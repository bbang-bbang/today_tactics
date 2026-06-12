# -*- coding: utf-8 -*-
"""
mps.team_id 정규화 — 경기 실제 소속(정규 팀 ID)으로 일치 (멱등).

진단(2026-06-12): match_player_stats.team_id가 같은 구단의 비정규 ID(시즌별 별칭/
현소속 고정)로 광범위하게 어긋남 — 전체의 61.6%(42,855/69,622)가 실제 경기팀과
불일치. events의 home/away는 정규 ID라, 올바른 소속 = (is_home ? home : away).
교정 타깃은 100% teams 마스터에 존재 → 무손실. 팀별 집계(team-top-players,
heatmap roster 등 WHERE mps.team_id=?)의 대량 누락 해소.

처리:
  A) mps.team_id = (is_home ? event.home_team_id : away_team_id)  — 불일치 행만.
  B) players.team_id = 최신 경기(date_ts max)의 소속팀 — 비정규/구식 등록팀 정규화.

안전: 단일 트랜잭션, 사전/사후 카운트. event home/away가 NULL이면 해당 행 건너뜀.
재실행해도 이미 정규화돼 있으면 0행 갱신(무해).
"""
import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "players.db")


def _mismatch(cur):
    return cur.execute("""
        SELECT COUNT(*) FROM match_player_stats m JOIN events e ON e.id = m.event_id
        WHERE (CASE WHEN m.is_home=1 THEN e.home_team_id ELSE e.away_team_id END) IS NOT NULL
          AND m.team_id != (CASE WHEN m.is_home=1 THEN e.home_team_id ELSE e.away_team_id END)
    """).fetchone()[0]


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    before = _mismatch(cur)
    orphan_before = cur.execute(
        "SELECT COUNT(*) FROM match_player_stats WHERE team_id NOT IN (SELECT id FROM teams)").fetchone()[0]
    print(f"[pre] team_id≠경기팀 mps={before:,}  / teams마스터에 없는 mps={orphan_before:,}")
    if before == 0:
        print("[skip] 이미 정규화됨")
        conn.close()
        return

    try:
        cur.execute("BEGIN")

        # A) mps.team_id 정규화 (불일치 + 경기 home/away 존재하는 행만)
        cur.execute("""
            UPDATE match_player_stats
            SET team_id = (
                SELECT CASE WHEN match_player_stats.is_home=1 THEN e.home_team_id ELSE e.away_team_id END
                FROM events e WHERE e.id = match_player_stats.event_id)
            WHERE event_id IN (
                SELECT e2.id FROM events e2
                WHERE (CASE WHEN match_player_stats.is_home=1 THEN e2.home_team_id ELSE e2.away_team_id END) IS NOT NULL)
              AND team_id != (
                SELECT CASE WHEN match_player_stats.is_home=1 THEN e.home_team_id ELSE e.away_team_id END
                FROM events e WHERE e.id = match_player_stats.event_id)
        """)
        print(f"[A] mps.team_id 정규화: {cur.rowcount:,}행")

        # B) players.team_id = 최신 경기 소속팀
        cur.execute("""
            UPDATE players
            SET team_id = (
                SELECT CASE WHEN m.is_home=1 THEN e.home_team_id ELSE e.away_team_id END
                FROM match_player_stats m JOIN events e ON e.id = m.event_id
                WHERE m.player_id = players.id
                  AND (CASE WHEN m.is_home=1 THEN e.home_team_id ELSE e.away_team_id END) IS NOT NULL
                ORDER BY e.date_ts DESC LIMIT 1)
            WHERE EXISTS (
                SELECT 1 FROM match_player_stats m2 JOIN events e2 ON e2.id = m2.event_id
                WHERE m2.player_id = players.id
                  AND (CASE WHEN m2.is_home=1 THEN e2.home_team_id ELSE e2.away_team_id END) IS NOT NULL)
        """)
        print(f"[B] players.team_id 정규화: {cur.rowcount:,}명")

        conn.commit()
        print("[ok] 커밋")
    except Exception as e:
        conn.rollback()
        print(f"[ROLLBACK] {e}")
        conn.close()
        raise

    after = _mismatch(cur)
    orphan_after = cur.execute(
        "SELECT COUNT(*) FROM match_player_stats WHERE team_id NOT IN (SELECT id FROM teams)").fetchone()[0]
    porphan = cur.execute(
        "SELECT COUNT(*) FROM players WHERE team_id NOT IN (SELECT id FROM teams)").fetchone()[0]
    print(f"[post] team_id≠경기팀 mps={after:,}  / 마스터에 없는 mps={orphan_after:,}  / 마스터에 없는 players={porphan:,}")
    conn.close()


if __name__ == "__main__":
    main()
