#!/usr/bin/env python3
"""
crawl_league.py -- 해외 리그 범용 크롤러

사용법:
    python crawlers/crawl_league.py --league epl
    python crawlers/crawl_league.py --league laliga --year 2025
    python crawlers/crawl_league.py --league bundesliga --step events
    python crawlers/crawl_league.py --league all

수집 단계 (--step 으로 개별 실행 가능):
    events      : 경기 메타 (결과, 날짜, venue)
    teams       : 팀 기본정보
    players     : 선수 기본정보
    mps         : 경기별 선수 세부 스탯 (lineup)
    avgpos      : 평균 포지션 (팀 형태)
    shotmap     : 슛맵 + xG
    heatmap     : 히트맵 (선택, 시간 오래 걸림)
    all         : 위 전부 (heatmap 제외)
"""

import argparse
import asyncio
import json
import os
import sqlite3
import sys

from playwright.async_api import async_playwright

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LEAGUE_REGISTRY = {
    "epl":        {"db": "epl.db",         "label": "Premier League", "tid": 17,  "slug": "england/premier-league/17"},
    "laliga":     {"db": "laliga.db",       "label": "La Liga",        "tid": 8,   "slug": "spain/laliga/8"},
    "bundesliga": {"db": "bundesliga.db",   "label": "Bundesliga",     "tid": 35,  "slug": "germany/bundesliga/35"},
    "seriea":     {"db": "seriea.db",       "label": "Serie A",        "tid": 23,  "slug": "italy/serie-a/23"},
    "ligue1":     {"db": "ligue1.db",       "label": "Ligue 1",        "tid": 34,  "slug": "france/ligue-1/34"},
}

DELAY = 0.6


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


# ── Playwright API 헬퍼 ──────────────────────────────────────────────────────

async def api_fetch(page, path, retries=2):
    for attempt in range(retries + 1):
        try:
            result = await page.evaluate(f"""() =>
                fetch('{path}')
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
            """)
            return result
        except Exception as e:
            if attempt == retries:
                return None
            await asyncio.sleep(1)
    return None


async def open_browser(p, slug):
    """Chromium 실행 + SofaScore 세션 초기화."""
    browser = await p.chromium.launch(headless=True)
    ctx = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        extra_http_headers={
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.sofascore.com/",
        },
    )
    page = await ctx.new_page()
    url = f"https://www.sofascore.com/tournament/football/{slug}"
    log(f"  SofaScore 접속: {url}")
    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    await asyncio.sleep(3)
    log("  세션 준비 완료")
    return browser, page


# ── 시즌 ID 탐색 ─────────────────────────────────────────────────────────────

async def find_season_id(page, tid, year):
    """tournament_id + 연도 -> season_id 반환."""
    data = await api_fetch(page, f"/api/v1/unique-tournament/{tid}/seasons")
    if not data:
        return None
    seasons = data.get("seasons", [])
    year_str = str(year)
    for s in seasons:
        name = s.get("name", "") or s.get("year", "")
        sid  = s.get("id")
        # "2025/2026" 또는 "2025" 형식 모두 매칭
        if year_str in str(name):
            log(f"  시즌 발견: '{name}' (id={sid})")
            return sid
    # 첫 번째(최신) 시즌 폴백
    if seasons:
        s = seasons[0]
        log(f"  연도 매칭 실패 -> 최신 시즌 사용: '{s.get('name')}' (id={s.get('id')})")
        return s.get("id")
    return None


# ── STEP 1: events ───────────────────────────────────────────────────────────

async def crawl_events(page, conn, tid, season_id):
    """경기 메타 전체 수집 -> events 테이블."""
    log("[events] 경기 목록 수집 시작")
    all_events = []
    for page_num in range(0, 50):
        data = await api_fetch(
            page,
            f"/api/v1/unique-tournament/{tid}/season/{season_id}/events/last/{page_num}"
        )
        if not data:
            break
        evs = data.get("events", [])
        if not evs:
            break
        all_events.extend(evs)
        if not data.get("hasNextPage", False):
            break
        await asyncio.sleep(DELAY)

    # next (upcoming) events도 수집
    for page_num in range(0, 20):
        data = await api_fetch(
            page,
            f"/api/v1/unique-tournament/{tid}/season/{season_id}/events/next/{page_num}"
        )
        if not data:
            break
        evs = data.get("events", [])
        if not evs:
            break
        all_events.extend(evs)
        if not data.get("hasNextPage", False):
            break
        await asyncio.sleep(DELAY)

    saved = 0
    for ev in all_events:
        eid       = ev.get("id")
        home_team = ev.get("homeTeam", {})
        away_team = ev.get("awayTeam", {})
        home_score = ev.get("homeScore", {}).get("current")
        away_score = ev.get("awayScore", {}).get("current")
        date_ts    = ev.get("startTimestamp")
        round_info = ev.get("roundInfo", {})
        rnd        = round_info.get("round")
        season_sid = ev.get("season", {}).get("id", season_id)

        conn.execute("""
            INSERT OR REPLACE INTO events
                (id, tournament_id, season_id, home_team_id, away_team_id,
                 home_score, away_score, date_ts, round, status)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (eid, tid, season_sid,
              home_team.get("id"), away_team.get("id"),
              home_score, away_score, date_ts, rnd,
              ev.get("status", {}).get("type", "")))
        saved += 1

    conn.commit()
    log(f"[events] {saved}경기 저장 완료")
    return saved


# ── STEP 2: teams ────────────────────────────────────────────────────────────

async def crawl_teams(page, conn, tid, season_id):
    """팀 기본정보 수집 -> teams 테이블."""
    log("[teams] 팀 목록 수집")
    data = await api_fetch(page, f"/api/v1/unique-tournament/{tid}/season/{season_id}/teams")
    if not data:
        log("[teams] 응답 없음 -- events에서 팀 추출")
        _sync_teams_from_events(conn, tid)
        return

    teams = data.get("teams", [])
    for t in teams:
        conn.execute("""
            INSERT OR REPLACE INTO teams
                (id, name, short_name, tournament_id, season_id, primary_color)
            VALUES (?,?,?,?,?,?)
        """, (t.get("id"), t.get("name"), t.get("shortName"),
              tid, season_id, t.get("teamColors", {}).get("primary")))
    conn.commit()
    log(f"[teams] {len(teams)}팀 저장 완료")


def _sync_teams_from_events(conn, tid):
    """events 테이블에서 팀 ID 추출해 teams에 최소 레코드 삽입."""
    rows = conn.execute("""
        SELECT DISTINCT home_team_id AS tid FROM events WHERE tournament_id=?
        UNION
        SELECT DISTINCT away_team_id FROM events WHERE tournament_id=?
    """, (tid, tid)).fetchall()
    for (team_id,) in rows:
        if team_id:
            conn.execute(
                "INSERT OR IGNORE INTO teams (id, tournament_id) VALUES (?,?)",
                (team_id, tid)
            )
    conn.commit()
    log(f"[teams] events 기반 {len(rows)}팀 동기화")


# ── STEP 3: players ──────────────────────────────────────────────────────────

async def crawl_players(page, conn, tid, season_id):
    """각 팀 로스터 수집 -> players 테이블."""
    log("[players] 선수 수집 시작")
    team_ids = [r[0] for r in conn.execute(
        "SELECT id FROM teams WHERE tournament_id=?", (tid,)
    ).fetchall()]

    total = 0
    for team_id in team_ids:
        data = await api_fetch(page, f"/api/v1/team/{team_id}/players")
        if not isinstance(data, dict):
            await asyncio.sleep(DELAY)
            continue
        for p in data.get("players", []):
            pl = p.get("player", p)
            pid = pl.get("id")
            if not pid:
                continue
            conn.execute("""
                INSERT OR IGNORE INTO players
                    (id, team_id, name, position, height, nationality, jersey_number)
                VALUES (?,?,?,?,?,?,?)
            """, (pid, team_id, pl.get("name"),
                  pl.get("position"), pl.get("height"),
                  pl.get("nationality", {}).get("name") if isinstance(pl.get("nationality"), dict) else pl.get("nationality"),
                  p.get("shirtNumber")))
            total += 1
        await asyncio.sleep(DELAY)

    conn.commit()
    log(f"[players] {total}명 저장 완료")


# ── STEP 4: mps (경기별 선수 스탯) ──────────────────────────────────────────

def _parse_mps(s):
    def g(k):
        return s.get(k)
    _ap = g("accuratePass"); _tp = g("totalPass")
    return {
        "minutes_played":      g("minutesPlayed"),
        "rating":              g("rating"),
        "goals":               g("goals"),
        "assists":             g("goalAssist"),
        "expected_goals":      g("expectedGoals"),
        "total_shots":         g("totalShots"),
        "shots_on_target":     g("onTargetScoringAttempt"),
        "big_chances_missed":  g("bigChanceMissed"),
        "passes_total":        _tp,
        "passes_accurate":     _ap,
        "key_passes":          g("keyPass"),
        "long_balls":          g("totalLongBalls"),
        "long_balls_accurate": g("accurateLongBalls"),
        "crosses":             g("totalCross"),
        "crosses_accurate":    g("accurateCross"),
        "dribbles_attempted":  g("totalContest"),
        "dribbles_succeeded":  g("wonContest"),
        "duel_won":            g("duelWon"),
        "duel_lost":           g("duelLost"),
        "tackles":             g("totalTackle"),
        "interceptions":       g("interceptionWon"),
        "clearances":          g("totalClearance"),
        "aerial_won":          g("aerialWon"),
        "aerial_lost":         g("aerialLost"),
        "fouls_committed":     g("fouls"),
        "fouls_suffered":      g("wasFouled"),
        "yellow_cards":        g("yellowCard"),
        "red_cards":           g("redCard"),
        "saves":               g("saves"),
        "goals_conceded":      g("goalsConceded"),
    }


async def crawl_mps(page, conn, tid):
    """events 기반 경기별 선수 스탯 수집."""
    log("[mps] 경기별 선수 스탯 수집 시작")
    event_ids = [r[0] for r in conn.execute(
        "SELECT id FROM events WHERE tournament_id=? AND home_score IS NOT NULL ORDER BY date_ts",
        (tid,)
    ).fetchall()]

    done_events = {r[0] for r in conn.execute(
        "SELECT DISTINCT event_id FROM match_player_stats"
    ).fetchall()}
    todo = [eid for eid in event_ids if eid not in done_events]
    log(f"[mps] 대상 {len(todo)}경기 (완료: {len(done_events)}경기)")

    for i, eid in enumerate(todo):
        data = await api_fetch(page, f"/api/v1/event/{eid}/lineups")
        if not isinstance(data, dict):
            await asyncio.sleep(DELAY)
            continue

        saved = 0
        for side, is_home in [("home", 1), ("away", 0)]:
            side_data = data.get(side, {})
            for entry in side_data.get("players", []):
                pl = entry.get("player", {})
                pid = pl.get("id")
                if not pid:
                    continue
                team_id = entry.get("teamId") or side_data.get("teamId")
                s_dict  = _parse_mps(entry.get("statistics", {}))
                pos     = entry.get("position") or pl.get("position", "")
                cols    = list(s_dict.keys())
                vals    = list(s_dict.values())
                try:
                    conn.execute(f"""
                        INSERT OR REPLACE INTO match_player_stats
                            (event_id, player_id, player_name, team_id, is_home, position,
                             {', '.join(cols)})
                        VALUES (?,?,?,?,?,?, {', '.join(['?']*len(cols))})
                    """, [eid, pid, pl.get("name"), team_id, is_home, pos, *vals])
                    saved += 1
                except Exception as e:
                    log(f"    mps 저장 오류 pid={pid}: {e}")

        conn.commit()
        if (i + 1) % 20 == 0 or saved:
            log(f"  [{i+1}/{len(todo)}] event {eid} -> {saved}명")
        await asyncio.sleep(DELAY)

    log(f"[mps] 완료")


# ── STEP 5: avgpos ───────────────────────────────────────────────────────────

async def crawl_avgpos(page, conn, tid):
    """평균 포지션 수집 -> match_avg_positions 테이블."""
    log("[avgpos] 평균 포지션 수집 시작")
    event_ids = [r[0] for r in conn.execute(
        "SELECT id FROM events WHERE tournament_id=? AND home_score IS NOT NULL ORDER BY date_ts",
        (tid,)
    ).fetchall()]
    done = {r[0] for r in conn.execute(
        "SELECT DISTINCT event_id FROM match_avg_positions"
    ).fetchall()}
    todo = [eid for eid in event_ids if eid not in done]
    log(f"[avgpos] 대상 {len(todo)}경기")

    for i, eid in enumerate(todo):
        data = await api_fetch(page, f"/api/v1/event/{eid}/average-positions")
        if not isinstance(data, dict):
            await asyncio.sleep(DELAY)
            continue

        saved = 0
        for side, is_home in [("home", 1), ("away", 0)]:
            for entry in data.get(side, []):
                pl = entry.get("player", {})
                pid = pl.get("id")
                if not pid:
                    continue
                conn.execute("""
                    INSERT OR REPLACE INTO match_avg_positions
                        (event_id, player_id, team_id, is_home, is_substitute, avg_x, avg_y)
                    VALUES (?,?,?,?,?,?,?)
                """, (eid, pid,
                      entry.get("teamId"),
                      is_home,
                      1 if entry.get("substitute") else 0,
                      entry.get("averageX"), entry.get("averageY")))
                saved += 1

        conn.commit()
        if saved:
            log(f"  [{i+1}/{len(todo)}] event {eid} -> {saved}명")
        await asyncio.sleep(DELAY)

    log("[avgpos] 완료")


# ── STEP 6: shotmap ──────────────────────────────────────────────────────────

async def crawl_shotmap(page, conn, tid):
    """슛맵 수집 -> match_shotmap 테이블."""
    log("[shotmap] 슛맵 수집 시작")
    event_ids = [r[0] for r in conn.execute(
        "SELECT id FROM events WHERE tournament_id=? AND home_score IS NOT NULL ORDER BY date_ts",
        (tid,)
    ).fetchall()]
    done = {r[0] for r in conn.execute(
        "SELECT DISTINCT event_id FROM match_shotmap"
    ).fetchall()}
    todo = [eid for eid in event_ids if eid not in done]
    log(f"[shotmap] 대상 {len(todo)}경기")

    for i, eid in enumerate(todo):
        data = await api_fetch(page, f"/api/v1/event/{eid}/shotmap")
        if not isinstance(data, dict):
            await asyncio.sleep(DELAY)
            continue

        saved = 0
        for shot in data.get("shotmap", []):
            pl  = shot.get("player", {})
            pid = pl.get("id")
            conn.execute("""
                INSERT OR IGNORE INTO match_shotmap
                    (event_id, player_id, player_name, team_id, is_home,
                     x, y, xg, outcome, situation, body_part, minute, added_time)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (eid, pid, pl.get("name"),
                  shot.get("teamId"),
                  1 if shot.get("isHome") else 0,
                  shot.get("playerCoordinates", {}).get("x"),
                  shot.get("playerCoordinates", {}).get("y"),
                  shot.get("xg"),
                  shot.get("shotType"),
                  shot.get("situation"),
                  shot.get("bodyPart"),
                  shot.get("time"),
                  shot.get("addedTime")))
            saved += 1

        conn.commit()
        if saved:
            log(f"  [{i+1}/{len(todo)}] event {eid} -> {saved}슛")
        await asyncio.sleep(DELAY)

    log("[shotmap] 완료")


# ── STEP 7: heatmap (선택적) ─────────────────────────────────────────────────

async def crawl_heatmap(page, conn, tid):
    """히트맵 수집 -> heatmap_points 테이블 (시간 매우 오래 걸림)."""
    log("[heatmap] 히트맵 수집 시작 (시간 많이 소요)")
    player_ids = [r[0] for r in conn.execute(
        """SELECT DISTINCT m.player_id
           FROM match_player_stats m
           JOIN events e ON e.id = m.event_id
           WHERE e.tournament_id = ?""",
        (tid,)
    ).fetchall()]
    done = {r[0] for r in conn.execute(
        "SELECT DISTINCT player_id FROM heatmap_points"
    ).fetchall()}
    todo = [pid for pid in player_ids if pid not in done]
    log(f"[heatmap] 대상 {len(todo)}명 선수")

    for i, pid in enumerate(todo):
        data = await api_fetch(page, f"/api/v1/player/{pid}/heatmap/tournament/{tid}")
        if isinstance(data, dict):
            points = data.get("heatmap", [])
            if points:
                conn.executemany(
                    "INSERT OR IGNORE INTO heatmap_points (player_id, x, y) VALUES (?,?,?)",
                    [(pid, pt.get("x"), pt.get("y")) for pt in points]
                )
                conn.commit()
        if (i + 1) % 50 == 0:
            log(f"  {i+1}/{len(todo)} 완료")
        await asyncio.sleep(DELAY)

    log("[heatmap] 완료")


# ── 메인 ────────────────────────────────────────────────────────────────────

async def run_league(league_code, year, steps):
    cfg = LEAGUE_REGISTRY.get(league_code)
    if not cfg:
        log(f"[ERROR] 알 수 없는 리그: {league_code}")
        return

    db_path = os.path.join(BASE_DIR, cfg["db"])
    if not os.path.exists(db_path):
        log(f"[ERROR] DB 없음: {db_path}")
        log(f"  먼저 실행: python crawlers/init_league_db.py --league {league_code}")
        return

    tid  = cfg["tid"]
    slug = cfg["slug"]
    log(f"\n=== {cfg['label']} ({league_code}) | {year} ===")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    async with async_playwright() as p:
        browser, page = await open_browser(p, slug)

        season_id = await find_season_id(page, tid, year)
        if not season_id:
            log("[ERROR] 시즌 ID를 찾을 수 없음")
            await browser.close()
            conn.close()
            return
        log(f"  season_id={season_id}")

        step_map = {
            "events":  lambda: crawl_events(page, conn, tid, season_id),
            "teams":   lambda: crawl_teams(page, conn, tid, season_id),
            "players": lambda: crawl_players(page, conn, tid, season_id),
            "mps":     lambda: crawl_mps(page, conn, tid),
            "avgpos":  lambda: crawl_avgpos(page, conn, tid),
            "shotmap": lambda: crawl_shotmap(page, conn, tid),
            "heatmap": lambda: crawl_heatmap(page, conn, tid),
        }

        default_steps = ["events", "teams", "players", "mps", "avgpos", "shotmap"]
        run_steps = default_steps if steps == ["all"] else steps

        for step in run_steps:
            fn = step_map.get(step)
            if fn:
                await fn()
            else:
                log(f"[WARN] 알 수 없는 step: {step}")

        await browser.close()

    conn.close()
    log(f"=== {cfg['label']} 수집 완료 ===\n")


async def main():
    parser = argparse.ArgumentParser(description="해외 리그 범용 크롤러")
    parser.add_argument("--league", required=True,
                        help=f"리그 코드 또는 'all'. 선택: {', '.join(LEAGUE_REGISTRY)}, all")
    parser.add_argument("--year", type=int, default=2025,
                        help="수집 연도 (기본: 2025 = 2025/26 시즌)")
    parser.add_argument("--step", default="all",
                        help="수집 단계 (쉼표 구분): events,teams,players,mps,avgpos,shotmap,heatmap,all")
    args = parser.parse_args()

    steps = [s.strip() for s in args.step.split(",")]
    targets = list(LEAGUE_REGISTRY.keys()) if args.league == "all" else [args.league]

    for code in targets:
        await run_league(code, args.year, steps)


if __name__ == "__main__":
    asyncio.run(main())
