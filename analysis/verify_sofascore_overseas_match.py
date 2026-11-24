#!/usr/bin/env python3
"""collect_sofascore_overseas 매칭 로직 단위 검증 (읽기 전용, 합성 데이터).
실행: python analysis/verify_sofascore_overseas_match.py"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "crawlers"))
from collect_sofascore_overseas import norm_team, match_event, map_player  # noqa: E402

fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("PASS" if ok else "FAIL", label, "" if ok else f"got={got!r} want={want!r}")


check("팀 이름 정규화", norm_team("Kashima Antlers FC"), norm_team("kashima antlers"))
check("악센트·기호", norm_team("Cerezo Ōsaka"), norm_team("Cerezo Osaka"))

api_events = [  # (id, home_id, away_id, date_ts, hs, as, home_name, away_name)
    (1, 10, 20, 1_000_000, 0, 1, "Gamba Osaka", "Fagiano Okayama"),
    (2, 30, 40, 1_000_000, 0, 1, "Kashiwa Reysol", "Urawa"),          # 같은 날 같은 스코어 — 팀 이름으로 구분
    (3, 10, 30, 1_000_000 + 7 * 86400, 2, 2, "Gamba Osaka", "Kashiwa Reysol"),
]
sofa = {"start": 1_000_000 + 3600, "hs": 0, "as": 1, "home": "Gamba Osaka", "away": "Fagiano Okayama"}
check("경기 매칭: 날짜·스코어·팀", match_event(sofa, api_events), 1)
check("경기 매칭: 스코어 다르면 없음", match_event({**sofa, "hs": 2}, api_events), None)
check("경기 매칭: 팀 이름 다른 같은 날 경기 구분", match_event({**sofa, "home": "Kashiwa Reysol", "away": "Urawa Red Diamonds"}, api_events), 2)
check("경기 매칭: 3일 넘게 차이 나면 없음", match_event({**sofa, "start": 1_000_000 + 4 * 86400}, api_events), None)

cands = [  # (api_player_id, name, jersey)
    (501, "R. Meshino", 8), (502, "S. Sasaki", None), (503, "K. Sato", 14), (504, "Y. Sato", 22)]
check("선수: 등번호 우선", map_player({"shortName": "Ryotaro M.", "name": "Ryotaro Meshino", "jerseyNumber": "8"}, cands), 501)
check("선수: 약칭 일치", map_player({"shortName": "S. Sasaki", "name": "Shogo Sasaki", "jerseyNumber": "67"}, cands), 502)
check("선수: 성+이니셜(약칭 표기 다름)", map_player({"shortName": "Shogo Sasaki", "name": "Shogo Sasaki", "jerseyNumber": None}, cands), 502)
check("선수: 같은 성 둘이면 이니셜로", map_player({"shortName": "Y. Sato", "name": "Yuto Sato", "jerseyNumber": None}, cands), 504)
check("선수: 모호하면 None", map_player({"shortName": "Sato", "name": "Sato", "jerseyNumber": None}, cands), None)
check("선수: 없음", map_player({"shortName": "X. Nobody", "name": "X Nobody", "jerseyNumber": "99"}, cands), None)
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
