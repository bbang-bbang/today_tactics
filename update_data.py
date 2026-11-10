#!/usr/bin/env python3
"""
K1 + K2 통합 증분 업데이트 (매주 자동 실행 가정).

기존 (수원 삼성 단일팀) 한정에서 K1+K2 전체로 확장. 검증된 개별 크롤러를
STEP 단위로 subprocess 호출한다. 모든 STEP은 NOT EXISTS / 중복 가드를
가지고 있어 반복 실행해도 신규만 처리된다.

STEP 0  K리그 공식 API → kleague_results_2026.json 갱신
STEP 1  events 테이블 동기화 (synthetic 90xxxxxx 생성될 수 있음)
STEP 2  synthetic → SofaScore 실제 ID 교체
STEP 29 SofaScore 재생성 경기 ID 감지·교체 (구 ID 404 → 새 ID, crawlers/remap_event_ids.py)
STEP 3  최근 N일 라인업 수집 (K1+K2)
STEP 4  K1 mps 백필 (양 팀 양 선수)
STEP 5  K2 mps 백필
STEP 6  최근 N일 히트맵 수집 (K1+K2)
STEP 7  K1 골/카드 incidents
STEP 8  K2 골/카드 incidents
STEP 21 K리그 공식 API로 득점·카드·교체 복구 (SofaScore incidents 차단 대체 — STEP 16 매핑 직후 실행)
STEP 22 K리그 공식 API로 패스 네트워크 수집 (공개는 경기 다음 날 — 미공개는 재시도)
STEP 27 K리그 공식 선수 경기 기록 → kleague_player_match (공식 정의 그대로, mps와 분리)
STEP 28 공식 선수 ID ↔ SofaScore 선수 ID 매핑 → kleague_player_map
STEP 26 K2 PO·승강 PO를 K1(410)에서 분리 (tournament_id 9410, 멱등)
STEP 20 수집 공백 감사 (마지막에 실행; 종료 코드 0 정상 / 1 치명 / 2 부분 실패)

--official-only: K리그 공식 API STEP(21·22·25·27·28·24)과 공백 감사(20)만 실행.
  공식 데이터는 경기 1~2일 뒤 공개돼 월요일 정기 실행 때 주말 경기분이 '미공개'로 남는다 →
  주중(화) 크론에서 이 모드로 미공개분만 다시 채운다. 모든 STEP이 '데이터 없는 경기만' 처리해 멱등.

레거시는 update_data.py.legacy_*.bak에 백업.
"""

import argparse
import os
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

CRITICAL_STEPS = (0, 1, 2)   # 실패 시 후속 STEP이 의미 없어 중단
EXIT_CRITICAL = 1
EXIT_PARTIAL = 2             # main.py 스케줄러가 'partial'로 기록 (캐시는 정상 갱신)

# --official-only 에서 실행할 STEP (K리그 공식 API 수집 + 공백 감사). 순서는 전체 목록 순서를 따른다.
OFFICIAL_STEPS = (21, 22, 25, 27, 28, 24, 20)

# SofaScore STEP이 실패해도 같은 데이터를 공식/포털 소스로 채우는 대체 STEP.
# 대체 STEP이 같은 실행에서 성공했으면 화면 배지에서는 '미수집'으로 보지 않는다(로그·종료 코드는 그대로 부분 실패).
RECOVERED_BY = {3: 23, 6: 24, 7: 21, 8: 21}

# 실행 결과 상태 파일 — 운영은 crontab으로 돌아 main.py 메모리 상태(_UPDATE_STATUS)가 비므로
# /api/update-status 가 이 파일을 읽어 헤더 신선도 배지에 쓴다. (gitignored)
STATUS_FILE = BASE / ".update_status.json"


def write_status(mode, failures, uncovered, critical_failed, started):
    import json
    from datetime import datetime, timedelta, timezone
    kst = timezone(timedelta(hours=9))
    data = {
        "last_run": datetime.fromtimestamp(started, kst).strftime("%Y-%m-%d %H:%M KST"),
        "finished": datetime.now(kst).strftime("%Y-%m-%d %H:%M KST"),
        "mode": mode,
        "last_result": "error" if critical_failed else ("partial" if uncovered else "success"),
        "failures": failures,
        "uncovered": uncovered,
    }
    try:
        tmp = STATUS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, STATUS_FILE)
        print(f"  ✓ 상태 파일 기록 ({data['last_result']})")
    except OSError as e:
        print(f"  (상태 파일 기록 실패: {e})")


def run_step(step_no, label, cmd, fail_ok=False):
    """STEP 1개 실행. 반환값은 항상 '실제 성공 여부'다 (fail_ok와 무관).
    fail_ok는 호환용 — 중단할지 계속할지는 호출자(main)가 critical 여부로 결정한다.
    (이전엔 fail_ok=True면 실패해도 True를 반환해 failures에 안 쌓여 항상 '모든 STEP 정상'으로 끝났다.)"""
    print(f"\n{'='*60}")
    print(f"  STEP {step_no}  {label}")
    print(f"  $ {' '.join(cmd)}")
    print('='*60)
    sys.stdout.flush()

    t0 = time.time()
    success = True
    try:
        r = subprocess.run(cmd, cwd=str(BASE))
        dt = time.time() - t0
        success = (r.returncode == 0)
        flag = "OK" if success else f"FAIL (exit {r.returncode})"
        print(f"  → {flag} ({dt:.1f}s)")
        sys.stdout.flush()
    except Exception as e:
        print(f"  → EXCEPTION: {e}")
        sys.stdout.flush()
        success = False
    return success


def main():
    ap = argparse.ArgumentParser(description="K1+K2 통합 증분 업데이트")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help=f"라인업/히트맵/incidents 수집 범위 (기본 {DEFAULT_DAYS}일)")
    ap.add_argument("--skip-mps", action="store_true",
                    help="mps 백필 스킵 (이미 채워졌고 빠른 점검만 필요할 때)")
    ap.add_argument("--skip-heatmap", action="store_true",
                    help="히트맵 스킵")
    ap.add_argument("--official-only", action="store_true",
                    help="K리그 공식 API STEP(21·22·25·27·28·24)+감사(20)만 — 주중 미공개분 재수집용")
    args = ap.parse_args()

    print("\n#### update_data.py — K1+K2 통합 증분 ####")
    print(f"  days={args.days}  skip_mps={args.skip_mps}  skip_heatmap={args.skip_heatmap}"
          f"  official_only={args.official_only}")

    t_total = time.time()
    failures = []
    succeeded = set()

    steps = [
        (0, "K리그 공식 API → JSON",
            [PYTHON, str(CRAWLERS/"update_results_2026.py")]),
        (1, "events 테이블 동기화",
            [PYTHON, str(CRAWLERS/"sync_results_to_events.py")]),
        (2, "synthetic → SofaScore 실제 ID 교체",
            [PYTHON, str(CRAWLERS/"replace_synthetic_events.py")]),
        # SofaScore가 경기를 새 ID로 재생성(구 ID 404)하면 mps·라인업·히트맵이 조용히 스킵된다(2026-11-10 용인FC 16경기).
        # mps 없는 최근 종료 경기만 확인 — 대상 0이면 브라우저도 안 띄움. 예정 경기 중복은 보고만.
        (29, "SofaScore 재생성 경기 ID 감지·교체 (mps 없는 최근 120일 종료 경기)",
            [PYTHON, str(CRAWLERS/"remap_event_ids.py"), "--detect", "--apply", "--days", "120"]),
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
        (21, "K리그 공식 API → 득점·카드·교체 복구 (SofaScore incidents 차단 대체, 데이터 없는 경기만)",
            [PYTHON, str(CRAWLERS/"collect_kleague_events.py"), "--apply"]),
        (22, "K리그 공식 API → 패스 네트워크(선수 간 패스 행렬) 수집 (경기 다음 날 공개, 미공개는 다음 실행에서 재시도)",
            [PYTHON, str(CRAWLERS/"collect_kleague_passes.py"), "--apply"]),
        # SofaScore lineups/heatmap 차단(운영 9/20~) 대체. 둘 다 '데이터 없는 경기·선수만' 채우므로
        # SofaScore가 복구되면 자연히 할 일이 없어진다. STEP 16(포털 라인업)·4~5(mps) 이후, 18(detail_pos) 이전.
        (23, f"라인업 복원 — 포털 라인업 + mps 등번호 → match_lineups (SofaScore 라인업 없는 경기만, 최근 {max(args.days, 30)}일)",
            [PYTHON, str(CRAWLERS/"recover_lineups_kleague.py"), "--apply", "--days", str(max(args.days, 30))]),
        # STEP 21 복구 득점은 PK 구분이 없음 → 공식 슈팅 데이터(PK 코드)로 is_penalty 보정. 슈팅은 다음 날 공개.
        (25, f"K리그 공식 슈팅 → 득점 PK 보정 (최근 {max(args.days, 30)}일)",
            [PYTHON, str(CRAWLERS/"fix_penalty_from_kleague.py"), "--apply", "--days", str(max(args.days, 30))]),
    ]
    steps += [
        # 공식 데이터 전환 2단계: 공식 선수 경기 기록을 별도 테이블에 저장(SofaScore mps와 정의가 달라 섞지 않음).
        # 패스(STEP 22)·라인업(16)·교체(21) 이후 — 출전 선수 판별에 사용. 공개는 경기 다음 날, 미공개는 재시도.
        (27, f"K리그 공식 선수 경기 기록 → kleague_player_match (최근 {max(args.days, 30)}일)",
            [PYTHON, str(CRAWLERS/"collect_kleague_player_stats.py"), "--apply", "--days", str(max(args.days, 30))]),
        (28, "공식 선수 ID ↔ SofaScore 선수 ID 매핑 재계산 → kleague_player_map",
            [PYTHON, str(CRAWLERS/"build_kleague_player_map.py"), "--apply"]),
    ]
    if not args.skip_heatmap:
        steps += [
            (24,f"K리그 공식 API → 히트맵 (SofaScore 히트맵 없는 선수만, 최근 {max(args.days, 30)}일)",
                [PYTHON, str(CRAWLERS/"collect_kleague_heatmap.py"), "--apply", "--days", str(max(args.days, 30))]),
        ]
    steps += [
        # SofaScore는 K2 PO·승강 PO를 K1(410) 대회로 내려줌 → K2 팀이 K1 집계에 섞임. 크롤러들이 events를
        # INSERT OR REPLACE 하므로 매번 다시 분리한다(멱등). 시즌 초(최다 20경기 미만)는 판정 보류.
        (26, "K2 PO·승강 PO 경기를 K1(410)에서 분리 → tournament_id 9410",
            [PYTHON, str(CRAWLERS/"reclassify_playoffs.py"), "--apply"]),
        (17, "events.round 백필 (K리그 roundId → 백테스트 per_round)",
            [PYTHON, str(CRAWLERS/"backfill_rounds.py")]),
        (18, "세부 포지션 백필 (formation+slot → detail_pos, 비교 필터용)",
            [PYTHON, str(CRAWLERS/"backfill_detail_positions.py")]),
        (19, "mps.team_id 정규화 (경기 실제 소속으로 — 팀 집계 정합성)",
            [PYTHON, str(CRAWLERS/"normalize_mps_team.py")]),
        (20, "수집 공백 감사 (소스별 마지막 정상 수집일 — 차단/중단 조기 발견)",
            [PYTHON, str(BASE/"analysis"/"audit_collection_gaps.py"), "--summary-only"]),
    ]
    if args.official_only:
        steps = [s for s in steps if s[0] in OFFICIAL_STEPS]

    # STEP 0~2 실패 시 후속 의미 없음 → fail_ok=False (기본).
    # STEP 3~8 부분 실패는 다음 주 재시도로 자가복구되므로 fail_ok=True로 진행.
    for i, (no, label, cmd) in enumerate(steps):
        critical = (no in CRITICAL_STEPS)
        ok = run_step(no, label, cmd, fail_ok=not critical)
        if not ok and critical:
            print(f"\n!! 치명 STEP {no} 실패 — 중단")
            failures.append(no)
            break
        if not ok:
            failures.append(no)
        else:
            succeeded.add(no)

    print(f"\n#### 완료 — {time.time()-t_total:.1f}s ####")
    critical_failed = any(n in CRITICAL_STEPS for n in failures)
    uncovered = [n for n in failures if RECOVERED_BY.get(n) not in succeeded]
    if failures:
        print(f"  실패 STEP: {failures}")
        recovered = [n for n in failures if n not in uncovered]
        if recovered:
            print(f"  대체 STEP으로 보완됨: {recovered}")
    else:
        print("  모든 STEP 정상")
    write_status("official" if args.official_only else "full", failures, uncovered, critical_failed, t_total)

    # API 캐시 무효화 — 신규 매치 반영을 위해 실행 중인 Flask 서버에 hit.
    # prediction-backtest, round-predictions, schedule, rounds 캐시 리셋.
    # 부분 실패(STEP 3~)여도 스코어 등은 갱신됐으므로 치명 실패(0~2)가 아니면 무효화한다.
    if not critical_failed:
        # ① 캐시 세대 마커 갱신 — gunicorn 워커 전원이 다음 API 요청 때 각자 캐시를 비운다
        #    (아래 HTTP 호출은 워커 1개에만 도달하므로 이것만으론 부족했음). main.py `_CACHE_GEN_FILE`과 같은 경로.
        try:
            _gen_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache_generation")
            with open(_gen_file, "w", encoding="ascii") as f:
                f.write(str(time.time_ns()))
            print("  ✓ 캐시 세대 마커 갱신 (전 워커 무효화)")
        except OSError as e:
            print(f"  (캐시 세대 마커 갱신 실패: {e})")
        # ② 워커 1개 즉시 무효화 + 워밍업
        try:
            import urllib.request, urllib.error
            urllib.request.urlopen("http://127.0.0.1:5000/api/cache-invalidate", timeout=10).read()
            print("  ✓ API 캐시 무효화 + 워밍업 트리거")
        except Exception as e:
            print(f"  (캐시 무효화 skip: {e})")

    # 종료 코드: 0=정상 / 1=치명(STEP 0~2) / 2=부분 실패(수집 STEP 일부 실패 — 스코어는 갱신됨)
    if critical_failed:
        sys.exit(EXIT_CRITICAL)
    if failures:
        sys.exit(EXIT_PARTIAL)


if __name__ == "__main__":
    main()
