"""
SofaScore가 경기를 새 ID로 다시 만든 경우(구 ID → 404) DB의 경기 ID를 새 ID로 옮긴다.

배경 (2026-11-10): 용인FC의 7월 이후 K2 16경기가 SofaScore에서 전부 새 event ID로 재생성됨.
DB에는 일정 수집 당시의 구 ID가 남아 SofaScore 수집(mps·히트맵·라인업)이 계속 실패/스킵,
공식 API 데이터(득점·카드·교체·패스·공식 선수 기록)만 구 ID에 붙어 있었다.

사용:
  python crawlers/remap_event_ids.py --detect              # mps 없는 종료 경기 → SofaScore 404 + 같은 홈팀·±3일·같은 스코어 후보 탐색 (dry-run)
  python crawlers/remap_event_ids.py --detect --apply      # 위에서 '유일·스코어 일치' 후보만 교체
  python crawlers/remap_event_ids.py 15404037:16299962     # 지정 쌍 dry-run (--apply 시 교체)

교체 규칙: 한 트랜잭션에서 events.id 와 모든 테이블의 event_id / sofa_event_id 컬럼을 OLD→NEW.
안전장치: OLD가 events에 있어야 하고, NEW는 어느 테이블에도 없어야 한다(충돌 시 해당 쌍 건너뜀).
교체 뒤에는 update_data.py STEP 4·5(mps)·6(히트맵) 재실행 + 캐시 무효화가 필요하다.
"""
import argparse
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = str(BASE_DIR / "players.db")
REF_COLS = ("event_id", "sofa_event_id")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def ref_columns(conn):
    """[(table, column)] — events.id 제외, event_id/sofa_event_id 컬럼 전부 (sqlite_master 기준)."""
    out = []
    for (t,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        for r in conn.execute(f'PRAGMA table_info("{t}")'):
            if r[1] in REF_COLS:
                out.append((t, r[1]))
    return out


def refs(conn, cols, eid):
    n = conn.execute("SELECT COUNT(*) FROM events WHERE id=?", (eid,)).fetchone()[0]
    per = {"events.id": n} if n else {}
    for t, col in cols:
        k = conn.execute(f'SELECT COUNT(*) FROM "{t}" WHERE "{col}"=?', (eid,)).fetchone()[0]
        if k:
            per[f"{t}.{col}"] = k
    return per


def remap(conn, pairs, apply):
    cols = ref_columns(conn)
    done = 0
    for old, new in pairs:
        r_old, r_new = refs(conn, cols, old), refs(conn, cols, new)
        if not r_old.get("events.id"):
            print(f"  [{old}→{new}] 건너뜀: 구 ID가 events에 없음")
            continue
        if r_new:
            print(f"  [{old}→{new}] 건너뜀: 새 ID가 이미 존재 {r_new}")
            continue
        print(f"  [{old}→{new}] " + " · ".join(f"{k} {v}" for k, v in r_old.items()))
        if not apply:
            continue
        with conn:   # 쌍 단위 트랜잭션
            conn.execute("UPDATE events SET id=? WHERE id=?", (new, old))
            for t, col in cols:
                conn.execute(f'UPDATE "{t}" SET "{col}"=? WHERE "{col}"=?', (new, old))
        done += 1
    return done


class Blocked(Exception):
    pass


def report_future_duplicates(conn):
    """예정 경기 중복(같은 홈·원정팀, 결과 없음, 3일 이내 두 ID) — 보고만 한다(삭제 = Red, 사람이 판단)."""
    rows = conn.execute("""
        SELECT a.id, b.id, a.home_team_name, a.away_team_name,
               datetime(a.date_ts, 'unixepoch', '+9 hours'), datetime(b.date_ts, 'unixepoch', '+9 hours')
        FROM events a JOIN events b
          ON a.home_team_id = b.home_team_id AND a.away_team_id = b.away_team_id AND a.id < b.id
         AND ABS(a.date_ts - b.date_ts) <= 3 * 86400
        WHERE a.tournament_id IN (410, 777) AND b.tournament_id IN (410, 777)
          AND a.home_score IS NULL AND b.home_score IS NULL
          AND a.date_ts > strftime('%s', 'now') - 86400""").fetchall()
    for a, b, hn, an, da, db in rows:
        print(f"  ⚠ 예정 경기 중복: {hn}-{an} {a}({da}) / {b}({db}) — SofaScore 404인 쪽 삭제 검토 (자동 삭제 안 함)")
    return len(rows)


async def detect(conn, days=None):
    """mps 없는 K1/K2 종료 경기 중 SofaScore에서 404인 것 → 같은 홈팀 최근 경기에서 ±3일·같은 원정팀·같은 스코어 후보."""
    since = 0 if not days else int(__import__("time").time()) - days * 86400
    rows = conn.execute("""
        SELECT e.id, e.date_ts, e.home_team_id, e.away_team_id, e.home_score, e.away_score, e.home_team_name, e.away_team_name
        FROM events e
        WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
          AND e.date_ts >= ?
          AND NOT EXISTS (SELECT 1 FROM match_player_stats s WHERE s.event_id = e.id)
        ORDER BY e.date_ts DESC""", (since,)).fetchall()
    print(f"mps 없는 종료 경기 {len(rows)}" + (f" (최근 {days}일)" if days else ""))
    if not rows:
        return []
    from playwright.async_api import async_playwright
    pairs = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        pg = await (await b.new_context(user_agent=UA)).new_page()
        await pg.goto("https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
                      wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)

        async def get(path):
            return await pg.evaluate("async (u)=>{const r=await fetch(u);return [r.status, await r.text()];}",
                                     "https://www.sofascore.com" + path)
        team_events = {}
        for eid, ts, hid, aid, hs, as_, hn, an in rows:
            st, _ = await get(f"/api/v1/event/{int(eid)}")
            await asyncio.sleep(0.4)
            if st == 403:
                await b.close()
                raise Blocked(f"SofaScore 403 (event {eid}) — 차단, 판정 불가")
            if st != 404:
                print(f"  {eid} {hn}-{an}: SofaScore {st} (ID 유효 — 대상 아님)")
                continue
            if hid not in team_events:
                evs = []
                for page_no in (0, 1, 2):
                    s2, body = await get(f"/api/v1/team/{int(hid)}/events/last/{page_no}")
                    await asyncio.sleep(0.4)
                    if s2 != 200:
                        break
                    evs += json.loads(body).get("events", [])
                team_events[hid] = evs
            cand = [e for e in team_events[hid]
                    if e.get("homeTeam", {}).get("id") == hid and e.get("awayTeam", {}).get("id") == aid
                    and abs(int(e.get("startTimestamp") or 0) - ts) <= 3 * 86400
                    and (e.get("status") or {}).get("type") == "finished"
                    and (e.get("homeScore") or {}).get("current") == hs
                    and (e.get("awayScore") or {}).get("current") == as_]
            if len(cand) == 1:
                pairs.append((int(eid), int(cand[0]["id"])))
                print(f"  {eid} {hn}-{an} {hs}-{as_}: 404 → 후보 {cand[0]['id']}")
            else:
                print(f"  {eid} {hn}-{an} {hs}-{as_}: 404 → 후보 {len(cand)}개 (자동 교체 안 함)")
        await b.close()
    return pairs


def main():
    ap = argparse.ArgumentParser(description="SofaScore 재생성 경기 ID 교체 (기본 dry-run)")
    ap.add_argument("pairs", nargs="*", help="OLD:NEW 쌍")
    ap.add_argument("--detect", action="store_true", help="404 경기 자동 탐지")
    ap.add_argument("--apply", action="store_true", help="실제 교체")
    ap.add_argument("--days", type=int, help="--detect 대상을 최근 N일 종료 경기로 제한 (update_data 정기 실행용)")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    pairs = []
    for p in args.pairs:
        o, n = p.split(":")
        pairs.append((int(o), int(n)))
    if args.detect:
        try:
            pairs += asyncio.run(detect(conn, args.days))
        except Blocked as e:
            print(f"[차단 감지] {e}")
            sys.exit(3)
        report_future_duplicates(conn)
    if not pairs:
        print("교체할 쌍 없음")
        return
    print(f"[{'APPLY' if args.apply else 'DRY-RUN'}] 교체 대상 {len(pairs)}쌍")
    n = remap(conn, pairs, args.apply)
    conn.close()
    print(f"완료: {n if args.apply else 0}쌍 교체" + ("" if args.apply else " (dry-run: 변경 없음)"))


if __name__ == "__main__":
    main()
