#!/usr/bin/env python3
"""
해외 리그 선발 라인업 수집 → 세부 포지션(detail_pos) 라벨. 2026-11-19.

API-Football /players 는 포지션을 G/D/M/F 4분류로만 준다(걷어내기·크로스·제공권도 없어 기록으로 세부 추정은
K리그 교차검증 기준 정확도 ~80%, 수비형/공격형 MF는 사실상 불가). 대신 /fixtures/lineups 가 경기마다
포메이션과 선발 11명의 grid("줄:열")를 주므로, K리그와 같은 방식(포메이션 + 슬롯 → 세부 포지션,
crawlers/backfill_detail_positions.detail_positions)으로 라벨을 만든다.

저장: 각 리그 DB 의 기존 match_lineups (스키마 변경 없음) — event_id=API fixture id, formation_slot=grid,
      slot_order=슬롯 순서(0~10), detail_pos=GK/CB/FB/WB/DM/CM/AM/W/ST. 선발만 저장(교체 선수는 grid 없음).
증분: match_lineups 에 이미 있는 경기는 건너뜀. 라인업 미제공 경기는 저장하지 않아 다음 실행에서 재시도.

사용:
  python crawlers/collect_apifootball_lineups.py --league epl                  # dry-run (일정 1회 + 표본 1경기, 저장 안 함)
  python crawlers/collect_apifootball_lineups.py --league all --apply --max-calls 3000
호출 한도는 collect_apifootball.Client 와 같다(--max-calls · 응답 헤더 '오늘 남은 호출' ≤ --reserve 면 중단).
"""
import argparse
import sqlite3
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "crawlers"))
from collect_apifootball import (   # noqa: E402
    LEAGUES, DB_FILES, FINISHED, NO_MATCH_STATS, ALIASES, Client, load_key, f_int,
)
from backfill_detail_positions import detail_positions   # noqa: E402


def parse_grid(g):
    """'2:3' → (2, 3). 형식이 다르면 None."""
    try:
        r, c = str(g).split(":")
        return int(r), int(c)
    except (ValueError, AttributeError):
        return None


def label_team(formation, start_xi):
    """선발 11명 → [(player_dict, grid, slot_order, detail_pos)]. 정렬 근거: 줄 → 열(좌우 대칭이라 방향 무관).
    포메이션 줄 구성(1-4-2-3-1 등)과 grid 줄별 인원이 어긋나면 detail_pos=None(라벨 신뢰 불가)."""
    items = []
    for x in start_xi or []:
        p = (x or {}).get("player") or {}
        rc = parse_grid(p.get("grid"))
        if p.get("id") and rc:
            items.append((rc, p))
    items.sort(key=lambda t: t[0])
    labels = detail_positions(formation) if len(items) == 11 else None
    if labels:
        try:    # 포메이션 줄 구성과 실제 grid 줄 인원 대조
            want = [1] + [int(n) for n in formation.strip().split("-")]
            got = {}
            for (r, _c), _p in items:
                got[r] = got.get(r, 0) + 1
            if [got.get(r, 0) for r in range(1, len(want) + 1)] != want:
                labels = None
        except ValueError:
            labels = None
    out = []
    for i, ((r, c), p) in enumerate(items):
        out.append((p, f"{r}:{c}", i, labels[i] if labels else None))
    return out


def collect(cli, code, apply):
    lid, season, _tid, with_players = LEAGUES[code]
    if not with_players or code in NO_MATCH_STATS:
        print(f"  [{code}] 건너뜀 (순위표만 수집하는 리그)", flush=True)
        return
    db = ROOT / DB_FILES[code]
    if not db.exists():
        print(f"  [{code}] DB 없음 — 건너뜀", flush=True)
        return
    fixtures = cli.get(f"/fixtures?league={lid}&season={season}").get("response") or []
    done = [f for f in fixtures if ((f.get("fixture") or {}).get("status") or {}).get("short") in FINISHED]
    conn = sqlite3.connect(db, timeout=60)
    try:
        have = {r[0] for r in conn.execute("SELECT DISTINCT event_id FROM match_lineups")}
        todo = [f for f in done if f["fixture"]["id"] not in have]
        print(f"  [{code}] 종료 {len(done)}경기 · 새로 받을 경기 {len(todo)} (호출 누계 {cli.calls} · 오늘 남은 {cli.remaining})", flush=True)
        n_fx = n_rows = n_unlabeled = 0
        for i, f in enumerate(todo):
            fid = f["fixture"]["id"]
            home_id = ((f.get("teams") or {}).get("home") or {}).get("id")
            resp = cli.get(f"/fixtures/lineups?fixture={fid}").get("response") or []
            rows = []
            for side in resp:
                team_id = (side.get("team") or {}).get("id")
                for p, grid, slot, detail in label_team(side.get("formation"), side.get("startXI")):
                    if detail is None:
                        n_unlabeled += 1
                    rows.append((fid, p["id"], team_id, int(team_id == home_id), 1, p.get("pos"),
                                 grid, slot, f_int(p.get("number")), detail))
            if not rows:
                continue   # 라인업 미제공 — 다음 실행에서 재시도
            n_fx += 1
            n_rows += len(rows)
            if not apply:
                print(f"  (dry-run 표본 {fid}: {resp[0].get('formation')} → "
                      f"{[(r[6], r[9]) for r in rows[:11]]} · 저장 안 함)")
                return
            with conn:
                conn.executemany("""INSERT OR REPLACE INTO match_lineups (event_id, player_id, team_id, is_home, is_starter,
                                    position, formation_slot, slot_order, jersey_number, detail_pos)
                                    VALUES (?,?,?,?,?,?,?,?,?,?)""", rows)
            if n_fx % 25 == 0:
                print(f"    … {n_fx}/{len(todo)}경기 (호출 누계 {cli.calls} · 오늘 남은 {cli.remaining})", flush=True)
        print(f"  [{code}] 저장: 경기 {n_fx} · 선발 {n_rows}행 · 라벨 불가(포메이션/grid 불일치) {n_unlabeled}행", flush=True)
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description="API-Football 해외 선발 라인업 → 세부 포지션 (기본 dry-run)")
    ap.add_argument("--league", required=True, help=f"{', '.join(LEAGUES)} · top · lower · all — 쉼표로 여러 개")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-calls", type=int, default=400, help="이번 실행 최대 호출 수 (경기당 1회 + 리그당 일정 1회)")
    ap.add_argument("--reserve", type=int, default=500, help="오늘 남은 호출이 이 이하가 되면 중단 (다른 수집 크론 몫 보존)")
    args = ap.parse_args()
    cli = Client(load_key(), args.max_calls, args.reserve)
    codes = []
    for part in args.league.split(","):
        for c in ALIASES.get(part.strip(), [part.strip()]):
            if c not in codes:
                codes.append(c)
    for c in codes:
        if c not in LEAGUES:
            raise SystemExit(f"알 수 없는 리그: {c}")
    try:
        for c in codes:
            collect(cli, c, args.apply)
    except RuntimeError as e:
        print(f"[중단] {e}")
    print(f"\n총 호출 {cli.calls} · 오늘 남은 {cli.remaining}")


if __name__ == "__main__":
    main()
