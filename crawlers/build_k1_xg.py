#!/usr/bin/env python3
"""
K1 자체 xG 모델 — SofaScore shotmap 기반 lookup 테이블로 shot별 xG 추정 후
선수-경기별 aggregate → match_player_stats.expected_goals 업데이트.

SofaScore 원천에 K1 xG가 없어 (K2는 있음) K1 예측 모델 열세. 이 스크립트로 K1 자체 xG 확보.

모델:
- base xG by distance (SofaScore 좌표 x = 공격 방향 골까지 % 추정)
- angle factor (y=50 중앙=1.0, sideline=0.2)
- bodyPart (head ×0.6)
- situation (fast-break ×1.3, set-piece ×0.9, free-kick 직접 0.05 고정)
- penalty 0.78 고정
- goal은 xG 최소 0.1 guard (완전 저평가 방지)

실제 ML 모델(Understat) 수준은 아니지만 distance+angle+body+situation 커버로 충분히 유용.
"""

import argparse
import asyncio
import os
import sqlite3
import sys
from collections import defaultdict
from playwright.async_api import async_playwright

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, "players.db")
DELAY    = 0.3


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def estimate_xg(shot):
    """
    단일 shot dict → 추정 xG (0~0.95).
    SofaScore playerCoordinates: x는 0~100 (attacking 방향 % — 작을수록 골대에 가까움 추정).
    실제 SofaScore 좌표 해석은 공격 방향 기준이라 x가 작을수록 골대 근접.
    """
    situation = shot.get("situation", "regular")
    body_part = shot.get("bodyPart", "right-foot")
    shot_type = shot.get("shotType", "miss")
    goal_type = shot.get("goalType")

    # 페널티
    if situation == "penalty" or goal_type == "penalty":
        return 0.78

    # 자책골 → 공격 입장 xG 아님
    if goal_type == "own":
        return 0.0

    # 직접 프리킥
    if situation == "free-kick":
        return 0.05

    pc = shot.get("playerCoordinates") or {}
    x = pc.get("x", 50)
    y = pc.get("y", 50)

    # 거리: x가 작을수록 골대 근접 (SofaScore 공격 방향)
    # x=0~100 스케일. 골라인 근처는 x=0~15, 페널티박스는 x=15~25, 박스 밖은 x>25
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

    # 각도 (y=50 중앙=최대, 0 또는 100 사이드=최소)
    y_off = abs(y - 50)
    angle_factor = max(0.2, 1 - y_off / 50)

    xg = base * angle_factor

    if body_part == "head":
        xg *= 0.6

    if situation == "fast-break":
        xg *= 1.3
    elif situation == "set-piece":
        xg *= 0.9

    # 실제 goal이었다면 최소 0.08 (완전 저평가 방지)
    if shot_type == "goal" and xg < 0.08:
        xg = 0.08

    return round(min(0.95, max(0.0, xg)), 3)


async def api_fetch(page, path):
    try:
        return await page.evaluate(f"""async()=>{{
            const r = await fetch('{path}');
            return r.ok ? r.json() : null;
        }}""")
    except Exception:
        return None


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["K1", "K2"], default="K1")
    parser.add_argument("--force", action="store_true",
                        help="SofaScore 원천 xG 있어도 덮어쓰기 (K2는 false 권장)")
    args = parser.parse_args()

    tid_filter = 410 if args.league == "K1" else 777
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # 타깃: 종료 경기 중 mps에 xG 없는 경기
    xg_filter = "" if args.force else """
        AND EXISTS (SELECT 1 FROM match_player_stats mps
                    WHERE mps.event_id=e.id AND mps.expected_goals IS NULL)
    """
    cur.execute(f"""
        SELECT e.id FROM events e
        WHERE e.tournament_id=? AND e.home_score IS NOT NULL
          {xg_filter}
        ORDER BY e.date_ts DESC
    """, (tid_filter,))
    target_events = [r[0] for r in cur.fetchall()]
    log(f"[{args.league}] xG 추정 대상: {len(target_events)}경기")

    if not target_events:
        return

    session_url = "https://www.sofascore.com/tournament/football/south-korea/k-league-1/410" \
        if args.league == "K1" else "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777"

    stats = {"ok": 0, "skip_no_shot": 0, "updated_rows": 0, "total_xg_sum": 0.0, "total_goals": 0}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await ctx.new_page()
        await page.goto(session_url, wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)
        log("세션 준비 완료")

        for i, eid in enumerate(target_events):
            data = await api_fetch(page, f"/api/v1/event/{eid}/shotmap")
            if not isinstance(data, dict) or not data.get("shotmap"):
                stats["skip_no_shot"] += 1
                await asyncio.sleep(DELAY)
                continue

            # 선수별 xG 합산
            xg_by_player = defaultdict(float)
            for shot in data["shotmap"]:
                p = shot.get("player") or {}
                pid = p.get("id")
                if not pid:
                    continue
                xg = estimate_xg(shot)
                xg_by_player[pid] += xg
                if shot.get("shotType") == "goal":
                    stats["total_goals"] += 1

            # mps 업데이트
            for pid, xg_sum in xg_by_player.items():
                xg_rounded = round(xg_sum, 3)
                cur.execute("""
                    UPDATE match_player_stats
                    SET expected_goals = ?
                    WHERE event_id = ? AND player_id = ?
                """, (xg_rounded, eid, pid))
                stats["updated_rows"] += cur.rowcount
                stats["total_xg_sum"] += xg_rounded

            conn.commit()
            stats["ok"] += 1

            if (i+1) % 30 == 0:
                log(f"  [{i+1}/{len(target_events)}] updated_rows={stats['updated_rows']} "
                    f"avg_xg/goal={stats['total_xg_sum']/max(1,stats['total_goals']):.3f}")

            await asyncio.sleep(DELAY)

        await browser.close()

    conn.close()
    log("\n완료:")
    log(f"  처리: {stats['ok']}경기 / 스킵(shotmap 없음): {stats['skip_no_shot']}")
    log(f"  mps xG 업데이트: {stats['updated_rows']} rows")
    log(f"  xG 합계 / 실제 골: {stats['total_xg_sum']:.1f} / {stats['total_goals']} "
        f"= 비율 {stats['total_xg_sum']/max(1,stats['total_goals']):.2f} (이상적 ~1.0 근처)")


if __name__ == "__main__":
    asyncio.run(main())
