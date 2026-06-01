#!/usr/bin/env python3
"""
synthetic event(90xxxxxx, sync_results_to_events.py가 생성)를 진짜 SofaScore
event_id로 교체.

흐름:
1. events 테이블에서 id BETWEEN 90000000 AND 91000000 조회
2. 각 synthetic event의 home team SofaScore ID로 /api/v1/team/{id}/events/last/{page} 호출
3. (date_ts ±12h, opponent_id 일치) 매칭되는 진짜 event_id 발견
4. 진짜 event INSERT (스코어/팀/날짜/장소 모두 SofaScore 기준), synthetic DELETE
5. 이후 crawl_lineups.py, collect_goal_incidents.py가 자동으로 lineup + 카드 수집
"""

import asyncio, sqlite3, sys
from pathlib import Path
from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH  = str(BASE_DIR / "players.db")
DELAY    = 0.5

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


async def api_fetch(page, path, retries=2):
    for attempt in range(retries + 1):
        try:
            return await page.evaluate(f"""() =>
                fetch('{path}')
                .then(r => r.ok ? r.json() : r.status)
                .catch(e => ({{error: e.message}}))
            """)
        except Exception as e:
            if attempt < retries:
                try:
                    await page.goto(
                        "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
                        wait_until="domcontentloaded", timeout=60000
                    )
                    await asyncio.sleep(2)
                except Exception:
                    pass
            else:
                return {"error": str(e)}


async def find_real_event_id(page, home_ss_id, away_ss_id, target_ts, tournament_id):
    """주어진 (home_ss, away_ss, ±12h, tournament) 매칭되는 SofaScore event_id 검색"""
    for page_num in range(0, 5):  # 최근 ~5페이지
        data = await api_fetch(page, f"/api/v1/team/{home_ss_id}/events/last/{page_num}")
        if not isinstance(data, dict):
            return None
        events = data.get("events", [])
        if not events:
            return None
        for ev in events:
            ev_tid = ev.get("tournament", {}).get("uniqueTournament", {}).get("id")
            if ev_tid != tournament_id:
                continue
            ev_home = ev.get("homeTeam", {}).get("id")
            ev_away = ev.get("awayTeam", {}).get("id")
            ev_ts   = ev.get("startTimestamp")
            if (ev_home == home_ss_id and ev_away == away_ss_id and
                abs(ev_ts - target_ts) < 43200):  # ±12h
                return ev
        if not data.get("hasNextPage", False):
            return None
        await asyncio.sleep(DELAY)
    return None


async def main():
    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()

    cur.execute("""
        SELECT id, home_team_id, home_team_name, away_team_id, away_team_name,
               date_ts, home_score, away_score, tournament_id
        FROM events WHERE id BETWEEN 90000000 AND 91000000
        ORDER BY date_ts
    """)
    synthetic = cur.fetchall()
    if not synthetic:
        log("synthetic event 없음 — 종료")
        return

    log(f"synthetic event {len(synthetic)}개 발견 — SofaScore 매핑 시작\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            extra_http_headers={"Referer": "https://www.sofascore.com/"}
        )
        page = await ctx.new_page()
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
            wait_until="domcontentloaded", timeout=60000
        )
        await asyncio.sleep(3)
        log("세션 준비 완료\n")

        replaced = failed = 0
        for syn in synthetic:
            (syn_id, hid, hname, aid, aname, ts, hs, as_, tid) = syn
            real = await find_real_event_id(page, hid, aid, ts, tid)
            if not real:
                log(f"  [실패] {hname} vs {aname} ({ts}) — 매칭 안됨")
                failed += 1
                await asyncio.sleep(DELAY)
                continue

            real_id = real["id"]
            real_ts = real.get("startTimestamp")
            real_hs = real.get("homeScore", {}).get("current")
            real_as = real.get("awayScore", {}).get("current")
            ht_meta = real.get("homeTeam", {})
            at_meta = real.get("awayTeam", {})
            venue   = real.get("venue", {})
            v_name  = venue.get("name") or venue.get("stadium", {}).get("name")
            v_city  = (venue.get("city") or {}).get("name", "")

            # 진짜 event INSERT (synthetic과 다른 ID이므로 INSERT OR IGNORE 후 UPDATE)
            cur.execute("""
                INSERT OR IGNORE INTO events
                    (id, home_team_id, home_team_name, away_team_id, away_team_name,
                     date_ts, home_score, away_score, tournament_id, venue_name, venue_city)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (real_id, hid, ht_meta.get("name", hname), aid, at_meta.get("name", aname),
                  real_ts, real_hs, real_as, tid, v_name, v_city))
            cur.execute("""
                UPDATE events SET
                    home_score=?, away_score=?, date_ts=?,
                    venue_name=COALESCE(venue_name, ?),
                    venue_city=COALESCE(venue_city, ?)
                WHERE id=?
            """, (real_hs, real_as, real_ts, v_name, v_city, real_id))

            # synthetic DELETE
            cur.execute("DELETE FROM events WHERE id=?", (syn_id,))
            conn.commit()

            log(f"  [OK] {hname} vs {aname} | synthetic {syn_id} → real {real_id} | "
                f"{real_hs}-{real_as} @ {v_name or '?'}")
            replaced += 1
            await asyncio.sleep(DELAY)

        await browser.close()

    log(f"\n완료: 교체 {replaced}건 / 실패 {failed}건")
    conn.close()


if __name__ == "__main__":
    asyncio.run(main())
