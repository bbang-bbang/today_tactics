#!/usr/bin/env python3
"""
해외 리그 데이터 수집 — API-Football(api-sports.io, 정식 유료 API). 2026-11-11.

SofaScore 해외 리그 엔드포인트가 403(크롤러 차단)이라 대체. 기존 해외 리그 DB 구조(init_league_db.SCHEMA_SQL)에
그대로 저장해 /api/league/<code>/standings·team-rankings·top-performers 가 바로 쓴다.
  - league_standings : /standings (리그당 1회)
  - teams · players · player_stats : /players?league&season&page (리그당 약 30페이지, 페이지당 20명)
제공 안 되는 것: xG(expected_goals NULL), 몸값.

키: 환경변수 APIFOOTBALL_KEY 또는 ~/.apifootball_key (저장소에 넣지 않는다).
호출 한도: 실행당 --max-calls(기본 400) + 응답 헤더의 '오늘 남은 호출'이 --reserve(기본 200) 아래로 떨어지면 중단.

사용:
  python crawlers/collect_apifootball.py --league epl                 # dry-run (호출은 하되 저장 안 함 — 1회만 써서 형태 확인하려면 --max-calls 1)
  python crawlers/collect_apifootball.py --league all --apply
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
# code → (API-Football league id, 시즌(시작 연도), 이 DB에서 쓰는 tournament_id — main.LEAGUE_REGISTRY 와 일치)
LEAGUES = {
    "epl":         (39, 2026, 17),
    "laliga":      (140, 2026, 8),
    "bundesliga":  (78, 2026, 35),
    "seriea":      (135, 2026, 23),
    "ligue1":      (61, 2026, 34),
    "brasileirao": (71, 2026, 325),
}
DB_FILES = {"epl": "epl.db", "laliga": "laliga.db", "bundesliga": "bundesliga.db", "seriea": "seriea.db",
            "ligue1": "ligue1.db", "brasileirao": "brasileirao.db"}
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
    lid, season, tid = LEAGUES[code]
    db = ROOT / DB_FILES[code]
    print(f"\n=== {code} (API-Football league {lid}, season {season}) → {db.name} ===", flush=True)

    # 1) 순위표
    d = cli.get(f"/standings?league={lid}&season={season}")
    groups = ((d.get("response") or [{}])[0].get("league") or {}).get("standings") or []
    rows = groups[0] if groups else []
    print(f"  standings: {len(rows)}팀 (호출 {cli.calls} · 오늘 남은 {cli.remaining})", flush=True)

    # 2) 선수 시즌 기록 (페이지)
    players, page, total = [], 1, 1
    while page <= total:
        d = cli.get(f"/players?league={lid}&season={season}&page={page}")
        total = (d.get("paging") or {}).get("total") or 1
        players += d.get("response") or []
        page += 1
    print(f"  players: {len(players)}명 ({total}페이지 · 호출 누계 {cli.calls} · 오늘 남은 {cli.remaining})", flush=True)

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


def main():
    ap = argparse.ArgumentParser(description="API-Football 해외 리그 수집 (기본 dry-run)")
    ap.add_argument("--league", required=True, help=f"{', '.join(LEAGUES)} 또는 all")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-calls", type=int, default=400, help="이번 실행 최대 호출 수")
    ap.add_argument("--reserve", type=int, default=200, help="오늘 남은 호출이 이 이하가 되면 중단")
    args = ap.parse_args()
    cli = Client(load_key(), args.max_calls, args.reserve)
    codes = list(LEAGUES) if args.league == "all" else [args.league]
    for c in codes:
        if c not in LEAGUES:
            raise SystemExit(f"알 수 없는 리그: {c}")
    try:
        for c in codes:
            collect(cli, c, args.apply)
    except RuntimeError as e:
        print(f"[중단] {e}")
    print(f"\n총 호출 {cli.calls} · 오늘 남은 {cli.remaining}")


if __name__ == "__main__":
    main()
