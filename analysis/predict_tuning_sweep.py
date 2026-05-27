#!/usr/bin/env python3
"""
미탐색 매개변수 스윕 (READ-ONLY): decay / shrinkage_k / SOS.
_predict_core를 직접 호출(decay·apply_sos 인자) + shrinkage_k는 _league_coefs monkeypatch.
과적합 경계: in-sample 최대 hit이 아니라 양 리그 + brier 동반 개선만 채택 권고.

사용: ./venv/bin/python analysis/predict_tuning_sweep.py
"""
import sys, os, sqlite3
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main  # noqa: E402


def backtest(tid, year, decay=None, sos=False, shrink_override=None):
    orig = main._league_coefs
    if shrink_override is not None:
        base = dict(orig(tid)); base["shrinkage_k"] = shrink_override
        main._league_coefs = lambda t, _b=base, _t=tid, _o=orig: (_b if t == _t else _o(t))
    conn = sqlite3.connect(main.DB_PATH); cur = conn.cursor()
    cur.execute("""SELECT id,date_ts,home_team_id,away_team_id,home_score,away_score
        FROM events WHERE tournament_id=? AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND strftime('%Y',datetime(date_ts,'unixepoch','localtime'))=? ORDER BY date_ts ASC""", (tid, year))
    games = cur.fetchall()
    n = hit = 0; brier = 0.0
    for gid, ts, hid, aid, hs, as_ in games:
        p = main._predict_core(cur, hid, aid, tid, ts, year, apply_sos=sos, decay=decay)
        if not p: continue
        n += 1
        actual = "home" if hs > as_ else "away" if hs < as_ else "draw"
        op = {"home": p["pred_home"], "draw": p["pred_draw"], "away": p["pred_away"]}
        if max(op, key=op.get) == actual: hit += 1
        ap = {k: (1 if actual == k else 0) for k in op}
        brier += sum((op[k]/100.0 - ap[k])**2 for k in op) / 3
    conn.close()
    main._league_coefs = orig
    return {"n": n, "hit": round(100*hit/n, 1), "brier": round(brier/n, 4)}


def run(tid, label):
    print(f"\n{'='*64}\n  {label} (tid={tid})\n{'='*64}")
    base = backtest(tid, "2026")
    print(f"  baseline               hit={base['hit']}% brier={base['brier']}")
    def cmp(r):
        return ("↑" if r["hit"] > base["hit"] else "↓" if r["hit"] < base["hit"] else "=",
                "↑good" if r["brier"] < base["brier"] else "↓worse" if r["brier"] > base["brier"] else "=")
    print("  --- decay 스윕 (기본 0.88) ---")
    for d in (0.80, 0.84, 0.88, 0.90, 0.93, 0.96):
        r = backtest(tid, "2026", decay=d); h, b = cmp(r)
        print(f"  decay={d:<5} hit={r['hit']}% {h} brier={r['brier']} {b}")
    print("  --- shrinkage_k 스윕 ---")
    for k in (0, 2, 3, 5, 8, 12):
        r = backtest(tid, "2026", shrink_override=k); h, b = cmp(r)
        print(f"  shrink_k={k:<3} hit={r['hit']}% {h} brier={r['brier']} {b}")
    print("  --- SOS on (기본 off) ---")
    r = backtest(tid, "2026", sos=True); h, b = cmp(r)
    print(f"  sos=ON      hit={r['hit']}% {h} brier={r['brier']} {b}")


if __name__ == "__main__":
    print("미탐색 매개변수 스윕 — decay / shrinkage_k / SOS (프로덕션 무변경)")
    run(410, "K1")
    run(777, "K2")
