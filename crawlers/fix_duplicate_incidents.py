#!/usr/bin/env python3
"""goal_events / sub_events / card_events 중복 정리 (1회성, 2026-11-02).

원인: collect_goal_incidents.py 일반 모드가 '카드 0장 경기' 등을 매 실행 재수집하면서, SofaScore가
경기 후 시각을 1분씩 정정하면(82'→81') UNIQUE 키가 달라져 같은 기록이 다시 쌓였다(수집기는 같은 날 수정).

판정(보수적 — 정상 기록은 남는다):
  - 교체: 같은 경기·팀·IN 선수·OUT 선수 쌍이 시각 3분 이내로 2번 → 물리적으로 불가능한 중복.
  - 카드: 같은 경기·선수·같은 카드 종류가 시각 2분 이내로 2번 → 중복(두 번째 경고는 yellowRed로 기록됨).
  - 득점: 같은 경기·팀·선수가 시각 2분 이내로 2번이고, **그 경기 득점 수 > 최종 스코어**일 때만
          (2분 내 멀티골은 실제로 있으므로 스코어 초과가 확인된 경기로 한정).
  - 각 쌍에서 **오래된 행(id 작은 쪽)을 삭제** — 나중 행이 SofaScore의 정정된 시각.
  - 정리 후 득점 수가 스코어를 여전히 초과하면 그 경기는 보고만 한다.

사용:
  python crawlers/fix_duplicate_incidents.py           # dry-run (삭제 대상만 출력)
  python crawlers/fix_duplicate_incidents.py --apply   # 삭제 (단일 트랜잭션)
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = str(Path(__file__).resolve().parent.parent / "players.db")

SUB_DUPS = """
SELECT a.id, a.event_id, a.minute, b.minute, a.player_in_name, a.player_out_name
FROM sub_events a JOIN sub_events b
  ON a.event_id = b.event_id AND a.team_id = b.team_id
 AND a.player_in_id = b.player_in_id
 AND a.id < b.id AND ABS(a.minute - b.minute) <= 3
WHERE a.player_in_id IS NOT NULL
"""
# IN 선수만으로 판정: 한 선수는 한 경기에 한 번만 투입된다. SofaScore가 같은 시각 교체의 IN/OUT 짝을
# 바꿔 다시 매기거나(87' A↔B) OUT 선수 ID를 바꾸는(선수 ID 재매핑) 경우까지 잡는다.

CARD_DUPS = """
SELECT a.id, a.event_id, a.minute, b.minute, a.player_name, a.card_type
FROM card_events a JOIN card_events b
  ON a.event_id = b.event_id AND a.player_id = b.player_id AND a.card_type = b.card_type
 AND a.id < b.id AND ABS(a.minute - b.minute) <= 2
WHERE a.player_id IS NOT NULL
"""

GOAL_DUPS = """
SELECT a.id, a.event_id, a.minute, b.minute, a.player_name, a.team_id
FROM goal_events a JOIN goal_events b
  ON a.event_id = b.event_id AND a.team_id = b.team_id AND a.player_id = b.player_id
 AND a.id < b.id AND ABS(a.minute - b.minute) <= 2
JOIN events e ON e.id = a.event_id
WHERE a.player_id IS NOT NULL
  AND e.home_score IS NOT NULL
  AND (SELECT COUNT(*) FROM goal_events g WHERE g.event_id = a.event_id) > e.home_score + e.away_score
"""

OVER_SCORE = """
SELECT e.id, e.home_score + e.away_score, (SELECT COUNT(*) FROM goal_events g WHERE g.event_id = e.id)
FROM events e WHERE e.home_score IS NOT NULL
  AND (SELECT COUNT(*) FROM goal_events g WHERE g.event_id = e.id) > e.home_score + e.away_score
"""


def main() -> None:
    ap = argparse.ArgumentParser(description="득점·교체·카드 중복 정리 (기본 dry-run)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    plan = []
    for table, sql in (("sub_events", SUB_DUPS), ("card_events", CARD_DUPS), ("goal_events", GOAL_DUPS)):
        rows = conn.execute(sql).fetchall()
        ids = sorted({r[0] for r in rows})
        print(f"[{table}] 삭제 대상 {len(ids)}행 / {len({r[1] for r in rows})}경기")
        for r in rows:
            print(f"    id={r[0]} event={r[1]} {r[2]}'→{r[3]}' {r[4]} / {r[5]}")
        plan.append((table, ids))

    if args.apply:
        with conn:   # 단일 트랜잭션
            for table, ids in plan:
                conn.executemany(f"DELETE FROM {table} WHERE id = ?", [(i,) for i in ids])  # table은 상수 3개 중 하나
        print("삭제 완료")
    else:
        print("(dry-run: 삭제 안 함)")

    left = conn.execute(OVER_SCORE).fetchall()
    print(f"득점 수 > 스코어 경기 {'(정리 후)' if args.apply else '(현재)'}: {len(left)}" + (f" {left}" if left else ""))
    conn.close()


if __name__ == "__main__":
    main()
