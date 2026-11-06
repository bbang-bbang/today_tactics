# 차트 개편 Phase 0 — TERA 기반·대시보드 셸·게이트 스파이크 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TERA CHART를 self-host하고, 교체 가능한 어댑터(`tt_charts.js`)·핵심 프리셋 5종·대시보드 카드 셸(`tt_dash.js`)을 만든 뒤, 실데이터 스파이크 페이지로 Phase 0 게이트(spec §4.6)를 판정한다. 기존 화면 동작 변경 0.

**Architecture:** 화면 코드 → `TTChart.presets.*`(순수 함수: 도메인 데이터 → TERA config) → `TTChart.mount()`(DOM·DPR·리사이즈·접근성·lazy 렌더) → 전역 `TeraChart`. 카드 HTML은 `TTDash.*Html()` 순수 문자열 빌더. 순수 함수는 `node --test`로, DOM·렌더·CSP는 Playwright 스크립트로 검증.

**Tech Stack:** Vanilla JS(IIFE, 빌드 없음), TERA CHART 7.0.2(IIFE 전역), Node 24 `node:test`, Python Playwright(chromium), Flask 정적 서빙.

**Spec:** `docs/superpowers/specs/2026-11-06-chart-dashboard-redesign-design.md` (§3, §4.1–4.4, §4.6, §6 Phase 0)

## Global Constraints

- 운영 CSP(그대로 테스트에 주입): `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net/npm/chart.js@4.4.0/; object-src 'none'; base-uri 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';`
- 인라인 `<script>` 금지(CSP) — 페이지 스크립트는 전부 외부 파일.
- `TeraChart.fromSpec` / `fromSpecURL` 사용 금지(`new Function` → CSP 차단).
- 3D·WebGL 차트 타입 사용 금지.
- `TeraChart` 전역은 `static/js/tt_charts.js` 밖에서 참조 금지.
- 텍스트 최소 12px, 텍스트 대비 4.5:1, 그래픽 요소 대비 3:1(WCAG 1.4.11), 색만으로 정보 전달 금지(▲▼–, 라벨 병기).
- 모션: 최초 `animate` ≤ 400ms, `update` 300ms, `prefers-reduced-motion: reduce`면 `render`(정적).
- 카드 차트 높이 고정: L 320px / M 260px / S 200px.
- 사용자 입력·API 문자열을 HTML에 넣을 때 항상 이스케이프.
- 기존 Chart.js 및 기존 화면 코드는 이 Phase에서 수정하지 않는다(`index.html`의 lazy 맵 항목 추가만 예외).
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **빈/전부 표본부족 데이터** — 프리셋에 행이 0개거나 전부 `insufficient`면 TERA를 호출하지 않고 카드 차트 슬롯에 "표시할 데이터가 없습니다(표본 부족)"를 보여야 한다. → Task 3 `mount_empty_shows_placeholder`, Task 4 각 프리셋 `*_empty` 테스트.
2. **어두운 팀 컬러**(전북 `#0a4436`, 부천 `#8e272b` 등)가 배경 `#0b1220` 위에서 안 보이는 문제 — 3:1 미만이면 밝은 외곽선을 붙여야 한다. → Task 3 `ensureVisible_*` 테스트.
3. **빠른 탭/필터 전환** — 같은 슬롯에 `mount`를 연달아 호출해도 canvas가 1개만 남고 이전 리스너가 해제돼야 한다. → Task 3 `remount_same_slot_single_canvas`(Playwright).
4. **TERA 번들 로드 실패**(404·CSP 차단) — `mount`가 예외를 던지지 않고 슬롯에 "차트를 불러오지 못했습니다" + 카드의 근거 표를 자동으로 펼쳐야 한다. → Task 5 `tera_missing_fallback`(Playwright).
5. **팀/선수명 XSS** — 카드 제목·질문·한 줄 해석·경고·KPI 라벨에 `<img onerror>`가 들어와도 텍스트로 렌더돼야 한다. → Task 2 `cardHtml_escapes`, `kpiStripHtml_escapes`.

---

## File Structure

| 파일 | 역할 |
|------|------|
| `static/vendor/tera-chart-7.0.2.min.js` (신규) | TERA 번들, 첫 줄에 출처 주석 |
| `static/js/tt_charts.js` (신규) | 유일한 TERA 접점: 테마·유틸·mount/update/destroy·presets |
| `static/js/tt_dash.js` (신규) | 대시보드 셸 HTML 빌더 + 칩/토글 바인딩 |
| `static/css/style.css` (수정, 파일 끝에 섹션 추가) | `/* ── tt-dash ── */` 토큰·카드·KPI·칩 스타일 |
| `templates/index.html` (수정) | `#tt-lazy` 맵에 `tera`, `tt_charts`, `tt_dash` 추가 (로드 트리거는 Phase 1) |
| `static/dev/chart_spike.html`, `static/dev/chart_spike.js` (신규) | 실데이터 스파이크(게이트 판정용) |
| `tests/js/tt_charts.test.js`, `tests/js/tt_dash.test.js` (신규) | `node --test` 단위 테스트 |
| `analysis/verify_tt_charts.py` (신규) | Playwright: CSP 주입·렌더·리사이즈·destroy·폴백·스크린샷 |

모듈 패턴(두 JS 공통): IIFE가 `globalThis.TTChart`(또는 `TTDash`)를 정의하고 끝에 `if (typeof module !== "undefined") module.exports = TTChart;`. 순수 함수는 DOM·`TeraChart`에 접근하지 않는다.

---

### Task 1: TERA 벤더 추가 + lazy 맵 등록

**Files:**
- Create: `static/vendor/tera-chart-7.0.2.min.js`
- Modify: `templates/index.html` (`<script type="application/json" id="tt-lazy">` 블록)
- Create: `analysis/verify_tt_charts.py` (이 Task에서는 `check_vendor_loads`만)

**Interfaces:**
- Produces: lazy 키 `"tera"`, `"tt_charts"`, `"tt_dash"` → 이후 Phase에서 `lazyLoadSeq(["tera","tt_charts","tt_dash", ...])`로 사용. `verify_tt_charts.py`의 헬퍼 `open_with_csp(page, url)`(라우트로 HTML 응답에 Global Constraints의 CSP 헤더 주입)와 `collect_errors(page) -> list[str]`(console error + pageerror 수집).

- [ ] **Step 1:** `curl -s "http://192.168.10.94:7000/tera-chart.min.js?v=7.0.2" -o static/vendor/tera-chart-7.0.2.min.js` 후 파일 맨 앞에 한 줄 주석 삽입: `/*! TERA CHART v7.0.2 — source: internal http://192.168.10.94:7000 (author's personal library, used with permission request pending), fetched 2026-11-06. Do not edit; replace whole file to upgrade. */`. 크기 ≈ 1,201,225 B(+주석) 확인.
- [ ] **Step 2: 실패 테스트 작성** — `verify_tt_charts.py`에 `check_vendor_loads()`: `about:blank`가 아닌 `/static/dev/__vendor_probe.html`(이 Task에서 생성: `<script src="/static/vendor/tera-chart-7.0.2.min.js"></script><script src="/static/dev/__vendor_probe.js"></script>`, probe JS는 `window.__probe = typeof TeraChart === "object" && TeraChart.version`)을 CSP 주입으로 열어 `__probe`가 `"7.0.2"`로 시작하고 `collect_errors()`가 빈 리스트인지 assert. 스크립트는 `python analysis/verify_tt_charts.py [check_name ...]`로 개별 실행, 각 check는 PASS/FAIL 출력, 하나라도 FAIL이면 exit 1.
- [ ] **Step 3:** probe 파일 없이 실행 → FAIL(404) 확인: `python analysis/verify_tt_charts.py check_vendor_loads`
- [ ] **Step 4:** probe html/js 생성, 재실행 → `PASS check_vendor_loads`. `TeraChart.version` 실제 값이 다르면 assert를 그 값으로 고정하고 커밋 메시지에 기록.
- [ ] **Step 5:** `#tt-lazy` JSON에 추가: `"tera": "/static/vendor/tera-chart-7.0.2.min.js?v=1"`, `"tt_charts": "/static/js/tt_charts.js?v=1"`, `"tt_dash": "/static/js/tt_dash.js?v=1"`. 서버 기동 상태에서 메인 페이지 콘솔 에러 0 확인(아직 아무도 로드하지 않으므로 네트워크 요청도 없어야 함 — Playwright로 `/` 열고 요청 URL에 `tera-chart`가 없음을 assert하는 `check_not_loaded_on_home` 추가).
- [ ] **Step 6: Commit** — `git add static/vendor static/dev/__vendor_probe.* templates/index.html analysis/verify_tt_charts.py && git commit -m "chore(charts): TERA CHART 7.0.2 self-host + lazy 맵 등록"`

---

### Task 2: 대시보드 셸 — `tt_dash.js` HTML 빌더 + CSS

**Files:**
- Create: `static/js/tt_dash.js`, `tests/js/tt_dash.test.js`
- Modify: `static/css/style.css` (파일 끝 `/* ── tt-dash ── */` 섹션)

**Interfaces:**
- Produces (모두 순수, 문자열 반환):
  - `TTDash.esc(s: any) -> string` — `& < > " '` 이스케이프, null/undefined → `""`.
  - `TTDash.cardHtml(o) -> string`, `o = { id: string, size: "L"|"M"|"S", icon: string, title: string, question: string, take?: string, warnings: string[], evidenceHtml?: string, methodHtml?: string, leagues?: string[], activeLeague?: string, theme?: string }`. `warnings`가 배열이 아니면 `TypeError("warnings required")`. `evidenceHtml`·`methodHtml`은 이미 안전한 HTML로 간주(기존 렌더러 산출물)하고 그대로 삽입.
  - 출력 구조(셀렉터는 이후 Phase가 의존): 루트 `<section class="tt-card tt-card--{L|M|S}" id="{id}" data-theme="{theme}">`; 헤더 `.tt-card-h` 안 `.tt-card-title`, `.tt-card-q`; `leagues`가 2개 이상이면 `.tt-lg-toggle[role=tablist]` 안에 `<button role="tab" data-league="K1" aria-selected="true|false">`; `take`가 있으면 `.tt-card-take`; 경고마다 `<div class="tt-card-warn" role="note">⚠ …</div>`; 차트 슬롯 `<div class="tt-card-chart" data-chart-slot></div>`; `evidenceHtml||methodHtml`이 있으면 `<details class="tt-card-evidence"><summary>근거 보기</summary>{evidence}{method}</details>`.
  - `TTDash.kpiStripHtml(items) -> string`, `items: {label, value, delta?, dir?: "up"|"down"|"flat", hint?}[]` → `.tt-kpis` 안 `.tt-kpi`. `dir` 기호: up `▲`, down `▼`, flat `–` (색 클래스 `tt-kpi-d--up/down/flat` 병기).
  - `TTDash.chipsHtml(themes: {key,label}[], active: string) -> string` → `.tt-chips[role=tablist]` 안 `<button class="tt-chip" role="tab" data-theme-key aria-selected>`.
  - DOM 헬퍼(비순수, node 테스트 제외): `TTDash.bindChips(root: Element, onChange: (key) => void)`, `TTDash.bindLeagueToggle(cardEl: Element, onChange: (league) => void)` — 클릭 + 좌우 화살표 키 이동, `aria-selected`·`tabindex` 갱신.

- [ ] **Step 1: 실패 테스트 작성** (`tests/js/tt_dash.test.js`, `node:test` + `node:assert/strict`, `require("../../static/js/tt_dash.js")`):
  - `cardHtml_structure`: size `"L"` → `/class="tt-card tt-card--L"/`, `data-chart-slot` 1회, `id="ins-xgluck"`.
  - `cardHtml_requires_warnings`: `warnings` 생략 → `assert.throws(..., /warnings required/)`.
  - `cardHtml_escapes`: title·question·take·warnings에 `<img src=x onerror=alert(1)>` → 출력에 `<img` 없음, `&lt;img` 있음.
  - `cardHtml_league_toggle`: `leagues:["K1","K2"], activeLeague:"K2"` → K2 버튼 `aria-selected="true"`, K1 `"false"`; `leagues:["K1"]` → `tt-lg-toggle` 없음.
  - `cardHtml_evidence_optional`: evidence·method 둘 다 없으면 `<details` 없음.
  - `kpiStripHtml_dirs`: up/down/flat → `▲`, `▼`, `–` 각각 포함.
  - `kpiStripHtml_escapes`: label에 `<b>` → `&lt;b&gt;`.
  - `chipsHtml_active`: active `"flow"` → 해당 버튼만 `aria-selected="true"`.
- [ ] **Step 2:** `node --test tests/js/` → FAIL(모듈 없음).
- [ ] **Step 3:** `tt_dash.js` 구현(Interfaces대로). CSS 섹션 추가: 토큰은 `:root`에 `--tt-bg:#0b1220; --tt-card:#111a2e; --tt-line:#1f2a44; --tt-text:#e5e7eb; --tt-sub:#94a3b8; --tt-pos:#34d399; --tt-neg:#f87171; --tt-neutral:#475569; --tt-accent:#e8435a;`. 그리드 `.tt-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}`, `.tt-card--L{grid-column:span 8}`, `--M{span 6}`, `--S{span 4}`; `@media (max-width:1279px)` L=12·M/S=6, `@media (max-width:899px)` 전부 12. 차트 슬롯 높이 L 320 / M 260 / S 200px. `.tt-card-take` = 좌측 3px `--tt-accent` 보더 박스. 칩·토글·`summary`에 hover/active/`:focus-visible`(2px outline `--tt-accent`) 정의, transition 0.15s ease-in-out. 폰트 최소 12px, line-height 1.5. 기존 클래스와 충돌 없도록 전부 `tt-` 접두사.
- [ ] **Step 4:** `node --test tests/js/` → 8개 PASS.
- [ ] **Step 5: Commit** — `feat(charts): 대시보드 카드 셸 tt_dash.js + tt-dash CSS 토큰`

---

### Task 3: 어댑터 코어 — `tt_charts.js` 테마·유틸·mount

**Files:**
- Create: `static/js/tt_charts.js`, `tests/js/tt_charts.test.js`
- Modify: `analysis/verify_tt_charts.py` (mount 계열 check 추가)
- Create: `static/dev/mount_probe.html`, `static/dev/mount_probe.js`

**Interfaces:**
- Produces:
  - `TTChart.THEME` = `{ bg: "#0b1220", text: "#e5e7eb", sub: "#94a3b8", grid: "rgba(51,65,85,0.5)", pos: "#34d399", neg: "#f87171", neutral: "#475569", accent: "#e8435a", font: "'Noto Sans KR', system-ui, sans-serif", fontSize: 12 }` (CSS 토큰과 같은 값).
  - `TTChart.util.contrast(hexA, hexB) -> number` (WCAG 상대휘도 대비비).
  - `TTChart.util.ensureVisible(hex, bg = THEME.bg) -> { fill: string, stroke: string|null }` — `contrast(hex,bg) < 3` 이면 `stroke = THEME.text`, 아니면 `null`.
  - `TTChart.withTheme(cfg) -> cfg'` — 순수. 배경 투명(`background:{color:"rgba(0,0,0,0)"}`), 제목/부제 제거(카드가 담당), 축 라벨·범례·툴팁 색/폰트를 THEME로 채우되 **cfg에 이미 있는 값은 덮지 않음**(deep merge, cfg 우선), 폰트 크기 하한 12.
  - `TTChart.isEmpty(spec) -> boolean` — 프리셋이 붙인 `spec.__empty === true`.
  - `TTChart.mount(slotEl: Element, spec: object, opts?: { lazy?: boolean = true, ariaLabel?: string }) -> Handle`. `Handle = { update(spec): void, destroy(): void, canvas: HTMLCanvasElement|null }`.
    - 같은 `slotEl`에 기존 핸들이 있으면 먼저 `destroy()` (슬롯에 `WeakMap`으로 보관).
    - `isEmpty(spec)` → canvas 없이 `<div class="tt-chart-empty">표시할 데이터가 없습니다 (표본 부족)</div>`.
    - `typeof TeraChart === "undefined"` 또는 렌더 예외 → `<div class="tt-chart-error" role="alert">차트를 불러오지 못했습니다</div>` + 가장 가까운 `.tt-card` 안 `details.tt-card-evidence`에 `open` 설정. 예외는 `console.warn`만, throw 금지.
    - canvas 크기 = 슬롯 clientWidth × clientHeight, `width/height` 속성은 × `devicePixelRatio`, style은 CSS px. TERA config의 `width`/`height`는 CSS px 값 전달(스파이크에서 TERA가 DPR을 자체 처리하는지 확인하고 이중 스케일 시 한쪽 제거 — 결과를 Task 5 리포트에 기록).
    - `lazy` → `IntersectionObserver`(rootMargin `"200px"`)로 보일 때 최초 렌더.
    - 최초 렌더: `matchMedia("(prefers-reduced-motion: reduce)")`면 `TeraChart.render`, 아니면 `TeraChart.animate` (config `animation.duration`을 400으로 상한).
    - `update(spec)` → `TeraChart.update(canvas, withTheme(spec), { duration: 300 })` (reduced-motion이면 `render`).
    - 리사이즈: `ResizeObserver`로 슬롯 크기 변화 감지 → 150ms 디바운스 후 크기 재설정 + `render`.
    - `destroy()` → `TeraChart.stop(canvas)`, observer 둘 다 disconnect, canvas 제거, WeakMap 삭제.
    - 접근성: canvas에 `role="img"`, `aria-label = opts.ariaLabel || spec.__aria || "차트"`.

- [ ] **Step 1: 실패 테스트 작성** (`tests/js/tt_charts.test.js`):
  - `contrast_known_pairs`: `contrast("#ffffff","#000000")` ≈ 21 (±0.01), `contrast("#0b1220","#0b1220")` = 1.
  - `ensureVisible_dark_team_gets_stroke`: `#0a4436` → `stroke === THEME.text`; `#8e272b` → stroke 있음.
  - `ensureVisible_bright_team_no_stroke`: `#ef3744`, `#01a0fc` → `stroke === null`.
  - `withTheme_keeps_explicit_values`: 입력 `{type:"line", legend:{position:"top"}}` → 결과 `legend.position === "top"`, `legend` 글자색 = THEME.sub, `background.color === "rgba(0,0,0,0)"`, `title` 없음.
  - `withTheme_font_floor`: 입력 축 라벨 fontSize 9 → 결과 12.
  - `withTheme_pure`: 입력 객체가 변경되지 않음(`structuredClone` 비교).
- [ ] **Step 2:** `node --test tests/js/` → 새 6개 FAIL.
- [ ] **Step 3:** 순수부(THEME, util, withTheme, isEmpty) 구현 → `node --test` 전부 PASS.
- [ ] **Step 4: 실패 Playwright check 작성** — `mount_probe.html`(vendor + tt_dash + tt_charts + mount_probe.js, 슬롯 3개)과 check:
  - `mount_renders_nonblank`: 단순 line spec mount 후 canvas 1개, `getImageData` 픽셀 중 투명 아닌 비율 > 1%.
  - `mount_empty_shows_placeholder`: `{__empty:true}` → canvas 0개, `.tt-chart-empty` 텍스트 일치.
  - `remount_same_slot_single_canvas`: 같은 슬롯에 mount 5회 연속 → canvas 1개.
  - `destroy_cleans_up`: destroy 후 슬롯 안 canvas 0개.
  - `resize_rerenders`: 뷰포트 1440→900, 600ms 후 canvas CSS 폭이 줄었음.
  - `canvas_has_aria`: `role="img"`, `aria-label` 비어있지 않음.
  - 모든 check는 CSP 주입 + `collect_errors()==[]` 포함.
- [ ] **Step 5:** 실행 → FAIL 확인: `python analysis/verify_tt_charts.py mount_renders_nonblank mount_empty_shows_placeholder remount_same_slot_single_canvas destroy_cleans_up resize_rerenders canvas_has_aria`
- [ ] **Step 6:** `mount`/`update`/`destroy` 구현 → 6개 PASS.
- [ ] **Step 7: Commit** — `feat(charts): tt_charts 어댑터 코어 (테마·대비 보정·mount/update/destroy·lazy·a11y)`

---

### Task 4: 핵심 프리셋 5종 (순수 함수)

**Files:**
- Modify: `static/js/tt_charts.js` (`TTChart.presets`)
- Modify: `tests/js/tt_charts.test.js`

**Interfaces:**
- Consumes: `TTChart.THEME`, `TTChart.util.ensureVisible` (Task 3).
- Produces (모두 순수, TERA config 반환, 데이터 없으면 `{__empty:true}`; 반환 config에 `__aria` 한 문장 요약 포함):
  - `presets.bump({ rounds: number[], teams: {id, short, color, ranks: (number|null)[]}[], nTeams: number, highlight?: id[] })` → `type:"line"`. 각 팀 series `data[i] = ranks[i]==null ? null : {y: nTeams + 1 - ranks[i]}` (위로 갈수록 1위). `xAxis.categories = rounds.map(r => "R"+r)`. `yAxis` min 1, max nTeams, 눈금 라벨은 `(nTeams+1-v)+"위"`로 표시(TERA 라벨 포매터 옵션명은 스파이크에서 확인, 없으면 `annotations` 텍스트로 좌측 라벨). `highlight` 비었으면 전 팀 컬러; 있으면 highlight 팀 `color`·`lineWidth 3`, 나머지 `THEME.neutral`·`lineWidth 1.5`·`opacity .5`. 마지막 라운드에 팀 `short` 직접 라벨(annotation). `smooth:true`.
  - `presets.forest({ rows: {label, est, lo, hi, n, significant?: boolean, insufficient?: boolean}[], zero?: number = 0, unit?: string })` → 가로 `range-bar`(CI) + 추정치 점. 행 순서 = 입력 순서(호출자가 정렬). `insufficient` 행은 CI·점 생략, 라벨 `"{label} (표본 부족)"`. `significant` 행은 점 색 `est>zero ? THEME.pos : THEME.neg`, 비유의는 `THEME.text`. `zero`에 세로 기준선(plotLine, 점선). 점을 range-bar 위에 겹칠 TERA 방법은 스파이크에서 결정(`mixed` 또는 `annotations` point) — config 생성부는 `rows`→`{categories, ranges:[{low,high}], points:[{y:est,color}]}` 중간 표현을 만드는 `presets._forestModel(rows, zero)`로 분리해 테스트.
  - `presets.dumbbell({ categories: string[], a: {name, color, data: number[]}, b: {name, color, data: number[]}, decimals?: number = 2 })` → `type:"dumbbell"`, `orientation:"horizontal"`, `showDelta:true`, `showValueLabels:true`, `connectorWidth:3`, `markerRadius:7`. 길이 불일치 → `RangeError`.
  - `presets.quadrant({ points: {id, label, x, y, color}[], xTitle, yTitle, xMid?: number, yMid?: number, diagonal?: boolean, quadrantLabels?: [tl, tr, bl, br], highlight?: id[] })` → `type:"scatter"`. 점마다 `ensureVisible(color)` 적용(stroke 있으면 marker 외곽선). `xMid`/`yMid` 기준선(plotLines). `diagonal` → x·y 공통 범위 [min, max]로 y=x 점선. 사분면 라벨은 각 모서리 annotation. 점 라벨은 `highlight` 지정 시 그 팀만, 없으면 전부.
  - `presets.heatMatrix({ rows: string[], cols: string[], values: (number|null)[][], center?: number, decimals?: number = 2, colorTitle?: string })` → `type:"heatmap"`, `data = [{x: colIdx, y: rowIdx, value}]`(null은 `value:null`, `nullColor: "#1e293b"`), `center` 있으면 발산 colorStops `[THEME.neg, THEME.neutral, THEME.pos]`를 center 기준 대칭(min/max는 `center ± max|v−center|`), 없으면 순차 `[THEME.neutral, THEME.pos]`. `showValues:true`, `valueTextStyle.fontSize:12`.

- [ ] **Step 1: 실패 테스트 작성** (값은 실제 K1 2026 데이터에서 발췌):
  - `bump_transforms_rank`: nTeams 12, 서울 ranks `[3,1,1]` → data y `[10,12,12]`; categories `["R1","R2","R3"]`.
  - `bump_null_round`: ranks `[2,null,4]` → data `[{y:11}, null, {y:9}]`.
  - `bump_highlight_dims_others`: highlight `[7646]` → 그 series color = 팀 color·lineWidth 3, 다른 series color = THEME.neutral.
  - `bump_empty`: teams `[]` → `{__empty:true}`.
  - `forest_model_basic`: rows `[{label:"3일 이하",est:1.24,lo:0.98,hi:1.50,n:82},{label:"4~6일",est:1.52,lo:1.31,hi:1.73,n:147}]` → categories 동일 순서, ranges `[{low:0.98,high:1.5},{low:1.31,high:1.73}]`.
  - `forest_model_insufficient`: `insufficient:true` 행 → label에 `"(표본 부족)"`, range·point `null`.
  - `forest_significant_colors`: zero 0, `{est:0.31,significant:true}` → THEME.pos, `{est:-0.2,significant:true}` → THEME.neg, `{est:0.1}` → THEME.text.
  - `forest_empty`: 전부 insufficient → `{__empty:true}`.
  - `dumbbell_shape`: categories `["서울","광주"]`, a=[0.38,0.2], b=[2.62,1.1] → `type==="dumbbell"`, `orientation==="horizontal"`, series 2개 순서 a,b.
  - `dumbbell_length_mismatch`: → `RangeError`.
  - `quadrant_diagonal_range`: points x `[1.55,0.79]`, y `[1.89,0.78]`, diagonal true → 대각선 from `{x:0.78,y:0.78}` to `{x:1.89,y:1.89}`.
  - `quadrant_dark_color_stroke`: color `#0a4436` 점 → marker에 외곽선 색 THEME.text.
  - `heatMatrix_cells`: rows 2 × cols 3, values `[[2.17,1.92,1.8],[null,1.1,0.5]]` → data 길이 6, `{x:0,y:1,value:null}` 포함.
  - `heatMatrix_diverging_symmetric`: center 1.33, values max 2.17 min 0.5 → 스케일 min `1.33-0.84=0.49`, max `2.17` (반올림 2자리).
- [ ] **Step 2:** `node --test tests/js/` → 새 테스트 FAIL.
- [ ] **Step 3:** 프리셋 구현 → 전부 PASS. TERA 옵션명이 불확실한 부분(bump 눈금 포매터, forest 점 오버레이)은 이 Task에서 `// SPIKE:` 주석으로 표시하고 Task 5에서 확정.
- [ ] **Step 4: Commit** — `feat(charts): 프리셋 5종 bump/forest/dumbbell/quadrant/heatMatrix`

---

### Task 5: 실데이터 스파이크 페이지 + 게이트 판정

**Files:**
- Create: `static/dev/chart_spike.html`, `static/dev/chart_spike.js`
- Modify: `analysis/verify_tt_charts.py`, `static/js/tt_charts.js`(SPIKE 주석 해소)
- Create: `checklist/work-log-2026-11-06.md`에 게이트 결과 섹션 (파일 없으면 생성)

**Interfaces:**
- Consumes: `TTDash.cardHtml`, `TTDash.kpiStripHtml`, `TTDash.chipsHtml`, `TTDash.bindLeagueToggle`, `TTChart.mount`, `TTChart.presets.*`.
- Produces: `window.__spikeResults = { [presetName]: { ok: boolean, nonBlank: boolean, ms: number, note: string } }`, `window.__spikeDone = true`.

- [ ] **Step 1:** 스파이크 페이지 작성 — `.tt-kpis`(xg-luck에서 선두·최대 행운·최대 불운·경기 수 4칸) + `.tt-chips`(전체/흐름·운/전술/스쿼드 운용/세트피스·수비) + `.tt-grid`에 카드 5장. 데이터(전부 `year=2026&league=K1`, 기존 API 그대로):
  - L `bump` ← `/api/insights/standings-trend` (`rounds`, `teams[].ranks`, `short`; 색은 `/api/insights/xg-luck`의 `teams[].short→primary` 매핑, 미매칭 THEME.neutral). highlight 없음.
  - M `quadrant` ← `/api/insights/xg-luck` (`eligible` 팀만: x=`xppg`, y=`ppg`, diagonal true, quadrantLabels `["↖ 행운 (기대 이상)", "", "", "불운 (기대 이하) ↘"]` — 빈 문자열 모서리는 라벨 생략).
  - M `forest` ← `/api/insights/rest-effect` `buckets` (est=`ppg`, lo/hi=`ppg∓ci`, `n<20` → insufficient), zero = 리그 평균 PPG(`/api/insights/opponent-strength`의 `league_ppg`).
  - M `dumbbell` ← `/api/insights/game-state` eligible 팀: a=뒤질 때 PPG `trailed.ppg`, b=앞설 때 PPG `(3*led.w + led.d)/led.n` (표시 전용 환산, 2자리).
  - M `heatMatrix` ← `/api/insights/opponent-strength` eligible 팀 × `["top","mid","bottom"]` → 열 라벨 `["상위권","중위권","하위권"]`, value=`tiers[k].ppg`, center=`league_ppg`.
  - 각 카드 `warnings`는 응답 `warnings` 배열 그대로, `evidenceHtml`은 `"<p>스파이크 — 근거 표는 Phase 1</p>"`.
  - 렌더 후 `__spikeResults` 채우기(mount 소요 ms, canvas 비공백 여부).
- [ ] **Step 2: 실패 check 작성** — `spike_all_presets_ok`: CSP 주입으로 `/static/dev/chart_spike.html` 열고 `__spikeDone` 대기(20s), 5개 전부 `ok && nonBlank`, `collect_errors()==[]`. `spike_screenshots`: 1440·1280·900 폭 전체 페이지 스크린샷 → `analysis/output/tt_spike_{w}.png`. `tera_missing_fallback`: 라우트로 vendor 요청을 404 처리 → 카드 5장 모두 `.tt-chart-error` 표시 + `details.tt-card-evidence[open]`, pageerror 0.
- [ ] **Step 3:** 실행 → 페이지 없음으로 FAIL 확인.
- [ ] **Step 4:** 페이지 구현, `// SPIKE:` 항목 해소(bump 눈금 라벨 방식, forest 점 오버레이 방식, DPR 이중 스케일 여부) → 3개 check PASS.
- [ ] **Step 5: 시각 검증(사람 눈)** — 세 스크린샷을 직접 열어 각 프리셋을 판정 표로 기록: 한글 라벨 깨짐 / 12px 이상 / 팀 색 구분 / 어두운 팀 외곽선 / 축·기준선 / 툴팁 hover(1440에서 Playwright `hover` 후 스크린샷 1장씩). Chrome 외에 Playwright `firefox`로 `spike_all_presets_ok` 1회 재실행(Edge는 Chromium 동일 엔진 — 사용자 수동 확인 항목으로 기록).
- [ ] **Step 6: 게이트 판정 기록** — `checklist/work-log-2026-11-06.md`에 프리셋별 PASS/FAIL·사유·대체안. FAIL 2개 이상이면 spec §4.6대로 **구현 중단하고 사용자 보고**. 1개 이하면 해당 프리셋의 대체(어댑터 내부 Canvas 직접 구현 또는 Chart.js 유지)를 Phase 1 계획 입력으로 적는다.
- [ ] **Step 7: 전체 회귀** — `node --test tests/js/` 전부 PASS, `python analysis/verify_tt_charts.py`(전체) 전부 PASS, `python qa_check.py` 기존과 동일 결과, 메인 페이지 기존 탭 5개 열어 콘솔 에러 0(`check_existing_tabs_clean` 추가: 각 `.ws-tab` 클릭 후 errors 빈 리스트).
- [ ] **Step 8: Commit** — `feat(charts): Phase 0 실데이터 스파이크 + 게이트 판정 기록`

---

## Self-Review 결과
- Spec 커버리지: §4.1(벤더·어댑터·lazy 등록·TeraChart 격리) T1·T3, §4.2(카드 문법·KPI·칩·리그 토글·반응형·고정 높이) T2, §4.3(색·보조 부호·불확실성·모션·a11y) T2·T3·T4, §4.4(IO lazy·destroy) T3, §4.6 게이트 T5. §4.5 API 추가·§5 화면 적용은 Phase 1+ 계획으로 이월(의도).
- 이월 항목: 나머지 프리셋(waffle, beeswarm, sankey, lollipop, bullet, kpiSpark, ridgeline, timelineGrid, stacked100)은 쓰는 화면의 Phase 계획에서 추가 — 게이트 결과에 따라 형태가 달라질 수 있어 선행하지 않음.
