#!/usr/bin/env python3
"""
공식 일정(kleague_schedule)에는 있는데 events 에 없는 K1·K2 종료 경기를 SofaScore 경기 ID로 찾아 채운다.

배경 (2026-11-10): 운영 DB의 과거 K1 시즌 경기 누락 — 2023 149/232 · 2024 200/232 · 2025 158/232 (K2 2023 165/236).
순위·시즌 리뷰·백테스트·히트맵·선수 기록이 모두 '있는 경기'만 보므로 과거 시즌이 왜곡된다.

절차:
  1) 누락 = 공식 종료 경기 중 같은 홈·원정(K-ID→SofaScore 팀 ID)·±1일 events 가 없는 것
  2) SofaScore 시즌 경기 목록(unique-tournament/{410|777}/season/{sid}/events/last/N)에서
     같은 홈·원정·±1일·같은 스코어 유일 후보 → 그 event ID
  3) events INSERT(OR IGNORE) + kleague_event_map(공식 game_id 연결, mapping_method='backfill_sched')
이후 mps(backfill_k1_mps)·득점/카드/교체(collect_kleague_events)·라인업 복원·히트맵(collect_kleague_heatmap)은 기존 STEP 도구로.

사용:
  python crawlers/backfill_missing_events.py --years 2023 2024 2025            # dry-run
  python crawlers/backfill_missing_events.py --years 2023 2024 2025 --apply
"""
import argparse
import asyncio
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = str(ROOT / "players.db")
KST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
TID_BY_LEAGUE = {1: 410, 2: 777}
DELAY = 0.5


def kid_to_ss():
    """K-ID('K02') → SofaScore 팀 ID. main.TEAMS 의 emblem 규칙(emblem_K02.png) 사용."""
    sys.path.insert(0, str(ROOT))
    from main import TEAMS
    out = {}
    for t in TEAMS:
        m = re.match(r"emblem_(K\d{2})\.png", t.get("emblem") or "")
        if m and t.get("sofascore_id"):
            out[m.group(1)] = t["sofascore_id"]
    return out


def find_missing(conn, years, leagues, k2s, relabel):
    """누락 경기 목록. 있는데 리그 라벨(410/777)이 공식 일정과 다른 경기는 relabel 에 (event_id, 현재, 올바른 tid) 로 모은다
    (DB 2020~2023 일부 경기가 반대 리그로 저장된 문제 — 9410 PO는 건드리지 않음)."""
    rows = []
    for y in years:
        for lid in leagues:
            for gid, ms, gdate, hk, ak, hn, an, hg, ag in conn.execute(
                    """SELECT game_id, meet_seq, game_date, home_kid, away_kid, home_team_name, away_team_name, home_goal, away_goal
                       FROM kleague_schedule WHERE year=? AND league_id=? AND end_yn='Y'""", (y, lid)):
                hs, as_ = k2s.get(hk), k2s.get(ak)
                if not hs or not as_:
                    rows.append({"year": y, "lid": lid, "gid": gid, "ms": ms, "date": gdate, "home": hn, "away": an,
                                 "hs_id": hs, "as_id": as_, "hg": hg, "ag": ag, "reason": "팀 K-ID 매핑 없음"})
                    continue
                d0 = datetime.strptime(gdate, "%Y-%m-%d").replace(tzinfo=KST)
                lo, hi = int((d0 - timedelta(days=1)).timestamp()), int((d0 + timedelta(days=2)).timestamp())
                hit = conn.execute("""SELECT id, tournament_id FROM events WHERE home_team_id=? AND away_team_id=? AND date_ts >= ? AND date_ts < ?
                                      AND tournament_id IN (410, 777, 9410) LIMIT 1""", (hs, as_, lo, hi)).fetchone()
                if hit and hit[1] in (410, 777) and hit[1] != TID_BY_LEAGUE[lid]:
                    relabel.append((hit[0], hit[1], TID_BY_LEAGUE[lid], y, lid, gid, ms))
                if not hit:
                    rows.append({"year": y, "lid": lid, "gid": gid, "ms": ms, "date": gdate, "home": hn, "away": an,
                                 "hs_id": hs, "as_id": as_, "hg": hg, "ag": ag, "d0": d0})
    return rows


async def sofa_season_events(years, leagues):
    """{(tid, year): [event, ...]} — SofaScore 시즌 종료 경기 목록."""
    from playwright.async_api import async_playwright
    out = {}
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        pg = await (await b.new_context(user_agent=UA)).new_page()
        await pg.goto("https://www.sofascore.com/tournament/football/south-korea/k-league-1/410",
                      wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)

        async def get(path):
            st, body = await pg.evaluate("async (u)=>{const r=await fetch(u);return [r.status, await r.text()];}",
                                         "https://www.sofascore.com" + path)
            await asyncio.sleep(DELAY)
            return st, (json.loads(body) if st == 200 else None)

        for lid in leagues:
            tid = TID_BY_LEAGUE[lid]
            st, js = await get(f"/api/v1/unique-tournament/{tid}/seasons")
            if st == 403:
                await b.close()
                raise SystemExit(f"[차단 감지] seasons 403 — 중단 (exit 3)")
            seasons = {str(s.get("year")): s["id"] for s in (js or {}).get("seasons", [])}
            for y in years:
                sid = seasons.get(str(y))
                if not sid:
                    print(f"  SofaScore {tid} {y} 시즌 없음 (보유: {sorted(seasons)[:8]})")
                    continue
                evs, page = [], 0
                while page < 40:
                    st, js = await get(f"/api/v1/unique-tournament/{tid}/season/{sid}/events/last/{page}")
                    if st != 200 or not js:
                        break
                    evs += js.get("events", [])
                    if not js.get("hasNextPage"):
                        break
                    page += 1
                fin = [e for e in evs if (e.get("status") or {}).get("type") == "finished"]
                out[(tid, y)] = fin
                print(f"  SofaScore {tid} {y}: 시즌 {sid} · 종료 경기 {len(fin)} (페이지 {page + 1})")
        await b.close()
    return out


def main():
    ap = argparse.ArgumentParser(description="공식 일정 대비 누락 경기 백필 (기본 dry-run)")
    ap.add_argument("--years", type=int, nargs="+", required=True)
    ap.add_argument("--leagues", type=int, nargs="+", default=[1, 2], help="1=K1, 2=K2")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    k2s = kid_to_ss()
    relabel = []
    missing = find_missing(conn, args.years, args.leagues, k2s, relabel)
    by = {}
    for m in missing:
        by[(m["year"], m["lid"])] = by.get((m["year"], m["lid"]), 0) + 1
    print(f"[{'APPLY' if args.apply else 'DRY-RUN'}] 공식 종료 경기 중 events 누락: {len(missing)} {sorted(by.items())}")
    rb = {}
    for _eid, cur_t, new_t, y, *_ in relabel:
        rb[(y, cur_t, new_t)] = rb.get((y, cur_t, new_t), 0) + 1
    print(f"  리그 라벨 교정 대상(있는데 반대 리그로 저장): {len(relabel)} {sorted(rb.items())}")
    if args.apply and relabel:
        with conn:
            for eid, cur_t, new_t, y, lid, gid, ms in relabel:
                conn.execute("UPDATE events SET tournament_id=? WHERE id=? AND tournament_id=?", (new_t, eid, cur_t))
                conn.execute("""INSERT OR IGNORE INTO kleague_event_map (sofa_event_id, year, league_id, game_id, meet_seq, mapping_method)
                                VALUES (?,?,?,?,?, 'relabel_sched')""", (eid, y, lid, gid, ms))
        print(f"  라벨 교정 적용 {len(relabel)}")
    if not missing:
        return
    need = sorted({(m["lid"], m["year"]) for m in missing if "reason" not in m})
    sofa = asyncio.run(sofa_season_events(sorted({y for _, y in need}), sorted({l for l, _ in need})))

    ok = nomatch = multi = exists = 0
    unmatched = []
    for m in missing:
        if "reason" in m:
            unmatched.append((m, m["reason"])); nomatch += 1; continue
        tid = TID_BY_LEAGUE[m["lid"]]
        d0 = m["d0"].timestamp()
        cand = [e for e in sofa.get((tid, m["year"]), [])
                if e.get("homeTeam", {}).get("id") == m["hs_id"] and e.get("awayTeam", {}).get("id") == m["as_id"]
                and abs(int(e.get("startTimestamp") or 0) - d0) <= 2 * 86400
                and (e.get("homeScore") or {}).get("current") == m["hg"] and (e.get("awayScore") or {}).get("current") == m["ag"]]
        if len(cand) != 1:
            unmatched.append((m, f"SofaScore 후보 {len(cand)}개"));
            if cand: multi += 1
            else: nomatch += 1
            continue
        e = cand[0]
        if conn.execute("SELECT 1 FROM events WHERE id=?", (e["id"],)).fetchone():
            exists += 1
            unmatched.append((m, f"event {e['id']} 이미 있음(다른 날짜/팀으로 저장)")); continue
        if args.apply:
            with conn:
                conn.execute("""INSERT OR IGNORE INTO events (id, home_team_id, home_team_name, away_team_id, away_team_name,
                                date_ts, home_score, away_score, tournament_id, round) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                             (e["id"], m["hs_id"], e["homeTeam"].get("name"), m["as_id"], e["awayTeam"].get("name"),
                              e.get("startTimestamp"), m["hg"], m["ag"], tid, (e.get("roundInfo") or {}).get("round")))
                conn.execute("""INSERT OR REPLACE INTO kleague_event_map (sofa_event_id, year, league_id, game_id, meet_seq, mapping_method)
                                VALUES (?,?,?,?,?, 'backfill_sched')""", (e["id"], m["year"], m["lid"], m["gid"], m["ms"]))
        ok += 1
    print(f"완료: {'추가' if args.apply else '추가 예정'} {ok} · 후보 없음 {nomatch} · 후보 여러 개 {multi} · ID 충돌 {exists}")
    for m, why in unmatched[:25]:
        print(f"  미해결 {m['year']} L{m['lid']} {m['date']} {m['home']} {m['hg']}-{m['ag']} {m['away']}: {why}")
    conn.close()


if __name__ == "__main__":
    main()
