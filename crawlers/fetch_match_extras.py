#!/usr/bin/env python3
"""
SofaScore /event/{eid}/average-positions + /shotmap 수집기.

테이블 신규:
  match_avg_positions(event_id, player_id, is_home, is_substitute, x, y, PRIMARY KEY(event_id, player_id))
  match_shotmap(event_id, shot_id, player_id, is_home, x, y, target_x, target_y,
                shot_type, body_part, situation, draw_x, draw_y, time, time_seconds,
                outcome, xg, PRIMARY KEY(event_id, shot_id))

옵션:
  --days N        최근 N일 종료 매치만
  --refetch       이미 채워진 매치도 강제 재수집
  --league K1|K2|all (기본 all)
"""

import argparse
import asyncio
import sqlite3
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

import fetch_health   # 차단(403 challenge) 감지 — 조용한 skip 방지

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE = Path(__file__).resolve().parent.parent
DB_PATH = str(BASE / "players.db")
DELAY = 0.35

LEAGUE_TID = {"K1": (410,), "K2": (777,), "all": (410, 777)}


def log(msg):
    print(msg, flush=True)


def init_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS match_avg_positions (
            event_id       INTEGER NOT NULL,
            player_id      INTEGER NOT NULL,
            is_home        INTEGER NOT NULL,
            is_substitute  INTEGER NOT NULL DEFAULT 0,
            x              REAL,
            y              REAL,
            PRIMARY KEY (event_id, player_id)
        );
        CREATE INDEX IF NOT EXISTS idx_avgpos_event ON match_avg_positions(event_id);

        CREATE TABLE IF NOT EXISTS match_shotmap (
            event_id     INTEGER NOT NULL,
            shot_id      INTEGER NOT NULL,
            player_id    INTEGER,
            is_home      INTEGER,
            x            REAL,
            y            REAL,
            target_x     REAL,
            target_y     REAL,
            shot_type    TEXT,
            body_part    TEXT,
            situation    TEXT,
            outcome      TEXT,
            xg           REAL,
            time_min     INTEGER,
            time_sec     INTEGER,
            PRIMARY KEY (event_id, shot_id)
        );
        CREATE INDEX IF NOT EXISTS idx_shotmap_event ON match_shotmap(event_id);
        CREATE INDEX IF NOT EXISTS idx_shotmap_player ON match_shotmap(player_id);
    """)
    conn.commit()


async def api(page, path, retries=2):
    for attempt in range(retries + 1):
        try:
            return await page.evaluate(f"""async () => {{
                const r = await fetch('{path}');
                if (!r.ok) return {{__status: r.status}};
                return await r.json();
            }}""")
        except Exception:
            if attempt < retries:
                try:
                    await page.goto("https://www.sofascore.com",
                                    wait_until="domcontentloaded", timeout=30000)
                    await asyncio.sleep(2)
                except Exception:
                    pass
    return None


def collect_targets(conn, args):
    where_tid = "(" + ",".join(str(t) for t in LEAGUE_TID[args.league]) + ")"
    extras_clause = "" if args.refetch else """
        AND (
            NOT EXISTS (SELECT 1 FROM match_avg_positions WHERE event_id=e.id)
            OR NOT EXISTS (SELECT 1 FROM match_shotmap WHERE event_id=e.id)
        )
    """
    days_clause = ""
    if args.days:
        days_clause = f"AND e.date_ts >= strftime('%s', 'now', '-{args.days} days')"
    rows = conn.execute(f"""
        SELECT e.id FROM events e
        WHERE e.tournament_id IN {where_tid}
          AND e.home_score IS NOT NULL
          {days_clause}
          {extras_clause}
        ORDER BY e.date_ts DESC
    """).fetchall()
    return [r[0] for r in rows]


def save_avg_positions(conn, eid, data):
    if not isinstance(data, dict):
        return 0
    # subs는 is_home을 lineup에서 lookup
    sub_is_home = {
        r[0]: r[1]
        for r in conn.execute(
            "SELECT player_id, is_home FROM match_lineups WHERE event_id=?", (eid,)
        ).fetchall()
    }
    rows = []
    for side, is_home in [("home", 1), ("away", 0)]:
        for ent in (data.get(side) or []):
            pid = (ent.get("player") or {}).get("id")
            if not pid:
                continue
            rows.append((eid, pid, is_home, 0, ent.get("averageX"), ent.get("averageY")))
    for ent in (data.get("substitutions") or []):
        pid = (ent.get("player") or {}).get("id")
        if not pid:
            continue
        rows.append((
            eid, pid,
            sub_is_home.get(pid, 0),  # lineup 기반, 없으면 0
            1,
            ent.get("averageX"), ent.get("averageY"),
        ))
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO match_avg_positions "
            "(event_id, player_id, is_home, is_substitute, x, y) VALUES (?,?,?,?,?,?)",
            rows
        )
    return len(rows)


def save_shotmap(conn, eid, data):
    if not isinstance(data, dict):
        return 0
    arr = data.get("shotmap") or []
    rows = []
    for s in arr:
        sid = s.get("id")
        if sid is None:
            continue
        pid = (s.get("player") or {}).get("id")
        coords = s.get("playerCoordinates") or {}
        target = s.get("goalMouthCoordinates") or {}
        rows.append((
            eid, sid, pid,
            1 if s.get("isHome") else 0,
            coords.get("x"), coords.get("y"),
            target.get("x"), target.get("y"),
            s.get("shotType"),
            s.get("bodyPart"),
            s.get("situation"),
            s.get("shotType"),  # outcome 역할 (goal/save/miss/post)
            s.get("xg"),  # 없으면 None
            s.get("time"),
            s.get("timeSeconds"),
        ))
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO match_shotmap "
            "(event_id, shot_id, player_id, is_home, x, y, target_x, target_y, "
            " shot_type, body_part, situation, outcome, xg, time_min, time_sec) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows
        )
    return len(rows)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=None)
    ap.add_argument("--refetch", action="store_true")
    ap.add_argument("--league", choices=["K1", "K2", "all"], default="all")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    init_schema(conn)
    targets = collect_targets(conn, args)
    log(f"[{args.league}] 대상 매치: {len(targets)}")
    if not targets:
        log("처리할 매치 없음")
        return

    ok_pos = ok_shot = skip = 0
    t0 = time.time()
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            extra_http_headers={"Referer": "https://www.sofascore.com/"}
        )
        page = await ctx.new_page()
        await page.goto("https://www.sofascore.com/tournament/football/south-korea/k-league-1/410",
                        wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)
        log("세션 준비 완료\n")

        # 두 엔드포인트 모두 probe — 엔드포인트별로 차단 정책이 다를 수 있다
        await fetch_health.abort_if_blocked(page, f"/api/v1/event/{targets[0]}/average-positions", log, "avg-positions")
        await fetch_health.abort_if_blocked(page, f"/api/v1/event/{targets[0]}/shotmap", log, "shotmap")

        for i, eid in enumerate(targets):
            ap_data = await api(page, f"/api/v1/event/{eid}/average-positions")
            await asyncio.sleep(DELAY * 0.5)
            sm_data = await api(page, f"/api/v1/event/{eid}/shotmap")
            await asyncio.sleep(DELAY * 0.5)

            n_pos = save_avg_positions(conn, eid, ap_data) if isinstance(ap_data, dict) and "__status" not in ap_data else 0
            n_shot = save_shotmap(conn, eid, sm_data) if isinstance(sm_data, dict) and "__status" not in sm_data else 0
            ok_pos += (1 if n_pos else 0)
            ok_shot += (1 if n_shot else 0)
            if not n_pos and not n_shot:
                skip += 1

            if (i + 1) % 50 == 0 or (i + 1) == len(targets):
                conn.commit()
                log(f"  [{i+1}/{len(targets)}] avg_pos {ok_pos}경기 / shotmap {ok_shot}경기 / skip {skip}")

        conn.commit()
        await browser.close()

    log(f"\n완료: avg_pos {ok_pos} / shotmap {ok_shot} / skip {skip} ({time.time()-t0:.1f}s)")
    conn.close()
    fetch_health.abort_if_all_failed(len(targets) - skip, len(targets), log, "avg-positions+shotmap")


if __name__ == "__main__":
    asyncio.run(main())
