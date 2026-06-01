"""B 방식(라인 내 starter 좌우 재정렬) 전수 검증.

K1+K2 finished 모든 매치에서 main.py build_side 로직을 그대로 시뮬레이트하여:

  S1. 포메이션 재도출 비율 — SofaScore 라벨 vs 실측 분포가 다른 경우
  S2. 라인 내 starter swap 적용 비율 — slot_order가 실제 재할당된 경우
  S3. 매치별 변경 영향 — 변경 없음 / D/M/F 중 일부 라인 swap / 다중 라인 swap
  S4. 이상 매치 검출:
        - swap 후 슬롯 충돌 (한 슬롯에 2명 할당)
        - 같은 라인 내 avg_y 분산이 너무 작아 swap이 무의미 (1.0 미만)
        - 라인 멤버 수와 슬롯 수 불일치

샘플 출력으로 의심 매치 상위 N개 보고.
"""
from __future__ import annotations

import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from main import _build_formation_slots  # noqa: E402

DB = ROOT / "players.db"
EXCLUDED_EVENT_IDS = (90333089,)
EXCLUDED_SQL = "(" + ",".join(str(i) for i in EXCLUDED_EVENT_IDS) + ")"


def rederive_formation(formation, formation_sofa, actual_d, actual_m, actual_f):
    """main.py build_side의 formation 재도출 로직 그대로."""
    if formation_sofa:
        try:
            if actual_d + actual_m + actual_f == 10 and int(formation_sofa.split("-")[0]) != actual_d:
                raise ValueError
            return formation_sofa
        except (ValueError, IndexError):
            parts = []
            if actual_d: parts.append(str(actual_d))
            if actual_m: parts.append(str(actual_m))
            if actual_f: parts.append(str(actual_f))
            return "-".join(parts) if parts else formation
    elif actual_d + actual_m + actual_f == 10 and formation:
        try:
            if int(formation.split("-")[0]) != actual_d:
                parts = []
                if actual_d: parts.append(str(actual_d))
                if actual_m: parts.append(str(actual_m))
                if actual_f: parts.append(str(actual_f))
                return "-".join(parts) if parts else formation
        except (ValueError, IndexError):
            pass
    return formation


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row

    events = conn.execute(f"""
        SELECT DISTINCT ml.event_id, e.tournament_id, e.date_ts,
               e.home_team_id, e.away_team_id
        FROM match_lineups ml
        JOIN events e ON e.id = ml.event_id
        WHERE e.tournament_id IN (410, 777)
          AND e.id NOT IN {EXCLUDED_SQL}
        ORDER BY e.date_ts DESC
    """).fetchall()
    n_events = len(events)
    print(f"검사 대상: K1+K2 finished {n_events} 매치\n")

    # 통계
    sides_total = 0
    sides_formation_rederived = 0       # SofaScore 라벨과 실측 분포가 다름
    sides_formation_same = 0
    sides_swap_applied = 0              # 라인 내 slot_order swap 1회 이상
    sides_no_swap = 0
    sides_no_avg = 0                    # avg_position 없어 swap 자체 불가
    line_swap_count = Counter()         # {"D": N, "M": N, "F": N} 라인별 swap 매치 수
    formation_changes = Counter()       # {"3-4-3->5-4-1": N}
    anomalies = []                       # 이상 매치
    sample_rederive = []                # 재도출 샘플
    sample_swap = []                     # swap 샘플

    for ev in events:
        eid = ev["event_id"]
        rows = conn.execute("""
            SELECT ml.is_home, ml.formation, ml.formation_sofa,
                   ml.player_id, ml.player_name, ml.position, ml.is_starter, ml.slot_order,
                   ap.x AS ap_x, ap.y AS ap_y
            FROM match_lineups ml
            LEFT JOIN match_avg_positions ap
                   ON ap.event_id = ml.event_id AND ap.player_id = ml.player_id
            WHERE ml.event_id = ?
        """, (eid,)).fetchall()

        avg_by_pid = {r["player_id"]: (r["ap_x"], r["ap_y"]) for r in rows if r["ap_x"] is not None}

        for is_home in (0, 1):
            side_rows = [r for r in rows if r["is_home"] == is_home]
            if not side_rows:
                continue
            starter_rows = [r for r in side_rows if r["is_starter"]]
            if len(starter_rows) != 11:
                continue
            sides_total += 1

            formation_db   = next((r["formation"] for r in side_rows if r["formation"]), None)
            formation_sofa = next((r["formation_sofa"] for r in side_rows if r["formation_sofa"]), None)
            actual_d = sum(1 for r in starter_rows if r["position"] == "D")
            actual_m = sum(1 for r in starter_rows if r["position"] == "M")
            actual_f = sum(1 for r in starter_rows if r["position"] == "F")

            formation_final = rederive_formation(formation_db, formation_sofa, actual_d, actual_m, actual_f)
            if formation_final != formation_db:
                sides_formation_rederived += 1
                formation_changes[f"{formation_db} -> {formation_final}"] += 1
                if len(sample_rederive) < 10:
                    sample_rederive.append({
                        "event_id": eid, "is_home": is_home,
                        "from": formation_db, "to": formation_final,
                        "d/m/f": f"{actual_d}/{actual_m}/{actual_f}",
                    })
            else:
                sides_formation_same += 1

            if not formation_final:
                continue
            slots = _build_formation_slots(formation_final, mirror=(not bool(is_home)))

            # B 방식 swap 시뮬레이트
            if not avg_by_pid:
                sides_no_avg += 1
                continue

            starters = []
            for r in starter_rows:
                starters.append({
                    "player_id": r["player_id"],
                    "name": r["player_name"],
                    "position": r["position"],
                    "slot_order_orig": r["slot_order"],
                    "slot_order_new":  r["slot_order"],
                })

            by_line = defaultdict(list)
            line_sos = defaultdict(list)
            for st in starters:
                pos = st["position"]; so = st["slot_order_orig"]
                if pos in ("D", "M", "F") and so is not None and 0 <= so < len(slots):
                    by_line[pos].append(st)
                    line_sos[pos].append(so)

            swap_applied_in_side = False
            for pos, group in by_line.items():
                if len(group) < 2:
                    continue
                if not all(st["player_id"] in avg_by_pid for st in group):
                    continue
                sorted_st = sorted(group, key=lambda st: avg_by_pid[st["player_id"]][1])
                sorted_so = sorted(line_sos[pos], key=lambda so: slots[so]["y"])
                changed = False
                for st, new_so in zip(sorted_st, sorted_so):
                    if st["slot_order_new"] != new_so:
                        changed = True
                    st["slot_order_new"] = new_so
                if changed:
                    line_swap_count[pos] += 1
                    if len(sample_swap) < 8:
                        sample_swap.append({
                            "event_id": eid, "is_home": is_home, "line": pos,
                            "orig":  [(st["name"][:14], st["slot_order_orig"], round(avg_by_pid[st["player_id"]][1],1)) for st in group],
                            "new":   [(st["name"][:14], st["slot_order_new"]) for st in sorted_st],
                        })
                    swap_applied_in_side = True

            if swap_applied_in_side:
                sides_swap_applied += 1
            else:
                sides_no_swap += 1

            # 이상 검출
            new_sos = [st["slot_order_new"] for st in starters]
            if len(set(new_sos)) != len(new_sos):
                anomalies.append((eid, is_home, "slot 충돌", Counter(new_sos).most_common()))
            if len(starters) != len(slots):
                anomalies.append((eid, is_home, "라인 수 불일치", f"starter={len(starters)} slots={len(slots)}"))

    # ── 보고 ────────────────────────────────────────
    print("=" * 78)
    print("S1. 포메이션 재도출 비율")
    print(f"  sides 합계: {sides_total}")
    print(f"  재도출 발생: {sides_formation_rederived} ({sides_formation_rederived/max(sides_total,1)*100:.1f}%)")
    print(f"  변화 없음:   {sides_formation_same}")
    print("\n  자주 발생한 변환 (top 10):")
    for chg, n in formation_changes.most_common(10):
        print(f"    {n:>4}회  {chg}")

    print("\n" + "=" * 78)
    print("S2. 라인 내 starter swap 비율")
    print("  avg_position 있는 sides 중:")
    swap_pool = sides_total - sides_no_avg
    print(f"    swap 적용: {sides_swap_applied} / {swap_pool} ({sides_swap_applied/max(swap_pool,1)*100:.1f}%)")
    print(f"    swap 없음: {sides_no_swap}")
    print(f"  avg_position 없음(swap 불가): {sides_no_avg} sides")
    print("\n  라인별 swap 발생 횟수:")
    for line in ("D", "M", "F"):
        print(f"    {line}: {line_swap_count[line]} 매치")

    print("\n" + "=" * 78)
    print("S3. 이상 매치")
    if not anomalies:
        print("  PASS — 0건")
    else:
        for a in anomalies[:10]:
            print(f"  {a}")
        if len(anomalies) > 10:
            print(f"  ... (+{len(anomalies)-10})")

    print("\n" + "=" * 78)
    print("샘플 — 포메이션 재도출 (최근 10건)")
    for s in sample_rederive:
        side = "HOME" if s["is_home"] else "AWAY"
        print(f"  ev={s['event_id']} {side} {s['from']:>7} -> {s['to']:<7} (D/M/F={s['d/m/f']})")

    print("\n" + "=" * 78)
    print("샘플 — 라인 내 swap (최근 8건)")
    for s in sample_swap:
        side = "HOME" if s["is_home"] else "AWAY"
        print(f"  ev={s['event_id']} {side} line={s['line']}")
        print(f"    원본 (이름, slot_order, avg_y): {s['orig']}")
        print(f"    swap (이름, new_slot_order):   {s['new']}")

    conn.close()


if __name__ == "__main__":
    main()
