"""수집 공백 감사 (읽기 전용) — 소스별로 '조용히 멈춘' 수집을 드러낸다.

배경: crawlers/*는 SofaScore 응답이 실패(403 challenge 등)해도 skip만 하고 exit 0으로 끝나
update_data.py가 'STEP OK'로 보고한다. 그래서 수집이 멈춰도 알 수 없었다.
이 스크립트는 종료된 경기마다 각 소스 테이블에 데이터가 있는지 보고,
  1) 월별 커버리지(K1/K2)  2) 소스별 마지막 정상 수집 경기일과 최신 경기와의 공백
을 출력한다. 공백이 --max-gap-days 를 넘는 소스가 있으면 종료 코드 1.

사용: python analysis/audit_collection_gaps.py [--since 2026-01-01] [--max-gap-days 14]
"""
from __future__ import annotations
import argparse
import datetime as dt
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "players.db"
LEAGUES = {410: "K1", 777: "K2"}

# (키, 라벨, 분모가 되는 경기 조건) — 득점은 골이 있었던 경기만 분모
SOURCES = [
    ("goal", "득점 incidents", "goals"),
    ("card", "카드 incidents", "all"),
    ("sub", "교체 incidents", "all"),
    ("mps", "선수 스탯(평점)", "all"),
    ("lineup", "라인업", "all"),
    ("shot", "슈팅맵", "all"),
    ("avgpos", "평균 위치", "all"),
    ("heat", "히트맵", "all"),
]

# 테이블명은 바인딩이 불가능하므로 고정 SQL 한 벌만 사용한다 (외부 입력 미포함).
EVENT_FLAGS_SQL = """
SELECT e.date_ts, e.tournament_id, (e.home_score + e.away_score) AS goals,
  EXISTS(SELECT 1 FROM goal_events x WHERE x.event_id = e.id),
  EXISTS(SELECT 1 FROM card_events x WHERE x.event_id = e.id),
  EXISTS(SELECT 1 FROM sub_events x WHERE x.event_id = e.id),
  EXISTS(SELECT 1 FROM match_player_stats x WHERE x.event_id = e.id AND x.rating IS NOT NULL),
  EXISTS(SELECT 1 FROM match_lineups x WHERE x.event_id = e.id),
  EXISTS(SELECT 1 FROM match_shotmap x WHERE x.event_id = e.id),
  EXISTS(SELECT 1 FROM match_avg_positions x WHERE x.event_id = e.id),
  EXISTS(SELECT 1 FROM heatmap_points x WHERE x.event_id = e.id)
FROM events e
WHERE e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
  AND e.date_ts >= ?
ORDER BY e.date_ts
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="수집 공백 감사 (읽기 전용)")
    ap.add_argument("--since", default="2026-01-01", help="이 날짜 이후 경기만 (YYYY-MM-DD)")
    ap.add_argument("--max-gap-days", type=int, default=14, help="최신 경기 대비 허용 공백(일)")
    args = ap.parse_args()

    since_ts = int(dt.datetime.strptime(args.since, "%Y-%m-%d").timestamp())
    conn = sqlite3.connect(str(DB))
    try:
        rows = conn.execute(EVENT_FLAGS_SQL, (since_ts,)).fetchall()
    finally:
        conn.close()
    if not rows:
        print("대상 경기가 없습니다.")
        return 0

    latest_ts = max(r[0] for r in rows)
    month = lambda ts: dt.datetime.fromtimestamp(ts).strftime("%Y-%m")
    day = lambda ts: dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")

    # (리그, 월, 소스) → [커버, 분모]
    cov = defaultdict(lambda: [0, 0])
    last_ok = {}                       # (리그, 소스) → 마지막으로 데이터가 있던 경기 ts
    for r in rows:
        ts, tid, goals = r[0], r[1], r[2]
        lg = LEAGUES[tid]
        for i, (key, _lbl, denom) in enumerate(SOURCES):
            if denom == "goals" and goals == 0:
                continue
            has = bool(r[3 + i])
            c = cov[(lg, month(ts), key)]
            c[1] += 1
            c[0] += has
            if has:
                last_ok[(lg, key)] = max(last_ok.get((lg, key), 0), ts)

    months = sorted({m for (_lg, m, _k) in cov})
    print(f"## 월별 커버리지 (%)  — {args.since} 이후, 종료 경기 {len(rows)}건, 최신 경기 {day(latest_ts)}")
    for lg in ("K1", "K2"):
        print(f"\n[{lg}]")
        print("월       " + "".join(f"{lbl[:6]:>9}" for _k, lbl, _d in SOURCES))
        for m in months:
            cells = []
            for key, _lbl, _d in SOURCES:
                c = cov.get((lg, m, key))
                cells.append(f"{'-':>9}" if not c or not c[1] else f"{c[0] / c[1] * 100:>8.0f}%")
            print(f"{m}  " + "".join(cells))

    print(f"\n## 소스별 마지막 정상 수집 경기 (최신 경기 {day(latest_ts)} 기준 공백)")
    bad = 0
    for lg in ("K1", "K2"):
        for key, lbl, _d in SOURCES:
            ts = last_ok.get((lg, key))
            if ts is None:
                print(f"  ✗ {lg} {lbl:<10} 데이터 없음")
                bad += 1
                continue
            gap = (latest_ts - ts) // 86400
            flag = "✗ 수집 중단 의심" if gap > args.max_gap_days else "✓"
            bad += gap > args.max_gap_days
            print(f"  {flag:<9} {lg} {lbl:<10} 마지막 {day(ts)}  (공백 {gap}일)")
    print("\n" + (f"⚠ 공백 초과 {bad}건 — 크롤러 로그/차단(403) 여부 확인 필요" if bad else "모든 소스 정상 범위"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
