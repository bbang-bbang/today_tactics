// analytics.js — 단일 팀 종합 분석 대시보드
// 백엔드 3종을 오케스트레이션:
//   /api/team-analytics  : 상대팀별 전적 · 월별 승률 · 홈/원정 · 날씨별 승률 (결과 기반)
//   /api/team-trend      : 경기별 득/실/결과/누적승점 시계열
//   /api/league-rankings : 고급 11지표 + 리그 순위 (스킬 프로필 · 리그 평균 기준선)

(function () {
    const modal = document.getElementById("team-analysis-modal");
    if (!modal) return;

    const backdrop   = modal.querySelector(".modal-backdrop");
    const closeBtn   = document.getElementById("ta-close");
    const teamSelect = document.getElementById("ta-team-select");
    const yearWrap   = document.getElementById("ta-year-filter");
    const bodyEl     = document.getElementById("ta-body");
    const emptyEl    = document.getElementById("ta-empty");

    let charts = {};            // canvasId → Chart 인스턴스
    let teamsCache = null;      // /api/teams 결과
    let teamMeta = {};          // id → {name, league, emblem, primary, short}
    let currentTeamId = null;
    let currentLeague = null;
    let currentYear = "전체";

    // ── 유틸 ──────────────────────────────────────────────────────
    function destroyChart(id) {
        if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    }
    function winPct(w, g) { return g > 0 ? Math.round(w / g * 100) : 0; }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }

    // 다크 배경 가독성 보정 (팀 컬러가 너무 어두우면 밝게)
    function readableInk(hex) {
        const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex || "");
        if (!m) return "#cdd8e8";
        let r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum < 120) {
            const t = (120 - lum) / 120 * 0.7;
            r = Math.round(r + (255 - r) * t);
            g = Math.round(g + (255 - g) * t);
            b = Math.round(b + (255 - b) * t);
        }
        return `rgb(${r},${g},${b})`;
    }
    function hexToRgba(hex, a) {
        const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex || "");
        if (!m) return `rgba(120,160,255,${a})`;
        return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${a})`;
    }
    // 승률 → 색 (0%=빨강 ~ 100%=초록)
    function winColor(pct, alpha = 0.85) {
        const r = Math.round(220 - pct * 1.2);
        const g = Math.round(60 + pct * 1.6);
        return `rgba(${r},${g},80,${alpha})`;
    }

    const BASE_PLUGINS = {
        legend: { labels: { color: "#b0c4d8", font: { size: 11 }, padding: 12, usePointStyle: true, pointStyleWidth: 10 } },
        tooltip: {
            backgroundColor: "rgba(10,18,40,0.94)", borderColor: "rgba(100,160,255,0.28)",
            borderWidth: 1, titleColor: "#7eb8ff", bodyColor: "#cdd8e8", padding: 10, cornerRadius: 8,
        }
    };

    // ── 팀 셀렉트 채우기 ──────────────────────────────────────────
    function populateTeamSelect() {
        if (teamsCache) return Promise.resolve();
        return fetch("/api/teams").then(r => r.json()).then(teams => {
            teamsCache = teams;
            const grouped = { K1: [], K2: [] };
            teams.forEach(t => {
                teamMeta[t.id] = t;
                if (grouped[t.league]) grouped[t.league].push(t);
            });
            Object.values(grouped).forEach(arr => arr.sort((a, b) => a.name.localeCompare(b.name, "ko")));
            teamSelect.innerHTML = '<option value="">팀 선택…</option>';
            [["K1", "K리그1"], ["K2", "K리그2"]].forEach(([key, label]) => {
                if (!grouped[key].length) return;
                const og = document.createElement("optgroup");
                og.label = label;
                grouped[key].forEach(t => {
                    const opt = document.createElement("option");
                    opt.value = t.id; opt.textContent = t.name;
                    og.appendChild(opt);
                });
                teamSelect.appendChild(og);
            });
        });
    }

    // ── 연도 필터 ─────────────────────────────────────────────────
    function buildYearFilter(years) {
        yearWrap.innerHTML = "";
        ["전체", ...years].forEach(y => {
            const btn = document.createElement("button");
            btn.className = "year-filter-btn" + (y === currentYear ? " active" : "");
            btn.textContent = y === "전체" ? "전체" : y + "년";
            btn.dataset.year = y;
            btn.addEventListener("click", () => {
                if (currentYear === y) return;
                currentYear = y;
                yearWrap.querySelectorAll(".year-filter-btn").forEach(b => b.classList.toggle("active", b.dataset.year === y));
                if (currentTeamId) loadAll();
            });
            yearWrap.appendChild(btn);
        });
    }

    // ── 열기/닫기 ─────────────────────────────────────────────────
    document.getElementById("btn-analytics").addEventListener("click", () => {
        modal.classList.remove("hidden");
        populateTeamSelect();
    });
    // 워크스페이스 '🛡 팀' 탭에 인라인된 경우엔 닫기/Esc/백드롭으로 숨기지 않음
    // (모드 토글이 표시를 제어 — 인라인 상태에서 숨기면 빈 패널이 됨)
    const isInlined = () => !!modal.closest(".ws-panel");
    function closeModal() { if (!isInlined()) modal.classList.add("hidden"); }
    closeBtn.addEventListener("click", closeModal);
    backdrop.addEventListener("click", closeModal);
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && !modal.classList.contains("hidden") && !isInlined()) closeModal();
    });

    teamSelect.addEventListener("change", () => {
        currentTeamId = teamSelect.value || null;
        if (!currentTeamId) { bodyEl.classList.add("hidden"); emptyEl.classList.remove("hidden"); return; }
        currentLeague = (teamMeta[currentTeamId] || {}).league || "K1";
        currentYear = "전체";
        loadAll();
    });

    // ── 탭 ────────────────────────────────────────────────────────
    modal.querySelectorAll(".ta-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            modal.querySelectorAll(".ta-tab-btn").forEach(b => b.classList.remove("active"));
            modal.querySelectorAll(".ta-tab-panel").forEach(p => p.classList.add("hidden"));
            btn.classList.add("active");
            const panel = document.getElementById("ta-panel-" + btn.dataset.tab);
            if (panel) {
                panel.classList.remove("hidden");
                // 숨김 상태에서 만들어진 차트가 0px로 그려지는 문제 방지
                Object.values(charts).forEach(c => { try { c.resize(); } catch (_) {} });
            }
        });
    });

    // ── 메인 로드 ─────────────────────────────────────────────────
    function loadAll() {
        bodyEl.classList.remove("hidden");
        emptyEl.classList.add("hidden");
        const meta = teamMeta[currentTeamId] || {};
        document.getElementById("ta-team-name").textContent = "불러오는 중…";
        document.getElementById("ta-team-league").textContent = "";

        const yp = currentYear !== "전체" ? "&year=" + currentYear : "";
        Promise.all([
            fetch(`/api/team-analytics?teamId=${currentTeamId}${yp}`).then(r => r.json()),
            fetch(`/api/team-trend?teamId=${currentTeamId}${yp}`).then(r => r.json()),
            fetch(`/api/league-rankings?league=${currentLeague}${yp}`).then(r => r.json()),
        ]).then(([analytics, trend, rankings]) => {
            buildYearFilter(analytics.available_years || []);
            renderIdentity(meta, analytics, trend, rankings);
            // 결과 분석
            renderTrend(trend, meta);
            renderMargin(trend, meta);
            renderMonth(analytics.by_month || []);
            renderHomeAway(analytics.by_year_ha || {});
            renderVsOpponents(analytics.vs_opponents || []);
            renderWeather(analytics.weather || {});
            // 스킬 프로필
            renderSkill(rankings, meta);
        }).catch(err => {
            document.getElementById("ta-team-name").textContent = "데이터 로드 실패";
            console.error("[team-analysis]", err);
        });
    }

    // 리그 순위 조회 (rankings 페이로드 → {rank, total, pctl} | null)
    function leagueRank(rankings, key) {
        if (!rankings) return null;
        const me = (rankings.teams || []).find(t => t.id === currentTeamId);
        const rank = me && me.ranks ? me.ranks[key] : null;
        const total = (rankings.totals || {})[key] || 0;
        if (!rank || total < 2) return null;
        return { rank, total, pctl: Math.round((total - rank) / (total - 1) * 100) };
    }
    // 순위 → 색 (상위=초록 / 중위=노랑 / 하위=빨강)
    function rankColor(pctl) {
        return pctl >= 66 ? "#7bed9f" : pctl >= 33 ? "#ffd77a" : "#f87171";
    }
    function rankChip(r) {
        if (!r) return "";
        return `<div class="ta-stat-rank" style="color:${rankColor(r.pctl)}">리그 ${r.rank}<small>/${r.total}위</small></div>`;
    }

    // ── 아이덴티티 + 시즌 요약 ────────────────────────────────────
    function renderIdentity(meta, analytics, trend, rankings) {
        const emblem = document.getElementById("ta-emblem");
        if (meta.emblem) {
            emblem.src = `/static/img/emblems/${meta.emblem}`;
            emblem.style.display = "";
            emblem.onerror = () => { emblem.style.display = "none"; };
        } else emblem.style.display = "none";
        document.getElementById("ta-team-name").textContent = analytics.team || meta.name || "";
        const leagueLabel = meta.league === "K1" ? "K리그1" : meta.league === "K2" ? "K리그2" : (meta.league || "");
        document.getElementById("ta-team-league").textContent =
            leagueLabel + (currentYear !== "전체" ? ` · ${currentYear}` : " · 전체 시즌");

        // 시즌 누적 (trend.matches 기반 — 가장 신뢰도 높은 경기 단위)
        const ms = trend.matches || [];
        let w = 0, d = 0, l = 0, gf = 0, ga = 0;
        ms.forEach(m => {
            if (m.result === "W") w++; else if (m.result === "D") d++; else l++;
            gf += m.gf; ga += m.ga;
        });
        const g = ms.length, pts = w * 3 + d;
        const ppg = g ? (pts / g) : 0;
        // 경기당 득점/실점/폼은 리그 순위 칩으로 "전체 중 몇 위" 즉시 전달
        const summary = [
            { label: "경기", val: g, sub: "" },
            { label: "승점", val: pts, sub: `${ppg.toFixed(2)} PPG` },
            { label: "전적", val: `${w}-${d}-${l}`, sub: `승률 ${winPct(w, g)}%`, wide: true },
            { label: "득점", val: gf, sub: g ? `${(gf / g).toFixed(2)}/경기` : "", rank: leagueRank(rankings, "gf_per_game") },
            { label: "실점", val: ga, sub: g ? `${(ga / g).toFixed(2)}/경기` : "", rank: leagueRank(rankings, "ga_per_game") },
            { label: "득실차", val: (gf - ga >= 0 ? "+" : "") + (gf - ga), sub: "" },
        ];
        document.getElementById("ta-summary").innerHTML = summary.map(s => `
            <div class="ta-stat${s.wide ? " ta-stat-wide" : ""}">
                <div class="ta-stat-val">${s.val}</div>
                <div class="ta-stat-label">${s.label}</div>
                ${s.sub ? `<div class="ta-stat-sub">${s.sub}</div>` : ""}
                ${rankChip(s.rank)}
            </div>`).join("");

        // 최근 5경기 폼 (최신이 오른쪽)
        const last5 = ms.slice(-5);
        document.getElementById("ta-form").innerHTML = last5.length
            ? last5.map(m => `<span class="ta-form-pill ta-form-${m.result}" title="${m.date} vs ${m.opponent} ${m.gf}:${m.ga}">${m.result}</span>`).join("")
            : `<span class="ta-form-empty">기록 없음</span>`;
    }

    // ── 결과 ① 시즌 득/실 트렌드 + 누적 승점 ─────────────────────
    function renderTrend(trend, meta) {
        destroyChart("ta-trend");
        const el = document.getElementById("ta-trend");
        const ms = trend.matches || [];
        const scope = document.getElementById("ta-trend-scope");
        if (scope) scope.textContent = ms.length ? `${ms.length}경기` : "";
        if (!ms.length) { el.closest(".chart-wrap").innerHTML = "<p class='chart-empty'>데이터 없음</p>"; return; }
        const ink = readableInk(meta.primary || "#4ea4f8");
        const labels = ms.map((m, i) => `${i + 1}R`);
        charts["ta-trend"] = new Chart(el, {
            data: {
                labels,
                datasets: [
                    { type: "bar", label: "누적 승점", data: ms.map(m => m.cum_pts), yAxisID: "yPts",
                      backgroundColor: hexToRgba(meta.primary || "#4ea4f8", 0.18), borderRadius: 3, order: 3 },
                    { type: "line", label: "득점", data: ms.map(m => m.gf), yAxisID: "yGoals",
                      borderColor: ink, backgroundColor: ink, tension: 0.3, pointRadius: 2, borderWidth: 2.4, order: 1 },
                    { type: "line", label: "실점", data: ms.map(m => m.ga), yAxisID: "yGoals",
                      borderColor: "#f87171", backgroundColor: "#f87171", borderDash: [5, 4], tension: 0.3, pointRadius: 2, borderWidth: 2, order: 2 },
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    ...BASE_PLUGINS,
                    tooltip: {
                        ...BASE_PLUGINS.tooltip,
                        callbacks: {
                            title: items => { const m = ms[items[0].dataIndex]; return `${m.date} ${m.is_home ? "vs" : "@"} ${m.opponent}`; },
                            afterTitle: items => { const m = ms[items[0].dataIndex]; return `${m.gf}:${m.ga} (${m.result})`; },
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#7a8fa8", font: { size: 9 }, maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false } },
                    yGoals: { position: "left", beginAtZero: true, ticks: { color: "#9fb2c8", font: { size: 10 }, precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
                    yPts: { position: "right", beginAtZero: true, ticks: { color: hexToRgba(meta.primary || "#4ea4f8", 0.9), font: { size: 10 } }, grid: { display: false } },
                }
            }
        });
    }

    // ── 결과 ①-b 득실 마진 분포 (점수차별 경기 수) ───────────────
    function renderMargin(trend, meta) {
        destroyChart("ta-margin");
        const el = document.getElementById("ta-margin");
        const ms = trend.matches || [];
        const scope = document.getElementById("ta-margin-scope");
        if (!ms.length) { el.closest(".chart-wrap").innerHTML = "<p class='chart-empty'>데이터 없음</p>"; if (scope) scope.textContent = ""; return; }

        // 점수차 → 7버킷: 대승(3+) · 2점차승 · 1점차승 · 무 · 1점차패 · 2점차패 · 대패(3+)
        const labels = ["3+점차\n승", "2점차\n승", "1점차\n승", "무", "1점차\n패", "2점차\n패", "3+점차\n패"];
        const counts = [0, 0, 0, 0, 0, 0, 0];
        ms.forEach(m => {
            const d = m.gf - m.ga;
            const idx = d >= 3 ? 0 : d === 2 ? 1 : d === 1 ? 2 : d === 0 ? 3 : d === -1 ? 4 : d === -2 ? 5 : 6;
            counts[idx]++;
        });
        const colors = [
            "rgba(16,185,129,0.95)", "rgba(52,211,153,0.85)", "rgba(110,231,183,0.7)",
            "rgba(150,160,180,0.55)",
            "rgba(248,170,120,0.78)", "rgba(240,110,90,0.85)", "rgba(220,60,60,0.95)",
        ];
        const total = ms.length;
        const wins = counts[0] + counts[1] + counts[2];
        const losses = counts[4] + counts[5] + counts[6];
        const big = counts[0], narrow = counts[2];
        if (scope) {
            scope.textContent = wins >= losses
                ? (big > narrow ? "압도형 — 대승 多" : narrow >= big && narrow > 0 ? "살얼음형 — 1점차 승 多" : "")
                : (counts[6] > counts[4] ? "취약 — 대패 多" : "");
        }

        charts["ta-margin"] = new Chart(el, {
            type: "bar",
            data: {
                labels,
                datasets: [{ label: "경기 수", data: counts, backgroundColor: colors, borderRadius: 4, maxBarThickness: 44 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    ...BASE_PLUGINS, legend: { display: false },
                    tooltip: {
                        ...BASE_PLUGINS.tooltip,
                        callbacks: {
                            title: items => items[0].label.replace(/\n/g, " "),
                            label: c => `${c.parsed.y}경기 (${total ? Math.round(c.parsed.y / total * 100) : 0}%)`
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#c0d0e0", font: { size: 10 } }, grid: { display: false } },
                    y: { beginAtZero: true, ticks: { color: "#7a8fa8", font: { size: 10 }, precision: 0, stepSize: 1 }, grid: { color: "rgba(255,255,255,0.06)" } }
                }
            }
        });
    }

    // ── 결과 ② 월별 승률 ─────────────────────────────────────────
    function renderMonth(rows) {
        destroyChart("ta-month");
        const el = document.getElementById("ta-month");
        if (!rows.length) { el.closest(".chart-wrap").innerHTML = "<p class='chart-empty'>데이터 없음</p>"; return; }
        const labels = rows.map(r => r.month + "월");
        const pct = rows.map(r => winPct(r.w, r.games));
        charts["ta-month"] = new Chart(el, {
            type: "bar",
            data: {
                labels,
                datasets: [{ label: "승률", data: pct, backgroundColor: pct.map(p => winColor(p)), borderRadius: 4, maxBarThickness: 38 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    ...BASE_PLUGINS, legend: { display: false },
                    tooltip: {
                        ...BASE_PLUGINS.tooltip,
                        callbacks: {
                            label: c => `승률 ${c.parsed.y}%`,
                            afterBody: items => { const r = rows[items[0].dataIndex]; return `${r.games}경기  ${r.w}승 ${r.d}무 ${r.l}패`; }
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#c0d0e0", font: { size: 11 } }, grid: { display: false } },
                    y: { beginAtZero: true, max: 100, ticks: { color: "#7a8fa8", font: { size: 10 }, callback: v => v + "%" }, grid: { color: "rgba(255,255,255,0.06)" } }
                }
            }
        });
    }

    // ── 결과 ③ 홈/원정 성적 (연도 합산) ───────────────────────────
    function renderHomeAway(byYearHa) {
        const agg = { home: { games: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }, away: { games: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 } };
        Object.values(byYearHa).forEach(yr => {
            ["home", "away"].forEach(side => {
                if (!yr[side]) return;
                ["games", "w", "d", "l", "gf", "ga"].forEach(k => agg[side][k] += yr[side][k] || 0);
            });
        });
        const pctBadge = p => `<span class="ta-ha-pct" style="color:${p >= 50 ? '#7bed9f' : p >= 30 ? '#ffd77a' : '#f87171'}">${p}%</span>`;
        const row = (label, side) => {
            const r = agg[side];
            return `<tr>
                <td class="ta-ha-side">${label}</td>
                <td>${pctBadge(winPct(r.w, r.games))}</td>
                <td>${r.w}-${r.d}-${r.l}</td>
                <td>${r.games}</td>
                <td>${r.gf}:${r.ga}</td>
            </tr>`;
        };
        document.getElementById("ta-ha-table").innerHTML =
            `<tr><th>구분</th><th>승률</th><th>전적</th><th>경기</th><th>득실</th></tr>` +
            row("🏠 홈", "home") + row("✈ 원정", "away");
    }

    // ── 결과 ④ 상대팀별 전적 ──────────────────────────────────────
    function renderVsOpponents(rows) {
        const tbl = document.getElementById("ta-vs-table");
        if (!rows.length) { tbl.innerHTML = "<tr><td class='chart-empty'>데이터 없음</td></tr>"; return; }

        // 승률 높은 상대 → 낮은 순 (만만한 상대가 위)
        const sorted = [...rows].sort((a, b) => winPct(b.w, b.games) - winPct(a.w, a.games));

        tbl.innerHTML = `<tr><th>상대팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>득실</th><th>승률</th></tr>` +
            sorted.map(r => {
                const p = winPct(r.w, r.games);
                return `<tr>
                    <td class="ta-vs-name">${r.name}</td><td>${r.games}</td>
                    <td style="color:#7bed9f">${r.w}</td><td style="color:#aab">${r.d}</td><td style="color:#e05c5c">${r.l}</td>
                    <td>${r.gf}:${r.ga}</td>
                    <td><span class="ta-wr-badge" style="background:${winColor(p,0.22)};color:${winColor(p,1)};border:1px solid ${winColor(p,0.5)}">${p}%</span></td>
                </tr>`;
            }).join("");
    }

    // ── 결과 ⑤ 날씨별 승률 ───────────────────────────────────────
    function renderWeather(weather) {
        const groups = [
            { title: "🌡 기온", rows: weather.by_temp || [] },
            { title: "💧 습도", rows: weather.by_hum || [] },
            { title: "🌬 풍속", rows: weather.by_wind || [] },
        ];
        const host = document.getElementById("ta-weather");
        const hasAny = groups.some(g => g.rows.length);
        if (!hasAny) { host.innerHTML = "<p class='chart-empty'>날씨 표본 없음</p>"; return; }
        host.innerHTML = groups.map(g => {
            if (!g.rows.length) return "";
            const bars = g.rows.map(r => {
                const p = winPct(r.w, r.games);
                return `<div class="ta-wx-row">
                    <span class="ta-wx-label">${r.label}</span>
                    <div class="ta-wx-bar-track"><div class="ta-wx-bar" style="width:${p}%;background:${winColor(p)}"></div></div>
                    <span class="ta-wx-val">${p}% <em>(${r.w}-${r.d}-${r.l})</em></span>
                </div>`;
            }).join("");
            return `<div class="ta-wx-group"><div class="ta-wx-title">${g.title}</div>${bars}</div>`;
        }).join("");
    }

    // ── 스킬 프로필 (레이더 + 지표 바) ────────────────────────────
    function renderSkill(rankings, meta) {
        destroyChart("ta-radar");
        const metricsMeta = rankings.metrics || [];
        const teams = rankings.teams || [];
        const totals = rankings.totals || {};
        const me = teams.find(t => t.id === currentTeamId);
        const scope = document.getElementById("ta-skill-scope");
        const radarWrap = document.getElementById("ta-radar").closest(".chart-wrap");
        const barsHost = document.getElementById("ta-metric-bars");

        if (!me || !me.eligible) {
            if (scope) scope.textContent = "";
            radarWrap.innerHTML = "<p class='chart-empty'>샘플 경기 부족 — 스킬 지표 집계 제외</p>";
            barsHost.innerHTML = "";
            return;
        }
        if (scope) scope.textContent = `${currentLeague} · ${me.matches}경기`;
        if (!radarWrap.querySelector("canvas")) radarWrap.innerHTML = '<canvas id="ta-radar"></canvas>';

        // 리그 평균값 (지표별, eligible 팀)
        const leagueAvg = {};
        metricsMeta.forEach(mt => {
            const vals = teams.filter(t => t.eligible && t.values[mt.key] != null).map(t => t.values[mt.key]);
            leagueAvg[mt.key] = vals.length ? mean(vals) : null;
        });

        // 순위 → 백분위 (1위=100, 꼴찌=0)
        const pctlFromRank = (rank, total) => (total > 1 && rank) ? Math.round((total - rank) / (total - 1) * 100) : null;

        // 레이더: 팀이 순위를 가진 지표만 축으로
        const axes = metricsMeta.filter(mt => me.ranks[mt.key] && totals[mt.key] > 1);
        if (axes.length >= 3) {
            const labels = axes.map(mt => mt.label);
            const teamPctl = axes.map(mt => pctlFromRank(me.ranks[mt.key], totals[mt.key]));
            const ink = readableInk(meta.primary || "#7eb8ff");
            const el = document.getElementById("ta-radar");
            charts["ta-radar"] = new Chart(el, {
                type: "radar",
                data: {
                    labels,
                    datasets: [
                        { label: meta.short || meta.name, data: teamPctl,
                          borderColor: ink, backgroundColor: hexToRgba(meta.primary || "#7eb8ff", 0.22), pointBackgroundColor: ink,
                          pointRadius: 4, pointHoverRadius: 6, borderWidth: 2.5 },
                        { label: "리그 평균(50%)", data: axes.map(() => 50),
                          borderColor: "rgba(170,180,200,0.65)", backgroundColor: "rgba(170,180,200,0.05)",
                          pointRadius: 0, borderWidth: 1.4, borderDash: [5, 4] },
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: "#cdd8e8", font: { weight: "600" }, usePointStyle: true, padding: 12 } },
                        tooltip: {
                            ...BASE_PLUGINS.tooltip,
                            callbacks: {
                                title: items => axes[items[0].dataIndex].label,
                                label: c => {
                                    if (c.datasetIndex === 1) return "리그 평균 (50%)";
                                    const mt = axes[c.dataIndex];
                                    const v = me.values[mt.key];
                                    return `${fmtMetric(v, mt.format)} · 리그 ${me.ranks[mt.key]}위/${totals[mt.key]} (백분위 ${c.parsed.r})`;
                                }
                            }
                        }
                    },
                    scales: {
                        r: {
                            min: 0, max: 100,
                            angleLines: { color: "rgba(255,255,255,0.12)" }, grid: { color: "rgba(255,255,255,0.10)" },
                            pointLabels: { color: "#e2e8f0", font: { size: 11, weight: "700" } },
                            ticks: { color: "#9aa7bd", backdropColor: "transparent", stepSize: 25, font: { size: 9 } }
                        }
                    }
                }
            });
        } else {
            radarWrap.innerHTML = "<p class='chart-empty'>레이더 표시에 필요한 지표가 부족합니다</p>";
        }

        // 지표 바: 값 · 리그 평균 대비 · 순위 뱃지
        barsHost.innerHTML = metricsMeta.map(mt => {
            const v = me.values[mt.key];
            const rank = me.ranks[mt.key];
            const total = totals[mt.key] || 0;
            const avg = leagueAvg[mt.key];
            const pctl = pctlFromRank(rank, total);
            const avgPctl = (avg != null) ? valuePctl(avg, teams, mt) : 50;
            const barColor = pctl == null ? "rgba(120,130,150,0.5)" : winColor(pctl, 0.85);
            const rankBadge = rank
                ? `<span class="ta-rank-badge" style="color:${pctl >= 66 ? '#7bed9f' : pctl >= 33 ? '#ffd77a' : '#f87171'}">${rank}<small>/${total}</small></span>`
                : `<span class="ta-rank-badge ta-rank-na">표본부족</span>`;
            return `<div class="ta-mb-row">
                <div class="ta-mb-head">
                    <span class="ta-mb-label">${mt.label}</span>
                    <span class="ta-mb-val">${fmtMetric(v, mt.format)}</span>
                </div>
                <div class="ta-mb-track">
                    <div class="ta-mb-fill" style="width:${pctl == null ? 0 : pctl}%;background:${barColor}"></div>
                    <div class="ta-mb-avg" style="left:${avgPctl}%" title="리그 평균 ${fmtMetric(avg, mt.format)}"></div>
                </div>
                <div class="ta-mb-foot">
                    ${rankBadge}
                    <span class="ta-mb-avg-txt">리그 평균 ${fmtMetric(avg, mt.format)}</span>
                </div>
            </div>`;
        }).join("");
    }

    // 값 v의 리그 내 백분위 (방향 고려) — 평균 마커용
    function valuePctl(v, teams, mt) {
        const vals = teams.filter(t => t.eligible && t.values[mt.key] != null).map(t => t.values[mt.key]);
        const n = vals.length;
        if (n < 2) return 50;
        const higher = mt.direction === "higher";
        let worse = 0;
        vals.forEach(x => { if (higher ? x < v : x > v) worse++; });
        return clamp(Math.round(worse / (n - 1) * 100), 0, 100);
    }

    // 지표 포맷
    function fmtMetric(v, fmt) {
        if (v == null) return "—";
        switch (fmt) {
            case "ratio2": return (+v).toFixed(2);
            case "num2":   return (+v).toFixed(2);
            case "num1":   return (+v).toFixed(1);
            case "pct1":   return (+v).toFixed(1) + "%";
            default:       return String(v);
        }
    }
})();
