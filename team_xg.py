"""해외 리그 팀 xG 집계 (2026-11-25) — API-Football /fixtures/statistics 경기별 팀 기록(match_team_stats) 기반.

경기당 지표: xG 득/실, xG 차, 득점−xG(결정력·운), 실점−xGA(골키퍼·운), 박스 안 슈팅 비율, 점유율.
xG 가 없는 경기는 xG 지표에서 빼고(xg_games), 슈팅·점유율은 전체 경기로 계산한다.
"""


def _r(v, n=2):
    return round(v, n) if v is not None else None


def team_xg_table(games):
    """games = [(event_id, team_id, is_home, xg, shots, shots_inside, possession, goals_for, goals_against, opp_xg)].
    팀별 경기당 지표 리스트 — xG 차 큰 순(없으면 뒤)."""
    acc = {}
    for _eid, tid, _h, xg, shots, inside, poss, gf, ga, oxg in games:
        a = acc.setdefault(tid, {"games": 0, "xg_games": 0, "xg": 0.0, "xga": 0.0, "gf_x": 0, "ga_x": 0,
                                 "shots": 0, "inside": 0, "poss": [], "gf": 0, "ga": 0})
        a["games"] += 1
        a["gf"] += gf or 0
        a["ga"] += ga or 0
        a["shots"] += shots or 0
        a["inside"] += inside or 0
        if poss is not None:
            a["poss"].append(poss)
        if xg is not None and oxg is not None:
            a["xg_games"] += 1
            a["xg"] += xg
            a["xga"] += oxg
            a["gf_x"] += gf or 0
            a["ga_x"] += ga or 0
    out = []
    for tid, a in acc.items():
        n = a["xg_games"]
        out.append({
            "team_id": tid, "games": a["games"], "xg_games": n,
            "xg_for": _r(a["xg"] / n) if n else None,
            "xg_against": _r(a["xga"] / n) if n else None,
            "xg_diff": _r((a["xg"] - a["xga"]) / n) if n else None,
            "g_minus_xg": _r((a["gf_x"] - a["xg"]) / n) if n else None,
            "ga_minus_xga": _r((a["ga_x"] - a["xga"]) / n) if n else None,
            "xg_total": _r(a["xg"], 1) if n else None,
            "goals_for": a["gf"], "goals_against": a["ga"],
            "shots_pg": _r(a["shots"] / a["games"], 1) if a["games"] else None,
            "box_share": _r(a["inside"] / a["shots"] * 100, 1) if a["shots"] else None,
            "possession": _r(sum(a["poss"]) / len(a["poss"]), 1) if a["poss"] else None,
        })
    out.sort(key=lambda r: (r["xg_diff"] is None, -(r["xg_diff"] or 0)))
    return out
