#!/usr/bin/env python3
"""
해외 리그 수준 보정 계수(main.py _OS_LEAGUE_FACTOR · _OS_BRA_FACTOR) 검증 — 읽기 전용. 2026-11-23.

방법: API-Football 선수 ID는 리그 DB끼리 같다 → 같은 시즌에 두 리그에서 뛴 선수(시즌 중 이적)의
같은 선수·다른 리그 분당 생산량 비율(리그 a / 리그 b)을 출전 시간 가중 합산으로 구하고 부트스트랩 95% CI.
선수 능력이 같다고 보면 비율 < 1 이면 a 리그가 더 어렵다(같은 선수가 덜 생산).

한계: 이적 방향·팀 전력(약팀으로 승격 이적 → 수비 지표 증가) 선택 편향. 표본 작으면 CI가 넓다.
2026-11-23 운영 DB: 1·2부 겹침 31명 중 브라질 1↔2부 23명만 의미 있음(유럽은 1월 이적시장 뒤 재실행).

사용:  python analysis/verify_league_factors.py [--db-dir .] [--min-minutes 270] [--min-n 10]
"""
import argparse
import bisect
import glob
import os
import random
import sqlite3
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

METRICS = {3: "골", 4: "도움", 5: "키패스", 6: "태클+인터셉트", 7: "슈팅", 8: "드리블 성공"}
SQL = """SELECT s.player_id, p.position, s.minutes_played, COALESCE(s.goals,0), COALESCE(s.assists,0),
                COALESCE(s.key_passes,0), COALESCE(s.tackles,0)+COALESCE(s.interceptions,0),
                COALESCE(s.total_shots,0), COALESCE(s.successful_dribbles,0)
         FROM player_stats s JOIN players p ON p.id = s.player_id WHERE s.minutes_played >= ?"""


def load(path, min_minutes):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    try:
        return {r[0]: r for r in conn.execute(SQL, (min_minutes,))}
    except sqlite3.Error:
        return {}
    finally:
        conn.close()


def pooled(A, B, ids, i):
    ea, ma = sum(A[p][i] for p in ids), sum(A[p][2] for p in ids)
    eb, mb = sum(B[p][i] for p in ids), sum(B[p][2] for p in ids)
    return (ea / ma) / (eb / mb) if ea > 0 and eb > 0 else None


def pct_shift(A, B, ids, i):
    """같은 선수의 리그 내 같은 포지션 백분위 차이(a − b) — 앱 점수(raw)가 리그 간에 얼마나 움직이는지."""
    def table(D):
        t = {}
        for r in D.values():
            t.setdefault(r[1], []).append(r[i] * 90.0 / r[2])
        return {k: sorted(v) for k, v in t.items()}
    ta, tb = table(A), table(B)
    d = []
    for p in ids:
        pos = A[p][1]
        if pos in ta and pos in tb:
            pa = bisect.bisect_left(ta[pos], A[p][i] * 90.0 / A[p][2]) / len(ta[pos]) * 100
            pb = bisect.bisect_left(tb[pos], B[p][i] * 90.0 / B[p][2]) / len(tb[pos]) * 100
            d.append(pa - pb)
    return sum(d) / len(d) if d else None


def main():
    ap = argparse.ArgumentParser(description="해외 리그 보정 계수 검증 (읽기 전용)")
    ap.add_argument("--db-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    ap.add_argument("--min-minutes", type=int, default=270)
    ap.add_argument("--min-n", type=int, default=10, help="겹치는 선수가 이 이상인 리그 쌍만 비율 계산")
    ap.add_argument("--boot", type=int, default=2000)
    args = ap.parse_args()

    dbs = {}
    for path in sorted(glob.glob(os.path.join(args.db_dir, "*.db"))):
        code = os.path.basename(path)[:-3]
        if code == "players":
            continue
        rows = load(path, args.min_minutes)
        if rows:
            dbs[code] = rows
    codes = sorted(dbs)
    pairs = []
    for x, a in enumerate(codes):
        for b in codes[x + 1:]:
            ids = sorted(dbs[a].keys() & dbs[b].keys())
            if ids:
                pairs.append((len(ids), a, b, ids))
    pairs.sort(reverse=True)
    print(f"리그 DB {len(codes)}개 · 두 리그 모두 {args.min_minutes}분+ 선수 쌍 {len(pairs)} (총 {sum(p[0] for p in pairs)}명)")
    for n, a, b, _ in pairs:
        print(f"  {a} ↔ {b}: {n}명")
    rnd = random.Random(1)
    for n, a, b, ids in pairs:
        if n < args.min_n:
            continue
        A, B = dbs[a], dbs[b]
        print(f"\n## {a} / {b} — {n}명 (비율 = {a} 분당 ÷ {b} 분당, 출전 시간 가중)")
        for i, nm in METRICS.items():
            est = pooled(A, B, ids, i)
            bs = sorted(v for v in (pooled(A, B, [rnd.choice(ids) for _ in ids], i) for _ in range(args.boot)) if v)
            ci = f"{bs[int(.025 * len(bs))]:.2f}~{bs[int(.975 * len(bs))]:.2f}" if bs else "-"
            sig = "" if not bs else (" *" if bs[int(.975 * len(bs))] < 1 or bs[int(.025 * len(bs))] > 1 else "")
            shift = pct_shift(A, B, ids, i)
            print(f"  {nm:8s} {est:.2f}  95%CI {ci}{sig}   백분위 차이 {shift:+.1f}" if est else f"  {nm:8s} -")
    print("\n* = CI가 1을 포함하지 않음. 현재 앱 가정: 브라질 2부/1부 = 0.80/0.90 ≈ 0.89, 유럽 2부/1부 = 0.85.")


if __name__ == "__main__":
    main()
