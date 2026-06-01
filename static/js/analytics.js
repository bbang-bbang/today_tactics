// analytics.js — 팀 분석 모달 (Chart.js 기반)

(function () {
    // ── DOM refs ──────────────────────────────────────────────────
    const modal      = document.getElementById("analytics-modal");
    const backdrop   = modal.querySelector(".modal-backdrop");
    const closeBtn   = document.getElementById("analytics-close");
    const teamSelect = document.getElementById("analytics-team-select");
    const tabBtns    = modal.querySelectorAll(".analytics-tab-btn");
    const panels     = modal.querySelectorAll(".analytics-panel");
    const titleEl    = document.getElementById("analytics-team-title");

    let charts = {};
    let currentTeamId = null;
    let currentYear = "전체";

    // ── 팀 목록 채우기 ────────────────────────────────────────────
    let teamsLoaded = false;
    function populateTeamSelect() {
        if (teamsLoaded) return;
        fetch("/api/teams").then(r => r.json()).then(teams => {
            teamsLoaded = true;
            const grouped = { K1: [], K2: [] };
            teams.forEach(t => {
                if (grouped[t.league]) grouped[t.league].push(t);
            });
            Object.values(grouped).forEach(arr =>
                arr.sort((a, b) => a.name.localeCompare(b.name, "ko"))
            );
            teamSelect.innerHTML = '<option value="">팀 선택...</option>';
            [["K1", "K리그1"], ["K2", "K리그2"]].forEach(([key, label]) => {
                if (!grouped[key].length) return;
                const og = document.createElement("optgroup");
                og.label = label;
                grouped[key].forEach(t => {
                    const opt = document.createElement("option");
                    opt.value = t.id;
                    opt.textContent = t.name;
                    og.appendChild(opt);
                });
                teamSelect.appendChild(og);
            });
        });
    }

    // ── 탭 전환 ──────────────────────────────────────────────────
    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            tabBtns.forEach(b => b.classList.remove("active"));
            panels.forEach(p => p.classList.add("hidden"));
            btn.classList.add("active");
            const panel = document.getElementById("analytics-panel-" + btn.dataset.tab);
            if (panel) panel.classList.remove("hidden");
        });
    });

    // ── 연도 필터 빌드 ────────────────────────────────────────────
    function buildYearFilter(years, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = "";
        ["전체", ...years].forEach(y => {
            const btn = document.createElement("button");
            btn.className = "year-filter-btn" + (y === currentYear ? " active" : "");
            btn.textContent = y === "전체" ? "전체" : y + "년";
            btn.dataset.year = y;
            btn.addEventListener("click", () => {
                currentYear = y;
                modal.querySelectorAll(".year-filter-btn").forEach(b => {
                    b.classList.toggle("active", b.dataset.year === y);
                });
                if (currentTeamId) loadAnalytics(currentTeamId);
            });
            container.appendChild(btn);
        });
    }

    // ── 열기 ─────────────────────────────────────────────────────
    document.getElementById("btn-analytics").addEventListener("click", () => {
        modal.classList.remove("hidden");
        populateTeamSelect();
    });

    function closeModal() { modal.classList.add("hidden"); }
    closeBtn.addEventListener("click", closeModal);
    backdrop.addEventListener("click", closeModal);

    teamSelect.addEventListener("change", () => {
        currentTeamId = teamSelect.value || null;
        currentYear = "전체";
        if (currentTeamId) loadAnalytics(currentTeamId);
    });

    function loadAnalytics(teamId) {
        titleEl.textContent = "불러오는 중...";
        const yp = currentYear !== "전체" ? "&year=" + currentYear : "";
        fetch(`/api/team-analytics?teamId=${teamId}${yp}`).then(r => r.json()).then((data) => {
            titleEl.textContent = data.team + " 분석";
            const years = data.available_years || [];
            buildYearFilter(years, "year-filter-global");
            renderVsOpponents(data.vs_opponents || []);
        });
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────
    function destroyChart(key) {
        if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    }
    function winPct(w, g) { return g > 0 ? Math.round(w / g * 100) : 0; }

    // 승률에 따른 색상 (0%=빨강 ~ 100%=초록)
    function winColor(pct, alpha = 0.85) {
        const r = Math.round(220 - pct * 1.2);
        const g = Math.round(60 + pct * 1.6);
        const b = 80;
        return `rgba(${r},${g},${b},${alpha})`;
    }

    // 캔버스 세로 그라디언트
    function vertGrad(ctx, top, bottom) {
        const grad = ctx.createLinearGradient(0, 0, 0, 300);
        grad.addColorStop(0, top);
        grad.addColorStop(1, bottom);
        return grad;
    }

    // 공통 Chart 기본 옵션
    const BASE_OPTS = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: "easeOutQuart" },
        plugins: {
            legend: {
                labels: { color: "#b0c4d8", font: { size: 11 }, padding: 14, usePointStyle: true, pointStyleWidth: 10 }
            },
            tooltip: {
                backgroundColor: "rgba(10,18,40,0.92)",
                borderColor: "rgba(100,160,255,0.25)",
                borderWidth: 1,
                titleColor: "#7eb8ff",
                bodyColor: "#cdd8e8",
                padding: 10,
                cornerRadius: 8,
            }
        }
    };

    function mergeOpts(extra) {
        return Object.assign({}, BASE_OPTS, extra,
            { plugins: Object.assign({}, BASE_OPTS.plugins, extra.plugins || {}) });
    }

    // ── 1. 상대팀별 (수평 바) ──────────────────────────────────────
    function renderVsOpponents(rows) {
        destroyChart("vs");
        const el = document.getElementById("chart-vs");
        if (!rows.length) { el.closest(".chart-wrap").innerHTML = "<p class='chart-empty'>데이터 없음</p>"; return; }

        rows = [...rows].sort((a, b) => winPct(a.w, a.games) - winPct(b.w, b.games));

        const labels  = rows.map(r => r.name);
        const wPct    = rows.map(r => winPct(r.w, r.games));
        const dPct    = rows.map(r => winPct(r.d, r.games));
        const lPct    = rows.map(r => winPct(r.l, r.games));
        const barH    = Math.max(28, Math.min(42, 360 / rows.length));

        // 차트 높이 동적 조절
        el.closest(".chart-wrap").style.height = (rows.length * barH + 60) + "px";

        charts["vs"] = new Chart(el, {
            type: "bar",
            data: {
                labels,
                datasets: [
                    { label: "승", data: wPct, backgroundColor: rows.map(r => winColor(winPct(r.w,r.games))), borderRadius: { topLeft:0, topRight:4, bottomLeft:0, bottomRight:4 }, borderSkipped: false },
                    { label: "무", data: dPct, backgroundColor: "rgba(120,130,150,0.6)", borderRadius: 0 },
                    { label: "패", data: lPct, backgroundColor: "rgba(220,70,70,0.7)", borderRadius: { topLeft:4, topRight:0, bottomLeft:4, bottomRight:0 }, borderSkipped: false },
                ]
            },
            options: mergeOpts({
                indexAxis: "y",
                plugins: {
                    tooltip: {
                        ...BASE_OPTS.plugins.tooltip,
                        callbacks: {
                            label(ctx) {
                                return ctx.dataset.label + ": " + ctx.parsed.x + "%";
                            },
                            afterBody(ctx) {
                                const r = rows[ctx[0].dataIndex];
                                return [`${r.games}경기  ${r.w}승 ${r.d}무 ${r.l}패`, `득실차: +${r.gf-r.ga} (${r.gf}득 ${r.ga}실)`];
                            }
                        }
                    }
                },
                scales: {
                    x: { stacked: true, max: 100, ticks: { color: "#7a8fa8", callback: v => v + "%", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.06)" } },
                    y: { stacked: true, ticks: { color: "#c0d0e0", font: { size: 11 } }, grid: { display: false } }
                }
            })
        });

        // 테이블
        const tbl = document.getElementById("table-vs");
        tbl.innerHTML = `<tr><th>상대팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>득</th><th>실</th><th>승률</th></tr>`;
        [...rows].reverse().forEach(r => {
            const pct = winPct(r.w, r.games);
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${r.name}</td><td>${r.games}</td>
                <td style="color:#7bed9f">${r.w}</td>
                <td style="color:#aab">${r.d}</td>
                <td style="color:#e05c5c">${r.l}</td>
                <td>${r.gf}</td><td>${r.ga}</td>
                <td><span class="wr-badge" style="background:${winColor(pct,0.25)};color:${winColor(pct,1)};border:1px solid ${winColor(pct,0.5)}">${pct}%</span></td>
            `;
            tbl.appendChild(tr);
        });
    }

})();
