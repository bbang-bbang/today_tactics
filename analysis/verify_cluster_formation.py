"""좌표 기반 라인 클러스터링 전수 검증.

main.py build_side의 새 클러스터링 로직(SofaScore position 라벨 무시, raw_x로 D/M/F
자체 재분류)을 K1+K2 finished 전수에 적용해 결과를 통계화.

  C1. 클러스터링 성공/실패율 (모든 starter avg_position 보유 여부 + 라인 수 sanity)
  C2. 클러스터링 결과 vs SofaScore 라벨 차이:
        - position 라벨 변경된 starter 수 (예: D → M)
        - formation 변경 (SofaScore label vs 좌표 클러스터링)
  C3. 자주 발생한 formation 변환 top 15
  C4. 이상 매치: 클러스터링 실패 매치 샘플
  C5. 샘플 — position 라벨 차이 큰 매치 상위 10건

K1+K2 finished 전수 (슈퍼컵 90333089 제외).
"""
from __future__ import annotations

import sqlite3
import sys
from collections import Counter
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "players.db"
EXCLUDED_EVENT_IDS = (90333089,)
EXCLUDED_SQL = "(" + ",".join(str(i) for i in EXCLUDED_EVENT_IDS) + ")"


def cluster_outfield(starter_pts):
    """build_side의 _cluster_outfield_by_avg_x와 동일 로직 (단독 시뮬).
    starter_pts: [(pid, raw_x, raw_y, sofa_pos, name), ...]
    """
    if len(starter_pts) != 11:
        return None
    if any(p[1] is None or p[2] is None for p in starter_pts):
        return None
    pts = sorted(starter_pts, key=lambda t: t[1])
    if pts[0][1] >= 25:
        return None
    gk = pts[0]
    outfield = pts[1:]
    if len(outfield) < 4:
        return None
    gaps = [(outfield[i + 1][1] - outfield[i][1], i) for i in range(len(outfield) - 1)]
    gaps.sort(reverse=True)
    top2 = sorted(gaps[:2], key=lambda g: g[1])
    b1, b2 = top2[0][1], top2[1][1]
    line_d = outfield[:b1 + 1]
    line_m = outfield[b1 + 1:b2 + 1]
    line_f = outfield[b2 + 1:]
    if not (3 <= len(line_d) <= 6 and 1 <= len(line_m) <= 6 and 1 <= len(line_f) <= 4):
        return None
    return {"gk": gk, "D": line_d, "M": line_m, "F": line_f}


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row

    events = conn.execute(f"""
        SELECT DISTINCT ml.event_id
        FROM match_lineups ml
        JOIN events e ON e.id = ml.event_id
        WHERE e.tournament_id IN (410, 777)
          AND e.id NOT IN {EXCLUDED_SQL}
    """).fetchall()
    n_events = len(events)

    sides_total = 0
    sides_clustered = 0
    sides_failed = 0
    fail_reasons = Counter()

    formation_changes = Counter()
    sides_formation_changed = 0
    sides_formation_same = 0

    label_diff_cnt = Counter()    # 'D->M', 'M->D', 'M->F', ...
    pid_label_diff_total = 0
    side_label_diff_max = []     # (eid, is_home, n_diff, samples)

    for ev_row in events:
        eid = ev_row["event_id"]
        rows = conn.execute("""
            SELECT ml.is_home, ml.formation, ml.formation_sofa,
                   ml.player_id, ml.player_name, ml.position, ml.is_starter, ml.slot_order,
                   ap.x ap_x, ap.y ap_y
            FROM match_lineups ml
            LEFT JOIN match_avg_positions ap
                   ON ap.event_id = ml.event_id AND ap.player_id = ml.player_id
            WHERE ml.event_id = ?
        """, (eid,)).fetchall()

        for is_home in (0, 1):
            starter_rows = [r for r in rows if r["is_home"] == is_home and r["is_starter"]]
            if len(starter_rows) != 11:
                continue
            sides_total += 1

            sofa_formation = next((r["formation"] for r in starter_rows if r["formation"]), None)

            starter_pts = [(r["player_id"], r["ap_x"], r["ap_y"], r["position"], r["player_name"]) for r in starter_rows]
            cluster = cluster_outfield(starter_pts)

            if not cluster:
                sides_failed += 1
                if any(p[1] is None for p in starter_pts):
                    fail_reasons["avg_position 누락"] += 1
                else:
                    fail_reasons["라인수 sanity"] += 1
                continue
            sides_clustered += 1

            # formation 비교
            cluster_formation = f"{len(cluster['D'])}-{len(cluster['M'])}-{len(cluster['F'])}"
            if cluster_formation != sofa_formation:
                formation_changes[f"{sofa_formation} -> {cluster_formation}"] += 1
                sides_formation_changed += 1
            else:
                sides_formation_same += 1

            # position 라벨 차이
            cluster_pos = {cluster["gk"][0]: "G"}
            for label in ("D", "M", "F"):
                for p in cluster[label]:
                    cluster_pos[p[0]] = label

            diffs = []
            for r in starter_rows:
                old_pos = r["position"]
                new_pos = cluster_pos.get(r["player_id"], old_pos)
                if old_pos != new_pos:
                    label_diff_cnt[f"{old_pos}->{new_pos}"] += 1
                    pid_label_diff_total += 1
                    diffs.append((r["player_name"], old_pos, new_pos))
            if diffs:
                side_label_diff_max.append((eid, is_home, len(diffs), diffs))

    print(f"검사 대상: K1+K2 finished {n_events} 매치 / {sides_total} sides\n")

    print("=" * 78)
    print("C1. 좌표 클러스터링 성공률")
    print(f"  성공: {sides_clustered} ({sides_clustered/max(sides_total,1)*100:.1f}%)")
    print(f"  실패: {sides_failed}")
    for reason, n in fail_reasons.most_common():
        print(f"    - {reason}: {n}")

    print("\n" + "=" * 78)
    print("C2. 클러스터링 vs SofaScore formation 비교 (성공한 sides 한정)")
    print(f"  formation 변경:  {sides_formation_changed} ({sides_formation_changed/max(sides_clustered,1)*100:.1f}%)")
    print(f"  formation 동일:  {sides_formation_same}")

    print("\n" + "=" * 78)
    print("C3. 자주 발생한 formation 변환 top 15")
    for chg, n in formation_changes.most_common(15):
        print(f"  {n:>4}회  {chg}")

    print("\n" + "=" * 78)
    print(f"C4. position 라벨 변경 총: {pid_label_diff_total}명 (라벨 변경 발생한 starters)")
    for chg, n in label_diff_cnt.most_common():
        print(f"  {chg}: {n}")

    print("\n" + "=" * 78)
    print("C5. position 라벨 변경 다수 매치 top 10 (총 변경 수 기준)")
    side_label_diff_max.sort(key=lambda x: -x[2])
    for s in side_label_diff_max[:10]:
        side = "HOME" if s[1] else "AWAY"
        print(f"  ev={s[0]} {side}: {s[2]}명 변경")
        for name, old, new in s[3]:
            print(f"     - {name[:20]:<22} {old} -> {new}")

    conn.close()


if __name__ == "__main__":
    main()
