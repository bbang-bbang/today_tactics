#!/usr/bin/env python3
"""새로 수집한 데이터 정합성·무결성 점검 (읽기 전용, 2026-11-25).
대상: J1·J2 리그 DB(API-Football) · match_team_stats(팀 xG) · transfermarkt.db(시장가치·연결표).
실행(서버): cd /opt/today_tactics && venv/bin/python analysis/audit_new_data.py
결과: 항목마다 OK / WARN / FAIL + 수치. DB 는 mode=ro 로만 연다."""
import os
import sqlite3
import sys
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
    print(f"[{level:4s}] {area:12s} {label} {detail}")


def ro(name):
    p = os.path.join(ROOT, name)
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True) if os.path.exists(p) else None


# ── J1 ──────────────────────────────────────────────────────────────
c = ro("jleague1.db")
if c:
    A = "J1"
    ev = c.execute("SELECT id, home_team_id, away_team_id, home_score, away_score, date_ts, season_id FROM events").fetchall()
    fin = [e for e in ev if e[3] is not None]
    rep("OK" if len(ev) == 380 else "WARN", A, "일정 경기 수", f"{len(ev)} (종료 {len(fin)})")
    dup = Counter((e[1], e[2], e[6]) for e in ev)
    d2 = [k for k, v in dup.items() if v > 1]
    rep("OK" if not d2 else "FAIL", A, "같은 대진 중복(시즌 내 홈·원정 1회씩)", f"{len(d2)}건")
    rep("OK" if {e[6] for e in ev} == {2027} else "WARN", A, "시즌 값", str({e[6] for e in ev}))
    half = [e for e in fin if (e[3] is None) != (e[4] is None)]
    rep("OK" if not half else "FAIL", A, "스코어 한쪽만 있는 경기", f"{len(half)}")
    # 순위표 vs 경기 결과
    agg = defaultdict(lambda: [0, 0, 0, 0, 0, 0])   # P W D L GF GA
    for _id, h, a, hs, as_, *_ in fin:
        for t, gf, ga in ((h, hs, as_), (a, as_, hs)):
            x = agg[t]; x[0] += 1; x[4] += gf; x[5] += ga
            x[1 if gf > ga else 2 if gf == ga else 3] += 1
    st = c.execute("SELECT team_id, matches, wins, draws, losses, gf, ga, points FROM league_standings WHERE season_id = 2027").fetchall()
    mism = [(t, (m, w, d, l, gf, ga), tuple(agg[t])) for t, m, w, d, l, gf, ga, _p in st if (m, w, d, l, gf, ga) != tuple(agg[t])]
    rep("OK" if not mism else "WARN", A, "순위표 = 경기 결과 합산(경기·승무패·득실)", f"불일치 {len(mism)}/{len(st)}팀" + (f" 예: {mism[0]}" if mism else ""))
    badpts = [t for t, m, w, d, l, gf, ga, p in st if p != 3 * w + d]
    rep("OK" if not badpts else "WARN", A, "승점 = 3승+무", f"불일치 {len(badpts)} (감점 팀이면 정상)")
    # 경기별 선수 기록 득점 합 vs 스코어
    g = defaultdict(int)
    for eid, tid, goals in c.execute("SELECT event_id, team_id, SUM(COALESCE(goals,0)) FROM match_player_stats GROUP BY event_id, team_id"):
        g[(eid, tid)] = goals
    gm = [e[0] for e in fin if g.get((e[0], e[1]), 0) != e[3] or g.get((e[0], e[2]), 0) != e[4]]
    have = {r[0] for r in c.execute("SELECT DISTINCT event_id FROM match_player_stats")}
    rep("OK" if len(have) >= len(fin) else "WARN", A, "경기별 선수 기록 보유 경기", f"{len(have & {e[0] for e in fin})}/{len(fin)}")
    rep("OK" if len(gm) <= len(fin) * 0.1 else "WARN", A, "선수 득점 합 = 스코어", f"불일치 {len(gm)}/{len(fin)} (자책골이면 정상 불일치)")
    # 라인업·포메이션
    lu = defaultdict(list)
    for eid, ih, grid in c.execute("SELECT event_id, is_home, formation_slot FROM match_lineups WHERE is_starter=1"):
        lu[(eid, ih)].append(grid)
    n11 = sum(1 for v in lu.values() if len(v) == 11)
    okf = sum(1 for v in lu.values() if formation_from_grids(v))
    rep("OK" if lu and okf / len(lu) >= 0.95 else "WARN", A, "라인업 선발 11명·포메이션 복원", f"11명 {n11}/{len(lu)} · 복원 {okf}/{len(lu)}")
    unl = c.execute("SELECT COUNT(*), SUM(detail_pos IS NULL) FROM match_lineups WHERE is_starter=1").fetchone()
    rep("OK" if (unl[1] or 0) <= unl[0] * 0.05 else "WARN", A, "세부 포지션 라벨", f"없음 {unl[1]}/{unl[0]}")
    # 팀 xG
    ts = c.execute("SELECT event_id, team_id, is_home, xg, shots, shots_on, shots_inside, possession FROM match_team_stats").fetchall()
    per = Counter(r[0] for r in ts)
    rep("OK" if all(v == 2 for v in per.values()) and len(per) == len(fin) else "WARN", A, "팀 기록: 종료 경기마다 두 팀",
        f"경기 {len(per)}/{len(fin)} · 2팀 아닌 경기 {sum(1 for v in per.values() if v != 2)}")
    xnull = [r for r in ts if r[3] is None]
    rep("OK" if len(xnull) <= len(ts) * 0.1 else "WARN", A, "xG 결측", f"{len(xnull)}/{len(ts)}행 ({len({r[0] for r in xnull})}경기) — 공급자 미제공")
    one_side = [e for e, v in Counter(r[0] for r in xnull).items() if v == 1]
    rep("OK" if not one_side else "WARN", A, "xG 한 팀만 있는 경기", f"{len(one_side)}")
    bad = [r for r in ts if r[4] is not None and ((r[5] or 0) > r[4] or (r[6] or 0) > r[4])]
    rep("OK" if not bad else "FAIL", A, "유효슈팅·박스 안 ≤ 전체 슈팅", f"위반 {len(bad)}")
    xr = [r[3] for r in ts if r[3] is not None]
    rep("OK" if xr and min(xr) >= 0 and max(xr) <= 7 else "WARN", A, "xG 범위", f"{min(xr):.2f}~{max(xr):.2f}" if xr else "-")
    poss = defaultdict(float)
    for r in ts:
        if r[7] is not None:
            poss[r[0]] += r[7]
    pbad = [e for e, v in poss.items() if abs(v - 100) > 1.5]
    rep("OK" if not pbad else "WARN", A, "두 팀 점유율 합 ≈ 100", f"벗어남 {len(pbad)}")
    # xG 와 실제 득점 상관(상식 점검)
    sc = {e[0]: (e[1], e[3], e[4]) for e in fin}
    pairs = [(r[3], sc[r[0]][1] if r[1] == sc[r[0]][0] else sc[r[0]][2]) for r in ts if r[3] is not None and r[0] in sc]
    if len(pairs) > 10:
        n = len(pairs); mx = sum(p[0] for p in pairs) / n; my = sum(p[1] for p in pairs) / n
        cov = sum((x - mx) * (y - my) for x, y in pairs); vx = sum((x - mx) ** 2 for x, _ in pairs); vy = sum((y - my) ** 2 for _, y in pairs)
        r_ = cov / (vx * vy) ** 0.5 if vx and vy else 0
        rep("OK" if r_ >= 0.3 else "WARN", A, "경기 xG ↔ 득점 상관", f"r={r_:.2f} · 평균 xG {mx:.2f} vs 득점 {my:.2f}")
    # 선수 시즌 기록
    ps = c.execute("SELECT COUNT(*), SUM(minutes_played < 0), SUM(team_id NOT IN (SELECT id FROM teams)) FROM player_stats JOIN players ON players.id = player_stats.player_id").fetchone()
    rep("OK" if not (ps[1] or ps[2]) else "WARN", A, "선수 시즌 기록", f"{ps[0]}명 · 음수 출전 {ps[1]} · 팀 없음 {ps[2]}")
    c.close()

# ── J2 ──────────────────────────────────────────────────────────────
c = ro("jleague2.db")
if c:
    A = "J2"
    st = c.execute("SELECT season_id, COUNT(*) FROM league_standings GROUP BY 1").fetchall()
    ps = c.execute("SELECT season_id, COUNT(*), SUM(minutes_played >= 900) FROM player_stats GROUP BY 1").fetchall()
    rep("OK", A, "순위표 시즌별 팀 수", str(st))
    rep("OK" if any(s == 2025 and n > 800 for s, n, _ in ps) else "WARN", A, "선수 기록 시즌별(영입 후보 = 2025)", str(ps))
    c.close()

# ── Transfermarkt ───────────────────────────────────────────────────
c = ro("transfermarkt.db")
if c:
    A = "TM"
    meta = dict(c.execute("SELECT key, value FROM tm_meta"))
    rep("OK", A, "적재 정보", f"{meta.get('imported_at')} · 시장가치 최신 {meta.get('last_valuation')}")
    n = dict(c.execute("SELECT 'players', COUNT(*) FROM tm_players UNION ALL SELECT 'vals', COUNT(*) FROM tm_valuations UNION ALL SELECT 'map', COUNT(*) FROM tm_map"))
    rep("OK", A, "행 수", str(n))
    orphan = c.execute("SELECT COUNT(*) FROM tm_map m LEFT JOIN tm_players p ON p.player_id = m.tm_player_id WHERE p.player_id IS NULL").fetchone()[0]
    rep("OK" if not orphan else "FAIL", A, "연결표 → TM 선수 존재", f"고아 {orphan}")
    dup = c.execute("SELECT league_code, tm_player_id, COUNT(*) FROM tm_map GROUP BY 1, 2 HAVING COUNT(*) > 1").fetchall()
    rep("OK" if not dup else "WARN", A, "같은 리그에서 TM 1명 ↔ 우리 선수 여러 명", f"{len(dup)}건" + (f" 예: {dup[:3]}" if dup else ""))
    nov = c.execute("SELECT COUNT(*) FROM tm_map m JOIN tm_players p ON p.player_id = m.tm_player_id WHERE p.market_value IS NULL").fetchone()[0]
    rep("OK", A, "연결됐지만 시장가치 없음", f"{nov}/{n['map']} (은퇴·하위 리그 등)")
    stale = c.execute("SELECT COUNT(*) FROM tm_map m JOIN tm_players p ON p.player_id = m.tm_player_id WHERE p.last_season < 2025").fetchone()[0]
    rep("OK" if stale <= n["map"] * 0.1 else "WARN", A, "연결 선수 중 TM 최근 시즌 < 2025", f"{stale} (데이터셋 밖으로 나간 선수 — 시장가치 오래됨)")
    # 교차 검증: 키·생년(연결 근거) 외 속성 — 우리 DB 키와 TM 키
    hd, hn = 0, 0
    for code in ("kleague", "jleague1", "epl"):
        path = "players.db" if code == "kleague" else f"{code}.db"
        o = ro(path)
        if not o:
            continue
        col = "height"
        ours = dict(o.execute(f"SELECT id, {col} FROM players WHERE {col} IS NOT NULL"))   # col 은 상수
        o.close()
        for pid, tmh in c.execute("SELECT m.player_id, p.height FROM tm_map m JOIN tm_players p ON p.player_id = m.tm_player_id WHERE m.league_code = ? AND p.height IS NOT NULL", (code,)):
            oh = ours.get(pid)
            if oh:
                try:
                    hn += 1
                    hd += abs(float(oh) - tmh) > 5
                except (TypeError, ValueError):
                    pass
    rep("OK" if hn and hd / hn <= 0.03 else "WARN", A, "교차 검증: 키 차이 > 5cm (오연결 신호)", f"{hd}/{hn}")
    c.close()

print("\n요약:", dict(Counter(r[0] for r in res)))
