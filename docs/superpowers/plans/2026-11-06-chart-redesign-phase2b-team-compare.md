# 차트 개편 Phase 2b — 팀 비교 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 팀 비교의 '시즌 득/실 트렌드'(두 팀 × 경기별 득·실점 = 선 4개가 엉킴)를 **두 팀 시즌 누적 승점 + 리그 평균 페이스**(같은 리그일 때)로 바꾼다.

**Spec:** `docs/superpowers/specs/2026-11-06-chart-dashboard-redesign-design.md` §5.3 · 선행 Phase 2a(`team-trend` 의 `season_cum_pts`·`league_avg_cum_pts`, `paceLine`, `TeamCharts`, `ttTeamReady`).

## 범위 결정
- 레이더·홈/원정·지표 대칭 막대(카운트업 애니메이션, 단위가 섞여 dumbbell 부적합)·맞대결 목록·순위·선제골·폼 스파크라인: **유지**.
- 득점 시간대 비교: 시간대별 A·B 묶음 막대가 이미 직접 비교에 적합 → **유지**.
- 공수 균형 산점도(`renderBalance`): 템플릿에 요소가 없고 호출도 없음(죽은 코드) → **이번 범위 밖**, work-log 에 기록.

## Global Constraints
Phase 2a 와 동일. 리그가 다른 두 팀(K1 vs K2)은 리그 평균이 서로 달라 기준선을 그리지 않는다.

## Review Focus
1. 두 팀 경기 수가 다름(일정 차) → 짧은 팀은 끝에서 끊김(null), 오류 아님. → `paceCompare_unequal_lengths`.
2. 다른 리그 → ref 없음 + 안내. → `paceCompare_cross_league_no_ref`.
3. 두 팀 색이 비슷 → B 를 대체색으로. → `paceCompare_close_colors`.
4. 연도 '전체' → 각 팀 최근 시즌만(시즌이 다르면 안내). → `paceCompare_latest_season`.
5. TERA 실패 → 오류 박스(패널 유지). → `check_compare_trend_render` 의 vendor 404 변형.

### Task 1: `paceLine` 다중 팀 + `TeamCharts.paceCompare`
- `presets.paceLine` 에 `extra?: {name, color, data}[]` (팀과 같은 굵기 3, 실선) 추가 — 기존 호출 불변.
- `TeamCharts.paceCompare(trA, trB, {colorA, colorB, sameLeague})` → 각 팀 최근 시즌 `season_cum_pts`, labels `R1..max(nA,nB)`, 짧은 쪽은 null 패딩, `sameLeague` 이면 ref = A 의 `league_avg_cum_pts`(B 가 더 길면 B 것으로 패딩), 색 대비(두 색 `contrast` < 1.6) 시 B = `#f59e0b`. `__note`: 연도 전체/시즌 상이 안내.
- [ ] 테스트(위 Review Focus 1~4 + 기존 paceLine 테스트 유지) RED → 구현 → GREEN → Commit.

### Task 2: 배선
- 템플릿 `tc-trend` canvas → `<div class="tt-card-chart" data-chart-slot id="tc-trend-slot" style="height:240px">`, 힌트 문구 교체.
- `team_compare.js` `renderTrend` → `TTChart.mount(slot, TeamCharts.paceCompare(...))` (`window.ttTeamReady` 대기, 모듈 없으면 오류 박스), 기존 `trendChart` 경로 제거.
- check(실패 먼저): `check_compare_trend_render`(팀 비교 모드 → 강원 vs 울산 → 슬롯 ink>1%, 콘솔 0), `check_compare_trend_tera_fail`.
- [ ] RED → 구현 → GREEN → 전체 회귀(node·verify·qa) → 스크린샷 → 기록 → Commit.
