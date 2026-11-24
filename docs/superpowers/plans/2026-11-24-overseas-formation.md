# 해외 후보 포메이션 사실 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 해외 후보마다 선발 경기 팀 포메이션(주 포메이션·3백/4백 선발 수)과 우리 팀 계열 일치 여부를 사실로 표시.
**Architecture:** 순수 함수는 새 모듈 `overseas_formation.py`(main.py import 시 앱 부팅 없이 테스트 가능), `main.py`가 `_overseas_rows`·`/api/overseas-recruit`에서 사용, `recruit.js`가 표시.
**Tech Stack:** Python 3/SQLite, Vanilla JS, Playwright.
**Spec:** `docs/superpowers/specs/2026-11-24-overseas-formation-design.md`

## Global Constraints
- 점수·정렬 불변(반목표). 스키마·수집기 변경 없음. SQL 파라미터 바인딩만.
- `team` 인자: `/^[a-z0-9_]{1,40}$/` + K1·K2 팀 목록에 있을 때만 사용, 아니면 무시(null).
- 표시 문구: `우리 팀 주 포메이션 {f} ({fam}, {of}경기 중 {games})` · `{f} 위주 · {fam} 선발 {n}/{tot}` · 0이면 `⚠ {fam} 선발 경험 없음`.
- 화면 문자열 전부 `ttEsc`.

## Review Focus
1. grid 파싱 불가(`None`, `"x:y"`, 10명, GK 2명) → None, 예외 없음. (Task 1)
2. 라인업 데이터 없는 리그 → 필드 None/{} 이고 화면에 표시 생략. (Task 2 브라우저)
3. `team` 인자 조작(`../`, 긴 문자열, 없는 팀) → 무시, 200 응답. (Task 2 qa_check)
4. 우리 팀 포메이션 없음(시즌 초) → `team_formation: null`, 후보 줄은 포메이션만. (Task 2)
5. 점수·순위가 변경 전과 같음. (Task 2 비교)

### Task 1: `overseas_formation.py` + 테스트
**Files:** Create `overseas_formation.py`, `analysis/verify_overseas_formation.py`
**Produces:** `formation_from_grids(grids: list[str]) -> str|None` · `formation_family(f: str|None) -> "3백"|"4백"|None` · `player_formations(rows: iterable[(event_id, is_home, player_id, grid)]) -> dict[pid, {"main": str|None, "fam": {"3백": n, "4백": m}, "n": int}]`
- [ ] 테스트(합성): `4-3-3`/`3-4-3`/`5-3-2`/`4-2-3-1` 복원 · 10명 → None · GK 2명 → None · `"x:y"`/None 포함 → None · family 3→3백, 5→3백, 4→4백, None→None · player_formations: 한 선수가 4-3-3 2경기·3-4-3 1경기 → main 4-3-3, fam {4백:2, 3백:1}, n 3.
- [ ] RED 확인 → 구현 → GREEN → 커밋.

### Task 2: main.py 연결 + recruit.js 표시
**Files:** `main.py`(`_overseas_rows`, `overseas_recruit`), `static/js/recruit.js`, `static/css/style.css`, `templates/index.html`(버전), `qa_check.py`
- [ ] `_overseas_rows`: 리그 DB마다 `SELECT event_id, is_home, player_id, formation_slot FROM match_lineups WHERE is_starter=1 AND formation_slot IS NOT NULL` → `player_formations` → 행에 `formation_main`, `fam_starts`.
- [ ] `overseas_recruit`: `team` 검증 → `_brief_formations`로 주 포메이션 → `team_formation`; 후보에 `formation_main`, `fam_starts`, `fam_match`({n, tot} 또는 null); notes 한 줄.
- [ ] qa_check: `/api/overseas-recruit?pos=W&team=suwon` 200·`team_formation` 키 존재 · `team=../x` 200.
- [ ] recruit.js: 요청에 team · 표 위 우리 팀 줄 · 후보 보조 줄 · 담기 detail 에 포메이션.
- [ ] 브라우저(로컬 epl.db 복사본에 합성 라인업 삽입 후 원복) 1280·375 Chromium·Firefox · qa_check · node 테스트 · 커밋.
