# 차트 개편 Phase 3 — 선수 분석 모달 경기별 트렌드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 선수 분석 모달의 '경기별 트렌드'(골·도움 막대 + 평점 선을 이중 축에 겹침)를 팀 분석과 같은 문법으로 바꾼다: **경기별 평점 선 + 시즌 평균 평점선** 과 그 아래 **경기 띠**(진하기 = 공격포인트 G+A, 글자 = W/D/L).

**Spec:** §5.4 (경기별 트렌드) · 선행: `paceLine`, `timelineGrid`, `mountTeam` 패턴(analytics.js), `ensureChartsReady`(workspace.js).

## 범위 결정
- 선수 리포트(전술판 옆 패널) 백분위 바: 백분위의 '포지션 평균'은 정의상 50 → 별도 API(A8) 없이도 의미가 같아 **이번 범위 밖**.
- 레이더·월별·활동량·선수 비교(단위 혼합 대칭 막대): **유지**.
- 데이터 출처는 기존 그대로(SofaScore 경기 기록). 용인 7월 이후 누락 같은 데이터 공백은 별건.

## Review Focus
1. 평점 없는 경기(null) → 선이 끊기고 오류 아님. → `ratingLine_null_gaps`.
2. 여러 시즌(연도 전체) → 최근 시즌만 + 안내. → `ratingLine_latest_season`.
3. 경기 1개 → 선 대신 점 1개라도 그려짐(빈 상태 아님). → `ratingLine_single`.
4. 모듈 미로드/TERA 실패 → 오류 박스, 모달은 정상. → `check_player_trend_tera_fail`.
5. 선수 연타 전환 → 이전 선수 차트가 덮지 않음(기존 loadData 토큰 확인/추가). → `check_player_switch_stale`.

### Task 1: `PlayerCharts` (신규 `static/js/player_charts.js`) + 테스트
- `PlayerCharts.ratingLine(trend)` → `paceLine({labels: "M/D", team: {name:"평점", color: THEME.accent, data: rating}, ref: {name:"시즌 평균", data: 평균(평점 있는 경기) 반복}})`, 최근 시즌(`year` 최댓값)만, `__note`.
- `PlayerCharts.strip(trend)` → `timelineGrid` 1행, `{v: goals+assists, mark: result}`, vMax 3, legend "칸 진하기 = 공격포인트(골+도움) · W 승 · D 무 · L 패".
- [ ] 테스트(Review Focus 1~3 + empty) RED → 구현 → GREEN → Commit.

### Task 2: 배선
- `index.html` lazy 맵 `player_charts`, `workspace.js` 에 `window.ttPlayerReady()` (= `ensureChartsReady().then(lazyLoad("player_charts"))`, 실패 시 재시도 가능).
- `player_analytics.js` `renderTrend`: 기존 `chart-pa-trend` canvas 자리에 슬롯 2개(`pa-rating-slot` 240px, `pa-strip-slot` 64px) → `ttPlayerReady()` 후 mount, 실패 시 오류 박스. 기존 Chart.js 트렌드 코드 제거. `loadData` 에 요청 토큰.
- check: `check_player_trend_render`(석현준 106249 → 두 슬롯 ink>1%), `check_player_trend_tera_fail`, `check_player_switch_stale`(첫 선수 응답 3s 지연 + 둘째 선수 → 둘째 이름).
- [ ] RED → 구현 → GREEN → 전체 회귀 → 스크린샷 → 기록 → Commit.
