# -*- coding: utf-8 -*-
"""events 스코어 정합 교정 — K리그 공식 결과 JSON 기준.

배경(2026-06-15): SofaScore 크롤 단계에서 일부 경기의 events.home_score/away_score가
좌우 반전된 채 유입됐고, sync_results_to_events.py는 'score 있으면 SKIP'이라 못 고침.
슛맵/골기록(SofaScore)·외부 뉴스로 교차검증한 결과 K리그 공식 JSON이 정답.

이 스크립트는 events를 공식 JSON과 대조해 **불일치 경기만** 스코어를 JSON 값으로 교정한다.
멱등(재실행 시 0건). 단일 트랜잭션. 로컬·운영 DB 양쪽에서 안전하게 실행 가능.
"""
import os
import sys
import json
import sqlite3

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, "crawlers"))
import sync_results_to_events as S   # SLUG_META, date_to_ts, DB_PATH, RESULTS_FILE 재사용


def authoritative_games():
    """공식 JSON에서 home 관점 고유 경기 → {(date, home_slug, away_slug): (hs, as_)}"""
    with open(S.RESULTS_FILE, encoding="utf-8") as f:
        data = json.load(f)
    games = {}
    for slug, matches in data.items():
        for m in matches:
            if not m.get("home"):          # home 관점만(절대 home-away 스코어)
                continue
            opp = m.get("opponent")
            dt = m.get("date")
            if not opp or not dt:
                continue
            try:
                hs, as_ = (int(x) for x in m.get("score", "").split("-"))
            except (ValueError, AttributeError):
                continue
            games[(dt, slug, opp)] = (hs, as_)
    return games


def main(apply=False):
    games = authoritative_games()
    conn = sqlite3.connect(S.DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    fixes = []
    for (dt, h, a), (hs, as_) in games.items():
        if h not in S.SLUG_META or a not in S.SLUG_META:
            continue
        hid, aid = S.SLUG_META[h][0], S.SLUG_META[a][0]
        ts = S.date_to_ts(dt)
        row = cur.execute(
            "SELECT id, home_score, away_score FROM events "
            "WHERE home_team_id=? AND away_team_id=? AND date_ts BETWEEN ? AND ?",
            (hid, aid, ts - 43200, ts + 43200)
        ).fetchone()
        if not row or row["home_score"] is None:
            continue
        if row["home_score"] != hs or row["away_score"] != as_:
            fixes.append((row["id"], dt, h, a, row["home_score"], row["away_score"], hs, as_))

    print(f"[fix_swapped_scores] 공식 JSON 대조 → 불일치 {len(fixes)}건")
    for eid, dt, h, a, dhs, das, jhs, jas in fixes:
        print(f"  event {eid} {dt} {h} vs {a}: db {dhs}-{das} -> json {jhs}-{jas}")

    if apply and fixes:
        for eid, dt, h, a, dhs, das, jhs, jas in fixes:
            cur.execute("UPDATE events SET home_score=?, away_score=? WHERE id=?", (jhs, jas, eid))
        conn.commit()
        print(f"[fix_swapped_scores] {len(fixes)}건 교정 완료(commit).")
    elif not apply:
        print("[fix_swapped_scores] DRY-RUN (적용하려면 --apply)")
    conn.close()
    return len(fixes)


if __name__ == "__main__":
    main(apply="--apply" in sys.argv)
