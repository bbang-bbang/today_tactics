"""SofaScore 수집 건강 점검 — 차단(403 challenge)을 '조용한 skip'이 아닌 명시적 실패로 만든다.

배경: 2026-08 이후 SofaScore가 봇 차단 챌린지(403 {"reason":"challenge"})를 반환하는데,
크롤러가 응답 null을 skip으로만 처리하고 exit 0으로 끝나 update_data.py가 'STEP OK'로 오인했다.
(checklist/backlog.md 'SofaScore 수집 중단' 참조)

이 모듈은 우회가 아니라 '감지'만 한다:
  - abort_if_blocked : 본 수집 전에 크롤러가 쓰는 '같은 엔드포인트'로 1건 probe → 403이면 즉시 중단(exit 3)
  - abort_if_all_failed : 5건 이상 시도했는데 성공 0이면 종료(exit 3)
엔드포인트별로 차단이 다를 수 있어(예: lineups 정상·incidents 차단) probe는 크롤러별로 수행한다.
"""
from __future__ import annotations

import sys

EXIT_BLOCKED = 3   # update_data.py의 run_step이 FAIL(exit 3)로 표시


async def status_of(page, path: str) -> int:
    """페이지 컨텍스트에서 path를 fetch해 HTTP 상태코드를 반환 (네트워크 오류는 0)."""
    try:
        return await page.evaluate(
            """async (p) => { try { const r = await fetch(p); return r.status; } catch (e) { return 0; } }""",
            path,
        )
    except Exception:
        return 0


async def abort_if_blocked(page, path: str, log, label: str) -> int:
    """probe 요청이 403이면 로그를 남기고 종료(exit 3). 그 외 상태(200/404/네트워크 오류)는 통과시킨다.
    404 등은 '아직 데이터 없음'일 수 있어 차단으로 보지 않는다."""
    st = await status_of(page, path)
    if st == 403:
        log(f"[차단 감지] {label}: {path} → HTTP 403 (SofaScore challenge). "
            f"수집을 중단합니다 (exit {EXIT_BLOCKED}) — checklist/backlog.md 'SofaScore 수집 중단' 참조")
        sys.exit(EXIT_BLOCKED)
    return st


def abort_if_all_failed(succeeded: int, attempted: int, log, label: str, min_attempts: int = 5) -> None:
    """min_attempts건 이상 시도했는데 성공이 0이면 종료(exit 3) — 차단/구조 변경 의심."""
    if attempted >= min_attempts and succeeded == 0:
        log(f"[전부 실패] {label}: {attempted}건 시도, 성공 0 — 차단 또는 응답 구조 변경 의심 (exit {EXIT_BLOCKED})")
        sys.exit(EXIT_BLOCKED)
