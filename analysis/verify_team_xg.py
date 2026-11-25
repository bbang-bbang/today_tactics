#!/usr/bin/env python3
"""해외 리그 경기별 팀 기록(xG) 파싱·집계 검증 (읽기 전용, 합성 데이터). 실행: python analysis/verify_team_xg.py"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "crawlers"))
from collect_apifootball import parse_fixture_stats, TEAM_STATS_LEAGUES  # noqa: E402
sys.path.insert(0, ROOT)
from team_xg import team_xg_table  # noqa: E402

fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("PASS" if ok else "FAIL", label, "" if ok else f"got={got!r} want={want!r}")


resp = [
    {"team": {"id": 10}, "statistics": [{"type": "expected_goals", "value": "0.97"}, {"type": "Total Shots", "value": 17},
                                         {"type": "Shots on Goal", "value": 5}, {"type": "Shots insidebox", "value": 10},
                                         {"type": "Ball Possession", "value": "69%"}, {"type": "Passes %", "value": "88%"},
                                         {"type": "Corner Kicks", "value": None}]},
    {"team": {"id": 20}, "statistics": [{"type": "expected_goals", "value": None}, {"type": "Total Shots", "value": "6"}]},
]
rows = parse_fixture_stats(555, resp, home_id=10)
check("행 2개", len(rows), 2)
check("홈 행", rows[0], {"event_id": 555, "team_id": 10, "is_home": 1, "xg": 0.97, "shots": 17, "shots_on": 5,
                         "shots_inside": 10, "possession": 69.0, "pass_acc": 88.0, "corners": None})
check("원정 xG 없음 → None, 문자열 숫자 변환", (rows[1]["xg"], rows[1]["shots"], rows[1]["is_home"]), (None, 6, 0))
check("빈 응답", parse_fixture_stats(1, [], home_id=1), [])
check("이상한 값", parse_fixture_stats(1, [{"team": {"id": 1}, "statistics": [{"type": "expected_goals", "value": "abc"}]}], 1)[0]["xg"], None)

# (event_id, team_id, is_home, xg, shots, shots_inside, possession, goals_for, goals_against, opp_xg)
games = [
    (1, 10, 1, 2.0, 15, 9, 60.0, 3, 0, 0.5),
    (2, 10, 0, 1.0, 10, 5, 50.0, 0, 2, 1.5),
    (1, 20, 0, 0.5, 5, 2, 40.0, 0, 3, 2.0),
    (2, 20, 1, 1.5, 12, 8, 50.0, 2, 0, 1.0),
    (3, 30, 1, None, 9, 3, 55.0, 1, 1, None),     # xG 없는 경기는 xG 집계에서 제외
]
t = {r["team_id"]: r for r in team_xg_table(games)}
check("팀 10 경기 수·xG", (t[10]["games"], t[10]["xg_games"], t[10]["xg_for"], t[10]["xg_against"]), (2, 2, 1.5, 1.0))
check("팀 10 골−xG(경기당)", t[10]["g_minus_xg"], 0.0)          # 득점 3 − xG 3.0 = 0
check("팀 10 실점−xGA(경기당)", t[10]["ga_minus_xga"], 0.0)     # 실점 2 − xGA 2.0 = 0
check("팀 20 xG 차(경기당)", t[20]["xg_diff"], -0.5)           # (2.0 − 3.0)/2
check("박스 안 슈팅 비율", t[10]["box_share"], 56.0)             # 14/25
check("xG 없는 팀 → None", (t[30]["xg_games"], t[30]["xg_for"]), (0, None))
check("정렬: xG 차 큰 순", [r["team_id"] for r in team_xg_table(games)][:2], [10, 20])
check("팀 기록 수집 = 경기별 기록 있는 모든 리그(J1만 아님)", {"epl", "laliga", "brasileirao", "championship", "jleague1", "liga3"} <= TEAM_STATS_LEAGUES, True)
check("순위표만·지난 시즌 기록 리그는 제외", ("brasileiroc" in TEAM_STATS_LEAGUES, "jleague2" in TEAM_STATS_LEAGUES, "seriec_a" in TEAM_STATS_LEAGUES), (False, False, False))

# 2026-11-25 감사 반영: 공급자 오류(슈팅 5개 이상인데 xG 0) → 없음 처리 · 표본 부족 팀 xG 숨김 · 제공률
from team_xg import xg_coverage, XG_MIN_GAMES  # noqa: E402
g2 = [  # 11번째 = 상대 슈팅
    (1, 10, 1, 0.0, 8, 3, 50.0, 1, 0, 1.2, 9),      # 슈팅 8개인데 xG 0 → 오류 → 경기 제외
    (1, 20, 0, 1.2, 9, 5, 50.0, 0, 1, 0.0, 8),      # 상대 xG 가 오류 → 이 경기도 제외
    (2, 10, 1, 0.0, 2, 1, 50.0, 0, 0, 0.3, 4),      # 슈팅 2개 xG 0 → 정상(진짜 0)
    (2, 20, 0, 0.3, 4, 2, 50.0, 0, 0, 0.0, 2),
]
t2 = {r["team_id"]: r for r in team_xg_table(g2)}
check("xG 0·슈팅≥5 → 오류로 제외", (t2[10]["games"], t2[10]["xg_games"], t2[10]["xg_for"]), (2, 1, 0.0))
check("최소 표본 상수", XG_MIN_GAMES, 3)
t3 = {r["team_id"]: r for r in team_xg_table(g2, min_games=XG_MIN_GAMES)}
check("표본 미만 → xG 지표 None(경기 수는 유지)", (t3[10]["xg_for"], t3[10]["xg_diff"], t3[10]["xg_games"]), (None, None, 1))
check("제공률 = xG 정상 경기 / 전체 경기", xg_coverage(g2), {"games": 2, "xg_games": 1, "pct": 50.0})
check("제공률 빈 입력", xg_coverage([]), {"games": 0, "xg_games": 0, "pct": None})
check("10필드(상대 슈팅 없음)도 동작", xg_coverage(games)["games"], 3)
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
