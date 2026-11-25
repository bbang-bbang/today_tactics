"""해외 리그 팀 xG 집계 (2026-11-25) — API-Football /fixtures/statistics 경기별 팀 기록(match_team_stats) 기반.

경기당 지표: xG 득/실, xG 차, 득점−xG(결정력·운), 실점−xGA(골키퍼·운), 박스 안 슈팅 비율, 점유율.
xG 가 없는 경기는 xG 지표에서 빼고(xg_games), 슈팅·점유율은 전체 경기로 계산한다.
공급자 오류 방어(정합성 감사 2026-11-25): 슈팅 5개 이상인데 xG 0.0 → 없음 처리(브라질 세리에B 3건 실측).
"""

XG_MIN_GAMES = 3        # API 노출 시 xG 지표를 보이는 팀별 최소 경기 수 — 1~2경기 평균은 운에 크게 흔들림
_GLITCH_SHOTS = 5


def _r(v, n=2):
    return round(v, n) if v is not None else None


def _valid_xg(xg, shots):
    """xG 0.0 인데 슈팅이 5개 이상이면 공급자 오류로 보고 None."""
    if xg is None:
        return None
    if xg == 0 and (shots or 0) >= _GLITCH_SHOTS:
        return None
    return xg


def _norm(g):
    """(event, team, is_home, xg, shots, inside, poss, gf, ga, opp_xg[, opp_shots]) → 오류 정리된 (…, xg, opp_xg)."""
    eid, tid, h, xg, shots, inside, poss, gf, ga, oxg = g[:10]
    oshots = g[10] if len(g) > 10 else None
    return eid, tid, h, _valid_xg(xg, shots), shots, inside, poss, gf, ga, _valid_xg(oxg, oshots)


def xg_coverage(games):
    """xG 제공률 — 양 팀 xG 가 모두 정상인 경기 / 전체 경기 (경기 단위)."""
    ev = {}
    for g in games:
        n = _norm(g)
        ev[n[0]] = ev.get(n[0], True) and n[3] is not None and n[9] is not None
    tot, ok = len(ev), sum(ev.values())
    return {"games": tot, "xg_games": ok, "pct": round(ok / tot * 100, 1) if tot else None}


def team_xg_table(games, min_games=1):
    """games = [(event_id, team_id, is_home, xg, shots, shots_inside, possession, goals_for, goals_against, opp_xg[, opp_shots])].
    팀별 경기당 지표 리스트 — xG 차 큰 순(없으면 뒤). xG 있는 경기가 min_games 미만인 팀은 xG 지표 None."""
    acc = {}
    for g in games:
        _eid, tid, _h, xg, shots, inside, poss, gf, ga, oxg = _norm(g)
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
        ok = n >= max(1, min_games)
        out.append({
            "team_id": tid, "games": a["games"], "xg_games": n,
            "xg_for": _r(a["xg"] / n) if ok else None,
            "xg_against": _r(a["xga"] / n) if ok else None,
            "xg_diff": _r((a["xg"] - a["xga"]) / n) if ok else None,
            "g_minus_xg": _r((a["gf_x"] - a["xg"]) / n) if ok else None,
            "ga_minus_xga": _r((a["ga_x"] - a["xga"]) / n) if ok else None,
            "xg_total": _r(a["xg"], 1) if ok else None,
            "goals_for": a["gf"], "goals_against": a["ga"],
            "shots_pg": _r(a["shots"] / a["games"], 1) if a["games"] else None,
            "box_share": _r(a["inside"] / a["shots"] * 100, 1) if a["shots"] else None,
            "possession": _r(sum(a["poss"]) / len(a["poss"]), 1) if a["poss"] else None,
        })
    out.sort(key=lambda r: (r["xg_diff"] is None, -(r["xg_diff"] or 0)))
    return out
