"""해외 리그 팀 리포트 집계 (2026-11-25) — 순위 흐름·최근 폼·포메이션 분포.

순위 흐름은 리그 DB events 의 경기 결과로 직접 계산한다(라운드 값이 있으면 라운드 기준, 없으면 팀 경기 날짜 기준).
동점 처리 = 승점 → 득실차 → 다득점 (유럽 주요 리그 공통 근사 — 리그별 세부 규정(상대 전적·승수 등)과 다를 수 있음).
최종 순위는 화면에서 공식 순위표(league_standings)를 함께 보여 준다.
"""
from collections import Counter

from overseas_formation import formation_from_grids, formation_family


def _finished(games):
    return [g for g in games if g[5] is not None and g[6] is not None]


def _table(games):
    t = {}
    for _e, _r, _d, h, a, hs, as_ in games:
        for tid, gf, ga in ((h, hs, as_), (a, as_, hs)):
            x = t.setdefault(tid, [0, 0, 0])          # 승점, 득점, 실점
            x[0] += 3 if gf > ga else 1 if gf == ga else 0
            x[1] += gf
            x[2] += ga
    return t


def _rank_of(table, team_id):
    order = sorted(table, key=lambda k: (-table[k][0], -(table[k][1] - table[k][2]), -table[k][1], k))
    return order.index(team_id) + 1


def rank_flow(games, team_id):
    """games = [(event_id, round, date_ts, home, away, hs, as)] → 팀이 뛴 라운드(또는 경기일)마다
    {round, date_ts, rank, pts, n, res('W'|'D'|'L'), gf, ga}."""
    fin = _finished(games)
    mine = sorted((g for g in fin if team_id in (g[3], g[4])), key=lambda g: (g[1] if g[1] is not None else 0, g[2] or 0))
    if not mine:
        return []
    by_round = all(g[1] is not None for g in fin)
    teams = {g[3] for g in fin} | {g[4] for g in fin}
    out = []
    for g in mine:
        if by_round:
            upto = [x for x in fin if x[1] <= g[1]]
        else:
            upto = [x for x in fin if (x[2] or 0) <= (g[2] or 0)]
        table = _table(upto)
        home = g[3] == team_id
        gf, ga = (g[5], g[6]) if home else (g[6], g[5])
        out.append({"round": g[1], "date_ts": g[2], "rank": _rank_of(table, team_id), "pts": table[team_id][0],
                    "n": len(teams), "res": "W" if gf > ga else "D" if gf == ga else "L", "gf": gf, "ga": ga})
    return out


def recent_form(games, team_id, n=5):
    """최근 n경기 결과 'W'/'D'/'L' — 최신 먼저(날짜 기준)."""
    mine = sorted((g for g in _finished(games) if team_id in (g[3], g[4])), key=lambda g: -(g[2] or 0))[:n]
    res = []
    for g in mine:
        gf, ga = (g[5], g[6]) if g[3] == team_id else (g[6], g[5])
        res.append("W" if gf > ga else "D" if gf == ga else "L")
    return res


def formation_summary(rows):
    """rows = [(event_id, grid)] (한 팀 선발) → {list: [{formation, n}] 빈도순, family: {'4백': n, '3백': n}, n: 복원 경기 수}."""
    per = {}
    for ev, grid in rows:
        per.setdefault(ev, []).append(grid)
    cnt = Counter(f for f in (formation_from_grids(v) for v in per.values()) if f)
    fam = Counter()
    for f, k in cnt.items():
        if formation_family(f):
            fam[formation_family(f)] += k
    return {"list": [{"formation": f, "n": k} for f, k in sorted(cnt.items(), key=lambda x: (-x[1], x[0]))],
            "family": dict(fam), "n": sum(cnt.values())}
