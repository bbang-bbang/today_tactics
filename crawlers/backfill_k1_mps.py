#!/usr/bin/env python3
"""
K1 match_player_stats 백필 — events 테이블 기반 직접 수집.
기존 crawl_match_stats.py는 팀별 API(fetch_team_events) 경유라 구형 경기 일부 누락.
이 스크립트는 events 테이블의 K1 종료 경기 중 mps 미커버 경기를 직접
/api/v1/event/{id}/lineups 호출로 백필한다.
"""

import argparse
import asyncio
import json
import os
import sqlite3
import sys
from playwright.async_api import async_playwright

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, "players.db")
DELAY    = 0.5

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def parse_stats(s):
    """SofaScore statistics dict → 컬럼 값 dict"""
    def g(k): return s.get(k)
    _ap = g("accuratePass")
    _tp = g("totalPass")
    _pass_pct = round(_ap / _tp * 100, 1) if (_ap is not None and _tp) else None
    return {
        "minutes_played":       g("minutesPlayed"),
        "rating":               g("rating"),
        "goals":                g("goals"),
        "assists":              g("goalAssist"),
        "total_shots":          g("totalShots"),
        "shots_on_target":      g("onTargetScoringAttempt"),
        "big_chances_missed":   g("bigChanceMissed"),
        "expected_goals":       g("expectedGoals"),
        "total_passes":         _tp,
        "accurate_passes":      _ap,
        "accurate_passes_pct":  _pass_pct,
        "key_passes":           g("keyPass"),
        "accurate_long_balls":  g("accurateLongBalls"),
        "total_long_balls":     g("totalLongBalls"),
        "accurate_crosses":     g("accurateCross"),
        "total_crosses":        g("totalCross"),
        "successful_dribbles":  g("wonContest"),
        "attempted_dribbles":   g("totalContest"),
        "touches":              g("touches"),
        "possession_lost":      g("possessionLostCtrl"),
        "tackles":              g("totalTackle"),
        "interceptions":        g("interceptionWon"),
        "clearances":           g("totalClearance"),
        "blocked_shots":        g("outfielderBlock"),
        "duel_won":             g("duelWon"),
        "duel_lost":            g("duelLost"),
        "aerial_won":           g("aerialWon"),
        "aerial_lost":          g("aerialLost"),
        "won_tackle":           g("wonTackle"),
        "ball_recovery":        g("ballRecovery"),
        "challenge_lost":       g("challengeLost"),
        "was_fouled":           g("wasFouled"),
        "fouls":                g("fouls"),
        "yellow_cards":         g("yellowCard"),
        "red_cards":            g("redCard"),
        "saves":                g("saves"),
        "goals_conceded":       g("goalsConceded"),
    }


def save_player_stat(conn, event_id, player_id, team_id, is_home,
                     position, shirt_number, stats_raw, s_dict):
    cols = list(s_dict.keys())
    vals = list(s_dict.values())
    conn.execute(f"""
        INSERT OR REPLACE INTO match_player_stats
            (event_id, player_id, team_id, is_home, position, shirt_number,
             {', '.join(cols)}, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, {', '.join(['?']*len(cols))}, ?)
    """, [event_id, player_id, team_id, is_home, position, shirt_number,
          *vals, json.dumps(stats_raw, ensure_ascii=False)])


async def api_fetch(page, path, retries=2):
    for attempt in range(retries + 1):
        try:
            r = await page.evaluate(f"""() =>
                fetch('{path}').then(r => r.ok ? r.json() : r.status).catch(() => null)
            """)
            return r
        except Exception:
            if attempt < retries:
                try:
                    await page.goto("https://www.sofascore.com", wait_until="domcontentloaded", timeout=30000)
                    await asyncio.sleep(2)
                except Exception:
                    pass
    return None


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["K1", "K2"], default="K1")
    parser.add_argument("--limit",  type=int, default=None, help="최대 수집 경기 수 (테스트용)")
    args = parser.parse_args()

    tid_filter = 410 if args.league == "K1" else 777

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # 종료 경기 중 mps row 없거나 minutes_played NULL인 경기
    # (mins NULL은 SofaScore가 매치 직후 늦게 반영 — 후속 백필 필요)
    cur.execute("""
        SELECT e.id, e.date_ts, e.home_team_id, e.away_team_id
        FROM events e
        WHERE e.tournament_id = ?
          AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
          AND e.id < 50000000
          AND NOT EXISTS (
            SELECT 1 FROM match_player_stats mps
            WHERE mps.event_id = e.id AND mps.minutes_played IS NOT NULL
          )
        ORDER BY e.date_ts DESC
    """, (tid_filter,))
    events_todo = cur.fetchall()
    if args.limit:
        events_todo = events_todo[:args.limit]

    log(f"[{args.league}] backfill 대상: {len(events_todo)}경기 (events에는 있지만 mps 없음)")
    if not events_todo:
        log("완료할 작업 없음.")
        return

    session_url = "https://www.sofascore.com/tournament/football/south-korea/k-league-1/410" \
        if args.league == "K1" else "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777"

    ok = skip = 0
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await ctx.new_page()
        await page.goto(session_url, wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)
        log("세션 준비 완료")

        for i, (eid, date_ts, hid, aid) in enumerate(events_todo):
            data = await api_fetch(page, f"/api/v1/event/{eid}/lineups")
            if not isinstance(data, dict) or ("home" not in data and "away" not in data):
                skip += 1
                if (i+1) % 20 == 0:
                    log(f"  [{i+1}/{len(events_todo)}] 진행 중... (ok={ok}, skip={skip})")
                await asyncio.sleep(DELAY)
                continue

            saved = 0
            for side, is_home in [("home", 1), ("away", 0)]:
                side_data = data.get(side, {}) or {}
                players  = side_data.get("players", []) or []
                for entry in players:
                    entry_team_id = entry.get("teamId") or (hid if is_home else aid)
                    player = entry.get("player") or {}
                    pid = player.get("id")
                    if not pid:
                        continue
                    stats_raw = entry.get("statistics") or {}
                    s_dict = parse_stats(stats_raw)
                    pos = entry.get("position") or player.get("position", "") or ""
                    shirt = entry.get("shirtNumber")
                    try:
                        save_player_stat(conn, eid, pid, entry_team_id, is_home,
                                         pos, shirt, stats_raw, s_dict)
                        saved += 1
                    except Exception as e:
                        log(f"    save error player {pid}: {e}")
            conn.commit()
            ok += 1
            if (i+1) % 20 == 0 or saved == 0:
                log(f"  [{i+1}/{len(events_todo)}] event {eid} → {saved}명 저장 (ok={ok}, skip={skip})")
            await asyncio.sleep(DELAY)

        await browser.close()

    conn.close()
    log(f"\n완료: {ok}경기 수집, {skip}경기 스킵")


if __name__ == "__main__":
    asyncio.run(main())
