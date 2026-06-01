"""전술판 선수 업로드 정합성 검증.

`/api/match-lineup` → `applyMatchLineup` 흐름의 데이터 무결성:
  A. 매치별 starter 정확히 11명 (home, away 각각)
  B. slot_order가 0~10 unique (중복·결측 없음)
  C. GK 슬롯(slot_order=0)의 player.position == 'G'
  D. player_id가 players 테이블에 존재
  E. name·shirt_number null/공백 없음
  F. formation 등록 또는 fallback 유효

K1+K2 finished 매치 전수 (슈퍼컵 90333089 제외).
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
    print(f"검사 대상: K1+K2 {n_events} 매치 (lineup 보유)")

    # 정합 오류 누적
    fail_A_starter_count = []   # (event_id, is_home, count)
    fail_B_slot_order   = []    # (event_id, is_home, issue, detail)
    fail_C_gk_position  = []    # (event_id, is_home, slot0_pos, player_name)
    fail_D_missing_pid  = []    # (event_id, player_id, player_name)
    fail_E_blank_field  = []    # (event_id, player_id, field, value)
    fail_F_formation    = []    # (event_id, is_home, formation)

    # 검사용: players 테이블에 있는 ID 집합
    valid_pids = {r[0] for r in conn.execute("SELECT id FROM players").fetchall()}

    for ev_row in events:
        eid = ev_row["event_id"]
        rows = conn.execute("""
            SELECT is_home, formation, player_id, player_name, shirt_number,
                   position, is_starter, slot_order
            FROM match_lineups
            WHERE event_id = ?
        """, (eid,)).fetchall()

        for is_home in (0, 1):
            side_rows = [r for r in rows if r["is_home"] == is_home]
            if not side_rows:
                continue

            starters = [r for r in side_rows if r["is_starter"] == 1]

            # A. starter 11명
            if len(starters) != 11:
                fail_A_starter_count.append((eid, is_home, len(starters)))

            # B. slot_order 0~10 unique
            slot_orders = [r["slot_order"] for r in starters if r["slot_order"] is not None]
            if slot_orders:
                if min(slot_orders) != 0 or max(slot_orders) > 10:
                    fail_B_slot_order.append((eid, is_home, "range", f"{min(slot_orders)}~{max(slot_orders)}"))
                cnt = Counter(slot_orders)
                dup = [k for k, v in cnt.items() if v > 1]
                if dup:
                    fail_B_slot_order.append((eid, is_home, "duplicate", dup))
                missing = sorted(set(range(11)) - set(slot_orders))
                if missing and len(starters) == 11:
                    fail_B_slot_order.append((eid, is_home, "missing", missing))

            # C. GK 슬롯(slot_order=0)이 'G' 포지션
            gk_slot = next((r for r in starters if r["slot_order"] == 0), None)
            if gk_slot and gk_slot["position"] != "G":
                fail_C_gk_position.append((eid, is_home, gk_slot["position"], gk_slot["player_name"]))

            # F. formation null/잘못된 형식
            formation = side_rows[0]["formation"]
            if not formation:
                fail_F_formation.append((eid, is_home, None))
            elif not all(p.isdigit() for p in formation.split("-")):
                fail_F_formation.append((eid, is_home, formation))

            # D·E 검사 (선발+교체 전체)
            for r in side_rows:
                # D. player_id가 players 테이블 존재
                if r["player_id"] not in valid_pids:
                    fail_D_missing_pid.append((eid, r["player_id"], r["player_name"]))
                # E. name·shirt 검사
                if not r["player_name"] or not r["player_name"].strip():
                    fail_E_blank_field.append((eid, r["player_id"], "player_name", repr(r["player_name"])))
                if r["is_starter"] == 1 and r["shirt_number"] is None:
                    fail_E_blank_field.append((eid, r["player_id"], "shirt_number", "None"))

    # ── 보고 ────────────────────────────────────────
    def report(name, fails, head=10):
        status = "PASS" if not fails else f"FAIL ({len(fails)}건)"
        print(f"\n[{name}] {status}")
        for row in fails[:head]:
            print(f"  - {row}")
        if len(fails) > head:
            print(f"  ... (+{len(fails)-head} more)")

    print("\n검사 결과")
    report("A starter 정확히 11명",        fail_A_starter_count)
    report("B slot_order 0~10 unique",    fail_B_slot_order)
    report("C GK 슬롯 position='G'",      fail_C_gk_position)
    report("D player_id players 존재",    fail_D_missing_pid)
    report("E player_name·shirt 채워짐",  fail_E_blank_field)
    report("F formation 등록·형식",        fail_F_formation)

    total_fails = sum(map(len, [fail_A_starter_count, fail_B_slot_order, fail_C_gk_position,
                                fail_D_missing_pid, fail_E_blank_field, fail_F_formation]))
    print(f"\n총 정합 오류: {total_fails}건 / {n_events} 매치 × 2 sides")

    conn.close()


if __name__ == "__main__":
    main()
