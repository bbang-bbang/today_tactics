"""K리그 v5 알고리즘 결과 전수 자동 진단.

  A1. K리그 적용 불가 매치 사유 분포 + 샘플
  A2. 비표준 formation 결과 (4-4-2/3-4-3 외 빈도 ≤5%)
  A3. SofaScore vs K리그 D/M/F 카운트 차이가 큰 매치
  A4. K리그 row 패턴 vs 적용 결과 매핑 검증
"""
from __future__ import annotations
import sqlite3, sys
from collections import Counter, defaultdict
from pathlib import Path

try: sys.stdout.reconfigure(encoding="utf-8")
except: pass

DB = Path(__file__).resolve().parent.parent / "players.db"


def cluster(kl):
    """v5 알고리즘 그대로."""
    if len(kl) != 11: return None, "wrong_count"
    by_t = defaultdict(list)
    for p in kl: by_t[round(p["top_pct"], 1)].append(p)
    tops = sorted(by_t.keys(), reverse=True)
    if len(tops) < 3: return None, "rows<3"
    gk = by_t[tops[0]]
    if len(gk) != 1: return None, "no_gk"
    outfield = [(t, list(by_t[t])) for t in tops[1:]]
    if sum(len(p) for _, p in outfield) != 10: return None, "outfield≠10"
    while len(outfield) > 1 and len(outfield[0][1]) < 3:
        merged = (outfield[0][0], outfield[0][1] + outfield[1][1])
        outfield = [merged] + outfield[2:]
    if len(outfield) < 2 or len(outfield[0][1]) < 3:
        return None, "D_accum_fail"
    while len(outfield) > 4:
        mid = list(range(1, len(outfield) - 1))
        if len(mid) < 2:
            merged = (outfield[0][0], outfield[0][1] + outfield[1][1])
            outfield = [merged] + outfield[2:]
            continue
        best_i, best_sum = None, 999
        for i in mid[:-1]:
            s = len(outfield[i][1]) + len(outfield[i+1][1])
            if s < best_sum: best_sum, best_i = s, i
        merged = (outfield[best_i][0], outfield[best_i][1] + outfield[best_i+1][1])
        outfield = outfield[:best_i] + [merged] + outfield[best_i+2:]
    rc = [len(p) for _, p in outfield]
    nD, nF, nM = rc[0], rc[-1], sum(rc[1:-1])
    if not (3 <= nD <= 6): return None, f"nD_invalid_{nD}"
    if not (1 <= nF <= 4): return None, f"nF_invalid_{nF}"
    if nM < 1: return None, "nM_zero"
    if nD + nM + nF != 10: return None, "sum_mismatch"
    return "-".join(str(c) for c in rc), "ok"


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    events = conn.execute("SELECT DISTINCT sofa_event_id FROM kleague_lineup").fetchall()

    fdist = Counter()
    fail_reasons = Counter()
    fail_examples = defaultdict(list)
    row_pat_to_form = defaultdict(Counter)
    total = 0

    for ev_row in events:
        eid = ev_row["sofa_event_id"]
        for side in ("home", "away"):
            kl = conn.execute(
                "SELECT back_no, top_pct, left_pct FROM kleague_lineup WHERE sofa_event_id=? AND side=?",
                (eid, side)).fetchall()
            kl = [dict(r) for r in kl]
            total += 1
            f, reason = cluster(kl)
            if not f:
                fail_reasons[reason] += 1
                if len(fail_examples[reason]) < 5:
                    by_t = defaultdict(list)
                    for p in kl: by_t[round(p["top_pct"], 1)].append(p)
                    tops = sorted(by_t.keys(), reverse=True)
                    pat = tuple(len(by_t[t]) for t in tops)
                    fail_examples[reason].append((eid, side, pat))
                continue
            fdist[f] += 1

            # row 패턴 → formation 매핑
            by_t = defaultdict(list)
            for p in kl: by_t[round(p["top_pct"], 1)].append(p)
            pat = tuple(len(by_t[t]) for t in sorted(by_t.keys(), reverse=True))
            row_pat_to_form[pat][f] += 1

    print(f"=== 총 {total} sides ===")
    print(f"적용: {sum(fdist.values())}  거부: {sum(fail_reasons.values())}")

    print("\n=== A1. 거부 사유 ===")
    for r, n in fail_reasons.most_common():
        print(f"  {r}: {n}")
        for ex in fail_examples[r][:3]:
            print(f"    ex: ev={ex[0]} {ex[1]} rows={ex[2]}")

    print("\n=== A2. formation 분포 ===")
    for f, n in fdist.most_common(20):
        pct = n / max(sum(fdist.values()), 1) * 100
        print(f"  {f}: {n} ({pct:.1f}%)")

    print("\n=== A4. row 패턴 → formation 매핑 (top 15) ===")
    sorted_pats = sorted(row_pat_to_form.items(), key=lambda x: -sum(x[1].values()))
    for pat, forms in sorted_pats[:15]:
        total_pat = sum(forms.values())
        top = forms.most_common(1)[0]
        print(f"  {pat}: {total_pat}회 → {dict(forms)}")


if __name__ == "__main__":
    main()
