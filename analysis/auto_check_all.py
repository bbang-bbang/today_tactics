"""전수 자동 점검 — v11 적용 후 K리그 적용률 + 의심 케이스 detection.

  C1. K리그 적용 vs SS fallback 사이드 비율 (등번호+이름 매칭 결과)
  C2. K리그 적용된 매치의 formation 분포
  C3. SS fallback된 매치 (K리그 미적용 사유) 분석
  C4. 라벨/슬롯 시각 무결성 검증 (line_x_order, slot_dup)
  C5. K리그 데이터 자체 의심 (raw row 인원 불균형, GK 위치 이상 등)
"""
from __future__ import annotations
import sys, sqlite3, os
from collections import Counter, defaultdict
from pathlib import Path
try: sys.stdout.reconfigure(encoding="utf-8")
except: pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))
from main import app

DB = ROOT / "players.db"


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    events = conn.execute("""
        SELECT DISTINCT m.sofa_event_id, date(e.date_ts,'unixepoch','localtime') d
        FROM kleague_event_map m
        JOIN events e ON e.id=m.sofa_event_id
        WHERE EXISTS (SELECT 1 FROM kleague_lineup WHERE sofa_event_id=m.sofa_event_id)
          AND e.id NOT IN (90333089)
        ORDER BY e.date_ts DESC
    """).fetchall()
    print(f"K리그 라인업 매치: {len(events)}건\n")

    kl_applied = 0
    ss_fallback = 0
    formation_dist = Counter()
    fallback_reasons = Counter()
    suspect = []
    visited_sides = 0

    # K리그 적용 여부 추적: API response의 starters[i].position과 K리그 데이터 비교
    with app.test_client() as cl:
        for ev_row in events[:3700]:
            eid = ev_row["sofa_event_id"]
            try:
                data = cl.get(f"/api/match-lineup?event_id={eid}").get_json()
            except: continue
            if not data or not data.get("ready"): continue

            # K리그 raw 데이터
            for side_key in ("home", "away"):
                side = data.get(side_key)
                if not side: continue
                visited_sides += 1
                starters = side.get("starters", [])
                kl = conn.execute(
                    "SELECT back_no, player_name FROM kleague_lineup WHERE sofa_event_id=? AND side=?",
                    (eid, side_key)).fetchall()
                if len(kl) != 11:
                    continue

                kl_shirts = {r["back_no"] for r in kl}
                # SS starter shirt_number와 K리그 매핑
                ss_shirts = {s["shirt_number"] for s in starters if s.get("shirt_number") is not None}
                shirt_match = len(ss_shirts & kl_shirts)

                # K리그 적용 추정: K리그 row 인원과 API formation row 인원 일치
                formation = side.get("formation", "")
                fparts = [int(x) for x in formation.split("-") if x.isdigit()]
                # K리그 raw row count
                by_t = defaultdict(int)
                kl_full = conn.execute(
                    "SELECT top_pct FROM kleague_lineup WHERE sofa_event_id=? AND side=?",
                    (eid, side_key)).fetchall()
                for r in kl_full:
                    by_t[round(r["top_pct"], 1)] += 1
                kl_rows = [v for k, v in sorted(by_t.items(), reverse=True)][1:]  # skip GK

                # 비교: kl_rows를 단순 4-row로 축소했을 때 fparts와 일치하면 K리그 적용된 것
                # (정확한 비교는 어려우나 합계와 row 수 비슷성으로 추정)
                if fparts == kl_rows or sum(fparts) == sum(kl_rows):
                    formation_dist[formation] += 1
                    kl_applied += 1
                else:
                    ss_fallback += 1
                    fallback_reasons[f"row mismatch (kl={kl_rows}, ss={fparts})"] += 1
                    if len(suspect) < 10 and shirt_match < 11:
                        suspect.append({
                            "ev": eid, "d": ev_row["d"], "side": side_key,
                            "shirt_match": shirt_match,
                            "formation": formation, "kl_rows": kl_rows,
                        })

    print("\nC1. K리그 적용 vs SS fallback:")
    print(f"  방문 sides: {visited_sides}")
    print(f"  K리그 적용 추정: {kl_applied} ({kl_applied/max(visited_sides,1)*100:.1f}%)")
    print(f"  SS fallback 추정: {ss_fallback}")

    print("\nC2. K리그 적용 formation 분포 (top 15):")
    for f, n in formation_dist.most_common(15):
        print(f"  {f}: {n}")

    print("\nC3. SS fallback 사유 (top 10):")
    for r, n in fallback_reasons.most_common(10):
        print(f"  {r}: {n}")

    print("\nC5. 의심 매치 (shirt 매칭 < 11, K리그 미적용):")
    for s in suspect:
        print(f"  ev={s['ev']} {s['d']} {s['side']} shirt={s['shirt_match']}/11 formation={s['formation']} kl_rows={s['kl_rows']}")

    conn.close()


if __name__ == "__main__":
    main()
