#!/usr/bin/env python3
"""
득점·카드·교체 기록의 비어 있는 선수 ID(NULL)를 '그 경기 출전 선수 명단'의 한글 이름으로 채운다.

배경 (2026-11-10): 공식 API로 복구한 과거 시즌 기록은 선수 ID 해석률이 낮다(2023~25 백필 1,938/5,927).
공식 피드의 등번호가 경기 당시가 아니라 선수의 '현재' 번호라 등번호 매칭이 어긋나기 때문.
→ 같은 경기·같은 팀 match_player_stats 의 선수 중 players.name_ko(공백 제거)가 기록의 이름과 정확히 1명 일치할 때만 채운다.
   모호하면(동명이인) 그대로 NULL. 이미 있는 ID는 건드리지 않는다.

사용:
  python crawlers/resolve_event_player_ids.py --since 2023-01-01           # dry-run
  python crawlers/resolve_event_player_ids.py --since 2023-01-01 --apply
"""
import argparse
import re
import sqlite3
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = str(Path(__file__).resolve().parent.parent / "players.db")


def norm(s):
    return re.sub(r"[\s·.\-()]", "", s or "")


def main():
    ap = argparse.ArgumentParser(description="이벤트 선수 ID 재해석 (기본 dry-run)")
    ap.add_argument("--since", default="2023-01-01")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()
    conn = sqlite3.connect(args.db, timeout=60)

    roster_cache = {}
    def roster(eid, tid):
        k = (eid, tid)
        if k not in roster_cache:
            m = {}
            for pid, nk, pn in conn.execute(
                    """SELECT DISTINCT s.player_id, p.name_ko, s.player_name FROM match_player_stats s
                       LEFT JOIN players p ON p.id = s.player_id WHERE s.event_id = ? AND s.team_id = ?""", (eid, tid)):
                for nm in {norm(nk), norm(pn)} - {""}:
                    m.setdefault(nm, set()).add(pid)
            roster_cache[k] = m
        return roster_cache[k]

    # ② 공식 경로: 같은 경기 공식 선수 기록(kleague_player_match: 공식 이름·K-ID) → kleague_player_map(K-ID → SofaScore ID).
    #    과거 선수는 players.name_ko 가 비고 mps.player_name 이 영문이라 ①로는 안 맞는 경우가 많다.
    off_cache = {}
    def official(eid):
        if eid not in off_cache:
            m = {}
            try:
                for nm, sid in conn.execute(
                        """SELECT k.player_name, mp.sofa_player_id FROM kleague_player_match k
                           JOIN kleague_player_map mp ON mp.player_kid = k.player_kid
                           WHERE k.event_id = ? AND mp.sofa_player_id IS NOT NULL""", (eid,)):
                    if norm(nm):
                        m.setdefault(norm(nm), set()).add(sid)
            except sqlite3.OperationalError:
                pass
            off_cache[eid] = m
        return off_cache[eid]

    def resolve(eid, tid, name):
        hit = roster(eid, tid).get(norm(name))
        if hit and len(hit) == 1:
            return next(iter(hit))
        hit = official(eid).get(norm(name))
        return next(iter(hit)) if hit and len(hit) == 1 else None

    plans = [
        ("goal_events", "id", "player_id", "player_name"),
        ("card_events", "id", "player_id", "player_name"),
        ("sub_events", "id", "player_in_id", "player_in_name"),
        ("sub_events", "id", "player_out_id", "player_out_name"),
    ]
    total = {}
    for table, key, idcol, namecol in plans:
        rows = conn.execute(f"""SELECT t.{key}, t.event_id, t.team_id, t.{namecol} FROM {table} t JOIN events e ON e.id = t.event_id
                                WHERE t.{idcol} IS NULL AND t.{namecol} IS NOT NULL AND t.{namecol} != ''
                                  AND e.date_ts >= strftime('%s', ?)""", (args.since,)).fetchall()
        fixed = []
        for rid, eid, tid, name in rows:
            pid = resolve(eid, tid, name)
            if pid:
                fixed.append((pid, rid))
        if args.apply and fixed:
            with conn:   # 비어 있는 칸만 — 다른 실행이 먼저 채웠으면 건너뜀
                conn.executemany(f"UPDATE {table} SET {idcol} = ? WHERE {key} = ? AND {idcol} IS NULL", fixed)
        total[f"{table}.{idcol}"] = (len(fixed), len(rows))
        print(f"  {table}.{idcol}: 비어 있음 {len(rows)} → 해석 {len(fixed)}")
    left = {}
    for table, key, idcol, namecol in plans:
        n, all_ = conn.execute(f"""SELECT SUM(t.{idcol} IS NULL), COUNT(*) FROM {table} t JOIN events e ON e.id = t.event_id
                                   WHERE e.date_ts >= strftime('%s', ?)""", (args.since,)).fetchone()
        left[f"{table}.{idcol}"] = f"{(all_ - (n or 0))}/{all_}"
    print(f"[{'APPLY' if args.apply else 'DRY-RUN'}] 해석 {sum(v[0] for v in total.values())}건 · "
          f"현재 ID 보유율 {left}" + ("" if args.apply else " (dry-run: 적용 전 수치)"))
    conn.close()


if __name__ == "__main__":
    main()
