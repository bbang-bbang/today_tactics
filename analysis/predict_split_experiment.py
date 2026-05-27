#!/usr/bin/env python3
"""
실험 B: 홈/원정 분리 레이팅 오프라인 검증 (READ-ONLY, 프로덕션 무변경).

가설: 팀은 홈·원정에서 다르게 수행 → 홈팀은 홈 레이팅, 원정팀은 원정 레이팅을 쓰면
변별력↑. 단 표본 절반이라 overall 레이팅으로 shrinkage 블렌드 필요(blend_k 스윕).

blended_for = (venue_wf + blend_k * overall_for) / (venue_wt + blend_k)
  - venue_wt 클수록 venue 우세, 작을수록 overall로 수렴 (cold-start 안전)
  - blend_k=∞ 면 baseline(전부 overall)과 동일 → 연속적 비교

baseline은 main._predict_core(분리 없음)와 동일 로직으로 재현해 사과-대-사과 비교.
sweep: blend_k ∈ {2,4,6,10,20} + baseline(분리 없음).

사용: ./venv/bin/python analysis/predict_split_experiment.py
"""
import sys, os, sqlite3

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main  # noqa: E402

DECAY = main._DECAY_LAMBDA


def _league_avg(cur, tid, year, as_of):
    cur.execute("""
        SELECT AVG(home_score + away_score) / 2.0 FROM events
        WHERE tournament_id=? AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=? AND date_ts < ?
    """, (tid, year, as_of))
    r = cur.fetchone()
    return float(r[0]) if r and r[0] else 1.3


def _weighted_sums(cur, ss, tid, year, as_of, venue):
    """venue: None(전체)/'home'/'away'. 반환 (wf, wa, wt, games) — decay 가중 합."""
    years = "('2024','2025','2026')" if tid == 410 else "('2025','2026')"
    if venue == "home":
        venue_clause = "e.home_team_id=?"
        params_venue = (ss,)
    elif venue == "away":
        venue_clause = "e.away_team_id=?"
        params_venue = (ss,)
    else:
        venue_clause = "(e.home_team_id=? OR e.away_team_id=?)"
        params_venue = (ss, ss)
    cur.execute(f"""
        SELECT e.id, e.home_team_id=? AS is_home, e.home_score, e.away_score,
               mps_agg.xg_for, mps_agg.xg_against
        FROM events e
        LEFT JOIN (
            SELECT event_id,
                   SUM(CASE WHEN team_id=? AND expected_goals IS NOT NULL THEN expected_goals END) AS xg_for,
                   SUM(CASE WHEN team_id IS NOT NULL AND team_id != ? AND expected_goals IS NOT NULL THEN expected_goals END) AS xg_against
            FROM match_player_stats GROUP BY event_id
        ) mps_agg ON mps_agg.event_id=e.id
        WHERE e.tournament_id=? AND {venue_clause}
          AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL AND e.date_ts < ?
          AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) IN {years}
        ORDER BY e.date_ts DESC
    """, (ss, ss, ss, tid, *params_venue, as_of))
    rows = cur.fetchall()
    wf = wa = wt = 0.0
    for rank, (_id, is_home, hs, as_, xgf, xga) in enumerate(rows):
        w = DECAY ** rank
        gf = hs if is_home else as_
        ga = as_ if is_home else hs
        wf += w * (float(xgf) if xgf is not None else float(gf or 0))
        wa += w * (float(xga) if xga is not None else float(ga or 0))
        wt += w
    return wf, wa, wt, len(rows)


def _overall_rate(cur, ss, tid, year, as_of, league_avg, shrink_k):
    wf, wa, wt, n = _weighted_sums(cur, ss, tid, year, as_of, None)
    if n == 0:
        return None
    if shrink_k > 0:
        return ((wf + shrink_k * league_avg) / (wt + shrink_k),
                (wa + shrink_k * league_avg) / (wt + shrink_k), n)
    return (wf / wt, wa / wt, n)


def predict(cur, h_ss, a_ss, tid, as_of, year, blend_k=None):
    """blend_k=None → baseline(분리 없음). 숫자면 홈/원정 분리 블렌드."""
    coefs = main._league_coefs(tid)
    shrink_k = coefs.get("shrinkage_k", 0)
    league_avg = _league_avg(cur, tid, year, as_of)

    ov_h = _overall_rate(cur, h_ss, tid, year, as_of, league_avg, shrink_k)
    ov_a = _overall_rate(cur, a_ss, tid, year, as_of, league_avg, shrink_k)
    if not ov_h or not ov_a:
        return None

    if blend_k is None:
        h_for, h_ag = ov_h[0], ov_h[1]
        a_for, a_ag = ov_a[0], ov_a[1]
    else:
        # 홈팀=홈 레이팅, 원정팀=원정 레이팅, overall로 블렌드
        hwf, hwa, hwt, _ = _weighted_sums(cur, h_ss, tid, year, as_of, "home")
        awf, awa, awt, _ = _weighted_sums(cur, a_ss, tid, year, as_of, "away")
        h_for = (hwf + blend_k * ov_h[0]) / (hwt + blend_k)
        h_ag  = (hwa + blend_k * ov_h[1]) / (hwt + blend_k)
        a_for = (awf + blend_k * ov_a[0]) / (awt + blend_k)
        a_ag  = (awa + blend_k * ov_a[1]) / (awt + blend_k)

    h_atk, h_def = h_for / league_avg, h_ag / league_avg
    a_atk, a_def = a_for / league_avg, a_ag / league_avg
    lam_h = max(0.1, h_atk * a_def * league_avg * coefs["home_adv"])
    lam_a = max(0.1, a_atk * h_def * league_avg * coefs["away_adj"])
    matrix = main._score_matrix(lam_h, lam_a, dc_rho=coefs.get("dc_rho", 0.0))
    out = main._matrix_outcomes(matrix, draw_boost=coefs.get("draw_boost", 0.0))
    return {"pred_home": out["home"], "pred_draw": out["draw"], "pred_away": out["away"],
            "lam_home": lam_h, "lam_away": lam_a, "top_scores": out["top_scores"]}


def backtest(tid, year, blend_k=None):
    conn = sqlite3.connect(main.DB_PATH); cur = conn.cursor()
    cur.execute("""SELECT id,date_ts,home_team_id,away_team_id,home_score,away_score
        FROM events WHERE tournament_id=? AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND strftime('%Y',datetime(date_ts,'unixepoch','localtime'))=? ORDER BY date_ts ASC""", (tid, year))
    games = cur.fetchall()
    n = hit = 0; brier = 0.0; dp = {"home":0,"draw":0,"away":0}
    for gid, ts, hid, aid, hs, as_ in games:
        p = predict(cur, hid, aid, tid, ts, year, blend_k)
        if not p: continue
        n += 1
        actual = "home" if hs > as_ else "away" if hs < as_ else "draw"
        op = {"home": p["pred_home"], "draw": p["pred_draw"], "away": p["pred_away"]}
        po = max(op, key=op.get)
        if po == actual: hit += 1
        dp[po] += 1
        ap = {k: (1 if actual == k else 0) for k in op}
        brier += sum((op[k]/100.0 - ap[k])**2 for k in op) / 3
    conn.close()
    return {"n": n, "hit": round(100*hit/n,1), "brier": round(brier/n,4), "dp": dp}


def run(tid, label):
    print(f"\n{'='*70}\n  {label} (tid={tid})\n{'='*70}")
    base = backtest(tid, "2026", None)
    print(f"  baseline(분리 없음)  hit={base['hit']}% brier={base['brier']} H/D/A={base['dp']['home']}/{base['dp']['draw']}/{base['dp']['away']}")
    for bk in (2, 4, 6, 10, 20):
        r = backtest(tid, "2026", bk)
        d = "↑" if r["hit"] > base["hit"] else ("↓" if r["hit"] < base["hit"] else "=")
        db = "↑good" if r["brier"] < base["brier"] else "↓worse"
        print(f"  split blend_k={bk:<3} hit={r['hit']}% {d} brier={r['brier']} {db} H/D/A={r['dp']['home']}/{r['dp']['draw']}/{r['dp']['away']}")


if __name__ == "__main__":
    print("실험 B: 홈/원정 분리 레이팅 — 오프라인 검증 (프로덕션 무변경)")
    run(410, "K1")
    run(777, "K2")
