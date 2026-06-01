"""실제 /api/match-lineup 응답을 시뮬레이트하여 슬롯 정합성 자동 검증.

Flask test_client로 실제 build_side 호출. 각 매치 응답에 대해:
  V1. 11명 starter 모두 0~10 slot_order, 중복 없음
  V2. GK(position='G') slot_order=0, slot.x가 자기 골대 부근 (home: <0.2 / away: >0.8)
  V3. 같은 라인의 starter slot.y 분산이 양호 (한쪽으로 몰리지 않음)
  V4. formation row 수 ≥ 3, 각 row 인원 ≥ 1
  V5. 라인 라벨(D/M/F)이 slot.x 순서대로 D→M→F 정합

이상 케이스 자동 보고 + 매칭 발견 시 분석.
"""
from __future__ import annotations
import sys, os
from collections import Counter, defaultdict
from pathlib import Path

try: sys.stdout.reconfigure(encoding="utf-8")
except: pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))

# Flask app import
from main import app
import sqlite3

DB = ROOT / "players.db"


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    events = conn.execute("""
        SELECT DISTINCT m.sofa_event_id
        FROM kleague_event_map m
        WHERE EXISTS (SELECT 1 FROM kleague_lineup WHERE sofa_event_id=m.sofa_event_id)
        LIMIT 2500
    """).fetchall()
    conn.close()

    fails = defaultdict(list)
    formation_dist = Counter()
    slot_x_ranges = Counter()
    n_total = 0
    n_kleague_applied = 0
    n_fallback = 0

    with app.test_client() as client:
        for ev_row in events:
            eid = ev_row["sofa_event_id"]
            r = client.get(f"/api/match-lineup?event_id={eid}")
            if r.status_code != 200:
                fails["http_err"].append((eid, r.status_code))
                continue
            data = r.get_json()
            if not data or not data.get("ready"):
                fails["not_ready"].append((eid, data.get("reason") if data else "no_data"))
                continue

            for side_key in ("home", "away"):
                side = data.get(side_key)
                if not side:
                    fails["no_side"].append((eid, side_key))
                    continue
                n_total += 1
                slots = side.get("slots", [])
                starters = side.get("starters", [])
                formation = side.get("formation", "")
                is_home = (side_key == "home")

                if len(starters) != 11:
                    fails["starter_count"].append((eid, side_key, len(starters)))
                    continue

                # V1. slot_order 중복·범위
                sos = [s.get("slot_order") for s in starters]
                if None in sos:
                    fails["slot_order_none"].append((eid, side_key))
                if len(set(sos)) != 11:
                    fails["slot_dup"].append((eid, side_key, Counter(sos).most_common(2)))
                bad_so = [so for so in sos if so is None or so < 0 or so > 10]
                if bad_so:
                    fails["slot_range"].append((eid, side_key, bad_so))

                # V2. GK 위치
                gk = next((s for s in starters if s.get("position") == "G"), None)
                if gk:
                    gk_slot = slots[gk["slot_order"]] if 0 <= gk["slot_order"] < len(slots) else None
                    if gk_slot:
                        gx = gk_slot.get("x", 0.5)
                        if is_home and gx > 0.2:
                            fails["gk_pos_home"].append((eid, side_key, round(gx, 3), gk.get("name")))
                        elif not is_home and gx < 0.8:
                            fails["gk_pos_away"].append((eid, side_key, round(gx, 3), gk.get("name")))

                # V3. 라인 슬롯 분산
                by_pos = defaultdict(list)
                for s in starters:
                    by_pos[s.get("position", "?")].append(s)
                for pos, sts in by_pos.items():
                    if pos == "G" or len(sts) < 2: continue
                    ys = [slots[s["slot_order"]]["y"] for s in sts if 0 <= s["slot_order"] < len(slots)]
                    if len(ys) >= 2 and max(ys) - min(ys) < 0.1:
                        fails["line_y_collapsed"].append((eid, side_key, pos, [round(y, 3) for y in ys]))

                # V4. formation row 수
                if formation:
                    rows = formation.split("-")
                    if len(rows) < 2 or not all(r.isdigit() for r in rows):
                        fails["formation_bad"].append((eid, side_key, formation))

                # V5. 라인 x 정합 (D → M → F: x 증가)
                line_avg_x = {}
                for pos, sts in by_pos.items():
                    if pos == "G" or not sts: continue
                    xs = [slots[s["slot_order"]]["x"] for s in sts if 0 <= s["slot_order"] < len(slots)]
                    if xs: line_avg_x[pos] = sum(xs) / len(xs)
                # home: D < M < F (x 증가). away: D > M > F (mirror)
                if "D" in line_avg_x and "M" in line_avg_x and "F" in line_avg_x:
                    d, m, f = line_avg_x["D"], line_avg_x["M"], line_avg_x["F"]
                    if is_home and not (d < m < f):
                        fails["line_x_order"].append((eid, side_key, round(d, 3), round(m, 3), round(f, 3)))
                    elif not is_home and not (d > m > f):
                        fails["line_x_order"].append((eid, side_key, round(d, 3), round(m, 3), round(f, 3)))

                formation_dist[formation] += 1
                # K리그 적용 여부 추정
                gk_first = starters[0] if starters else None

    print(f"=== 검사 {n_total} sides ===\n")
    print("V 검증 결과:")
    for k, v in sorted(fails.items()):
        print(f"  {k}: {len(v)}건")
        for ex in v[:5]:
            print(f"    {ex}")
    print(f"\n전체 무결성: {sum(len(v) for v in fails.values())}건 이상")
    print("\nformation 분포 top 15:")
    for f, n in formation_dist.most_common(15):
        print(f"  {f}: {n}")


if __name__ == "__main__":
    main()
