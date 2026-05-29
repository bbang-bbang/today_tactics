#!/usr/bin/env python3
"""
K1 match_shotmap.xg 백필 — 저장된 shot 컬럼(x/y/situation/body_part/outcome)으로
샷 단위 xG를 로컬 추정해 match_shotmap.xg 를 채운다. (재크롤링 불필요)

배경:
- SofaScore 원천에 K1 xG 없음 (K2는 있음). 기존 build_k1_xg.py 는 추정 xG 를
  match_player_stats.expected_goals 에만 기록 → 세트피스 카드가 읽는
  match_shotmap.xg (샷 단위) 는 여전히 NULL 이었다.
- match_shotmap 에 이미 x/y/situation/body_part/outcome 가 SofaScore 원본 그대로
  저장돼 있어 (fetch_match_extras.py), estimate_xg 입력을 모두 충족한다.

모델: build_k1_xg.estimate_xg 와 동일 공식 (mps.expected_goals 와 정합성 유지).
  ※ 모델 변경 시 두 파일을 함께 수정할 것.

기본은 K1(tid=410), xg IS NULL 인 샷만 갱신 (기존 값 보존).
K2는 SofaScore 실측 xG 가 권위이므로 대상 아님 (--league K2 강제 시에도 NULL만).
"""

import argparse
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "players.db")


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def estimate_xg(situation, body_part, outcome, x, y):
    """build_k1_xg.estimate_xg 의 컬럼 입력판. 반환 0.0~0.95."""
    # 페널티
    if situation == "penalty":
        return 0.78
    # 직접 프리킥
    if situation == "free-kick":
        return 0.05

    x = x if x is not None else 50.0
    y = y if y is not None else 50.0

    # 거리: x가 작을수록 골대 근접 (SofaScore 공격 방향)
    dist = x
    if dist < 6:
        base = 0.40
    elif dist < 12:
        base = 0.22
    elif dist < 18:
        base = 0.10
    elif dist < 25:
        base = 0.05
    elif dist < 35:
        base = 0.025
    else:
        base = 0.01

    # 각도 (y=50 중앙=최대, 사이드=최소)
    angle_factor = max(0.2, 1 - abs(y - 50) / 50)
    xg = base * angle_factor

    if body_part == "head":
        xg *= 0.6

    if situation == "fast-break":
        xg *= 1.3
    elif situation == "set-piece":
        xg *= 0.9

    # 실제 goal 이었다면 최소 0.08 (완전 저평가 방지)
    if outcome == "goal" and xg < 0.08:
        xg = 0.08

    return round(min(0.95, max(0.0, xg)), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", choices=["K1", "K2"], default="K1")
    ap.add_argument("--dry-run", action="store_true", help="갱신 없이 통계만 출력")
    args = ap.parse_args()

    tid = 410 if args.league == "K1" else 777
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute(
        """SELECT s.event_id, s.shot_id, s.situation, s.body_part, s.outcome, s.x, s.y
           FROM match_shotmap s JOIN events e ON s.event_id = e.id
           WHERE e.tournament_id = ? AND s.xg IS NULL""",
        (tid,),
    )
    rows = cur.fetchall()
    log(f"[{args.league}] xg NULL 대상 샷: {len(rows)}")
    if not rows:
        conn.close()
        return

    updates = []
    xg_sum = 0.0
    goals = 0
    for event_id, shot_id, situation, body_part, outcome, x, y in rows:
        xg = estimate_xg(situation, body_part, outcome, x, y)
        updates.append((xg, event_id, shot_id))
        xg_sum += xg
        if outcome == "goal":
            goals += 1

    ratio = xg_sum / max(1, goals)
    log(f"  추정 xG 합계 {xg_sum:.1f} / 실제 골 {goals} = 비율 {ratio:.2f} (이상적 ~1.0 근처)")

    if args.dry_run:
        log("  [dry-run] 갱신 생략")
        conn.close()
        return

    cur.executemany(
        "UPDATE match_shotmap SET xg = ? WHERE event_id = ? AND shot_id = ?",
        updates,
    )
    conn.commit()
    log(f"  match_shotmap.xg 갱신: {cur.rowcount if cur.rowcount >= 0 else len(updates)} rows")
    conn.close()
    log("완료")


if __name__ == "__main__":
    main()
