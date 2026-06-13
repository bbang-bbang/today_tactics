// workspace.js — 상위 작업공간 탭 컨트롤러 (전술판 / 경기예측 / 팀 / 선수)
//
// 설계: 기존 DOM(섹션·모달)을 appendChild로 각 탭 패널에 "재배치"한다.
// 노드를 옮겨도 id·이벤트 리스너가 보존되므로 각 모듈의 렌더 로직은 손대지 않는다.
// 모달은 패널 안에서 CSS로 정적 블록화(.ws-panel .modal). 탭이 보일 때
// 캔버스/차트를 리사이즈해 display:none→표시 전환 시 깨짐을 막는다.
//
// 이 스크립트는 모든 모듈 스크립트 "뒤"에 로드되어야 한다(노드 이동 시점 = 초기화 후).
(function () {
    "use strict";
    const $ = (id) => document.getElementById(id);

    const panels = {
        tactics: $("ws-tactics"),
        predict: $("ws-predict"),
        team:    $("ws-team"),
        player:  $("ws-player"),
        heatmap: $("ws-heatmap"),
        global:  $("ws-global"),
    };
    if (!panels.tactics) return; // 셸 미존재 시 무동작(레거시 안전)

    // ── 1) 기존 요소를 탭 패널로 재배치 (id/리스너 보존) ──────────────
    const move = (name, ids) => ids.forEach((id) => {
        const el = $(id);
        if (el && panels[name]) panels[name].appendChild(el);
    });
    // #main-row = 캔버스(#main-area) + 선수 개별분석(#player-report-section) 묶음 → 전술판 탭
    move("tactics", ["main-row"]);
    move("predict", ["prediction-section"]);
    // 팀 탭: 단일 팀 분석(team-analysis-modal) + 팀 비교(team-compare-modal) — 모드 토글로 전환
    move("team",    ["team-analysis-modal", "team-compare-modal"]);
    move("player",  ["insights-section"]);
    move("heatmap", ["k2-heatmap-modal"]);

    // 비워진 구조 래퍼(#board-report-wrap)는 박스를 생성하지 않도록 처리(잔여 여백 제거)
    const _wrap = $("board-report-wrap");
    if (_wrap) _wrap.style.display = "contents";

    // ── 2) 차트 일괄 리사이즈 (Chart.js v4 전역 레지스트리 활용) ───────
    function resizeChartsIn(panel) {
        if (!panel || !window.Chart || !window.Chart.getChart) return;
        panel.querySelectorAll("canvas").forEach((cv) => {
            const c = window.Chart.getChart(cv);
            if (c) { try { c.resize(); } catch (e) { /* noop */ } }
        });
    }

    // ── 3) 팀 탭 모드 토글 (단일 팀 분석 ↔ 팀 비교) ──────────────────
    // 인라인된 두 모달을 모드에 따라 보이기/숨기기. 최초 노출 시 기존 트리거를
    // 1회 click 해 셀렉트/렌더를 초기화(각 모듈 로직 그대로 재사용).
    let _teamMode = "analysis";
    let _analysisInit = false, _compareInit = false;
    function setTeamMode(mode) {
        _teamMode = mode;
        document.querySelectorAll("#ws-team .ws-team-mode").forEach((b) => {
            const on = b.dataset.tmode === mode;
            b.classList.toggle("active", on);
            b.setAttribute("aria-selected", on ? "true" : "false");
        });
        const ana = $("team-analysis-modal"), cmp = $("team-compare-modal");
        if (mode === "compare") {
            if (ana) ana.classList.add("hidden");
            if (cmp) {
                if (!_compareInit) { _compareInit = true; const c = $("btn-team-compare"); if (c) c.click(); }
                else cmp.classList.remove("hidden");
            }
        } else {
            if (cmp) cmp.classList.add("hidden");
            if (ana) {
                if (!_analysisInit) { _analysisInit = true; const a = $("btn-analytics"); if (a) a.click(); }
                else ana.classList.remove("hidden");
            }
        }
        requestAnimationFrame(() => resizeChartsIn(panels.team));
    }
    document.querySelectorAll("#ws-team .ws-team-mode").forEach((b) => {
        b.addEventListener("click", () => setTeamMode(b.dataset.tmode));
    });

    // ── 4) 탭별 onShow 훅 ────────────────────────────────────────────
    const onShow = {
        tactics() {
            // 전술판 캔버스는 컨테이너 가시성에 의존 → 보일 때 재계산
            if (window.__ttResize) requestAnimationFrame(() => window.__ttResize());
        },
        predict() {
            requestAnimationFrame(() => resizeChartsIn(panels.predict));
        },
        team() {
            setTeamMode(_teamMode);   // 현재 모드 콘텐츠 노출 + 최초 1회 초기화
        },
        player() {
            requestAnimationFrame(() => resizeChartsIn(panels.player));
        },
        heatmap() {
            // 인라인 히트맵 뷰 최초 노출 시 초기화(팀 그리드 로드 + 검색 포커스)
            if (window.initK2HeatmapView) window.initK2HeatmapView();
        },
        global() {
            if (window.initGlobalLeagueView) window.initGlobalLeagueView();
        },
    };

    // ── 4) 탭 전환 ───────────────────────────────────────────────────
    let _current = "tactics";
    function switchWorkspace(name) {
        if (!panels[name]) return;
        _current = name;
        Object.entries(panels).forEach(([k, p]) => {
            if (p) p.classList.toggle("hidden", k !== name);
        });
        document.querySelectorAll("#workspace-tabs .ws-tab").forEach((b) => {
            const on = b.dataset.ws === name;
            b.classList.toggle("active", on);
            b.setAttribute("aria-selected", on ? "true" : "false");
            b.tabIndex = on ? 0 : -1;
        });
        if (onShow[name]) onShow[name]();
    }
    window.switchWorkspace = switchWorkspace;

    // ── 5) 탭바 인터랙션 (클릭 + 좌우 화살표 키보드 탐색) ─────────────
    const tabEls = [...document.querySelectorAll("#workspace-tabs .ws-tab")];
    tabEls.forEach((b) => {
        b.addEventListener("click", () => switchWorkspace(b.dataset.ws));
        b.addEventListener("keydown", (e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const i = tabEls.indexOf(b);
            const n = (i + (e.key === "ArrowRight" ? 1 : tabEls.length - 1)) % tabEls.length;
            tabEls[n].focus();
            switchWorkspace(tabEls[n].dataset.ws);
        });
    });

    // ── 6) 매치 선택 스트립 접기 (PM 권고: 선택 후 공간 회복) ─────────
    const stripToggle = $("match-strip-toggle");
    const COLLAPSE_KEY = "tt_match_strip_collapsed";
    function setStripCollapsed(on) {
        document.body.classList.toggle("match-strip-collapsed", on);
        if (stripToggle) {
            stripToggle.setAttribute("aria-expanded", on ? "false" : "true");
            stripToggle.textContent = on ? "▾ 매치 선택 펼치기" : "▴ 접기";
        }
        try { localStorage.setItem(COLLAPSE_KEY, on ? "1" : "0"); } catch (e) { /* noop */ }
    }
    if (stripToggle) {
        stripToggle.addEventListener("click", () =>
            setStripCollapsed(!document.body.classList.contains("match-strip-collapsed")));
    }
    // 매치 카드 클릭 시 자동 접기
    const schedWrap = $("league-schedule-wrap");
    if (schedWrap) {
        schedWrap.addEventListener("click", (e) => {
            if (e.target.closest(".kmc, .km-card, .match-card, [data-match-id], [data-home]")) {
                setStripCollapsed(true);
            }
        });
    }
    try { if (localStorage.getItem(COLLAPSE_KEY) === "1") setStripCollapsed(true); } catch (e) { /* noop */ }

    // ── 7) 안전망: 캔버스 컨테이너 크기 변화 시 재계산 ────────────────
    const cc = $("canvas-container");
    if (cc && window.ResizeObserver) {
        new ResizeObserver(() => {
            if (_current === "tactics" && window.__ttResize) window.__ttResize();
        }).observe(cc);
    }

    // ── 8) 기본 탭 = 전술판 (캔버스 정상 init 보장) ──────────────────
    switchWorkspace("tactics");
})();
