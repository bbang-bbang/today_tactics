#!/usr/bin/env python3
"""
K1 + K2 통합 증분 업데이트 (매주 자동 실행 가정).

기존 (수원 삼성 단일팀) 한정에서 K1+K2 전체로 확장. 검증된 개별 크롤러를
STEP 단위로 subprocess 호출한다. 모든 STEP은 NOT EXISTS / 중복 가드를
가지고 있어 반복 실행해도 신규만 처리된다.

STEP 0  K리그 공식 API → kleague_results_2026.json 갱신
STEP 1  events 테이블 동기화 (synthetic 90xxxxxx 생성될 수 있음)
STEP 2  synthetic → SofaScore 실제 ID 교체
STEP 3  최근 N일 라인업 수집 (K1+K2)
STEP 4  K1 mps 백필 (양 팀 양 선수)
STEP 5  K2 mps 백필
STEP 6  최근 N일 히트맵 수집 (K1+K2)
STEP 7  K1 골/카드 incidents
STEP 8  K2 골/카드 incidents

레거시는 update_data.py.legacy_*.bak에 백업.
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE = Path(__file__).resolve().parent
CRAWLERS = BASE / "crawlers"
PYTHON = sys.executable

DEFAULT_DAYS = 14  # 매주 cron이라 14일이면 충분 + 재시도 여유


def run_step(step_no, label, cmd, fail_ok=False):
    print(f"\n{'='*60}")
    print(f"  STEP {step_no}  {label}")
    print(f"  $ {' '.join(cmd)}")
    print('='*60)
    sys.stdout.flush()

    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=str(BASE))
        dt = time.time() - t0
        ok = (r.returncode == 0)
        flag = "OK" if ok else f"FAIL (exit {r.returncode})"
        print(f"  → {flag} ({dt:.1f}s)")
        sys.stdout.flush()
        if not ok and not fail_ok:
            return False
    except Exception as e:
        print(f"  → EXCEPTION: {e}")
        sys.stdout.flush()
        if not fail_ok:
            return False
    return True


def main():
    ap = argparse.ArgumentParser(description="K1+K2 통합 증분 업데이트")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help=f"라인업/히트맵/incidents 수집 범위 (기본 {DEFAULT_DAYS}일)")
    ap.add_argument("--skip-mps", action="store_true",
                    help="mps 백필 스킵 (이미 채워졌고 빠른 점검만 필요할 때)")
    ap.add_argument("--skip-heatmap", action="store_true",
                    help="히트맵 스킵")
    args = ap.parse_args()

    print("\n#### update_data.py — K1+K2 통합 증분 ####")
    print(f"  days={args.days}  skip_mps={args.skip_mps}  skip_heatmap={args.skip_heatmap}")

    t_total = time.time()
    failures = []

    steps = [
        (0, "K리그 공식 API → JSON",
            [PYTHON, str(CRAWLERS/"update_results_2026.py")]),
        (1, "events 테이블 동기화",
            [PYTHON, str(CRAWLERS/"sync_results_to_events.py")]),
        (2, "synthetic → SofaScore 실제 ID 교체",
            [PYTHON, str(CRAWLERS/"replace_synthetic_events.py")]),
        (3, f"라인업 수집 (최근 {args.days}일)",
            [PYTHON, str(CRAWLERS/"crawl_lineups.py"), "--days", str(args.days)]),
    ]
    if not args.skip_mps:
        steps += [
            (4, "K1 mps 백필", [PYTHON, str(CRAWLERS/"backfill_k1_mps.py"), "--league", "K1"]),
            (5, "K2 mps 백필", [PYTHON, str(CRAWLERS/"backfill_k1_mps.py"), "--league", "K2"]),
        ]
    if not args.skip_heatmap:
        steps += [
            (6, f"히트맵 수집 (최근 {args.days}일)",
                [PYTHON, str(CRAWLERS/"fetch_event_heatmap.py"), "--days", str(args.days)]),
        ]
    steps += [
        (7, f"K1 incidents (최근 {args.days}일)",
            [PYTHON, str(CRAWLERS/"collect_goal_incidents.py"),
             "--days", str(args.days), "--league", "K1", "--include-zero-zero"]),
        (8, f"K2 incidents (최근 {args.days}일)",
            [PYTHON, str(CRAWLERS/"collect_goal_incidents.py"),
             "--days", str(args.days), "--league", "K2", "--include-zero-zero"]),
        (9, "venue 백필 (K1+K2)",
            [PYTHON, str(CRAWLERS/"fetch_venues.py"), "--league", "all"]),
        (10, "weather 백필 (K1+K2)",
            [PYTHON, str(CRAWLERS/"fetch_weather.py"), "--league", "all"]),
        (11, "player master 갱신",
            [PYTHON, str(CRAWLERS/"fill_player_master.py")]),
        (12, "K리그 포털 JSON 갱신",
            [PYTHON, str(CRAWLERS/"crawl_kleague.py")]),
        (13, "K리그 포털 → 신체정보 + name_ko 백필",
            [PYTHON, str(CRAWLERS/"fill_korean_names.py")]),
        (14, f"avg_positions + shotmap (최근 {args.days}일)",
            [PYTHON, str(CRAWLERS/"fetch_match_extras.py"),
             "--days", str(args.days), "--league", "all"]),
        (15, "K리그 포털 formation 덮어쓰기",
            [PYTHON, str(CRAWLERS/"fill_formation_from_kleague.py")]),
        (16, "K리그 포털 스케줄 + 라인업 (현재 시즌)",
            [PYTHON, str(CRAWLERS/"crawl_kleague_lineup.py"), "all", "--years", "2026"]),
        (17, "events.round 백필 (K리그 roundId → 백테스트 per_round)",
            [PYTHON, str(CRAWLERS/"backfill_rounds.py")]),
    ]

    # STEP 0~2 실패 시 후속 의미 없음 → fail_ok=False (기본).
    # STEP 3~8 부분 실패는 다음 주 재시도로 자가복구되므로 fail_ok=True로 진행.
    for i, (no, label, cmd) in enumerate(steps):
        critical = (no in (0, 1, 2))
        ok = run_step(no, label, cmd, fail_ok=not critical)
        if not ok and critical:
            print(f"\n!! 치명 STEP {no} 실패 — 중단")
            failures.append(no)
            break
        if not ok:
            failures.append(no)

    print(f"\n#### 완료 — {time.time()-t_total:.1f}s ####")
    if failures:
        print(f"  실패 STEP: {failures}")
        sys.exit(1)
    print("  모든 STEP 정상")

    # API 캐시 무효화 — 신규 매치 반영을 위해 실행 중인 Flask 서버에 hit.
    # prediction-backtest, round-predictions, schedule, rounds 캐시 리셋.
    try:
        import urllib.request, urllib.error
        urllib.request.urlopen("http://127.0.0.1:5000/api/cache-invalidate", timeout=10).read()
        print("  ✓ API 캐시 무효화 + 워밍업 트리거")
    except Exception as e:
        print(f"  (캐시 무효화 skip: {e})")


if __name__ == "__main__":
    main()
