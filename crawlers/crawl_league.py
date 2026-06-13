#!/usr/bin/env python3
"""
crawl_league.py -- 해외 리그 범용 크롤러

사용법:
    python crawlers/crawl_league.py --league epl
    python crawlers/crawl_league.py --league laliga --year 2025
    python crawlers/crawl_league.py --league bundesliga --step events
    python crawlers/crawl_league.py --league all

수집 단계 (--step 으로 개별 실행 가능):
    teams       : 팀 기본정보 (standings API -> slug/name)
    events      : 경기 메타 (팀 프로필 페이지 방문 방식)
    all         : teams + events

참고:
    mps/avgpos/shotmap/heatmap 은 SofaScore EPL 봇 차단(403)으로 현재 미지원.
    K리그 대비 유럽 상위 리그는 세부 API가 강하게 보호됨.
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
    # season_ids: 2025 = 2024/25 시즌 (시즌 시작 연도)
    "epl":        {"db": "epl.db",         "label": "Premier League", "tid": 17,  "slug": "england/premier-league/17",
                   "season_ids": {2025: 76986}},
    "laliga":     {"db": "laliga.db",       "label": "La Liga",        "tid": 8,   "slug": "spain/laliga/8",
                   "season_ids": {2025: 77559}},
    "bundesliga": {"db": "bundesliga.db",   "label": "Bundesliga",     "tid": 35,  "slug": "germany/bundesliga/35",
                   "season_ids": {2025: 77333}},
    "seriea":     {"db": "seriea.db",       "label": "Serie A",        "tid": 23,  "slug": "italy/serie-a/23",
                   "season_ids": {2025: 76457},
                   "fallback_sids": {2025: 95836}},   # 팀 목록용 (standings API 403 우회)
    "ligue1":     {"db": "ligue1.db",       "label": "Ligue 1",        "tid": 34,  "slug": "france/ligue-1/34",
                   "season_ids": {2025: 77356},
                   "fallback_sids": {2025: 96127}},   # 팀 목록용 (standings API 403 우회)
}

DELAY = 0.8


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


# ── Playwright 헬퍼 ──────────────────────────────────────────────────────────

async def open_browser(p, slug):
    """Chromium 실행 + SofaScore tournament 페이지 세션 초기화."""
    browser = await p.chromium.launch(headless=True)
    ctx = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    )
    page = await ctx.new_page()
    url = f"https://www.sofascore.com/tournament/football/{slug}"
    log(f"  SofaScore 접속: {url}")
    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    await asyncio.sleep(3)
    log("  세션 준비 완료")
    return browser, ctx, page


# ── STEP 1: standings + teams (standings API) ─────────────────────────────────

async def crawl_standings(page, conn, tid, season_id, fallback_sid=None):
    """standings API로 순위표 + 팀 목록 동시 수집.
    tournament 페이지 컨텍스트에서 호출해야 함.
    fallback_sid: 메인 season_id 실패 시 팀 목록 수집 전용으로 사용.
    """
    import time
    log("[standings] standings API로 순위표 + 팀 목록 수집")

    async def _fetch_standings(sid):
        return await page.evaluate(f"""() =>
            fetch('/api/v1/unique-tournament/{tid}/season/{sid}/standings/total')
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        """)

    data = await _fetch_standings(season_id)
    rows = data["standings"][0].get("rows", []) if isinstance(data, dict) and data.get("standings") else []

    # league_standings에 저장할 데이터 판단 (matches > 0인 실제 데이터 여부)
    has_real_data = rows and rows[0].get("matches", 0) > 0

    # 팀 목록만 있고 경기 데이터가 없을 경우 fallback으로 팀 수집
    if not rows and fallback_sid:
        log(f"[standings] 메인 season_id({season_id}) 실패 → fallback({fallback_sid})으로 팀 목록 수집")
        data2 = await _fetch_standings(fallback_sid)
        if isinstance(data2, dict) and data2.get("standings"):
            rows = data2["standings"][0].get("rows", [])

    if not rows:
        log("[standings] standings API 실패 (팀 목록 없음)")
        return 0

    now_ts = int(time.time())
    saved = 0
    for r in rows:
        t = r.get("team", {})
        tid_t = t.get("id")
        if not tid_t:
            continue

        # teams 테이블 (항상 저장)
        conn.execute("""
            INSERT OR REPLACE INTO teams
                (id, name, short_name, slug, tournament_id, season_id)
            VALUES (?,?,?,?,?,?)
        """, (tid_t, t.get("name"), t.get("shortName"), t.get("slug"),
              tid, season_id))

        # league_standings (실제 경기 데이터 있을 때만 저장)
        if has_real_data:
            gf = r.get("scoresFor", 0) or 0
            ga = r.get("scoresAgainst", 0) or 0
            conn.execute("""
                INSERT OR REPLACE INTO league_standings
                    (tournament_id, season_id, team_id, team_name, team_slug,
                     position, matches, wins, draws, losses, gf, ga, gd, points, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (tid, season_id, tid_t, t.get("name"), t.get("slug"),
                  r.get("position"), r.get("matches"),
                  r.get("wins"), r.get("draws"), r.get("losses"),
                  gf, ga, gf - ga, r.get("points"), now_ts))
        saved += 1

    conn.commit()
    st_note = f"순위표 {saved}팀" if has_real_data else f"팀 목록만 {saved}팀 (순위표 데이터 없음)"
    log(f"[standings] {st_note} 저장 완료")
    return saved


# standings 별칭 (하위 호환)
async def crawl_teams(page, conn, tid, season_id):
    return await crawl_standings(page, conn, tid, season_id)


def _sync_teams_from_events(conn, tid):
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


# ── STEP 2: events (팀 프로필 페이지 방문 방식) ──────────────────────────────

async def crawl_events(page, conn, tid, season_id, ctx):
    """각 팀 프로필 페이지를 방문해 이벤트 수집 -> events 테이블.

    팀 단위 events API (/api/v1/team/{id}/events/last/{page}) 는
    팀 프로필 페이지 컨텍스트에서만 200 응답. tournament 레벨 API 는 403.
    """
    log("[events] 팀 프로필 페이지 방식으로 경기 목록 수집")

    team_rows = conn.execute(
        "SELECT id, slug FROM teams WHERE tournament_id=? AND slug IS NOT NULL",
        (tid,)
    ).fetchall()

    if not team_rows:
        log("[events] teams 테이블에 slug 정보 없음. 먼저 teams 단계 실행 필요")
        return 0

    all_events = {}  # event_id -> event dict

    for (team_id, slug) in team_rows:
        team_url = f"https://www.sofascore.com/team/football/{slug}/{team_id}"
        try:
            await page.goto(team_url, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(2)
        except Exception as e:
            log(f"  [{slug}] 페이지 이동 실패: {e}")
            continue

        # last (completed) events
        page_num = 0
        while True:
            data = await page.evaluate(f"""() =>
                fetch('/api/v1/team/{team_id}/events/last/{page_num}')
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
            """)
            if not isinstance(data, dict):
                break
            events = data.get("events", [])
            if not events:
                break
            for ev in events:
                ut = ev.get("tournament", {}).get("uniqueTournament", {})
                ev_season = ev.get("season", {})
                if ut.get("id") == tid and ev_season.get("id") == season_id:
                    eid = ev.get("id")
                    if eid and eid not in all_events:
                        all_events[eid] = ev
            if not data.get("hasNextPage", False):
                break
            page_num += 1
            await asyncio.sleep(DELAY)

        log(f"  [{slug}] 완료 | 누적 {len(all_events)}경기")
        await asyncio.sleep(DELAY)

    # DB 저장
    saved = 0
    for eid, ev in all_events.items():
        home_team = ev.get("homeTeam", {})
        away_team = ev.get("awayTeam", {})
        home_score = ev.get("homeScore", {}).get("current")
        away_score = ev.get("awayScore", {}).get("current")
        date_ts    = ev.get("startTimestamp")
        round_info = ev.get("roundInfo", {})
        rnd        = round_info.get("round")
        status_type = ev.get("status", {}).get("type", "")

        # 홈/원정 팀 이름이 teams에 없으면 추가
        for team in [home_team, away_team]:
            tid_t = team.get("id")
            if tid_t and team.get("name"):
                conn.execute("""
                    INSERT OR IGNORE INTO teams (id, name, short_name, slug, tournament_id, season_id)
                    VALUES (?,?,?,?,?,?)
                """, (tid_t, team.get("name"), team.get("shortName"),
                      team.get("slug"), tid, season_id))

        conn.execute("""
            INSERT OR REPLACE INTO events
                (id, tournament_id, season_id, home_team_id, away_team_id,
                 home_score, away_score, date_ts, round, status)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (eid, tid, season_id,
              home_team.get("id"), away_team.get("id"),
              home_score, away_score, date_ts, rnd, status_type))
        saved += 1

    conn.commit()
    log(f"[events] {saved}경기 저장 완료")
    return saved


# ── STEP 3: players + season stats ──────────────────────────────────────────

async def crawl_players(page, conn, tid, season_id, fallback_sid=None):
    """top-players/overall API로 선수 목록 + 시즌 누적 스탯 수집.

    전략:
    - /api/v1/unique-tournament/{tid}/season/{sid}/top-players/overall
      → 28개 카테고리 × 최대 50명 → ~300+ unique 선수
    - 카테고리별 stats를 player_id 기준으로 합산 → 1회 API 호출로 완료
    - team/{id}/players 및 개인 페이지 방문 불필요 (EPL 등 상위 리그 403 우회)
    - fallback_sid: 메인 season_id 실패 시 Serie A/Ligue 1 대체 sid
    """
    import json, time
    log("[players] top-players/overall API로 선수 스탯 수집")

    async def _fetch_top(sid):
        return await page.evaluate(f"""() =>
            fetch('/api/v1/unique-tournament/{tid}/season/{sid}/top-players/overall')
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        """)

    data = await _fetch_top(season_id)
    if (not isinstance(data, dict) or not data.get("topPlayers")) and fallback_sid:
        log(f"  메인 season_id({season_id}) 실패 → fallback({fallback_sid}) 시도")
        data = await _fetch_top(fallback_sid)

    if not isinstance(data, dict) or not data.get("topPlayers"):
        log("[players] top-players/overall API 실패 (403 또는 데이터 없음)")
        return 0

    tp = data["topPlayers"]

    # player_id → {player_info, team_info, merged_stats} 집계
    player_map = {}
    for cat, entries in tp.items():
        for entry in (entries or []):
            p_obj = entry.get("player", {})
            t_obj = entry.get("team", {})
            s_obj = entry.get("statistics", {})
            pid = p_obj.get("id")
            if not pid:
                continue
            if pid not in player_map:
                player_map[pid] = {
                    "player": p_obj,
                    "team":   t_obj,
                    "stats":  {},
                }
            # appearances는 덮어쓰기(가장 정확한 값 유지), 나머지는 update
            pm = player_map[pid]["stats"]
            for k, v in s_obj.items():
                if k in ("id", "type", "statisticsType"):
                    continue
                # appearances: 최댓값 유지
                if k == "appearances":
                    pm[k] = max(pm.get(k) or 0, v or 0)
                elif k not in pm:
                    pm[k] = v

    log(f"  집계 완료 | unique 선수 {len(player_map)}명")

    now_ts = int(time.time())
    saved_p = 0
    saved_s = 0

    for pid, info in player_map.items():
        p_obj = info["player"]
        t_obj = info["team"]
        s     = info["stats"]

        team_id = t_obj.get("id")

        # players 테이블 저장
        conn.execute("""
            INSERT OR REPLACE INTO players
                (id, team_id, name, slug, position)
            VALUES (?,?,?,?,?)
        """, (
            pid, team_id,
            p_obj.get("name"), p_obj.get("slug"),
            p_obj.get("position"),
        ))
        saved_p += 1

        # teams 테이블 보완 (color 정보 포함)
        if team_id and t_obj.get("name"):
            colors = t_obj.get("teamColors", {})
            conn.execute("""
                INSERT OR IGNORE INTO teams
                    (id, name, slug, tournament_id, season_id, primary_color, secondary_color)
                VALUES (?,?,?,?,?,?,?)
            """, (
                team_id, t_obj.get("name"), t_obj.get("slug"),
                tid, season_id,
                colors.get("primary"), colors.get("secondary"),
            ))

        # player_stats 저장
        conn.execute("""
            INSERT OR REPLACE INTO player_stats (
                player_id, tournament_id, season_id,
                appearances, rating,
                goals, assists, expected_goals, expected_assists,
                total_shots, shots_on_target,
                accurate_passes, accurate_passes_pct,
                key_passes, successful_dribbles,
                tackles, interceptions, yellow_cards, red_cards,
                big_chances_created, big_chances_missed,
                clearances, possession_lost,
                saves, clean_sheet, goals_conceded,
                raw_json
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            pid, tid, season_id,
            s.get("appearances"),          s.get("rating"),
            s.get("goals"),                s.get("assists"),
            s.get("expectedGoals"),        s.get("expectedAssists"),
            s.get("totalShots"),           s.get("shotsOnTarget"),
            s.get("accuratePasses"),       s.get("accuratePassesPercentage"),
            s.get("keyPasses"),            s.get("successfulDribbles"),
            s.get("tackles"),              s.get("interceptions"),
            s.get("yellowCards"),          s.get("redCards"),
            s.get("bigChancesCreated"),    s.get("bigChancesMissed"),
            s.get("clearances"),           s.get("possessionLost"),
            s.get("saves"),                s.get("cleanSheet"),
            s.get("goalsConceded"),
            json.dumps(s, ensure_ascii=False),
        ))
        saved_s += 1

    conn.commit()
    log(f"[players] 완료 | 선수 {saved_p}명 | 스탯 {saved_s}명 저장")
    return saved_s


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

    tid       = cfg["tid"]
    slug      = cfg["slug"]
    season_id = cfg.get("season_ids", {}).get(int(year))
    if not season_id:
        log(f"[ERROR] year={year} 에 해당하는 season_id 없음. LEAGUE_REGISTRY 확인 필요")
        return

    log(f"\n=== {cfg['label']} ({league_code}) | year={year} | season_id={season_id} ===")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    unsupported = {"mps", "avgpos", "shotmap", "heatmap"}
    default_steps = ["standings", "events", "players"]
    run_steps = default_steps if steps == ["all"] else steps

    async with async_playwright() as p:
        browser, ctx, page = await open_browser(p, slug)

        fallback_sid = cfg.get("fallback_sids", {}).get(int(year))

        for step in run_steps:
            if step in unsupported:
                log(f"[{step}] SofaScore 봇 차단(403)으로 현재 미지원. 스킵.")
                continue
            elif step in ("teams", "standings"):
                await crawl_standings(page, conn, tid, season_id, fallback_sid)
            elif step == "events":
                await crawl_events(page, conn, tid, season_id, ctx)
            elif step == "players":
                await crawl_players(page, conn, tid, season_id, fallback_sid)
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
                        help="수집 연도 (기본: 2025 = 2024/25 시즌)")
    parser.add_argument("--step", default="all",
                        help="수집 단계 (쉼표 구분): teams,events,all")
    args = parser.parse_args()

    steps = [s.strip() for s in args.step.split(",")]
    targets = list(LEAGUE_REGISTRY.keys()) if args.league == "all" else [args.league]

    for code in targets:
        await run_league(code, args.year, steps)


if __name__ == "__main__":
    asyncio.run(main())
