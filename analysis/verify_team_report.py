#!/usr/bin/env python3
"""해외 리그 팀 리포트 집계 검증 (읽기 전용, 합성 데이터, 2026-11-25). 실행: python analysis/verify_team_report.py"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from team_report import rank_flow, recent_form, formation_summary  # noqa: E402

fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("PASS" if ok else "FAIL", label, "" if ok else f"got={got!r} want={want!r}")


# (event_id, round, date_ts, home, away, hs, as)
games = [
    (1, 1, 100, 10, 20, 2, 0),
    (2, 1, 100, 30, 40, 1, 1),
    (3, 2, 200, 20, 30, 3, 0),
    (4, 2, 200, 40, 10, 0, 0),
    (5, 3, 300, 10, 30, 0, 1),
    (6, 3, 300, 20, 40, None, None),     # 미종료 → 제외
]
f = rank_flow(games, 10)
# R1: 10 W(3,+2), 30 D, 40 D, 20 L → 10 1위
# R2: 10 4pts(+2), 20 3pts, 40 2pts, 30 1pt → 10 1위
# R3: 10 4pts(+1) = 30 4pts(-2) → 득실로 10 1위 · 20 3위
check("라운드별 순위", [(p["round"], p["rank"], p["pts"]) for p in f], [(1, 1, 3), (2, 1, 4), (3, 1, 4)])
check("팀 수(분모)", f[0]["n"], 4)
check("결과 표시", [p["res"] for p in f], ["W", "D", "L"])
check("다른 팀 흐름", [(p["round"], p["rank"]) for p in rank_flow(games, 20)], [(1, 4), (2, 2)])  # R3 은 미종료
check("동점 → 득실(30 은 R3 에 10 과 승점 같고 득실 낮아 2위)", [(p["round"], p["rank"]) for p in rank_flow(games, 30)][-1], (3, 2))
check("경기 없는 팀 → 빈 목록", rank_flow(games, 99), [])
# 라운드 값이 없으면 날짜순(팀 경기 기준)으로
g2 = [(e, None, d, h, a, hs, as_) for e, _r, d, h, a, hs, as_ in games]
check("라운드 없음 → 날짜 기준 동일 결과", [(p["rank"], p["pts"]) for p in rank_flow(g2, 10)], [(1, 3), (1, 4), (1, 4)])
check("최근 폼(최신 먼저)", recent_form(games, 10, n=2), ["L", "D"])
check("최근 폼 개수 제한", len(recent_form(games, 10, n=5)), 3)

lineups = (  # (event_id, grid) — 팀 선발 11명
    [(1, g) for g in ["1:1", "2:1", "2:2", "2:3", "2:4", "3:1", "3:2", "3:3", "4:1", "4:2", "4:3"]]
    + [(2, g) for g in ["1:1", "2:1", "2:2", "2:3", "2:4", "3:1", "3:2", "3:3", "4:1", "4:2", "4:3"]]
    + [(3, g) for g in ["1:1", "2:1", "2:2", "2:3", "3:1", "3:2", "3:3", "3:4", "3:5", "4:1", "4:2"]]
    + [(4, g) for g in ["1:1", "2:1", "2:2"]]          # 복원 불가 → 제외
)
fs = formation_summary(lineups)
check("포메이션 빈도순", fs["list"], [{"formation": "4-3-3", "n": 2}, {"formation": "3-5-2", "n": 1}])
check("3백/4백 계열", fs["family"], {"4백": 2, "3백": 1})
check("복원된 경기 수", fs["n"], 3)
check("빈 입력", formation_summary([]), {"list": [], "family": {}, "n": 0})
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
