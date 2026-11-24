#!/usr/bin/env python3
"""_overseas_rows 메모이즈 검증 (읽기 전용). 실행: python analysis/verify_overseas_rows_cache.py
- 같은 min_minutes 두 번째 호출은 해외 DB를 다시 열지 않는다(sqlite3.connect 호출 0회)
- 돌려준 행을 호출부가 고쳐도(pcts·raw·adj 대입) 다음 호출 결과에 번지지 않는다
"""
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


def check(label, cond, extra=""):
    global fails
    fails += not cond
    print("PASS" if cond else "FAIL", label, extra)


main._PRED_CACHE.clear()
a = main._overseas_rows(900)
calls = {"n": 0}
real = main.sqlite3.connect


def counting(*args, **kw):
    calls["n"] += 1
    return real(*args, **kw)


main.sqlite3.connect = counting
try:
    b = main._overseas_rows(900)
finally:
    main.sqlite3.connect = real
check("두 번째 호출은 DB 재조회 없음", calls["n"] == 0, f"connect {calls['n']}회")
check("같은 행 수", len(a) == len(b), f"{len(a)} vs {len(b)}")
if b:
    b[0]["adj"] = -1
    b[0]["pcts"] = {"x": 1}
    c = main._overseas_rows(900)
    check("호출부 변경이 캐시에 번지지 않음", "adj" not in c[0] and "pcts" not in c[0])
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
