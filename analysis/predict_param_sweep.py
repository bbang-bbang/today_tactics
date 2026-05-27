#!/usr/bin/env python3
"""
예측 모델 파라미터 오프라인 스윕 (READ-ONLY 분석, 프로덕션 무변경).

main._league_coefs를 monkeypatch해서 계수만 바꿔가며 rolling backtest 재실행.
look-ahead 차단은 _predict_core가 as_of_ts로 보장.

실험:
  A. draw_boost × dc_rho 스윕 (K1의 "draw 0개 예측" 미스캘리브레이션 검증)
  B. (후속) 홈/원정 분리 — 별도 스크립트

사용: ./venv/bin/python analysis/predict_param_sweep.py
"""
import sys, os, sqlite3, copy

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main  # noqa: E402


def run_backtest(tid, year, coefs_override=None):
    """단일 계수 설정으로 rolling backtest. coefs_override=None이면 현 운영 계수."""
    orig = main._league_coefs
    if coefs_override is not None:
        base = orig(tid)
        merged = dict(base)
        merged.update(coefs_override)
        main._league_coefs = lambda t, _o=orig, _t=tid, _m=merged: (_m if t == _t else _o(t))

    conn = sqlite3.connect(main.DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, date_ts, home_team_id, away_team_id, home_score, away_score
        FROM events
        WHERE tournament_id=? AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
        ORDER BY date_ts ASC
    """, (tid, year))
    games = cur.fetchall()

    n = hit = exact = top3 = 0
    brier_sum = 0.0
    dp = {"home": 0, "draw": 0, "away": 0}
    da = {"home": 0, "draw": 0, "away": 0}

    for gid, ts, hid, aid, hs, as_ in games:
        pred = main._predict_core(cur, hid, aid, tid, ts, year)
        if not pred:
            continue
        n += 1
        actual = "home" if hs > as_ else "away" if hs < as_ else "draw"
        op = {"home": pred["pred_home"], "draw": pred["pred_draw"], "away": pred["pred_away"]}
        po = max(op, key=op.get)
        if po == actual:
            hit += 1
        dp[po] += 1
        da[actual] += 1
        actual_str = f"{int(hs)}-{int(as_)}"
        top_strs = [f"{s['home']}-{s['away']}" for s in pred["top_scores"]]
        if top_strs and top_strs[0] == actual_str:
            exact += 1
        if actual_str in top_strs[:3]:
            top3 += 1
        ap = {k: (1 if actual == k else 0) for k in ("home", "draw", "away")}
        brier_sum += sum((op[k] / 100.0 - ap[k]) ** 2 for k in ("home", "draw", "away")) / 3

    conn.close()
    main._league_coefs = orig
    return {
        "n": n,
        "hit_pct": round(100 * hit / n, 1) if n else 0,
        "exact_pct": round(100 * exact / n, 1) if n else 0,
        "top3_pct": round(100 * top3 / n, 1) if n else 0,
        "brier": round(brier_sum / n, 4) if n else 0,
        "pred": dp,
        "actual": da,
    }


def fmt(r):
    return (f"n={r['n']:3d} hit={r['hit_pct']:5.1f}% exact={r['exact_pct']:4.1f}% "
            f"top3={r['top3_pct']:4.1f}% brier={r['brier']:.4f} "
            f"pred(H/D/A)={r['pred']['home']}/{r['pred']['draw']}/{r['pred']['away']}")


def sweep(tid, year, label):
    print(f"\n{'='*78}\n  {label} (tournament_id={tid}, year={year})\n{'='*78}")
    base = run_backtest(tid, year, None)
    print(f"  [baseline 운영계수]   {fmt(base)}")
    print(f"   실제(H/D/A)={base['actual']['home']}/{base['actual']['draw']}/{base['actual']['away']}")
    print(f"\n  --- draw_boost × dc_rho 스윕 ---")
    best = (base["hit_pct"], -base["brier"], "baseline", base)
    for db_ in (0.04, 0.08, 0.12, 0.16, 0.20, 0.24):
        for rho in (0.06, 0.10, 0.14):
            r = run_backtest(tid, year, {"draw_boost": db_, "dc_rho": rho})
            tag = f"db={db_:.2f} rho={rho:.2f}"
            flag = ""
            # 양쪽 개선 우선: hit↑ 이면서 brier 악화 작을 때
            if r["hit_pct"] > best[0] + 0.01 or (abs(r["hit_pct"] - best[0]) < 0.6 and -r["brier"] > best[1] + 0.0005):
                best = (r["hit_pct"], -r["brier"], tag, r)
                flag = " ★"
            print(f"  {tag:20s} {fmt(r)}{flag}")
    print(f"\n  >>> 최적 후보: {best[2]} | {fmt(best[3])}")
    return base, best


if __name__ == "__main__":
    print("예측 모델 파라미터 오프라인 스윕 — 프로덕션 무변경 (READ-ONLY)")
    print(f"DB: {main.DB_PATH}")
    sweep(410, "2026", "K1")
    sweep(777, "2026", "K2")
