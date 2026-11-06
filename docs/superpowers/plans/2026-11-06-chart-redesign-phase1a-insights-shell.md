# 차트 개편 Phase 1a — 인사이트 심화 탭 대시보드 셸 + 검증된 프리셋 적용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인사이트 › 심화 탭(세로 23,000px, 표 18개 일렬)을 A안 대시보드(KPI 줄 → 테마 칩 → 카드 그리드, 카드 = 한 줄 해석 → 차트 → 접힌 근거 표)로 바꾸고, Phase 0에서 검증된 프리셋 5종으로 차트 9장을 붙인다. API 변경 없음.

**Architecture:** 기존 `insights.js` 렌더러(표·한 줄 해석·경고 HTML 생성)는 그대로 두고 "근거" 영역에 그린다. 카드 셸은 `TTDash`, 차트는 `InsCharts`(신규, 순수: API 응답 1개 → 프리셋 입력) → `TTChart.presets.*` → `TTChart.mount`. 렌더 후 근거 영역의 한 줄 해석·판정·경고 노드를 카드 상단으로 옮겨 접혀도 보이게 한다. 리그 '전체'는 카드마다 K1|K2 토글로 한 리그씩.

**Tech Stack:** Vanilla JS, TERA CHART 7.0.2(어댑터 경유), Node 24 `node:test`, Python Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-chart-dashboard-redesign-design.md` (§2 G2–G4, §4.2, §4.3, §4.4, §5.1) · Phase 0 결과 `checklist/work-log-2026-11-06.md`

**범위 분할:** Phase 1 = 1a(이 문서) + 1b(신규 프리셋 8종 + API 필드 A1·A2·A4·A5·A6·A9 + 날씨 CI). 1a 의 차트 없는 카드는 근거 표를 펼친 채로 보여 줘 기존 대비 정보 손실이 없다. 1a·1b 모두 끝난 뒤 한 번에 배포(사용자 결정).

## Global Constraints

- Phase 0 Global Constraints 전부 유지(운영 CSP, 인라인 스크립트 금지, `fromSpec` 금지, 3D/WebGL 금지, `TeraChart`는 `tt_charts.js` 밖 참조 금지, 12px·4.5:1·3:1, 모션 ≤400/300ms·reduced-motion).
- API·`main.py` 변경 없음. 프런트는 새 통계를 계산하지 않는다 — API 값의 표시 변환(정렬, 부호, 행 선택, 가중평균으로 '전체 평균' 기준선 표시)만 허용.
- 기존 경고·판정·표본 표기(`warnings`, `verdict`, `min_*`, `eligible:false` 행)는 하나도 숨기지 않는다 — 카드 상단으로 옮길 뿐.
- 랭킹 탭·규율 탭·다른 작업공간 탭은 이 Phase에서 변경 없음.
- 정적 파일 변경 시 `index.html` 버전 쿼리 갱신(`insights.js?v=56`, `workspace.js?v=12`, `tt_charts.js?v=2`, `tt_dash.js?v=2`, 신규 `ins_charts.js?v=1`).
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **숨겨진 탭에서 mount** — 심화 탭 카드는 패널이 `hidden`일 때 그려질 수 있다(필터 변경 후 재방문). 폭 0 슬롯은 그리지 말고, 보이는 순간 그려야 한다. → Task 1 `check_hidden_slot_draws_when_shown`.
2. **리그 토글 연타 / 필터 변경 중 응답 늦게 도착** — 이전 요청 응답이 나중에 와서 현재 리그·시즌 카드를 덮으면 안 된다. → Task 3 `check_stale_response_ignored`.
3. **한 리그만 eligible 데이터가 없음**(예: K2 단일 시즌 xG 표본 부족) — 그 리그로 토글하면 빈 상태 문구, 다른 카드·리그는 정상. → Task 2 `*_empty` 테스트 + Task 3 `check_league_toggle_switches`.
4. **TERA 로드 실패** — 심화 탭 진입 시 차트 9장은 오류 박스 + 근거 펼침, 표·해석은 그대로. → Task 3 `check_adv_tera_fail_shows_tables`.
5. **팀명/라벨 XSS** — InsCharts 가 만든 라벨은 Canvas/TERA(툴팁 이스케이프 확인됨)로만 가고, 카드 HTML은 TTDash 이스케이프. 근거 영역은 기존 렌더러(escI) 그대로. → Task 2 `labels_are_plain_strings`.

---

## File Structure

| 파일 | 역할 |
|------|------|
| `static/js/tt_dash.js` (수정) | `cardHtml` 옵션 `chart:false`, `bodyHtml`, 상단 슬롯 `.tt-card-lead` |
| `static/js/tt_charts.js` (수정) | 행 수 기반 높이, 폭 0 지연 렌더, `destroyAll`, null 가드, 오류 후 canvas 참조 해제, forest 값 열 `n` 표기 |
| `static/js/ins_charts.js` (신규) | `InsCharts.<card>(d) -> presetSpec` 순수 빌더 9종 + `CARDS` 카드 정의(메타) |
| `static/js/insights.js` (수정) | `loadAdvanced` 를 카드 루프로: 셸 렌더, 리그 토글, 칩 필터, KPI 줄, 리드 노드 이동, stale 응답 무시 |
| `templates/index.html` (수정) | 심화 패널 마크업을 셸 컨테이너 3개로 교체, 버전 쿼리 |
| `static/js/workspace.js` (수정) | `player` 탭 onShow: `ttLoadCharts()` 후 `insights` 로드 |
| `static/css/style.css` (수정, tt-dash 섹션) | `.tt-card-lead`, `.tt-card-body`(최대 높이 스크롤), 근거 안 기존 리드 중복 방지 |
| `tests/js/fixtures/*.json` (신규) | K1 2026 실응답 스냅샷 9종 |
| `tests/js/ins_charts.test.js` (신규) | 빌더 단위 테스트 |
| `analysis/verify_tt_charts.py` (수정) | 심화 탭 실화면 check 추가 |

---

### Task 1: 셸·어댑터 보강 (Phase 0 이월분)

**Files:** Modify `static/js/tt_dash.js`, `static/js/tt_charts.js`, `static/css/style.css`, `tests/js/tt_dash.test.js`, `tests/js/tt_charts.test.js`, `static/dev/mount_probe.*`, `analysis/verify_tt_charts.py`

**Interfaces:**
- Produces:
  - `TTDash.cardHtml(o)` 추가 옵션: `chart?: boolean = true`(false 면 `data-chart-slot` 없음), `bodyHtml?: string`(신뢰 HTML, `<div class="tt-card-body">` 로 감싸 차트 슬롯 뒤·근거 앞에 삽입), 항상 `<div class="tt-card-lead"></div>` 를 경고 뒤·차트 앞에 둔다.
  - `TTChart.mount(slot, spec, opts)` 추가 동작: `spec.__rows`(정수)가 있으면 슬롯 높이 = `max(기본 CSS 높이, __rows * (opts.rowPx || 26) + 56)` px 로 inline style 지정. `slot.clientWidth === 0` 이면 그리지 않고 ResizeObserver 가 폭>0 을 처음 보고할 때 최초 렌더(애니메이션 포함). `slot`/`spec` 이 null 이면 `console.warn` 후 no-op 핸들 반환(throw 금지). `showError` 후 내부 canvas 참조 `null`.
  - `TTChart.destroyAll(container: Element): number` — container 안 모든 `[data-chart-slot]` 의 핸들 destroy, 해제 개수 반환.
  - forest 프리셋 행 입력에 `n` 이 있으면 값 열 텍스트 = `"1.24 · n=82"`.
  - 프리셋 `dumbbell`·`heatMatrix`·`forest` 반환 spec 에 `__rows` = 행 수.

- [ ] **Step 1: 실패 테스트** — node: `cardHtml_chart_false_no_slot`(chart:false → `data-chart-slot` 없음), `cardHtml_body_html_raw`(bodyHtml `<table>` 원형 유지, `tt-card-body` 안), `cardHtml_has_lead_slot`(`tt-card-lead` 1회), `dumbbell_rows_meta`(categories 12개 → `__rows === 12`), `heatMatrix_rows_meta`, `forest_rows_meta`. Playwright: `check_hidden_slot_draws_when_shown`(display:none 부모 안 슬롯에 lazy:false mount → canvas 0개 또는 미렌더, 부모 표시 후 600ms 내 canvas 1개·ink>1%), `check_auto_height_rows`(`__rows:12` spec → 슬롯 offsetHeight ≥ 12*26+56), `check_destroy_all`(슬롯 3개 mount → `destroyAll(grid)` 반환 3, canvas 0), `check_mount_null_safe`(`mount(null, {})`·`mount(slot, null)` pageerror 0).
- [ ] **Step 2:** `node --test "tests/js/*.test.js"` 와 `python analysis/verify_tt_charts.py <신규 4개>` → 신규 항목 FAIL 확인.
- [ ] **Step 3:** 구현. CSS: `.tt-card-lead:empty{display:none}`, `.tt-card-lead .ins-take, .tt-card-lead .ins-rs-verdict, .tt-card-lead .ins-xl-warn{margin:6px 0}`, `.tt-card-body{max-height:420px;overflow:auto}`, `.tt-card-body:focus-visible` 포커스 링(스크롤 영역 키보드 접근: `tabindex="0"` 을 cardHtml 이 부여).
- [ ] **Step 4:** 전체 node·verify 재실행 → 모두 PASS.
- [ ] **Step 5: Commit** — `feat(charts): 셸·어댑터 보강 — 차트 없는 카드·리드 슬롯·행 비례 높이·숨김 슬롯 지연 렌더·destroyAll`

---

### Task 2: `InsCharts` — 카드 9종 차트 빌더 (순수)

**Files:** Create `static/js/ins_charts.js`, `tests/js/ins_charts.test.js`, `tests/js/fixtures/k1_2026_{xg-luck,opponent-strength,formation-matchup,standings-trend,pass-volume,rest-effect,substitution-impact,setpiece-profile,game-state}.json`

**Interfaces:**
- Consumes: `TTChart.presets.{bump,forest,dumbbell,quadrant,heatMatrix}` (Phase 0), Task 1 `__rows`.
- Produces: `InsCharts.<key>(d, colorOf) -> spec` (colorOf: `short -> hex|undefined`, 없으면 THEME.neutral) 와 `InsCharts.CARDS: Card[]`.
  `Card = { key, bodyId, size: "L"|"M"|"S", theme: "flow"|"tactics"|"squad"|"setpiece", icon, title, question, endpoint, perLeague: boolean, render: string /* insights.js 렌더러 이름 */, chart: boolean }`.
  CARDS 순서·값(모든 카드, 차트 없는 카드 포함 — Task 3 가 이 목록으로 그리드를 만든다):

  | key | bodyId | size | theme | endpoint | perLeague | render | chart |
  |-----|--------|------|-------|----------|-----------|--------|-------|
  | trend | ins-trend-body | L | flow | standings-trend | ✓ | renderTrend | ✓ bump |
  | xgluck | ins-xgluck-body | M | flow | xg-luck | ✓ | renderXgLuck | ✓ quadrant |
  | opp | ins-opp-body | L | flow | opponent-strength | ✓ | renderOppStrength | ✓ heatMatrix |
  | story | ins-story-body | M | flow | storylines | ✓ | renderStorylines | ✗ |
  | weather | ins-wx-body | M | flow | weather-effect | ✗ | renderWeather | ✗ (1b) |
  | formation | ins-fm-body | L | tactics | formation-matchup | ✓ | renderFormation | ✓ heatMatrix |
  | gs | ins-gs-body | M | tactics | game-state | ✓ | renderGameState | ✓ dumbbell |
  | pv | ins-pv-body | M | tactics | pass-volume | ✓ | renderPassVolume | ✓ dumbbell |
  | aft | ins-aft-body | M | tactics | goal-aftermath | ✓ | renderAftermath | ✗ (1b) |
  | hub | ins-hub-body | M | tactics | pass-hub | ✓ | renderPassHub | ✗ (1b) |
  | subimp | ins-subimp-body | M | squad | substitution-impact | ✓ | renderSubImpact | ✓ forest |
  | rest | ins-rest-body | M | squad | rest-effect | ✓ | renderRestEffect | ✓ forest |
  | rot | ins-rot-body | M | squad | rotation | ✓ | renderRotation | ✗ (1b) |
  | sdep | ins-sdep-body | M | squad | scoring-dependence | ✓ | renderScoringDep | ✗ (1b) |
  | sub | ins-sub-body | M | squad | substitution | ✗ | renderSubstitution | ✗ |
  | clutch | ins-clutch-body | S | squad | clutch | ✗ | renderClutch | ✗ (1b) |
  | spp | ins-spp-body | M | setpiece | setpiece-profile | ✓ | renderSetpieceProfile | ✓ quadrant |
  | weak | ins-weak-body | M | setpiece | defensive-weakness | ✓ | renderWeakness | ✗ (1b) |
  | shooting | ins-shooting-body | S | setpiece | shooting | ✗ | renderShooting | ✗ (1b) |
  | gk | ins-gk-body | S | setpiece | goalkeeper | ✗ | renderGoalkeeper | ✗ (1b) |
  | duel | ins-duel-body | S | setpiece | duels | ✗ | renderDuels | ✗ (1b) |

  title·icon·question 은 현재 `index.html` 카드 머리말(이모지·제목·`ins-clutch-hint` 문구)을 그대로 옮긴다(교체 분석 탭 2개는 "🔁 팀별 교체 효과"·"🦸 슈퍼서브·교체 시점", 경기 흐름 탭 2개는 "🎢 경기 상황별 성적"·"⚡ 득점 직후 실점·반격"으로 분리).

  빌더 9종(모두 `eligible` 행만, 데이터 없으면 프리셋이 `{__empty:true}`):
  - `trend(d, colorOf)` → `bump({rounds:d.rounds, nTeams:d.teams.length, teams: d.teams.map(t=>({id:t.id, short:t.short, color:colorOf(t.short), ranks:t.ranks})), highlight})`; highlight 기본 = 최종 순위 상위 3 + 하위 2 의 `id`.
  - `xgluck(d)` → `quadrant({points: 팀별 {id, label:short, x:xppg, y:ppg, color:primary}, xTitle:"기대 승점 (xPPG)", yTitle:"실제 승점 (PPG)", diagonal:true, quadrantLabels:["↖ 행운 (기대 이상)","","","불운 (기대 이하) ↘"]})`.
  - `opp(d)` → `heatMatrix({rows: short, cols:["상위권","중위권","하위권"], values: tiers.{top,mid,bottom}.ppg (tier 없거나 n<d.tier_min → null), center:d.league_ppg, colorTitle:"PPG"})`, 행 순서 = `rank_actual` 오름차순.
  - `formation(d)` → `heatMatrix({rows: d.formations, cols: d.formations, values[i][j] = matchups 중 formation=rows[i]·opp=cols[j] 의 ppg (n<d.min_cell 이면 null), colorTitle:"PPG", center: 전체 matchups 의 n 가중 평균 ppg})`. `d.formations` 가 문자열 배열이 아니면 matchups 의 고유 formation 을 n 합 내림차순 상위 6개.
  - `gs(d)` → `dumbbell({categories: short, a:{name:"뒤질 때 PPG", color:THEME.neg, data: trailed.ppg}, b:{name:"앞설 때 PPG", color:THEME.pos, data:(3*led.w+led.d)/led.n}})`, `led.n` 또는 `trailed.n` 이 `d.min_games` 미만인 팀 제외, 정렬 = 앞설 때 PPG 내림차순.
  - `pv(d)` → `dumbbell({categories: short, a:{name:"뒤질 때 패스 변화 %", color:THEME.neg, data: trail_dev}, b:{name:"앞설 때 패스 변화 %", color:THEME.pos, data: lead_dev}, decimals:1})`, `lead_dev`/`trail_dev` 가 null 인 팀 제외, 정렬 = `avg_passes` 내림차순.
  - `subimp(d)` → `forest({rows: 팀별 {label:short, est:vs_league, lo:vs_league-ci, hi:vs_league+ci, n, significant, insufficient: z==null}, zero:0, zeroLabel:"리그 평균", unit:"골"})`, 정렬 = vs_league 내림차순(insufficient 맨 뒤).
  - `rest(d)` → `forest({rows: [...buckets, ...congestion].map(b=>({label: (buckets 면 "간격 · " : "연전 · ")+b.label, est:b.ppg, lo:b.ppg-b.ci, hi:b.ppg+b.ci, n:b.n, insufficient:b.n<20})), zero: buckets 의 n 가중 평균 ppg(소수 2자리), zeroLabel:"전체 평균", unit:"PPG"})`.
  - `spp(d)` → `quadrant({points: 팀별 {label:short, x: for[k], y: against[k], color}, k = d.xg_ok ? "xg_pg" : "shots_pg", xTitle:"만든 세트피스 "+d.metric+"/경기", yTitle:"허용 세트피스 "+d.metric+"/경기", xMid: x 평균, yMid: y 평균, quadrantLabels:["","↗ 공격↑ 수비 약함","↙ 둘 다 적음","↘ 공격↑ 수비 탄탄"]})`. 색은 `colorOf(short)`.

- [ ] **Step 1:** 서버에서 K1 2026 응답 9종을 `tests/js/fixtures/` 에 저장(`curl -s "http://127.0.0.1:5000/api/insights/<ep>?year=2026&league=K1" > tests/js/fixtures/k1_2026_<ep>.json`). 파일 크기 0 아님 확인.
- [ ] **Step 2: 실패 테스트** (`tests/js/ins_charts.test.js`, fixture 로드):
  - `cards_cover_all_bodies`: CARDS 21개, bodyId 집합 = 현재 index.html 심화 패널의 body id 21개(위 표).
  - `trend_highlights_top3_bottom2`: highlight 길이 5, 최종 1위 팀 id 포함.
  - `xgluck_only_eligible`: points 수 = fixture eligible 팀 수.
  - `opp_rows_sorted_by_rank`: rows[0] = rank_actual 1 팀 short.
  - `formation_null_below_min_cell`: n<min_cell 셀은 value null.
  - `gs_sorted_and_filtered`: 첫 category 의 앞설 때 PPG ≥ 둘째.
  - `pv_decimals_1`: series 값 소수 1자리.
  - `subimp_insufficient_last`: z null 팀이 마지막에, label 에 "(표본 부족)".
  - `rest_reference_weighted_mean`: zero = Σ(ppg·n)/Σn (2자리) — fixture 로 계산한 기대값과 같음.
  - `spp_uses_metric_key`: xg_ok false fixture → x = for.shots_pg.
  - `*_empty`: 각 빌더에 `{teams:[]}`(또는 해당 배열 빈 값) → `{__empty:true}`.
  - `labels_are_plain_strings`: 모든 빌더 산출 라벨이 `<` 를 포함한 입력 `short:"<b>x</b>"` 에서도 문자열 그대로(HTML 해석 경로 없음 — spec 에 `__html` 류 키 없음).
- [ ] **Step 3:** `node --test "tests/js/*.test.js"` → 신규 FAIL.
- [ ] **Step 4:** `ins_charts.js` 구현(Phase 0 모듈 패턴, `globalThis.InsCharts` + `module.exports`; node 에서는 `require("./tt_charts.js")` 로 TTChart 확보).
- [ ] **Step 5:** 전체 node PASS.
- [ ] **Step 6: Commit** — `feat(insights): InsCharts 카드 정의 21종 + 차트 빌더 9종`

---

### Task 3: 심화 탭 대시보드 배선

**Files:** Modify `templates/index.html`(심화 패널 347–390 행 블록, 버전 쿼리), `static/js/insights.js`(`loadAdvanced`, `initCardTabs` 사용처), `static/js/workspace.js`(onShow.player), `static/css/style.css`, `analysis/verify_tt_charts.py`

**Interfaces:**
- Consumes: `InsCharts.CARDS`, `InsCharts.<key>`, `TTDash.{cardHtml,kpiStripHtml,chipsHtml,bindChips,bindLeagueToggle}`, `TTChart.{mount,destroyAll}`, `window.ttLoadCharts`.
- Produces (DOM, 검증 스크립트가 의존): 심화 패널 = `#ins-adv-kpis`, `#ins-adv-chips`, `#ins-adv-grid.tt-grid`; 카드 루트 id = `ins-c-<key>`; 근거 영역 = 기존 bodyId 요소(카드 `bodyHtml`/`evidenceHtml` 안).

- [ ] **Step 1: 실패 check 작성** (`verify_tt_charts.py`, 공통 헬퍼 `_open_adv(pw, width=1440, league="all", block_vendor=False)`: `/` 열고 `player` 탭 → 인사이트 펼침 → `[data-itab=adv]` 클릭 → `#ins-c-trend [data-chart-slot] canvas` 또는 오류 박스가 생길 때까지 폴링 20s):
  - `check_adv_cards_render`: 카드 21개, 차트 카드 9개 모두 canvas ink>1%, 차트 없는 카드는 근거 영역 내용 길이>0, 콘솔 에러 0.
  - `check_adv_height_budget`: 1440×900 에서 `#ins-panel-adv` scrollHeight ≤ 4500.
  - `check_adv_leads_hoisted`: `#ins-c-xgluck .tt-card-lead .ins-take` 존재, 근거 안 `.ins-take` 0개.
  - `check_league_toggle_switches`: league=all 에서 `#ins-c-xgluck` K2 클릭 → 근거 머리말 텍스트에 "K2", canvas 다시 그려짐, 다른 카드 리그 불변.
  - `check_chips_filter`: "세트피스·수비" 칩 → theme≠setpiece 카드 `hidden`, "전체" → 21개 표시.
  - `check_stale_response_ignored`: `xg-luck` 응답을 라우트로 2s 지연, 그 사이 시즌 필터 변경 → 최종 카드 근거 머리말 = 새 시즌.
  - `check_adv_tera_fail_shows_tables`: vendor 404 → 차트 카드 9개 `.tt-chart-error` + `details[open]`, `.tt-card-lead` 해석 유지, pageerror 0.
  - `check_k1_filter_no_toggle`: 상단 리그 필터 K1 → `.tt-lg-toggle` 0개.
- [ ] **Step 2:** 실행 → FAIL(구조 없음).
- [ ] **Step 3:** 구현
  - `index.html`: 심화 패널 안 `.ins-adv-grid` 블록 전체를 `<div id="ins-adv-kpis"></div><div id="ins-adv-chips"></div><div id="ins-adv-grid" class="tt-grid"></div>` 로 교체(제목·힌트 줄 유지). `#tt-lazy` 에 `"ins_charts": "/static/js/ins_charts.js?v=1"` 추가, 버전 쿼리 갱신.
  - `workspace.js` onShow.player: `window.ttLoadCharts().then(() => lazyLoadSeq(["ins_charts", "insights"]))`.
  - `insights.js`:
    - `ensureAdvShell()` 1회: CARDS → `TTDash.cardHtml({id:"ins-c-"+key, size, icon, title, question, warnings:[], theme, chart, leagues: perLeague && currentLeague==="all" ? ["K1","K2"] : undefined, activeLeague:"K1", ...(chart ? {evidenceHtml:`<div id="${bodyId}"></div>`} : {bodyHtml:`<div id="${bodyId}"></div>`})})` 를 그리드에 렌더(그 전에 `TTChart.destroyAll(grid)`), 칩(전체/흐름·운/전술/스쿼드 운용/세트피스·수비) 렌더·바인딩(카드 `hidden` 토글), 카드별 `bindLeagueToggle` → `loadCard(card, league)`.
    - `loadCard(card, league)`: 요청 토큰 `_advSeq` 증가값을 캡처, 응답 도착 시 토큰·시즌·리그 불일치면 무시. perLeague 면 `?year=…&league=<league.toLowerCase()>`, 아니면 기존 qs. 성공 시 기존 렌더러를 **해당 리그 1개 배열**로 호출(`renderX([d])`; 비 perLeague 렌더러는 기존 시그니처 그대로) → `hoistLeads(cardEl)`(bodyId 안 `.ins-take`, `.ins-rs-verdict`, `.ins-xl-warn` 를 `.tt-card-lead` 로 이동; 이전 리드 비움) → chart 카드면 `TTChart.mount(slot, InsCharts[key](d, colorOf), {ariaLabel: title})`. 실패 시 기존 `warn(name)` 경로.
    - `colorOf`: `xg-luck` 응답(리그별 캐시)의 `short→primary`, 없으면 undefined.
    - KPI 줄: league = 상단 필터 리그(전체면 K1)의 `standings-trend`(선두 short·points, `leader_changes`)·`xg-luck`(최대/최소 `luck_ppg` 팀) → `kpiStripHtml` 4칸(선두 / 가장 운 좋은 팀 / 가장 억울한 팀 / 선두 교체 횟수). 응답은 해당 카드 로드와 공유(중복 요청 금지: 리그별 Promise 캐시 `_advCache[ep+"|"+league+"|"+year]`).
    - `loadAdvanced()` 는 위 셸을 만들고 CARDS 각각 `loadCard(card, "K1"(전체면) | currentLeague)` 호출. 기존 `initCardTabs` 는 심화 패널 대상이 사라지므로 호출 유지해도 무해(대상 없음) — 그대로 둔다.
  - CSS: 근거 안 `.ins-adv-sub-h` 는 리그명 머리말로 유지; `.tt-card .ins-top-scroll` 은 `max-height` 제거(근거 안에서 전체 표).
- [ ] **Step 4:** check 8개 PASS. `node --test` 전체 PASS.
- [ ] **Step 5: Commit** — `feat(insights): 심화 탭을 대시보드 셸로 — KPI·테마 칩·카드 그리드·리그 토글·차트 9장`

---

### Task 4: 회귀·시각 검증·기록

**Files:** Modify `checklist/work-log-2026-11-06.md`, `checklist/history.md`(맨 끝에 1줄 요약)

- [ ] **Step 1:** `node --test "tests/js/*.test.js"`, `python analysis/verify_tt_charts.py`(전체), `python qa_check.py` → 전부 PASS (실패 시 원인 수정 후 재실행).
- [ ] **Step 2:** 심화 탭 스크린샷 1440·1280·900(`check_adv_screenshots` 추가 → `analysis/output/tt_adv_{w}.png`) + Firefox 로 `check_adv_cards_render` 1회. 스크린샷을 직접 열어 7인 관점 체크표(P1~P7 PASS/FAIL + 사유)를 work-log 에 기록. FAIL 항목은 수정 후 재촬영.
- [ ] **Step 3:** 전/후 비교 수치 기록: 심화 탭 높이(이전 23,407px → 측정값), 차트가 붙은 카드 수(이전 0 → 9), 전체 카드 수(18 → 21, 탭 카드 2개 분리).
- [ ] **Step 4: Commit** — `docs: 차트 개편 Phase 1a 검증 기록`

---

## Self-Review 결과
- Spec 커버리지: §4.2(KPI·칩·카드 문법·리그 토글·반응형·고정/비례 높이) T1·T3, §4.3(focus+context=bump 하이라이트, 불확실성=forest, 색 보정) T1·T2, §4.4(lazy·destroy) T1·T3, §5.1 중 9장 T2. 나머지 §5.1(날씨 forest, 실점 지도, 의존도 waffle, 로테이션 그리드, Sankey, 허브 lollipop, 승부처·벤치 beeswarm, 슈팅·GK bullet, 듀얼 lollipop, 랭킹 beeswarm, 규율 100% 막대)과 §4.5 API 필드는 Phase 1b 로 명시 이월.
- 리스크: `renderX([d])` 로 단일 리그 호출 시 기존 렌더러가 `list.length===2` 를 가정한 곳이 있으면 깨짐 → Task 3 Step 3 구현 중 각 렌더러의 `list.map` 사용을 확인(전부 map 기반이면 안전).
