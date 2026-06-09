#!/usr/bin/env python3
"""
match_player_stats 수비 세부 지표 백필 — raw_json에서 추출 (외부 API 불필요).

추가 컬럼 3종 (SofaScore statistics 원본 키 → 컬럼):
  wonTackle      -> won_tackle      (성공 태클)
  ballRecovery   -> ball_recovery   (볼 회수)
  challengeLost  -> challenge_lost  (피드리블 = 제쳐진 횟수)

수비P 정밀도 향상을 위해 도입. ALTER TABLE은 멱등(이미 있으면 skip),
UPDATE는 raw_json이 있는 행만 대상. 로컬/운영 DB 각각 1회 실행.

사용:  python crawlers/backfill_duel_detail.py
"""

import json
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, "players.db")

NEW_COLS = ["won_tackle", "ball_recovery", "challenge_lost"]
KEY_MAP  = {                       # 컬럼 -> raw_json(statistics) 키
    "won_tackle":     "wonTackle",
    "ball_recovery":  "ballRecovery",
    "challenge_lost": "challengeLost",
}


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def ensure_columns(conn):
    existing = {r[1] for r in conn.execute("PRAGMA table_info(match_player_stats)")}
    added = []
    for col in NEW_COLS:
        if col not in existing:
            conn.execute(f"ALTER TABLE match_player_stats ADD COLUMN {col} INTEGER")
            added.append(col)
    if added:
        log(f"컬럼 추가: {', '.join(added)}")
    else:
        log("컬럼 이미 존재 — ALTER skip")
    conn.commit()


def backfill(conn):
    rows = conn.execute(
        "SELECT id, raw_json FROM match_player_stats WHERE raw_json IS NOT NULL AND raw_json != ''"
    ).fetchall()
    log(f"대상 행(raw_json 보유): {len(rows):,}")

    updates = []          # (won_tackle, ball_recovery, challenge_lost, id)
    bad = 0
    for rid, raw in rows:
        try:
            s = json.loads(raw)
        except (ValueError, TypeError):
            bad += 1
            continue
        if not isinstance(s, dict):
            bad += 1
            continue
        updates.append((
            s.get(KEY_MAP["won_tackle"]),
            s.get(KEY_MAP["ball_recovery"]),
            s.get(KEY_MAP["challenge_lost"]),
            rid,
        ))

    conn.executemany(
        "UPDATE match_player_stats SET won_tackle=?, ball_recovery=?, challenge_lost=? WHERE id=?",
        updates,
    )
    conn.commit()

    # 검증 집계
    filled = {}
    for col in NEW_COLS:
        n = conn.execute(
            f"SELECT COUNT(*) FROM match_player_stats WHERE {col} IS NOT NULL"
        ).fetchone()[0]
        filled[col] = n
    log(f"UPDATE 완료: {len(updates):,}행 (json 파싱 실패 {bad})")
    for col in NEW_COLS:
        log(f"  {col}: NOT NULL {filled[col]:,}행")


def main():
    if not os.path.exists(DB_PATH):
        log(f"DB 없음: {DB_PATH}")
        sys.exit(1)
    conn = sqlite3.connect(DB_PATH)
    try:
        ensure_columns(conn)
        backfill(conn)
        log("완료")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
