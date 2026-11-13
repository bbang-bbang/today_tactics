#!/usr/bin/env python3
"""
해외 리그 데이터 수집 — API-Football(api-sports.io, 정식 유료 API). 2026-11-11.

SofaScore 해외 리그 엔드포인트가 403(크롤러 차단)이라 대체. 기존 해외 리그 DB 구조(init_league_db.SCHEMA_SQL)에
그대로 저장해 /api/league/<code>/standings·team-rankings·top-performers 가 바로 쓴다.
  - league_standings : /standings (리그당 1회)
  - teams · players · player_stats : /players?league&season&page (리그당 약 30페이지, 페이지당 20명)
  - events · match_player_stats : --part matches — /fixtures(리그당 1회) + 끝난 경기마다 /fixtures/players 1회(증분)
제공 안 되는 것: xG(expected_goals NULL), 몸값, 히트맵·슈팅 위치.

키: 환경변수 APIFOOTBALL_KEY 또는 ~/.apifootball_key (저장소에 넣지 않는다).
호출 한도: 실행당 --max-calls(기본 400) + 응답 헤더의 '오늘 남은 호출'이 --reserve(기본 200) 아래로 떨어지면 중단.

사용:
  python crawlers/collect_apifootball.py --league epl                 # dry-run (호출은 하되 저장 안 함 — 1회만 써서 형태 확인하려면 --max-calls 1)
  python crawlers/collect_apifootball.py --league all --apply
  python crawlers/collect_apifootball.py --league top --part matches --apply --max-calls 1200   # 1부 6개 경기별 기록
"""
import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "crawlers"))
from init_league_db import SCHEMA_SQL   # noqa: E402

BASE = "https://v3.football.api-sports.io"
# code → (API-Football league id, 시즌(시작 연도), 이 DB에서 쓰는 tournament_id — main.LEAGUE_REGISTRY 와 일치, 선수 기록 수집 여부)
# 하위 리그 tournament_id = API-Football id (리그별 DB 파일이라 충돌 없음). players=False → 순위표만(coverage 없음, /players 호출 생략).
LEAGUES = {
    "epl":         (39, 2026, 17, True),
    "laliga":      (140, 2026, 8, True),
    "bundesliga":  (78, 2026, 35, True),
    "seriea":      (135, 2026, 23, True),
    "ligue1":      (61, 2026, 34, True),
    "brasileirao": (71, 2026, 325, True),
    # ── 2·3부 (2026-11-12) ──
    "championship": (40, 2026, 40, True),
    "leagueone":    (41, 2026, 41, True),
    "bundesliga2":  (79, 2026, 79, True),
    "liga3":        (80, 2026, 80, True),
    "segunda":      (141, 2026, 141, True),
    "primerarfef1": (435, 2026, 435, False),
    "primerarfef2": (436, 2026, 436, False),
    "serieb":       (136, 2026, 136, True),
    "seriec_a":     (942, 2026, 942, False),
    "seriec_b":     (943, 2026, 943, False),
    "seriec_c":     (138, 2026, 138, False),
    "ligue2":       (62, 2026, 62, True),
    "ligue3":       (63, 2026, 63, False),
    "brasileirob":  (72, 2026, 72, True),
    "brasileiroc":  (75, 2026, 75, True),
}
DB_FILES = {code: f"{code}.db" for code in LEAGUES}
POS = {"Goalkeeper": "G", "Defender": "D", "Midfielder": "M", "Attacker": "F"}


def load_key():
    k = os.environ.get("APIFOOTBALL_KEY")
    if not k:
        p = Path.home() / ".apifootball_key"
        if p.exists():
            k = p.read_text(encoding="utf-8").strip()
    if not k:
        raise SystemExit("API 키 없음 — APIFOOTBALL_KEY 환경변수 또는 ~/.apifootball_key")
    return k


class Client:
    def __init__(self, key, max_calls, reserve):
        self.key, self.max_calls, self.reserve = key, max_calls, reserve
        self.calls, self.remaining = 0, None

    def get(self, path):
        if self.calls >= self.max_calls:
            raise RuntimeError(f"실행당 호출 상한 {self.max_calls} 도달")
        if self.remaining is not None and self.remaining <= self.reserve:
            raise RuntimeError(f"오늘 남은 호출 {self.remaining} ≤ 예비분 {self.reserve} — 중단")
        req = urllib.request.Request(BASE + path, headers={"x-apisports-key": self.key})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    self.calls += 1
                    rem = r.headers.get("x-ratelimit-requests-remaining")
                    self.remaining = int(rem) if rem and rem.isdigit() else self.remaining
                    per_min = r.headers.get("X-RateLimit-Remaining")
                    d = json.loads(r.read().decode("utf-8"))
                if per_min and per_min.isdigit() and int(per_min) < 3:
                    time.sleep(20)   # 분당 한도 근접 — 잠시 쉼
                else:
                    time.sleep(0.4)
                errs = d.get("errors")
                if errs and (not isinstance(errs, list) or errs):
                    raise RuntimeError(f"API 오류: {errs}")
                return d
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 2:
                    time.sleep(30)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                if attempt < 2:
                    time.sleep(3)
                    continue
                raise


def f_int(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def f_float(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def collect(cli, code, apply):
    lid, season, tid, with_players = LEAGUES[code]
    db = ROOT / DB_FILES[code]
    print(f"\n=== {code} (API-Football league {lid}, season {season}) → {db.name} ===", flush=True)

    # 1) 순위표
    d = cli.get(f"/standings?league={lid}&season={season}")
    groups = ((d.get("response") or [{}])[0].get("league") or {}).get("standings") or []
    rows = groups[0] if groups else []
    print(f"  standings: {len(rows)}팀 (호출 {cli.calls} · 오늘 남은 {cli.remaining})", flush=True)

    # 2) 선수 시즌 기록 (페이지)
    players, page, total = [], 1, 1
    while with_players and page <= total:
        d = cli.get(f"/players?league={lid}&season={season}&page={page}")
        total = (d.get("paging") or {}).get("total") or 1
        players += d.get("response") or []
        page += 1
    print(f"  players: {len(players)}명 ({total}페이지 · 호출 누계 {cli.calls} · 오늘 남은 {cli.remaining})"
          if with_players else "  players: 건너뜀 (순위표만 제공 리그)", flush=True)

    if not apply:
        print("  (dry-run: 저장 안 함)")
        return
    conn = sqlite3.connect(db, timeout=60)
    conn.executescript(SCHEMA_SQL)
    now = int(time.time())
    with conn:
        conn.execute("DELETE FROM league_standings WHERE tournament_id=?", (tid,))
        for r in rows:
            t = r.get("team") or {}
            a = r.get("all") or {}
            g = a.get("goals") or {}
            conn.execute("""INSERT OR REPLACE INTO teams (id, name, short_name, league, tournament_id, season_id)
                            VALUES (?,?,?,?,?,?)""", (t.get("id"), t.get("name"), t.get("name"), code, tid, season))
            conn.execute("""INSERT OR REPLACE INTO league_standings (tournament_id, season_id, team_id, team_name, position,
                            matches, wins, draws, losses, gf, ga, gd, points, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                         (tid, season, t.get("id"), t.get("name"), r.get("rank"), a.get("played"), a.get("win"), a.get("draw"),
                          a.get("lose"), g.get("for"), g.get("against"), r.get("goalsDiff"), r.get("points"), now))
        n_ps = 0
        for item in players:
            p = item.get("player") or {}
            stats = [s for s in (item.get("statistics") or []) if (s.get("league") or {}).get("id") == lid]
            if not p.get("id") or not stats:
                continue
            s = max(stats, key=lambda x: f_int((x.get("games") or {}).get("minutes")) or 0)   # 시즌 중 이적: 가장 많이 뛴 팀
            gm, gl, sh, ps, tk, du, dr, cd, fo = (s.get(k) or {} for k in
                                                  ("games", "goals", "shots", "passes", "tackles", "duels", "dribbles", "cards", "fouls"))
            team = s.get("team") or {}
            conn.execute("""INSERT OR REPLACE INTO teams (id, name, short_name, league, tournament_id, season_id)
                            VALUES (?, COALESCE((SELECT name FROM teams WHERE id=?), ?), ?, ?, ?, ?)""",
                         (team.get("id"), team.get("id"), team.get("name"), team.get("name"), code, tid, season))
            conn.execute("""INSERT OR REPLACE INTO players (id, team_id, name, position, height, weight, birth_date, nationality)
                            VALUES (?,?,?,?,?,?,?,?)""",
                         (p["id"], team.get("id"), p.get("name"), POS.get(gm.get("position"), gm.get("position")),
                          f_int(str(p.get("height") or "").split(" ")[0] or None), f_int(str(p.get("weight") or "").split(" ")[0] or None),
                          (p.get("birth") or {}).get("date"), p.get("nationality")))
            tot_pass, acc_pct = f_int(ps.get("total")), f_float(ps.get("accuracy"))
            conn.execute("""INSERT OR REPLACE INTO player_stats (player_id, tournament_id, season_id, appearances, minutes_played, rating,
                            goals, assists, total_shots, shots_on_target, total_passes, accurate_passes, accurate_passes_pct, key_passes,
                            successful_dribbles, tackles, interceptions, yellow_cards, red_cards, saves, goals_conceded,
                            was_fouled, fouls, raw_json)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                         (p["id"], tid, season, f_int(gm.get("appearences")), f_int(gm.get("minutes")), f_float(gm.get("rating")),
                          f_int(gl.get("total")) or 0, f_int(gl.get("assists")) or 0, f_int(sh.get("total")), f_int(sh.get("on")),
                          tot_pass, None, acc_pct, f_int(ps.get("key")), f_int(dr.get("success")), f_int(tk.get("total")),
                          f_int(tk.get("interceptions")), f_int(cd.get("yellow")), f_int(cd.get("red")), f_int(gl.get("saves")),
                          f_int(gl.get("conceded")), f_int(fo.get("drawn")), f_int(fo.get("committed")),
                          json.dumps({"source": "api-football", "season": season, "team": team.get("name")}, ensure_ascii=False)))
            n_ps += 1
    conn.close()
    print(f"  저장: 팀 {len(rows)} · 선수 기록 {n_ps}", flush=True)


FINISHED = ("FT", "AET", "PEN")
TOP_LEAGUES = ["epl", "laliga", "bundesliga", "seriea", "ligue1", "brasileirao"]
# 시즌 선수 기록은 있지만 경기별 선수 기록(coverage statistics_players)이 없는 리그 — 2026-11-13 표본 확인(선수 0명)
NO_MATCH_STATS = {"brasileiroc"}
# 경기별 기록까지 받는 하위 리그 (2026-11-13)
LOWER_LEAGUES = [c for c, v in LEAGUES.items() if v[3] and c not in TOP_LEAGUES and c not in NO_MATCH_STATS]
ALIASES = {"top": TOP_LEAGUES, "lower": LOWER_LEAGUES, "all": list(LEAGUES)}


def _round_no(s):
    """'Regular Season - 12' → 12. 숫자가 없으면 None."""
    tail = str(s or "").rsplit("-", 1)[-1].strip()
    return int(tail) if tail.isdigit() else None


def collect_matches(cli, code, apply):
    """경기 일정(events) + 끝난 경기의 선수별 기록(match_player_stats). 2026-11-13.
    /fixtures 1회 + 아직 기록이 없는 끝난 경기마다 /fixtures/players 1회(증분 — 중단돼도 다음 실행이 이어 받음).
    dry-run: 일정 1회 + 표본 1경기만 호출하고 저장하지 않는다."""
    lid, season, tid, with_players = LEAGUES[code]
    if not with_players or code in NO_MATCH_STATS:
        print(f"  [{code}] 경기별 기록: 건너뜀 (API-Football 경기별 선수 기록 미제공)", flush=True)
        return
    db = ROOT / DB_FILES[code]
    d = cli.get(f"/fixtures?league={lid}&season={season}")
    fixtures = d.get("response") or []
    done = [f for f in fixtures if ((f.get("fixture") or {}).get("status") or {}).get("short") in FINISHED]

    if not apply and not db.exists():   # dry-run 은 DB 파일을 만들지 않는다
        conn = sqlite3.connect(":memory:")
    else:
        conn = sqlite3.connect(db, timeout=60)
    try:
        conn.executescript(SCHEMA_SQL)
        have = {r[0] for r in conn.execute("SELECT DISTINCT event_id FROM match_player_stats")}
        todo = [f for f in done if f["fixture"]["id"] not in have]
        print(f"  [{code}] 일정 {len(fixtures)}경기 · 종료 {len(done)} · 새로 받을 경기 {len(todo)}"
              f" (호출 누계 {cli.calls} · 오늘 남은 {cli.remaining})", flush=True)
        if not apply:
            if todo:
                s = cli.get(f"/fixtures/players?fixture={todo[0]['fixture']['id']}")
                print(f"  (dry-run: 표본 1경기 선수 {sum(len(t.get('players') or []) for t in s.get('response') or [])}명 · 저장 안 함)")
            return

        with conn:
            for f in fixtures:
                fx, tm, gl, lg = (f.get(k) or {} for k in ("fixture", "teams", "goals", "league"))
                fin = (fx.get("status") or {}).get("short") in FINISHED
                conn.execute("""INSERT OR REPLACE INTO events (id, tournament_id, season_id, home_team_id, away_team_id,
                                home_score, away_score, date_ts, round, status, venue_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                             (fx.get("id"), tid, season, (tm.get("home") or {}).get("id"), (tm.get("away") or {}).get("id"),
                              gl.get("home") if fin else None, gl.get("away") if fin else None, fx.get("timestamp"),
                              _round_no(lg.get("round")), (fx.get("status") or {}).get("short"),
                              (fx.get("venue") or {}).get("name")))

        n_rows = n_fx = 0
        for f in todo:
            fid = f["fixture"]["id"]
            home_id = ((f.get("teams") or {}).get("home") or {}).get("id")
            resp = cli.get(f"/fixtures/players?fixture={fid}").get("response") or []
            rows = []
            for side in resp:
                team_id = (side.get("team") or {}).get("id")
                for item in side.get("players") or []:
                    p = item.get("player") or {}
                    s = (item.get("statistics") or [{}])[0]
                    gm = s.get("games") or {}
                    mins = f_int(gm.get("minutes"))
                    if not p.get("id") or not mins:
                        continue   # 명단에만 있고 안 뛴 선수
                    sh, g, ps, tk, du, dr, fo, cd = (s.get(k) or {} for k in
                                                     ("shots", "goals", "passes", "tackles", "duels", "dribbles", "fouls", "cards"))
                    z = lambda v: f_int(v) or 0   # 뛴 선수의 null = 0회 (API는 0을 null로 준다)
                    duels, won = f_int(du.get("total")), f_int(du.get("won"))
                    rows.append((fid, p["id"], p.get("name"), team_id, int(team_id == home_id), mins, gm.get("position"),
                                 f_float(gm.get("rating")), z(g.get("total")), z(g.get("assists")),
                                 z(sh.get("total")), z(sh.get("on")), z(ps.get("total")), z(ps.get("accuracy")), z(ps.get("key")),
                                 z(dr.get("attempts")), z(dr.get("success")), z(won),
                                 (duels - (won or 0)) if duels is not None else 0,
                                 z(tk.get("total")), z(tk.get("interceptions")), z(fo.get("committed")), z(fo.get("drawn")),
                                 z(cd.get("yellow")), z(cd.get("red")),
                                 f_int(g.get("saves")) if gm.get("position") == "G" else None,
                                 f_int(g.get("conceded")) if gm.get("position") == "G" else None))
            if not rows:
                continue   # 아직 기록 미제공 — 다음 실행에서 재시도
            with conn:
                conn.executemany("""INSERT OR REPLACE INTO match_player_stats (event_id, player_id, player_name, team_id, is_home,
                                    minutes_played, position, rating, goals, assists, total_shots, shots_on_target,
                                    passes_total, passes_accurate, key_passes, dribbles_attempted, dribbles_succeeded,
                                    duel_won, duel_lost, tackles, interceptions, fouls_committed, fouls_suffered,
                                    yellow_cards, red_cards, saves, goals_conceded)
                                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
            n_rows += len(rows)
            n_fx += 1
            if n_fx % 25 == 0:
                print(f"    … {n_fx}/{len(todo)}경기 (호출 누계 {cli.calls} · 오늘 남은 {cli.remaining})", flush=True)
        print(f"  [{code}] 저장: 일정 {len(fixtures)} · 경기 {n_fx} · 선수 기록 {n_rows}", flush=True)
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description="API-Football 해외 리그 수집 (기본 dry-run)")
    ap.add_argument("--league", required=True, help=f"{', '.join(LEAGUES)} · top(1부 6개) · lower(경기별 기록 있는 2·3부) · all — 쉼표로 여러 개")
    ap.add_argument("--part", choices=("season", "matches", "both"), default="season",
                    help="season=순위표+시즌 누적(기본) · matches=경기 일정+경기별 선수 기록(증분) · both")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-calls", type=int, default=400,
                    help="이번 실행 최대 호출 수 (season all ≈700회 · matches 첫 수집 top ≈ 끝난 경기 수+6회)")
    ap.add_argument("--reserve", type=int, default=200, help="오늘 남은 호출이 이 이하가 되면 중단")
    args = ap.parse_args()
    cli = Client(load_key(), args.max_calls, args.reserve)
    codes = []
    for part in args.league.split(","):   # 예: top,lower · epl,laliga
        for c in ALIASES.get(part.strip(), [part.strip()]):
            if c not in codes:
                codes.append(c)
    for c in codes:
        if c not in LEAGUES:
            raise SystemExit(f"알 수 없는 리그: {c}")
    try:
        for c in codes:
            if args.part in ("season", "both"):
                collect(cli, c, args.apply)
            if args.part in ("matches", "both"):
                collect_matches(cli, c, args.apply)
    except RuntimeError as e:
        print(f"[중단] {e}")
    print(f"\n총 호출 {cli.calls} · 오늘 남은 {cli.remaining}")


if __name__ == "__main__":
    main()
