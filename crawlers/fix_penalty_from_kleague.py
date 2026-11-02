#!/usr/bin/env python3
"""K리그 공식 슈팅 데이터(getShootData)의 PK 구분으로 goal_events.is_penalty 보정.

배경: collect_kleague_events.py(STEP 21, SofaScore incidents 차단 대체)는 공식 이벤트 피드에
PK 구분이 없어 복구 득점을 전부 is_penalty=0으로 저장한다 → PK 득점 통계·경기 요약 PK 표시가 틀림.

  POST https://www.kleague.com/api/ddf/match/getShootData.do
       (multipart: MEET_YEAR, MEET_SEQ, GAME_ID, homeTeam, awayTeam=K-ID)
  → data.shootEvent[{type_DETAIL_CD: 'GL'(득점)…, type_DETAIL_CD2: 'PK'|'', ha_CODE: H|A,
                     back_NO, player_NAME, period_ID, min_TIME, sec_TIME, own_GOAL_CODE: Y|N}]
  ※ 유효슈팅·블록·득점만 수록(빗나간 슛 없음) — 득점(GL)만 쓰므로 무관.

매칭: 공식 PK 득점(GL+PK, 자책 아님) ↔ 같은 경기 goal_events 중
      같은 득점 측(is_home = H) · 자책 아님 · 시각 차 ≤ 2분 · (등번호→mps 선수 ID 일치 또는 이름 일치 우선).
보정: 매칭된 득점이 is_penalty=0이면 is_penalty=1, goal_type='penalty'.
      반대(DB는 PK인데 공식은 아님)는 바꾸지 않고 보고만 한다(SofaScore 원본 존중).
안전장치: 공식 득점(GL) 수 ≠ DB 득점 수인 경기는 건너뜀(불완전/미공개).

사용:
  python crawlers/fix_penalty_from_kleague.py                 # dry-run: 일치율 + 보정 대상 출력
  python crawlers/fix_penalty_from_kleague.py --apply         # 보정
  python crawlers/fix_penalty_from_kleague.py --days 30 --apply   # update_data 정기 실행용
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import fetch_health   # 5건 이상 시도했는데 성공 0이면 exit 3

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = str(Path(__file__).resolve().parent.parent / "players.db")
API = "https://www.kleague.com/api/ddf/match/getShootData.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
DELAY = 0.4
TIMEOUT = 25
DEFAULT_SINCE = "2026-01-01"
MINUTE_TOL = 2

TARGET_SQL = """
SELECT e.id, e.home_score, e.away_score, m.year, m.meet_seq, m.game_id, s.home_kid, s.away_kid
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
JOIN kleague_schedule s ON s.year = m.year AND s.league_id = m.league_id
                       AND s.game_id = m.game_id AND s.meet_seq = m.meet_seq
WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
  AND e.home_score + e.away_score > 0
  AND e.date_ts >= ?
  AND EXISTS (SELECT 1 FROM goal_events g WHERE g.event_id = e.id)
ORDER BY e.date_ts
"""


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch_shots(year, meet_seq, game_id, home_kid, away_kid, retries=2):
    boundary = uuid.uuid4().hex
    fields = {"MEET_YEAR": year, "MEET_SEQ": meet_seq, "GAME_ID": game_id, "homeTeam": home_kid, "awayTeam": away_kid}
    body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                    for k, v in fields.items()) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": "https://www.kleague.com/match.do",
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    err = ""
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                d = json.loads(r.read().decode("utf-8"))
            if str(d.get("resultCode")) != "200":
                return None, f"resultCode={d.get('resultCode')!r}"
            return (d.get("data") or {}).get("shootEvent") or [], ""
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            err = f"{type(e).__name__}: {e}"
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    return None, err


def official_goals(shots):
    """→ [(is_home, clock_min, back_no, name, is_pk)] 자책골 제외. clock_min = min_TIME + 1 (경기 표기 분)."""
    out = []
    for s in shots:
        if s.get("type_DETAIL_CD") != "GL" or s.get("own_GOAL_CODE") == "Y":
            continue
        try:
            clock = int(s.get("min_TIME")) + 1
            back = int(s.get("back_NO")) if s.get("back_NO") not in (None, "") else None
        except (TypeError, ValueError):
            continue
        out.append((1 if s.get("ha_CODE") == "H" else 0, clock, back, (s.get("player_NAME") or "").strip(),
                    s.get("type_DETAIL_CD2") == "PK"))
    return out


def match_goals(conn, eid, off):
    """공식 득점 → DB goal_events 행 1:1 매칭. → [(official, db_row)]"""
    db = conn.execute("""SELECT g.id, g.is_home, g.minute + COALESCE(g.added_time, 0) AS clk, g.player_id,
                                g.player_name, g.is_penalty, s.shirt_number, p.name_ko
                         FROM goal_events g
                         LEFT JOIN match_player_stats s ON s.event_id = g.event_id AND s.player_id = g.player_id
                         LEFT JOIN players p ON p.id = g.player_id
                         WHERE g.event_id = ? AND g.is_own_goal = 0""", (eid,)).fetchall()
    used, pairs = set(), []
    for o in off:
        is_home, clock, back, name, _ = o
        cands = []
        for r in db:
            if r["id"] in used or r["is_home"] != is_home or abs(r["clk"] - clock) > MINUTE_TOL:
                continue
            same_player = (back is not None and r["shirt_number"] == back) or \
                          (name and name in ((r["name_ko"] or ""), (r["player_name"] or "")))
            cands.append((0 if same_player else 1, abs(r["clk"] - clock), r))
        if cands:
            cands.sort(key=lambda c: (c[0], c[1]))
            used.add(cands[0][2]["id"])
            pairs.append((o, cands[0][2]))
    return pairs


def main() -> None:
    ap = argparse.ArgumentParser(description="공식 슈팅 데이터 PK 구분 → goal_events.is_penalty 보정 (기본 dry-run)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--since", default=DEFAULT_SINCE)
    ap.add_argument("--days", type=int, help="최근 N일 경기만 (지정 시 --since 무시)")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    since_ts = int(time.time()) - args.days * 86400 if args.days else \
        int(time.mktime(time.strptime(args.since, "%Y-%m-%d")))
    targets = conn.execute(TARGET_SQL, (since_ts,)).fetchall()
    log(f"[{'APPLY' if args.apply else 'DRY-RUN'}] 득점 있는 경기 {len(targets)}")

    st = {"games": 0, "pending": 0, "count_mismatch": 0, "failed": 0, "matched": 0, "unmatched": 0,
          "both_pk": 0, "both_not": 0, "fix": 0, "db_only_pk": 0}
    fixes = []
    for ev in targets:
        shots, err = fetch_shots(ev["year"], ev["meet_seq"], ev["game_id"], ev["home_kid"], ev["away_kid"])
        time.sleep(DELAY)
        if shots is None:
            st["failed"] += 1
            log(f"  [{ev['id']}] 응답 실패 ({err})")
            continue
        if not shots:
            st["pending"] += 1          # 미공개(다음 날 공개) — 다음 실행에서 재시도
            continue
        all_gl = sum(1 for s in shots if s.get("type_DETAIL_CD") == "GL")
        db_n = conn.execute("SELECT COUNT(*) FROM goal_events WHERE event_id=?", (ev["id"],)).fetchone()[0]
        if all_gl != db_n:
            st["count_mismatch"] += 1
            continue
        st["games"] += 1
        off = official_goals(shots)
        pairs = match_goals(conn, ev["id"], off)
        st["matched"] += len(pairs)
        st["unmatched"] += len(off) - len(pairs)
        for o, r in pairs:
            pk = o[4]
            if pk and r["is_penalty"]:
                st["both_pk"] += 1
            elif not pk and not r["is_penalty"]:
                st["both_not"] += 1
            elif pk and not r["is_penalty"]:
                st["fix"] += 1
                fixes.append((r["id"], ev["id"], r["player_name"], r["clk"]))
            else:
                st["db_only_pk"] += 1
                log(f"  [{ev['id']}] DB는 PK, 공식은 PK 아님: {r['player_name']} {r['clk']}' (변경 안 함)")

    log(f"\n대조 경기 {st['games']} (미공개 {st['pending']} · 득점 수 불일치 건너뜀 {st['count_mismatch']} · 실패 {st['failed']})")
    log(f"득점 매칭 {st['matched']} (미매칭 {st['unmatched']})")
    log(f"  둘 다 PK {st['both_pk']} · 둘 다 아님 {st['both_not']} · 공식만 PK(보정 대상) {st['fix']} · DB만 PK {st['db_only_pk']}")
    for gid, eid, name, clk in fixes:
        log(f"  보정 대상: goal id={gid} event={eid} {name} {clk}'")
    if args.apply and fixes:
        with conn:
            conn.executemany("UPDATE goal_events SET is_penalty = 1, goal_type = 'penalty' WHERE id = ? AND is_penalty = 0",
                             [(f[0],) for f in fixes])
        log(f"보정 완료: {len(fixes)}건")
    conn.close()
    done = st["games"] + st["pending"] + st["count_mismatch"]
    fetch_health.abort_if_all_failed(done, done + st["failed"], log, "kleague getShootData")


if __name__ == "__main__":
    main()
