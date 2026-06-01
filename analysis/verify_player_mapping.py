"""선수 아이콘 자동 매핑 전수 검증.

match_lineups의 (player_id, team_id, shirt_number) 단위로:
  DB players.name_ko  vs  kleague_players_2026.json[slug].players[#shirt].name
불일치를 리스트로 출력.

읽기 전용. 활성 K1/K2 경기(2026 시즌) 한정.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = Path(__file__).resolve().parent.parent
DB = BASE / "players.db"
PORTAL_JSON = BASE / "data" / "kleague_players_2026.json"
EXCLUDED_EVENT_IDS = (90333089,)  # synthetic event 제외 (main.py 동일)
EXCLUDED_SQL = "(" + ",".join(str(i) for i in EXCLUDED_EVENT_IDS) + ")"

# SofaScore team_id → portal slug (history 5/11 16:10 검증 매핑)
SS_TO_SLUG = {
    7653: "ulsan", 7650: "pohang", 7649: "jeju", 6908: "jeonbuk", 7646: "fcseoul",
    7645: "daejeon", 7648: "incheon", 34220: "gangwon", 48912: "gwangju", 92539: "bucheon",
    32675: "anyang", 7647: "gimcheon", 7652: "suwon", 7642: "busan", 7643: "jeonnam",
    7651: "seongnam", 7644: "daegu", 7641: "gyeongnam", 41261: "suwon_fc",
    189422: "seouland", 248375: "ansan", 339827: "asan", 195172: "gimpo",
    314293: "cheongju", 41263: "cheonan", 195174: "hwaseong", 314294: "paju",
    41260: "gimhae", 41266: "yongin",
}


def main():
    portal = json.loads(PORTAL_JSON.read_text(encoding="utf-8"))
    # slug → {shirt_number → portal_name}
    portal_idx = {}
    for slug, td in portal.items():
        m = {}
        for p in td.get("players", []):
            n = p.get("number")
            if n is None:
                continue
            m[int(n)] = p.get("name", "")
        portal_idx[slug] = m

    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row

    # 최근 출전한 player_id 단위로 best shirt + DB name_ko + team
    # (전 시즌 = 2026, K1/K2 경기 한정)
    rows = conn.execute(f"""
        WITH appearances AS (
            SELECT ml.player_id,
                   ml.shirt_number,
                   CASE WHEN ml.is_home=1 THEN e.home_team_id ELSE e.away_team_id END AS ss_team_id,
                   COUNT(*) AS cnt
            FROM match_lineups ml
            JOIN events e ON e.id=ml.event_id
            WHERE e.tournament_id IN (410, 777)
              AND e.id NOT IN {EXCLUDED_SQL}
              AND date(e.date_ts, 'unixepoch', 'localtime') >= '2026-01-01'
              AND ml.shirt_number IS NOT NULL
            GROUP BY ml.player_id, ml.shirt_number, ss_team_id
        ),
        best_per_player AS (
            SELECT player_id, shirt_number, ss_team_id, cnt,
                   ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY cnt DESC) AS rn
            FROM appearances
        )
        SELECT p.id AS pid, p.name AS sofa_name, p.name_ko, p.team_id AS db_team_id,
               b.ss_team_id AS lineup_team_id, b.shirt_number, b.cnt AS games
        FROM best_per_player b
        JOIN players p ON p.id = b.player_id
        WHERE b.rn = 1
    """).fetchall()

    mismatches = []      # name_ko vs portal mismatch
    no_portal_entry = [] # name_ko 있는데 portal에 해당 #shirt 없는 경우
    untracked = 0        # K3 또는 SS_TO_SLUG에 없는 팀
    matched = 0

    for r in rows:
        ss_team = r["lineup_team_id"]
        slug = SS_TO_SLUG.get(ss_team)
        if not slug:
            untracked += 1
            continue
        shirt = r["shirt_number"]
        if shirt is None:
            continue
        portal_team = portal_idx.get(slug, {})
        portal_name = portal_team.get(int(shirt))
        db_ko = r["name_ko"] or ""
        if not portal_name:
            if db_ko:  # portal에 등번호 entry 없음 — 백필 자료 부족
                no_portal_entry.append((r["pid"], r["sofa_name"], db_ko, slug, shirt, r["games"]))
            continue
        if db_ko != portal_name:
            mismatches.append((r["pid"], r["sofa_name"], db_ko, portal_name, slug, shirt, r["games"]))
        else:
            matched += 1

    print("=== 매핑 검증 (출전 player_id 기준) ===")
    print(f"  매칭 OK:          {matched}")
    print(f"  name_ko ≠ portal: {len(mismatches)}")
    print(f"  portal에 #shirt 없음 (DB name_ko 있음): {len(no_portal_entry)}")
    print(f"  SS_TO_SLUG 미등록 팀(K3·임대): {untracked}")
    total = matched + len(mismatches) + len(no_portal_entry) + untracked
    print(f"  합계: {total}")

    if mismatches:
        print("\n=== 불일치 상위 30 (출전수 내림차순) ===")
        mismatches.sort(key=lambda x: -x[6])
        print(f"{'pid':>7} | {'sofa name':<24} | {'DB name_ko':<12} | {'portal name':<12} | {'team':<10} #{'shirt':<3} {'games':>4}")
        print("-" * 100)
        for pid, sofa, db_ko, portal_name, slug, shirt, games in mismatches[:30]:
            print(f"{pid:>7} | {sofa[:24]:<24} | {db_ko[:12]:<12} | {portal_name[:12]:<12} | {slug:<10} #{str(shirt):<3} {games:>4}")

    if no_portal_entry:
        print("\n=== portal #shirt 누락 상위 10 (DB에 name_ko 있어서 문제 없음 가능) ===")
        no_portal_entry.sort(key=lambda x: -x[5])
        for pid, sofa, db_ko, slug, shirt, games in no_portal_entry[:10]:
            print(f"  pid={pid} sofa={sofa[:24]:<24} db_ko={db_ko:<10} {slug} #{shirt} games={games}")

    conn.close()


if __name__ == "__main__":
    main()
