#!/usr/bin/env python3
"""
K리그2 전 팀 경기별 선수 세부 스탯 수집기 (경기 단위 수집)
- 경기 하나당 양 팀 선수 전부 한 번에 저장 → 중복 API 호출 없음
- 이미 수집된 event_id는 완전 스킵
- events, match_player_stats, 경기장 좌표, 날씨 통합 저장
"""

import asyncio
import json
import sqlite3
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from playwright.async_api import async_playwright

TOURNAMENT_ID = 777
DB_PATH       = "players.db"
DELAY         = 0.5
KST           = timezone(timedelta(hours=9))

KLEAGUE2_TEAMS = {
    7652, 7642, 41261, 7644, 189422, 339827, 314294,
    7651, 195172, 41263, 248375, 195174, 22020,
    7643, 314293, 41266, 41260,
}

# 2024-01-01 00:00 KST 기준 timestamp
MIN_TIMESTAMP = 1704034800

WEATHER_CODE_MAP = {
    0:"맑음", 1:"대체로 맑음", 2:"부분 흐림", 3:"흐림",
    45:"안개", 48:"결빙 안개",
    51:"가벼운 이슬비", 53:"이슬비", 55:"짙은 이슬비",
    61:"가벼운 비", 63:"비", 65:"강한 비",
    71:"가벼운 눈", 73:"눈", 75:"강한 눈",
    80:"소나기", 81:"강한 소나기", 82:"폭우",
    95:"뇌우", 96:"우박 뇌우", 99:"강한 우박 뇌우",
}

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

# ── API ─────────────────────────────────────────────────
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

# ── 스탯 파싱 ────────────────────────────────────────────
def parse_stats(s):
    def g(k): return s.get(k)
    return {
        "minutes_played":      g("minutesPlayed"),
        "rating":              g("rating"),
        "goals":               g("goals"),
        "assists":             g("goalAssist"),
        "total_shots":         g("totalShots"),
        "shots_on_target":     g("onTargetScoringAttempt"),
        "big_chances_missed":  g("bigChanceMissed"),
        "expected_goals":      g("expectedGoals"),
        "total_passes":        g("totalPass"),
        "accurate_passes":     g("accuratePass"),
        "accurate_passes_pct": (round(g("accuratePass") / g("totalPass") * 100, 1)
                                if g("totalPass") else None),
        "key_passes":          g("keyPass"),
        "accurate_long_balls": g("accurateLongBalls"),
        "total_long_balls":    g("totalLongBalls"),
        "accurate_crosses":    g("accurateCross"),
        "total_crosses":       g("totalCross"),
        "successful_dribbles": g("wonContest"),
        "attempted_dribbles":  g("totalContest"),
        "touches":             g("touches"),
        "possession_lost":     g("possessionLostCtrl"),
        "tackles":             g("totalTackle"),
        "interceptions":       g("interceptionWon"),
        "clearances":          g("totalClearance"),
        "blocked_shots":       g("outfielderBlock"),
        "duel_won":            g("duelWon"),
        "duel_lost":           g("duelLost"),
        "aerial_won":          g("aerialWon"),
        "aerial_lost":         g("aerialLost"),
        "was_fouled":          g("wasFouled"),
        "fouls":               g("fouls"),
        "yellow_cards":        g("yellowCard"),
        "red_cards":           g("redCard"),
        "saves":               g("saves"),
        "goals_conceded":      g("goalsConceded"),
    }

# ── 경기장 좌표 검증 ────────────────────────────────────
def is_valid_korea(lat, lon):
    return lat and lon and 33 <= lat <= 39 and 124 <= lon <= 132

def nominatim_geocode(name, city):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": f"{name}, {city}, South Korea", "format": "json", "limit": 1}
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "today_tactics/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            res = json.loads(resp.read())
        if res: return float(res[0]["lat"]), float(res[0]["lon"])
    except Exception as e:
        log(f"  Nominatim 오류: {e}")
    return None, None

# ── 날씨 수집 ────────────────────────────────────────────
def fetch_weather(date_str, hour, lat, lon):
    url = (
        f"https://archive-api.open-meteo.com/v1/archive"
        f"?latitude={lat}&longitude={lon}"
        f"&start_date={date_str}&end_date={date_str}"
        f"&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code"
        f"&timezone=Asia%2FSeoul"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        h = data["hourly"]
        return {
            "temperature":  h["temperature_2m"][hour],
            "humidity":     h["relative_humidity_2m"][hour],
            "wind_speed":   h["wind_speed_10m"][hour],
            "weather_code": h["weather_code"][hour],
            "weather_desc": WEATHER_CODE_MAP.get(h["weather_code"][hour], "알 수 없음"),
        }
    except Exception as e:
        log(f"  날씨 API 오류: {e}")
        return None

# ── K리그2 전체 경기 ID 수집 ────────────────────────────
async def get_all_event_ids(page, conn):
    """팀별로 경기 목록을 모아 K리그2 고유 경기 ID 집합 반환"""
    all_ids = set()
    existing = {r[0] for r in conn.execute(
        "SELECT DISTINCT event_id FROM match_player_stats"
    ).fetchall()}

    for team_id, team_name in [(tid, n) for tid, n in [
        (7652,"Suwon Samsung"),(7642,"Busan"),(41261,"Suwon FC"),
        (7644,"Daegu"),(189422,"Seoul E-Land"),(339827,"Chungnam Asan"),
        (314294,"Paju"),(7651,"Seongnam"),(195172,"Gimpo"),
        (41263,"Cheonan"),(248375,"Ansan"),(195174,"Hwaseong"),
        (22020,"Gyeongnam"),(7643,"Jeonnam"),(314293,"Cheongju"),
        (41266,"Yongin"),(41260,"Gimhae"),
    ]]:
        page_num = 0
        while True:
            data = await api_fetch(page, f"/api/v1/team/{team_id}/events/last/{page_num}")
            if not isinstance(data, dict): break
            events = data.get("events", [])
            if not events: break
            stop = False
            for ev in events:
                tid = ev.get("tournament", {}).get("uniqueTournament", {}).get("id")
                ts = ev.get("startTimestamp", 0)
                if ts < MIN_TIMESTAMP:
                    stop = True
                    break
                if tid == TOURNAMENT_ID:
                    all_ids.add(ev["id"])
            if stop or not data.get("hasNextPage", False): break
            page_num += 1
            await asyncio.sleep(DELAY * 0.3)
        log(f"  {team_name}: 누적 {len(all_ids)}경기")

    todo = sorted(all_ids - existing)
    log(f"\n전체 고유 경기: {len(all_ids)}개 | 신규 수집 대상: {len(todo)}개")
    return todo

# ── 경기 단위 수집 ───────────────────────────────────────
async def collect_event(page, conn, eid):
    """경기 하나에서 양 팀 선수 스탯 + events + 경기장 저장"""

    # 1) event 메타 + 경기장
    ev_data = await api_fetch(page, f"/api/v1/event/{eid}")
    lat = lon = v_name = v_city = None
    if isinstance(ev_data, dict):
        ev = ev_data.get("event", {})
        ht = ev.get("homeTeam", {}); at = ev.get("awayTeam", {})
        venue = ht.get("venue", {})
        v_name = venue.get("name") or venue.get("stadium", {}).get("name")
        v_city = venue.get("city", {}).get("name", "")
        coords = venue.get("venueCoordinates", {})
        raw_lat, raw_lon = coords.get("latitude"), coords.get("longitude")
        if raw_lat and raw_lon:
            if is_valid_korea(raw_lat, raw_lon): lat, lon = raw_lat, raw_lon
            elif is_valid_korea(raw_lon, raw_lat): lat, lon = raw_lon, raw_lat
        if lat is None and v_name:
            lat, lon = nominatim_geocode(v_name, v_city)
            time.sleep(1.1)

        conn.execute("""
            INSERT OR REPLACE INTO events
                (id, home_team_id, home_team_name, away_team_id, away_team_name,
                 date_ts, home_score, away_score, tournament_id,
                 venue_name, venue_city, venue_lat, venue_lon)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (eid, ht.get("id"), ht.get("name"), at.get("id"), at.get("name"),
              ev.get("startTimestamp"),
              ev.get("homeScore", {}).get("current"),
              ev.get("awayScore", {}).get("current"),
              TOURNAMENT_ID, v_name, v_city, lat, lon))
        conn.commit()

    await asyncio.sleep(DELAY)

    # 2) lineups → 양 팀 선수 스탯
    lineups = await api_fetch(page, f"/api/v1/event/{eid}/lineups")
    if not isinstance(lineups, dict):
        return 0

    saved = 0
    for side, is_home in [("home", 1), ("away", 0)]:
        for entry in lineups.get(side, {}).get("players", []):
            team_id = entry.get("teamId")
            if team_id not in KLEAGUE2_TEAMS: continue
            player = entry.get("player", {})
            pid = player.get("id")
            if not pid: continue
            stats_raw = entry.get("statistics", {})
            s_dict = parse_stats(stats_raw)
            cols = list(s_dict.keys()); vals = list(s_dict.values())
            conn.execute(f"""
                INSERT OR REPLACE INTO match_player_stats
                    (event_id, player_id, team_id, is_home, position, shirt_number,
                     {', '.join(cols)}, raw_json)
                VALUES (?,?,?,?,?,?, {', '.join(['?']*len(cols))}, ?)
            """, [eid, pid, team_id, is_home,
                  entry.get("position"), entry.get("shirtNumber"),
                  *vals, json.dumps(stats_raw, ensure_ascii=False)])
            saved += 1

    conn.commit()
    return saved

# ── 히트맵 수집 ─────────────────────────────────────────
async def fill_heatmap(page, conn):
    log("\n[히트맵 수집]")
    # 스탯은 있는데 히트맵이 없는 선수×경기 조합
    rows = conn.execute("""
        SELECT mps.event_id, mps.player_id
        FROM match_player_stats mps
        WHERE NOT EXISTS (
            SELECT 1 FROM heatmap_points hp
            WHERE hp.event_id = mps.event_id AND hp.player_id = mps.player_id
        )
        ORDER BY mps.event_id
    """).fetchall()
    log(f"  대상: {len(rows)}건 (선수×경기)")

    batch = []
    for i, (eid, pid) in enumerate(rows):
        hdata = await api_fetch(page, f"/api/v1/event/{eid}/player/{pid}/heatmap")
        if isinstance(hdata, dict):
            pts = hdata.get("heatmap", [])
            batch.extend([(pid, eid, pt["x"], pt["y"]) for pt in pts])

        if len(batch) >= 500:
            conn.executemany(
                "INSERT OR IGNORE INTO heatmap_points (player_id, event_id, x, y) VALUES (?,?,?,?)",
                batch
            )
            conn.commit()
            batch = []

        if (i + 1) % 100 == 0:
            now = datetime.now(tz=KST).strftime("%H:%M:%S")
            log(f"  [{now}] {i+1}/{len(rows)} 완료")

        await asyncio.sleep(DELAY * 0.4)

    if batch:
        conn.executemany(
            "INSERT OR IGNORE INTO heatmap_points (player_id, event_id, x, y) VALUES (?,?,?,?)",
            batch
        )
        conn.commit()
    log("  히트맵 수집 완료")

# ── result + 날씨 일괄 보완 ──────────────────────────────
def fill_result_and_weather(conn):
    # result
    conn.execute("""
        UPDATE match_player_stats
        SET result = (
            SELECT CASE
                WHEN match_player_stats.is_home=1 AND e.home_score > e.away_score THEN 2
                WHEN match_player_stats.is_home=0 AND e.away_score > e.home_score THEN 2
                WHEN e.home_score = e.away_score THEN 1
                ELSE 0
            END
            FROM events e WHERE e.id = match_player_stats.event_id
        )
        WHERE result IS NULL
    """)
    conn.commit()
    log("  result 업데이트 완료")

    # 날씨
    rows = conn.execute("""
        SELECT mps.event_id, e.date_ts, e.venue_lat, e.venue_lon, e.venue_name
        FROM match_player_stats mps
        JOIN events e ON mps.event_id = e.id
        WHERE mps.match_date IS NULL
          AND e.date_ts IS NOT NULL AND e.venue_lat IS NOT NULL
        GROUP BY mps.event_id
        ORDER BY e.date_ts
    """).fetchall()
    log(f"  날씨 수집 대상: {len(rows)}경기")
    for eid, date_ts, lat, lon, venue_name in rows:
        dt = datetime.fromtimestamp(date_ts, tz=KST)
        w = fetch_weather(dt.strftime("%Y-%m-%d"), dt.hour, lat, lon)
        if w:
            conn.execute("""
                UPDATE match_player_stats
                SET match_date=?, temperature=?, humidity=?, wind_speed=?, weather_code=?, weather_desc=?
                WHERE event_id=?
            """, (dt.strftime("%Y-%m-%d %H:%M"),
                  w["temperature"], w["humidity"], w["wind_speed"],
                  w["weather_code"], w["weather_desc"], eid))
            conn.commit()
            log(f"  event {eid} | {venue_name} | {w['temperature']}C | {w['weather_desc']}")
        time.sleep(0.5)

# ── 메인 ────────────────────────────────────────────────
async def main():
    conn = sqlite3.connect(DB_PATH)

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
        log("세션 준비 완료")

        log("\n[경기 ID 수집]")
        todo = await get_all_event_ids(page, conn)

        log(f"\n[스탯 수집] {len(todo)}경기")
        for i, eid in enumerate(todo):
            saved = await collect_event(page, conn, eid)
            log(f"  [{i+1}/{len(todo)}] event {eid} → {saved}명")
            await asyncio.sleep(DELAY)

        log("\n[히트맵 수집]")
        await fill_heatmap(page, conn)

        await browser.close()

    log("\n[result + 날씨 보완]")
    fill_result_and_weather(conn)
    conn.close()
    log("\n전체 수집 완료!")

if __name__ == "__main__":
    asyncio.run(main())
