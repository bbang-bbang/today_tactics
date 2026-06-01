#!/usr/bin/env python3
"""
P2: heatmap_points / match_player_stats가 참조하지만 events 테이블에 없는
orphan event_id들을 SofaScore API에서 메타데이터 재조회 → events INSERT.
실패(404 등) 시 해당 event를 heatmap_points / mps에서 cascading delete.
"""

import asyncio
import sqlite3
import sys
from playwright.async_api import async_playwright

DB_PATH = "players.db"
DELAY = 0.4  # 호출 간격


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


async def api_fetch(page, path):
    return await page.evaluate(f"""() =>
        fetch('{path}').then(r => r.ok ? r.json() : ({{error: r.status}}))
        .catch(e => ({{error: e.message}}))
    """)


async def main():
    conn = sqlite3.connect(DB_PATH)

    orphan_ids = set()
    for r in conn.execute(
        "SELECT DISTINCT event_id FROM heatmap_points WHERE event_id NOT IN (SELECT id FROM events)"
    ).fetchall():
        orphan_ids.add(r[0])
    for r in conn.execute(
        "SELECT DISTINCT event_id FROM match_player_stats WHERE event_id NOT IN (SELECT id FROM events)"
    ).fetchall():
        orphan_ids.add(r[0])

    orphan_ids = sorted(orphan_ids)
    log(f"orphan events: {len(orphan_ids)}건")
    if not orphan_ids:
        log("정리할 항목 없음")
        return

    inserted, deleted, errored = 0, 0, []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            extra_http_headers={"Referer": "https://www.sofascore.com/"},
        )
        page = await ctx.new_page()
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
            wait_until="domcontentloaded", timeout=60000,
        )
        await asyncio.sleep(2)

        for i, eid in enumerate(orphan_ids, 1):
            data = await api_fetch(page, f"/api/v1/event/{eid}")

            if isinstance(data, dict) and "event" in data:
                ev = data["event"]
                ht = ev.get("homeTeam", {})
                at = ev.get("awayTeam", {})
                tid = ev.get("tournament", {}).get("uniqueTournament", {}).get("id")
                conn.execute("""
                    INSERT OR REPLACE INTO events
                        (id, home_team_id, home_team_name, away_team_id, away_team_name,
                         date_ts, home_score, away_score, tournament_id)
                    VALUES (?,?,?,?,?,?,?,?,?)
                """, (
                    eid,
                    ht.get("id"), ht.get("name"),
                    at.get("id"), at.get("name"),
                    ev.get("startTimestamp"),
                    ev.get("homeScore", {}).get("current"),
                    ev.get("awayScore", {}).get("current"),
                    tid,
                ))
                inserted += 1
                if i % 50 == 0:
                    conn.commit()
                    log(f"  [{i}/{len(orphan_ids)}] inserted={inserted} deleted={deleted}")
            elif isinstance(data, dict) and data.get("error") in (404, "404"):
                # 진짜 없는 경기 → cascading delete
                conn.execute("DELETE FROM heatmap_points WHERE event_id=?", (eid,))
                conn.execute("DELETE FROM match_player_stats WHERE event_id=?", (eid,))
                deleted += 1
            else:
                errored.append((eid, data))
                if i % 50 == 0:
                    log(f"  [{i}/{len(orphan_ids)}] inserted={inserted} deleted={deleted} errors={len(errored)}")

            await asyncio.sleep(DELAY)

        conn.commit()
        await browser.close()

    conn.close()
    log("")
    log("=== 완료 ===")
    log(f"  inserted (events 백필): {inserted}")
    log(f"  deleted (cascading):    {deleted}")
    log(f"  errored (재시도 필요):   {len(errored)}")
    if errored[:5]:
        log(f"  샘플 에러: {errored[:5]}")


if __name__ == "__main__":
    asyncio.run(main())
