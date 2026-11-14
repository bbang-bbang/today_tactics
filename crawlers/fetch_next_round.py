#!/usr/bin/env python3
"""
K1/K2 다음 라운드 일정을 SofaScore에서 가져와 events 테이블에 INSERT (home_score=NULL).

사용법:
  python crawlers/fetch_next_round.py            # K1+K2 둘 다
  python crawlers/fetch_next_round.py --league K1
"""

import argparse
import asyncio
import sqlite3
import sys
from playwright.async_api import async_playwright

DB_PATH = "players.db"
DELAY = 0.4

LEAGUE_TID = {"K1": 410, "K2": 777}


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


async def api_fetch(page, path):
    return await page.evaluate(f"""() =>
        fetch('{path}').then(r => r.ok ? r.json() : ({{error: r.status}}))
        .catch(e => ({{error: e.message}}))
    """)


async def collect_for_league(page, conn, tid, label):
    log(f"\n[{label}] 다음 경기 수집 (T{tid})")

    # 해당 리그에서 최근 활동 팀 (최근 300일 events — 연초(1월)에도 직전 시즌 팀으로 다음 일정 조회)
    team_ids = [r[0] for r in conn.execute("""
        SELECT DISTINCT t FROM (
            SELECT home_team_id t FROM events WHERE tournament_id=? AND date_ts >= strftime('%s','now','-300 days')
            UNION
            SELECT away_team_id   FROM events WHERE tournament_id=? AND date_ts >= strftime('%s','now','-300 days')
        ) WHERE t IS NOT NULL
    """, (tid, tid)).fetchall()]
    log(f"  대상 팀 {len(team_ids)}개")

    seen = set()
    inserted = 0

    for tidx, team_id in enumerate(team_ids):
        data = await api_fetch(page, f"/api/v1/team/{team_id}/events/next/0")
        if not isinstance(data, dict):
            await asyncio.sleep(DELAY)
            continue
        for ev in data.get("events", []):
            uniq_tid = ev.get("tournament", {}).get("uniqueTournament", {}).get("id")
            if uniq_tid != tid:
                continue
            eid = ev["id"]
            if eid in seen:
                continue
            seen.add(eid)

            ht = ev.get("homeTeam", {})
            at = ev.get("awayTeam", {})
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
                None, None,
                tid,
            ))
            inserted += 1
        await asyncio.sleep(DELAY)

    conn.commit()
    log(f"  {len(seen)}경기 unique, {inserted}행 INSERT")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["K1", "K2", "all"], default="all")
    args = parser.parse_args()

    targets = list(LEAGUE_TID.items()) if args.league == "all" else [(args.league, LEAGUE_TID[args.league])]

    conn = sqlite3.connect(DB_PATH)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            extra_http_headers={"Referer": "https://www.sofascore.com/"},
        )
        page = await ctx.new_page()
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-1/410",
            wait_until="domcontentloaded", timeout=60000,
        )
        await asyncio.sleep(2)
        for label, tid in targets:
            await collect_for_league(page, conn, tid, label)
        await browser.close()
    conn.close()
    log("\n완료.")


if __name__ == "__main__":
    asyncio.run(main())
