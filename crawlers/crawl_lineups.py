#!/usr/bin/env python3
"""
SofaScore K리그 경기별 라인업(포메이션 + 출전 선수) 수집기.

- 대상: events 테이블에 저장된 K1/K2 경기 (tournament_id in 410, 777) 중
        이미 종료된 경기 (home_score IS NOT NULL)
- 저장: match_lineups (event_id, player_id PK)
- 증분: 이미 라인업이 저장된 event_id는 스킵.
  * --force: 강제 재수집
  * --event-id N: 단일 이벤트 강제 수집
  * --days N: 최근 N일 이내 경기만 대상
"""

import argparse
import asyncio
import json
import sqlite3
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = str(BASE_DIR / "players.db")
DELAY = 0.4
TARGET_TOURNAMENTS = (410, 777)


def init_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS match_lineups (
            event_id       INTEGER NOT NULL,
            team_id        INTEGER NOT NULL,
            is_home        INTEGER NOT NULL,
            formation      TEXT,
            player_id      INTEGER NOT NULL,
            player_name    TEXT,
            shirt_number   INTEGER,
            position       TEXT,
            is_starter     INTEGER NOT NULL,
            slot_order     INTEGER,
            confirmed      INTEGER,
            PRIMARY KEY (event_id, player_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mlu_event ON match_lineups(event_id);
        CREATE INDEX IF NOT EXISTS idx_mlu_team ON match_lineups(team_id);
    """)
    conn.commit()


async def api_fetch(page, path, retries=1):
    for attempt in range(retries + 1):
        try:
            return await page.evaluate(f"""() =>
                fetch('{path}').then(r => r.ok ? r.json() : {{_status: r.status}}).catch(e => ({{_error: String(e)}}))
            """)
        except Exception as e:
            if attempt >= retries:
                return {"_error": str(e)}
            try:
                await page.goto(
                    "https://www.sofascore.com/tournament/football/south-korea/k-league-1/410",
                    wait_until="domcontentloaded", timeout=60000,
                )
                await asyncio.sleep(1.5)
            except Exception:
                pass


def parse_side(event_id, side_block, is_home, existing_team_id):
    """SofaScore lineup 응답의 home/away 블록을 DB 행 리스트로 변환."""
    if not isinstance(side_block, dict):
        return []
    formation = side_block.get("formation") or None
    raw_players = side_block.get("players") or []
    starters = [p for p in raw_players if not p.get("substitute")]
    subs = [p for p in raw_players if p.get("substitute")]

    rows = []
    for idx, entry in enumerate(starters):
        player = entry.get("player") or {}
        pid = player.get("id")
        if pid is None:
            continue
        rows.append({
            "event_id":     event_id,
            "team_id":      entry.get("teamId") or existing_team_id,
            "is_home":      1 if is_home else 0,
            "formation":    formation,
            "player_id":    pid,
            "player_name":  player.get("name"),
            "shirt_number": entry.get("shirtNumber"),
            "position":     entry.get("position") or player.get("position"),
            "is_starter":   1,
            "slot_order":   idx,
        })
    for entry in subs:
        player = entry.get("player") or {}
        pid = player.get("id")
        if pid is None:
            continue
        rows.append({
            "event_id":     event_id,
            "team_id":      entry.get("teamId") or existing_team_id,
            "is_home":      1 if is_home else 0,
            "formation":    formation,
            "player_id":    pid,
            "player_name":  player.get("name"),
            "shirt_number": entry.get("shirtNumber"),
            "position":     entry.get("position") or player.get("position"),
            "is_starter":   0,
            "slot_order":   None,
        })
    return rows


def save_rows(conn, rows, confirmed):
    if not rows:
        return
    conn.executemany("""
        INSERT OR REPLACE INTO match_lineups
            (event_id, team_id, is_home, formation, player_id, player_name,
             shirt_number, position, is_starter, slot_order, confirmed)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
    """, [(r["event_id"], r["team_id"], r["is_home"], r["formation"],
           r["player_id"], r["player_name"], r["shirt_number"],
           r["position"], r["is_starter"], r["slot_order"],
           1 if confirmed else 0) for r in rows])
    conn.commit()


def target_events(conn, force=False, event_id=None, days=None):
    """수집 대상 event 리스트."""
    cur = conn.cursor()
    if event_id:
        cur.execute("""SELECT id, home_team_id, away_team_id, date_ts
                       FROM events WHERE id = ?""", (event_id,))
        return cur.fetchall()

    # 경기 결과(score)가 들어왔거나 이미 경기 시작 시각이 지난 매치를 대상으로 한다.
    # score만 보면 sync_results_to_events.py가 score를 채우기 전까지 라인업이 영영 안 들어오는
    # 사고가 발생한다(2026-05-19 5/16~17 14경기 누락 사건). date_ts 조건을 OR로 묶어 자가복구.
    where = [
        "tournament_id IN ({})".format(",".join("?" * len(TARGET_TOURNAMENTS))),
        "(home_score IS NOT NULL OR date_ts <= ?)",
    ]
    params = list(TARGET_TOURNAMENTS) + [int(time.time())]
    if days is not None:
        cutoff = int(time.time()) - days * 86400
        where.append("date_ts >= ?")
        params.append(cutoff)
    sql = f"SELECT id, home_team_id, away_team_id, date_ts FROM events WHERE {' AND '.join(where)} ORDER BY date_ts DESC"
    cur.execute(sql, params)
    events = cur.fetchall()

    if force:
        return events

    # 이미 수집된 event 제외
    done = {r[0] for r in conn.execute("SELECT DISTINCT event_id FROM match_lineups").fetchall()}
    return [e for e in events if e[0] not in done]


async def collect(force=False, event_id=None, days=None, limit=None):
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    events = target_events(conn, force=force, event_id=event_id, days=days)
    if limit:
        events = events[:limit]

    if not events:
        log("수집 대상 경기가 없습니다.")
        conn.close()
        return

    log(f"수집 대상: {len(events)}경기")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            extra_http_headers={
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://www.sofascore.com/",
            },
        )
        page = await ctx.new_page()
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-1/410",
            wait_until="domcontentloaded", timeout=60000,
        )
        await asyncio.sleep(2)

        ok, skip, fail = 0, 0, 0
        for eid, home_tid, away_tid, _ts in events:
            data = await api_fetch(page, f"/api/v1/event/{eid}/lineups")
            if not isinstance(data, dict) or "home" not in data or "away" not in data:
                fail += 1
                log(f"  [{eid}] 라인업 없음 ({data})")
                await asyncio.sleep(DELAY)
                continue

            confirmed = bool(data.get("confirmed"))
            rows = []
            rows.extend(parse_side(eid, data.get("home"), True, home_tid))
            rows.extend(parse_side(eid, data.get("away"), False, away_tid))

            if not rows:
                skip += 1
                log(f"  [{eid}] 선수 목록 비어있음, 스킵")
            else:
                # 기존 행 삭제 후 저장 (force 또는 재수집 시)
                conn.execute("DELETE FROM match_lineups WHERE event_id = ?", (eid,))
                save_rows(conn, rows, confirmed)
                ok += 1
                log(f"  [{eid}] 저장: {len(rows)}명 (confirmed={confirmed})")

            await asyncio.sleep(DELAY)

        await browser.close()

    conn.close()
    log(f"\n완료: ok={ok} skip={skip} fail={fail}")


def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="이미 저장된 경기도 재수집")
    parser.add_argument("--event-id", type=int, default=None, help="단일 이벤트 수집")
    parser.add_argument("--days", type=int, default=None, help="최근 N일 이내 경기만")
    parser.add_argument("--limit", type=int, default=None, help="최대 N경기만")
    args = parser.parse_args()
    asyncio.run(collect(force=args.force, event_id=args.event_id, days=args.days, limit=args.limit))
