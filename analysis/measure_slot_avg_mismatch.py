"""슬롯 순서 vs 실제 평균위치(avg_x) 정렬 불일치 측정.

`match_lineups.slot_order`는 SofaScore가 부여한 포메이션 슬롯 인덱스.
`match_avg_positions.x`는 그 경기에서 실측된 평균 x 좌표.

같은 라인(같은 position 카테고리) 내에서 `slot_order` 순서대로 줄세웠을 때
`avg_x` 정렬도 같아야 시각화상 좌→우 배치가 일치한다.
불일치 매치 수를 K1+K2 finished 전수로 집계.

판정: 같은 라인 안의 slot_order 순서와 avg_x 순서가 다르면 mismatch 1.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB = Path(__file__).resolve().parent.parent / "players.db"
EXCLUDED_EVENT_IDS = (90333089,)
EXCLUDED_SQL = "(" + ",".join(str(i) for i in EXCLUDED_EVENT_IDS) + ")"


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
    sides_with_avg = 0
    sides_mismatch = 0
    mismatch_samples = []

    for ev_row in events:
        eid = ev_row["event_id"]
        rows = conn.execute("""
            SELECT ml.is_home, ml.slot_order, ml.position, ml.player_id, ml.player_name,
                   ap.x AS ap_x
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
            if not all(r["ap_x"] is not None for r in side_rows):
                continue
            sides_with_avg += 1

            # 라인별 그룹화 (position: D/M/F — GK는 1명이라 제외)
            by_pos = {}
            for r in side_rows:
                pos = r["position"]
                if pos == "G":
                    continue
                by_pos.setdefault(pos, []).append(r)

            mismatch_in_side = False
            for pos, group in by_pos.items():
                if len(group) < 2:
                    continue
                by_slot = sorted(group, key=lambda r: r["slot_order"])
                by_avg = sorted(group, key=lambda r: r["ap_x"])
                if [r["player_id"] for r in by_slot] != [r["player_id"] for r in by_avg]:
                    mismatch_in_side = True
                    if len(mismatch_samples) < 8:
                        slot_names = [r["player_name"] for r in by_slot]
                        avg_names = [r["player_name"] for r in by_avg]
                        mismatch_samples.append({
                            "event_id": eid, "is_home": is_home, "line": pos,
                            "slot_order": slot_names, "avg_x_order": avg_names,
                        })

            if mismatch_in_side:
                sides_mismatch += 1

    print(f"검사 대상: K1+K2 {n_events} 매치 (lineup 보유)")
    print(f"side 단위 합계: {sides_total}")
    print(f"  avg_position 보유: {sides_with_avg}")
    print(f"  slot_order ≠ avg_x 정렬 mismatch: {sides_mismatch} ({sides_mismatch/max(sides_with_avg,1)*100:.1f}%)")
    print("\n샘플 (최대 8건):")
    for s in mismatch_samples:
        print(f"  ev={s['event_id']} {'HOME' if s['is_home'] else 'AWAY'} line={s['line']}")
        print(f"    slot 순:  {s['slot_order']}")
        print(f"    avg_x 순: {s['avg_x_order']}")

    conn.close()


if __name__ == "__main__":
    main()
