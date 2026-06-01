#!/usr/bin/env python3
"""
SofaScore K리그 선수 스탯 + 히트맵 수집기
- 수집 대상: K리그1 / K리그2 전 팀 선수
- 저장: SQLite (players.db)
- 히트맵: 선수별 시즌 전체 경기 좌표 누적
"""

import asyncio
import json
import sqlite3
import sys
from playwright.async_api import async_playwright

# ── 설정 ────────────────────────────────────────────────
LEAGUES = [
    {"name": "K리그1", "tournament_id": 410, "season_id": 88606},
    {"name": "K리그2", "tournament_id": 777, "season_id": 88837},
]
DB_PATH = "players.db"
DELAY = 0.4  # 요청 간 딜레이 (초)

# ── DB 초기화 ────────────────────────────────────────────
def init_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS teams (
            id          INTEGER PRIMARY KEY,
            name        TEXT,
            short_name  TEXT,
            league      TEXT,
            tournament_id INTEGER,
            season_id   INTEGER
        );

        CREATE TABLE IF NOT EXISTS players (
            id              INTEGER PRIMARY KEY,
            team_id         INTEGER,
            name            TEXT,
            position        TEXT,
            nationality     TEXT,
            dob             TEXT,
            height          INTEGER,
            preferred_foot  TEXT,
            shirt_number    INTEGER,
            FOREIGN KEY(team_id) REFERENCES teams(id)
        );

        CREATE TABLE IF NOT EXISTS player_stats (
            id                          INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id                   INTEGER,
            tournament_id               INTEGER,
            season_id                   INTEGER,
            appearances                 INTEGER,
            minutes_played              INTEGER,
            rating                      REAL,
            goals                       INTEGER,
            assists                     INTEGER,
            total_shots                 INTEGER,
            shots_on_target             INTEGER,
            accurate_passes             INTEGER,
            total_passes                INTEGER,
            accurate_passes_pct         REAL,
            key_passes                  INTEGER,
            successful_dribbles         INTEGER,
            tackles                     INTEGER,
            interceptions               INTEGER,
            yellow_cards                INTEGER,
            red_cards                   INTEGER,
            aerial_duels_won            INTEGER,
            aerial_duels_won_pct        REAL,
            ground_duels_won            INTEGER,
            ground_duels_won_pct        REAL,
            big_chances_created         INTEGER,
            big_chances_missed          INTEGER,
            accurate_crosses            INTEGER,
            clearances                  INTEGER,
            saves                       INTEGER,
            clean_sheet                 INTEGER,
            goals_conceded              INTEGER,
            touches                     INTEGER,
            possession_lost             INTEGER,
            was_fouled                  INTEGER,
            fouls                       INTEGER,
            raw_json                    TEXT,
            UNIQUE(player_id, tournament_id, season_id),
            FOREIGN KEY(player_id) REFERENCES players(id)
        );

        CREATE TABLE IF NOT EXISTS events (
            id              INTEGER PRIMARY KEY,
            home_team_id    INTEGER,
            home_team_name  TEXT,
            away_team_id    INTEGER,
            away_team_name  TEXT,
            date_ts         INTEGER,
            home_score      INTEGER,
            away_score      INTEGER,
            tournament_id   INTEGER
        );

        CREATE TABLE IF NOT EXISTS heatmap_points (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id   INTEGER,
            event_id    INTEGER,
            x           INTEGER,
            y           INTEGER,
            FOREIGN KEY(player_id) REFERENCES players(id)
        );

        CREATE INDEX IF NOT EXISTS idx_heatmap_player ON heatmap_points(player_id);
        CREATE INDEX IF NOT EXISTS idx_heatmap_event ON heatmap_points(event_id);
        CREATE INDEX IF NOT EXISTS idx_stats_player ON player_stats(player_id);
    """)
    # 기존 events 테이블에 컬럼 없으면 추가 (ALTER TABLE)
    existing = {r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
    for col, typedef in [
        ("date_ts",       "INTEGER"),
        ("home_score",    "INTEGER"),
        ("away_score",    "INTEGER"),
        ("tournament_id", "INTEGER"),
    ]:
        if col not in existing:
            conn.execute(f"ALTER TABLE events ADD COLUMN {col} {typedef}")
    conn.commit()
    conn.commit()

# ── 브라우저 내부 fetch (봇 감지 우회) ──────────────────
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
                # 컨텍스트 파괴 등 에러 시 페이지 복구
                try:
                    await page.goto("https://www.sofascore.com/tournament/football/south-korea/k-league-1/410", wait_until="domcontentloaded", timeout=60000)
                    await asyncio.sleep(2)
                except Exception:
                    pass
            else:
                return {"error": str(e)}

# ── 시즌 ID 자동 탐지 ────────────────────────────────────
async def get_latest_season_id(page, tournament_id):
    data = await api_fetch(page, f"/api/v1/unique-tournament/{tournament_id}/seasons")
    if isinstance(data, dict):
        seasons = data.get("seasons", [])
        if seasons:
            return seasons[0]["id"]
    return None

# ── 팀 목록 수집 ─────────────────────────────────────────
async def fetch_teams(page, tournament_id, season_id):
    data = await api_fetch(page, f"/api/v1/unique-tournament/{tournament_id}/season/{season_id}/standings/total")
    if not isinstance(data, dict):
        return []
    rows = data.get("standings", [{}])[0].get("rows", [])
    teams = []
    for r in rows:
        t = r["team"]
        teams.append({
            "id": t["id"],
            "name": t["name"],
            "short_name": t.get("shortName", t["name"]),
        })
    return teams

# ── 선수 목록 수집 ───────────────────────────────────────
async def fetch_players(page, team_id):
    data = await api_fetch(page, f"/api/v1/team/{team_id}/players")
    if not isinstance(data, dict):
        return []
    result = []
    for entry in data.get("players", []):
        p = entry["player"]
        result.append({
            "id": p["id"],
            "name": p["name"],
            "position": p.get("position", ""),
            "nationality": p.get("nationality", {}).get("name", "") if isinstance(p.get("nationality"), dict) else "",
            "dob": p.get("dateOfBirthTimestamp", ""),
            "height": p.get("height"),
            "preferred_foot": p.get("preferredFoot", ""),
            "shirt_number": entry.get("shirtNumber"),
        })
    return result

# ── 선수 스탯 수집 ───────────────────────────────────────
async def fetch_player_stats(page, player_id, tournament_id, season_id):
    data = await api_fetch(page, f"/api/v1/player/{player_id}/unique-tournament/{tournament_id}/season/{season_id}/statistics/overall")
    if not isinstance(data, dict):
        return None
    return data.get("statistics") or None

# ── 선수 히트맵 수집 (경기별 좌표 누적) ─────────────────
async def fetch_player_heatmap(page, player_id, conn=None):
    points = []
    page_num = 0
    while True:
        data = await api_fetch(page, f"/api/v1/player/{player_id}/events/last/{page_num}")
        if not isinstance(data, dict):
            break
        events = data.get("events", [])
        if not events:
            break

        for event in events:
            eid = event["id"]

            # 경기 메타데이터 저장
            if conn is not None:
                save_event(conn, event)

            hdata = await api_fetch(page, f"/api/v1/event/{eid}/player/{player_id}/heatmap")
            if isinstance(hdata, dict):
                for pt in hdata.get("heatmap", []):
                    points.append({"event_id": eid, "x": pt["x"], "y": pt["y"]})
            await asyncio.sleep(DELAY * 0.5)

        if not data.get("hasNextPage", False):
            break
        page_num += 1
        await asyncio.sleep(DELAY)

    return points

# ── DB 저장 ──────────────────────────────────────────────
def save_team(conn, team, league, tournament_id, season_id):
    conn.execute("""
        INSERT OR REPLACE INTO teams (id, name, short_name, league, tournament_id, season_id)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (team["id"], team["name"], team["short_name"], league, tournament_id, season_id))

def save_player(conn, player, team_id):
    conn.execute("""
        INSERT OR REPLACE INTO players (id, team_id, name, position, nationality, dob, height, preferred_foot, shirt_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        player["id"], team_id, player["name"], player["position"],
        player["nationality"], player["dob"], player["height"],
        player["preferred_foot"], player["shirt_number"]
    ))

def save_stats(conn, player_id, tournament_id, season_id, s):
    conn.execute("""
        INSERT OR REPLACE INTO player_stats (
            player_id, tournament_id, season_id,
            appearances, minutes_played, rating,
            goals, assists, total_shots, shots_on_target,
            accurate_passes, total_passes, accurate_passes_pct,
            key_passes, successful_dribbles,
            tackles, interceptions, yellow_cards, red_cards,
            aerial_duels_won, aerial_duels_won_pct,
            ground_duels_won, ground_duels_won_pct,
            big_chances_created, big_chances_missed,
            accurate_crosses, clearances,
            saves, clean_sheet, goals_conceded,
            touches, possession_lost, was_fouled, fouls,
            raw_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        player_id, tournament_id, season_id,
        s.get("appearances"), s.get("minutesPlayed"), s.get("rating"),
        s.get("goals"), s.get("assists"), s.get("totalShots"), s.get("shotsOnTarget"),
        s.get("accuratePasses"), s.get("totalPasses"), s.get("accuratePassesPercentage"),
        s.get("keyPasses"), s.get("successfulDribbles"),
        s.get("tackles"), s.get("interceptions"), s.get("yellowCards"), s.get("redCards"),
        s.get("aerialDuelsWon"), s.get("aerialDuelsWonPercentage"),
        s.get("groundDuelsWon"), s.get("groundDuelsWonPercentage"),
        s.get("bigChancesCreated"), s.get("bigChancesMissed"),
        s.get("accurateCrosses"), s.get("clearances"),
        s.get("saves"), s.get("cleanSheet"), s.get("goalsConceded"),
        s.get("touches"), s.get("possessionLost"), s.get("wasFouled"), s.get("fouls"),
        json.dumps(s, ensure_ascii=False)
    ))

def save_event(conn, event):
    eid = event["id"]
    ht = event.get("homeTeam", {})
    at = event.get("awayTeam", {})
    hs = event.get("homeScore", {}).get("current")
    as_ = event.get("awayScore", {}).get("current")
    ts = event.get("startTimestamp")
    tid = event.get("tournament", {}).get("uniqueTournament", {}).get("id")
    conn.execute("""
        INSERT OR REPLACE INTO events
            (id, home_team_id, home_team_name, away_team_id, away_team_name,
             date_ts, home_score, away_score, tournament_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (eid, ht.get("id"), ht.get("name"), at.get("id"), at.get("name"),
          ts, hs, as_, tid))

def save_heatmap(conn, player_id, points):
    # 기존 데이터 삭제 후 재저장
    conn.execute("DELETE FROM heatmap_points WHERE player_id = ?", (player_id,))
    conn.executemany(
        "INSERT INTO heatmap_points (player_id, event_id, x, y) VALUES (?, ?, ?, ?)",
        [(player_id, pt["event_id"], pt["x"], pt["y"]) for pt in points]
    )

# ── 메인 ────────────────────────────────────────────────
async def main():
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            extra_http_headers={
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://www.sofascore.com/",
            }
        )
        page = await ctx.new_page()

        # sofascore 메인 방문으로 쿠키/세션 확보
        log("sofascore 메인 페이지 접속 중...")
        await page.goto("https://www.sofascore.com/tournament/football/south-korea/k-league-1/410", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)
        log("세션 준비 완료")

        for league in LEAGUES:
            tid = league["tournament_id"]
            sid = league["season_id"]

            if sid is None:
                sid = await get_latest_season_id(page, tid)
                if not sid:
                    log(f"[{league['name']}] 시즌 ID 탐지 실패, 스킵")
                    continue
                log(f"[{league['name']}] 시즌 ID 자동 탐지: {sid}")

            log(f"\n{'='*50}")
            log(f"[{league['name']}] tournament:{tid} season:{sid}")

            teams = await fetch_teams(page, tid, sid)
            log(f"팀 {len(teams)}개 수집")

            for team in teams:
                save_team(conn, team, league["name"], tid, sid)
                conn.commit()
                log(f"\n  [{team['name']}]")

                players = await fetch_players(page, team["id"])
                log(f"  선수 {len(players)}명")

                for player in players:
                    save_player(conn, player, team["id"])

                    # 스탯
                    stats = await fetch_player_stats(page, player["id"], tid, sid)
                    if stats:
                        save_stats(conn, player["id"], tid, sid, stats)

                    # 히트맵
                    heatmap_pts = await fetch_player_heatmap(page, player["id"], conn)
                    if heatmap_pts:
                        save_heatmap(conn, player["id"], heatmap_pts)

                    log(f"    {player['name']} | 스탯:{bool(stats)} | 히트맵:{len(heatmap_pts)}pts")
                    conn.commit()
                    await asyncio.sleep(DELAY)

        await browser.close()
    conn.close()
    log("\n완료! players.db 저장됨")

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

if __name__ == "__main__":
    asyncio.run(main())
