# -*- coding: utf-8 -*-
"""
K3(tournament_id=10268) 라벨 손상 정리 — 1회성 마이그레이션 (멱등).

진단(2026-06-12): teams에 league='K3리그'로 잡힌 9팀과 그 등록 선수 61명 중
58명은 실제 K1/K2 선수인데 mps.team_id가 '현 소속(K3 강등 구단)'으로 고정돼
과거 K2 경기까지 K3팀으로 잘못 귀속(804건, 실제 경기 양팀과 100% 불일치).
나머지 3명은 mps·히트맵 0의 순수 K3 로스터. K3 대회 13경기 + 히트맵 935점은 고아.

처리:
  ② 교정 — mps.team_id를 event(home/away)+is_home로 유도한 실제 팀으로 재매핑,
            players.team_id는 교정된 mps 최빈 팀으로.
  ① 삭제 — K3 대회 이벤트/그 히트맵, 순수 K3 선수, K3 팀 행.

안전장치: 단일 트랜잭션, 사전/사후 카운트 출력, 비K3 이벤트가 K3팀을 home/away로
쓰면 중단(teams 삭제 보류). 재실행해도 (K3 흔적이 이미 없으면) 무해.
"""
import os
import sqlite3
from collections import Counter

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "players.db")
K3_TID = 10268


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    k3teams = [r[0] for r in cur.execute("SELECT id FROM teams WHERE tournament_id=?", (K3_TID,))]
    k3ev = [r[0] for r in cur.execute("SELECT id FROM events WHERE tournament_id=?", (K3_TID,))]
    if not k3teams and not k3ev:
        print("[skip] K3 흔적 없음 — 이미 정리됨")
        conn.close()
        return
    qmt = ",".join("?" * len(k3teams)) if k3teams else "NULL"
    qme = ",".join("?" * len(k3ev)) if k3ev else "NULL"

    print(f"[pre] K3팀={len(k3teams)} K3이벤트={len(k3ev)}")
    mps_bad = cur.execute(f"SELECT COUNT(*) FROM match_player_stats WHERE team_id IN ({qmt})", k3teams).fetchone()[0]
    pls = [r[0] for r in cur.execute(f"SELECT id FROM players WHERE team_id IN ({qmt})", k3teams)]
    print(f"[pre] K3팀 귀속 mps={mps_bad}, K3팀 등록 선수={len(pls)}")

    # 안전장치: 비-K3 이벤트가 K3팀을 home/away로 참조하면 중단
    if k3teams:
        ref = cur.execute(
            f"SELECT COUNT(*) FROM events WHERE tournament_id!=? AND "
            f"(home_team_id IN ({qmt}) OR away_team_id IN ({qmt}))",
            (K3_TID, *k3teams, *k3teams)).fetchone()[0]
        if ref:
            print(f"[ABORT] 비-K3 이벤트 {ref}건이 K3팀을 참조 — 수동 확인 필요. 중단.")
            conn.close()
            return

    try:
        cur.execute("BEGIN")

        # ── ② mps.team_id 교정 (해당 경기 home/away + is_home로 유도) ──
        if k3teams:
            cur.execute(f"""
                UPDATE match_player_stats
                SET team_id = (
                    SELECT CASE WHEN match_player_stats.is_home=1 THEN e.home_team_id ELSE e.away_team_id END
                    FROM events e WHERE e.id = match_player_stats.event_id)
                WHERE team_id IN ({qmt})
                  AND EXISTS (SELECT 1 FROM events e2 WHERE e2.id = match_player_stats.event_id)
            """, k3teams)
            print(f"[②] mps.team_id 교정: {cur.rowcount}행")

        # ── ② players.team_id 교정 (교정된 mps 최빈 팀) / 순수 K3는 삭제 후보 ──
        pure = []
        for pid in pls:
            rows = cur.execute(
                "SELECT team_id FROM match_player_stats WHERE player_id=?", (pid,)).fetchall()
            if not rows:
                pure.append(pid)
                continue
            best = Counter(r[0] for r in rows).most_common(1)[0][0]
            cur.execute("UPDATE players SET team_id=? WHERE id=?", (best, pid))
        print(f"[②] players.team_id 교정: {len(pls)-len(pure)}명 / 순수K3(삭제대상): {len(pure)}명")

        # ── ① 순수 K3 데이터 삭제 ──
        if k3ev:
            cur.execute(f"DELETE FROM heatmap_points WHERE event_id IN ({qme})", k3ev)
            print(f"[①] K3 이벤트 히트맵 삭제: {cur.rowcount}점")
        if pure:
            qpu = ",".join("?" * len(pure))
            cur.execute(f"DELETE FROM players WHERE id IN ({qpu})", pure)
            print(f"[①] 순수 K3 선수 삭제: {cur.rowcount}명")
        if k3ev:
            cur.execute(f"DELETE FROM events WHERE id IN ({qme})", k3ev)
            print(f"[①] K3 이벤트 삭제: {cur.rowcount}건")
        if k3teams:
            # 삭제 직전 재확인 — 아직 K3팀을 참조하는 players/mps 없어야
            still_p = cur.execute(f"SELECT COUNT(*) FROM players WHERE team_id IN ({qmt})", k3teams).fetchone()[0]
            still_m = cur.execute(f"SELECT COUNT(*) FROM match_player_stats WHERE team_id IN ({qmt})", k3teams).fetchone()[0]
            if still_p or still_m:
                raise RuntimeError(f"K3팀 잔여 참조 players={still_p} mps={still_m} — 롤백")
            cur.execute(f"DELETE FROM teams WHERE id IN ({qmt})", k3teams)
            print(f"[①] K3 팀 삭제: {cur.rowcount}팀")

        conn.commit()
        print("[ok] 커밋 완료")
    except Exception as e:
        conn.rollback()
        print(f"[ROLLBACK] {e}")
        conn.close()
        raise

    # ── 사후 검증 ──
    bad = conn.execute("SELECT COUNT(*) FROM match_player_stats WHERE team_id NOT IN (SELECT id FROM teams)").fetchone()[0]
    k3left = conn.execute("SELECT COUNT(*) FROM teams WHERE tournament_id=?", (K3_TID,)).fetchone()[0]
    evleft = conn.execute("SELECT COUNT(*) FROM events WHERE tournament_id=?", (K3_TID,)).fetchone()[0]
    print(f"[post] K3 팀 잔여={k3left}, K3 이벤트 잔여={evleft}, team_id가 teams에 없는 mps={bad}")
    conn.close()


if __name__ == "__main__":
    main()
