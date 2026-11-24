#!/usr/bin/env python3
"""J리그(J1·J2) 등록 검증 (읽기 전용). 실행: python analysis/verify_jleague_registry.py
- 앱 레지스트리·수집기 리그 표가 같은 API id·시즌을 가리키는지(J1은 API 시즌 표기가 종료 연도 2027, J2는 시작 연도 2026)
- 리그 수준 추정 계수: J1 0.85 · J2 0.75 (유럽 1부 1.0 과 같은 '1부'로 취급하지 않음)
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
os.environ.setdefault("DISABLE_SCHEDULER", "1")
sys.argv = [sys.argv[0]]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "crawlers"))
import main  # noqa: E402
import collect_apifootball as ca  # noqa: E402

fails = 0


def check(label, cond, extra=""):
    global fails
    fails += not cond
    print("PASS" if cond else "FAIL", label, extra)


R = main.LEAGUE_REGISTRY
for code, api_id, season, tier in (("jleague1", 98, 2027, 1), ("jleague2", 99, 2026, 2)):
    cfg = R.get(code)
    check(f"{code} 등록", cfg is not None)
    if not cfg:
        continue
    check(f"{code} 나라·티어", cfg.get("country") == "일본" and cfg.get("tier") == tier, str((cfg.get("country"), cfg.get("tier"))))
    check(f"{code} tournament id = API id", cfg["tournaments"][0]["id"] == api_id)
    check(f"{code} 시즌 2026/27 → API 시즌 {season}", cfg.get("season_ids") == {2026: season}, str(cfg.get("season_ids")))
    check(f"{code} 수집기 표 일치", ca.LEAGUES.get(code) == (api_id, season, api_id, True), str(ca.LEAGUES.get(code)))
check("J2 경기별 선수 기록 미제공 → matches 건너뜀", "jleague2" in ca.NO_MATCH_STATS)
check("J1 은 경기별 기록 수집(lower 묶음)", "jleague1" in ca.LOWER_LEAGUES)
check("J1 계수 0.85", main._os_league_factor("jleague1", 1) == 0.85)
check("J2 계수 0.75", main._os_league_factor("jleague2", 2) == 0.75)
check("유럽 1부 계수 불변 1.0", main._os_league_factor("epl", 1) == 1.0)
check("브라질 1부 계수 불변 0.9", main._os_league_factor("brasileirao", 1) == 0.9)
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
