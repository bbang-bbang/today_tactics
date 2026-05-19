#!/usr/bin/env python3
"""
kleague_results_2026.json → events 테이블 동기화
- SofaScore 크롤러로 수집되지 않은 최신 경기 결과를 events 테이블에 삽입
- ID 범위: 90000000~91000000 (SofaScore 실제 ID와 충돌 없음)
- INSERT OR IGNORE: 기존 SofaScore 데이터 덮어쓰지 않음
- score backfill: 기존 row가 있고 home_score가 NULL이면 결과 score만 UPDATE
  (SofaScore가 예정 매치 row를 score NULL로 미리 만들어둔 케이스를 채우기 위함)
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone, timedelta

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH     = os.path.join(BASE_DIR, "players.db")
RESULTS_FILE = os.path.join(BASE_DIR, "data", "kleague_results_2026.json")
KST         = timezone(timedelta(hours=9))

# 팀 슬러그 → (sofascore_id, tournament_id, team_name)
SLUG_META = {
    "ulsan":     (7653,  410, "Ulsan HD FC"),
    "pohang":    (7650,  410, "Pohang Steelers"),
    "jeju":      (7649,  410, "Jeju United"),
    "jeonbuk":   (6908,  410, "Jeonbuk Hyundai Motors"),
    "fcseoul":   (7646,  410, "FC Seoul"),
    "daejeon":   (7645,  410, "Daejeon Hana Citizen"),
    "incheon":   (7648,  410, "Incheon United"),
    "gangwon":   (34220, 410, "Gangwon FC"),
    "gwangju":   (48912, 410, "Gwangju FC"),
    "bucheon":   (92539, 410, "Bucheon FC 1995"),
    "anyang":    (32675, 410, "FC Anyang"),
    "gimcheon":  (7647,  410, "Gimcheon Sangmu FC"),
    "suwon":     (7652,  777, "Suwon Samsung Bluewings"),
    "busan":     (7642,  777, "Busan IPark"),
    "jeonnam":   (7643,  777, "Jeonnam Dragons"),
    "seongnam":  (7651,  777, "Seongnam FC"),
    "daegu":     (7644,  777, "Daegu FC"),
    "gyeongnam": (22020, 777, "Gyeongnam FC"),
    "suwon_fc":  (41261, 777, "Suwon FC"),
    "seouland":  (189422,777, "Seoul E-Land FC"),
    "ansan":     (248375,777, "Ansan Greeners FC"),
    "asan":      (339827,777, "Chungnam Asan FC"),
    "gimpo":     (195172,777, "Gimpo FC"),
    "cheongju":  (314293,777, "Chungbuk Cheongju FC"),
    "cheonan":   (41263, 777, "Cheonan City FC"),
    "hwaseong":  (195174,777, "Hwaseong FC"),
    "paju":      (314294,777, "Paju Citizen"),
    "gimhae":    (41260, 777, "Gimhae City FC"),
    "yongin":    (41266, 777, "Yongin City FC"),
}

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

def date_to_ts(date_str):
    """'2026-04-18' → KST 정오 unix timestamp"""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=12, tzinfo=KST)
    return int(dt.timestamp())

def synthetic_id(date_str, home_slug, away_slug):
    """(날짜, 홈, 어웨이) 조합으로 재현 가능한 고유 ID 생성 (90000000~91000000)"""
    raw = f"{date_str}_{home_slug}_{away_slug}"
    h = 0
    for c in raw:
        h = (h * 31 + ord(c)) & 0xFFFFFF
    return 90000000 + h % 1000000

def main():
    with open(RESULTS_FILE, encoding="utf-8") as f:
        all_results = json.load(f)

    # 고유 경기 재구성 (팀별 결과에서 중복 제거)
    seen = set()
    games = []
    for slug, matches in all_results.items():
        if slug not in SLUG_META:
            continue
        for m in matches:
            date  = m.get("date", "")
            opp   = m.get("opponent", "")
            is_home = m.get("home", True)
            score_raw = m.get("score", "")
            if not date or not opp or opp not in SLUG_META:
                continue
            home_slug = slug if is_home else opp
            away_slug = opp  if is_home else slug
            key = (date, home_slug, away_slug)
            if key in seen:
                continue
            seen.add(key)
            try:
                parts = score_raw.split("-")
                hs, as_ = int(parts[0]), int(parts[1])
            except Exception:
                continue
            games.append({
                "date": date, "home": home_slug, "away": away_slug,
                "home_score": hs, "away_score": as_,
            })

    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()

    inserted = 0
    updated  = 0
    skipped  = 0
    for g in sorted(games, key=lambda x: x["date"]):
        hm = SLUG_META[g["home"]]
        am = SLUG_META[g["away"]]
        tid = hm[1]  # tournament_id (K1=410, K2=777)
        ts  = date_to_ts(g["date"])
        eid = synthetic_id(g["date"], g["home"], g["away"])

        # 이미 같은 날짜 + 팀 조합이 있으면 score 보강만 시도, 없으면 INSERT
        cur.execute(
            "SELECT id, home_score FROM events WHERE home_team_id=? AND away_team_id=? AND date_ts BETWEEN ? AND ?",
            (hm[0], am[0], ts - 43200, ts + 43200)
        )
        row = cur.fetchone()
        if row:
            existing_eid, existing_score = row
            if existing_score is None:
                cur.execute(
                    "UPDATE events SET home_score=?, away_score=? WHERE id=?",
                    (g["home_score"], g["away_score"], existing_eid)
                )
                updated += 1
            else:
                skipped += 1
            continue

        cur.execute("""
            INSERT OR IGNORE INTO events
              (id, home_team_id, home_team_name, away_team_id, away_team_name,
               date_ts, home_score, away_score, tournament_id)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (eid, hm[0], hm[2], am[0], am[2], ts, g["home_score"], g["away_score"], tid))
        inserted += 1

    conn.commit()
    conn.close()

    log(f"삽입: {inserted}경기 / score 백필: {updated}경기 / 중복 스킵: {skipped}경기 / 전체: {len(games)}경기")

if __name__ == "__main__":
    main()
