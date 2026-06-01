#!/usr/bin/env python3
"""
K1/K2 전경기 골 인시던트(득점 시간, 선수, 팀) 수집
sofascore /api/v1/event/{id}/incidents 사용

goal_type:
  regular     - 일반 필드골
  penalty     - PK
  fromSetPiece - 프리킥/세트피스 골
  ownGoal     - 자책골
"""

import asyncio, sqlite3, sys, argparse
from playwright.async_api import async_playwright

DB_PATH = "players.db"
DELAY   = 0.25

LEAGUE_TID = {"K1": 410, "K2": 777}

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

def init_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS goal_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id    INTEGER NOT NULL,
            team_id     INTEGER NOT NULL,
            player_id   INTEGER,
            player_name TEXT,
            minute      INTEGER,
            added_time  INTEGER DEFAULT 0,
            is_home     INTEGER DEFAULT 0,
            is_own_goal INTEGER DEFAULT 0,
            is_penalty  INTEGER DEFAULT 0,
            goal_type   TEXT DEFAULT 'regular',
            UNIQUE(event_id, team_id, player_id, minute, added_time)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ge_event ON goal_events(event_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ge_team  ON goal_events(team_id)")
    # goal_type 컬럼 없으면 추가 (기존 DB 호환)
    try:
        conn.execute("ALTER TABLE goal_events ADD COLUMN goal_type TEXT DEFAULT 'regular'")
    except Exception:
        pass

    # 카드 이벤트 테이블 (옐로/레드/2nd yellow)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS card_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id    INTEGER NOT NULL,
            team_id     INTEGER NOT NULL,
            player_id   INTEGER,
            player_name TEXT,
            minute      INTEGER,
            added_time  INTEGER DEFAULT 0,
            is_home     INTEGER DEFAULT 0,
            card_type   TEXT,         -- yellow / red / yellowRed
            reason      TEXT,
            UNIQUE(event_id, player_id, minute, added_time, card_type)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ce_event  ON card_events(event_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ce_player ON card_events(player_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ce_team   ON card_events(team_id)")

    # 교체 이벤트 테이블 — SofaScore incidents의 substitution 직접 적재
    # mins 추정 기반 페어 매칭 대체 (정확도 ↑)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sub_events (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id       INTEGER NOT NULL,
            team_id        INTEGER NOT NULL,
            is_home        INTEGER DEFAULT 0,
            minute         INTEGER,
            added_time     INTEGER DEFAULT 0,
            player_in_id   INTEGER,
            player_in_name TEXT,
            player_out_id  INTEGER,
            player_out_name TEXT,
            injury         INTEGER DEFAULT 0,
            UNIQUE(event_id, player_in_id, player_out_id, minute)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_se_event ON sub_events(event_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_se_team  ON sub_events(team_id)")
    conn.commit()

async def api(page, path):
    for attempt in range(3):
        try:
            r = await page.evaluate(f"""() =>
                fetch('{path}').then(r => r.ok ? r.json() : null).catch(() => null)
            """)
            return r
        except:
            if attempt < 2:
                await page.goto("https://www.sofascore.com", wait_until="domcontentloaded", timeout=30000)
                await asyncio.sleep(2)
    return None

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--refetch", action="store_true", help="기수집 경기도 재수집 (goal_type / cards 업데이트)")
    parser.add_argument("--league", choices=["K1", "K2", "all"], default="K2",
                        help="대상 리그 (K1/K2/all, 기본 K2)")
    parser.add_argument("--days", type=int, default=None,
                        help="최근 N일 이내 경기만 대상 (백필용)")
    parser.add_argument("--include-zero-zero", action="store_true",
                        help="0-0 경기도 포함 (카드 수집용)")
    args = parser.parse_args()

    if args.league == "all":
        tids = list(LEAGUE_TID.values())
    else:
        tids = [LEAGUE_TID[args.league]]
    placeholders = ",".join("?" for _ in tids)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    init_table(conn)
    cur = conn.cursor()

    days_cond = ""
    days_params = ()
    if args.days:
        days_cond = " AND date_ts > strftime('%s','now') - ? * 86400"
        days_params = (args.days,)

    cur.execute(f"""
        SELECT id, home_team_id, away_team_id
        FROM events WHERE tournament_id IN ({placeholders}){days_cond}
        ORDER BY date_ts
    """, tuple(tids) + days_params)
    all_events = cur.fetchall()

    # 점수가 0-0인 경기는 골 없으므로 보통 스킵 (카드만 수집할 땐 --include-zero-zero)
    if args.include_zero_zero:
        zero_zero = set()
    else:
        cur.execute(f"SELECT id FROM events WHERE tournament_id IN ({placeholders}) AND home_score=0 AND away_score=0", tids)
        zero_zero = {r[0] for r in cur.fetchall()}

    if args.refetch:
        targets = [e for e in all_events if e["id"] not in zero_zero]
        log("[--refetch] 재수집 모드")
    else:
        cur.execute("SELECT DISTINCT event_id FROM goal_events")
        done_g = {r[0] for r in cur.fetchall()}
        cur.execute("SELECT DISTINCT event_id FROM card_events")
        done_c = {r[0] for r in cur.fetchall()}
        # 골/카드 둘 다 수집된 경기만 스킵 (둘 중 하나라도 없으면 다시)
        done = done_g & done_c
        targets = [e for e in all_events if e["id"] not in done and e["id"] not in zero_zero]

    log(f"[{args.league}] 전체: {len(all_events)}경기 / 0-0스킵: {len(zero_zero)} / 수집대상: {len(targets)}경기")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await ctx.new_page()
        await page.goto("https://www.sofascore.com", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)
        log("세션 준비 완료\n")

        ok = skip = 0
        consecutive_fails = 0
        for i, ev in enumerate(targets):
            eid = ev["id"]
            data = await api(page, f"/api/v1/event/{eid}/incidents")
            await asyncio.sleep(DELAY)

            if not data or "incidents" not in data:
                skip += 1
                consecutive_fails += 1
                if consecutive_fails >= 10:
                    log(f"  연속 {consecutive_fails}회 실패 — 세션 재초기화...")
                    await page.goto("https://www.sofascore.com", wait_until="domcontentloaded", timeout=60000)
                    await asyncio.sleep(5)
                    consecutive_fails = 0
                continue
            consecutive_fails = 0

            # 재수집 모드: 기존 해당 경기 데이터 삭제 후 재삽입
            if args.refetch:
                cur.execute("DELETE FROM goal_events WHERE event_id=?", (eid,))
                cur.execute("DELETE FROM card_events WHERE event_id=?", (eid,))
                cur.execute("DELETE FROM sub_events  WHERE event_id=?", (eid,))

            rows_inserted = 0
            for inc in data["incidents"]:
                inc_type = inc.get("incidentType")

                # ── 카드 이벤트 처리 ──
                if inc_type == "card":
                    minute     = inc.get("time", 0)
                    added_time = inc.get("addedTime", 0) or 0
                    is_home    = 1 if inc.get("isHome") else 0
                    inc_class  = inc.get("incidentClass", "")  # yellow/red/yellowRed
                    reason     = inc.get("reason", "") or inc.get("rescinded", "")
                    player     = inc.get("player") or {}
                    pid        = player.get("id")
                    pname      = player.get("name", "")
                    team_id    = ev["home_team_id"] if is_home else ev["away_team_id"]
                    try:
                        cur.execute("""
                            INSERT OR IGNORE INTO card_events
                            (event_id, team_id, player_id, player_name, minute, added_time,
                             is_home, card_type, reason)
                            VALUES (?,?,?,?,?,?,?,?,?)
                        """, (eid, team_id, pid, pname, minute, added_time,
                              is_home, inc_class, reason))
                    except Exception:
                        pass
                    continue

                # ── 교체 이벤트 처리 ──
                if inc_type == "substitution":
                    minute     = inc.get("time", 0) or 0
                    added_time = inc.get("addedTime", 0) or 0
                    is_home    = 1 if inc.get("isHome") else 0
                    p_in       = inc.get("playerIn")  or {}
                    p_out      = inc.get("playerOut") or {}
                    injury     = 1 if inc.get("injury") else 0
                    team_id    = ev["home_team_id"] if is_home else ev["away_team_id"]
                    try:
                        cur.execute("""
                            INSERT OR IGNORE INTO sub_events
                            (event_id, team_id, is_home, minute, added_time,
                             player_in_id, player_in_name, player_out_id, player_out_name, injury)
                            VALUES (?,?,?,?,?,?,?,?,?,?)
                        """, (eid, team_id, is_home, minute, added_time,
                              p_in.get("id"), p_in.get("name", ""),
                              p_out.get("id"), p_out.get("name", ""), injury))
                    except Exception:
                        pass
                    continue

                if inc_type != "goal":
                    continue
                minute     = inc.get("time", 0)
                added_time = inc.get("addedTime", 0) or 0
                is_home    = 1 if inc.get("isHome") else 0
                inc_class  = inc.get("incidentClass", "regular")

                is_own = 1 if inc_class == "ownGoal" else 0
                is_pen = 1 if inc_class == "penalty" else 0

                # goal_type 분류
                if inc_class == "penalty":
                    goal_type = "penalty"
                elif inc_class == "ownGoal":
                    goal_type = "ownGoal"
                elif inc_class == "fromSetPiece":
                    goal_type = "fromSetPiece"
                else:
                    goal_type = "regular"

                player = inc.get("player") or {}
                pid    = player.get("id")
                pname  = player.get("name", "")

                # 팀 ID 결정 (자책골이면 상대팀이 득점)
                if is_own:
                    team_id = ev["away_team_id"] if is_home else ev["home_team_id"]
                else:
                    team_id = ev["home_team_id"] if is_home else ev["away_team_id"]

                try:
                    cur.execute("""
                        INSERT OR IGNORE INTO goal_events
                        (event_id, team_id, player_id, player_name, minute, added_time,
                         is_home, is_own_goal, is_penalty, goal_type)
                        VALUES (?,?,?,?,?,?,?,?,?,?)
                    """, (eid, team_id, pid, pname, minute, added_time,
                          is_home, is_own, is_pen, goal_type))
                    rows_inserted += cur.rowcount
                except:
                    pass

            ok += 1
            if (i+1) % 50 == 0:
                conn.commit()
                log(f"  [{i+1}/{len(targets)}] 처리 중...")

        conn.commit()
        await browser.close()

    # 최종 통계
    cur.execute("SELECT goal_type, COUNT(*) as cnt FROM goal_events GROUP BY goal_type ORDER BY cnt DESC")
    log("\n골 종류별 집계:")
    for r in cur.fetchall():
        log(f"  {r[0]}: {r[1]}개")

    cur.execute("SELECT card_type, COUNT(*) as cnt FROM card_events GROUP BY card_type ORDER BY cnt DESC")
    log("\n카드 종류별 집계:")
    for r in cur.fetchall():
        log(f"  {r[0]}: {r[1]}개")

    cur.execute("SELECT COUNT(*) FROM goal_events")
    total_g = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM card_events")
    total_c = cur.fetchone()[0]
    conn.close()
    log(f"\n완료: {ok}경기 처리 / 스킵: {skip}경기")
    log(f"goal_events 총 레코드: {total_g}건 / card_events 총: {total_c}건")

if __name__ == "__main__":
    asyncio.run(main())
