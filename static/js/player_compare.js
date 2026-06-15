/* player_compare.js — 선수 vs 선수 직접 비교 모달 (K리그2)
 * window.openPlayerCompare() 진입. /api/heatmap-player-search 로 검색,
 * /api/player-stat-report 를 두 선수에 대해 호출해 헤더·레이더·지표 막대·최근폼 비교.
 * 모든 지표는 90분 환산(%는 비율). A=파랑 / B=빨강. */
(function () {
    "use strict";
    const A_COL = "#5b9bf3", B_COL = "#f0776c";
    const STATS = [
        { k: "goals", label: "득점", dec: 2 },
        { k: "assists", label: "도움", dec: 2 },
        { k: "shots", label: "슈팅", dec: 2 },
        { k: "sot", label: "유효슈팅", dec: 2 },
        { k: "key_passes", label: "키패스", dec: 2 },
        { k: "pass_pct", label: "패스 성공률", suf: "%", dec: 1 },
        { k: "drib_s", label: "드리블 성공", dec: 2 },
        { k: "drib_pct", label: "드리블 성공률", suf: "%", dec: 1 },
        { k: "tackles", label: "태클", dec: 2 },
        { k: "ints", label: "인터셉트", dec: 2 },
        { k: "clears", label: "클리어링", dec: 2 },
        { k: "aer_w", label: "공중볼 성공", dec: 2 },
        { k: "aer_pct", label: "공중볼 승률", suf: "%", dec: 1 },
        { k: "duel_pct", label: "듀얼 승률", suf: "%", dec: 1 },
        { k: "touches", label: "볼터치", dec: 1 },
    ];
    const RESULT = { W: "승", D: "무", L: "패", "?": "?" };

    const modal = document.getElementById("player-compare-modal");
    const bodyEl = document.getElementById("pc-body");
    if (!modal || !bodyEl) return;

    const sel = { a: null, b: null };       // 선택된 선수 {playerId, name, ...}
    const rep = { a: null, b: null };       // 가져온 리포트
    const _repCache = {};
    let _radar = null;

    function close() {
        modal.classList.add("hidden");
        if (_radar) { try { _radar.destroy(); } catch (_) {} _radar = null; }
    }
    modal.querySelectorAll("[data-pc-close]").forEach(el => el.addEventListener("click", close));
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
    });

    window.openPlayerCompare = function (prefill) {
        modal.classList.remove("hidden");
        if (prefill && prefill.playerId && !sel.a) pick("a", prefill);
        renderBody();
    };

    const launch = document.getElementById("btn-player-compare");
    if (launch) launch.addEventListener("click", () => window.openPlayerCompare());

    // ── 검색 ──────────────────────────────────────────────
    modal.querySelectorAll(".pc-pick").forEach(pickEl => {
        const slot = pickEl.dataset.slot;
        const input = pickEl.querySelector(".pc-search");
        const results = pickEl.querySelector(".pc-results");
        let timer = null;
        input.addEventListener("input", () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (q.length < 1) { results.classList.add("hidden"); results.innerHTML = ""; return; }
            timer = setTimeout(() => doSearch(q, results, slot), 220);
        });
        input.addEventListener("focus", () => { if (results.innerHTML) results.classList.remove("hidden"); });
        document.addEventListener("click", e => { if (!pickEl.contains(e.target)) results.classList.add("hidden"); });
    });

    async function doSearch(q, results, slot) {
        let list = [];
        try {
            const r = await fetch("/api/heatmap-player-search?q=" + encodeURIComponent(q));
            list = await r.json();                                    // K1+K2 (상세 스탯은 각 리그 내에서 계산)
        } catch (_) { list = []; }
        if (!list.length) {
            results.innerHTML = '<div class="pc-res-empty">선수 검색 결과 없음</div>';
            results.classList.remove("hidden"); return;
        }
        results.innerHTML = list.slice(0, 12).map(p =>
            `<button type="button" class="pc-res" data-pid="${p.playerId}">
                <span class="pc-res-name">${p.name} <em class="pc-lg pc-lg-${p.league}">${p.league === "k1" ? "K1" : "K2"}</em></span>
                <span class="pc-res-meta">${p.teamShort || p.teamName || ""}${p.detailLabel ? " · " + p.detailLabel : (p.position ? " · " + p.position : "")} · ${p.games}경기</span>
            </button>`).join("");
        results.classList.remove("hidden");
        results.querySelectorAll(".pc-res").forEach(btn => {
            btn.addEventListener("click", () => {
                const p = list.find(x => String(x.playerId) === btn.dataset.pid);
                results.classList.add("hidden");
                pickEl(slot).querySelector(".pc-search").value = p.name;
                pick(slot, p);
            });
        });
    }
    const pickEl = slot => modal.querySelector(`.pc-pick[data-slot="${slot}"]`);

    async function pick(slot, p) {
        sel[slot] = p; rep[slot] = null;
        renderBody();   // 로딩 표시
        let data = _repCache[p.playerId];
        if (!data) {
            try {
                const r = await fetch("/api/player-stat-report?playerId=" + encodeURIComponent(p.playerId));
                data = await r.json();
                _repCache[p.playerId] = data;
            } catch (_) { data = { found: false }; }
        }
        rep[slot] = data;
        renderBody();
    }

    // ── 렌더 ──────────────────────────────────────────────
    function renderBody() {
        if (!sel.a && !sel.b) {
            bodyEl.innerHTML = '<div class="pc-empty">두 선수를 검색해 선택하면 90분 환산 지표·레이더·최근 폼을 나란히 비교합니다.</div>';
            return;
        }
        const ra = rep.a, rb = rep.b;
        const loadingA = sel.a && !ra, loadingB = sel.b && !rb;
        if (loadingA || loadingB) {
            bodyEl.innerHTML = '<div class="pc-empty">⏳ 선수 데이터 불러오는 중…</div>';
            return;
        }
        const okA = ra && ra.found, okB = rb && rb.found;
        // 한 명만 선택됐거나 데이터 없음 처리
        const warn = [];
        if (sel.a && !okA) warn.push(`${sel.a.name}: K리그2 상세 스탯 없음`);
        if (sel.b && !okB) warn.push(`${sel.b.name}: K리그2 상세 스탯 없음`);

        let html = "";
        // 헤더 카드 2개
        html += `<div class="pc-cards">${headerCard(okA ? ra : null, sel.a, A_COL)}${headerCard(okB ? rb : null, sel.b, B_COL)}</div>`;
        if (warn.length) html += `<div class="pc-warn">⚠ ${warn.join(" · ")}</div>`;

        if (okA && okB) {
            const crossLg = ra.player.league && rb.player.league && ra.player.league !== rb.player.league;
            const radarSub = crossLg
                ? "백분위는 <b>각자 자기 리그·포지션 내</b> 기준(K1↔K2 교차 비교는 참고용)"
                : "리그 백분위(각 포지션 내) · 100=리그 1위";
            html += `<div class="pc-section">
                        <div class="pc-sec-title">📡 레이더 <span class="pc-sec-sub">${radarSub}</span></div>
                        <div class="pc-radar-wrap"><canvas id="pc-radar"></canvas></div>
                     </div>`;
            html += `<div class="pc-section">
                        <div class="pc-sec-title">📊 지표 비교 <span class="pc-sec-sub">90분 환산 · %는 비율 · 굵게=우위</span></div>
                        ${statBars(ra, rb)}
                     </div>`;
            html += `<div class="pc-section">
                        <div class="pc-sec-title">📋 최근 5경기</div>
                        <div class="pc-form-duo">${formCol(ra, A_COL)}${formCol(rb, B_COL)}</div>
                     </div>`;
        }
        bodyEl.innerHTML = html;
        if (okA && okB) drawRadar(ra, rb);
    }

    function headerCard(r, selp, col) {
        if (!selp) return `<div class="pc-card pc-card-empty">선수 미선택</div>`;
        if (!r) return `<div class="pc-card"><div class="pc-card-name" style="color:${col}">${selp.name}</div>
            <div class="pc-card-warn">K리그2 상세 스탯 없음</div></div>`;
        const p = r.player;
        const lg = p.league ? `<em class="pc-lg pc-lg-${p.league.toLowerCase()}">${p.league}</em>` : "";
        const posTxt = (p.detail_label || p.pos_label || "") + (p.team ? " · " + p.team : "");
        const kpi = (v, l) => `<div class="pc-kpi"><div class="pc-kpi-v">${v}</div><div class="pc-kpi-l">${l}</div></div>`;
        return `<div class="pc-card" style="border-top:3px solid ${col}">
            <div class="pc-card-name" style="color:${col}">${p.name} ${lg}</div>
            <div class="pc-card-meta">${posTxt}</div>
            <div class="pc-kpis">
                ${kpi(p.games, "경기")}${kpi(p.goals, "골")}${kpi(p.assists, "도움")}
                ${kpi(p.rating != null ? p.rating : "—", "평점")}
            </div></div>`;
    }

    function statBars(ra, rb) {
        const A = ra.all_stats || {}, B = rb.all_stats || {};
        return STATS.map(s => {
            const a = +A[s.k] || 0, b = +B[s.k] || 0, tot = a + b;
            const ap = tot ? Math.round(a / tot * 100) : 50;
            const aWin = a > b, bWin = b > a;
            const fv = v => (s.dec ? v.toFixed(s.dec) : v) + (s.suf || "");
            return `<div class="pc-bar-row">
                <span class="pc-bar-v ${aWin ? "win" : ""}" style="${aWin ? "color:" + A_COL : ""}">${fv(a)}</span>
                <div class="pc-bar-mid">
                    <div class="pc-bar-label">${s.label}</div>
                    <div class="pc-bar-track">
                        <span class="pc-bar-a" style="width:${ap}%;background:${A_COL}"></span>
                        <span class="pc-bar-b" style="width:${100 - ap}%;background:${B_COL}"></span>
                    </div>
                </div>
                <span class="pc-bar-v ${bWin ? "win" : ""}" style="${bWin ? "color:" + B_COL : ""}">${fv(b)}</span>
            </div>`;
        }).join("");
    }

    function radarAxes(ra, rb) {
        const gk = ra.player.pos === "G" || rb.player.pos === "G";
        return gk
            ? [["saves", "선방"], ["aer_pct", "공중볼%"], ["pass_pct", "패스%"], ["touches", "터치"], ["duel_pct", "듀얼%"]]
            : [["goals", "득점"], ["key_passes", "키패스"], ["drib_s", "드리블"], ["tackles", "태클"], ["aer_pct", "공중볼%"], ["pass_pct", "패스%"]];
    }

    function drawRadar(ra, rb) {
        const el = document.getElementById("pc-radar");
        if (!el || typeof Chart === "undefined") return;
        const axes = radarAxes(ra, rb);
        const pa = ra.all_pctiles || {}, pb = rb.all_pctiles || {};
        if (_radar) { try { _radar.destroy(); } catch (_) {} }
        _radar = new Chart(el, {
            type: "radar",
            data: {
                labels: axes.map(x => x[1]),
                datasets: [
                    { label: ra.player.name, data: axes.map(x => pa[x[0]] != null ? pa[x[0]] : 50),
                      borderColor: A_COL, backgroundColor: A_COL + "33", pointBackgroundColor: A_COL,
                      borderWidth: 2.3, pointRadius: 3.5 },
                    { label: rb.player.name, data: axes.map(x => pb[x[0]] != null ? pb[x[0]] : 50),
                      borderColor: B_COL, backgroundColor: B_COL + "2e", pointBackgroundColor: B_COL,
                      borderWidth: 2.3, pointRadius: 3.5 },
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    r: { min: 0, max: 100, ticks: { stepSize: 25, color: "#7c8a99", backdropColor: "transparent" },
                         grid: { color: "rgba(255,255,255,0.10)" }, angleLines: { color: "rgba(255,255,255,0.10)" },
                         pointLabels: { color: "#cdd8e8", font: { size: 12, weight: "600" } } }
                },
                plugins: {
                    legend: { labels: { color: "#cdd8e8", usePointStyle: true, padding: 14 } },
                    tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.r}%ile` } }
                }
            }
        });
    }

    function formCol(r, col) {
        const f = r.recent_form || [];
        const rows = f.length ? f.map(m => {
            const rc = m.result || "?";
            return `<div class="pc-form-row">
                <span class="pc-form-res pc-res-${rc}">${RESULT[rc] || "?"}</span>
                <span class="pc-form-opp">${m.is_home ? "vs" : "@"} ${m.opponent}</span>
                <span class="pc-form-line">${m.goals ? "⚽" + m.goals : ""}${m.assists ? " 🎨" + m.assists : ""}</span>
                <span class="pc-form-rating">${m.rating != null ? m.rating : "—"}</span>
            </div>`;
        }).join("") : '<div class="pc-form-empty">최근 경기 없음</div>';
        return `<div class="pc-form-col">
            <div class="pc-form-cap" style="color:${col}">${r.player.name}</div>${rows}</div>`;
    }
})();
