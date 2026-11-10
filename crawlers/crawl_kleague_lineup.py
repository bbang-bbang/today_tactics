"""K리그 공식 포털(kleague.com) 라인업 스크래퍼.

3단계 구조:
  1) collect_schedule()  — getScheduleList.do API로 매치 메타 수집 (kleague_schedule)
  2) map_events()        — SofaScore event_id ↔ K리그 (year,leagueId,gameId,meetSeq) 매칭
                            (날짜 + home/away K-ID 기준)
  3) collect_lineups()   — match.do HTML 파싱으로 player-data 좌표 + 이름 + 등번호 수집
                            (kleague_lineup)

스키마:
  kleague_schedule(year, league_id, game_id, meet_seq, game_date, home_kid, away_kid,
                   home_goal, away_goal, end_yn, PRIMARY KEY(year, league_id, game_id, meet_seq))
  kleague_event_map(sofa_event_id INTEGER PRIMARY KEY,
                    year, league_id, game_id, meet_seq, mapping_method)
  kleague_lineup(sofa_event_id, side, back_no, player_name, top_pct, left_pct,
                 PRIMARY KEY(sofa_event_id, side, back_no))

호출 예:
  python crawlers/crawl_kleague_lineup.py schedule --year 2026
  python crawlers/crawl_kleague_lineup.py map
  python crawlers/crawl_kleague_lineup.py lineup
  python crawlers/crawl_kleague_lineup.py all --year 2026
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "players.db"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
BASE = "https://www.kleague.com"
SCHEDULE_URL = f"{BASE}/getScheduleList.do"
MATCH_URL = f"{BASE}/match.do"
SLEEP_BETWEEN = 0.8  # rate limit 보수치 (초)

PLAYER_DATA_RE = re.compile(
    r'<div class="player-data" style="top:\s*([\d.]+)%;\s*left:\s*([\d.]+)%;">.*?'
    r'<p>(\d+)\.([^<]+)</p>',
    re.DOTALL,
)


# ── DB 스키마 ─────────────────────────────────────────────────────
def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS kleague_schedule (
            year       INTEGER NOT NULL,
            league_id  INTEGER NOT NULL,
            game_id    INTEGER NOT NULL,
            meet_seq   INTEGER NOT NULL,
            game_date  TEXT NOT NULL,    -- 'YYYY-MM-DD'
            game_time  TEXT,             -- 'HH:MM'
            home_kid   TEXT,             -- 'K02' etc
            away_kid   TEXT,
            home_team_name  TEXT,
            away_team_name  TEXT,
            home_goal  INTEGER,
            away_goal  INTEGER,
            end_yn     TEXT,
            PRIMARY KEY (year, league_id, game_id, meet_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_kleague_schedule_date
            ON kleague_schedule(game_date, home_kid, away_kid);

        CREATE TABLE IF NOT EXISTS kleague_event_map (
            sofa_event_id   INTEGER PRIMARY KEY,
            year            INTEGER NOT NULL,
            league_id       INTEGER NOT NULL,
            game_id         INTEGER NOT NULL,
            meet_seq        INTEGER NOT NULL,
            mapping_method  TEXT,
            mapped_at       TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS kleague_lineup (
            sofa_event_id   INTEGER NOT NULL,
            side            TEXT NOT NULL,    -- 'home' or 'away'
            back_no         INTEGER NOT NULL,
            player_name     TEXT NOT NULL,
            top_pct         REAL NOT NULL,    -- 캔버스 top% (큰 값=자기 골대 쪽)
            left_pct        REAL NOT NULL,    -- 캔버스 left% (좌측=0, 우측=100)
            is_starter      INTEGER DEFAULT 1,
            PRIMARY KEY (sofa_event_id, side, back_no)
        );
        CREATE INDEX IF NOT EXISTS idx_kleague_lineup_event
            ON kleague_lineup(sofa_event_id);
    """)
    conn.commit()


# ── HTTP 유틸 ─────────────────────────────────────────────────────
def http_post_json(url: str, payload: dict, timeout: int = 15) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def http_get_text(url: str, timeout: int = 15) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


# ── 1) 스케줄 수집 ─────────────────────────────────────────────────
def collect_schedule(conn: sqlite3.Connection, year: int, league_ids=(1, 2)) -> int:
    """year × league × month(1~12) 전수 스케줄을 kleague_schedule에 적재."""
    cur = conn.cursor()
    inserted = 0
    for lid in league_ids:
        for month in range(1, 13):
            payload = {
                "leagueId": lid,
                "teamId": "",
                "ticketStatus": "",
                "year": str(year),
                "month": f"{month:02d}",
                "ticketYn": "",
            }
            try:
                data = http_post_json(SCHEDULE_URL, payload)
            except Exception as e:
                print(f"  schedule fail year={year} lid={lid} m={month}: {e}")
                continue
            time.sleep(SLEEP_BETWEEN)
            sched = (data.get("data") or {}).get("scheduleList") or []
            for s in sched:
                gd = (s.get("gameDate") or "").replace(".", "-")
                cur.execute("""
                    INSERT OR REPLACE INTO kleague_schedule
                      (year, league_id, game_id, meet_seq, game_date, game_time,
                       home_kid, away_kid, home_team_name, away_team_name,
                       home_goal, away_goal, end_yn)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    s.get("year"), s.get("leagueId"), s.get("gameId"), s.get("meetSeq"),
                    gd, s.get("gameTime"),
                    s.get("homeTeam"), s.get("awayTeam"),
                    s.get("homeTeamName"), s.get("awayTeamName"),
                    s.get("homeGoal"), s.get("awayGoal"),
                    s.get("endYn"),
                ))
                inserted += 1
            print(f"  year={year} lid={lid} m={month:02d}: {len(sched)} 매치")
    conn.commit()
    return inserted


# ── 2) SofaScore event ↔ K리그 매핑 ──────────────────────────────
def _emblem_to_kid(emblem: str) -> str | None:
    """'emblem_K02.png' → 'K02'."""
    m = re.match(r"emblem_(K\d{2})\.png", emblem or "")
    return m.group(1) if m else None


def _load_team_kid_map(conn: sqlite3.Connection) -> dict:
    """sofascore_id → K-ID. main.py TEAMS는 import 부담 — events 메타와 emblem 결합."""
    # main.py를 import해서 TEAMS 쓰는 게 안전
    sys.path.insert(0, str(ROOT))
    from main import TEAMS
    return {t["sofascore_id"]: _emblem_to_kid(t.get("emblem")) for t in TEAMS if t.get("emblem")}


def map_events(conn: sqlite3.Connection) -> int:
    """events(SofaScore) ↔ kleague_schedule 매칭. (date, home_kid, away_kid) 기준."""
    cur = conn.cursor()
    ss_to_kid = _load_team_kid_map(conn)

    cur.execute("""
        SELECT e.id, e.home_team_id, e.away_team_id,
               date(e.date_ts, 'unixepoch', 'localtime') AS d
        FROM events e
        WHERE e.tournament_id IN (410, 777)
          AND e.home_team_id IS NOT NULL AND e.away_team_id IS NOT NULL
    """)
    matched, unmatched_team, unmatched_sched = 0, 0, 0
    for ev_id, ht_ss, at_ss, d in cur.fetchall():
        ht_kid = ss_to_kid.get(ht_ss)
        at_kid = ss_to_kid.get(at_ss)
        if not ht_kid or not at_kid:
            unmatched_team += 1
            continue
        row = conn.execute("""
            SELECT year, league_id, game_id, meet_seq
            FROM kleague_schedule
            WHERE game_date = ? AND home_kid = ? AND away_kid = ?
            LIMIT 1
        """, (d, ht_kid, at_kid)).fetchone()
        if not row:
            unmatched_sched += 1
            continue
        cur.execute("""
            INSERT OR REPLACE INTO kleague_event_map
              (sofa_event_id, year, league_id, game_id, meet_seq, mapping_method)
            VALUES (?,?,?,?,?, 'date_kid')
        """, (ev_id, row[0], row[1], row[2], row[3]))
        matched += 1
    conn.commit()
    print(f"  매핑: {matched}, 팀 KID 부재: {unmatched_team}, 스케줄 부재: {unmatched_sched}")
    return matched


# ── 3) 라인업 스크래핑 ─────────────────────────────────────────────
def fetch_match_page(year: int, lid: int, gid: int, mseq: int) -> str:
    url = (
        f"{MATCH_URL}?year={year}&leagueId={lid}"
        f"&gameId={gid}&meetSeq={mseq}&startTabNum=3"
    )
    return http_get_text(url)


def parse_lineup_html(html: str):
    """반환: [(side, [(top, left, back_no, name), ...]), ...] (home, away 순서)."""
    # 두 lineup 섹션 (home/away) 추출 — 첫 번째가 HOME, 두 번째가 AWAY
    # K리그 클래스 표기가 둘 다 'lineup away'인데 순서로 구분
    blocks = re.findall(
        r'<div class="lineup [a-z]+">.*?<div class="ground">(.*?)</div>\s*<div class="standby">',
        html, flags=re.DOTALL,
    )
    out = []
    for side, b in zip(("home", "away"), blocks):
        players = []
        for top, left, no, name in PLAYER_DATA_RE.findall(b):
            players.append((float(top), float(left), int(no), name.strip()))
        out.append((side, players))
    return out


def collect_lineups(conn: sqlite3.Connection, limit: int | None = None, min_year: int = 0) -> int:
    """kleague_event_map에 매핑된 event들 중 kleague_lineup 미보유 매치만 수집 (min_year 이후 시즌만)."""
    cur = conn.cursor()
    cur.execute("""
        SELECT m.sofa_event_id, m.year, m.league_id, m.game_id, m.meet_seq
        FROM kleague_event_map m
        LEFT JOIN (
            SELECT DISTINCT sofa_event_id FROM kleague_lineup
        ) l ON l.sofa_event_id = m.sofa_event_id
        WHERE l.sofa_event_id IS NULL AND m.year >= ?
    """, (min_year,))
    todo = cur.fetchall()
    if limit:
        todo = todo[:limit]
    print(f"  수집 대상: {len(todo)} 매치")
    ok, fail = 0, 0
    for i, (ev_id, year, lid, gid, mseq) in enumerate(todo, 1):
        try:
            html = fetch_match_page(year, lid, gid, mseq)
            blocks = parse_lineup_html(html)
        except Exception as e:
            fail += 1
            print(f"    [{i}/{len(todo)}] ev={ev_id} fail: {e}")
            time.sleep(SLEEP_BETWEEN)
            continue
        if len(blocks) != 2 or not all(len(p) == 11 for _, p in blocks):
            fail += 1
            time.sleep(SLEEP_BETWEEN)
            continue
        for side, players in blocks:
            for top, left, no, name in players:
                cur.execute("""
                    INSERT OR REPLACE INTO kleague_lineup
                      (sofa_event_id, side, back_no, player_name, top_pct, left_pct, is_starter)
                    VALUES (?,?,?,?,?,?,1)
                """, (ev_id, side, no, name, top, left))
        ok += 1
        if i % 50 == 0:
            conn.commit()
            print(f"    [{i}/{len(todo)}] ok={ok} fail={fail}")
        time.sleep(SLEEP_BETWEEN)
    conn.commit()
    print(f"  완료: ok={ok}, fail={fail}")
    return ok


# ── CLI ───────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["schedule", "map", "lineup", "all", "schema"])
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--years", default="2024,2025,2026")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--min-year", type=int, default=0, help="lineup 단계: 이 시즌 이후 경기만 (과거 시즌 백필 범위 제한)")
    args = ap.parse_args()

    conn = sqlite3.connect(str(DB))
    ensure_schema(conn)

    if args.phase == "schema":
        print("스키마 생성 완료")
        return 0

    if args.phase in ("schedule", "all"):
        years = [int(y) for y in args.years.split(",")] if args.phase == "all" else [args.year]
        for y in years:
            print(f"[schedule] year={y}")
            collect_schedule(conn, y)
    if args.phase in ("map", "all"):
        print("[map] events ↔ kleague_schedule 매칭")
        map_events(conn)
    if args.phase in ("lineup", "all"):
        print("[lineup] match.do HTML 파싱 수집")
        collect_lineups(conn, limit=args.limit, min_year=args.min_year)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
