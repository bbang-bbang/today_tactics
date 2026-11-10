#!/usr/bin/env python3
"""SofaScore 히트맵 차단 대체 — K리그 공식 `getHeatmapData.do` → `heatmap_points`.

  POST https://www.kleague.com/api/ddf/match/getHeatmapData.do
       (multipart: MEET_YEAR, MEET_SEQ, GAME_ID, PLAYER_LIST=K리그 선수 ID, H_GK_PLAYER=홈 GK K-ID)
  → data.coordinates[{START_POINT_X, START_POINT_Y, PERIOD_ID, PASS_YN_CD}]   (0~100, 경기장 절대좌표)

선수 매핑: 경기 페이지(match.do) 히트맵 선수 목록 = 엔트리 전원의 (홈/원정, K-ID, 포지션, 이름(등번호))
  → 같은 경기 `match_player_stats`(is_home, shirt_number) → SofaScore player_id. 출전 0분 선수는 요청 안 함.

좌표 변환(SofaScore 좌표계 = 각 팀이 오른쪽으로 공격, 정수 0~100):
  피리어드별 공격 방향 = 그 피리어드 홈 선발 GK 평균 x < 50 이면 홈이 오른쪽 공격(원정은 반대).
  오른쪽 공격: (x, 100−y) / 왼쪽 공격: (100−x, y).  방향은 경기마다 다르므로 경기별로 판별한다.
  검증(2026-11-02, SofaScore 보유 45명): 점 개수 비율 0.96, 평균 위치 차 |x| 1.0·|y| 1.5, 분산 비율 1.03/1.05.

저장 규칙:
  - 대상: 종료 경기 중 heatmap_points가 없는 (경기, 선수)만 — SofaScore 원본이 있는 선수는 건드리지 않음.
  - 홈 GK 좌표로 방향을 정하지 못한 피리어드의 점은 버린다(뒤집힌 히트맵 저장 방지).
  - 빈 응답 = 미공개 → 저장 안 하고 다음 실행에서 재시도. 패스·슈팅(다음 날)과 달리 히트맵은 공개가 늦다:
    2026-11-10 확인 — 10/24·25 경기는 11/2에, 11/1 경기는 11/9에 수집됐고 11/7·8 경기는 11/10에도 빈 응답
    (같은 시점 과거 경기는 정상 응답 → API 차단 아님). 즉 약 1주 뒤 공개 → 월 05:00 정기 실행이 주로 채운다.
  - 원장 `kleague_recovery_log(kind='heatmap', player_id)` → 롤백:
      DELETE FROM heatmap_points WHERE (event_id, player_id) IN
        (SELECT event_id, player_id FROM kleague_recovery_log WHERE kind='heatmap');
      DELETE FROM kleague_recovery_log WHERE kind='heatmap';

사용:
  python crawlers/collect_kleague_heatmap.py                # dry-run (기본)
  python crawlers/collect_kleague_heatmap.py --apply        # 저장
  python crawlers/collect_kleague_heatmap.py --compare 3    # SofaScore 히트맵 보유 경기에서 변환 결과 대조 (읽기 전용)
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import statistics as st
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

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = str(BASE_DIR / "players.db")
API = "https://www.kleague.com/api/ddf/match/"
PAGE = "https://www.kleague.com/match.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
DELAY = 0.4
TIMEOUT = 25
DEFAULT_SINCE = "2026-07-01"
MAX_POINTS = 400          # 선수 1명 1경기 상식 상한 (관측 최대 ≈ 150)

LEDGER_SCHEMA = """
CREATE TABLE IF NOT EXISTS kleague_recovery_log (
  event_id     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  player_id    INTEGER NOT NULL DEFAULT 0,
  rows         INTEGER NOT NULL,
  note         TEXT,
  recovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, kind, player_id)
) WITHOUT ROWID;
"""

TARGET_SQL = """
SELECT e.id, m.year, m.league_id, m.meet_seq, m.game_id
FROM events e
JOIN kleague_event_map m ON m.sofa_event_id = e.id
WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
  AND e.date_ts >= ?
  AND EXISTS (SELECT 1 FROM match_player_stats s WHERE s.event_id = e.id AND s.minutes_played > 0
              AND NOT EXISTS (SELECT 1 FROM heatmap_points h WHERE h.event_id = e.id AND h.player_id = s.player_id))
ORDER BY e.date_ts
"""

RE_PLAYER = re.compile(
    r'class="HeatmapSeq heatmapChkbox([HA])" id="chk(\d+)" value="\d+">.*?'
    r'<p style="width: 50%;">([^<]*)</p>.*?<p>([^<]*?)\((\d+)\)</p>', re.S)


def log(msg: str) -> None:
    print(msg, flush=True)


# ── 네트워크 ────────────────────────────────────────────────────────────────
def _open(req, retries=2):
    err = ""
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read().decode("utf-8"), ""
        except (urllib.error.URLError, TimeoutError) as e:
            err = f"{type(e).__name__}: {e}"
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    return None, err


def fetch_entry(year, league_id, game_id, meet_seq):
    """경기 페이지 → [(side 'home'|'away', kid, pos, name, back_no)]"""
    url = f"{PAGE}?year={int(year)}&leagueId={int(league_id)}&gameId={int(game_id)}&meetSeq={int(meet_seq)}"
    html, err = _open(urllib.request.Request(url, headers={"User-Agent": UA}))
    if html is None:
        return None, err
    out = [("home" if s == "H" else "away", int(k), pos.strip(), name.strip(), int(b))
           for s, k, pos, name, b in RE_PLAYER.findall(html)]
    return out, ""


def fetch_heatmap(year, meet_seq, game_id, kid, home_gk):
    boundary = uuid.uuid4().hex
    fields = {"MEET_YEAR": year, "MEET_SEQ": meet_seq, "GAME_ID": game_id, "PLAYER_LIST": kid, "H_GK_PLAYER": home_gk}
    body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                    for k, v in fields.items()) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(API + "getHeatmapData.do", data=body, method="POST", headers={
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": PAGE,
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    text, err = _open(req)
    if text is None:
        return None, err
    try:
        d = json.loads(text)
    except ValueError as e:
        return None, f"JSON: {e}"
    if str(d.get("resultCode")) != "200":
        return None, f"resultCode={d.get('resultCode')!r}"
    co = (d.get("data") or {}).get("coordinates") or []
    pts = []
    for q in co:
        try:
            x, y, per = float(q["START_POINT_X"]), float(q["START_POINT_Y"]), int(q["PERIOD_ID"])
        except (KeyError, TypeError, ValueError):
            continue
        if per in (1, 2) and 0 <= x <= 100 and 0 <= y <= 100:
            pts.append((x, y, per))
    return pts, ""


# ── 변환 ────────────────────────────────────────────────────────────────────
def directions(gk_points):
    """홈 GK 원좌표 → {period: home_attacks_right}. 점 3개 미만 피리어드는 판별 불가(제외)."""
    out = {}
    for per in (1, 2):
        xs = [x for x, _, p in gk_points if p == per]
        if len(xs) >= 3:
            out[per] = st.mean(xs) < 50
    return out


def to_sofa(points, side, dirs):
    res = []
    for x, y, per in points:
        home_right = dirs.get(per)
        if home_right is None:
            continue
        right = home_right if side == "home" else not home_right
        nx, ny = (x, 100 - y) if right else (100 - x, y)
        res.append((min(100, max(0, round(nx))), min(100, max(0, round(ny)))))
    return res


# ── 경기 처리 ───────────────────────────────────────────────────────────────
def process_event(conn, ev, only_missing=True):
    """→ dict(status, players={sofa_pid: [(x,y)]}, msg)."""
    entry, err = fetch_entry(ev["year"], ev["league_id"], ev["game_id"], ev["meet_seq"])
    time.sleep(DELAY)
    if entry is None:
        return {"status": "fail", "msg": f"경기 페이지 실패 ({err})"}
    if not entry:
        return {"status": "pending", "msg": "선수 목록 없음"}
    starters = {(r[0], r[1]) for r in conn.execute(
        "SELECT side, back_no FROM kleague_lineup WHERE sofa_event_id=? AND is_starter=1", (ev["id"],))}
    gk = [e for e in entry if e[0] == "home" and e[2] == "GK"]
    home_gk = next((e for e in gk if ("home", e[4]) in starters), gk[0] if len(gk) == 1 else None)
    if home_gk is None:
        return {"status": "skip", "msg": "홈 선발 GK 판별 불가"}
    mps = {}
    for pid, ih, shirt, mins in conn.execute(
            "SELECT player_id, is_home, shirt_number, minutes_played FROM match_player_stats WHERE event_id=?", (ev["id"],)):
        mps.setdefault(("home" if ih else "away", shirt), []).append((pid, mins or 0))
    have = {r[0] for r in conn.execute("SELECT DISTINCT player_id FROM heatmap_points WHERE event_id=?", (ev["id"],))}

    gk_pts, err = fetch_heatmap(ev["year"], ev["meet_seq"], ev["game_id"], home_gk[1], home_gk[1])
    time.sleep(DELAY)
    if gk_pts is None:
        return {"status": "fail", "msg": f"GK 히트맵 실패 ({err})"}
    if not gk_pts:
        return {"status": "pending", "msg": "히트맵 미공개"}
    dirs = directions(gk_pts)
    if not dirs:
        return {"status": "skip", "msg": "공격 방향 판별 불가"}

    players, unmatched = {}, 0
    for side, kid, pos, name, back in entry:
        cand = mps.get((side, back), [])
        if len(cand) != 1:
            unmatched += 1
            continue
        pid, mins = cand[0]
        if mins <= 0 or (only_missing and pid in have):
            continue
        if kid == home_gk[1]:
            pts = gk_pts
        else:
            pts, err = fetch_heatmap(ev["year"], ev["meet_seq"], ev["game_id"], kid, home_gk[1])
            time.sleep(DELAY)
            if pts is None:
                log(f"    [{ev['id']}] {name} 히트맵 실패 ({err})")
                continue
        if len(pts) > MAX_POINTS:
            log(f"    [{ev['id']}] {name} 점 {len(pts)}개 — 상한 초과로 제외")
            continue
        conv = to_sofa(pts, side, dirs)
        if conv:
            players[pid] = conv
    return {"status": "ok", "players": players, "dirs": dirs, "unmatched": unmatched,
            "msg": f"{len(players)}명" + (f" (전 피리어드 방향 미판별)" if len(dirs) < 2 else "")}


def compare(conn, limit):
    """SofaScore 히트맵이 있는 최근 경기: 변환 결과를 원본과 선수별 통계로 대조 (읽기 전용)."""
    evs = conn.execute(
        """SELECT e.id, m.year, m.league_id, m.meet_seq, m.game_id FROM events e
        JOIN kleague_event_map m ON m.sofa_event_id = e.id
        WHERE e.tournament_id IN (410, 777) AND EXISTS (SELECT 1 FROM heatmap_points h WHERE h.event_id = e.id)
        ORDER BY e.date_ts DESC LIMIT ?""", (limit,)).fetchall()
    rows = []
    for ev in evs:
        r = process_event(conn, ev, only_missing=False)
        if r["status"] != "ok":
            log(f"  [{ev['id']}] {r['status']}: {r['msg']}")
            continue
        for pid, T in r["players"].items():
            S = conn.execute("SELECT x, y FROM heatmap_points WHERE event_id=? AND player_id=?", (ev["id"], pid)).fetchall()
            if len(S) < 5 or len(T) < 5:
                continue
            rows.append((len(T) / len(S),
                         abs(st.mean(p[0] for p in T) - st.mean(p[0] for p in S)),
                         abs(st.mean(p[1] for p in T) - st.mean(p[1] for p in S))))
        log(f"  [{ev['id']}] 방향 {r['dirs']} · {r['msg']} · 매핑 실패 {r['unmatched']}")
    if rows:
        log(f"대조 선수 {len(rows)}명 · 점 개수 비율 중앙값 {st.median(r[0] for r in rows):.2f} · "
            f"평균 위치 차 |x| {st.median(r[1] for r in rows):.1f} · |y| {st.median(r[2] for r in rows):.1f} "
            f"(최대 |x| {max(r[1] for r in rows):.1f} · |y| {max(r[2] for r in rows):.1f})")
    else:
        log("대조할 선수 없음")


def main() -> None:
    ap = argparse.ArgumentParser(description="K리그 공식 히트맵 → heatmap_points (기본 dry-run)")
    ap.add_argument("--apply", action="store_true", help="실제 저장 (없으면 dry-run)")
    ap.add_argument("--since", default=DEFAULT_SINCE, help=f"이 날짜 이후 경기만 (기본 {DEFAULT_SINCE})")
    ap.add_argument("--limit", type=int, default=300, help="한 번에 처리할 최대 경기 수 (안전장치)")
    ap.add_argument("--days", type=int, help="최근 N일 경기만 (지정 시 --since 무시 — update_data 정기 실행용)")
    ap.add_argument("--compare", type=int, metavar="N", help="SofaScore 히트맵 보유 최근 N경기 대조 (읽기 전용)")
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
    targets = conn.execute(TARGET_SQL, (since_ts,)).fetchall()[: args.limit]
    log(f"[{'APPLY(저장)' if args.apply else 'DRY-RUN(저장 안 함)'}] 히트맵 빈 선수가 있는 경기 {len(targets)} (since {args.since})")

    counts = {"ok": 0, "pending": 0, "skip": 0, "fail": 0}
    players = points = 0
    for i, ev in enumerate(targets):
        r = process_event(conn, ev)
        counts[r["status"]] += 1
        if r["status"] != "ok":
            log(f"  [{ev['id']}] {r['status']}: {r['msg']}")
            continue
        players += len(r["players"]); points += sum(len(v) for v in r["players"].values())
        if args.apply and r["players"]:
            with conn:   # 경기 단위 트랜잭션
                for pid, pts in r["players"].items():
                    conn.executemany("INSERT INTO heatmap_points (player_id, event_id, x, y) VALUES (?,?,?,?)",
                                     [(pid, ev["id"], x, y) for x, y in pts])
                    conn.execute("INSERT OR REPLACE INTO kleague_recovery_log (event_id, kind, player_id, rows, note) "
                                 "VALUES (?, 'heatmap', ?, ?, ?)", (ev["id"], pid, len(pts), json.dumps(r["dirs"])))
        if (i + 1) % 10 == 0 or (i + 1) == len(targets):
            log(f"  [{i+1}/{len(targets)}] 수집 {counts['ok']} · 미공개 {counts['pending']} · 건너뜀 {counts['skip']} · 실패 {counts['fail']}")
    conn.close()
    log(f"\n완료: 경기 {counts['ok']} / 미공개 {counts['pending']} / 건너뜀 {counts['skip']} / 실패 {counts['fail']} — "
        f"선수 {players:,}명 · 점 {points:,}개" + ("" if args.apply else " (dry-run: 저장 안 함)"))
    done = counts["ok"] + counts["pending"] + counts["skip"]
    fetch_health.abort_if_all_failed(done, done + counts["fail"], log, "kleague getHeatmapData")


if __name__ == "__main__":
    main()
