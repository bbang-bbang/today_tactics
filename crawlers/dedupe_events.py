#!/usr/bin/env python3
"""같은 경기가 events 에 두 번 등록된 중복을 병합한다 (기본 dry-run, --apply 로 저장).

배경(2026-11-04 점검): K2 용인시티 경기 12건이 같은 홈/원정/일시로 두 번 등록돼 있었다.
한쪽(15403xxx)은 스코어·공식 기록이 있고 다른 쪽(1629996x·1630303x)은 점수 NULL인데,
득점·카드·교체 기록은 양쪽에 중복으로, 라인업은 점수 NULL 쪽에만 붙어 있었다.

규칙
- 그룹: 같은 (home_team_id, away_team_id) 이고 date_ts 가 ±12h 안인 events.
- 대표(canon) 선택: 스코어 있음 > 딸린 행 많음 > id 작음.
- 대표에 해당 테이블 행이 없으면 중복의 행을 대표로 '이동', 있으면 중복의 행은 '삭제'.
  단 득점·카드·교체(incident)는 더 많은 쪽 집합을 채택(덜 수집된 쪽을 버림).
- 대표의 NULL 메타(장소·라운드 등)는 중복 값으로 보강. 스코어가 서로 다르면 건너뛰고 사람 확인.
- 선수 경기 스탯(match_player_stats)이 양쪽에 모두 있으면 자동 병합하지 않고 건너뜀.
- 단일 트랜잭션 + 적용 전 SQLite 백업 + 적용 후 행 수 검증(실패 시 전체 롤백). 멱등.
"""
import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
INCIDENT_TABLES = {"goal_events", "card_events", "sub_events"}
KEY_COLS = ("event_id", "sofa_event_id")
WINDOW = 43200  # ±12h


def event_tables(conn):
    """event 를 참조하는 (테이블, 컬럼) 목록 — events 자신 제외."""
    out = []
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'events'"):
        cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{name}")')]   # 테이블명은 sqlite_master 값
        for k in KEY_COLS:
            if k in cols:
                out.append((name, k))
                break
    return out


def count(conn, table, col, eid):
    return conn.execute(f'SELECT COUNT(*) FROM "{table}" WHERE "{col}" = ?', (eid,)).fetchone()[0]


def find_groups(conn):
    rows = conn.execute(
        "SELECT id, home_team_id, away_team_id, date_ts, home_score, away_score FROM events "
        "WHERE home_team_id IS NOT NULL AND away_team_id IS NOT NULL AND date_ts IS NOT NULL "
        "ORDER BY home_team_id, away_team_id, date_ts, id").fetchall()
    groups, cur = [], []
    for r in rows:
        if cur and r[1] == cur[-1][1] and r[2] == cur[-1][2] and r[3] - cur[0][3] <= WINDOW:
            cur.append(r)
        else:
            if len(cur) > 1:
                groups.append(cur)
            cur = [r]
    if len(cur) > 1:
        groups.append(cur)
    return groups


def dep_total(conn, tables, eid):
    return sum(count(conn, t, c, eid) for t, c in tables)


def plan_group(conn, tables, grp):
    """그룹 하나의 병합 계획. 건너뛰면 (None, 사유)."""
    ev = []
    for (eid, h, a, ts, hs, as_) in grp:
        ev.append({"id": eid, "hs": hs, "as": as_, "dep": dep_total(conn, tables, eid),
                   "mps": count(conn, "match_player_stats", "event_id", eid)})
    scored = {(e["hs"], e["as"]) for e in ev if e["hs"] is not None}
    if len(scored) > 1:
        return None, f"스코어 불일치 {sorted(scored)} — 사람 확인"
    ev.sort(key=lambda e: (e["hs"] is None, -e["dep"], e["id"]))
    canon, dups = ev[0], ev[1:]
    if canon["mps"] and any(d["mps"] for d in dups):
        return None, "선수 경기 스탯이 양쪽에 있음 — 자동 병합 안 함"
    actions = []
    for d in dups:
        for t, c in tables:
            nd, nc = count(conn, t, c, d["id"]), count(conn, t, c, canon["id"])
            if nd == 0:
                continue
            if nc == 0:
                actions.append((d["id"], t, c, "move", nd, nc))
            elif t in INCIDENT_TABLES and nd > nc:
                actions.append((d["id"], t, c, "replace", nd, nc))     # 대표 행 삭제 후 중복 행 이동
            else:
                actions.append((d["id"], t, c, "drop", nd, nc))
    return {"canon": canon["id"], "dups": [d["id"] for d in dups], "actions": actions}, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "players.db"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir", default=str(ROOT))
    args = ap.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    tables = event_tables(conn)
    plans, skipped = [], []
    for grp in find_groups(conn):
        plan, why = plan_group(conn, tables, grp)
        (plans if plan else skipped).append(plan or (grp, why))

    print(f"[중복 병합] 대상 그룹 {len(plans)} · 건너뜀 {len(skipped)} · {'APPLY' if args.apply else 'DRY-RUN(저장 안 함)'}")
    for grp, why in skipped:
        print(f"  건너뜀 {[g[0] for g in grp]}: {why}")
    for p in plans:
        mv = [f"{t}:{k}({n})" for _, t, _, k, n, _ in p["actions"]]
        print(f"  대표 {p['canon']} ← 중복 {p['dups']}  " + (", ".join(mv) if mv else "(딸린 행 없음)"))
    if not args.apply or not plans:
        conn.close()
        return 0

    # 적용 전 백업 (SQLite online backup — 쓰기 중에도 일관)
    Path(args.backup_dir).mkdir(parents=True, exist_ok=True)
    bk = Path(args.backup_dir) / f"players_before_dedupe_{time.strftime('%Y%m%d_%H%M%S')}.db"
    dst = sqlite3.connect(str(bk))
    conn.backup(dst)
    dst.close()
    print(f"  백업: {bk} (확인 후 gzip 권장)")

    before = {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t, _ in tables}
    before_ev = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    expect = {t: 0 for t, _ in tables}          # 삭제로 줄어야 하는 행 수
    meta_cols = [r[1] for r in conn.execute("PRAGMA table_info(events)")
                 if r[1] not in ("id", "home_score", "away_score", "home_team_id", "away_team_id", "date_ts")]
    try:
        with conn:
            for p in plans:
                canon = p["canon"]
                for (eid, t, c, kind, nd, nc) in p["actions"]:
                    if kind == "move":
                        conn.execute(f'UPDATE "{t}" SET "{c}" = ? WHERE "{c}" = ?', (canon, eid))
                    elif kind == "replace":
                        conn.execute(f'DELETE FROM "{t}" WHERE "{c}" = ?', (canon,))
                        expect[t] += nc
                        conn.execute(f'UPDATE "{t}" SET "{c}" = ? WHERE "{c}" = ?', (canon, eid))
                    else:  # drop
                        conn.execute(f'DELETE FROM "{t}" WHERE "{c}" = ?', (eid,))
                        expect[t] += nd
                for d in p["dups"]:
                    for m in meta_cols:   # 대표의 NULL 메타를 중복 값으로 보강 (컬럼명은 PRAGMA 결과)
                        conn.execute(f'UPDATE events SET "{m}" = (SELECT "{m}" FROM events WHERE id = ?) '
                                     f'WHERE id = ? AND "{m}" IS NULL', (d, canon))
                    # 남은 딸린 행이 없어야 삭제 (move/drop/replace 후)
                    left = dep_total(conn, tables, d)
                    if left:
                        raise RuntimeError(f"이벤트 {d} 에 처리되지 않은 딸린 행 {left}")
                    conn.execute("DELETE FROM events WHERE id = ?", (d,))
            ndel = sum(len(p["dups"]) for p in plans)
            if conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] != before_ev - ndel:
                raise RuntimeError("events 행 수 불일치")
            for t, _ in tables:
                now = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                if now != before[t] - expect[t]:
                    raise RuntimeError(f"{t} 행 수 불일치: 기대 {before[t] - expect[t]} 실제 {now}")
    except Exception as e:
        print(f"[실패] 전체 롤백됨: {e}")
        conn.close()
        return 1
    conn.close()
    gen = ROOT / ".cache_generation"
    gen.write_text(str(time.time_ns()), encoding="ascii")
    os.utime(gen, None)
    print(f"[완료] {len(plans)}그룹 병합 · 삭제 이벤트 {ndel}건 · 행 수 검증 통과 · 캐시 세대 갱신")
    return 0


if __name__ == "__main__":
    sys.exit(main())
