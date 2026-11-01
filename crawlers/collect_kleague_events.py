#!/usr/bin/env python3
"""K리그 공식 API(matchInfo.do) → goal_events / card_events / sub_events 복구 수집.

배경: 2026-08 이후 SofaScore가 incidents를 403 challenge로 막아 득점·카드·교체 수집이 멈췄다
(checklist/backlog.md 'SofaScore 수집 중단'). kleague.com 경기 페이지가 쓰는 공개 JSON API가
같은 이벤트를 제공하므로(SofaScore 수집분과 대조 시 득점자 일치, 공식이 더 완전) 같은 테이블에 채운다.

  POST https://www.kleague.com/api/ddf/match/matchInfo.do   (form: year, meetSeq, gameId)
  → data.firstHalf / data.secondHalf: 이벤트 피드(득점·도움·경고·퇴장·교체·자책골·유효슈팅·파울)

저장 규칙은 SofaScore 수집기(collect_goal_incidents.py)와 동일하다:
  - 득점: is_home = 득점이 인정된 팀 쪽, team_id = 득점 팀.
  - 자책골: is_home = 득점이 인정된 팀(= 자책한 선수의 상대), team_id = 자책한 선수의 팀.
  - 카드: yellow / red / yellowRed('경고누적' 이벤트 또는 같은 경기 경고 후 퇴장).
  - 교체: player_out = playerName, player_in = playerName2.

주의(한계):
  - 시각은 'clock 분'이다. 득점·카드는 SofaScore와 ±1분 이내, 교체는 SofaScore가 1~3분 늦게 기록하는 체계 차이가 있다.
  - 페널티킥 여부는 피드에 구분이 없어 is_penalty=0, goal_type='regular'로 저장한다.
  - 선수 ID는 (mps/라인업 등번호 → players.name_ko) 순으로 해석하며 모호하면 NULL(이름은 항상 저장).
    해석률(2026-08 이후): K1 득점 98%·카드 99%·교체 OUT 99% / 교체 IN 63% / K2 43~54% (K2는 최근 mps 없음).

사용:
  python crawlers/collect_kleague_events.py                 # dry-run (기본, DB 변경 없음)
  python crawlers/collect_kleague_events.py --apply         # 실제 저장
  python crawlers/collect_kleague_events.py --compare 8     # 이미 SofaScore 데이터가 있는 경기 N건과 대조(읽기 전용)
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import fetch_health   # 5건 이상 시도했는데 성공 0이면 exit 3 (조용한 실패 방지)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = "players.db"
API_URL = "https://www.kleague.com/api/ddf/match/matchInfo.do"
REFERER = "https://www.kleague.com/match.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
DELAY = 0.4          # 공식 서버 부하를 고려한 요청 간격(초)
TIMEOUT = 20
KNOWN_EVENTS = {"전반시작", "전반종료", "후반시작", "경기종료", "파울", "유효슈팅", "경고", "경고누적", "퇴장", "득점", "도움", "교체", "자책골"}


def log(msg: str) -> None:
    print(msg, flush=True)


# ── 순수 파싱 (네트워크/DB 없음 — 대조·테스트에서 재사용) ─────────────────────────
def clock(half: int, tmin: int) -> tuple[int, int]:
    """전/후반 상대 분 → (경기 분, 추가시간). 후반은 45분 기준으로 이어 붙이고 45/90을 넘으면 추가시간.
    후반 시작 직후(0분대)는 전반 45분과 겹치지 않도록 46분으로 본다(하프타임 교체 등)."""
    absolute = tmin if half == 1 else 45 + max(tmin, 1)
    cap = 45 if half == 1 else 90
    return min(absolute, cap), max(0, absolute - cap)


def parse_match_info(data: dict, home_kid: str, away_kid: str, home_tid: int, away_tid: int) -> dict:
    """matchInfo.do의 data → {goals, cards, subs, assists, unknown_events, problems}.
    팀 판별은 이벤트 teamId(K-ID)를 스케줄의 home_kid/away_kid와 비교한다."""
    feed = sorted(
        [e for h in ("firstHalf", "secondHalf") for e in (data.get(h) or [])],
        key=lambda e: (e.get("halfType") or 0, e.get("timeMin") or 0, e.get("timeSec") or 0, e.get("num") or 0),
    )
    out = {"goals": [], "cards": [], "subs": [], "assists": [], "unknown_events": set(), "problems": []}
    yellow_seen: dict[str, int] = {}

    def side_of(e):
        kid = e.get("teamId")
        if kid == home_kid:
            return "home"
        if kid == away_kid:
            return "away"
        return None

    for e in feed:
        name = e.get("eventName") or ""
        if name not in KNOWN_EVENTS:
            out["unknown_events"].add(name)
            continue
        if name in ("전반시작", "전반종료", "후반시작", "경기종료", "파울", "유효슈팅"):
            continue
        side = side_of(e)
        if side is None:
            out["problems"].append(f"팀 판별 실패: {name} teamId={e.get('teamId')}")
            continue
        minute, added = clock(e.get("halfType") or 1, e.get("timeMin") or 0)
        team_tid = home_tid if side == "home" else away_tid
        base = {"minute": minute, "added": added, "back_no": e.get("backNo") or None,
                "name": (e.get("playerName") or "").strip(), "kid": e.get("playerId") or ""}
        if name == "득점":
            out["goals"].append({**base, "side": side, "team_id": team_tid, "credited_home": side == "home",
                                 "own": False})
        elif name == "자책골":
            # 자책골: 득점은 상대 팀에 인정(is_home), team_id는 자책한 선수의 팀
            out["goals"].append({**base, "side": side, "team_id": team_tid, "credited_home": side != "home",
                                 "own": True})
        elif name == "도움":
            out["assists"].append({**base, "side": side})
        elif name == "경고":
            yellow_seen[base["kid"]] = yellow_seen.get(base["kid"], 0) + 1
            out["cards"].append({**base, "side": side, "team_id": team_tid, "type": "yellow"})
        elif name == "경고누적":
            # 두 번째 경고로 인한 퇴장 — SofaScore의 yellowRed에 해당
            yellow_seen[base["kid"]] = yellow_seen.get(base["kid"], 0) + 1
            out["cards"].append({**base, "side": side, "team_id": team_tid, "type": "yellowRed"})
        elif name == "퇴장":
            second = yellow_seen.get(base["kid"], 0) > 0     # 같은 경기에서 이미 경고를 받은 선수 → 경고 누적 퇴장
            out["cards"].append({**base, "side": side, "team_id": team_tid, "type": "yellowRed" if second else "red"})
        elif name == "교체":
            injury = "부상" in (e.get("gubunSubNm") or "")
            out["subs"].append({**base, "side": side, "team_id": team_tid, "injury": 1 if injury else 0,
                                "out_name": base["name"], "out_kid": base["kid"],
                                "in_name": (e.get("playerName2") or "").strip(), "in_kid": e.get("playerId2") or ""})
    return out


def check_final_score(parsed: dict, data: dict, home_score: int, away_score: int) -> list[str]:
    """득점 이벤트로 재구성한 스코어가 공식 스코어·DB 스코어와 모두 같아야 득점 데이터를 신뢰한다."""
    h = sum(1 for g in parsed["goals"] if g["credited_home"])
    a = sum(1 for g in parsed["goals"] if not g["credited_home"])
    probs = []
    if (h, a) != (home_score, away_score):
        probs.append(f"득점 이벤트 스코어 {h}-{a} ≠ DB 스코어 {home_score}-{away_score}")
    if (data.get("homeGoal"), data.get("awayGoal")) != (home_score, away_score):
        probs.append(f"공식 스코어 {data.get('homeGoal')}-{data.get('awayGoal')} ≠ DB 스코어 {home_score}-{away_score}")
    return probs


# ── 선수 ID 해석 (SofaScore ID가 필요한 기존 분석 호환) ──────────────────────────
def resolve_player(conn: sqlite3.Connection, event_id: int, team_tid: int, back_no, name: str):
    """SofaScore player id 해석 (모호하면 None — 잘못된 ID보다 NULL이 안전하다):
      1) 등번호 → mps / match_lineups (같은 경기·팀)
      2) players(team_id, name_ko) 가 정확히 1명일 때
    교체 IN 선수는 이름만 오고(kleague_lineup은 선발 11명뿐) name_ko가 외국인에서 중복되는 경우가 있어 NULL이 남을 수 있다.
    """
    if back_no:
        for sql in ("SELECT DISTINCT player_id FROM match_player_stats WHERE event_id = ? AND team_id = ? AND shirt_number = ?",
                    "SELECT DISTINCT player_id FROM match_lineups WHERE event_id = ? AND team_id = ? AND shirt_number = ?"):
            rows = conn.execute(sql, (event_id, team_tid, back_no)).fetchall()
            if len(rows) == 1 and rows[0][0]:
                return rows[0][0]
    if name:
        rows = conn.execute("SELECT id FROM players WHERE team_id = ? AND name_ko = ?", (team_tid, name)).fetchall()
        if len(rows) == 1:
            return rows[0][0]
    return None


# ── 네트워크 ────────────────────────────────────────────────────────────────
def fetch_match_info(year: int, meet_seq: int, game_id: int, retries: int = 2):
    body = urllib.parse.urlencode({"year": year, "meetSeq": meet_seq, "gameId": game_id}).encode()
    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": REFERER,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"})
    last_err = ""
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                d = json.loads(r.read().decode("utf-8"))
            # resultCode는 문자열 '200'으로 온다 — 정수/문자열 모두 허용
            if str(d.get("resultCode")) == "200" and isinstance(d.get("data"), dict):
                return d["data"]
            last_err = f"resultCode={d.get('resultCode')!r} msg={d.get('resultMsg')!r}"
            fetch_match_info.last_error = last_err
            return None   # 서버가 명시적으로 거절한 응답은 재시도하지 않는다
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    fetch_match_info.last_error = last_err
    return None


fetch_match_info.last_error = ""


# ── DB ──────────────────────────────────────────────────────────────────────
TARGET_SQL = """
SELECT e.id, e.home_team_id, e.away_team_id, e.home_score, e.away_score,
       m.year, m.game_id, m.meet_seq, s.home_kid, s.away_kid
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
JOIN kleague_schedule s ON s.year = m.year AND s.league_id = m.league_id
                       AND s.game_id = m.game_id AND s.meet_seq = m.meet_seq
WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
  AND e.date_ts >= ?
  AND NOT EXISTS (SELECT 1 FROM goal_events g WHERE g.event_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM card_events c WHERE c.event_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM sub_events x WHERE x.event_id = e.id)
ORDER BY e.date_ts DESC
"""

COMPARE_SQL = """
SELECT e.id, e.home_team_id, e.away_team_id, e.home_score, e.away_score,
       m.year, m.game_id, m.meet_seq, s.home_kid, s.away_kid
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
JOIN kleague_schedule s ON s.year = m.year AND s.league_id = m.league_id
                       AND s.game_id = m.game_id AND s.meet_seq = m.meet_seq
WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.home_score + e.away_score >= 1
  AND EXISTS (SELECT 1 FROM goal_events g WHERE g.event_id = e.id)
  AND EXISTS (SELECT 1 FROM sub_events x WHERE x.event_id = e.id)
ORDER BY e.date_ts DESC LIMIT ?
"""


def write_event(conn: sqlite3.Connection, ev, parsed: dict) -> dict:
    """한 경기 분을 단일 트랜잭션으로 저장. 이미 3개 테이블 중 하나라도 행이 있으면 건드리지 않는다."""
    eid = ev["id"]
    n = {"goals": 0, "cards": 0, "subs": 0, "ids_resolved": 0, "ids_total": 0}
    with conn:   # 예외 시 롤백
        already = conn.execute("""SELECT 1 WHERE EXISTS (SELECT 1 FROM goal_events WHERE event_id = ?)
                                     OR EXISTS (SELECT 1 FROM card_events WHERE event_id = ?)
                                     OR EXISTS (SELECT 1 FROM sub_events WHERE event_id = ?)""",
                               (eid, eid, eid)).fetchone()
        if already:
            return n
        def pid(team_tid, back_no, name):
            r = resolve_player(conn, eid, team_tid, back_no, name)
            n["ids_total"] += 1
            n["ids_resolved"] += r is not None
            return r
        for g in parsed["goals"]:
            cur = conn.execute("""INSERT OR IGNORE INTO goal_events
                (event_id, team_id, player_id, player_name, minute, added_time, is_home, is_own_goal, is_penalty, goal_type)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (eid, g["team_id"], pid(g["team_id"], g["back_no"], g["name"]), g["name"], g["minute"], g["added"],
                 1 if g["credited_home"] else 0, 1 if g["own"] else 0, 0, "ownGoal" if g["own"] else "regular"))
            n["goals"] += cur.rowcount
        for c in parsed["cards"]:
            cur = conn.execute("""INSERT OR IGNORE INTO card_events
                (event_id, team_id, player_id, player_name, minute, added_time, is_home, card_type, reason)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (eid, c["team_id"], pid(c["team_id"], c["back_no"], c["name"]), c["name"], c["minute"], c["added"],
                 1 if c["side"] == "home" else 0, c["type"], ""))
            n["cards"] += cur.rowcount
        for s in parsed["subs"]:
            cur = conn.execute("""INSERT OR IGNORE INTO sub_events
                (event_id, team_id, is_home, minute, added_time, player_in_id, player_in_name, player_out_id, player_out_name, injury)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (eid, s["team_id"], 1 if s["side"] == "home" else 0, s["minute"], s["added"],
                 pid(s["team_id"], None, s["in_name"]), s["in_name"],
                 pid(s["team_id"], s["back_no"], s["out_name"]), s["out_name"], s["injury"]))
            n["subs"] += cur.rowcount
    return n


# ── 대조 모드 (읽기 전용): 이미 SofaScore 데이터가 있는 경기와 비교 ──────────────────
def compare_one(conn, ev, parsed) -> dict:
    eid = ev["id"]
    off_g = sorted((1 if g["credited_home"] else 0, g["minute"]) for g in parsed["goals"])
    db_g = sorted((r["is_home"], r["minute"]) for r in conn.execute(
        "SELECT is_home, minute FROM goal_events WHERE event_id = ?", (eid,)))
    off_names = sorted((1 if g["credited_home"] else 0, g["name"]) for g in parsed["goals"] if not g["own"])
    db_names = sorted((r["is_home"], r["pn"] or "") for r in conn.execute(
        """SELECT g.is_home, COALESCE(p.name_ko, g.player_name) pn FROM goal_events g
           LEFT JOIN players p ON p.id = g.player_id WHERE g.event_id = ? AND g.is_own_goal = 0""", (eid,)))
    # 득점자 ID 해석 정확도: SofaScore가 저장한 player_id와 비교
    db_ids = {(r["is_home"], r["minute"]): r["player_id"] for r in conn.execute(
        "SELECT is_home, minute, player_id FROM goal_events WHERE event_id = ? AND is_own_goal = 0", (eid,))}
    id_ok = id_total = 0
    for g in parsed["goals"]:
        if g["own"]:
            continue
        key = (1 if g["credited_home"] else 0, g["minute"])
        if key in db_ids and db_ids[key]:
            id_total += 1
            id_ok += resolve_player(conn, eid, g["team_id"], g["back_no"], g["name"]) == db_ids[key]
    db_c = conn.execute("SELECT COUNT(*) FROM card_events WHERE event_id = ?", (eid,)).fetchone()[0]
    db_s = conn.execute("SELECT COUNT(*) FROM sub_events WHERE event_id = ?", (eid,)).fetchone()[0]
    return {"goal_count": len(off_g) == len(db_g), "goal_side_min": sum(a == b for a, b in zip(off_g, db_g)) if len(off_g) == len(db_g) else 0,
            "goal_n": len(db_g), "names": off_names == db_names, "id_ok": id_ok, "id_total": id_total,
            "cards": (len(parsed["cards"]), db_c), "subs": (len(parsed["subs"]), db_s)}


def main() -> None:
    ap = argparse.ArgumentParser(description="K리그 공식 API → goal/card/sub_events 복구 수집 (기본 dry-run)")
    ap.add_argument("--apply", action="store_true", help="실제로 DB에 저장 (없으면 dry-run)")
    ap.add_argument("--since", default="2026-01-01", help="이 날짜 이후 경기만 (YYYY-MM-DD)")
    ap.add_argument("--limit", type=int, default=500, help="한 번에 처리할 최대 경기 수 (안전장치)")
    ap.add_argument("--compare", type=int, metavar="N", help="이미 SofaScore 데이터가 있는 최근 N경기와 대조 (읽기 전용)")
    ap.add_argument("--db", default=DB_PATH, help="DB 경로 (테스트용)")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    since_ts = int(time.mktime(time.strptime(args.since, "%Y-%m-%d")))

    if args.compare:
        rows = conn.execute(COMPARE_SQL, (args.compare,)).fetchall()
        log(f"[대조 모드] SofaScore 데이터가 있는 {len(rows)}경기를 공식 API와 비교 (읽기 전용)")
        agg = {"goal_count": 0, "names": 0, "id_ok": 0, "id_total": 0, "cards_eq": 0, "subs_eq": 0, "n": 0}
        for ev in rows:
            data = fetch_match_info(ev["year"], ev["meet_seq"], ev["game_id"])
            time.sleep(DELAY)
            if not data:
                log(f"  [{ev['id']}] 응답 없음 ({fetch_match_info.last_error})")
                continue
            parsed = parse_match_info(data, ev["home_kid"], ev["away_kid"], ev["home_team_id"], ev["away_team_id"])
            r = compare_one(conn, ev, parsed)
            agg["n"] += 1; agg["goal_count"] += r["goal_count"]; agg["names"] += r["names"]
            agg["id_ok"] += r["id_ok"]; agg["id_total"] += r["id_total"]
            agg["cards_eq"] += r["cards"][0] == r["cards"][1]; agg["subs_eq"] += r["subs"][0] == r["subs"][1]
            log(f"  [{ev['id']}] 득점수 {'✓' if r['goal_count'] else '✗'} 득점자명 {'✓' if r['names'] else '✗'} "
                f"선수ID {r['id_ok']}/{r['id_total']} 카드 {r['cards'][0]}/{r['cards'][1]} 교체 {r['subs'][0]}/{r['subs'][1]} "
                f"미지 이벤트 {sorted(parsed['unknown_events']) or '-'}")
        log(f"\n[대조 요약] 경기 {agg['n']} · 득점수 일치 {agg['goal_count']} · 득점자명 일치 {agg['names']} · "
            f"선수ID 일치 {agg['id_ok']}/{agg['id_total']} · 카드수 동일 {agg['cards_eq']} · 교체수 동일 {agg['subs_eq']}")
        conn.close()
        return

    targets = conn.execute(TARGET_SQL, (since_ts,)).fetchall()[: args.limit]
    mode = "APPLY(저장)" if args.apply else "DRY-RUN(저장 안 함)"
    log(f"[{mode}] 수집 대상(SofaScore 이벤트 데이터가 전혀 없는 종료 경기): {len(targets)}경기 (since {args.since}, limit {args.limit})")
    ok = fail = skipped = 0
    tot = {"goals": 0, "cards": 0, "subs": 0, "ids_resolved": 0, "ids_total": 0}
    unknown: set = set()
    for i, ev in enumerate(targets):
        data = fetch_match_info(ev["year"], ev["meet_seq"], ev["game_id"])
        time.sleep(DELAY)
        if not data:
            fail += 1
            log(f"  [{ev['id']}] 공식 API 응답 없음 ({fetch_match_info.last_error})")
            continue
        if data.get("gameStatus") != "FE":
            skipped += 1
            log(f"  [{ev['id']}] 경기 종료 상태 아님({data.get('gameStatus')}) — 스킵")
            continue
        parsed = parse_match_info(data, ev["home_kid"], ev["away_kid"], ev["home_team_id"], ev["away_team_id"])
        unknown |= parsed["unknown_events"]
        probs = parsed["problems"] + check_final_score(parsed, data, ev["home_score"], ev["away_score"])
        if probs:
            skipped += 1      # 득점이 스코어와 안 맞으면 경기 전체를 저장하지 않는다(잘못된 타임라인 방지)
            log(f"  [{ev['id']}] 무결성 불일치 — 저장 안 함: {'; '.join(probs)}")
            continue
        ok += 1
        if args.apply:
            n = write_event(conn, ev, parsed)
            for k in tot:
                tot[k] += n[k]
        else:
            tot["goals"] += len(parsed["goals"]); tot["cards"] += len(parsed["cards"]); tot["subs"] += len(parsed["subs"])
        if (i + 1) % 25 == 0 or (i + 1) == len(targets):
            log(f"  [{i+1}/{len(targets)}] ok={ok} fail={fail} skip={skipped}")
    conn.close()
    log(f"\n완료: 처리 {ok}경기 / 응답 실패 {fail} / 스킵 {skipped} — 득점 {tot['goals']} · 카드 {tot['cards']} · 교체 {tot['subs']}"
        + (f" · 선수ID 해석 {tot['ids_resolved']}/{tot['ids_total']}" if args.apply else " (dry-run: 저장 안 함)"))
    if unknown:
        log(f"참고: 알 수 없는 이벤트 종류 {sorted(unknown)} — 파서 업데이트 필요 여부 확인")
    fetch_health.abort_if_all_failed(ok + skipped, ok + skipped + fail, log, "kleague matchInfo")


if __name__ == "__main__":
    main()
