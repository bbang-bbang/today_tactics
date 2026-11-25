"""스쿼드 시장가치 vs 성적 (2026-11-25) — K리그·해외 리그 공통.

시장가치 = Transfermarkt 추정치(transfermarkt.db, 기준일 2025-06 이후 값만 — main._tm_values).
가치 순위는 시장가치가 있는 팀끼리, 차이 = 가치 순위 − 실제 순위 (+ 면 몸값보다 성적이 좋음).
"""


def squad_value_table(teams, players):
    """teams = [{team_id, name, rank, pts, played}] (실제 순위), players = [(team_id, market_value 또는 None)] — 연결된 선수.
    반환: 실제 순위 순 리스트 {team_id, name, rank, pts, played, value, n_linked, n_valued, value_rank, diff, value_per_pt_m}."""
    agg = {}
    for tid, v in players:
        a = agg.setdefault(tid, [0, 0, 0])      # 합계, 연결 수, 값 있는 수
        a[1] += 1
        if v:
            a[0] += v
            a[2] += 1
    rows = []
    for t in teams:
        a = agg.get(t["team_id"], [0, 0, 0])
        rows.append({**t, "value": a[0] if a[2] else None, "n_linked": a[1], "n_valued": a[2]})
    valued = sorted((r for r in rows if r["value"]), key=lambda r: -r["value"])
    vr = {r["team_id"]: i + 1 for i, r in enumerate(valued)}
    for r in rows:
        r["value_rank"] = vr.get(r["team_id"])
        r["diff"] = (r["value_rank"] - r["rank"]) if r["value_rank"] and r.get("rank") else None
        r["value_per_pt_m"] = round(r["value"] / 1e6 / r["pts"], 2) if r["value"] and r.get("pts") else None
    rows.sort(key=lambda r: (r.get("rank") is None, r.get("rank") or 0))
    return rows
