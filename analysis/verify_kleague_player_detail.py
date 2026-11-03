"""K리그 공식 선수 상세(getMatchRecordPlayerDetail) ↔ SofaScore match_player_stats 대조 (읽기 전용).

목적(공식 데이터 전환 1단계 검증, 2026-11-03):
  ① 출전분(minutePlay vs minutes_played) 불일치 원인
  ② 항목별 일치율 (표본 확대: 시즌×리그 층화)
  ③ 선수 단위 공식 xG(expectedGoal)·슈팅이 빗나간 슛까지 포함하는지
  ④ 과거 시즌(2023~) 응답 존재 여부

선수 매칭: 공식 선수 ID(kleague_pass_player) → 이름 → kleague_lineup(등번호·선발) → mps(등번호 + 홈/원정).
DB에는 쓰지 않는다. 원본 응답은 --out JSONL 로 저장.

사용: python analysis/verify_kleague_player_detail.py --per-bucket 5 --out <파일.jsonl>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "crawlers"))
from collect_kleague_passes import post_multipart  # noqa: E402  (공식 API multipart 호출 재사용)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DELAY = 0.4
CUTOFF = "2026-08-01"   # SofaScore 차단 전 경기만 (대조 기준 확보)

SAMPLE_SQL = """
SELECT e.id, e.tournament_id, m.year, m.game_id, m.meet_seq, s.home_kid, s.away_kid, e.home_team_id, e.away_team_id
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
JOIN kleague_schedule s ON s.year = m.year AND s.league_id = m.league_id AND s.game_id = m.game_id AND s.meet_seq = m.meet_seq
WHERE e.tournament_id = ? AND m.year = ? AND e.home_score IS NOT NULL
  AND e.date_ts < strftime('%s', ?)
  AND EXISTS (SELECT 1 FROM kleague_pass_player p WHERE p.event_id = e.id)
  AND (SELECT COUNT(*) FROM match_player_stats x WHERE x.event_id = e.id AND x.rating IS NOT NULL) >= 22
ORDER BY (e.id * 2654435761) % 1000003     -- 결정적 의사 무작위(재현 가능)
LIMIT ?
"""


def norm(s: str) -> str:
    return re.sub(r"\(c\)|\s", "", s or "")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-bucket", type=int, default=5, help="시즌×리그 버킷당 경기 수")
    ap.add_argument("--years", default="2023,2024,2025,2026")
    ap.add_argument("--out", required=True)
    ap.add_argument("--db", default=os.path.join(ROOT, "players.db"))
    args = ap.parse_args()

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)   # 읽기 전용 열기
    conn.row_factory = sqlite3.Row
    games = []
    for y in args.years.split(","):
        for tid in (410, 777):
            games += conn.execute(SAMPLE_SQL, (tid, int(y), CUTOFF, args.per_bucket)).fetchall()
    print(f"표본 {len(games)}경기", flush=True)

    calls = ok = empty = 0
    with open(args.out, "w", encoding="utf-8") as fo:
        for gi, g in enumerate(games):
            for side, kid_team, ss_team in (("home", g["home_kid"], g["home_team_id"]), ("away", g["away_kid"], g["away_team_id"])):
                lineup = {norm(r["player_name"]): (r["back_no"], r["is_starter"]) for r in conn.execute(
                    "SELECT player_name, back_no, is_starter FROM kleague_lineup WHERE sofa_event_id=? AND side=?", (g["id"], side))}
                mps = {r["shirt_number"]: dict(r) for r in conn.execute(
                    """SELECT shirt_number, player_id, minutes_played, rating, goals, assists, total_shots, shots_on_target,
                              expected_goals, total_passes, accurate_passes, key_passes, total_crosses, accurate_crosses,
                              aerial_won, aerial_lost, duel_won, duel_lost, attempted_dribbles, successful_dribbles,
                              tackles, interceptions, ball_recovery, fouls, was_fouled, saves, clearances, blocked_shots,
                              total_long_balls, accurate_long_balls, touches, possession_lost
                       FROM match_player_stats WHERE event_id=? AND is_home=?""", (g["id"], 1 if side == "home" else 0))}
                for p in conn.execute("SELECT player_kid, player_name FROM kleague_pass_player WHERE event_id=? AND team_id=?",
                                      (g["id"], ss_team)):
                    d, err = post_multipart("getMatchRecordPlayerDetail.do", {
                        "MEET_YEAR": g["year"], "MEET_SEQ": g["meet_seq"], "GAME_ID": g["game_id"],
                        "TEAM_ID": kid_team, "PLAYER_ID": p["player_kid"]})
                    time.sleep(DELAY)
                    calls += 1
                    det = (d or {}).get("playerDetail") or {}
                    if det:
                        ok += 1
                    else:
                        empty += 1
                    lu = lineup.get(norm(p["player_name"]))
                    back = None
                    try:
                        back = int(det.get("backNo")) if det.get("backNo") not in (None, "") else (lu[0] if lu else None)
                    except ValueError:
                        back = lu[0] if lu else None
                    fo.write(json.dumps({
                        "event_id": g["id"], "tid": g["tournament_id"], "year": g["year"], "side": side,
                        "kid": p["player_kid"], "name": p["player_name"], "back_no": back,
                        "starter": (lu[1] if lu else None), "err": err, "official": det,
                        "sofa": mps.get(back)}, ensure_ascii=False) + "\n")
            print(f"  [{gi + 1}/{len(games)}] {g['year']} {'K1' if g['tournament_id'] == 410 else 'K2'} ev={g['id']} "
                  f"누적 호출 {calls} (응답 {ok}, 빈 응답 {empty})", flush=True)
    conn.close()
    print(f"완료: 호출 {calls}, 응답 {ok}, 빈 응답 {empty} → {args.out}", flush=True)


if __name__ == "__main__":
    main()
