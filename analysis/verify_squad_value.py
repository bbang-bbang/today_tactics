#!/usr/bin/env python3
"""스쿼드 시장가치 vs 성적 집계 검증 (순수 함수, 합성 데이터). 실행: python analysis/verify_squad_value.py"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from squad_value import squad_value_table  # noqa: E402

fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("PASS" if ok else "FAIL", label, "" if ok else f"got={got!r} want={want!r}")


teams = [{"team_id": 1, "name": "A", "rank": 1, "pts": 30, "played": 12},
         {"team_id": 2, "name": "B", "rank": 2, "pts": 25, "played": 12},
         {"team_id": 3, "name": "C", "rank": 3, "pts": 10, "played": 12}]
players = [(1, 1_000_000), (1, 2_000_000), (1, None),          # A: 3백만, 연결 3명 중 값 2명
           (2, 10_000_000), (2, 5_000_000),                   # B: 1500만
           (3, 20_000_000), (3, None), (3, None)]             # C: 2000만
rows = {r["team_id"]: r for r in squad_value_table(teams, players)}
check("A 스쿼드 가치·값 있는 선수", (rows[1]["value"], rows[1]["n_valued"], rows[1]["n_linked"]), (3_000_000, 2, 3))
check("가치 순위(높은 순)", (rows[3]["value_rank"], rows[2]["value_rank"], rows[1]["value_rank"]), (1, 2, 3))
check("차이 = 가치 순위 − 실제 순위 (+면 몸값보다 잘함)", (rows[1]["diff"], rows[2]["diff"], rows[3]["diff"]), (2, 0, -2))
check("승점당 시장가치(€M)", rows[2]["value_per_pt_m"], 0.6)            # 1500만/25점
check("정렬 = 실제 순위", [r["team_id"] for r in squad_value_table(teams, players)], [1, 2, 3])
empty = squad_value_table(teams, [(1, 5_000_000)])
check("값 없는 팀 → value None·가치 순위 None", ({r["team_id"]: r["value"] for r in empty}[2], {r["team_id"]: r["value_rank"] for r in empty}[2]), (None, None))
check("값 있는 팀만 가치 순위", {r["team_id"]: r["value_rank"] for r in empty}[1], 1)
check("값 없는 팀은 차이 None", {r["team_id"]: r["diff"] for r in empty}[3], None)
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
