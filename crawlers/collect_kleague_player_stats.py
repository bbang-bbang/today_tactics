#!/usr/bin/env python3
"""K리그 공식 선수 경기 기록(getMatchRecordPlayerDetail) → kleague_player_match (공식 데이터 전환 2단계).

  POST https://www.kleague.com/api/ddf/match/getMatchRecordPlayerDetail.do
       (multipart: MEET_YEAR, MEET_SEQ, GAME_ID, TEAM_ID=팀 K-ID, PLAYER_ID=선수 K-ID)
  → data.playerDetail(약 112필드) + data.playerGKDetail(선방·실점 등)

왜 별도 테이블인가 (checklist/backlog.md P1 '재검증 — 2026-11-03 오후'):
  - 공식과 SofaScore는 같은 이름이라도 정의가 다른 항목이 많다(태클·경합·드리블·인터셉트·볼 회수 등)
    → match_player_stats 에 섞으면 90분 환산·백분위가 왜곡된다. 공식 값은 공식 테이블에만 그대로 저장.
  - 출전분(minutes)은 추가시간 포함 실제 시간(풀타임 ≈ 98분) — SofaScore(풀타임 90) 와 정의가 다르다.
  - 응답의 backNo·teamName 은 '경기 당시'가 아니라 선수의 현재 값 → 저장하지 않는다.
    등번호·홈원정은 경기 페이지 엔트리(경기 당시)에서 가져온다.
  - xG(expectedGoal)는 2023~2025 는 있으나 2026 은 빈 값(2026-11-03 확인) → NULL 로 저장.

대상 선수: 경기 페이지 엔트리 중 '출전한' 선수만 호출(벤치 미출전 호출 절약):
  패스 데이터 선수(kleague_pass_player) ∪ 공식 라인업 선발(kleague_lineup) ∪ 교체 투입(sub_events) 이름.
  패스 데이터가 없는 경기는 엔트리 전원을 호출한다. 응답 출전분 0이면 저장하지 않는다.

저장(신규 테이블 2개, 기존 테이블 변경 없음 / 롤백 = DROP TABLE 두 개):
  kleague_player_match      (event_id, player_kid) PK — 공식 값 + raw_json(응답 원문)
  kleague_player_match_log  (event_id) PK — 수집 원장(멱등 키). 빈 응답(미공개)은 원장에 쓰지 않고 다음 실행에서 재시도.

사용:
  python crawlers/collect_kleague_player_stats.py                          # dry-run (기본, DB 변경 없음)
  python crawlers/collect_kleague_player_stats.py --apply --since 2026-01-01 --limit 50
  python crawlers/collect_kleague_player_stats.py --apply --days 30        # 정기 업데이트(최근 30일)
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

from collect_kleague_heatmap import fetch_entry          # 경기 페이지 엔트리(경기 당시 홈/원정·K-ID·등번호)
from collect_kleague_passes import post_multipart        # 공식 API multipart 호출
import fetch_health                                        # 5건 이상 시도했는데 성공 0이면 exit 3

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = str(Path(__file__).resolve().parent.parent / "players.db")
DELAY = 0.6                 # 공식 사이트 부하 배려 — 기존 수집기(0.4)보다 느리게
DEFAULT_SINCE = "2023-01-01"
MAX_MINUTES = 140           # 연장 포함 상식 상한
MAX_COUNT = 300             # 개별 카운트 상식 상한(패스 시도 관측 최대 ≈ 150)

SCHEMA = """
CREATE TABLE IF NOT EXISTS kleague_player_match (
  event_id        INTEGER NOT NULL,
  team_id         INTEGER NOT NULL,     -- SofaScore 팀 ID(events.home/away_team_id)
  is_home         INTEGER NOT NULL,
  player_kid      INTEGER NOT NULL,     -- K리그 공식 선수 ID
  player_name     TEXT NOT NULL,
  back_no         INTEGER,              -- 경기 당시 등번호(경기 페이지 엔트리)
  position        TEXT,                 -- 엔트리 포지션(GK/DF/MF/FW)
  detail_pos      TEXT,                 -- 공식 세부 포지션(CB·CM·RW 등)
  minutes         INTEGER NOT NULL,     -- 추가시간 포함 실제 출전분(공식 정의)
  goals INTEGER, assists INTEGER, shots INTEGER, shots_on_target INTEGER, xg REAL,
  passes INTEGER, passes_acc INTEGER, key_passes INTEGER,
  crosses INTEGER, crosses_acc INTEGER, long_passes INTEGER, long_passes_acc INTEGER,
  through_passes INTEGER, through_passes_acc INTEGER,
  aerials INTEGER, aerials_won INTEGER, duels INTEGER, duels_won INTEGER,
  dribbles INTEGER, dribbles_won INTEGER, tackles INTEGER, tackles_won INTEGER,
  interceptions INTEGER, ball_recoveries INTEGER, clearances INTEGER, shots_blocked INTEGER,
  fouls INTEGER, fouled INTEGER, offsides INTEGER, yellow INTEGER, red INTEGER,
  saves INTEGER, goals_conceded INTEGER,
  point REAL,                           -- 공식 playerPoint(SofaScore 평점과 산식 다름)
  raw_json        TEXT NOT NULL,        -- 응답 원문(playerDetail + playerGKDetail) — 필드 추가 시 재호출 불필요
  fetched_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, player_kid)
);
CREATE INDEX IF NOT EXISTS idx_kpm_player ON kleague_player_match(player_kid);
CREATE INDEX IF NOT EXISTS idx_kpm_team ON kleague_player_match(team_id, event_id);
CREATE TABLE IF NOT EXISTS kleague_player_match_log (
  event_id   INTEGER PRIMARY KEY,
  players    INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);
"""

TARGET_SQL = """
SELECT e.id, e.home_team_id, e.away_team_id, m.year, m.league_id, m.game_id, m.meet_seq, s.home_kid, s.away_kid
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
JOIN kleague_schedule s ON s.year = m.year AND s.league_id = m.league_id AND s.game_id = m.game_id AND s.meet_seq = m.meet_seq
WHERE e.tournament_id IN (410, 777, 9410) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
  AND e.date_ts >= ? AND e.date_ts < ?
  AND NOT EXISTS (SELECT 1 FROM kleague_player_match_log l WHERE l.event_id = e.id)
ORDER BY e.date_ts DESC
"""

# (컬럼, playerDetail 키) — 정수 카운트
INT_FIELDS = [
    ("goals", "goal"), ("assists", "assist"), ("shots", "shot"), ("shots_on_target", "shotOnTarget"),
    ("passes", "pass"), ("passes_acc", "passAcc"), ("key_passes", "exAttKeyPass"),
    ("crosses", "cros"), ("crosses_acc", "crosAcc"), ("long_passes", "longPass"), ("long_passes_acc", "longPassSuccess"),
    ("through_passes", "throughPass"), ("through_passes_acc", "throughPassSuccess"),
    ("aerials", "airChalg"), ("aerials_won", "airChalgWon"), ("duels", "chalg"), ("duels_won", "chalgWon"),
    ("dribbles", "dribble"), ("dribbles_won", "dribbleSuccess"), ("tackles", "tackle"), ("tackles_won", "tackleSuccess"),
    ("interceptions", "intercept"), ("ball_recoveries", "ballRecoverie"), ("clearances", "cutOff"),
    ("shots_blocked", "blockingShoot"), ("fouls", "foul"), ("fouled", "foulSuffered"), ("offsides", "offside"),
    ("yellow", "yellowCard"), ("red", "redCard"),
]
GK_FIELDS = [("saves", "goalkeeperSave"), ("goals_conceded", "goalConceded")]
COLUMNS = (["event_id", "team_id", "is_home", "player_kid", "player_name", "back_no", "position", "detail_pos", "minutes"]
           + [c for c, _ in INT_FIELDS] + ["xg"] + [c for c, _ in GK_FIELDS] + ["point", "raw_json", "fetched_at"])
INSERT_SQL = ("INSERT OR REPLACE INTO kleague_player_match (" + ", ".join(COLUMNS) + ") VALUES ("
              + ", ".join("?" for _ in COLUMNS) + ")")   # 컬럼명은 위 고정 목록에서만 — 외부 입력 없음


def log(msg: str) -> None:
    print(msg, flush=True)


def norm(s: str) -> str:
    return re.sub(r"\(c\)|[\s·.\-]", "", s or "")


# ── 순수 파싱/검증 (네트워크·DB 없음) ─────────────────────────────────────────
def to_int(v):
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def to_float(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_detail(data: dict) -> tuple[dict | None, list[str]]:
    """응답 → (값 dict, 문제 목록). playerDetail 이 비면 (None, []) = 미공개."""
    det = (data or {}).get("playerDetail") or {}
    if not det:
        return None, []
    gk = (data or {}).get("playerGKDetail") or {}
    problems = []
    out = {"minutes": to_int(det.get("minutePlay")), "detail_pos": (det.get("playerPos") or "").strip() or None,
           "xg": to_float(det.get("expectedGoal")), "point": to_float(det.get("playerPoint"))}
    for col, key in INT_FIELDS:
        out[col] = to_int(det.get(key))
    for col, key in GK_FIELDS:
        out[col] = to_int(gk.get(key))
    m = out["minutes"]
    if m is None:
        out["minutes"] = 0                  # 벤치 미출전은 minutePlay 가 빈 값 → 호출 측에서 미출전으로 건너뜀
        return out, problems
    if not 0 <= m <= MAX_MINUTES:
        problems.append(f"출전분 이상 {det.get('minutePlay')!r}")
    for col, _ in INT_FIELDS + GK_FIELDS:
        v = out[col]
        if v is not None and not 0 <= v <= MAX_COUNT:
            problems.append(f"{col}={v}")
    for a, b in (("passes_acc", "passes"), ("crosses_acc", "crosses"), ("long_passes_acc", "long_passes"),
                 ("shots_on_target", "shots"), ("dribbles_won", "dribbles"), ("aerials_won", "aerials"), ("duels_won", "duels")):
        if out[a] is not None and out[b] is not None and out[a] > out[b]:
            problems.append(f"{a}({out[a]}) > {b}({out[b]})")
    if out["xg"] is not None and not 0 <= out["xg"] <= 10:
        problems.append(f"xg={out['xg']}")
    return out, problems


# ── 대상 선수 ──────────────────────────────────────────────────────────────
def played_names(conn, ev) -> set[str] | None:
    """출전 추정 선수의 정규화 이름 집합. 패스 데이터가 없으면 None(= 엔트리 전원 호출)."""
    names = {norm(r[0]) for r in conn.execute("SELECT player_name FROM kleague_pass_player WHERE event_id = ?", (ev["id"],))}
    if not names:
        return None
    names |= {norm(r[0]) for r in conn.execute(
        "SELECT player_name FROM kleague_lineup WHERE sofa_event_id = ? AND is_starter = 1", (ev["id"],))}
    names |= {norm(r[0]) for r in conn.execute(
        "SELECT player_in_name FROM sub_events WHERE event_id = ? AND player_in_name IS NOT NULL", (ev["id"],))}
    return names


def process_event(conn, ev, apply: bool, delay: float = DELAY) -> dict:
    """한 경기 수집. 반환: {status: saved|pending|fail, players, problems, calls}"""
    res = {"status": "fail", "players": 0, "problems": [], "calls": 0}
    entry, err = fetch_entry(ev["year"], ev["league_id"], ev["game_id"], ev["meet_seq"])
    time.sleep(delay)
    if entry is None:
        res["problems"].append(f"엔트리 실패: {err}")
        return res
    if not entry:
        res["status"] = "pending"          # 엔트리 미공개
        return res
    want = played_names(conn, ev)
    rows, empty = [], 0
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    for side, kid, pos, name, back in entry:
        if want is not None and norm(name) not in want:
            continue
        team_kid = ev["home_kid"] if side == "home" else ev["away_kid"]
        data, err = post_multipart("getMatchRecordPlayerDetail.do", {
            "MEET_YEAR": ev["year"], "MEET_SEQ": ev["meet_seq"], "GAME_ID": ev["game_id"],
            "TEAM_ID": team_kid, "PLAYER_ID": kid})
        time.sleep(delay)
        res["calls"] += 1
        if data is None:
            res["problems"].append(f"{name}: {err}")
            continue
        vals, probs = parse_detail(data)
        if vals is None:
            empty += 1
            continue
        if probs:
            res["problems"].append(f"{name}: " + ", ".join(probs))
            continue
        if not vals["minutes"]:
            continue                        # 미출전
        raw = json.dumps({"playerDetail": data.get("playerDetail"), "playerGKDetail": data.get("playerGKDetail")},
                         ensure_ascii=False, separators=(",", ":"))
        vals.update({"event_id": ev["id"], "team_id": ev["home_team_id"] if side == "home" else ev["away_team_id"],
                     "is_home": 1 if side == "home" else 0, "player_kid": kid, "player_name": name,
                     "back_no": back, "position": pos or None, "raw_json": raw, "fetched_at": now})
        rows.append(vals)
    if res["calls"] and empty == res["calls"]:
        res["status"] = "pending"           # 전원 빈 응답 = 미공개 → 다음 실행에서 재시도
        return res
    if res["problems"] and len(res["problems"]) > max(2, 0.2 * max(res["calls"], 1)):
        return res                          # 문제가 많으면 경기 단위로 저장하지 않음(부분 저장 방지)
    homes = sum(r["is_home"] for r in rows)
    if homes < 11 or len(rows) - homes < 11:
        res["problems"].append(f"출전 선수 부족(홈 {homes}, 원정 {len(rows) - homes})")
        return res
    res["players"] = len(rows)
    if apply:
        with conn:                          # 경기 단위 단일 트랜잭션
            conn.execute("DELETE FROM kleague_player_match WHERE event_id = ?", (ev["id"],))
            conn.executemany(INSERT_SQL, [tuple(r[c] for c in COLUMNS) for r in rows])
            conn.execute("INSERT OR REPLACE INTO kleague_player_match_log (event_id, players, fetched_at) VALUES (?,?,?)",
                         (ev["id"], len(rows), now))
    res["status"] = "saved"
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description="K리그 공식 선수 경기 기록 수집 (기본 dry-run)")
    ap.add_argument("--apply", action="store_true", help="실제 저장 (없으면 dry-run)")
    ap.add_argument("--since", default=DEFAULT_SINCE, help="이 날짜 이후 경기 (YYYY-MM-DD)")
    ap.add_argument("--until", default="2100-01-01", help="이 날짜 이전 경기 (YYYY-MM-DD, 미포함)")
    ap.add_argument("--days", type=int, help="최근 N일 (지정 시 --since 무시)")
    ap.add_argument("--limit", type=int, default=3000, help="한 번에 처리할 최대 경기 수")
    ap.add_argument("--delay", type=float, default=DELAY, help=f"호출 간격(초, 기본 {DELAY}) — 대량 백필은 1.0 권장")
    ap.add_argument("--pause-hours", metavar="H1-H2",
                    help="이 시간대(현지 시각, 예 13-22)에는 수집을 쉬고 끝날 때까지 대기 — 대량 백필용(경기·접속 많은 시간 회피)")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()
    delay = max(0.3, args.delay)
    pause = None
    if args.pause_hours:
        h1, h2 = (int(x) for x in args.pause_hours.split("-"))
        if not (0 <= h1 < h2 <= 24):
            ap.error("--pause-hours 는 0 <= H1 < H2 <= 24 (예 13-22)")
        pause = (h1, h2)

    conn = sqlite3.connect(args.db, timeout=30)
    conn.row_factory = sqlite3.Row
    if args.apply:
        conn.executescript(SCHEMA)
    elif not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kleague_player_match_log'").fetchone():
        conn.execute("CREATE TEMP TABLE kleague_player_match_log(event_id INTEGER PRIMARY KEY, players, fetched_at)")
    since = (time.time() - args.days * 86400) if args.days else time.mktime(time.strptime(args.since, "%Y-%m-%d"))
    until = time.mktime(time.strptime(args.until, "%Y-%m-%d"))
    targets = conn.execute(TARGET_SQL, (int(since), int(until))).fetchall()[: args.limit]
    log(f"[{'APPLY(저장)' if args.apply else 'DRY-RUN(저장 안 함)'}] 대상 {len(targets)}경기 "
        f"({time.strftime('%Y-%m-%d', time.localtime(since))} ~ {args.until}, limit {args.limit})")

    cnt = {"saved": 0, "pending": 0, "fail": 0, "players": 0, "calls": 0}
    t0 = time.time()
    for i, ev in enumerate(targets):
        if pause:
            now = time.localtime()
            if pause[0] <= now.tm_hour < pause[1]:
                wait = (pause[1] - now.tm_hour) * 3600 - now.tm_min * 60 - now.tm_sec
                log(f"  [쉬는 시간 {pause[0]}~{pause[1]}시] {wait // 60}분 대기 후 재개 (진행 {i}/{len(targets)})")
                time.sleep(max(60, wait))
        r = process_event(conn, ev, args.apply, delay)
        cnt[r["status"]] += 1
        cnt["players"] += r["players"]
        cnt["calls"] += r["calls"]
        if r["status"] == "fail" or r["problems"]:
            log(f"  [{ev['id']}] {r['status']}: " + " / ".join(r["problems"][:3]))
        if (i + 1) % 20 == 0 or i + 1 == len(targets):
            log(f"  진행 {i + 1}/{len(targets)} — 저장 {cnt['saved']}, 미공개 {cnt['pending']}, 실패 {cnt['fail']}, "
                f"선수 {cnt['players']}, 호출 {cnt['calls']} ({time.time() - t0:.0f}s)")
    conn.close()
    log(f"[완료] 저장 {cnt['saved']} · 미공개 {cnt['pending']} · 실패 {cnt['fail']} · 선수 {cnt['players']} · 호출 {cnt['calls']}")
    fetch_health.abort_if_all_failed(cnt["saved"] + cnt["pending"], cnt["saved"] + cnt["pending"] + cnt["fail"],
                                     log, "kleague getMatchRecordPlayerDetail")


if __name__ == "__main__":
    main()
