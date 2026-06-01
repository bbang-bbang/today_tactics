"""
90xxxxxxx placeholder event_id를 SofaScore 날짜 API로 실제 ID로 교체한 뒤 라인업 수집.

흐름:
  1. events 테이블에서 90xxxxxxx ID + 라인업 없는 경기 조회
  2. SofaScore /api/v1/sport/football/scheduled-events/YYYY-MM-DD 로 실제 ID 역조회
  3. events 테이블 UPDATE (90xxxxxxx → 실제 ID)
  4. 연관 테이블(heatmap_points, match_player_stats) 도 함께 UPDATE
  5. 라인업 수집
"""
import asyncio, sqlite3, datetime
from pathlib import Path
from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH  = str(BASE_DIR / "players.db")
DELAY    = 0.4


def log(msg):
    print(msg, flush=True)


def get_placeholder_events(conn):
    cur = conn.cursor()
    cur.execute("""
        SELECT e.id, e.home_team_id, e.away_team_id, e.date_ts,
               e.tournament_id, e.home_score, e.away_score, e.round
        FROM events e
        WHERE e.id > 90000000
          AND e.home_score IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM match_lineups m WHERE m.event_id = e.id)
        ORDER BY e.date_ts
    """)
    return cur.fetchall()


def replace_event_id(conn, old_id, new_id):
    cur = conn.cursor()
    # 이미 new_id가 있으면 old만 삭제
    existing = cur.execute("SELECT id FROM events WHERE id=?", (new_id,)).fetchone()
    if existing:
        cur.execute("DELETE FROM events WHERE id=?", (old_id,))
        conn.commit()
        return "dup_skip"

    # UPDATE events
    cur.execute("UPDATE events SET id=? WHERE id=?", (new_id, old_id))
    # 연관 테이블 UPDATE (외래키 없으므로 직접)
    for tbl in ("match_lineups", "heatmap_points", "match_player_stats"):
        cur.execute(f"UPDATE {tbl} SET event_id=? WHERE event_id=?", (new_id, old_id))
    conn.commit()
    return "ok"


async def run():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    placeholders = get_placeholder_events(conn)
    if not placeholders:
        log("교체 대상 없음")
        conn.close()
        return

    log(f"교체 대상: {len(placeholders)}경기")

    # 날짜별로 묶기
    by_date: dict[str, list] = {}
    for ev in placeholders:
        dt = datetime.datetime.fromtimestamp(ev["date_ts"]).strftime("%Y-%m-%d")
        by_date.setdefault(dt, []).append(ev)

    replaced = 0
    not_found = 0
    lineup_ok = 0
    lineup_fail = 0

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            extra_http_headers={"Accept": "application/json",
                                "Referer": "https://www.sofascore.com/"},
        )
        page = await ctx.new_page()
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-1/410",
            wait_until="domcontentloaded", timeout=60000,
        )
        await asyncio.sleep(2)

        for date_str, evs in sorted(by_date.items()):
            log(f"\n[{date_str}] {len(evs)}경기 조회...")
            data = await page.evaluate(
                f"() => fetch('/api/v1/sport/football/scheduled-events/{date_str}').then(r=>r.json())"
            )
            await asyncio.sleep(DELAY)

            ss_events = data.get("events", []) if isinstance(data, dict) else []
            # K1/K2 만 필터
            ss_events = [
                e for e in ss_events
                if e.get("tournament", {}).get("uniqueTournament", {}).get("id") in (410, 777)
            ]
            # home_team_id → event 매핑
            ss_by_teams: dict[tuple, int] = {}
            for e in ss_events:
                h = e.get("homeTeam", {}).get("id")
                a = e.get("awayTeam", {}).get("id")
                if h and a:
                    ss_by_teams[(h, a)] = e["id"]

            for ev in evs:
                key = (ev["home_team_id"], ev["away_team_id"])
                real_id = ss_by_teams.get(key)
                if not real_id:
                    log(f"  [{ev['id']}] 실제 ID 미발견 (home={ev['home_team_id']} away={ev['away_team_id']})")
                    not_found += 1
                    continue

                result = replace_event_id(conn, ev["id"], real_id)
                if result == "dup_skip":
                    log(f"  [{ev['id']}] → {real_id} (이미 존재, 플레이스홀더 삭제)")
                else:
                    log(f"  [{ev['id']}] → {real_id} 교체 완료")
                replaced += 1

                # 라인업 수집
                lu = await page.evaluate(
                    f"() => fetch('/api/v1/event/{real_id}/lineups').then(r=>r.ok?r.json():{{_status:r.status}})"
                )
                await asyncio.sleep(DELAY)
                if isinstance(lu, dict) and "home" in lu and "away" in lu:
                    from crawl_lineups import parse_side, save_rows
                    confirmed = bool(lu.get("confirmed"))
                    rows = (
                        parse_side(real_id, lu["home"], True,  ev["home_team_id"]) +
                        parse_side(real_id, lu["away"], False, ev["away_team_id"])
                    )
                    save_rows(conn, rows, confirmed)
                    log(f"    라인업 저장: {len(rows)}명")
                    lineup_ok += 1
                else:
                    log(f"    라인업 없음: {lu}")
                    lineup_fail += 1

        await browser.close()

    conn.close()
    log(f"\n완료: 교체 {replaced}건, 미발견 {not_found}건, 라인업 ok={lineup_ok} fail={lineup_fail}")


if __name__ == "__main__":
    asyncio.run(run())
