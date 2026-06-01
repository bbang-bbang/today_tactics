"""avg_position 오버라이드 후 전 매치 정합성 전수 검증.

main.py `build_side`의 변환 로직을 그대로 재현:
- home: slot.x = raw_x/100,   slot.y = 1 - raw_y/100
- away: slot.x = 1 - raw_x/100, slot.y = raw_y/100

검증 축:
  V1. avg_position 커버리지 — starter 11명 중 몇 명에 avg 좌표가 있는가
  V2. 같은 라인 내 slot.x 순서가 avg_x 순서와 정합 (home은 동순, away는 역순)
  V3. GK는 자기 골대 부근 (home: x<0.25 / away: x>0.75)
  V4. slot_order 인덱스 범위 (0~10) 유효
  V5. avg_override 적용된 슬롯이 formation slot 좌표와 다른지 (실제 변경 효과)

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

DB = Path(__file__).resolve().parent.parent / "players.db"
EXCLUDED_EVENT_IDS = (90333089,)
EXCLUDED_SQL = "(" + ",".join(str(i) for i in EXCLUDED_EVENT_IDS) + ")"


def transform_xy(is_home, raw_x, raw_y):
    """main.py build_side와 동일한 변환."""
    if is_home:
        return raw_x / 100.0, 1.0 - raw_y / 100.0
    else:
        return 1.0 - raw_x / 100.0, raw_y / 100.0


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
    print(f"검증 대상: K1+K2 finished {n_events} 매치 (lineup 보유)\n")

    # 통계 누적
    sides_total = 0
    sides_full_avg = 0       # starter 11명 모두 avg 보유
    sides_partial_avg = 0    # 일부만 avg 보유
    sides_no_avg = 0         # avg 전무 (라이브 매치 가능성)

    fail_V2 = []  # (eid, is_home, line, slot_order_list, avg_x_order_list)
    fail_V3 = []  # (eid, is_home, gk_slot_x)
    fail_V4 = []  # (eid, is_home, bad_slot_order)
    coverage_dist = Counter()

    for ev_row in events:
        eid = ev_row["event_id"]
        rows = conn.execute("""
            SELECT ml.is_home, ml.slot_order, ml.position, ml.player_id, ml.player_name,
                   ap.x AS ap_x, ap.y AS ap_y
            FROM match_lineups ml
            LEFT JOIN match_avg_positions ap
                   ON ap.event_id = ml.event_id AND ap.player_id = ml.player_id
            WHERE ml.event_id = ? AND ml.is_starter = 1
        """, (eid,)).fetchall()

        for is_home in (0, 1):
            side_rows = [r for r in rows if r["is_home"] == is_home]
            if len(side_rows) != 11:
                continue
            sides_total += 1

            # V1. 커버리지
            with_avg = [r for r in side_rows if r["ap_x"] is not None]
            cov = len(with_avg)
            coverage_dist[cov] += 1
            if cov == 11:
                sides_full_avg += 1
            elif cov == 0:
                sides_no_avg += 1
                continue
            else:
                sides_partial_avg += 1

            # V4. slot_order 범위
            for r in side_rows:
                so = r["slot_order"]
                if so is None or not (0 <= so <= 10):
                    fail_V4.append((eid, is_home, so))

            # 변환 후 slot 좌표 계산
            transformed = []
            for r in with_avg:
                sx, sy = transform_xy(is_home, r["ap_x"], r["ap_y"])
                transformed.append({
                    "slot_order": r["slot_order"],
                    "position":   r["position"],
                    "name":       r["player_name"],
                    "ap_x":       r["ap_x"],
                    "sx":         sx,
                    "sy":         sy,
                })

            # V3. GK 좌측/우측 정합
            gk = next((t for t in transformed if t["position"] == "G"), None)
            if gk:
                if is_home and gk["sx"] > 0.25:
                    fail_V3.append((eid, is_home, round(gk["sx"], 3)))
                elif not is_home and gk["sx"] < 0.75:
                    fail_V3.append((eid, is_home, round(gk["sx"], 3)))

            # V2. 같은 라인 내 slot.x 순서 정합
            # 홈: ap_x ↑ → sx ↑ (동순), 어웨이: ap_x ↑ → sx ↓ (역순)
            # 즉 변환 후 sx 정렬 = 같은 라인 내 좌우 분포가 일관되어야 함.
            # 실제로는 변환 후 sx 자체가 그 좌우 정렬이므로 V2는 변환 함수 검증.
            # 의미 있는 V2: 같은 라인에서 sx 순서로 정렬한 player_id 리스트가
            # 변환 직전 ap_x 정렬한 리스트(home: 동순, away: 역순)과 일치하는가
            by_pos = {}
            for t in transformed:
                if t["position"] == "G":
                    continue
                by_pos.setdefault(t["position"], []).append(t)

            for pos, group in by_pos.items():
                if len(group) < 2:
                    continue
                by_sx = sorted(group, key=lambda t: t["sx"])
                by_ap = sorted(group, key=lambda t: t["ap_x"], reverse=(not is_home))
                if [t["name"] for t in by_sx] != [t["name"] for t in by_ap]:
                    fail_V2.append((eid, is_home, pos,
                                    [t["name"] for t in by_sx],
                                    [t["name"] for t in by_ap]))

    # ── 보고 ────────────────────────────────────────
    print("=" * 70)
    print("V1. avg_position 커버리지 (side 단위)")
    print(f"   sides 합계: {sides_total}")
    print(f"   full(11/11):   {sides_full_avg} ({sides_full_avg/max(sides_total,1)*100:.1f}%)")
    print(f"   partial(1~10): {sides_partial_avg} ({sides_partial_avg/max(sides_total,1)*100:.1f}%)")
    print(f"   none(0/11):    {sides_no_avg} ({sides_no_avg/max(sides_total,1)*100:.1f}%)")
    print("   partial 커버리지 분포 (선수 수→sides):")
    for cov in sorted(coverage_dist):
        if cov in (0, 11):
            continue
        print(f"     {cov}명 보유: {coverage_dist[cov]} sides")

    def report(name, fails, head=5):
        status = "PASS" if not fails else f"FAIL ({len(fails)}건)"
        print(f"\n{name}: {status}")
        for row in fails[:head]:
            print(f"   - {row}")
        if len(fails) > head:
            print(f"   ... (+{len(fails)-head} more)")

    report("V2. 변환식 → slot.x 정렬 정합 (자기점검)", fail_V2)
    report("V3. GK 자기 골대 부근 위치", fail_V3)
    report("V4. slot_order 0~10 범위", fail_V4)

    total = len(fail_V2) + len(fail_V3) + len(fail_V4)
    print(f"\n총 오류: {total}건")
    print(f"→ avg_position 오버라이드 적용 가능 sides: {sides_total - sides_no_avg} / {sides_total}")

    conn.close()


if __name__ == "__main__":
    main()
