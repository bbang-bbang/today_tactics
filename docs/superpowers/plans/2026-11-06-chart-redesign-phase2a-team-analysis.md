# 차트 개편 Phase 2a — 팀 분석(단일 팀) 차트 개편 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀 탭 › 단일 팀 분석의 '결과 분석'·'심화 인사이트' 탭에서 판독이 어렵거나 막대·표뿐인 차트 7개를 질문에 맞는 차트로 바꾼다. 157경기를 한 줄로 그린 시즌 트렌드가 최우선.

**Architecture:** 서버 2곳에 필드 추가(additive) → 순수 빌더 `TeamCharts`(신규, `static/js/team_charts.js`) → 기존 `TTChart` 프리셋(+신규 2종) → `analytics.js` 의 해당 렌더러가 canvas 대신 TTChart 슬롯에 mount. 기존 표는 같은 패널 안 `근거 보기`로 접어 보존. 패널 컨테이너(`tc-panel`)·탭 구조는 그대로(시각 일관성은 tt-dash 토큰 재사용).

**Tech Stack:** Flask/SQLite, Vanilla JS, TERA CHART(어댑터 경유), node:test, Playwright, qa_check.

**Spec:** `docs/superpowers/specs/2026-11-06-chart-dashboard-redesign-design.md` §4.5(A3·A7), §5.2

## 범위
| 패널 | 현재 | 변경 |
|------|------|------|
| 📈 시즌 득/실 트렌드 | 157경기 막대+선 겹침 | **누적 승점 vs 리그 평균 페이스** 선 2개(paceLine) + **결과 띠**(timelineGrid 1행: 진하기=점수차, 글자 W/D/L). 연도 '전체'면 최근 시즌만 + 안내 |
| 📅 월별 승률 | 세로 막대 | barRef: 월별 PPG + 시즌 PPG 기준선, 4경기 미만 월은 라벨에 "(n경기)" |
| 🏟 홈/원정 | 표 | dumbbell: 경기당 승점·득점·실점 (원정●—●홈), 표는 근거 |
| ⚔ 상대팀별 전적 | 표 | barRef: 상대별 PPG(4경기↑만, 내림차순) + 팀 전체 PPG 기준선, 표는 근거 |
| 🌦 날씨별 | 가로 막대 | forest: 구간별 PPG ± 95% (A3), 기준선 = 팀 전체 PPG |
| ⏱ 득점·실점 시간대 | 세로 막대 | diverging: 15분 구간별 득점(오른쪽)·실점(왼쪽) 가로 막대 |
| 🥇 선제골 효과 | 막대 | sankey: 선제 득점/선제 실점 → 승·무·패 |
**유지:** 득실 패턴 분포·xG 누적·득점자·스킬 레이더·팀 형태·슛맵·패스 네트워크(이미 적합하거나 Canvas 경기장). **Phase 2b:** 팀 비교.

## Global Constraints
- Phase 0·1 Global Constraints 유지(CSP, TeraChart 격리, 12px·4.5:1·3:1, 색만으로 정보 금지, 모션).
- API additive only. 새 통계는 서버에서만.
- 팀 컬러는 `meta.primary`(기존 팀 메타) → 어댑터가 3:1 미만이면 밝힘.
- 버전 쿼리: `analytics.js` +1, `tt_charts.js?v=7`, 신규 `team_charts.js?v=1`(lazy 맵, `team` 탭 onShow 에서 `ttChartsReady` 와 함께 로드).
- 기존 Chart.js 차트(유지 목록)는 건드리지 않는다.

## Review Focus
1. **연도 '전체'** — 여러 시즌 경기가 섞인 트렌드에서 누적 승점·리그 평균이 시즌마다 리셋돼야 한다(시즌 넘어 누적 금지). → Task 1 qa `trend season_cum_pts 시즌별 리셋`.
2. **K3·리그 정보 없는 팀** — 리그 평균 페이스 계산 불가 시 팀 선만 그리고 안내. → Task 3 `trend_without_league_avg`.
3. **표본 부족**(월 1~3경기·상대 1경기·날씨 구간 소수) — 막대/구간은 그리되 라벨·insufficient 로 구분, 색만으로 표시 금지. → Task 3 `*_small_sample`.
4. **팀 전환 연타** — 이전 팀 응답이 늦게 와서 현재 팀 차트를 덮으면 안 된다(기존 loadAll 은 토큰 없음). → Task 4 `check_team_switch_stale`.
5. **TERA 실패** — 팀 분석 화면이 깨지지 않고 오류 박스 + 표(근거) 펼침. → Task 4 `check_team_tera_fail`.

---

### Task 1: API — 팀 트렌드 시즌 누적·리그 평균 페이스(A7), 팀 날씨 PPG·CI(A3)
**Files:** `main.py` `get_team_trend`, `get_team_analytics`(날씨 bucket), `qa_check.py`
**Produces:**
- `team-trend.matches[]` 에 `season`(int, 경기 연도), `season_cum_pts`(그 시즌 누적), `league_avg_cum_pts`(같은 리그·같은 시즌, 그 경기 날짜까지 끝난 경기 기준 리그 팀 평균 누적 승점, 소수 2자리; 계산 불가면 null).
- `team-analytics.weather.by_*[]` 행에 `ppg`(=(3w+d)/games, 2자리), `ci`(경기 승점 표본 표준편차 기반 1.96·sd/√n, n<4 이면 null), `weather.overall_ppg`(날씨 표본 전체 PPG).
- [ ] qa(실패 먼저): `trend season_cum_pts 시즌별 리셋`(year 미지정 강원 — 시즌 첫 경기 season_cum_pts == pts), `trend league_avg_cum_pts 단조 비감소·0~3×경기수`, `analytics weather ppg·ci`, 두 엔드포인트 `기존 키 불변`.
- [ ] 구현(파라미터 바인딩만) → `bash /tmp/qarun.sh` 전부 PASS → Commit `feat(api): 팀 트렌드 리그 평균 페이스·팀 날씨 PPG 신뢰구간 (additive)`

### Task 2: 프리셋 `paceLine`, `diverging`
**Files:** `static/js/tt_charts.js`, `tests/js/tt_charts.test.js`, `static/dev/__lab.html`(미커밋 랩)
**Produces:**
- `presets.paceLine({ labels: string[], team: {name, color, data: (number|null)[]}, ref?: {name, data: (number|null)[]} })` → TERA `line`, `curveType:'monotone'`, team 굵게(3), ref 회색 점선; ref 없으면 1 series.
- `presets.diverging({ categories: string[], left: {name, color, data}, right: {name, color, data} })` → 가로 막대, left 값은 음수로 그려 0 중심 좌우 대칭(라벨은 절대값). TERA `row-bar` 2 series 의 `stacking:'normal'` + 음수(랩 검증; 불가 시 자체 Canvas).
- [ ] 랩에서 두 형식 확인 → Ruling 기록 → 테스트(`paceLine_two_series`, `paceLine_without_ref`, `diverging_left_negative`, `diverging_empty`) RED → 구현 → GREEN → Commit.

### Task 3: `TeamCharts` 빌더 8종 (순수)
**Files:** Create `static/js/team_charts.js`, `tests/js/team_charts.test.js`, `tests/js/fixtures/gangwon_2026_{team-analytics,team-trend,team-insights}.json`
**Produces:** `TeamCharts.{pace(trend, color), strip(trend), month(analytics), homeAway(analytics), vsOpp(analytics), weather(analytics), timing(insights), firstGoal(insights)}` → spec.
- `pace`: 마지막 시즌 경기만(`season` 최댓값), labels `"R"+순번`, team = season_cum_pts, ref = league_avg_cum_pts(전부 null 이면 생략). `__note` = 연도 전체일 때 `"{season} 시즌만 표시"`.
- `strip`: timelineGrid 1행(label = 팀 short 또는 "결과"), cells `{v: |gf-ga|, mark: result}`, vMax 4, legend "칸 진하기 = 점수차 · W 승 · D 무 · L 패".
- `month`: barRef categories `"{m}월"` + (games<4 이면 `" ({n}경기)"`), values PPG, ref = 전체 PPG.
- `homeAway`: dumbbell categories ["경기당 승점","경기당 득점","경기당 실점"], a 원정 b 홈 (by_year_ha 합산).
- `vsOpp`: games≥4 상대만 PPG 내림차순, ref = 팀 전체 PPG(vs_opponents 합산), 0개면 EMPTY.
- `weather`: forest rows = by_temp·by_hum·by_wind (`"기온 · "` 등 접두), est ppg, lo/hi = ppg∓ci, insufficient = ci==null, zero = weather.overall_ppg, zeroLabel "팀 평균".
- `timing`: diverging categories ["0-15","16-30","31-45","46-60","61-75","76+"], left 실점(against), right 득점(for).
- `firstGoal`: sankey nodes ["선제 득점","선제 실점","승","무","패"], links scored.w/d/l·conceded.w/d/l (0 제외).
- [ ] fixture 저장 → 테스트(각 빌더 + `trend_without_league_avg`, `month_small_sample`, `vsOpp_min_games`, `weather_small_sample`, `homeAway_values`, `firstGoal_links_sum`, 각 empty) RED → 구현 → GREEN → Commit.

### Task 4: `analytics.js` 배선
**Files:** `templates/index.html`(해당 7패널 canvas/표 컨테이너), `static/js/analytics.js`, `static/js/workspace.js`(onShow.team: `ttChartsReady` 확보 + `team_charts` 로드), `analysis/verify_tt_charts.py`
- 패널마다: 차트 슬롯 `<div class="tt-card-chart" data-chart-slot id="ta-<key>-slot"></div>` + (표가 있던 패널) `<details class="tt-card-evidence"><summary>근거 보기</summary><table …기존 id…></table></details>`. 트렌드 패널은 슬롯 2개(pace, strip).
- 렌더러: `renderTrend/renderMonth/renderHomeAway/renderVsOpponents/renderWeather/renderGoalTiming/renderFirstGoal` 가 기존 표 HTML 은 그대로 만들고(근거), 차트는 `TTChart.mount(slot, TeamCharts.x(...), {ariaLabel})`. TeamCharts/TTChart 미로드면 기존 Chart.js 경로 유지(폴백).
- `loadAll` 에 요청 토큰: 시작 시 `const tok = ++_loadSeq`, 응답 처리 전 `tok !== _loadSeq` 면 무시.
- check(실패 먼저): `check_team_charts_render`(강원 선택 → 슬롯 8개 ink>1%, 콘솔 0), `check_team_switch_stale`(팀 A 응답 3s 지연 + 팀 B 선택 → 최종 팀명·차트 = B), `check_team_tera_fail`(vendor 404 → 오류 박스·근거 펼침, pageerror 0), `check_team_year_all_note`(연도 전체 → 트렌드 안내 문구).
- [ ] RED → 구현 → GREEN → 스크린샷(1440·900) 확인 → Commit.

### Task 5: 회귀·기록
- [ ] node 전체 · verify 전체 · qa 전체 PASS, Firefox 팀 분석 1회. work-log·history 기록(전/후, 7인 관점). Commit.
