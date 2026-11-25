#!/usr/bin/env python3
"""_tm_values 단위 검증 (임시 transfermarkt DB, 읽기 전용): 기준일 2025-06-01 이전 시장가치는 '오래됨'으로 숨김.
실행: python analysis/verify_tm_values.py"""
import os
import sqlite3
import sys
import tempfile

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


d = tempfile.mkdtemp()
p = os.path.join(d, "tm.db")
c = sqlite3.connect(p)
c.executescript("""CREATE TABLE tm_players (player_id INTEGER PRIMARY KEY, market_value INTEGER, highest_value INTEGER, contract_until TEXT, height INTEGER, foot TEXT);
CREATE TABLE tm_valuations (player_id INTEGER, date TEXT, value INTEGER);
CREATE TABLE tm_map (league_code TEXT, player_id INTEGER, tm_player_id INTEGER);
INSERT INTO tm_players VALUES (1, 2000000, 3000000, '2027-06-30', 183, 'left'), (2, 500000, 900000, NULL, 0, '');
INSERT INTO tm_valuations VALUES (1, '2026-05-20', 2000000), (2, '2023-12-01', 500000);
INSERT INTO tm_map VALUES ('epl', 10, 1), ('epl', 20, 2);""")
c.commit(); c.close()
main.TM_DB_PATH = p
v = main._tm_values([("epl", 10), ("epl", 20), ("epl", 30)])
check("최신 값 표시", (v[("epl", 10)]["market_value"], v[("epl", 10)]["mv_date"]), (2000000, "2026-05-20"))
check("TM 키·주발(정규화 Left)", (v[("epl", 10)]["tm_height"], v[("epl", 10)]["tm_foot"]), (183, "Left"))
check("키 0·주발 빈 값 → None (오래된 값이어도 키·주발 필드는 있음)", (v[("epl", 20)]["tm_height"], v[("epl", 20)]["tm_foot"]), (None, None))
att = main._tm_attach([{"lc": "epl", "pid": 10, "height": None, "foot": None}, {"lc": "epl", "pid": 10, "height": 180, "foot": "Right"}],
                      lambda x: x["lc"], lambda x: x["pid"])
check("비어 있을 때만 TM 으로 채움", [(a["height"], a["foot"]) for a in att], [(183, "Left"), (180, "Right")])
check("채운 출처 표시", [a.get("phys_src") for a in att], ["TM", None])
check("오래된 값(2023-12) 숨김", (v.get(("epl", 20)) or {}).get("market_value"), None)
check("오래된 값 표시 여부 플래그", (v.get(("epl", 20)) or {}).get("mv_stale"), True)
items = [{"lc": "epl", "pid": 20}, {"lc": "epl", "pid": 10}]
kept, exc = main._mv_cap(items, lambda x: x["lc"], lambda x: x["pid"], 1000000)
check("오래된 값은 상한 필터에서 제외되지 않음(값 모름 취급)", ([x["pid"] for x in kept], exc), ([20], 1))
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
