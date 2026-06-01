"""
events 테이블에 round 컬럼을 추가하고 K리그 공식 API(kleague.com)로 채운다.
K1(leagueId=1) + K2(leagueId=2) 모두 처리.
"""
import sqlite3, json, urllib.request, datetime, os

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "players.db")

KLEAGUE_TEAM_CODE = {
    "K02": "suwon",    "K06": "busan",    "K07": "jeonnam",  "K08": "seongnam",
    "K17": "daegu",    "K20": "gyeongnam","K29": "suwon_fc", "K31": "seouland",
    "K32": "ansan",    "K34": "asan",     "K36": "gimpo",    "K37": "cheongju",
    "K38": "cheonan",  "K39": "hwaseong", "K40": "paju",     "K41": "gimhae",
    "K42": "yongin",
    "K01": "ulsan",    "K03": "pohang",   "K04": "jeju",     "K05": "jeonbuk",
    "K09": "fcseoul",  "K10": "daejeon",  "K18": "incheon",  "K21": "gangwon",
    "K22": "gwangju",  "K26": "bucheon",  "K27": "anyang",   "K35": "gimcheon",
}

# main.py TEAMS 리스트에서 추출한 slug → sofascore_id
SLUG_TO_SSID = {
    # K1 (main.py TEAMS 기준)
    "ulsan": 7653,    "pohang": 7650,   "jeju": 7649,     "jeonbuk": 6908,
    "fcseoul": 7646,  "daejeon": 7645,  "incheon": 7648,  "gangwon": 34220,
    "gwangju": 48912, "bucheon": 92539, "anyang": 32675,  "gimcheon": 7647,
    # K2
    "suwon": 7652,    "busan": 7642,    "jeonnam": 7643,  "seongnam": 7651,
    "daegu": 7644,    "gyeongnam": 22020,"suwon_fc": 41261,"seouland": 189422,
    "ansan": 248375,  "asan": 339827,   "gimpo": 195172,  "cheongju": 314293,
    "cheonan": 41263, "hwaseong": 195174,"paju": 314294,  "gimhae": 41260,
    "yongin": 41266,
}


def fetch_games(league_id: str, year: int) -> list:
    url = "https://www.kleague.com/getScheduleList.do"
    now_month = datetime.datetime.now().month if year == datetime.datetime.now().year else 12
    games = []
    for m in range(1, now_month + 2):
        if m > 12:
            break
        payload = json.dumps({"leagueId": league_id, "year": str(year),
                               "month": str(m).zfill(2)}).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
            headers={"Content-Type": "application/json; charset=UTF-8",
                     "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                games += data.get("data", {}).get("scheduleList", [])
        except Exception as e:
            print(f"  fetch {league_id}/{m} 실패: {e}")
    return games


def run(year: int = 2026):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # round 컬럼 추가 (없으면)
    cols = {r[1] for r in cur.execute("PRAGMA table_info(events)").fetchall()}
    if "round" not in cols:
        cur.execute("ALTER TABLE events ADD COLUMN round INTEGER")
        conn.commit()
        print("events.round 컬럼 추가")
    else:
        print("events.round 이미 존재")

    total_updated = 0
    for league_id, tid_filter in [("1", 410), ("2", 777)]:
        label = "K1" if league_id == "1" else "K2"
        print(f"\n{label} 라운드 수집 중...")
        games = fetch_games(league_id, year)
        print(f"  API {len(games)}경기")

        updated = skipped = no_match = 0
        for g in games:
            round_no = g.get("roundId")
            if not round_no:
                skipped += 1
                continue
            try:
                round_no = int(round_no)
            except (ValueError, TypeError):
                skipped += 1
                continue

            game_date = g.get("gameDate", "")  # "2026.MM.DD"
            home_code = g.get("homeTeam", "")
            away_code = g.get("awayTeam", "")

            home_ssid = SLUG_TO_SSID.get(KLEAGUE_TEAM_CODE.get(home_code, ""))
            away_ssid = SLUG_TO_SSID.get(KLEAGUE_TEAM_CODE.get(away_code, ""))
            if not home_ssid or not away_ssid:
                skipped += 1
                continue

            try:
                dt = datetime.datetime.strptime(game_date, "%Y.%m.%d")
            except ValueError:
                skipped += 1
                continue
            start_ts = int(dt.timestamp())
            end_ts   = start_ts + 86400

            cur.execute("""
                UPDATE events SET round = ?
                WHERE tournament_id = ?
                  AND date_ts >= ? AND date_ts < ?
                  AND home_team_id = ? AND away_team_id = ?
                  AND (round IS NULL OR round != ?)
            """, (round_no, tid_filter, start_ts, end_ts,
                  home_ssid, away_ssid, round_no))
            if cur.rowcount > 0:
                updated += 1
            else:
                ev = cur.execute("""
                    SELECT id FROM events
                    WHERE tournament_id=? AND date_ts>=? AND date_ts<?
                      AND home_team_id=? AND away_team_id=?
                """, (tid_filter, start_ts, end_ts, home_ssid, away_ssid)).fetchone()
                if not ev:
                    no_match += 1

        conn.commit()
        total_updated += updated
        print(f"  업데이트 {updated}건, 매칭 실패 {no_match}건, 스킵 {skipped}건")

    # 요약
    filled = cur.execute(
        "SELECT COUNT(*) FROM events WHERE round IS NOT NULL AND tournament_id IN (410,777)"
    ).fetchone()[0]
    empty = cur.execute(
        "SELECT COUNT(*) FROM events WHERE round IS NULL AND tournament_id IN (410,777)"
    ).fetchone()[0]
    print(f"\n결과: round 채워진 K1/K2 이벤트 {filled}건, 비어있는 {empty}건")

    # 2026 라운드 분포
    rows = cur.execute("""
        SELECT tournament_id, round, COUNT(*) as n
        FROM events WHERE tournament_id IN (410,777) AND round IS NOT NULL
          AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))='2026'
        GROUP BY tournament_id, round ORDER BY tournament_id, round
    """).fetchall()
    print("\n2026 K1/K2 라운드별 경기 수:")
    for r in rows:
        label = "K1" if r[0] == 410 else "K2"
        print(f"  {label} R{r[1]:2d}: {r[2]}경기")

    conn.close()


if __name__ == "__main__":
    run()
