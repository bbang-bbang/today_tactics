# -*- coding: utf-8 -*-
"""
K2 플레이오프·승강 플레이오프 경기를 K1 리그(tournament_id=410)에서 분리 (멱등, update_data STEP 26).

배경(2026-11-03 발견): SofaScore는 K2 PO·승강 PO를 K리그1 대회(410) 안의 경기로 내려준다.
그대로 두면 K2 팀이 K1 순위·팀 분석·리그 랭킹·패스 허브 등 410 기준 집계에 섞인다
(2025: 부천-성남 PO 1건 + 승강 PO 4건). main.py 는 123곳에서 tournament_id 로 리그를 나누므로
엔드포인트를 고치는 대신 이 경기들의 tournament_id 를 PLAYOFF_TID 로 옮긴다(삭제 아님 —
선수 경기 목록 등 대회 무관 화면에는 그대로 남음).

판정(시즌=현지 연도 단위):
  - 그 시즌 410 경기 수가 리그 최다 팀의 25% 미만인 팀 = '외부 팀'(K2 소속으로 PO에만 나온 팀)
  - 외부 팀이 홈/원정에 있는 410 경기 = PO
  - 시즌 최다 경기 수가 MIN_SEASON_GAMES 미만이면(시즌 초) 판정하지 않음 → 개막 직후 오분류 방지
여러 크롤러가 events 를 INSERT OR REPLACE 하므로 매 업데이트마다 다시 적용해야 한다.

사용: python crawlers/reclassify_playoffs.py          # dry-run (변경 없음)
      python crawlers/reclassify_playoffs.py --apply  # 적용
"""
import argparse
import os
import sqlite3
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "players.db")
K1_TID = 410
PLAYOFF_TID = 9410          # 합성 ID — 'K리그 PO(K2 PO·승강 PO)'. SofaScore 대회 ID와 겹치지 않는 값
VISITOR_RATIO = 0.25        # 리그 최다 경기 수 대비 이 비율 미만이면 외부 팀
MIN_SEASON_GAMES = 20       # 시즌 최다 경기 수가 이보다 적으면 판정 보류


def find_playoffs(conn):
    """→ [(event_id, year, home_id, away_id, home_name, away_name, date)] PO로 판정된 410 경기."""
    rows = conn.execute("""
        SELECT id, strftime('%Y', datetime(date_ts,'unixepoch','localtime')) AS yr,
               home_team_id, away_team_id, home_team_name, away_team_name,
               date(date_ts,'unixepoch','localtime')
        FROM events WHERE tournament_id = ? AND date_ts IS NOT NULL
    """, (K1_TID,)).fetchall()
    by_year = {}
    for r in rows:
        by_year.setdefault(r[1], []).append(r)
    out = []
    for yr, evs in sorted(by_year.items()):
        cnt = {}
        for _id, _y, h, a, *_ in evs:
            cnt[h] = cnt.get(h, 0) + 1
            cnt[a] = cnt.get(a, 0) + 1
        top = max(cnt.values()) if cnt else 0
        if top < MIN_SEASON_GAMES:
            print(f"  {yr}: 최다 경기 {top} < {MIN_SEASON_GAMES} — 시즌 초/표본 부족으로 판정 보류")
            continue
        visitors = {t for t, n in cnt.items() if n < top * VISITOR_RATIO}
        hits = [r for r in evs if r[2] in visitors or r[3] in visitors]
        vnames = sorted({(r[4] if r[2] in visitors else r[5]) or "?" for r in hits})
        print(f"  {yr}: 최다 경기 {top}, 외부 팀 {len(visitors)}({', '.join(vnames) or '-'}) → PO {len(hits)}건")
        out.extend(hits)
    return out


def main():
    ap = argparse.ArgumentParser(description="K2 PO·승강 PO를 K1(410)에서 분리")
    ap.add_argument("--apply", action="store_true", help="실제로 tournament_id 변경 (기본 dry-run)")
    args = ap.parse_args()

    if not os.path.exists(DB_PATH):
        print("[skip] players.db 없음")
        return 0
    conn = sqlite3.connect(DB_PATH)
    try:
        print(f"## K1(410) 안의 PO 경기 판정 — {'APPLY' if args.apply else 'DRY-RUN'}")
        hits = find_playoffs(conn)
        for eid, yr, _h, _a, hn, an, d in hits:
            print(f"    {eid}  {d}  {hn} vs {an}")
        if not hits:
            print("[ok] 분리할 경기 없음")
            return 0
        if not args.apply:
            print(f"[dry-run] {len(hits)}건을 tournament_id {K1_TID} → {PLAYOFF_TID}로 옮길 예정 (--apply 로 적용)")
            return 0
        ids = [h[0] for h in hits]
        with conn:   # 단일 트랜잭션
            conn.executemany("UPDATE events SET tournament_id = ? WHERE id = ? AND tournament_id = ?",
                             [(PLAYOFF_TID, i, K1_TID) for i in ids])
        left = sum(conn.execute("SELECT COUNT(*) FROM events WHERE tournament_id = ? AND id = ?",
                                (K1_TID, i)).fetchone()[0] for i in ids)
        moved = conn.execute("SELECT COUNT(*) FROM events WHERE tournament_id = ?", (PLAYOFF_TID,)).fetchone()[0]
        print(f"[ok] {len(ids)}건 이동 · 410 잔여 {left}건 · {PLAYOFF_TID} 누적 {moved}건")
        return 0 if left == 0 else 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
