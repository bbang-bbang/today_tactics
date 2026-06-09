#!/usr/bin/env python3
"""
SofaScore 경기별 선수 세부 스탯 수집기
- 대상: K리그1/K리그2 전 팀 (--team 으로 특정 팀만 지정 가능)
- 엔드포인트: /api/v1/event/{event_id}/lineups
- 저장: SQLite (players.db) → match_player_stats 테이블
"""

import argparse
import asyncio
import json
import sqlite3
import sys
from playwright.async_api import async_playwright

# 기본값: 수원 삼성 (기존 호환)
DEFAULT_TEAM_ID    = 7652   # 수원 삼성 블루윙즈
DEFAULT_TOURNAMENT = 777    # K리그2
DB_PATH            = "players.db"
DELAY              = 0.5

# K리그 팀 목록 (sofascore_id → 팀명)
K1_TEAMS = {
    7653: "울산", 7650: "포항", 7649: "제주", 6908: "전북", 7646: "서울",
    7645: "대전", 7648: "인천", 34220: "강원", 48912: "광주",
    92539: "부천", 32675: "안양", 7647: "김천",
}
K2_TEAMS = {
    7652: "수원삼성", 7642: "부산", 7643: "전남", 7651: "성남", 7644: "대구",
    22020: "경남", 41261: "수원FC", 189422: "이랜드", 248375: "안산",
    339827: "아산", 195172: "김포", 314293: "청주", 41263: "천안",
    195174: "화성", 314294: "파주", 41260: "김해", 41266: "용인",
}
K1_TOURNAMENT = 410   # K리그1 (Sofascore tournament ID)
K2_TOURNAMENT = 777   # K리그2

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

# ── DB 테이블 초기화 ─────────────────────────────────────
def init_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS match_player_stats (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id                INTEGER NOT NULL,
            player_id               INTEGER NOT NULL,
            team_id                 INTEGER,
            is_home                 INTEGER,   -- 1=홈, 0=원정
            position                TEXT,
            shirt_number            INTEGER,
            minutes_played          INTEGER,
            rating                  REAL,

            -- 공격
            goals                   INTEGER,
            assists                 INTEGER,
            total_shots             INTEGER,
            shots_on_target         INTEGER,
            big_chances_missed      INTEGER,
            expected_goals          REAL,

            -- 패스
            total_passes            INTEGER,
            accurate_passes         INTEGER,
            accurate_passes_pct     REAL,
            key_passes              INTEGER,
            accurate_long_balls     INTEGER,
            total_long_balls        INTEGER,
            accurate_crosses        INTEGER,
            total_crosses           INTEGER,

            -- 드리블
            successful_dribbles     INTEGER,
            attempted_dribbles      INTEGER,
            touches                 INTEGER,
            possession_lost         INTEGER,

            -- 수비
            tackles                 INTEGER,
            interceptions           INTEGER,
            clearances              INTEGER,
            blocked_shots           INTEGER,
            duel_won                INTEGER,
            duel_lost               INTEGER,
            aerial_won              INTEGER,
            aerial_lost             INTEGER,
            won_tackle              INTEGER,
            ball_recovery           INTEGER,
            challenge_lost          INTEGER,

            -- 기타
            was_fouled              INTEGER,
            fouls                   INTEGER,
            yellow_cards            INTEGER,
            red_cards               INTEGER,
            saves                   INTEGER,
            goals_conceded          INTEGER,

            raw_json                TEXT,
            UNIQUE(event_id, player_id)
        );

        CREATE INDEX IF NOT EXISTS idx_mps_event  ON match_player_stats(event_id);
        CREATE INDEX IF NOT EXISTS idx_mps_player ON match_player_stats(player_id);
        CREATE INDEX IF NOT EXISTS idx_mps_team   ON match_player_stats(team_id);
    """)
    conn.commit()

# ── API fetch ────────────────────────────────────────────
async def api_fetch(page, path, retries=2):
    for attempt in range(retries + 1):
        try:
            result = await page.evaluate(f"""() =>
                fetch('{path}')
                .then(r => r.ok ? r.json() : r.status)
                .catch(e => ({{error: e.message}}))
            """)
            return result
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

# ── 팀 경기 목록 수집 ──────────────────────────────────
async def fetch_team_events(page, team_id, tournament_id):
    """팀의 시즌 전체 경기 event_id 목록 반환"""
    all_teams = {**K1_TEAMS, **K2_TEAMS}
    team_name = all_teams.get(team_id, str(team_id))
    event_ids = []
    page_num = 0
    while True:
        data = await api_fetch(page, f"/api/v1/team/{team_id}/events/last/{page_num}")
        if not isinstance(data, dict):
            break
        events = data.get("events", [])
        if not events:
            break
        for ev in events:
            tid = ev.get("tournament", {}).get("uniqueTournament", {}).get("id")
            if tid == tournament_id:
                event_ids.append(ev["id"])
        if not data.get("hasNextPage", False):
            break
        page_num += 1
        await asyncio.sleep(DELAY)

    log(f"[{team_name}] 경기 수집: {len(event_ids)}경기")
    return event_ids

# ── 경기별 선수 스탯 파싱 ───────────────────────────────
def parse_stats(s):
    """statistics dict → 컬럼 값 dict (SofaScore 실제 키 기준)"""
    def g(key):
        return s.get(key)
    _ap = g("accuratePass")
    _tp = g("totalPass")
    _pass_pct = round(_ap / _tp * 100, 1) if (_ap is not None and _tp) else None
    return {
        "minutes_played":       g("minutesPlayed"),
        "rating":               g("rating"),
        "goals":                g("goals"),
        "assists":              g("goalAssist"),
        "total_shots":          g("totalShots"),
        "shots_on_target":      g("onTargetScoringAttempt"),
        "big_chances_missed":   g("bigChanceMissed"),
        "expected_goals":       g("expectedGoals"),
        "total_passes":         _tp,
        "accurate_passes":      _ap,
        "accurate_passes_pct":  _pass_pct,
        "key_passes":           g("keyPass"),
        "accurate_long_balls":  g("accurateLongBalls"),
        "total_long_balls":     g("totalLongBalls"),
        "accurate_crosses":     g("accurateCross"),
        "total_crosses":        g("totalCross"),
        "successful_dribbles":  g("wonContest"),
        "attempted_dribbles":   g("totalContest"),
        "touches":              g("touches"),
        "possession_lost":      g("possessionLostCtrl"),
        "tackles":              g("totalTackle"),
        "interceptions":        g("interceptionWon"),
        "clearances":           g("totalClearance"),
        "blocked_shots":        g("outfielderBlock"),
        "duel_won":             g("duelWon"),
        "duel_lost":            g("duelLost"),
        "aerial_won":           g("aerialWon"),
        "aerial_lost":          g("aerialLost"),
        "won_tackle":           g("wonTackle"),
        "ball_recovery":        g("ballRecovery"),
        "challenge_lost":       g("challengeLost"),
        "was_fouled":           g("wasFouled"),
        "fouls":                g("fouls"),
        "yellow_cards":         g("yellowCard"),
        "red_cards":            g("redCard"),
        "saves":                g("saves"),
        "goals_conceded":       g("goalsConceded"),
    }

# ── 경기 라인업에서 수원 삼성 선수 스탯 저장 ────────────
def save_player_stat(conn, event_id, player_id, team_id, is_home,
                     position, shirt_number, stats_raw, s_dict):
    cols = list(s_dict.keys())
    vals = list(s_dict.values())
    conn.execute(f"""
        INSERT OR REPLACE INTO match_player_stats
            (event_id, player_id, team_id, is_home, position, shirt_number,
             {', '.join(cols)}, raw_json)
        VALUES
            (?, ?, ?, ?, ?, ?,
             {', '.join(['?']*len(cols))}, ?)
    """, [event_id, player_id, team_id, is_home, position, shirt_number,
          *vals, json.dumps(stats_raw, ensure_ascii=False)])

# ── 단일 팀 수집 ────────────────────────────────────────
async def crawl_team(page, conn, team_id, tournament_id):
    """한 팀의 경기별 선수 스탯 수집 (양팀 선수 모두 저장)"""
    all_teams = {**K1_TEAMS, **K2_TEAMS}
    team_name = all_teams.get(team_id, str(team_id))

    event_ids = await fetch_team_events(page, team_id, tournament_id)

    # 이미 수집된 경기 제외 (해당 팀 기준)
    existing = {r[0] for r in conn.execute(
        "SELECT DISTINCT event_id FROM match_player_stats WHERE team_id = ?", (team_id,)
    ).fetchall()}
    todo = [eid for eid in event_ids if eid not in existing]
    log(f"[{team_name}] 수집 대상: {len(todo)}경기 (이미 완료: {len(existing)}경기)")

    for i, eid in enumerate(todo):
        data = await api_fetch(page, f"/api/v1/event/{eid}/lineups")
        if not isinstance(data, dict):
            log(f"  [{i+1}/{len(todo)}] event {eid} 스킵 (응답 없음)")
            await asyncio.sleep(DELAY)
            continue

        saved = 0
        for side, is_home in [("home", 1), ("away", 0)]:
            side_data = data.get(side, {})
            for entry in side_data.get("players", []):
                entry_team_id = entry.get("teamId")
                player = entry.get("player", {})
                pid = player.get("id")
                if not pid:
                    continue
                stats_raw = entry.get("statistics", {})
                s_dict = parse_stats(stats_raw)
                pos = entry.get("position", player.get("position", ""))
                shirt = entry.get("shirtNumber")
                try:
                    save_player_stat(conn, eid, pid, entry_team_id, is_home,
                                     pos, shirt, stats_raw, s_dict)
                    saved += 1
                except Exception as e:
                    log(f"    저장 오류 player {pid}: {e}")

        conn.commit()
        log(f"  [{i+1}/{len(todo)}] event {eid} → {saved}명 저장")
        await asyncio.sleep(DELAY)

    return len(todo)


# ── 메인 ────────────────────────────────────────────────
async def main():
    parser = argparse.ArgumentParser(description="K리그 경기별 선수 스탯 수집")
    parser.add_argument("--team", type=int, default=None,
                        help="특정 팀 sofascore_id (미지정 시 수원 삼성)")
    parser.add_argument("--league", choices=["K1", "K2", "all"], default=None,
                        help="리그 전체 수집 (K1, K2, all)")
    args = parser.parse_args()

    # 수집 대상 결정
    if args.league == "K1":
        targets = [(tid, K1_TOURNAMENT) for tid in K1_TEAMS]
    elif args.league == "K2":
        targets = [(tid, K2_TOURNAMENT) for tid in K2_TEAMS]
    elif args.league == "all":
        targets = [(tid, K1_TOURNAMENT) for tid in K1_TEAMS] + \
                  [(tid, K2_TOURNAMENT) for tid in K2_TEAMS]
    elif args.team:
        tournament = K1_TOURNAMENT if args.team in K1_TEAMS else K2_TOURNAMENT
        targets = [(args.team, tournament)]
    else:
        targets = [(DEFAULT_TEAM_ID, DEFAULT_TOURNAMENT)]

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            extra_http_headers={
                "Accept-Language": "ko-KR,ko;q=0.9",
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://www.sofascore.com/",
            }
        )
        page = await ctx.new_page()

        log("sofascore 접속 중...")
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
            wait_until="domcontentloaded", timeout=60000
        )
        await asyncio.sleep(3)
        log("세션 준비 완료")

        total = 0
        for team_id, tournament_id in targets:
            total += await crawl_team(page, conn, team_id, tournament_id)

        await browser.close()
    conn.close()
    log(f"\n완료! {len(targets)}팀, {total}경기 수집됨")

if __name__ == "__main__":
    asyncio.run(main())
