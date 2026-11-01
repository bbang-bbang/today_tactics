#!/usr/bin/env python3
"""K리그 공식 API(getPassData) → 선수 간 패스 행렬(패스 네트워크) 수집.

  POST https://www.kleague.com/api/ddf/match/getPassData.do   (multipart: year, meetSeq, gameId, homeTeam, awayTeam)
  → data.passHome / passAway: {playerIds, playerNames, passMatrix{패스한선수:{받은선수:횟수}}, positionMap{선수:GK|DF|MF|FW}}

검증된 사실(2026-11-01, 표본):
  - 행=패스한 선수, 열=받은 선수 (행 합계 = 선수 상세의 성공 패스, 20=20·57=57).
  - 2020~2026 K1·K2 전 시즌에 존재(수집은 2023~ 만). 행렬 합계 ↔ SofaScore 성공 패스 상관 1.00.
  - 공개 시점은 경기 다음 날 — 빈 응답은 '미공개'로 보고 저장하지 않으며 다음 실행에서 재시도한다(실패로 세지 않음).
  - 이름은 라인업(kleague_lineup)과 '(c)'·공백 제거 후 100% 일치 → 선발 좌표를 붙인다.

저장(신규 테이블 3개, 기존 테이블 변경 없음 / 롤백 = DROP):
  kleague_pass_edge(event_id, team_id, passer_kid, receiver_kid, passes)
  kleague_pass_player(event_id, team_id, player_kid, player_name, position, is_starter, pos_top, pos_left)
  kleague_pass_match(event_id, team_id, players, total_passes, fetched_at)   ← 수집 원장(멱등 키)

사용:
  python crawlers/collect_kleague_passes.py                 # dry-run (기본, DB 변경 없음)
  python crawlers/collect_kleague_passes.py --apply         # 저장
  python crawlers/collect_kleague_passes.py --compare 6     # 선수 상세 성공 패스와 행 합계 대조 (읽기 전용)
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid

import fetch_health   # 5건 이상 시도했는데 성공 0이면 exit 3

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = "players.db"
BASE = "https://www.kleague.com/api/ddf/match/"
REFERER = "https://www.kleague.com/match.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
DELAY = 0.4
TIMEOUT = 25
DEFAULT_SINCE = "2023-01-01"        # 사용자 결정(2026-11-02): 2020~2022 시즌은 불필요 → 수집 범위에서 제외
MIN_TOTAL, MAX_TOTAL = 20, 1200      # 팀 총 패스 상식 범위(관측 평균 ≈ 408)
POSITIONS = {"GK", "DF", "MF", "FW"}
# 선수 상세의 세부 포지션(playerPos: CF·CM 등) → 4분류. 모르는 코드는 None.
POS_GROUP = {"GK": "GK",
             "CB": "DF", "LB": "DF", "RB": "DF", "LWB": "DF", "RWB": "DF", "WB": "DF", "SW": "DF", "DF": "DF",
             "CM": "MF", "AM": "MF", "DM": "MF", "LM": "MF", "RM": "MF", "CAM": "MF", "CDM": "MF", "MF": "MF",
             "CF": "FW", "ST": "FW", "SS": "FW", "LW": "FW", "RW": "FW", "LF": "FW", "RF": "FW", "FW": "FW", "W": "FW"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS kleague_pass_edge (
  event_id     INTEGER NOT NULL,
  team_id      INTEGER NOT NULL,
  passer_kid   INTEGER NOT NULL,
  receiver_kid INTEGER NOT NULL,
  passes       INTEGER NOT NULL CHECK (passes > 0),
  PRIMARY KEY (event_id, team_id, passer_kid, receiver_kid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kpe_team ON kleague_pass_edge(team_id, passer_kid);
CREATE TABLE IF NOT EXISTS kleague_pass_player (
  event_id    INTEGER NOT NULL,
  team_id     INTEGER NOT NULL,
  player_kid  INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  position    TEXT,
  is_starter  INTEGER NOT NULL DEFAULT 0,
  pos_top     REAL,
  pos_left    REAL,
  PRIMARY KEY (event_id, team_id, player_kid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kleague_pass_match (
  event_id     INTEGER NOT NULL,
  team_id      INTEGER NOT NULL,
  players      INTEGER NOT NULL,
  total_passes INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id)
) WITHOUT ROWID;
"""

TARGET_SQL = """
SELECT e.id, e.home_team_id, e.away_team_id, m.year, m.game_id, m.meet_seq, s.home_kid, s.away_kid
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
JOIN kleague_schedule s ON s.year = m.year AND s.league_id = m.league_id
                       AND s.game_id = m.game_id AND s.meet_seq = m.meet_seq
WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
  AND e.date_ts >= ?
  AND NOT EXISTS (SELECT 1 FROM kleague_pass_match p WHERE p.event_id = e.id)
ORDER BY e.date_ts DESC
"""


def log(msg: str) -> None:
    print(msg, flush=True)


def norm_name(name: str) -> str:
    """라인업 표기 차이 흡수: 주장 표기 '(c)'와 공백 제거."""
    return re.sub(r"\(c\)|\s", "", name or "")


# ── 네트워크 ────────────────────────────────────────────────────────────────
def post_multipart(endpoint: str, fields: dict, retries: int = 2):
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + endpoint, data=body, method="POST", headers={
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": REFERER,
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                d = json.loads(r.read().decode("utf-8"))
            if str(d.get("resultCode")) == "200" and isinstance(d.get("data"), dict):
                return d["data"], ""
            return None, f"resultCode={d.get('resultCode')!r}"
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            err = f"{type(e).__name__}: {e}"
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    return None, err


def fetch_pass_data(year, meet_seq, game_id, home_kid, away_kid):
    return post_multipart("getPassData.do", {"year": year, "meetSeq": meet_seq, "gameId": game_id,
                                             "homeTeam": home_kid, "awayTeam": away_kid})


def resolve_unknown_players(year, meet_seq, game_id, team_kid, kids: list[int]) -> list[dict]:
    """열에만 나온 선수의 이름·포지션을 선수 상세 API로 보충. 실패하면 이름은 '선수<ID>'로 남긴다."""
    out = []
    for kid in kids:
        d, _ = post_multipart("getMatchRecordPlayerDetail.do", {
            "MEET_YEAR": year, "MEET_SEQ": meet_seq, "GAME_ID": game_id, "TEAM_ID": team_kid, "PLAYER_ID": kid})
        time.sleep(DELAY)
        det = (d or {}).get("playerDetail") or {}
        name = (det.get("playerName") or "").strip() or f"선수{kid}"
        out.append({"kid": kid, "name": name, "position": POS_GROUP.get((det.get("playerPos") or "").upper())})
    return out


# ── 순수 파싱/검증 (네트워크·DB 없음 — 테스트 재사용) ─────────────────────────
def parse_side(side: dict) -> tuple[dict | None, list[str]]:
    """한 팀의 passHome/passAway → ({players, edges, total, unknown}, problems). 비어 있으면 (None, [])."""
    ids = [str(i) for i in (side.get("playerIds") or [])]
    if not ids:
        return None, []                       # 미공개
    names = side.get("playerNames") or []
    pos = side.get("positionMap") or {}
    mat = side.get("passMatrix") or {}
    problems: list[str] = []
    if len(names) != len(ids):
        problems.append(f"선수 ID {len(ids)}개 ≠ 이름 {len(names)}개")
    idset = set(ids)
    edges = []
    self_passes = 0          # 자기 자신에게 간 패스(대각선) — 0.3% 수준의 이상값이 간혹 있어 저장하지 않고 무시
    for passer, row in mat.items():
        if passer not in idset:
            problems.append(f"행 키 {passer} 가 선수 목록에 없음")
            continue
        for recv, n in (row or {}).items():
            if recv == passer:
                self_passes += n if isinstance(n, int) and n > 0 else 0
            elif not isinstance(n, int) or n < 0:
                problems.append(f"횟수 이상 {passer}->{recv}={n!r}")
            elif n > 0:
                edges.append((int(passer), int(recv), n))
    # 패스를 '받기만' 한 선수(예: 막판 교체 투입)는 선수 목록에 없고 열에만 나온다 — 정상 데이터.
    # 이름은 응답에 없어 unknown으로 돌려주고, 호출 측이 선수 상세 API로 보충한다.
    unknown = sorted({e[1] for e in edges} - {int(i) for i in ids})
    total = sum(e[2] for e in edges)
    if self_passes and self_passes > 0.05 * max(total, 1):       # 5% 초과면 데이터 오염으로 판단
        problems.append(f"대각선 값 {self_passes}회가 총 {total}회의 5% 초과")
    if not (MIN_TOTAL <= total <= MAX_TOTAL):
        problems.append(f"팀 총 패스 {total} 가 범위({MIN_TOTAL}~{MAX_TOTAL}) 밖")
    players = []
    for kid, nm in zip(ids, names):
        p = pos.get(kid)
        if (nm or "").strip():
            players.append({"kid": int(kid), "name": nm.strip(), "position": p if p in POSITIONS else None})
        else:
            unknown.append(int(kid))     # 이름이 비어 온 선수 — 경기 전체를 버리지 않고 선수 상세 API로 이름을 보충한다
    unknown = sorted(set(unknown))
    return {"players": players, "edges": edges, "total": total, "unknown": unknown, "self_passes": self_passes}, problems


def lineup_coords(conn, event_id: int, side: str) -> dict:
    """정규화 이름 → (top, left) — 선발 11명(kleague_lineup)."""
    rows = conn.execute("""SELECT player_name, top_pct, left_pct FROM kleague_lineup
                           WHERE sofa_event_id = ? AND side = ? AND is_starter = 1""", (event_id, side)).fetchall()
    return {norm_name(r[0]): (r[1], r[2]) for r in rows}


def write_event(conn, ev, home, away) -> dict:
    """양 팀을 한 트랜잭션으로 저장. 원장에 이미 있으면 건드리지 않는다."""
    eid = ev["id"]
    n = {"edges": 0, "players": 0, "teams": 0}
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with conn:
        if conn.execute("SELECT 1 FROM kleague_pass_match WHERE event_id = ? LIMIT 1", (eid,)).fetchone():
            return n
        for side_key, tid, parsed in (("home", ev["home_team_id"], home), ("away", ev["away_team_id"], away)):
            coords = lineup_coords(conn, eid, side_key)
            for p in parsed["players"]:
                xy = coords.get(norm_name(p["name"]))
                conn.execute("""INSERT OR IGNORE INTO kleague_pass_player
                    (event_id, team_id, player_kid, player_name, position, is_starter, pos_top, pos_left)
                    VALUES (?,?,?,?,?,?,?,?)""",
                    (eid, tid, p["kid"], p["name"], p["position"], 1 if xy else 0,
                     xy[0] if xy else None, xy[1] if xy else None))
                n["players"] += 1
            for passer, recv, cnt in parsed["edges"]:
                conn.execute("""INSERT OR IGNORE INTO kleague_pass_edge
                    (event_id, team_id, passer_kid, receiver_kid, passes) VALUES (?,?,?,?,?)""",
                    (eid, tid, passer, recv, cnt))
                n["edges"] += 1
            conn.execute("""INSERT OR IGNORE INTO kleague_pass_match
                (event_id, team_id, players, total_passes, fetched_at) VALUES (?,?,?,?,?)""",
                (eid, tid, len(parsed["players"]), parsed["total"], now))
            n["teams"] += 1
    return n


# ── 대조 모드(읽기 전용): 선수 상세 성공 패스 == 행 합계 ───────────────────────────
def compare(conn, limit: int) -> None:
    rows = conn.execute("""
        SELECT e.id, m.year, m.game_id, m.meet_seq, s.home_kid, s.away_kid
        FROM events e JOIN kleague_event_map m ON m.sofa_event_id = e.id
        JOIN kleague_schedule s ON s.year = m.year AND s.league_id = m.league_id AND s.game_id = m.game_id AND s.meet_seq = m.meet_seq
        WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL
        ORDER BY e.date_ts DESC LIMIT ?""", (limit * 6,)).fetchall()
    ok = tot = skipped = 0
    for r in rows:
        if tot >= limit * 4:
            break
        data, _ = fetch_pass_data(r["year"], r["meet_seq"], r["game_id"], r["home_kid"], r["away_kid"])
        time.sleep(DELAY)
        if not data:
            continue
        for key, kid_team in (("passHome", r["home_kid"]), ("passAway", r["away_kid"])):
            parsed, probs = parse_side(data.get(key) or {})
            if not parsed:
                skipped += 1
                continue
            row_sum = {}
            for passer, recv, cnt in parsed["edges"]:
                row_sum[passer] = row_sum.get(passer, 0) + cnt
            for passer, s in sorted(row_sum.items(), key=lambda kv: -kv[1])[:2]:
                d, _ = post_multipart("getMatchRecordPlayerDetail.do", {
                    "MEET_YEAR": r["year"], "MEET_SEQ": r["meet_seq"], "GAME_ID": r["game_id"],
                    "TEAM_ID": kid_team, "PLAYER_ID": passer})
                time.sleep(DELAY)
                acc = int(((d or {}).get("playerDetail") or {}).get("passAcc") or -1)
                tot += 1
                ok += (acc == s)
                if acc != s:
                    log(f"  [{r['id']}] 선수 {passer}: 행합 {s} ≠ 성공패스 {acc}")
    log(f"[대조 요약] 행 합계 = 선수 상세 성공 패스: {ok}/{tot} 일치 (미공개로 건너뛴 팀 {skipped})")


def main() -> None:
    ap = argparse.ArgumentParser(description="K리그 공식 API → 패스 네트워크 수집 (기본 dry-run)")
    ap.add_argument("--apply", action="store_true", help="실제 저장 (없으면 dry-run)")
    ap.add_argument("--since", default=DEFAULT_SINCE, help="이 날짜 이후 경기만 (YYYY-MM-DD, 기본 2023-01-01 — 2020~2022는 수집 대상에서 제외)")
    ap.add_argument("--limit", type=int, default=3000, help="한 번에 처리할 최대 경기 수 (안전장치)")
    ap.add_argument("--compare", type=int, metavar="N", help="선수 상세 성공 패스와 행 합계 대조 (읽기 전용)")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    if args.compare:
        compare(conn, args.compare)
        conn.close()
        return
    if args.apply:
        conn.executescript(SCHEMA)
    else:
        # dry-run은 스키마를 만들지 않으므로 원장 테이블이 없으면 '전부 미수집'으로 취급
        has = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kleague_pass_match'").fetchone()
        if not has:
            conn.execute("CREATE TEMP TABLE kleague_pass_match(event_id, team_id, players, total_passes, fetched_at)")
    since_ts = int(time.mktime(time.strptime(args.since, "%Y-%m-%d")))
    targets = conn.execute(TARGET_SQL, (since_ts,)).fetchall()[: args.limit]
    log(f"[{'APPLY(저장)' if args.apply else 'DRY-RUN(저장 안 함)'}] 수집 대상 {len(targets)}경기 (since {args.since}, limit {args.limit})")

    saved = pending = bad = failed = 0
    tot = {"edges": 0, "players": 0}
    for i, ev in enumerate(targets):
        data, err = fetch_pass_data(ev["year"], ev["meet_seq"], ev["game_id"], ev["home_kid"], ev["away_kid"])
        time.sleep(DELAY)
        if data is None:
            failed += 1
            log(f"  [{ev['id']}] 공식 API 응답 실패 ({err})")
            continue
        home, hp = parse_side(data.get("passHome") or {})
        away, ap_ = parse_side(data.get("passAway") or {})
        if home is None or away is None:
            pending += 1          # 아직 미공개(경기 다음 날 공개) — 다음 실행에서 재시도
            continue
        probs = hp + ap_
        if not probs and args.apply:
            for parsed, kid_team in ((home, ev["home_kid"]), (away, ev["away_kid"])):
                if parsed["unknown"]:
                    parsed["players"] += resolve_unknown_players(ev["year"], ev["meet_seq"], ev["game_id"], kid_team, parsed["unknown"])
        if probs:
            bad += 1
            log(f"  [{ev['id']}] 무결성 불일치 — 저장 안 함: {'; '.join(probs[:3])}")
            continue
        saved += 1
        if args.apply:
            n = write_event(conn, ev, home, away)
            tot["edges"] += n["edges"]; tot["players"] += n["players"]
        else:
            tot["edges"] += len(home["edges"]) + len(away["edges"])
            tot["players"] += len(home["players"]) + len(away["players"])
        if (i + 1) % 100 == 0 or (i + 1) == len(targets):
            log(f"  [{i+1}/{len(targets)}] 수집 {saved} · 미공개 {pending} · 불일치 {bad} · 실패 {failed}")
    conn.close()
    log(f"\n완료: 수집 {saved}경기 / 미공개(재시도 대상) {pending} / 무결성 불일치 {bad} / 응답 실패 {failed} — "
        f"엣지 {tot['edges']:,} · 선수 {tot['players']:,}" + ("" if args.apply else " (dry-run: 저장 안 함)"))
    # 미공개(빈 응답)는 실패가 아니다. 네트워크/서버 오류만 '전부 실패' 판정에 쓴다.
    fetch_health.abort_if_all_failed(saved + pending + bad, saved + pending + bad + failed, log, "kleague getPassData")


if __name__ == "__main__":
    main()
