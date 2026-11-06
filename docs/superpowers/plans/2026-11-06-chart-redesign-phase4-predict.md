# 차트 개편 Phase 4 — 시즌 시뮬레이션 히트맵 · 라운드 예측 확률 막대 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** (1) 인사이트 배너 한 줄로만 보이던 시즌 시뮬레이션을 심화 탭 카드 **"팀 × 최종 순위 확률" 히트맵**으로, (2) 경기예측 라운드 표의 홈·무·원정 %를 행마다 **100% 누적 인라인 막대**(숫자 유지)로.

**Spec:** §5.5 · 선행: `heatMatrix`, `InsCharts.CARDS`/`loadAdvCard`(Phase 1).

## 범위 결정
- 경기 리포트 xG 흐름: 이미 누적 계단선 + 골 마커(스펙 의도와 같음) → 유지.
- Chart.js 제거: 대체 차트(선제골·득실 마진·xG 누적 등)가 남아 spec §4.6 조건 미충족 → 유지, CSP 유지.
- 라운드 막대는 행당 Canvas 대신 CSS(경량, 색 + 숫자 병기).

## Review Focus
1. 시즌 종료(남은 경기 0) → 분포가 한 칸 100% — 정상 표시. 2. `ready:false` → 빈 상태. 3. 0% 칸은 비워(null) 노이즈 감소, 색만으로 정보 금지 → 칸 값 표기. 4. 예측 % 합이 100이 아닐 때(반올림) 막대가 넘치지 않음. 5. K2 홀수 팀(휴식) → 열 수 = 팀 수.

### Task 1: 시즌 시뮬레이션 카드
- `InsCharts.sim(d)` → `heatMatrix({rows: teams.name(현재 순서), cols: "1위".."N위", values: position_dist/n_simulations*100 (0 → null, 반올림 0자리), colorTitle: "%", decimals: 0})`; `ready` 거짓이면 EMPTY.
- `CARDS` 에 `{key:"sim", bodyId:"ins-sim-body", size:"L", theme:"flow", icon:"🎲", title:"시즌 시뮬레이션 — 최종 순위 확률", question:"남은 경기를 500번 시뮬레이션하면 몇 위로 끝나나?", url: lg => "/api/season-simulation?league="+lg+"&n=500", perLeague:true, render:"renderSim", chart:true}` (trend 다음).
- `insights.js`: `advFetch` 가 `card.url` 이 있으면 그 URL 사용(캐시 키 동일 규칙), `renderSim([d])` 근거 표(팀·우승%·AFC/승격%·강등%·평균 순위).
- 테스트: `sim_percent_matrix`, `sim_not_ready_empty`, `sim_zero_cells_null`, CARDS 수 22·차트 16 갱신, 행 배치 빈칸 상한 16.

### Task 2: 라운드 예측 인라인 막대
- `prediction.js` 라운드 표 행에 `<td class="rpp-bar-cell"><span class="rpp-bar" role="img" aria-label="홈 a% 무 b% 원정 c%"><i class="rpp-seg-h" style="width:a%"></i><i class="rpp-seg-d" …></i><i class="rpp-seg-a" …></i></span></td>`; 폭은 합으로 정규화.
- CSS: 홈 = 팀 A 쪽 accent, 무 = neutral, 원정 = 청록, 대비 3:1↑, 막대 높이 10px.
- check: `check_round_pred_bars`(경기예측 탭 → 라운드 표 막대 수 = 경기 수, 세 폭 합 ≈ 100%).

### Task 3: 회귀·기록·통합 배포 준비
