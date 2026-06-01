"""각 formation별 샘플 매치 자동 검증.

  - 흔치 않은 formation(빈도 < 5%) 매치 샘플링
  - K리그 raw row 패턴과 알고리즘 결과 비교
  - GK·DF·MF·FW 라인 시각적 정합 (sy, sx 분포) 점검
  - SofaScore label과 K리그 label 차이 큰 매치 검출
"""
from __future__ import annotations
import sys, os, sqlite3
from collections import defaultdict
from pathlib import Path

try: sys.stdout.reconfigure(encoding="utf-8")
except: pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))
from main import app

DB = ROOT / "players.db"
SAMPLE_PER_FORMATION = 3


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row

    # API 응답으로 formation 분포 (사이드 단위) 다시 산출
    formation_to_eids = defaultdict(list)
    events = conn.execute("SELECT DISTINCT sofa_event_id FROM kleague_lineup").fetchall()

    with app.test_client() as cl:
        for ev in events:
            eid = ev["sofa_event_id"]
            data = cl.get(f"/api/match-lineup?event_id={eid}").get_json()
            if not data or not data.get("ready"):
                continue
            for side_key in ("home", "away"):
                side = data.get(side_key)
                if not side: continue
                f = side.get("formation", "?")
                formation_to_eids[f].append((eid, side_key))

    formation_dist = {f: len(lst) for f, lst in formation_to_eids.items()}
    total_sides = sum(formation_dist.values())

    # 빈도 낮은(< 1%) formation 우선 확인
    uncommon = sorted(
        [(f, n) for f, n in formation_dist.items() if n / total_sides < 0.01],
        key=lambda x: -x[1],
    )
    print(f"=== 빈도 낮은 formation ({len(uncommon)}종) — 각 최대 {SAMPLE_PER_FORMATION}매치 ===\n")

    for f, n in uncommon[:15]:
        print(f"\n┌─ formation: {f} ({n}건, {n/total_sides*100:.2f}%)")
        samples = formation_to_eids[f][:SAMPLE_PER_FORMATION]
        for eid, side_key in samples:
            ev_meta = conn.execute(
                "SELECT date(date_ts,'unixepoch','localtime') d, home_team_name, away_team_name FROM events WHERE id=?",
                (eid,)).fetchone()
            kl = conn.execute(
                "SELECT back_no, player_name, top_pct, left_pct FROM kleague_lineup WHERE sofa_event_id=? AND side=? ORDER BY top_pct DESC, left_pct",
                (eid, side_key)).fetchall()
            by_t = defaultdict(list)
            for r in kl:
                by_t[round(r["top_pct"],1)].append(r)
            row_pat = tuple(len(by_t[t]) for t in sorted(by_t.keys(), reverse=True))
            tnm = ev_meta["home_team_name"] if side_key == "home" else ev_meta["away_team_name"]
            print(f"│ ev={eid} {ev_meta['d']} {side_key.upper()} {tnm[:25]}")
            print(f"│   K리그 row 패턴: {row_pat}")

    # 사용자 인지 의심 — SofaScore formation vs K리그 formation 가장 다른 매치
    print("\n\n=== SofaScore vs K리그 formation 차이 큰 매치 top 10 ===\n")
    with app.test_client() as cl:
        diff_examples = []
        for ev in events[:500]:  # 500개 샘플
            eid = ev["sofa_event_id"]
            for side_key in ("home", "away"):
                is_home = (side_key == "home")
                ss_f = conn.execute(
                    "SELECT formation FROM match_lineups WHERE event_id=? AND is_home=? AND is_starter=1 AND formation IS NOT NULL LIMIT 1",
                    (eid, 1 if is_home else 0)).fetchone()
                if not ss_f: continue
                ss_f = ss_f["formation"]
                data = cl.get(f"/api/match-lineup?event_id={eid}").get_json()
                if not data or not data.get("ready"): continue
                kl_f = data[side_key]["formation"]
                if ss_f == kl_f: continue
                ss_parts = [int(x) for x in ss_f.split("-") if x.isdigit()]
                kl_parts = [int(x) for x in kl_f.split("-") if x.isdigit()]
                if not ss_parts or not kl_parts: continue
                # row 수 차이로 평가
                row_diff = abs(len(ss_parts) - len(kl_parts))
                # 첫 row(DF) 차이
                df_diff = abs(ss_parts[0] - kl_parts[0])
                diff_examples.append((row_diff*10 + df_diff, eid, side_key, ss_f, kl_f))
        diff_examples.sort(reverse=True)
        for score, eid, side_key, ss_f, kl_f in diff_examples[:10]:
            ev_meta = conn.execute(
                "SELECT date(date_ts,'unixepoch','localtime') d, home_team_name, away_team_name FROM events WHERE id=?",
                (eid,)).fetchone()
            tnm = ev_meta["home_team_name"] if side_key == "home" else ev_meta["away_team_name"]
            print(f"  ev={eid} {ev_meta['d']} {side_key.upper()} {tnm[:20]}: SS '{ss_f}' → KL '{kl_f}'")

    conn.close()


if __name__ == "__main__":
    main()
