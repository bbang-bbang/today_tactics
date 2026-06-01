"""전 매치의 K리그 알고리즘 결과를 스캔해 의심스러운 케이스 검출.

검출 기준:
  S1. 비현실 카운트: nD=0 / nM=0 / nF=0 / nF >= 4
  S2. 극단 카운트: nM>=6 (윙어 흡수 가능성), nM<=1 (M 너무 빈약)
  S3. K리그 raw row 분석으로 사용자 인지 가능한 더 자연스러운 분류 제안
  S4. SofaScore 라벨과 큰 차이 (label 차이 ≥ 4명)

매치별로 정렬해서 상위 케이스 출력 + 패턴 통계.
"""
from __future__ import annotations
import sqlite3, sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB = Path(__file__).resolve().parent.parent / "players.db"
EXCLUDED = (90333089,)


def cluster(kl):
    if len(kl) != 11: return None
    by_t = defaultdict(list)
    for p in kl: by_t[round(p["top_pct"], 1)].append(p)
    tops = sorted(by_t.keys(), reverse=True)
    if len(tops) < 3: return None
    gk = by_t[tops[0]]
    if len(gk) != 1: return None
    non_gk = tops[1:]
    d_line, d_used = [], 0
    for t in non_gk:
        d_line.extend(by_t[t]); d_used += 1
        if len(d_line) >= 3: break
    if not (3 <= len(d_line) <= 6): return None
    f_line = list(by_t[non_gk[-1]])
    if not (1 <= len(f_line) <= 4): return None
    if d_used + 1 > len(non_gk): return None
    m_start, m_end = d_used, len(non_gk) - 1
    if m_start >= m_end: return None
    m_line = []
    for t in non_gk[m_start:m_end]: m_line.extend(by_t[t])
    if len(m_line) < 1: return None
    return {
        "formation": f"{len(d_line)}-{len(m_line)}-{len(f_line)}",
        "nD": len(d_line), "nM": len(m_line), "nF": len(f_line),
        "row_dist": [(t, len(by_t[t])) for t in tops],
    }


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    events = conn.execute("""
        SELECT DISTINCT sofa_event_id FROM kleague_lineup
        WHERE sofa_event_id NOT IN (?)
    """, EXCLUDED).fetchall()

    formation_dist = Counter()
    row_pattern_dist = Counter()
    suspicious = {"high_m": [], "low_m": [], "split_wing_lost": [], "label_diff_large": []}
    null_cluster = 0
    total = 0

    for ev_row in events:
        eid = ev_row["sofa_event_id"]
        for side in ("home", "away"):
            kl = conn.execute("""
                SELECT back_no, top_pct, left_pct FROM kleague_lineup
                WHERE sofa_event_id=? AND side=?
            """, (eid, side)).fetchall()
            kl = [dict(r) for r in kl]
            cl = cluster(kl)
            if not cl:
                null_cluster += 1
                continue
            total += 1
            formation_dist[cl["formation"]] += 1

            # row pattern (인원 수 튜플)
            row_pat = tuple(c for _, c in cl["row_dist"])
            row_pattern_dist[row_pat] += 1

            nD, nM, nF = cl["nD"], cl["nM"], cl["nF"]

            # S2: high M (>=6) → 윙어/DM 등 흡수 의심
            if nM >= 6:
                suspicious["high_m"].append((eid, side, cl["formation"], row_pat))
            if nM <= 1:
                suspicious["low_m"].append((eid, side, cl["formation"], row_pat))

            # S3: 마지막 row 직전 row가 2명 이하 + 인접 = 윙어 split 가능성 (예: 1+4+4+1+1+1 → 4-3-3인데 4-5-1로 표시됨)
            row_counts = [c for _, c in cl["row_dist"][1:]]  # outfield rows
            if len(row_counts) >= 3:
                last = row_counts[-1]
                prev = row_counts[-2]
                # 마지막 2 row 합 = 2~3, 둘 다 작은 인원 → 윙어 split 가능성
                if 1 <= last <= 2 and 1 <= prev <= 2 and last + prev in (2, 3):
                    suspicious["split_wing_lost"].append((eid, side, cl["formation"], row_pat))

    print("=== formation 분포 ===")
    for f, n in formation_dist.most_common(15):
        print(f"  {f}: {n}")

    print("\n=== K리그 row 패턴 (top 15) ===")
    for pat, n in row_pattern_dist.most_common(15):
        print(f"  {pat}: {n}")

    print("\n=== 의심 케이스 ===")
    print(f"S2-1 nM>=6 (윙어/DM 흡수): {len(suspicious['high_m'])}")
    print("  샘플:")
    for s in suspicious["high_m"][:5]:
        print(f"    ev={s[0]} {s[1]} formation={s[2]} rows={s[3]}")
    print(f"\nS2-2 nM<=1 (M 빈약): {len(suspicious['low_m'])}")
    for s in suspicious["low_m"][:5]:
        print(f"    ev={s[0]} {s[1]} formation={s[2]} rows={s[3]}")
    print(f"\nS3 윙어 split 가능성: {len(suspicious['split_wing_lost'])}")
    for s in suspicious["split_wing_lost"][:5]:
        print(f"    ev={s[0]} {s[1]} formation={s[2]} rows={s[3]}")

    print(f"\n총: {total} sides ({null_cluster} 알고리즘 적용 불가)")


if __name__ == "__main__":
    main()
