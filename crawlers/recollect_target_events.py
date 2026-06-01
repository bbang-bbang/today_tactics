#!/usr/bin/env python3
"""
특정 event_id 의 player stats 를 재수집하는 스크립트.
"""

import asyncio, sqlite3, sys
from playwright.async_api import async_playwright

DB_PATH = "players.db"
TARGET_EVENT_IDS = [12116819, 13522851]   # 경남FC 결측 2경기
DELAY = 0.6

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

async def api(page, path):
    for attempt in range(3):
        try:
            r = await page.evaluate(f"""() =>
                fetch('{path}').then(r => r.ok ? r.json() : null).catch(() => null)
            """)
            return r
        except:
            if attempt < 2:
                await page.goto("https://www.sofascore.com", wait_until="domcontentloaded", timeout=30000)
                await asyncio.sleep(2)
    return None

def upsert_player_stats(cur, eid, team_id, is_home, pdata, event_row):
    """선수 한 명의 stats를 match_player_stats 에 upsert."""
    pid   = pdata.get("player", {}).get("id")
    pname = pdata.get("player", {}).get("name", "")
    if not pid:
        return

    stats  = pdata.get("statistics", {})
    pos    = pdata.get("position", "") or pdata.get("player", {}).get("position", "")
    shirt  = pdata.get("shirtNumber")
    mins   = stats.get("minutesPlayed", 0) or 0

    date_ts, home_score, away_score = event_row
    if is_home:
        my_score, opp_score = home_score or 0, away_score or 0
    else:
        my_score, opp_score = away_score or 0, home_score or 0

    result = 1 if my_score > opp_score else (0 if my_score == opp_score else -1)

    cur.execute("""
        INSERT INTO match_player_stats (
            event_id, player_id, team_id, is_home, position, shirt_number,
            minutes_played, rating,
            goals, assists, total_shots, shots_on_target, big_chances_missed, expected_goals,
            total_passes, accurate_passes, accurate_passes_pct, key_passes,
            accurate_long_balls, total_long_balls,
            accurate_crosses, total_crosses,
            successful_dribbles, attempted_dribbles,
            touches, possession_lost,
            tackles, interceptions, clearances, blocked_shots,
            duel_won, duel_lost, aerial_won, aerial_lost,
            was_fouled, fouls, yellow_cards, red_cards,
            saves, goals_conceded,
            result, player_name
        ) VALUES (
            ?,?,?,?,?,?,
            ?,?,
            ?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,
            ?,?,
            ?,?,
            ?,?,
            ?,?,?,?,
            ?,?,?,?,
            ?,?,?,?,
            ?,?,
            ?,?
        )
        ON CONFLICT(event_id, player_id) DO UPDATE SET
            minutes_played=excluded.minutes_played, rating=excluded.rating,
            goals=excluded.goals, assists=excluded.assists,
            total_shots=excluded.total_shots, shots_on_target=excluded.shots_on_target,
            expected_goals=excluded.expected_goals,
            total_passes=excluded.total_passes, accurate_passes=excluded.accurate_passes,
            accurate_passes_pct=excluded.accurate_passes_pct, key_passes=excluded.key_passes,
            tackles=excluded.tackles, interceptions=excluded.interceptions,
            duel_won=excluded.duel_won, duel_lost=excluded.duel_lost,
            saves=excluded.saves, goals_conceded=excluded.goals_conceded,
            result=excluded.result
    """, (
        eid, pid, team_id, int(is_home), pos, shirt,
        mins, stats.get("rating"),
        stats.get("goals"), stats.get("goalAssist"),
        stats.get("totalShots"), stats.get("shotsOnTarget"), stats.get("bigChancesMissed"),
        stats.get("expectedGoals"),
        stats.get("accuratePass"), stats.get("accuratePass"), stats.get("accuratePassesPercentage"),
        stats.get("keyPass"),
        stats.get("accurateLongBalls"), stats.get("totalLongBalls"),
        stats.get("accurateCross"), stats.get("totalCross"),
        stats.get("successfulDribbles"), stats.get("attemptedDribbles"),
        stats.get("touches"), stats.get("possessionLostCtrl"),
        stats.get("tackles"), stats.get("interceptions"), stats.get("clearances"),
        stats.get("blockedShots"),
        stats.get("duelWon"), stats.get("duelLost"),
        stats.get("aerialWon"), stats.get("aerialLost"),
        stats.get("wasFouled"), stats.get("fouls"),
        stats.get("yellowCards"), stats.get("redCards"),
        stats.get("saves"), stats.get("goalsConceded"),
        result, pname
    ))

async def main():
    conn = sqlite3.connect(DB_PATH)
    # unique constraint 확인
    try:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_mps_event_player ON match_player_stats(event_id, player_id)")
        conn.commit()
    except:
        pass
    cur = conn.cursor()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await ctx.new_page()
        await page.goto("https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
                        wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)
        log("세션 준비 완료")

        for eid in TARGET_EVENT_IDS:
            log(f"\n[event {eid}] 라인업 조회 중...")
            data = await api(page, f"/api/v1/event/{eid}/lineups")
            await asyncio.sleep(DELAY)

            if not data:
                log("  → 데이터 없음")
                continue

            cur.execute("SELECT date_ts, home_score, away_score, home_team_id, away_team_id FROM events WHERE id=?", (eid,))
            erow = cur.fetchone()
            if not erow:
                log("  → events 테이블에 없음")
                continue

            date_ts, home_score, away_score, home_team_id, away_team_id = erow
            event_row = (date_ts, home_score, away_score)

            home_players = data.get("home", {}).get("players", [])
            away_players = data.get("away", {}).get("players", [])

            inserted = 0
            for pdata in home_players:
                upsert_player_stats(cur, eid, home_team_id, True, pdata, event_row)
                inserted += 1
            for pdata in away_players:
                upsert_player_stats(cur, eid, away_team_id, False, pdata, event_row)
                inserted += 1

            conn.commit()
            log(f"  → {inserted}명 저장 완료 (홈:{home_team_id} {home_score}-{away_score} 원정:{away_team_id})")

            # 결과 확인
            cur.execute("SELECT COUNT(*) FROM match_player_stats WHERE event_id=?", (eid,))
            log(f"  → DB 확인: {cur.fetchone()[0]}행")

        await browser.close()

    conn.close()
    log("\n완료!")

if __name__ == "__main__":
    asyncio.run(main())
