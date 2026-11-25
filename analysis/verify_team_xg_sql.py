#!/usr/bin/env python3
"""_team_xg_games SQL 검증 (임시 DB, 읽기 전용, 2026-11-25): 라운드 없는 경기(승격 PO 등)는 리그 집계에서 제외,
리그 전체가 라운드 없으면 그대로 사용. 실행: python analysis/verify_team_xg_sql.py"""
import os
import sqlite3
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
os.environ.setdefault("DISABLE_SCHEDULER", "1")
sys.argv = [sys.argv[0]]
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main  # noqa: E402

fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("PASS" if ok else "FAIL", label, "" if ok else f"got={got!r} want={want!r}")


def mk(rounds):
    c = sqlite3.connect(":memory:")
    c.executescript("""CREATE TABLE events (id INTEGER PRIMARY KEY, tournament_id INT, season_id INT, home_team_id INT, away_team_id INT,
                                            home_score INT, away_score INT, date_ts INT, round INT);
                       CREATE TABLE match_team_stats (event_id INT, team_id INT, is_home INT, xg REAL, shots INT, shots_inside INT, possession REAL);""")
    for i, r in enumerate(rounds, start=1):
        c.execute("INSERT INTO events VALUES (?, 1, 2026, 10, 20, 1, 0, ?, ?)", (i, i * 100, r))
        c.execute("INSERT INTO match_team_stats VALUES (?, 10, 1, 1.0, 10, 5, 50)", (i,))
        c.execute("INSERT INTO match_team_stats VALUES (?, 20, 0, 0.5, 8, 3, 50)", (i,))
    return c


g = main._team_xg_games(mk([1, 2, 3, None]), [1], 2026)
check("라운드 있는 리그: 라운드 없는 PO 경기 제외", sorted({r[0] for r in g}), [1, 2, 3])
g = main._team_xg_games(mk([None, None]), [1], 2026)
check("라운드 값이 전혀 없는 리그: 전부 사용", sorted({r[0] for r in g}), [1, 2])
check("12필드(마지막 date_ts)", len(g[0]), 12)
# get_league_db: 없는 리그 DB 파일을 새로 만들지 않는다 (2026-11-25 감사 — 로컬에서 0바이트 DB 13개 생성됨)
import tempfile  # noqa: E402
missing = os.path.join(tempfile.mkdtemp(), "zz_missing.db")
main.LEAGUE_REGISTRY["zz_test"] = {"db": missing, "tournaments": [], "label": "t"}
try:
    with main.get_league_db("zz_test") as c:
        c.execute("SELECT 1")
    opened = True
except sqlite3.OperationalError:
    opened = False
check("없는 DB → 오류(빈 파일 생성 안 함)", (opened, os.path.exists(missing)), (False, False))
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
