#!/usr/bin/env python3
"""SofaScore 라인업 차단 대체 — K리그 포털 라인업 + SofaScore 선수 스탯으로 `match_lineups` 복원.

배경(2026-11-02): 운영에서 SofaScore lineups가 9/20 이후 403(봇 챌린지). 그러나
  - `kleague_lineup`(포털 선발 11명 + 등번호 + 배치 좌표)은 계속 수집되고,
  - `match_player_stats`(SofaScore, 경기 엔트리 전원 + 등번호 + 포지션)도 대부분 수집된다.
→ (경기, 홈/원정, 등번호)로 이어 SofaScore 선수 ID 기반 라인업 행을 만든다.

검증(공백 이전 170경기, 2026-07~09): 선발 일치 3516/3520(99.9%).
세부 포지션: 포털 포메이션의 라인 인원수대로 깊이(top_pct) 순으로 묶고 라인 안은 left_pct 내림차순
  → slot_order. `backfill_detail_positions.py`(STEP 18)가 formation+slot_order로 detail_pos를 채운다.
  기존 SofaScore 슬롯 기반 detail_pos와 83.5% 일치(불일치는 두 소스가 CM↔W 등 역할을 다르게 본 경우).

저장 규칙:
  - 대상: match_lineups 행이 전혀 없는 종료 경기만 (SofaScore 원본이 있으면 절대 건드리지 않음).
  - 한쪽 팀이라도 선발 11명 전원의 SofaScore ID를 확정하지 못하면 그 경기는 저장하지 않음(부분 라인업 방지).
  - 벤치 = 같은 경기·같은 팀 mps 행 중 선발이 아닌 선수(출전 안 한 벤치 포함 — mps가 엔트리 전원 수록).
  - formation: 포털(fill_formation_from_kleague와 같은 원천). 못 받으면 NULL + 깊이·좌우 순 slot_order.
  - formation_sofa는 NULL(= SofaScore가 보고한 값 없음).
  - 경기 단위 트랜잭션. 원장 `kleague_recovery_log(kind='lineup')` 기록 → 롤백:
      DELETE FROM match_lineups WHERE event_id IN (SELECT event_id FROM kleague_recovery_log WHERE kind='lineup');
      DELETE FROM kleague_recovery_log WHERE kind='lineup';

사용:
  python crawlers/recover_lineups_kleague.py                # dry-run (기본, DB 변경 없음)
  python crawlers/recover_lineups_kleague.py --apply        # 저장
  python crawlers/recover_lineups_kleague.py --compare 50   # SofaScore 라인업이 있는 경기에서 복원 결과 대조 (읽기 전용)
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = Path(__file__).resolve().parent.parent
DB_PATH = str(BASE / "players.db")
DEFAULT_SINCE = "2026-07-01"

LEDGER_SCHEMA = """
CREATE TABLE IF NOT EXISTS kleague_recovery_log (
  event_id     INTEGER NOT NULL,
  kind         TEXT NOT NULL,              -- 'lineup' | 'heatmap'
  player_id    INTEGER NOT NULL DEFAULT 0, -- heatmap: SofaScore 선수 ID / lineup: 0
  rows         INTEGER NOT NULL,
  note         TEXT,
  recovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, kind, player_id)
) WITHOUT ROWID;
"""

TARGET_SQL = """
SELECT e.id, e.home_team_id, e.away_team_id, m.year, m.meet_seq, m.game_id
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
  AND e.date_ts >= ?
  AND NOT EXISTS (SELECT 1 FROM match_lineups l WHERE l.event_id = e.id)
  AND EXISTS (SELECT 1 FROM kleague_lineup k WHERE k.sofa_event_id = e.id)
ORDER BY e.date_ts
"""


def log(msg: str) -> None:
    print(msg, flush=True)


def norm_name(name: str) -> str:
    return re.sub(r"\(c\)|\s", "", name or "")


def parse_formation(f):
    """'4-2-3-1' → [4,2,3,1] (합 10일 때만)."""
    if not f:
        return None
    try:
        sizes = [int(x) for x in f.split("-")]
    except ValueError:
        return None
    return sizes if sum(sizes) == 10 and all(n > 0 for n in sizes) else None


def order_starters(starters, formation):
    """선발(dict: back_no, top, left) → slot 순서 리스트. GK(가장 깊은 선수) 먼저."""
    deep = sorted(starters, key=lambda s: -s["top"])
    sizes = parse_formation(formation)
    if not sizes:
        return sorted(starters, key=lambda s: (-s["top"], -s["left"]))
    out, i = [deep[0]], 1
    for n in sizes:
        out += sorted(deep[i:i + n], key=lambda s: -s["left"])
        i += n
    return out


def build_side(conn, eid, side, team_id, formation):
    """한 팀의 match_lineups 행 리스트, 또는 (None, 사유)."""
    is_home = 1 if side == "home" else 0
    starters = [{"back_no": r[0], "name": r[1], "top": r[2], "left": r[3]} for r in conn.execute(
        "SELECT back_no, player_name, top_pct, left_pct FROM kleague_lineup "
        "WHERE sofa_event_id=? AND side=? AND is_starter=1", (eid, side))]
    if len(starters) != 11:
        return None, f"{side} 포털 선발 {len(starters)}명"
    mps = conn.execute(
        "SELECT s.player_id, s.shirt_number, s.position, p.name, p.name_ko, s.minutes_played FROM match_player_stats s "
        "LEFT JOIN players p ON p.id = s.player_id WHERE s.event_id=? AND s.is_home=?", (eid, is_home)).fetchall()
    if not mps:
        return None, f"{side} SofaScore 선수 스탯 없음"
    played = {r[0]: (r[5] or 0) for r in mps}
    mps = [r[:5] for r in mps]
    by_shirt = {}
    for pid, shirt, pos, name, name_ko in mps:
        by_shirt.setdefault(shirt, []).append((pid, pos, name, name_ko))
    starter_ids = set()
    rows = []
    for slot, s in enumerate(order_starters(starters, formation)):
        cand = by_shirt.get(s["back_no"], [])
        if len(cand) != 1:   # 등번호 불일치/중복 → 같은 팀 mps에서 한글 이름으로 1명 확정 시도
            cand = [c for c in (x for v in by_shirt.values() for x in v)
                    if c[3] and norm_name(c[3]) == norm_name(s["name"])]
        if len(cand) > 1:    # SofaScore 중복 선수 등록(같은 이름·등번호, 한쪽은 미출전) → 실제 출전자가 1명이면 그 선수
            # 2026-11-10: 김해 #22 박상준 1634041(출전 없음) / 2188416(86분) 사례. 선발은 반드시 출전 >0.
            on_pitch = [c for c in cand if played.get(c[0], 0) > 0]
            if len(on_pitch) == 1:
                cand = on_pitch
        if len(cand) != 1:
            return None, f"{side} 선발 #{s['back_no']} {s['name']} SofaScore ID 미확정"
        pid, pos, name, _ = cand[0]
        if pid in starter_ids:
            return None, f"{side} 선발 ID 중복 {pid}"
        starter_ids.add(pid)
        rows.append((eid, team_id, is_home, formation, pid, name or s["name"], s["back_no"],
                     pos or None, 1, slot, 1))
    for pid, shirt, pos, name, name_ko in mps:
        if pid in starter_ids:
            continue
        rows.append((eid, team_id, is_home, formation, pid, name or name_ko, shirt, pos or None, 0, None, 1))
    return rows, ""


def portal_formations(targets):
    """{event_id: (home, away)} — fill_formation_from_kleague의 포털 조회 재사용. 실패 시 빈 dict."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import fill_formation_from_kleague as ff
    except Exception as e:
        log(f"  (포털 formation 모듈 로드 실패: {e} — formation 없이 진행)")
        return {}
    sid = ff.get_portal_session()
    if not sid:
        log("  (포털 세션 실패 — formation 없이 진행)")
        return {}
    out = {}
    for t in targets:
        html = ff.fetch_match_html(sid, t["game_id"], t["year"], t["meet_seq"])
        h, a = ff.parse_formations(html)
        out[t["id"]] = (h if parse_formation(h) else None, a if parse_formation(a) else None)
        time.sleep(0.3)
    return out


def compare(conn, limit):
    """SofaScore 라인업이 있는 경기에서 복원 결과를 원본과 대조 (읽기 전용)."""
    evs = conn.execute("""SELECT DISTINCT k.sofa_event_id FROM kleague_lineup k JOIN events e ON e.id = k.sofa_event_id
        WHERE EXISTS (SELECT 1 FROM match_lineups l WHERE l.event_id = k.sofa_event_id)
        ORDER BY e.date_ts DESC LIMIT ?""", (limit,)).fetchall()
    st_ok = st_tot = bench_ok = bench_tot = built = 0
    for (eid,) in evs:
        ev = conn.execute("SELECT home_team_id, away_team_id FROM events WHERE id=?", (eid,)).fetchone()
        for side, tid, ih in (("home", ev[0], 1), ("away", ev[1], 0)):
            f = conn.execute("SELECT formation FROM match_lineups WHERE event_id=? AND is_home=? LIMIT 1", (eid, ih)).fetchone()
            rows, why = build_side(conn, eid, side, tid, f[0] if f else None)
            if rows is None:
                continue
            built += 1
            orig = {r[0]: r[1] for r in conn.execute(
                "SELECT player_id, is_starter FROM match_lineups WHERE event_id=? AND is_home=?", (eid, ih))}
            for r in rows:
                if r[8] == 1:
                    st_tot += 1; st_ok += orig.get(r[4]) == 1
                else:
                    bench_tot += 1; bench_ok += orig.get(r[4]) == 0
    log(f"대조 {len(evs)}경기 · 복원 성공 {built}/{len(evs)*2}팀 · 선발 일치 {st_ok}/{st_tot} · 벤치 일치 {bench_ok}/{bench_tot}")


def main() -> None:
    ap = argparse.ArgumentParser(description="K리그 포털 라인업 + mps → match_lineups 복원 (기본 dry-run)")
    ap.add_argument("--apply", action="store_true", help="실제 저장 (없으면 dry-run)")
    ap.add_argument("--since", default=DEFAULT_SINCE, help=f"이 날짜 이후 경기만 (기본 {DEFAULT_SINCE})")
    ap.add_argument("--days", type=int, help="최근 N일 경기만 (지정 시 --since 무시 — update_data 정기 실행용)")
    ap.add_argument("--compare", type=int, metavar="N", help="SofaScore 라인업 보유 최근 N경기 대조 (읽기 전용)")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    if args.compare:
        compare(conn, args.compare)
        return
    if args.apply:
        conn.executescript(LEDGER_SCHEMA)
    since_ts = int(time.mktime(time.strptime(args.since, "%Y-%m-%d")))
    if args.days:
        since_ts = int(time.time()) - args.days * 86400
        args.since = f"최근 {args.days}일"
    targets = conn.execute(TARGET_SQL, (since_ts,)).fetchall()
    log(f"[{'APPLY(저장)' if args.apply else 'DRY-RUN(저장 안 함)'}] 라인업 없는 경기 {len(targets)} (since {args.since})")
    if not targets:
        return
    forms = portal_formations(targets)
    log(f"  포털 formation 확보 {sum(1 for v in forms.values() if v[0] and v[1])}/{len(targets)}경기")

    saved = skipped = 0
    total_rows = 0
    for t in targets:
        fh, fa = forms.get(t["id"], (None, None))
        home, why_h = build_side(conn, t["id"], "home", t["home_team_id"], fh)
        away, why_a = build_side(conn, t["id"], "away", t["away_team_id"], fa)
        if home is None or away is None:
            skipped += 1
            log(f"  [{t['id']}] 건너뜀 — {why_h or why_a}")
            continue
        rows = home + away
        saved += 1
        total_rows += len(rows)
        if args.apply:
            with conn:   # 경기 단위 트랜잭션
                conn.executemany(
                    "INSERT INTO match_lineups (event_id, team_id, is_home, formation, player_id, player_name, "
                    "shirt_number, position, is_starter, slot_order, confirmed) VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
                conn.execute("INSERT OR REPLACE INTO kleague_recovery_log (event_id, kind, player_id, rows, note) "
                             "VALUES (?, 'lineup', 0, ?, ?)",
                             (t["id"], len(rows), f"formation {fh or '-'} / {fa or '-'}"))
    conn.close()
    log(f"\n완료: 복원 {saved}경기({total_rows}행) / 건너뜀 {skipped}" + ("" if args.apply else " (dry-run: 저장 안 함)"))


if __name__ == "__main__":
    main()
