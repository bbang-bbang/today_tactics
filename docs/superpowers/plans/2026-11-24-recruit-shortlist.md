# 영입 후보 목록(숏리스트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 영입 추천의 모든 후보 표에서 ☆로 담고, 팀별 후보 목록을 비교 패널로 보고, CSV로 내보낸다.

**Architecture:** 순수 로직(검증·저장·CSV·패널 HTML)은 새 파일 `static/js/recruit_shortlist.js`
(UMD: `window.ttShortlist` + `module.exports`, `tt_dash.js` 패턴)로 분리해 node 테스트. `recruit.js`는
행마다 ☆ 버튼과 패널 토글만 붙인다. 서버·DB·API 변경 없음.

**Tech Stack:** Vanilla JS, localStorage, `node --test`, Playwright(브라우저 확인).

**Spec:** `docs/superpowers/specs/2026-11-24-recruit-shortlist-design.md`

## Global Constraints
- localStorage 키 `tt_recruit_shortlist_v1`, 값 `{ [teamSlug]: entry[] }`, 팀당 최대 **10명**.
- 모든 localStorage 접근 try/catch — 실패해도 화면 정상(목록은 빈 것으로).
- 화면에 넣는 모든 문자열 `ttEsc`(저장값 포함). 숫자는 `Number.isFinite` 검증.
- CSV: UTF-8 BOM, `"` → `""`, 셀이 `= + - @ \t \r`로 시작하면 앞에 `'`. 파일명 `영입후보_{팀}_{YYYYMMDD}.csv`.
- 국내(kr)·해외(os) 후보는 패널에서 구역 분리 + 안내 "지표 정의가 다른 리그(해외 API)라 국내 후보와 수치를 직접 비교하지 마세요".
- CSS: 최소 12px, 대비 4.5:1, hover/active/focus-visible 정의, 기존 `rc-*` 톤 재사용.
- 추천/적합도 공식 변경 없음.

## Review Focus
1. 손으로 망가뜨린 localStorage(JSON 아님·배열 아님·필드 누락·`name`에 `<script>`) → 예외 없이 잘못된 entry만 버리고 그림. (Task 1 `sanitize_*` 테스트)
2. 같은 선수를 다른 모드 표에서 다시 담기 → 중복 없이 '담김' 상태로 표시. (Task 1 `add_dedupes`)
3. 11번째 담기 → 거부되고 안내, 목록 10명 유지. (Task 1 `add_caps_at_10`)
4. 해외 후보는 player_id가 없음 → id = `os:{name}|{team}`로 안정적 키. (Task 1 `entry_id`)
5. 팀 전환 시 다른 팀 목록이 보이지 않음 + 표를 다시 그려도 ★ 상태 유지. (Task 3 브라우저 확인)

---

### Task 1: `recruit_shortlist.js` 순수 로직 + 저장

**Files:**
- Create: `static/js/recruit_shortlist.js`
- Test: `tests/js/recruit_shortlist.test.js`

**Interfaces:**
- Produces (`window.ttShortlist` / `module.exports`):
  - `entryId(e) -> string` — kr: `kr:{player_id}`, os: `os:{name}|{team}`
  - `sanitize(raw) -> entry|null` — 필수 `src∈{kr,os}`, `name`(비어있지 않은 문자열), kr이면 `player_id` 정수. 숫자 필드(`age,mins,goals,assists,score,fit`) 비정상은 `null`, `metrics`는 `{label:string, pct:number|null}[]` 최대 8개로 정리. 문자열 필드는 120자 컷.
  - `load(storage) -> {[team]: entry[]}` / `save(storage, all) -> boolean` — storage는 `localStorage` 호환 객체(테스트에 가짜 주입). 파손 시 `{}`.
  - `list(storage, team) -> entry[]`, `has(storage, team, id) -> boolean`
  - `add(storage, team, entry) -> "added"|"exists"|"full"|"invalid"` (`MAX = 10`)
  - `remove(storage, team, id) -> void`, `clear(storage, team) -> void`
  - `toCsv(entries) -> string` (BOM 포함), `csvCell(v) -> string`, `csvName(teamName, date) -> string`
  - `panelHtml(entries, esc) -> string` — 비면 안내 문구, kr/os 구역 분리, 각 카드 `data-sl-remove="{id}"` 빼기 버튼.
- entry 필드: `src, player_id?, name, team, league, age, mins, goals, assists, detail, score, fitLabel, fit, metrics, mode, saved`

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 storage(`{getItem,setItem}` Map 기반, `setItem` throw 버전도) 사용:
  - `entry_id`: `entryId({src:"kr",player_id:5}) === "kr:5"`, `entryId({src:"os",name:"A",team:"B"}) === "os:A|B"`
  - `sanitize_rejects`: `null`, `{src:"x",name:"a"}`, `{src:"kr",name:"a"}`(player_id 없음), `{src:"os",name:""}` → `null`
  - `sanitize_cleans`: `{src:"os",name:"A",team:"T",age:"abc",metrics:[{label:"키패스",pct:"81"},{bad:1}]}` → `age===null`, `metrics` 길이 1, `pct===81`
  - `load_corrupt`: `getItem` → `"not json"` / `"[1,2]"` / `'{"suwon":[{"src":"x"}, {"src":"os","name":"A","team":"T"}]}'` → 각각 `{}`, `{}`, `suwon` 길이 1
  - `load_storage_throws`: `getItem` throw → `{}` (예외 전파 없음)
  - `add_dedupes`: 같은 entry 두 번 → `"added"`, `"exists"`, `list` 길이 1
  - `add_caps_at_10`: 10명 뒤 11번째 → `"full"`, 길이 10
  - `add_per_team`: `suwon`에 담고 `ulsan` 목록 길이 0
  - `remove_clear`: remove 후 `has` false, clear 후 길이 0
  - `csvCell_injection`: `csvCell("=1+1") === "\"'=1+1\""`, `csvCell("@x")`, `csvCell("-3")`도 `'` 접두, `csvCell('a"b') === '"a""b"'`, `csvCell(null) === '""'`
  - `toCsv_bom_header`: 첫 글자 `"﻿"`, 첫 줄에 `구분,이름,소속,리그,나이,출전,골,도움,세부 포지션,점수 이름,점수,지표,추천 방식,담은 날짜`(각 셀 따옴표), 지표 셀 `키패스:81;태클:60`
  - `csvName`: `csvName("수원 삼성", "2026-11-24") === "영입후보_수원 삼성_20261124.csv"`, 파일명 금지문자 `/\\:*?"<>|`는 `_`
  - `panelHtml_escapes_and_splits`: name `<img src=x onerror=1>` 엔트리 → 출력에 `<img` 없음; kr·os 섞으면 `국내 후보`·`해외 후보` 둘 다, os 있을 때 안내 문구 포함; 빈 배열 → `담은 후보가 없습니다`
- [ ] **Step 2: 실패 확인** — `node --test tests/js/recruit_shortlist.test.js` → FAIL(모듈 없음)
- [ ] **Step 3: 구현** — 위 Interfaces 그대로. `save`는 try/catch로 false 반환. `panelHtml`의 `esc`는 호출부의 `ttEsc` 주입(테스트에선 같은 정의 사용). 카드: 이름·소속·리그·나이·출전·골·도움·세부 포지션·`fitLabel fit`·지표 막대(`rc-pbar` 재사용)·`담은 날짜 saved`·✕(`aria-label="후보 목록에서 빼기: {이름}"`). 하단 버튼 `data-sl-csv`, `data-sl-clear`.
- [ ] **Step 4: 통과 확인** — `node --test "tests/js/*.test.js"` → 전체 PASS
- [ ] **Step 5: 커밋** — `feat(recruit): 후보 목록 저장·CSV 로직 (recruit_shortlist.js)`

### Task 2: `recruit.js` 연결 + 로딩 + CSS

**Files:**
- Modify: `static/js/recruit.js` (needHtml·osHtml·playTable 행, controlsHtml 모드 줄, bind)
- Modify: `static/js/workspace.js:151` — `lazyLoadSeq(["recruit_shortlist", "recruit"])`
- Modify: `templates/index.html:1045` 근처 — `"recruit_shortlist": "/static/js/recruit_shortlist.js?v=1"`, `recruit.js?v=8`, `workspace.js` 버전 +1
- Modify: `static/css/style.css` (rc 블록 끝, 버전 쿼리 +1)

**Interfaces:**
- Consumes: Task 1 `window.ttShortlist` 전부.
- 행 버튼: `<button type="button" class="rc-star" data-sl-add="{idx}" data-sl-tbl="{tableKey}" aria-pressed="true|false" aria-label="후보 목록에 담기: {이름}">★|☆</button>` — 첫 `<td class="rc-rank">` 안 순번 앞.
  엔트리 원본은 표를 그릴 때 `_rows[tableKey] = entry[]`에 보관(DOM에 JSON 넣지 않음). tableKey: `pos-{group}`, `os-{group}`, `style`, `similar`.

- [ ] **Step 1: 엔트리 만들기** — `toEntry(c, src, mode, fitLabel, fit, metrics)`를 recruit.js 안에: kr은 `player_id, team, league, detail(=c.pos 또는 needs 라벨)`; os는 `league=c.league`, `detail=OS_DETAIL[c.detail]`, `score=c.raw`, `fit=c.adj`, `fitLabel="보정"`. 포지션 보강 `fitLabel="적합도"`, 플레이 보강 `"적합도"`, 비슷한 선수 `"유사도"`. `saved` = 오늘 `YYYY-MM-DD`(로컬).
- [ ] **Step 2: 행에 ☆ 버튼** — 4개 표 모두, `has()`로 ★/☆·`aria-pressed`.
- [ ] **Step 3: 모드 줄에 `후보 목록 (N)` 버튼**(`id="rc-sl-btn"`, `aria-expanded`, `aria-controls="rc-sl-panel"`) + 그 아래 `<div id="rc-sl-panel" hidden>`. N과 패널은 `refreshShortlist()` 한 함수가 갱신(팀 전환·담기·빼기·비우기 후 호출).
- [ ] **Step 4: bind 클릭 처리** — `data-sl-add`: 담김이면 remove, 아니면 add → `"full"`이면 패널 위 안내 `rc-sl-msg`(role=status) "후보는 팀당 10명까지 담을 수 있습니다"; 버튼 상태만 그 자리에서 갱신(표 재조회 없음). `data-sl-remove`·`data-sl-clear`(`confirm("이 팀 후보 목록을 모두 비울까요?")`)·`data-sl-csv`(Blob `text/csv;charset=utf-8` → `<a download>` 클릭 → `URL.revokeObjectURL`). 팀 전환 시 `refreshShortlist()`.
- [ ] **Step 5: CSS** — `.rc-star`(배경 없음, 16px 아이콘, ☆ `var(--text-muted)`, ★ 노랑 계열 대비 4.5:1, hover/active/focus-visible), `.rc-sl-btn`, `.rc-sl-panel`(카드 가로 배치 `display:flex; flex-wrap:wrap; gap`), `.rc-sl-card`(최소 폭 180px), `.rc-sl-sec h4`, `.rc-sl-note`. 375px에서 가로 넘침 없게.
- [ ] **Step 6: 확인** — `node --test "tests/js/*.test.js"` PASS · `python main.py` 띄우고 Playwright(Chromium·Firefox, 1280·375): 팀 탭 > 영입 추천 > 포지션 보강 행 ☆ → ★·N=1 · 해외 후보 열고 담기 → 패널에 해외 구역+안내 · 새로고침 후 유지 · 팀 바꾸면 N=0 · 모드 바꿔 같은 선수 ★ 유지 · CSV 다운로드 내용(BOM·헤더) · Tab/Enter만으로 담기·패널 열기·빼기 · 콘솔 에러 0 · 375 가로 스크롤 0. `python qa_check.py` 회귀 없음.
- [ ] **Step 7: 커밋** — `feat(recruit): 영입 후보 목록 — ☆ 담기·비교 패널·CSV 내보내기`
