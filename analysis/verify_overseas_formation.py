#!/usr/bin/env python3
"""overseas_formation.py 단위 검증 (읽기 전용, 합성 데이터). 실행: python analysis/verify_overseas_formation.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from overseas_formation import formation_from_grids, formation_family, player_formations  # noqa: E402


def grids(form):
    """'4-3-3' → GK 1:1 + 줄별 grid 목록 (API-Football 형식)."""
    out = ["1:1"]
    for i, n in enumerate(int(x) for x in form.split("-")):
        out += [f"{i + 2}:{c + 1}" for c in range(n)]
    return out


fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("PASS" if ok else "FAIL"), label, "" if ok else f"got={got!r} want={want!r}")


for f in ["4-3-3", "3-4-3", "5-3-2", "4-2-3-1", "4-4-2"]:
    check(f"복원 {f}", formation_from_grids(grids(f)), f)
check("10명 → None", formation_from_grids(grids("4-3-3")[:10]), None)
check("GK 2명 → None", formation_from_grids(["1:1", "1:2"] + grids("4-3-3")[2:]), None)
check("파싱 불가 → None", formation_from_grids(grids("4-3-3")[:10] + ["x:y"]), None)
check("None 포함 → None", formation_from_grids(grids("4-3-3")[:10] + [None]), None)
check("빈 목록 → None", formation_from_grids([]), None)
check("family 3", formation_family("3-4-3"), "3백")
check("family 5", formation_family("5-3-2"), "3백")
check("family 4", formation_family("4-2-3-1"), "4백")
check("family None", formation_family(None), None)
check("family 이상값", formation_family("x"), None)

rows = []
for ev, f in [(1, "4-3-3"), (2, "4-3-3"), (3, "3-4-3")]:
    for i, g in enumerate(grids(f)):
        rows.append((ev, 1, 100 + i, g))
    for i, g in enumerate(grids("4-4-2")):           # 상대 팀(is_home=0)
        rows.append((ev, 0, 900 + i, g))
rows.append((4, 1, 100, "2:1"))                       # 10명 미만 경기 — 포메이션 불명, 집계 제외
pf = player_formations(rows)
check("선수 주 포메이션", pf[100]["main"], "4-3-3")
check("선수 계열 선발", pf[100]["fam"], {"4백": 2, "3백": 1})
check("선수 집계 경기 수", pf[100]["n"], 3)
check("상대 팀 분리", pf[900]["main"], "4-4-2")

print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
