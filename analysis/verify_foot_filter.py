#!/usr/bin/env python3
"""영입 추천 주발 필터 검증 (2026-11-25, 합성 데이터). 실행: python analysis/verify_foot_filter.py"""
import os
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


check("빈 값 → 필터 없음", (main._parse_foot(None), main._parse_foot("")), (None, None))
check("left/right 소문자 정규화", (main._parse_foot("LEFT"), main._parse_foot("right")), ("Left", "Right"))
try:
    main._parse_foot("middle"); bad = False
except ValueError:
    bad = True
check("잘못된 값 → ValueError", bad, True)

items = [{"id": 1, "foot": "Left"}, {"id": 2, "foot": "Right"}, {"id": 3, "foot": "Both"}, {"id": 4, "foot": None}, {"id": 5}]
keep, unknown = main._foot_filter(items, "Left")
check("왼발 = 왼발 + 양발", [c["id"] for c in keep], [1, 3])
check("주발 모름 → 제외 수", unknown, 2)
keep, unknown = main._foot_filter(items, "Right")
check("오른발 = 오른발 + 양발", [c["id"] for c in keep], [2, 3])
keep, unknown = main._foot_filter(items, None)
check("필터 없음 → 그대로·제외 0", (len(keep), unknown), (5, 0))
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
