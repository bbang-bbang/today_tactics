"""K리그 통합 build_side 로직 전수 검증.

수집된 kleague_lineup이 있는 매치에 대해:
  K1. K리그 적용 가능 매치율 (3-row outfield 단순화 통과)
  K2. SofaScore vs K리그 formation 차이 분포
  K3. SofaScore vs K리그 D/M/F 라벨 차이 (선수 수)
  K4. 등번호 매칭률 (K리그 #등번호 ↔ SofaScore shirt_number)
  K5. K리그 적용 불가 사유 분포
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
EXCLUDED_EVENT_IDS = (90333089,)
EXCLUDED_SQL = "(" + ",".join(str(i) for i in EXCLUDED_EVENT_IDS) + ")"


def kleague_pos_by_shirt(kl_players):
    if len(kl_players) != 11:
        return None, "wrong_count"
    by_top = defaultdict(list)
    for p in kl_players:
        by_top[round(p["top_pct"], 1)].append(p)
    tops_desc = sorted(by_top.keys(), reverse=True)
    if len(tops_desc) < 3:
        return None, "too_few_rows"
    gk_line = by_top[tops_desc[0]]
    if len(gk_line) != 1:
        return None, "no_gk"
    non_gk = tops_desc[1:]

    d_line = []
    d_used = 0
    for t in non_gk:
        d_line.extend(by_top[t])
        d_used += 1
        if len(d_line) >= 3:
            break
    if not (3 <= len(d_line) <= 6):
        return None, f"D_size_{len(d_line)}"

    f_line = []
    f_used = 0
    for t in reversed(non_gk[d_used:]):
        f_line = list(by_top[t]) + f_line
        f_used += 1
        if len(f_line) >= 2:
            break
    if not (1 <= len(f_line) <= 4):
        return None, f"F_size_{len(f_line)}"

    m_start = d_used
    m_end = len(non_gk) - f_used
    if m_start >= m_end:
        return None, "M_no_room"
    m_line = []
    for t in non_gk[m_start:m_end]:
        m_line.extend(by_top[t])
    if len(m_line) < 1:
        return None, "M_empty"

    nD, nM, nF = len(d_line), len(m_line), len(f_line)
    if nD + nM + nF != 10:
        return None, "sum_mismatch"
    pos = {gk_line[0]["back_no"]: "G"}
    for p in d_line: pos[p["back_no"]] = "D"
    for p in m_line: pos[p["back_no"]] = "M"
    for p in f_line: pos[p["back_no"]] = "F"
    return (pos, f"{nD}-{nM}-{nF}"), "ok"


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    events_with_kl = conn.execute("""
        SELECT DISTINCT sofa_event_id FROM kleague_lineup
    """).fetchall()
    n_total = len(events_with_kl)
    print(f"K리그 라인업 수집: {n_total} 매치")

    sides_kl_ok = 0
    sides_kl_fail = 0
    fail_reasons = Counter()
    formation_diff = Counter()  # SofaScore -> K리그
    formation_same = 0
    label_diff_pid = 0
    shirt_match_dist = Counter()
    side_w_shirt_match = []  # (eid, side, match_count)

    for ev_row in events_with_kl:
        eid = ev_row["sofa_event_id"]
        kl_rows = conn.execute("""
            SELECT side, back_no, top_pct, left_pct FROM kleague_lineup
            WHERE sofa_event_id=?
        """, (eid,)).fetchall()
        by_side = {"home": [], "away": []}
        for r in kl_rows:
            by_side[r["side"]].append(dict(r))

        ss_rows = conn.execute("""
            SELECT is_home, formation, player_id, player_name, shirt_number,
                   position, is_starter
            FROM match_lineups WHERE event_id=?
        """, (eid,)).fetchall()

        for is_home in (0, 1):
            side_key = "home" if is_home else "away"
            kl_players = by_side[side_key]
            starters = [r for r in ss_rows if r["is_home"] == is_home and r["is_starter"]]
            if len(starters) != 11:
                continue
            sofa_f = next((r["formation"] for r in starters if r["formation"]), None)
            sd = sum(1 for r in starters if r["position"] == "D")
            sm = sum(1 for r in starters if r["position"] == "M")
            sf = sum(1 for r in starters if r["position"] == "F")
            sofa_formation_calc = f"{sd}-{sm}-{sf}"

            kl_result, reason = kleague_pos_by_shirt(kl_players)
            if not kl_result:
                sides_kl_fail += 1
                fail_reasons[reason] += 1
                continue
            sides_kl_ok += 1
            kl_pos_by_shirt, kl_f = kl_result

            # 등번호 매칭률
            matched = sum(1 for r in starters if r["shirt_number"] in kl_pos_by_shirt)
            shirt_match_dist[matched] += 1
            side_w_shirt_match.append((eid, side_key, matched))

            # formation 차이
            if kl_f != sofa_formation_calc:
                formation_diff[f"{sofa_formation_calc} -> {kl_f}"] += 1
            else:
                formation_same += 1

            # 라벨 차이 (등번호 매칭된 선수만)
            for r in starters:
                kl_pos = kl_pos_by_shirt.get(r["shirt_number"])
                if kl_pos and kl_pos != r["position"]:
                    label_diff_pid += 1

    print()
    print("K1. K리그 라인업 적용 가능 sides")
    total_sides = sides_kl_ok + sides_kl_fail
    print(f"  적용 가능: {sides_kl_ok} ({sides_kl_ok/max(total_sides,1)*100:.1f}%)")
    print(f"  적용 불가: {sides_kl_fail}")
    for reason, n in fail_reasons.most_common():
        print(f"    - {reason}: {n}")

    print("\nK2. formation 차이 (SS 카운트 → K리그 카운트)")
    print(f"  동일: {formation_same}")
    print(f"  다름: {sum(formation_diff.values())}")
    print("  상위 10:")
    for chg, n in formation_diff.most_common(10):
        print(f"    {n:>4}회  {chg}")

    print(f"\nK3. position 라벨 차이 (등번호 매칭된 starters): {label_diff_pid}명")

    print("\nK4. 등번호 매칭률 (sides 기준)")
    for k in sorted(shirt_match_dist.keys()):
        print(f"  {k}/11: {shirt_match_dist[k]} sides")

    # 매칭률 낮은 매치 샘플
    low = [s for s in side_w_shirt_match if s[2] < 9]
    print(f"\nK4-1. 매칭 < 9 sides (Seoul E-Land 케이스): {len(low)}")
    for s in low[:10]:
        print(f"  ev={s[0]} side={s[1]} matched={s[2]}/11")

    conn.close()


if __name__ == "__main__":
    main()
