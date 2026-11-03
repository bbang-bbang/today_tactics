#!/usr/bin/env python3
"""K리그 공식 선수 ID(kid) ↔ SofaScore 선수 ID 매핑 → kleague_player_map (공식 데이터 전환 2단계).

kleague_player_match(공식)와 match_player_stats(SofaScore)가 둘 다 있는 경기에서 경기마다 짝을 찾고,
선수별로 여러 경기의 표를 모아 일관될 때만 확정한다(잘못된 연결보다 미연결이 안전).

경기 안 짝찾기(같은 경기 · 같은 홈/원정):
  1) 이름: 공식 이름 == players.name_ko 또는 mps.player_name (정규화 후 유일할 때)
  2) 남은 선수끼리: 경기 당시 등번호(엔트리) == mps.shirt_number 이고 출전분이 정의 차이 범위 안
     (공식 − SofaScore 가 −3 ~ +25분: 공식은 추가시간 포함 실제 시간)
     ※ 공식 상세의 backNo 는 '현재' 번호라 쓰지 않는다. mps.shirt_number 도 일부 현재 번호라 출전분으로 함께 확인.
확정: 표 ≥ 2 이고 최다 후보 비율 ≥ 80% (표 1개면 이름 일치일 때만).
매핑 표에 없는 kid 는 공식 이름으로만 표시한다(SofaScore 연결 없음).

저장(신규 테이블, 롤백 = DROP TABLE kleague_player_map). 매번 전체 재계산(멱등).
사용: python crawlers/build_kleague_player_map.py [--apply]
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = str(Path(__file__).resolve().parent.parent / "players.db")
MIN_SHARE = 0.8

SCHEMA = """
CREATE TABLE IF NOT EXISTS kleague_player_map (
  player_kid     INTEGER PRIMARY KEY,
  sofa_player_id INTEGER NOT NULL,
  player_name    TEXT NOT NULL,
  votes          INTEGER NOT NULL,     -- 최다 후보 표 수
  total          INTEGER NOT NULL,     -- 전체 표 수
  method         TEXT NOT NULL,        -- name | shirt+minutes | mixed
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kpmap_sofa ON kleague_player_map(sofa_player_id);
"""


def norm(s: str) -> str:
    return re.sub(r"\(c\)|[\s·.\-]", "", s or "")


def pair_event(off_rows, sofa_rows):
    """한 경기 한 팀 → [(kid, sofa_pid, method)]"""
    out, used_k, used_s = [], set(), set()
    by_name = defaultdict(list)
    for s in sofa_rows:
        for n in {norm(s["nko"]), norm(s["nraw"])} - {""}:
            by_name[n].append(s["player_id"])
    for o in off_rows:
        c = set(by_name.get(norm(o["player_name"]), []))
        if len(c) == 1:
            pid = c.pop()
            if pid not in used_s:
                out.append((o["player_kid"], pid, "name"))
                used_k.add(o["player_kid"]); used_s.add(pid)
    for o in off_rows:
        if o["player_kid"] in used_k or o["back_no"] is None:
            continue
        c = [s for s in sofa_rows if s["player_id"] not in used_s and s["shirt_number"] == o["back_no"]
             and s["minutes_played"] is not None and -3 <= o["minutes"] - s["minutes_played"] <= 25]
        if len(c) == 1:
            out.append((o["player_kid"], c[0]["player_id"], "shirt+minutes"))
            used_k.add(o["player_kid"]); used_s.add(c[0]["player_id"])
    return out


def build(conn):
    votes = defaultdict(Counter)       # kid → Counter(sofa_pid)
    methods = defaultdict(Counter)     # (kid, pid) → Counter(method)
    names = {}
    evs = [r[0] for r in conn.execute(
        "SELECT DISTINCT k.event_id FROM kleague_player_match k WHERE EXISTS (SELECT 1 FROM match_player_stats m WHERE m.event_id = k.event_id)")]
    for eid in evs:
        for is_home in (1, 0):
            off = [dict(r) for r in conn.execute(
                "SELECT player_kid, player_name, back_no, minutes FROM kleague_player_match WHERE event_id = ? AND is_home = ?",
                (eid, is_home))]
            sofa = [dict(r) for r in conn.execute(
                """SELECT m.player_id, m.shirt_number, m.minutes_played, COALESCE(p.name_ko, '') AS nko, COALESCE(m.player_name, '') AS nraw
                   FROM match_player_stats m LEFT JOIN players p ON p.id = m.player_id
                   WHERE m.event_id = ? AND m.is_home = ? AND m.player_id IS NOT NULL""", (eid, is_home))]
            for o in off:
                names[o["player_kid"]] = o["player_name"]
            for kid, pid, how in pair_event(off, sofa):
                votes[kid][pid] += 1
                methods[(kid, pid)][how] += 1
    rows, rejected = [], 0
    for kid, cnt in votes.items():
        pid, top = cnt.most_common(1)[0]
        total = sum(cnt.values())
        m = methods[(kid, pid)]
        how = "name" if set(m) == {"name"} else ("shirt+minutes" if set(m) == {"shirt+minutes"} else "mixed")
        if top / total < MIN_SHARE or (total == 1 and how != "name"):
            rejected += 1
            continue
        rows.append((kid, pid, names.get(kid, ""), top, total, how))
    # 한 SofaScore 선수에 kid 가 여럿 붙으면(동명이인 오매칭 의심) 표가 가장 많은 것만 남긴다
    best = {}
    for r in rows:
        if r[1] not in best or r[3] > best[r[1]][3]:
            best[r[1]] = r
    dup = len(rows) - len(best)
    return list(best.values()), len(evs), len(votes), rejected, dup


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()
    conn = sqlite3.connect(args.db, timeout=30)
    conn.row_factory = sqlite3.Row
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kleague_player_match'").fetchone():
        print("[skip] kleague_player_match 없음 — collect_kleague_player_stats.py 먼저 실행")
        return
    rows, n_ev, n_kid, rejected, dup = build(conn)
    total_kids = conn.execute("SELECT COUNT(DISTINCT player_kid) FROM kleague_player_match").fetchone()[0]
    by = Counter(r[5] for r in rows)
    print(f"대조 경기 {n_ev} · 표가 있는 kid {n_kid} / 전체 kid {total_kids} → 확정 {len(rows)} "
          f"(이름 {by['name']}, 등번호+출전분 {by['shirt+minutes']}, 혼합 {by['mixed']}) · 불일치로 보류 {rejected} · 중복 제거 {dup}")
    if args.apply:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        with conn:
            conn.executescript(SCHEMA)
            conn.execute("DELETE FROM kleague_player_map")
            conn.executemany("INSERT INTO kleague_player_map VALUES (?,?,?,?,?,?,?)", [r + (now,) for r in rows])
        print(f"[ok] kleague_player_map {len(rows)}행 저장")
    conn.close()


if __name__ == "__main__":
    main()
