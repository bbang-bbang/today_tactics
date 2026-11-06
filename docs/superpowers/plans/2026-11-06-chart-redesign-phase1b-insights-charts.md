# 차트 개편 Phase 1b — 심화 탭 남은 카드 6장 차트화 + API 필드 4종 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1a에서 표로 남은 심화 카드 중 효과가 큰 6장(날씨·실점 약점 지도·득점 의존도·선발 로테이션·득점 직후·패스 허브)에 질문에 맞는 차트를 붙인다. 필요한 데이터는 기존 API에 **필드 추가만** 한다.

**Architecture:** 서버: 4개 엔드포인트에 새 키만 덧붙임(기존 키·계산 불변) + `qa_check.py` 검증. 프런트: 새 프리셋 4종(TERA 2종 `stacked100`·`lollipop`·`sankey` 검증 후, Canvas 자체 렌더러 2종 `timelineGrid`·`pitchZones`) → `InsCharts` 빌더 6종 → `CARDS` 의 `chart:true` 전환(1a 배선 그대로 사용).

**Tech Stack:** Flask/SQLite(main.py), Vanilla JS, TERA CHART 7.0.2(어댑터 경유), node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-chart-dashboard-redesign-design.md` §4.5(A1·A2·A9 + 날씨 CI), §5.1 · 선행: Phase 1a(`…phase1a-insights-shell.md`)

## 범위 결정 (사용자 확인 대상)
spec §5.1 중 다음은 **1b에서 제외**: 승부처 해결사 beeswarm(A5), 벤치 beeswarm(A6), 슈팅·GK bullet, 듀얼 lollipop, 화제 KPI 스파크라인(A4), 랭킹 탭 beeswarm, 규율 탭 100% 막대. 이유 — 해당 카드는 이미 막대형 순위 시각화가 있어 전환 효과가 작고(A5·A6·슈팅·GK·듀얼), A4 는 카드 종류마다 시계열 출처가 달라 비용 대비 효과가 낮음. 랭킹·규율 탭은 심화 탭과 별개 화면이라 Phase 3(선수) 때 함께 다룬다.

## Global Constraints
- Phase 0·1a Global Constraints 전부 유지.
- **API 는 additive only**: 기존 키 이름·타입·값·정렬 불변, 새 키만 추가. SQL 은 파라미터 바인딩만. 새 통계는 서버에서만 계산.
- 응답 형태가 바뀌므로 확인 시 Flask 재시작(인메모리 `@cached_response` 1h).
- 새 Canvas 렌더러는 forest 와 같은 규칙: DPR 수동 처리, 12px 이상, 텍스트 대비 4.5:1, 색 + 글자/기호 병기.
- 버전 쿼리: `tt_charts.js?v=3`, `ins_charts.js?v=3`, `insights.js?v=58`.

## Review Focus
1. **API 회귀** — 새 키 추가가 기존 키를 바꾸지 않아야 한다(기존 화면·`qa_check` 159항목 그대로 PASS). → 각 API Task 의 `기존 키 불변` qa 항목.
2. **흐름 4분기 합계** — 득점 직후 Sankey 의 4분기(추가골만/실점만/둘 다/변화 없음)는 상호배타이고 합이 `scored` 와 같아야 한다. → Task 2 qa `aftermath flow 합 = scored`.
3. **표본 부족 팀** — 로테이션 타임라인이 비거나(eligible false) 실점 지도 구역이 `null`(리그에서 분류 불가)이면 빈 칸·"분류 불가" 표기, 오류 아님. → Task 6 `*_null_cells`.
4. **K2 원본 'fast-break' 부재** — 실점 지도 상황 축에서 `available:false` 상황은 회색 + 라벨. → Task 6 `weak_unavailable_sit`.
5. **긴 팀 이름·라운드 수 많음(34+)** — 타임라인 그리드가 카드 폭을 넘지 않고 칸이 최소 8px 이상(넘치면 최근 N경기로 자름 + 안내). → Task 5 `timelineGrid_clips_to_width`.

---

## File Structure
| 파일 | 역할 |
|------|------|
| `main.py` (수정) | 로테이션 `timeline`, 득점 직후 `flow`, 날씨 `goals_ci`, 실점 지도 `zones_geom` 추가 |
| `qa_check.py` (수정) | 새 키 존재·범위·합계·기존 키 불변 qa 항목 |
| `static/js/tt_charts.js` (수정) | 프리셋 `stacked100`, `lollipop`, `sankey`(TERA), `timelineGrid`, `pitchZones`(자체 Canvas) |
| `static/js/ins_charts.js` (수정) | 빌더 `weather, weak, sdep, rot, aft, hub` + CARDS `chart:true`·`collapse` 해제 |
| `tests/js/tt_charts.test.js`, `tests/js/ins_charts.test.js`, `tests/js/fixtures/*` (수정/추가) | 단위 테스트 + 갱신 fixture |
| `analysis/verify_tt_charts.py` (수정) | 차트 카드 15장 렌더 check, 신규 Canvas 렌더 check |

---

### Task 1: API — 로테이션 `teams[].timeline` (A1)
**Files:** `main.py` `insights_rotation`(8297~), `qa_check.py`
**Interfaces — Produces:** eligible 팀마다 `timeline: [{ "ts": int(경기 시작 epoch), "changes": int(0~11), "pts": 0|1|3 }]` 시간순, 집계 구간(year) 안·직전 경기 비교 가능한 경기만(기존 `chg` 와 같은 집합 → `len(timeline) == matches`). 비 eligible 팀은 키 없음.
- [ ] **Step 1:** qa 추가 — `rotation timeline 길이 = matches`(K1 2026 eligible 전 팀), `rotation timeline changes 0~11·pts∈{0,1,3}·ts 오름차순`, `rotation 기존 키 불변`(teams[0] 의 기존 키 집합 ⊇ `{id, short, matches, eligible, avg_changes, core_size, high_n, high_ppg}`).
- [ ] **Step 2:** 서버 재시작 후 `python qa_check.py 2>&1 | grep rotation` → 새 2항목 FAIL.
- [ ] **Step 3:** 구현 — 기존 루프에서 `per_team[t]["chg"].append(...)` 하는 지점에 `per_team[t]["tl"].append({"ts": ts, "changes": chg, "pts": _ins_pts(gf, ga)})`, eligible 팀 dict 에 `"timeline": d["tl"]`.
- [ ] **Step 4:** 재시작 → rotation qa 3항목 PASS, 전체 qa 기존 159 PASS.
- [ ] **Step 5: Commit** `feat(api): 로테이션 팀별 경기 타임라인 필드 추가 (additive)`

### Task 2: API — 득점 직후 `flow` (A2)
**Files:** `main.py` `insights_goal_aftermath`(9078~), `qa_check.py`
**Interfaces — Produces:** 팀(eligible)·`league_total` 에 `flow: {"extra_only": int, "conc_only": int, "both": int, "none": int}` — 득점 1건마다 같은 창(`win`) 안에서 득점팀 추가골 여부(own) × 상대 득점 여부(opp) 로 정확히 한 칸. 합 = `scored`.
- [ ] **Step 1:** qa — `aftermath flow 합 = scored`(팀·리그), `aftermath flow conc_only+both = conc_obs`, `aftermath 기존 키 불변`.
- [ ] **Step 2:** 재시작 후 FAIL 확인.
- [ ] **Step 3:** 구현 — 기존 `opp_scored` 옆에 `own_more = any(t1 - t0 <= win and s1 == side for t1, _g, s1 in glist[i+1:])`, 4분기 카운트를 `st[scorer]["flow"]` 에 누적, 리그 합계도 동일.
- [ ] **Step 4:** PASS + 전체 qa.
- [ ] **Step 5: Commit** `feat(api): 득점 직후 흐름 4분기 집계 필드 추가 (additive)`

### Task 3: API — 날씨 `goals_ci` · 실점 지도 `zones_geom` (A3′·A9)
**Files:** `main.py` `insights_weather_effect`(8803~), `insights_defensive_weakness`(8411~), `qa_check.py`
**Interfaces — Produces:**
- 날씨 그룹 행마다 `goals_ci`: `goals_resid` 가 있으면 `round(1.96 * sd_all / sqrt(n), 2)`(기존 `goals_z` 와 같은 SE), 없으면 `null`.
- 실점 지도 최상위 `zones_geom`: `[{"key": str, "x0": float, "x1": float, "y0": float, "y1": float}]` — x = 골라인에서의 거리(m, 0~40 으로 표시 상한), y = 폭 %(0~100). `_weak_zone()` 과 같은 경계 상수에서 생성(상수를 모듈 상단 이름 상수로 뽑아 `_weak_zone` 도 그 상수 사용). 구역 우선순위대로: goalmouth `(0,5.5,36.5,63.5)`, box_center `(0,16.5,30,70)`, box_wide `(0,16.5,0,30)`·`(0,16.5,70,100)`, out_center `(16.5,40,30,70)`, out_wide `(16.5,40,0,30)`·`(16.5,40,70,100)`. 그리는 쪽은 뒤에서부터(넓은 구역 먼저) 칠하고 goalmouth 를 마지막에 덮는다.
- [ ] **Step 1:** qa — `weather goals_ci 양수 또는 null, goals_resid 있으면 not null`, `weakness zones_geom 7개 사각형·키 5종`, `weakness _weak_zone 경계 일치`(qa 안에서 대표 좌표 6개를 `_weak_zone` 대신 zones_geom 으로 판정해 기대 키와 비교: (3,50)→goalmouth, (10,50)→box_center, (10,10)→box_wide, (25,50)→out_center, (25,90)→out_wide, (5.4,36.4)→box_center), 두 엔드포인트 `기존 키 불변`.
- [ ] **Step 2:** FAIL 확인. **Step 3:** 구현. **Step 4:** PASS + 전체 qa.
- [ ] **Step 5: Commit** `feat(api): 날씨 득점 신뢰구간·실점 지도 구역 좌표 필드 추가 (additive)`

### Task 4: TERA 프리셋 3종 — `stacked100`, `lollipop`, `sankey`
**Files:** `static/js/tt_charts.js`, `tests/js/tt_charts.test.js`, `static/dev/chart_spike.js`(카드 3장 추가), `analysis/verify_tt_charts.py`
**Interfaces — Produces:**
- `presets.stacked100({ categories: string[], parts: {name, color, data: number[] /* % */}[] })` → TERA `row-bar` 가로 100% 누적(옵션명은 Step 1 랩에서 확정: `stacking:'percent'` 우선 시도). `__rows`.
- `presets.lollipop({ categories: string[], values: number[], color?, ref?: number, refLabel?: string, unit?: string })` → TERA `lollipop` 가로, `ref` 는 기준선(그려지지 않으면 forest 와 같은 자체 Canvas 로 대체). `__rows`.
- `presets.sankey({ nodes: string[], links: {source: string, target: string, value: number}[] })` → TERA `sankey`. 노드·링크 0 → EMPTY.
- [ ] **Step 1: 랩 검증** — `static/dev/__lab.html`(커밋 안 함)에서 세 타입의 실제 config 형식·기준선·라벨·한글을 확인하고 결과(옵션명, 대체 필요 여부)를 ledger 에 Ruling 으로 기록. 2개 이상 실패하면 사용자 보고(Phase 0 게이트 규칙).
- [ ] **Step 2: 실패 테스트** — `stacked100_shape`(카테고리 3·parts 2 → series 2, 각 data 길이 3, `__rows` 3), `stacked100_empty`, `lollipop_ref_line`(ref 1.3 → 기준선 설정 포함), `lollipop_sorted_input_kept`(입력 순서 유지), `sankey_links`(nodes 4·links 3 → TERA 형식으로 변환, value 합 보존), `sankey_empty`.
- [ ] **Step 3:** FAIL → 구현 → PASS. 스파이크 페이지에 카드 3장 추가 후 `check_spike_all_presets_ok` 기대 id 목록 확장해 PASS.
- [ ] **Step 4: Commit** `feat(charts): 프리셋 stacked100·lollipop·sankey`

### Task 5: 자체 Canvas 프리셋 2종 — `timelineGrid`, `pitchZones`
**Files:** `static/js/tt_charts.js`, `tests/js/tt_charts.test.js`, `static/dev/mount_probe.*`, `analysis/verify_tt_charts.py`
**Interfaces — Produces:**
- `presets.timelineGrid({ rows: {label: string, cells: {v: number /*0~11*/, mark: "W"|"D"|"L"}[]}[], vMax: number, maxCells?: number = 34, legend: string })` → `{__renderer:"timelineGrid", __model, __rows}`. 칸 진하기 = v/vMax(중립→accent), 칸 안 글자 = mark(12px, 칸 폭 ≥ 14px 일 때만; 아니면 칸 아래 1px 색 띠: W pos / D neutral / L neg). 칸 폭 = (카드 폭 − 라벨 폭) / 칸 수, 8px 미만이면 최근 `floor(가용폭/8)` 칸만 그리고 우상단에 "최근 N경기" 표기.
- `presets.pitchZones({ geom: {key,x0,x1,y0,y1}[], values: {[key]: {label: string, share: number|null, lg_share: number|null, z: number|null}}, title?: string })` → `{__renderer:"pitchZones", ...}`. 하프 피치(골라인 위쪽, x 0~40m 를 세로로) 위에 구역 칠하기: 색 = z 발산(≥2 neg 진하게 / ≤−2 pos / 그 외 neutral, z null 회색 빗금), 구역 중앙에 `share%` + 리그 `lg_share%` 작은 글씨, z≥2 구역은 "⚠" 기호 병기.
- mount: `__renderer` 가 `timelineGrid`/`pitchZones` 면 forest 와 같은 분기(TERA 불필요).
- [ ] **Step 1: 실패 테스트** — node: `timelineGrid_model`(rows 2·cells 3 → `__rows` 2, 모델 셀 v·mark 보존), `timelineGrid_clips_to_width`(순수 헬퍼 `presets._gridLayout(widthPx, labelPx, nCells)` → 가용 300px·라벨 60·칸 40 → `{cell: 8, shown: 30, clipped: true}`, 칸 10 → `{cell: 24, shown: 10, clipped: false}`), `pitchZones_order`(geom 의 goalmouth 가 그리기 순서 마지막), `pitchZones_null_cells`(z null 구역은 `hatch:true`). Playwright: `check_custom_renderers_draw`(두 렌더러 mount → ink>1%, TERA 404 에서도 그려짐).
- [ ] **Step 2:** FAIL → 구현 → PASS.
- [ ] **Step 3: Commit** `feat(charts): 자체 Canvas 프리셋 timelineGrid·pitchZones`

### Task 6: InsCharts 빌더 6종 + 카드 전환
**Files:** `static/js/ins_charts.js`, `tests/js/ins_charts.test.js`, `tests/js/fixtures/k1_2026_{rotation,goal-aftermath,weather-effect,defensive-weakness,scoring-dependence,pass-hub}.json`(Task 1~3 반영 후 새로 저장), `templates/index.html`(버전), `analysis/verify_tt_charts.py`
**Interfaces — Consumes:** Task 1~5 필드·프리셋. **Produces:** `InsCharts.{weather, weak, sdep, rot, aft, hub}(d, colorOf)`; CARDS 해당 6장 `chart:true`, `collapse` 제거; `ADV_CHART_KEYS`(verify) 15개로 확장.
- `weather(d)` → `forest({rows: groups.temp·precip·wind 행을 순서대로 {label:"기온 · "+label | "강수 · " | "바람 · ", est: goals_resid, lo: goals_resid−goals_ci, hi: +goals_ci, n, significant: goals_diff, insufficient: goals_resid==null}, zero:0, zeroLabel:"리그 평균", unit:"경기당 골(평균 대비)"})`. 날씨 카드는 리그 단일 호출 그대로(perLeague false).
- `weak(d, _, team?)` → 리그 전체 대신 **선택 팀 1개**를 그린다: 기본 = `flagged` 첫 팀, 없으면 eligible 첫 팀. `pitchZones({geom: d.zones_geom, values: 그 팀 zones[k] → {label, share, lg_share, z}})`. 카드에 팀 선택 `<select>` 는 이번 범위 밖 — 차트 위 제목에 팀명 표시(`__title`), 근거 표에서 다른 팀 확인.
- `sdep(d)` → `stacked100({categories: eligible short (top1_share 내림차순), parts:[{name:"1위 득점자", color: THEME.accent, data: top1_share}, {name:"2위 득점자", color:"#f59e0b", data: top2_share−top1_share}, {name:"나머지", color: THEME.neutral, data: 100−top2_share}]})`.
- `rot(d)` → `timelineGrid({rows: eligible 팀(avg_changes 내림차순) {label: short, cells: timeline.map(c => ({v: c.changes, mark: c.pts===3?"W":c.pts===1?"D":"L"}))}, vMax: 11, legend: "칸 진하기 = 직전 경기 대비 선발 교체 수 · 글자 = 승(W)·무(D)·패(L)"})`.
- `aft(d)` → `sankey({nodes:["득점", "추가골만", "실점만", "둘 다", "변화 없음"], links: league_total.flow 4칸 → "득점"→각 노드, 값 0 인 링크 제외})`.
- `hub(d)` → `lollipop({categories: eligible short (hub_share 내림차순), values: hub_share, ref: d.league_hub_share, refLabel: "리그 평균", unit: "%"})`.
- [ ] **Step 1:** fixture 6종 재저장(서버 재시작 후). **Step 2: 실패 테스트** — `weather_rows_from_groups`(행 수 = temp+precip+wind, ci 적용), `weak_default_team_flagged`, `weak_unavailable_sit`(zones 값 null → hatch), `sdep_parts_sum_100`(각 팀 세 부분 합 = 100 ±0.1), `rot_marks`(pts→W/D/L), `aft_flow_links_sum`(링크 합 = league_total.scored), `hub_ref_is_league`, `cards_chart_count_15`(CARDS chart:true 15개, collapse 0개), 각 `*_empty`.
- [ ] **Step 3:** FAIL → 구현 → PASS. `ADV_CHART_KEYS` 15개로 늘리고 `check_adv_tera_fail_shows_tables` 기대값 갱신: 오류 박스 = TERA 차트 수 = 15 − 자체 Canvas 5(forest 3장 subimp·rest·weather + timelineGrid rot + pitchZones weak) = 10.
- [ ] **Step 4:** verify 전체 + node 전체 + qa 전체 PASS, 스크린샷 3폭 + Firefox.
- [ ] **Step 5: Commit** `feat(insights): 날씨·실점 지도·득점 의존도·로테이션·득점 직후·패스 허브 차트`

### Task 7: 기록
- [ ] work-log 에 전/후(차트 카드 9→15, 패널 높이), 7인 관점 체크, 범위 제외 항목 기록. history 1줄. Commit `docs: 차트 개편 Phase 1b 검증 기록`.

## Self-Review 결과
- Spec 커버리지: §4.5 A1·A2·A9 + 날씨 CI(Task 1–3), §5.1 의 날씨·실점 지도·의존도·로테이션·득점 직후·패스 허브(Task 6). 제외 항목은 상단 "범위 결정"에 명시 — 사용자 확인 필요.
