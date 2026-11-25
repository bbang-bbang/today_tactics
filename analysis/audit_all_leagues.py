#!/usr/bin/env python3
"""전 리그 데이터 정합성·무결성 점검 (읽기 전용, 2026-11-25).

대상: 해외 리그 DB 전부(*.db) · K리그 players.db · transfermarkt.db · (선택) 실행 중인 API 응답.
DB 는 mode=ro 로만 연다. API 점검은 --api http://127.0.0.1:5000 를 줄 때만(GET 만).
실행(서버): cd /opt/today_tactics && venv/bin/python analysis/audit_all_leagues.py --api http://127.0.0.1:5000
결과: 항목마다 OK / WARN / FAIL + 수치, 마지막에 요약. FAIL 이 있으면 종료 코드 1.
"""
import argparse
import glob
import json
import os
import sqlite3
import sys
import time
import urllib.request
from collections import Counter, defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from overseas_formation import formation_from_grids  # noqa: E402

res = []


def rep(level, area, label, detail=""):
    res.append((level, area, label, detail))
    print(f"[{level:4s}] {area:13s} {label} {detail}")


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True) if os.path.exists(path) else None


def has(c, table):
    return c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def standings_vs_events(fin, st):
    """fin = [(id, h, a, hs, as)], st = [(team, m, w, d, l, gf, ga, pts)] → 불일치 목록."""
    agg = defaultdict(lambda: [0, 0, 0, 0, 0, 0])
    for _id, h, a, hs, as_ in fin:
        for t, gf, ga in ((h, hs, as_), (a, as_, hs)):
            x = agg[t]; x[0] += 1; x[4] += gf; x[5] += ga
            x[1 if gf > ga else 2 if gf == ga else 3] += 1
    return [(t, (m, w, d, l, gf, ga), tuple(agg[t])) for t, m, w, d, l, gf, ga, _p in st if (m, w, d, l, gf, ga) != tuple(agg[t])]


# ── 해외 리그 ────────────────────────────────────────────────────────
def audit_overseas(path):
    code = os.path.basename(path)[:-3]
    c = ro(path)
    try:
        if not has(c, "events"):
            rep("WARN", code, "빈 DB(표 없음) — 수집 전이거나 잘못 만들어진 파일", "")
            return
        ev_all = c.execute("SELECT id, home_team_id, away_team_id, home_score, away_score, date_ts, season_id FROM events").fetchall()
        st_sid = c.execute("SELECT MAX(season_id) FROM league_standings").fetchone()[0] if has(c, "league_standings") else None
        if not ev_all:
            n = c.execute("SELECT COUNT(*) FROM league_standings WHERE season_id = ?", (st_sid,)).fetchone()[0] if st_sid else 0
            st = c.execute("SELECT matches, wins, draws, losses, points FROM league_standings WHERE season_id = ?", (st_sid,)).fetchall()
            bad = [r for r in st if r[0] != r[1] + r[2] + r[3]]
            rep("OK" if n and not bad else "WARN", code, "순위표만 리그: 팀 수·경기 = 승+무+패", f"{n}팀 · 불일치 {len(bad)}")
            return
        sid = max(e[6] for e in ev_all if e[6] is not None)
        ev = [e for e in ev_all if e[6] == sid]
        fin = [e[:5] for e in ev if e[3] is not None and e[4] is not None]
        now = time.time()
        half = [e for e in ev if (e[3] is None) != (e[4] is None)]
        neg = [e for e in fin if e[3] < 0 or e[4] < 0 or e[3] > 15 or e[4] > 15]
        fut = [e for e in ev if e[3] is not None and (e[5] or 0) > now + 3600]
        stale = [e for e in ev if e[3] is None and (e[5] or 0) < now - 5 * 86400]
        rep("OK" if not (half or neg or fut) else "FAIL", code, "스코어 무결성(한쪽만·범위·미래 경기 점수)",
            f"시즌 {sid} 경기 {len(ev)}(종료 {len(fin)}) · 한쪽만 {len(half)} · 범위 밖 {len(neg)} · 미래 {len(fut)}")
        rep("OK" if len(stale) <= max(3, len(ev) * 0.02) else "WARN", code, "5일 지난 미종료 경기(연기·수집 누락)", f"{len(stale)}")
        selfp = [e for e in ev if e[1] == e[2]]
        dup = [k for k, v in Counter((e[1], e[2]) for e in ev).items() if v > 1]
        rep("OK" if not selfp else "FAIL", code, "자기 자신과 경기", f"{len(selfp)}")
        rep("OK" if not dup else "WARN", code, "같은 홈·원정 대진 2회 이상(리그 방식에 따라 정상일 수 있음)", f"{len(dup)}")
        teams = {r[0] for r in c.execute("SELECT id FROM teams")}
        orphan_ev = [e for e in ev if e[1] not in teams or e[2] not in teams]
        rep("OK" if not orphan_ev else "FAIL", code, "경기의 팀이 teams 에 있음", f"없음 {len(orphan_ev)}")
        if st_sid is not None:
            st = c.execute("SELECT team_id, matches, wins, draws, losses, gf, ga, points FROM league_standings WHERE season_id = ?", (st_sid,)).fetchall()
            mism = standings_vs_events(fin, st)
            # 순위표가 경기 수집보다 앞서거나(당일) 늦을 수 있어 1경기 차이는 WARN
            rep("OK" if not mism else "WARN", code, "공식 순위표 = 경기 결과 합산", f"불일치 {len(mism)}/{len(st)}팀" + (f" 예: {mism[0]}" if mism else ""))
            bp = [t for t, m, w, d, l, gf, ga, p in st if p != 3 * w + d]
            rep("OK" if not bp else "WARN", code, "승점 = 3승+무", f"불일치 {len(bp)} (감점이면 정상)")
            so = [t for t, *_ in st if t not in teams]
            rep("OK" if not so else "FAIL", code, "순위표 팀이 teams 에 있음", f"없음 {len(so)}")
        # 선수
        pl = c.execute("SELECT id, team_id, name, birth_date, height FROM players").fetchall()
        op = [p for p in pl if p[1] not in teams]
        bh = [p for p in pl if p[4] and not (150 <= p[4] <= 210)]
        dn = [k for k, v in Counter((p[2], p[3]) for p in pl if p[3]).items() if v > 1]
        rep("OK" if not op else "WARN", code, "선수 소속 팀이 teams 에 있음", f"{len(pl)}명 · 없음 {len(op)}")
        rep("OK" if not bh else "WARN", code, "선수 키 범위 150~210", f"밖 {len(bh)}" + (f" 예: {bh[0][2]} {bh[0][4]}" if bh else ""))
        rep("OK" if not dn else "WARN", code, "같은 이름·생년월일 선수 중복", f"{len(dn)}" + (f" 예: {dn[0]}" if dn else ""))
        if has(c, "player_stats"):
            ps = c.execute("""SELECT COUNT(*), SUM(minutes_played < 0), SUM(minutes_played > COALESCE(appearances,0) * 130 + 30),
                                     SUM(player_id NOT IN (SELECT id FROM players)), SUM(rating > 0 AND (rating < 1 OR rating > 10)),
                                     SUM(goals < 0 OR assists < 0)
                              FROM player_stats WHERE season_id = (SELECT MAX(season_id) FROM player_stats)""").fetchone()
            rep("OK" if not any(ps[1:]) else "WARN", code, "선수 시즌 기록(음수 출전·출전시간>경기×130·고아·평점 1~10 밖·음수 골)",
                f"{ps[0]}행 · {ps[1] or 0}/{ps[2] or 0}/{ps[3] or 0}/{ps[4] or 0}/{ps[5] or 0}")
        if has(c, "match_player_stats") and c.execute("SELECT 1 FROM match_player_stats LIMIT 1").fetchone():
            g = defaultdict(int)
            for eid, tid, goals in c.execute("SELECT event_id, team_id, SUM(COALESCE(goals,0)) FROM match_player_stats GROUP BY 1, 2"):
                g[(eid, tid)] = goals
            have = {k[0] for k in g}
            fin_h = [e for e in fin if e[0] in have]
            over = [e for e in fin_h if g.get((e[0], e[1]), 0) > e[3] or g.get((e[0], e[2]), 0) > e[4]]
            rep("OK" if not over else "WARN", code, "선수 득점 합 ≤ 팀 스코어(자책골이면 작을 수 있음)", f"초과 {len(over)}/{len(fin_h)}")
        if has(c, "match_lineups") and c.execute("SELECT 1 FROM match_lineups LIMIT 1").fetchone():
            lu = defaultdict(list)
            for eid, ih, grid in c.execute("""SELECT l.event_id, l.is_home, l.formation_slot FROM match_lineups l JOIN events e ON e.id = l.event_id
                                              WHERE l.is_starter = 1 AND e.season_id = ?""", (sid,)):
                lu[(eid, ih)].append(grid)
            n11 = sum(1 for v in lu.values() if len(v) == 11)
            okf = sum(1 for v in lu.values() if formation_from_grids(v))
            rep("OK" if lu and n11 / len(lu) >= 0.98 and okf / len(lu) >= 0.9 else "WARN", code, "라인업 선발 11명·포메이션 복원",
                f"11명 {n11}/{len(lu)} · 복원 {okf}/{len(lu)}")
            dupl = c.execute("SELECT COUNT(*) FROM (SELECT event_id, player_id FROM match_lineups GROUP BY 1, 2 HAVING COUNT(*) > 1)").fetchone()[0]
            rep("OK" if not dupl else "FAIL", code, "라인업 같은 경기 같은 선수 중복", f"{dupl}")
    finally:
        c.close()


# ── K리그 ────────────────────────────────────────────────────────────
def audit_kleague(path):
    c = ro(path)
    if not c:
        return
    try:
        for tid, A in ((410, "K1"), (777, "K2")):
            ev = c.execute("""SELECT id, home_team_id, away_team_id, home_score, away_score, date_ts FROM events
                              WHERE tournament_id = ? AND date_ts >= strftime('%s', '2026-01-01')""", (tid,)).fetchall()
            fin = [e for e in ev if e[3] is not None and e[4] is not None]
            half = [e for e in ev if (e[3] is None) != (e[4] is None)]
            dup = [k for k, v in Counter((e[1], e[2], e[5] // 86400) for e in ev).items() if v > 1]
            rep("OK" if not half and not dup else "FAIL", A, "2026 경기 무결성(한쪽 스코어·같은 날 같은 대진 중복)",
                f"경기 {len(ev)}(종료 {len(fin)}) · 한쪽 {len(half)} · 중복 {len(dup)}")
            per = Counter()
            for e in fin:
                per[e[1]] += 1; per[e[2]] += 1
            spread = (min(per.values()), max(per.values())) if per else (0, 0)
            rep("OK" if spread[1] - spread[0] <= 2 else "WARN", A, "팀별 종료 경기 수 편차 ≤ 2", f"{spread}")
            ids = [e[0] for e in fin]
            ph = ",".join("?" * len(ids)) or "NULL"
            g = defaultdict(int)
            for eid, ih, goals in c.execute(f"""SELECT event_id, is_home, SUM(COALESCE(goals,0)) FROM match_player_stats
                                                WHERE event_id IN ({ph}) GROUP BY 1, 2""", ids):
                g[(eid, ih)] = goals
            have = {k[0] for k in g}
            fh = [e for e in fin if e[0] in have]
            over = [e for e in fh if g.get((e[0], 1), 0) > e[3] or g.get((e[0], 0), 0) > e[4]]
            rep("OK" if not over else "WARN", A, "선수 득점 합 ≤ 스코어", f"초과 {len(over)}/{len(fh)} (경기별 선수 기록 {len(fh)}/{len(fin)}경기)")
        tm = {r[0] for r in c.execute("SELECT id FROM teams")}
        op = c.execute("SELECT COUNT(*) FROM players WHERE team_id IS NOT NULL AND team_id NOT IN (SELECT id FROM teams)").fetchone()[0]
        rep("OK" if not op else "WARN", "K리그", "선수 소속 팀이 teams 에 있음", f"없음 {op} / 팀 {len(tm)}")
        if has(c, "heatmap_points"):
            oh = c.execute("SELECT COUNT(*) FROM (SELECT DISTINCT event_id FROM heatmap_points WHERE event_id NOT IN (SELECT id FROM events))").fetchone()[0]
            bad = c.execute("SELECT COUNT(*) FROM heatmap_points WHERE x < 0 OR x > 100 OR y < 0 OR y > 100").fetchone()[0]
            rep("OK" if not oh and not bad else "WARN", "K리그", "히트맵 고아 경기·좌표 범위(0~100)", f"고아 경기 {oh} · 범위 밖 {bad}")
        if has(c, "kleague_event_map"):
            d = c.execute("SELECT COUNT(*) FROM (SELECT sofa_event_id FROM kleague_event_map GROUP BY 1 HAVING COUNT(*) > 1)").fetchone()[0]
            rep("OK" if not d else "WARN", "K리그", "공식 일정 ↔ 경기 매핑 1:1", f"한 경기 여러 매핑 {d}")
        mps = c.execute("""SELECT COUNT(*), SUM(minutes_played IS NULL), SUM(rating IS NULL) FROM match_player_stats m
                           JOIN events e ON e.id = m.event_id WHERE e.tournament_id = 410 AND e.date_ts >= strftime('%s', '2026-01-01')""").fetchone()
        rep("OK" if (mps[1] or 0) <= mps[0] * 0.05 else "WARN", "K1", "경기별 선수 기록 출전시간·평점 NULL(11/30 크론 재시도 대상)",
            f"{mps[0]}행 · 시간 NULL {mps[1]} · 평점 NULL {mps[2]}")
    finally:
        c.close()


# ── Transfermarkt ────────────────────────────────────────────────────
def audit_tm(path):
    c = ro(path)
    if not c:
        return
    try:
        d1 = c.execute("SELECT COUNT(*) FROM (SELECT league_code, player_id FROM tm_map GROUP BY 1, 2 HAVING COUNT(*) > 1)").fetchone()[0]
        rep("OK" if not d1 else "FAIL", "TM", "우리 선수 1명 → TM 1명", f"여러 TM 연결 {d1}")
        orphan = c.execute("SELECT COUNT(*) FROM tm_map WHERE tm_player_id NOT IN (SELECT player_id FROM tm_players)").fetchone()[0]
        rep("OK" if not orphan else "FAIL", "TM", "연결표의 TM 선수 존재", f"고아 {orphan}")
        h = c.execute("""SELECT COUNT(*), SUM(p.height > 0 AND (p.height < 150 OR p.height > 215)), SUM(COALESCE(p.foot, '') NOT IN ('', 'left', 'right', 'both'))
                         FROM tm_map m JOIN tm_players p ON p.player_id = m.tm_player_id""").fetchone()
        rep("OK" if not (h[1] or h[2]) else "WARN", "TM", "연결 선수 키 범위·주발 값", f"{h[0]}명 · 키 이상 {h[1]} · 주발 이상 {h[2]}")
        mv = c.execute("SELECT SUM(market_value < 0), MAX(market_value) FROM tm_players").fetchone()
        rep("OK" if not mv[0] and (mv[1] or 0) <= 300_000_000 else "WARN", "TM", "시장가치 범위(0~€300M)", f"음수 {mv[0]} · 최대 €{(mv[1] or 0) / 1e6:.0f}M")
        meta = dict(c.execute("SELECT key, value FROM tm_meta").fetchall()) if has(c, "tm_meta") else {}
        rep("OK", "TM", "적재 메타", json.dumps({k: meta[k] for k in list(meta)[:4]}, ensure_ascii=False))
    finally:
        c.close()


# ── API 응답 정합성 ───────────────────────────────────────────────────
def get(base, path):
    with urllib.request.urlopen(base + path, timeout=60) as r:
        return json.load(r)


def audit_api(base):
    L = get(base, "/api/leagues")
    L = L if isinstance(L, list) else L.get("leagues", [])
    for lg in L:
        code = lg["code"]
        if code == "kleague" or lg.get("standingsOnly"):
            continue
        st = get(base, f"/api/league/{code}/standings")
        ranks = [r["rank"] for r in st]
        rep("OK" if ranks == list(range(1, len(ranks) + 1)) else "FAIL", code, "API 순위표 순위 1..N 연속", f"{len(ranks)}팀")
        if lg.get("hasTeamXg"):
            x = get(base, f"/api/league/{code}/team-xg")
            t = [r for r in x["teams"] if r.get("xpts") is not None]
            badx = [r["name"] for r in t if not (0 <= r["xpts"] <= 3 * r["xg_games"] + 1e-6) or r["pts_x"] > 3 * r["xg_games"]]
            tot_x = sum(r["xpts"] for r in t); tot_g = sum(r["xg_games"] for r in t)
            # 경기당 두 팀 xPts 합 = 3 − P(무) → 팀-경기당 평균 1.2~1.5 근처
            avg = tot_x / tot_g if tot_g else None
            rep("OK" if not badx and (avg is None or 1.0 <= avg <= 1.6) else "WARN", code, "xPts 범위·팀-경기당 평균(1.0~1.6)",
                f"이상 {len(badx)} · 평균 {avg:.2f}" if avg else "-")
            v = x.get("validation") or {}
            rr = [v.get(k) for k in ("r_pts", "r_gd", "r_xgd", "r_xpts") if v.get(k) is not None]
            rep("OK" if all(-1 <= r <= 1 for r in rr) else "FAIL", code, "예측력 r ∈ [-1, 1]", f"{rr}")
        if lg.get("hasSquadValue"):
            sv = get(base, f"/api/squad-value?league={code}")
            vr = [r["value_rank"] for r in sv["teams"] if r["value_rank"]]
            rep("OK" if sorted(vr) == list(range(1, len(vr) + 1)) else "FAIL", code, "스쿼드 가치 순위 1..N 중복 없음", f"{len(vr)}팀")
    for k in ("k1", "k2"):
        sv = get(base, f"/api/squad-value?league={k}")
        vr = [r["value_rank"] for r in sv["teams"] if r["value_rank"]]
        rep("OK" if sorted(vr) == list(range(1, len(vr) + 1)) else "FAIL", k.upper(), "스쿼드 가치 순위 1..N", f"{len(vr)}팀 · 연결 {sv['coverage']}")
    xv = get(base, "/api/overseas-xg-validation")
    rep("OK" if xv["pooled"]["n_teams"] == sum(l["n_teams"] for l in xv["leagues"]) else "FAIL", "xG검증", "합산 팀 수 = 리그별 합",
        f"{xv['pooled']['n_teams']}팀 · {xv['pooled']['n_leagues']}리그")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", help="실행 중인 앱 주소(예: http://127.0.0.1:5000) — 주면 API 응답 점검도")
    a = ap.parse_args()
    for p in sorted(glob.glob(os.path.join(ROOT, "*.db"))):
        name = os.path.basename(p)
        if name in ("players.db", "transfermarkt.db"):
            continue
        try:
            audit_overseas(p)
        except sqlite3.Error as e:
            rep("FAIL", name[:-3], "DB 읽기 오류", str(e))
    audit_kleague(os.path.join(ROOT, "players.db"))
    audit_tm(os.path.join(ROOT, "transfermarkt.db"))
    if a.api:
        try:
            audit_api(a.api.rstrip("/"))
        except Exception as e:      # 앱 오류도 결과로 남김
            rep("FAIL", "API", "API 점검 중 오류", repr(e)[:200])
    cnt = Counter(r[0] for r in res)
    print(f"\n요약: {dict(cnt)}")
    for lv in ("FAIL", "WARN"):
        for r in res:
            if r[0] == lv:
                print(f"  {lv} {r[1]} — {r[2]} {r[3]}")
    sys.exit(1 if cnt.get("FAIL") else 0)
