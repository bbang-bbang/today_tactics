#!/usr/bin/env python3
"""
K리그 포털(portal.kleague.com)에서 매치별 formation을 받아
match_lineups.formation 컬럼을 덮어쓴다.

K리그 공식 분류 (예: 4-4-2)가 SofaScore 분류 (예: 4-1-4-1)보다
사용자 인식과 일치하는 케이스가 있어 K리그 우선 적용.

흐름:
  1. K리그 공식 API getScheduleList → 종료 매치 (gameId, meetSeq, gameDate, homeTeam K-code, awayTeam K-code)
  2. (gameDate, sofascore home/away id) 매핑으로 events.id 찾기
  3. portal.kleague.com mainFrame.do?selectedMenuCd=0013&mainGameId=...&mainMeetYear=...&mainMeetSeq=...
     HTML에서 #homeFormation / #awayFormation .text('X - Y - Z') 추출
  4. UPDATE match_lineups SET formation = ? WHERE event_id = ? AND is_home = ?
     (formation_kleague 컬럼 추가하지 않고 직접 덮어쓰기)
"""

import argparse
import json
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE = Path(__file__).resolve().parent.parent
DB_PATH = str(BASE / "players.db")

# K리그 portal 팀 코드 → 우리 시스템 슬러그 (update_results_2026.py와 동일)
TEAM_CODE_MAP = {
    "K01": "ulsan",   "K02": "suwon",    "K03": "pohang",  "K04": "jeju",
    "K05": "jeonbuk", "K06": "busan",    "K07": "jeonnam", "K08": "seongnam",
    "K09": "fcseoul", "K10": "daejeon",  "K17": "daegu",   "K18": "incheon",
    "K20": "gyeongnam","K21": "gangwon", "K22": "gwangju", "K26": "bucheon",
    "K27": "anyang",  "K29": "suwon_fc", "K31": "seouland","K32": "ansan",
    "K34": "asan",    "K35": "gimcheon", "K36": "gimpo",   "K37": "cheongju",
    "K38": "cheonan", "K39": "hwaseong", "K40": "paju",    "K41": "gimhae",
    "K42": "yongin",
}

# 슬러그 → SofaScore team id (main.py의 TEAMS와 동일)
SLUG_TO_SS = {
    "ulsan": 7653, "pohang": 7650, "jeju": 7649, "jeonbuk": 6908,
    "fcseoul": 7646, "daejeon": 7645, "incheon": 7648, "gangwon": 34220,
    "gwangju": 48912, "bucheon": 92539, "anyang": 32675, "gimcheon": 7647,
    "suwon": 7652, "busan": 7642, "jeonnam": 7643, "seongnam": 7651,
    "daegu": 7644, "gyeongnam": 22020, "suwon_fc": 41261, "seouland": 189422,
    "ansan": 248375, "asan": 339827, "gimpo": 195172, "cheongju": 314293,
    "cheonan": 41263, "hwaseong": 195174, "paju": 314294, "gimhae": 41260,
    "yongin": 41266,
}


def log(msg):
    print(msg, flush=True)


def fetch_schedule(league_id, year, month):
    """K리그 공식 API 월별 일정"""
    payload = json.dumps({
        "leagueId": str(league_id), "year": str(year), "month": str(month).zfill(2)
    }).encode()
    req = urllib.request.Request(
        "https://www.kleague.com/getScheduleList.do",
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read()).get("data", {}).get("scheduleList", [])
    except Exception as e:
        log(f"  schedule fetch error: {e}")
        return []


def get_portal_session():
    cmd = ["curl", "-s", "-I", "-L",
           "https://portal.kleague.com/user/loginById.do?portalGuest=rstNE9zxjdkUC9kbUA08XQ==",
           "-H", "User-Agent: Mozilla/5.0", "--max-time", "30"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        m = re.search(r"JSESSIONID=([A-F0-9]+)", r.stdout)
        return m.group(1) if m else None
    except Exception as e:
        log(f"  session error: {e}")
        return None


def fetch_match_html(session_id, game_id, meet_year, meet_seq):
    cmd = [
        "curl", "-s", "https://portal.kleague.com/mainFrame.do",
        "-X", "POST",
        "-H", "User-Agent: Mozilla/5.0",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-H", f"Cookie: JSESSIONID={session_id}",
        "-d", f"selectedMenuCd=0013&mainMeetYear={meet_year}&mainMeetSeq={meet_seq}&mainGameId={game_id}",
        "--max-time", "20"
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        return r.stdout or ""
    except Exception as e:
        log(f"  fetch error: {e}")
        return ""


# JS 패턴: $("#homeFormation").text('4 - 4 - 2');
RE_FORMATION = re.compile(
    r'\$\("#(home|away)Formation"\)\.text\(\'([0-9 \-]+)\'\)',
    re.IGNORECASE
)


def parse_formations(html):
    """HTML에서 home/away formation 추출 → (home_str, away_str)"""
    found = {"home": None, "away": None}
    for m in RE_FORMATION.finditer(html):
        side = m.group(1).lower()
        # '4 - 4 - 2' → '4-4-2'
        norm = m.group(2).replace(" ", "")
        found[side] = norm
    return found["home"], found["away"]


def find_event_id(conn, date_str, home_ss, away_ss):
    """events 테이블에서 (date YYYY-MM-DD, home_team_id, away_team_id)로 event_id 조회"""
    # K리그 portal date "2026.05.03" → 2026-05-03
    dt_str = date_str.replace(".", "-")[:10]
    from datetime import datetime
    try:
        dt = datetime.strptime(dt_str, "%Y-%m-%d")
    except ValueError:
        return None
    start_ts = int(dt.timestamp())
    end_ts = start_ts + 86400
    row = conn.execute("""
        SELECT id FROM events
        WHERE date_ts >= ? AND date_ts < ?
          AND home_team_id = ? AND away_team_id = ?
        LIMIT 1
    """, (start_ts, end_ts, home_ss, away_ss)).fetchone()
    return row[0] if row else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--from-month", type=int, default=2)
    ap.add_argument("--to-month", type=int, default=None,
                    help="기본: 현재 월")
    args = ap.parse_args()

    if args.to_month is None:
        from datetime import datetime
        args.to_month = datetime.now().month

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # 안전망: 기존 formation을 별도 컬럼에 백업
    cur.execute("PRAGMA table_info(match_lineups)")
    cols = {r[1] for r in cur.fetchall()}
    if "formation_sofa" not in cols:
        cur.execute("ALTER TABLE match_lineups ADD COLUMN formation_sofa TEXT")
        cur.execute("UPDATE match_lineups SET formation_sofa = formation WHERE formation_sofa IS NULL")
        conn.commit()
        log("안전망: match_lineups.formation_sofa 컬럼 신설 + 기존값 보존")

    log(f"\nK리그 포털 formation 수집 — {args.year} 시즌, {args.from_month}~{args.to_month}월")
    session_id = get_portal_session()
    if not session_id:
        log("게스트 세션 획득 실패")
        return
    log(f"세션: {session_id[:8]}...")

    total_matches = updated = no_event = no_form = 0

    for league_id, league_name in [("1", "K1"), ("2", "K2")]:
        for month in range(args.from_month, args.to_month + 1):
            games = fetch_schedule(league_id, args.year, month)
            for g in games:
                if g.get("endYn") != "Y":
                    continue
                if g.get("homeGoal") is None or g.get("awayGoal") is None:
                    continue
                home_slug = TEAM_CODE_MAP.get(g.get("homeTeam", ""))
                away_slug = TEAM_CODE_MAP.get(g.get("awayTeam", ""))
                home_ss = SLUG_TO_SS.get(home_slug)
                away_ss = SLUG_TO_SS.get(away_slug)
                if not home_ss or not away_ss:
                    continue

                event_id = find_event_id(conn, g.get("gameDate", ""), home_ss, away_ss)
                if not event_id:
                    no_event += 1
                    continue

                game_id = g.get("gameId")
                meet_year = args.year
                meet_seq = g.get("meetSeq", 1) or 1

                html = fetch_match_html(session_id, game_id, meet_year, meet_seq)
                hf, af = parse_formations(html)

                if not hf and not af:
                    # 세션 만료 시 한번 재시도
                    session_id = get_portal_session() or session_id
                    html = fetch_match_html(session_id, game_id, meet_year, meet_seq)
                    hf, af = parse_formations(html)

                total_matches += 1
                changes = 0
                if hf:
                    cur.execute(
                        "UPDATE match_lineups SET formation=? WHERE event_id=? AND is_home=1",
                        (hf, event_id)
                    )
                    changes += cur.rowcount
                if af:
                    cur.execute(
                        "UPDATE match_lineups SET formation=? WHERE event_id=? AND is_home=0",
                        (af, event_id)
                    )
                    changes += cur.rowcount

                if changes:
                    updated += 1
                    log(f"  [{league_name}] {g.get('gameDate')} {g.get('homeTeamName')}({hf}) vs {g.get('awayTeamName')}({af})")
                else:
                    no_form += 1

                if total_matches % 30 == 0:
                    conn.commit()
                time.sleep(0.3)

    conn.commit()
    log(f"\n완료: 처리 {total_matches}경기 / formation 갱신 {updated}경기 / event 매칭 실패 {no_event} / 응답 없음 {no_form}")
    conn.close()


if __name__ == "__main__":
    main()
