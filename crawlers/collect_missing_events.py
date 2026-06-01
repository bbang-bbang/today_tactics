#!/usr/bin/env python3
"""
K리그2 누락 이벤트 수집기
- sofascore /api/v1/unique-tournament/777/seasons 로 시즌 목록 조회
- 2024/2025 시즌 전체 경기 목록 가져와서 DB에 없는 것만 삽입
- 이어서 누락 이벤트의 player stats 도 수집
"""

import asyncio, sqlite3, sys
from playwright.async_api import async_playwright

DB_PATH      = "players.db"
TOURNAMENT_UID = 777          # sofascore K리그2 unique tournament id
DELAY        = 0.4

KLEAGUE2_TEAMS = {
    7652, 7642, 41261, 7644, 189422, 339827, 314294,
    7651, 195172, 41263, 248375, 195174, 22020,
    7643, 314293, 41266, 41260, 92539, 32675,
}

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

async def main():
    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()

    # 기존 event_id 셋
    cur.execute("SELECT id FROM events WHERE tournament_id=777")
    existing_ids = {r[0] for r in cur.fetchall()}
    log(f"기존 K2 이벤트 수: {len(existing_ids)}")

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

        # 1. 시즌 목록
        seasons_data = await api(page, f"/api/v1/unique-tournament/{TOURNAMENT_UID}/seasons")
        if not seasons_data:
            log("시즌 목록 조회 실패")
            return
        seasons = seasons_data.get("seasons", [])
        log(f"시즌 목록: {[(s.get('year'), s.get('id')) for s in seasons[:6]]}")

        # 2024, 2025 시즌 필터
        target_seasons = [s for s in seasons if str(s.get("year","")) in ("2024","2025")]
        log(f"대상 시즌: {[(s.get('year'), s.get('id')) for s in target_seasons]}")

        new_events = []

        for season in target_seasons:
            sid  = season["id"]
            year = season["year"]
            log(f"\n[{year}] 시즌 ID={sid} 이벤트 수집 시작")

            # 페이지네이션: last/0, last/1, ... 그리고 next/0, next/1, ...
            for direction in ("last", "next"):
                page_no = 0
                while True:
                    path = f"/api/v1/unique-tournament/{TOURNAMENT_UID}/season/{sid}/events/{direction}/{page_no}"
                    data = await api(page, path)
                    await asyncio.sleep(DELAY)

                    if not data:
                        break
                    events = data.get("events", [])
                    if not events:
                        break

                    added = 0
                    for ev in events:
                        eid     = ev.get("id")
                        ht      = ev.get("homeTeam", {})
                        at      = ev.get("awayTeam", {})
                        home_id = ht.get("id")
                        away_id = at.get("id")
                        ts      = ev.get("startTimestamp")
                        hs      = ev.get("homeScore", {}).get("current")
                        as_     = ev.get("awayScore", {}).get("current")
                        status  = ev.get("status", {}).get("type","")

                        if not eid or status not in ("finished","canceled"):
                            continue
                        if status == "canceled":
                            continue
                        # K2 팀 포함 경기만
                        if home_id not in KLEAGUE2_TEAMS and away_id not in KLEAGUE2_TEAMS:
                            continue
                        if eid not in existing_ids:
                            cur.execute("""
                                INSERT OR IGNORE INTO events
                                  (id, home_team_id, home_team_name, away_team_id, away_team_name,
                                   date_ts, home_score, away_score, tournament_id)
                                VALUES (?,?,?,?,?,?,?,?,777)
                            """, (eid, home_id, ht.get("name"), away_id, at.get("name"),
                                  ts, hs, as_))
                            existing_ids.add(eid)
                            new_events.append(eid)
                            added += 1

                    conn.commit()
                    log(f"  {direction}/{page_no}: {len(events)}개 중 {added}개 신규 삽입")

                    has_next = data.get("hasNextPage", False)
                    if not has_next:
                        break
                    page_no += 1

        log(f"\n신규 추가 이벤트: {len(new_events)}개")

        # 3. 신규 이벤트 + 득점자 없는 기존 경기 → player stats 수집
        # 득점자 없는데 골 있는 경기
        cur.execute("""
            SELECT e.id FROM events e
            LEFT JOIN match_player_stats mps ON e.id=mps.event_id
            WHERE e.tournament_id=777
              AND (e.home_score + e.away_score) > 0
            GROUP BY e.id
            HAVING SUM(COALESCE(mps.goals,0)) = 0
        """)
        no_scorer_ids = [r[0] for r in cur.fetchall()]

        # 득점 2개 이상 불일치 경기
        cur.execute("""
            SELECT e.id FROM events e
            LEFT JOIN match_player_stats mps ON e.id=mps.event_id
            WHERE e.tournament_id=777
            GROUP BY e.id
            HAVING ABS((e.home_score+e.away_score) - COALESCE(SUM(mps.goals),0)) >= 2
        """)
        mismatch_ids = [r[0] for r in cur.fetchall()]

        retry_ids = list(set(new_events + no_scorer_ids + mismatch_ids))
        log(f"재수집 대상: {len(retry_ids)}경기 (신규:{len(new_events)} 득점자없음:{len(no_scorer_ids)} 불일치:{len(mismatch_ids)})")

        ok_count = 0
        for i, eid in enumerate(retry_ids):
            data = await api(page, f"/api/v1/event/{eid}/lineups")
            await asyncio.sleep(DELAY)
            if not data:
                continue

            home_players = data.get("home", {}).get("players", [])
            away_players = data.get("away", {}).get("players", [])

            cur.execute("SELECT home_team_id, away_team_id, date_ts FROM events WHERE id=?", (eid,))
            row = cur.fetchone()
            if not row:
                continue
            home_tid, away_tid, match_ts = row

            def save_players(plist, team_id, is_home):
                for p in plist:
                    pi = p.get("player", {})
                    st = p.get("statistics", {})
                    if not pi.get("id"):
                        continue
                    cur.execute("""
                        INSERT OR REPLACE INTO match_player_stats
                          (event_id, player_id, team_id, is_home, position, shirt_number,
                           minutes_played, rating, goals, assists, total_shots, shots_on_target,
                           expected_goals, total_passes, accurate_passes, accurate_passes_pct,
                           key_passes, accurate_long_balls, total_long_balls,
                           accurate_crosses, total_crosses,
                           successful_dribbles, attempted_dribbles, touches, possession_lost,
                           tackles, interceptions, clearances, blocked_shots,
                           duel_won, duel_lost, aerial_won, aerial_lost,
                           was_fouled, fouls, yellow_cards, red_cards, saves, goals_conceded,
                           raw_json, player_name)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, (
                        eid, pi["id"], team_id, 1 if is_home else 0,
                        p.get("position"), pi.get("shirtNumber"),
                        st.get("minutesPlayed"), st.get("rating"),
                        st.get("goals",0), st.get("goalAssist",0),
                        st.get("totalShots"), st.get("onTargetScoringAttempt"),
                        st.get("expectedGoals"),
                        st.get("totalPass"), st.get("accuratePass"),
                        st.get("accuratePassesPercentage") or (
                            round(st["accuratePass"]/st["totalPass"]*100,1)
                            if st.get("totalPass") else None),
                        st.get("keyPass"),
                        st.get("accurateLongBalls"), st.get("totalLongBalls"),
                        st.get("accurateCross"), st.get("totalCross"),
                        st.get("wonContest"), st.get("totalContest"),
                        st.get("touches"), st.get("possessionLostCtrl"),
                        st.get("totalTackle"), st.get("interceptionWon"),
                        st.get("totalClearance"), st.get("outfielderBlock"),
                        st.get("duelWon"), st.get("duelLost"),
                        st.get("aerialWon"), st.get("aerialLost"),
                        st.get("wasFouled"), st.get("fouls"),
                        st.get("yellowCards",0), st.get("redCards",0),
                        st.get("saves"), st.get("goalsConceded"),
                        str(st), pi.get("name","")
                    ))

            cur.execute("DELETE FROM match_player_stats WHERE event_id=?", (eid,))
            save_players(home_players, home_tid, True)
            save_players(away_players, away_tid, False)
            conn.commit()
            ok_count += 1

            if (i+1) % 20 == 0:
                log(f"  [{i+1}/{len(retry_ids)}] 스탯 수집 완료")

        log(f"\n스탯 재수집 완료: {ok_count}/{len(retry_ids)}")

        # 최종 현황
        cur.execute("""
            SELECT strftime("%Y", datetime(date_ts,"unixepoch","localtime")) yr,
                   COUNT(*) games
            FROM events WHERE tournament_id=777
            GROUP BY yr ORDER BY yr
        """)
        log("\n=== 최종 K2 이벤트 현황 ===")
        for yr, cnt in cur.fetchall():
            log(f"  {yr}: {cnt}경기")

        await browser.close()
    conn.close()

if __name__ == "__main__":
    asyncio.run(main())
