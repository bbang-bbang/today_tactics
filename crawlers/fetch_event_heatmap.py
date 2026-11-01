#!/usr/bin/env python3
"""
지정된 event_id 목록의 히트맵 수집 (K1/K2 무관).

사용:
  python crawlers/fetch_event_heatmap.py 15372988 15372989 ...
  python crawlers/fetch_event_heatmap.py --days 4   # 최근 N일 종료 경기

후보 선수: match_lineups (starter + 교체 모두 시도).
출전하지 않은 교체 선수는 SofaScore가 빈 응답을 주므로 자연 스킵된다.
"""

import argparse
import asyncio
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from playwright.async_api import async_playwright

import fetch_health   # 차단(403 challenge) 감지 — 조용한 skip 방지

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = str(BASE_DIR / "players.db")
DELAY = 0.35
KST = timezone(timedelta(hours=9))


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


async def api_fetch(page, path, retries=2):
    for attempt in range(retries + 1):
        try:
            return await page.evaluate(f"""() =>
                fetch('{path}')
                .then(r => r.ok ? r.json() : r.status)
                .catch(e => ({{error: e.message}}))
            """)
        except Exception as e:
            if attempt < retries:
                try:
                    await page.goto(
                        "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
                        wait_until="domcontentloaded", timeout=60000
                    )
                    await asyncio.sleep(2)
                except Exception:
                    pass
            else:
                return {"error": str(e)}


def collect_targets(conn, event_ids):
    placeholders = ",".join("?" for _ in event_ids)
    rows = conn.execute(f"""
        SELECT ml.event_id, ml.player_id
        FROM match_lineups ml
        WHERE ml.event_id IN ({placeholders})
          AND NOT EXISTS (
              SELECT 1 FROM heatmap_points hp
              WHERE hp.event_id = ml.event_id AND hp.player_id = ml.player_id
          )
        ORDER BY ml.event_id, ml.is_starter DESC, ml.slot_order
    """, event_ids).fetchall()
    return rows


def resolve_event_ids(conn, args):
    if args.event_ids:
        return [int(x) for x in args.event_ids]
    if args.days:
        cutoff = datetime.now(tz=KST) - timedelta(days=args.days)
        rows = conn.execute("""
            SELECT id FROM events
            WHERE date_ts >= ? AND home_score IS NOT NULL
              AND tournament_id IN (410, 777)
            ORDER BY date_ts
        """, (int(cutoff.timestamp()),)).fetchall()
        return [r[0] for r in rows]
    return []


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("event_ids", nargs="*", help="event_id (생략 시 --days 사용)")
    ap.add_argument("--days", type=int, help="최근 N일 종료 경기 일괄")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    event_ids = resolve_event_ids(conn, args)
    if not event_ids:
        log("대상 event_id 없음 — event_ids 또는 --days 필요")
        return

    targets = collect_targets(conn, event_ids)
    log(f"수집 대상: {len(event_ids)}경기 / {len(targets)}건 (선수×경기)")
    if not targets:
        log("이미 모두 수집됨")
        return

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            extra_http_headers={"Referer": "https://www.sofascore.com/"}
        )
        page = await ctx.new_page()
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
            wait_until="domcontentloaded", timeout=60000
        )
        await asyncio.sleep(3)
        log("세션 준비 완료\n")

        # 같은 엔드포인트로 1건 probe — 403이면 즉시 중단
        await fetch_health.abort_if_blocked(
            page, f"/api/v1/event/{targets[0][0]}/player/{targets[0][1]}/heatmap", log, "heatmap")

        batch = []
        per_event = {}
        for i, (eid, pid) in enumerate(targets):
            hdata = await api_fetch(page, f"/api/v1/event/{eid}/player/{pid}/heatmap")
            n = 0
            if isinstance(hdata, dict):
                pts = hdata.get("heatmap", [])
                if pts:
                    batch.extend([(pid, eid, pt["x"], pt["y"]) for pt in pts])
                    n = len(pts)
            per_event[eid] = per_event.get(eid, 0) + n

            if len(batch) >= 500:
                conn.executemany(
                    "INSERT OR IGNORE INTO heatmap_points (player_id, event_id, x, y) VALUES (?,?,?,?)",
                    batch
                )
                conn.commit()
                batch = []

            if (i + 1) % 20 == 0 or (i + 1) == len(targets):
                now = datetime.now(tz=KST).strftime("%H:%M:%S")
                log(f"  [{now}] {i+1}/{len(targets)}")
            await asyncio.sleep(DELAY)

        if batch:
            conn.executemany(
                "INSERT OR IGNORE INTO heatmap_points (player_id, event_id, x, y) VALUES (?,?,?,?)",
                batch
            )
            conn.commit()

        await browser.close()

    log("\n경기별 수집 결과:")
    for eid in event_ids:
        log(f"  {eid}: {per_event.get(eid, 0)} pts")
    conn.close()
    fetch_health.abort_if_all_failed(sum(1 for v in per_event.values() if v > 0), len(per_event), log, "heatmap")


if __name__ == "__main__":
    asyncio.run(main())
