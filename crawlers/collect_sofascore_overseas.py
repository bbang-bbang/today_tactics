#!/usr/bin/env python3
"""
해외 리그 SofaScore 슈팅맵(xG)·평균 위치 수집 → 리그 DB(API-Football 번호 체계)에 저장. 2026-11-24.

배경: 해외 리그 DB 는 API-Football 로 수집(경기·선수 번호 = API-Football). API-Football 에는 슈팅 좌표·xG·평균 위치가
없어 SofaScore 에서 받아 API-Football 경기·팀·선수 번호로 옮겨 저장한다(/api/league/<code>/team-shotmap·team-shape).
- 경기: 시작 시각 ±3일 + 스코어 일치 + 팀 이름 유사도
- 선수: 그 경기 API-Football 라인업 등번호 → 약칭('R. Meshino') → 성+이니셜. 모호하면 연결 안 함
  (슈팅은 player_id 없이 이름만 저장, 평균 위치는 건너뜀)

운영 서버는 SofaScore 가 막고(403) 있어 로컬 PC 에서 실행 → 결과를 import_overseas_extras.py 로 서버 DB 에 반영.
저부하 원칙: 요청 간 --delay(기본 1.5초), 403/챌린지 감지 시 즉시 중단(우회하지 않음).

사용:
  python crawlers/collect_sofascore_overseas.py --league jleague1 --db <jleague1.db 경로>            # dry-run(매칭만)
  python crawlers/collect_sofascore_overseas.py --league jleague1 --db <경로> --apply [--max 20]
"""
import argparse
import asyncio
import re
import sqlite3
import sys
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
# league code → (SofaScore unique tournament id, 시즌 이름에 들어갈 표기)
SOFA_LEAGUES = {"jleague1": (196, "26/27")}
WINDOW = 3 * 86400


def norm_team(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(fc|sc|cf|club)\b", " ", s)
    return re.sub(r"[^a-z0-9]+", "", s)


def _sim(a, b):
    a, b = norm_team(a), norm_team(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def match_event(sofa, api_events):
    """sofa = {start, hs, as, home, away}; api_events = [(id, home_id, away_id, date_ts, hs, as, home_name, away_name)].
    시작 시각 ±3일·스코어 일치 후보 중 팀 이름 유사도 합이 가장 큰 경기(두 팀 모두 0.5 이상)."""
    best, best_s = None, 0.0
    for eid, _h, _a, ts, hs, as_, hn, an in api_events:
        if ts is None or abs(ts - sofa["start"]) > WINDOW or hs != sofa["hs"] or as_ != sofa["as"]:
            continue
        sh, sa = _sim(sofa["home"], hn), _sim(sofa["away"], an)
        if sh < 0.5 or sa < 0.5:
            continue
        if sh + sa > best_s:
            best, best_s = eid, sh + sa
    return best


def _surname_initial(name):
    parts = [p for p in re.split(r"[\s.]+", unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().lower()) if p]
    if not parts:
        return None, None
    return parts[-1], (parts[0][0] if len(parts) > 1 else None)


def map_player(sp, cands):
    """sp = SofaScore player {shortName, name, jerseyNumber}; cands = [(api_id, name, jersey)] — 그 경기 그 팀 선수.
    등번호 → 약칭 일치 → 성+이니셜(유일할 때만). 없거나 모호하면 None."""
    jn = str(sp.get("jerseyNumber") or "").strip()
    if jn.isdigit():
        hit = [c for c in cands if c[2] is not None and int(c[2]) == int(jn)]
        if len(hit) == 1:
            return hit[0][0]
    short = norm_team(sp.get("shortName"))
    hit = [c for c in cands if short and norm_team(c[1]) == short]
    if len(hit) == 1:
        return hit[0][0]
    sur, ini = _surname_initial(sp.get("shortName") or sp.get("name"))
    if not sur:
        return None
    same = [c for c in cands if _surname_initial(c[1])[0] == sur]
    if ini:
        same = [c for c in same if _surname_initial(c[1])[1] in (ini, None)]
    elif len(same) > 1:
        return None
    return same[0][0] if len(same) == 1 else None


# ── 수집 ──────────────────────────────────────────────────────────
class Blocked(RuntimeError):
    pass


async def _get(page, path, delay):
    r = await page.evaluate("p => fetch(p).then(async r => ({s: r.status, b: r.ok ? await r.json() : null})).catch(e => ({s: 0}))", path)
    await asyncio.sleep(delay)
    if r["s"] in (401, 403, 429):
        raise Blocked(f"{path} → HTTP {r['s']} (차단/제한 — 우회하지 않고 중단)")
    return r["b"] if r["s"] == 200 else None


def _candidates(conn, eid, team_id):
    """그 경기 그 팀 선수: 라인업(등번호) ∪ 경기 기록 선수(이름)."""
    out = {}
    for pid, num in conn.execute("SELECT player_id, jersey_number FROM match_lineups WHERE event_id=? AND team_id=?", (eid, team_id)):
        out[pid] = [pid, None, num]
    for pid, nm in conn.execute("""SELECT m.player_id, COALESCE(p.name, m.player_name) FROM match_player_stats m
                                   LEFT JOIN players p ON p.id = m.player_id WHERE m.event_id=? AND m.team_id=?""", (eid, team_id)):
        out.setdefault(pid, [pid, None, None])[1] = nm
    for pid, row in out.items():
        if row[1] is None:
            r = conn.execute("SELECT name FROM players WHERE id=?", (pid,)).fetchone()
            row[1] = r[0] if r else None
    return [tuple(v) for v in out.values()]


def save_event(conn, eid, home_id, away_id, shot, avg):
    """한 경기 슈팅·평균 위치를 지우고 다시 넣는다(멱등). 반환 (슈팅 수, 평균 위치 수, 연결 못 한 선수 수)."""
    team = {1: home_id, 0: away_id}
    cands = {1: _candidates(conn, eid, home_id), 0: _candidates(conn, eid, away_id)}
    unmatched = 0
    shots = []
    for s in (shot or {}).get("shotmap") or []:
        ih = 1 if s.get("isHome") else 0
        sp = s.get("player") or {}
        pid = map_player(sp, cands[ih])
        unmatched += pid is None
        pc = s.get("playerCoordinates") or {}
        shots.append((eid, pid, sp.get("name"), team[ih], ih, pc.get("x"), pc.get("y"), s.get("xg"), s.get("shotType"),
                      s.get("situation"), s.get("bodyPart"), s.get("time"), s.get("addedTime")))
    subs = {((x.get("playerIn") or {}).get("id")) for x in (avg or {}).get("substitutions") or []}
    avgs = []
    for side, ih in (("home", 1), ("away", 0)):
        for a in (avg or {}).get(side) or []:
            sp = a.get("player") or {}
            pid = map_player(sp, cands[ih])
            if pid is None:
                unmatched += 1
                continue
            avgs.append((eid, pid, team[ih], ih, 1 if sp.get("id") in subs else 0, a.get("averageX"), a.get("averageY")))
    with conn:
        conn.execute("DELETE FROM match_shotmap WHERE event_id=?", (eid,))
        conn.execute("DELETE FROM match_avg_positions WHERE event_id=?", (eid,))
        conn.executemany("""INSERT OR REPLACE INTO match_shotmap (event_id, player_id, player_name, team_id, is_home, x, y, xg,
                            outcome, situation, body_part, minute, added_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", shots)
        conn.executemany("""INSERT OR REPLACE INTO match_avg_positions (event_id, player_id, team_id, is_home, is_substitute, avg_x, avg_y)
                            VALUES (?,?,?,?,?,?,?)""", avgs)
    return len(shots), len(avgs), unmatched


async def run(args):
    from playwright.async_api import async_playwright
    ut, season_tag = SOFA_LEAGUES[args.league]
    conn = sqlite3.connect(args.db, timeout=60)
    api_events = conn.execute("""SELECT e.id, e.home_team_id, e.away_team_id, e.date_ts, e.home_score, e.away_score,
                                        th.name, ta.name FROM events e
                                 LEFT JOIN teams th ON th.id = e.home_team_id LEFT JOIN teams ta ON ta.id = e.away_team_id
                                 WHERE e.home_score IS NOT NULL""").fetchall()
    done = {r[0] for r in conn.execute("SELECT DISTINCT event_id FROM match_avg_positions")}
    by_id = {r[0]: r for r in api_events}
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await b.new_page()
        await page.goto("https://www.sofascore.com/", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(2)
        seasons = (await _get(page, f"/api/v1/unique-tournament/{ut}/seasons", args.delay) or {}).get("seasons") or []
        season = next((s for s in seasons if season_tag in (s.get("name") or "")), None)
        if not season:
            print(f"시즌 '{season_tag}' 없음 — {[s.get('name') for s in seasons[:4]]}"); return 1
        sofa_events, pg = [], 0
        while True:
            d = await _get(page, f"/api/v1/unique-tournament/{ut}/season/{season['id']}/events/last/{pg}", args.delay) or {}
            sofa_events += [e for e in d.get("events") or [] if (e.get("status") or {}).get("type") == "finished"]
            if not d.get("hasNextPage"):
                break
            pg += 1
        pairs, miss = [], []
        for e in sofa_events:
            s = {"start": e.get("startTimestamp"), "hs": (e.get("homeScore") or {}).get("current"),
                 "as": (e.get("awayScore") or {}).get("current"), "home": e["homeTeam"]["name"], "away": e["awayTeam"]["name"]}
            eid = match_event(s, api_events)
            (pairs if eid else miss).append((e["id"], eid, s))
        print(f"[{args.league}] SofaScore {season['name']} 종료 {len(sofa_events)}경기 · 매칭 {len(pairs)} · 미매칭 {len(miss)}"
              f" (API 종료 {len(api_events)}) · 이미 받은 경기 {len(done)}", flush=True)
        for sid, _e, s in miss[:5]:
            print(f"   미매칭 예: {sid} {s['home']} {s['hs']}-{s['as']} {s['away']}")
        todo = [(sid, eid) for sid, eid, _ in pairs if args.refetch or eid not in done][: args.max or None]
        if not args.apply:
            print(f"  (dry-run) 받을 경기 {len(todo)} — 요청 약 {len(todo) * 2}회 · 예상 {len(todo) * 2 * args.delay / 60:.0f}분")
            await b.close(); return 0
        tot = [0, 0, 0]
        t0 = time.time()
        for i, (sid, eid) in enumerate(todo, 1):
            shot = await _get(page, f"/api/v1/event/{sid}/shotmap", args.delay)
            avg = await _get(page, f"/api/v1/event/{sid}/average-positions", args.delay)
            r = save_event(conn, eid, by_id[eid][1], by_id[eid][2], shot, avg)
            tot = [a + b_ for a, b_ in zip(tot, r)]
            if i % 10 == 0 or i == len(todo):
                print(f"   … {i}/{len(todo)}경기 · 슈팅 {tot[0]} · 평균 위치 {tot[1]} · 연결 못 한 선수 {tot[2]} ({time.time() - t0:.0f}s)", flush=True)
        await b.close()
    conn.close()
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", required=True, choices=sorted(SOFA_LEAGUES))
    ap.add_argument("--db", required=True, help="리그 DB 경로(로컬 사본)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--refetch", action="store_true")
    ap.add_argument("--max", type=int, default=0)
    ap.add_argument("--delay", type=float, default=1.5)
    args = ap.parse_args()
    if args.delay < 1.0:
        raise SystemExit("--delay 는 1.0초 이상(저부하 원칙)")
    try:
        return asyncio.run(run(args))
    except Blocked as e:
        print(f"중단: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
