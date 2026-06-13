"""
init_league_db.py — 해외 리그 DB 파일 초기화

사용법:
    python crawlers/init_league_db.py --league epl
    python crawlers/init_league_db.py --league all   # 5개 해외 리그 전부

역할:
    - {league}.db 파일 생성 (없으면)
    - players.db와 동일한 공용 스키마 생성
    - K리그 전용 테이블(kleague_*)은 생성하지 않음
    - 멱등(이미 있는 테이블은 CREATE TABLE IF NOT EXISTS로 스킵)
"""

import argparse
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LEAGUE_REGISTRY = {
    "epl":        {"db": "epl.db",         "label": "Premier League", "tournament_ids": [17]},
    "laliga":     {"db": "laliga.db",       "label": "La Liga",        "tournament_ids": [8]},
    "bundesliga": {"db": "bundesliga.db",   "label": "Bundesliga",     "tournament_ids": [35]},
    "seriea":     {"db": "seriea.db",       "label": "Serie A",        "tournament_ids": [23]},
    "ligue1":     {"db": "ligue1.db",       "label": "Ligue 1",        "tournament_ids": [34]},
}

SCHEMA_SQL = """
-- 팀 마스터
CREATE TABLE IF NOT EXISTS teams (
    id            INTEGER PRIMARY KEY,
    name          TEXT,
    name_ko       TEXT,
    short_name    TEXT,
    league        TEXT,
    tournament_id INTEGER,
    season_id     INTEGER,
    primary_color TEXT,
    secondary_color TEXT
);

-- 선수 기본정보
CREATE TABLE IF NOT EXISTS players (
    id        INTEGER PRIMARY KEY,
    team_id   INTEGER,
    name      TEXT,
    name_ko   TEXT,
    position  TEXT,
    height    INTEGER,
    weight    INTEGER,
    birth_date TEXT,
    nationality TEXT,
    jersey_number INTEGER
);

-- 경기 메타
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY,
    tournament_id   INTEGER,
    season_id       INTEGER,
    home_team_id    INTEGER,
    away_team_id    INTEGER,
    home_score      INTEGER,
    away_score      INTEGER,
    date_ts         INTEGER,
    round           INTEGER,
    status          TEXT,
    venue_name      TEXT,
    venue_lat       REAL,
    venue_lon       REAL
);

-- 경기별 선수 세부 스탯
CREATE TABLE IF NOT EXISTS match_player_stats (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id            INTEGER,
    player_id           INTEGER,
    player_name         TEXT,
    team_id             INTEGER,
    is_home             INTEGER,
    minutes_played      INTEGER,
    position            TEXT,
    rating              REAL,
    goals               INTEGER,
    assists             INTEGER,
    expected_goals      REAL,
    expected_assists    REAL,
    total_shots         INTEGER,
    shots_on_target     INTEGER,
    big_chances_missed  INTEGER,
    passes_total        INTEGER,
    passes_accurate     INTEGER,
    key_passes          INTEGER,
    dribbles_attempted  INTEGER,
    dribbles_succeeded  INTEGER,
    duel_won            INTEGER,
    duel_lost           INTEGER,
    tackles             INTEGER,
    interceptions       INTEGER,
    clearances          INTEGER,
    errors_leading_to_shot INTEGER,
    long_balls          INTEGER,
    long_balls_accurate INTEGER,
    crosses             INTEGER,
    crosses_accurate    INTEGER,
    aerial_won          INTEGER,
    aerial_lost         INTEGER,
    fouls_committed     INTEGER,
    fouls_suffered      INTEGER,
    yellow_cards        INTEGER,
    red_cards           INTEGER,
    saves               INTEGER,
    goals_conceded      INTEGER,
    UNIQUE(event_id, player_id)
);

-- 히트맵 좌표
CREATE TABLE IF NOT EXISTS heatmap_points (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    event_id  INTEGER,
    x         REAL,
    y         REAL
);

-- 라인업
CREATE TABLE IF NOT EXISTS match_lineups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER,
    player_id    INTEGER,
    team_id      INTEGER,
    is_home      INTEGER,
    is_starter   INTEGER,
    position     TEXT,
    formation_slot TEXT,
    slot_order   INTEGER,
    jersey_number INTEGER,
    detail_pos   TEXT,
    UNIQUE(event_id, player_id)
);

-- 평균 포지션 (팀 형태 분석)
CREATE TABLE IF NOT EXISTS match_avg_positions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      INTEGER,
    player_id     INTEGER,
    team_id       INTEGER,
    is_home       INTEGER,
    is_substitute INTEGER,
    avg_x         REAL,
    avg_y         REAL,
    UNIQUE(event_id, player_id)
);

-- 슛맵
CREATE TABLE IF NOT EXISTS match_shotmap (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER,
    player_id    INTEGER,
    player_name  TEXT,
    team_id      INTEGER,
    is_home      INTEGER,
    x            REAL,
    y            REAL,
    xg           REAL,
    outcome      TEXT,
    situation    TEXT,
    body_part    TEXT,
    minute       INTEGER,
    added_time   INTEGER,
    UNIQUE(event_id, player_id, minute, x, y)
);

-- 골 이벤트
CREATE TABLE IF NOT EXISTS goal_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER,
    player_id    INTEGER,
    team_id      INTEGER,
    minute       INTEGER,
    added_time   INTEGER,
    is_penalty   INTEGER DEFAULT 0,
    is_own_goal  INTEGER DEFAULT 0,
    UNIQUE(event_id, player_id, minute)
);

-- 카드 이벤트
CREATE TABLE IF NOT EXISTS card_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   INTEGER,
    player_id  INTEGER,
    team_id    INTEGER,
    minute     INTEGER,
    card_type  TEXT,
    UNIQUE(event_id, player_id, minute)
);

-- 교체 이벤트
CREATE TABLE IF NOT EXISTS sub_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER,
    player_in   INTEGER,
    player_out  INTEGER,
    team_id     INTEGER,
    minute      INTEGER,
    UNIQUE(event_id, player_in)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_mps_event     ON match_player_stats(event_id);
CREATE INDEX IF NOT EXISTS idx_mps_player    ON match_player_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_mps_team      ON match_player_stats(team_id);
CREATE INDEX IF NOT EXISTS idx_hm_player     ON heatmap_points(player_id);
CREATE INDEX IF NOT EXISTS idx_hm_event      ON heatmap_points(event_id);
CREATE INDEX IF NOT EXISTS idx_events_tid    ON events(tournament_id);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(date_ts);
CREATE INDEX IF NOT EXISTS idx_lu_event      ON match_lineups(event_id);
CREATE INDEX IF NOT EXISTS idx_lu_player     ON match_lineups(player_id);
CREATE INDEX IF NOT EXISTS idx_avg_event     ON match_avg_positions(event_id);
CREATE INDEX IF NOT EXISTS idx_shot_event    ON match_shotmap(event_id);
CREATE INDEX IF NOT EXISTS idx_shot_player   ON match_shotmap(player_id);
CREATE INDEX IF NOT EXISTS idx_goal_event    ON goal_events(event_id);
CREATE INDEX IF NOT EXISTS idx_card_event    ON card_events(event_id);
"""


def init_db(league_code: str):
    cfg = LEAGUE_REGISTRY.get(league_code)
    if not cfg:
        print(f"[ERROR] 알 수 없는 리그 코드: {league_code}")
        print(f"  유효한 코드: {', '.join(LEAGUE_REGISTRY)}")
        return False

    db_path = os.path.join(BASE_DIR, cfg["db"])
    already_exists = os.path.exists(db_path)

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    conn.close()

    status = "기존 DB 갱신" if already_exists else "신규 생성"
    print(f"[OK] {cfg['label']} ({league_code}) -> {db_path} [{status}]")
    print(f"     tournament_id: {cfg['tournament_ids']}")
    return True


def main():
    parser = argparse.ArgumentParser(description="해외 리그 DB 초기화")
    parser.add_argument("--league", required=True,
                        help=f"리그 코드 또는 'all'. 선택: {', '.join(LEAGUE_REGISTRY)}, all")
    args = parser.parse_args()

    targets = list(LEAGUE_REGISTRY.keys()) if args.league == "all" else [args.league]
    success = 0
    for code in targets:
        if init_db(code):
            success += 1

    print(f"\n완료: {success}/{len(targets)} 리그 초기화")


if __name__ == "__main__":
    main()
