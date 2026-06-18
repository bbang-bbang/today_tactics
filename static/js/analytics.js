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
    let _shotmapData = { for: null, against: null };   // 슛맵 캐시 (토글 재렌더용)
    let _shotmapSide = "for";
    let _shotFilter = { goal: true, save: true, post: true, block: true, miss: true };  // 결과별 표시 필터

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
                // 숨김 상태에서 만들어진 차트가 0px로 그려지는 문제 방지.
                // hidden 해제 직후 동기 resize는 reflow 전이라 컨테이너 높이를 0으로 읽음
                // → rAF로 레이아웃 반영 후 resize (특히 스킬 레이더가 height:0로 안 보이던 버그).
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    Object.values(charts).forEach(c => { try { c.resize(); } catch (_) {} });
                }));
            }
        });
    });

    // 슛맵 공격/수비 토글
    modal.querySelectorAll(".ta-sm-side").forEach(btn => {
        btn.addEventListener("click", () => {
            modal.querySelectorAll(".ta-sm-side").forEach(b => b.classList.toggle("active", b === btn));
            _shotmapSide = btn.dataset.side;
            renderShotmap();
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
            fetch(`/api/team-insights?teamId=${currentTeamId}${yp}`).then(r => r.json()).catch(e => ({ __err: "심화 인사이트", _e: e })),
            fetch(`/api/team-shape?teamId=${currentTeamId}${yp}`).then(r => r.json()).catch(e => ({ __err: "팀 형태", _e: e })),
            fetch(`/api/team-shotmap?teamId=${currentTeamId}&side=for${yp}`).then(r => r.json()).catch(e => ({ __err: "슛맵(공격)", _e: e })),
            fetch(`/api/team-shotmap?teamId=${currentTeamId}&side=against${yp}`).then(r => r.json()).catch(e => ({ __err: "슛맵(수비)", _e: e })),
        ]).then(([analytics, trend, rankings, insights, shape, smFor, smAgainst]) => {
            // 선택 데이터 로드 실패 가시화: 빈 결과("데이터 없음")와 "불러오기 실패"를 구분 (P5 견고성)
            const failed = [insights, shape, smFor, smAgainst].filter(x => x && x.__err);
            if (failed.length) {
                failed.forEach(x => console.warn("[team-analysis] 로드 실패:", x.__err, x._e));
                if (window.showToast) window.showToast(`일부 분석 데이터를 불러오지 못했습니다: ${failed.map(x => x.__err).join(", ")} (새로고침 해보세요)`);
            }
            buildYearFilter(analytics.available_years || []);
            renderIdentity(meta, analytics, trend, rankings);
            // 결과 분석
            renderTrend(trend, meta);
            renderMargin(trend, meta);
            renderMonth(analytics.by_month || []);
            renderHomeAway(analytics.by_year_ha || {});
            renderVsOpponents(analytics.vs_opponents || []);
            renderWeather(analytics.weather || {});
            // 심화 인사이트
            renderInsights(insights, meta);
            // 팀 형태
            renderShape(shape, meta);
            // 슛맵
            _shotmapData = { for: smFor, against: smAgainst };
            renderShotmap();
            // 스카우팅 리포트 (형태+슛맵 조합)
            renderScout(shape, smFor, smAgainst, meta);
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
        const MIN = 4;   // 이 미만 월은 표본 부족 → 막대 회색(승률 신뢰도 낮음 표시)
        const labels = rows.map(r => r.month + "월");
        const pct = rows.map(r => winPct(r.w, r.games));
        const colors = rows.map(r => r.games < MIN ? "rgba(120,134,153,0.55)" : winColor(winPct(r.w, r.games)));
        charts["ta-month"] = new Chart(el, {
            type: "bar",
            data: {
                labels,
                datasets: [{ label: "승률", data: pct, backgroundColor: colors, borderRadius: 4, maxBarThickness: 38 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    ...BASE_PLUGINS, legend: { display: false },
                    tooltip: {
                        ...BASE_PLUGINS.tooltip,
                        callbacks: {
                            label: c => `승률 ${c.parsed.y}%`,
                            afterBody: items => { const r = rows[items[0].dataIndex]; return `${r.games}경기  ${r.w}승 ${r.d}무 ${r.l}패` + (r.games < MIN ? "  ⚠표본 적음" : ""); }
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

        const MIN = 4;   // 이 미만 상대는 승률 신뢰도 낮음 → 후순위 + 배지 약화
        // 표본 충분한 상대를 승률순으로 먼저, 소표본 상대는 아래로(1경기 100% 같은 착시 방지)
        const sorted = [...rows].sort((a, b) => {
            const ae = a.games >= MIN, be = b.games >= MIN;
            if (ae !== be) return ae ? -1 : 1;
            return winPct(b.w, b.games) - winPct(a.w, a.games);
        });

        let anyLow = false;
        tbl.innerHTML = `<tr><th>상대팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>득실</th><th>승률</th></tr>` +
            sorted.map(r => {
                const p = winPct(r.w, r.games);
                const low = r.games < MIN;
                if (low) anyLow = true;
                const badge = low
                    ? `<span class="ta-wr-badge ta-wr-low" title="표본 ${r.games}경기 — 참고용">${p}%</span>`
                    : `<span class="ta-wr-badge" style="background:${winColor(p,0.22)};color:${winColor(p,1)};border:1px solid ${winColor(p,0.5)}">${p}%</span>`;
                return `<tr>
                    <td class="ta-vs-name">${r.name}</td><td>${r.games}</td>
                    <td style="color:#7bed9f">${r.w}</td><td style="color:#aab">${r.d}</td><td style="color:#e05c5c">${r.l}</td>
                    <td>${r.gf}:${r.ga}</td>
                    <td>${badge}</td>
                </tr>`;
            }).join("")
            + (anyLow ? `<tr class="ta-vs-note"><td colspan="7">⚠ <b>${MIN}경기 미만</b> 상대의 승률은 표본이 적어 흐리게 표시·후순위 정렬 (전적 W-D-L을 우선 참고)</td></tr>` : "");
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
        const MIN = 4;   // 이 미만 구간은 승률 신뢰도 낮음(표본 부족) → 약화 표시
        let anyLow = false;
        const body = groups.map(g => {
            if (!g.rows.length) return "";
            const bars = g.rows.map(r => {
                const p = winPct(r.w, r.games);
                const low = r.games < MIN;
                if (low) anyLow = true;
                // 표본 부족: 막대 회색 + 승률 흐리게 + 경기수만 강조(수치 오해 방지)
                const val = low
                    ? `<span class="ta-wx-faint">${p}%</span> <em>${r.games}경기</em>`
                    : `${p}% <em>(${r.w}-${r.d}-${r.l})</em>`;
                return `<div class="ta-wx-row${low ? " ta-wx-low" : ""}">
                    <span class="ta-wx-label">${r.label}</span>
                    <div class="ta-wx-bar-track"><div class="ta-wx-bar" style="width:${p}%;background:${low ? "#566072" : winColor(p)}"></div></div>
                    <span class="ta-wx-val">${val}</span>
                </div>`;
            }).join("");
            return `<div class="ta-wx-group"><div class="ta-wx-title">${g.title}</div>${bars}</div>`;
        }).join("");
        host.innerHTML = body + (anyLow
            ? `<p class="tc-hint">⚠ <b>${MIN}경기 미만</b> 구간은 표본이 적어 승률을 참고용(흐리게·경기수만)으로 표시 — 시즌이 진행될수록 정확해집니다.</p>`
            : "");
    }

    // ══ 심화 인사이트 ═══════════════════════════════════════════════
    function renderInsights(ins, meta) {
        ins = ins || {};
        renderGoalTiming(ins.goal_timing || {}, meta);
        renderFirstGoal(ins.first_goal || {});
        renderXgCumulative(ins.xg_cumulative || [], meta, ins.xg_coverage);
        renderScorers(ins.scorers || [], meta);
    }

    const TIMING_LABELS = ["0-15", "16-30", "31-45", "46-60", "61-75", "76+"];

    // ① 득점·실점 시간대 (15분 × 6버킷)
    function renderGoalTiming(gt, meta) {
        destroyChart("ta-timing");
        const el = document.getElementById("ta-timing");
        const forA = gt.for || [], agA = gt.against || [];
        if (!gt.total) { el.closest(".chart-wrap").innerHTML = "<p class='chart-empty'>골 데이터 없음</p>"; return; }
        const ink = readableInk(meta.primary || "#4ea4f8");
        charts["ta-timing"] = new Chart(el, {
            type: "bar",
            data: {
                labels: TIMING_LABELS,
                datasets: [
                    { label: "득점", data: forA, backgroundColor: "rgba(52,211,153,0.85)", borderRadius: 3, maxBarThickness: 26 },
                    { label: "실점", data: agA, backgroundColor: "rgba(240,90,80,0.8)", borderRadius: 3, maxBarThickness: 26 },
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    ...BASE_PLUGINS,
                    tooltip: { ...BASE_PLUGINS.tooltip, callbacks: { title: items => items[0].label + "분", label: c => `${c.dataset.label} ${c.parsed.y}골` } }
                },
                scales: {
                    x: { ticks: { color: "#c0d0e0", font: { size: 10 } }, grid: { display: false } },
                    y: { beginAtZero: true, ticks: { color: "#7a8fa8", font: { size: 10 }, precision: 0, stepSize: 1 }, grid: { color: "rgba(255,255,255,0.06)" } }
                }
            }
        });
    }

    // ② 선제골 영향 (선제 득점 시 / 선제 실점 시 → W/D/L)
    function renderFirstGoal(fg) {
        destroyChart("ta-firstgoal");
        const el = document.getElementById("ta-firstgoal");
        const s = fg.scored || { w: 0, d: 0, l: 0 }, c = fg.conceded || { w: 0, d: 0, l: 0 };
        const totalN = s.w + s.d + s.l + c.w + c.d + c.l;
        if (!totalN) { el.closest(".chart-wrap").innerHTML = "<p class='chart-empty'>선제골 데이터 없음</p>"; return; }
        const rowsFG = [
            { idx: 0, w: s.w, g: s.w + s.d + s.l },
            { idx: 1, w: c.w, g: c.w + c.d + c.l },
        ];
        // 막대 끝에 승률 % 라벨 (외부 플러그인 없이 인라인)
        const winLabelPlugin = {
            id: "fgWinLabel",
            afterDatasetsDraw(chart) {
                const { ctx, scales: { x, y } } = chart;
                ctx.save();
                ctx.font = "800 12px 'Pretendard', system-ui, sans-serif";
                ctx.textBaseline = "middle";
                rowsFG.forEach(r => {
                    if (!r.g) return;
                    const pct = Math.round(r.w / r.g * 100);
                    ctx.fillStyle = pct >= 50 ? "#7bed9f" : pct >= 30 ? "#ffd77a" : "#f87171";
                    ctx.fillText(`승률 ${pct}%`, x.getPixelForValue(r.g) + 8, y.getPixelForValue(r.idx));
                });
                ctx.restore();
            }
        };
        charts["ta-firstgoal"] = new Chart(el, {
            type: "bar",
            data: {
                labels: ["선제 득점 시", "선제 실점 시"],
                datasets: [
                    { label: "승", data: [s.w, c.w], backgroundColor: "rgba(52,211,153,0.88)" },
                    { label: "무", data: [s.d, c.d], backgroundColor: "rgba(150,160,180,0.6)" },
                    { label: "패", data: [s.l, c.l], backgroundColor: "rgba(240,90,80,0.82)" },
                ]
            },
            plugins: [winLabelPlugin],
            options: {
                indexAxis: "y", responsive: true, maintainAspectRatio: false,
                layout: { padding: { right: 56 } },   // 승률 라벨 공간 확보
                plugins: {
                    ...BASE_PLUGINS,
                    tooltip: {
                        ...BASE_PLUGINS.tooltip,
                        callbacks: {
                            label: c => `${c.dataset.label} ${c.parsed.x}경기`,
                            afterBody: items => {
                                const col = items[0].dataIndex === 0 ? s : c;
                                const g = col.w + col.d + col.l;
                                return g ? `승률 ${Math.round(col.w / g * 100)}%` : "";
                            }
                        }
                    }
                },
                scales: {
                    x: { stacked: true, beginAtZero: true, ticks: { color: "#7a8fa8", font: { size: 10 }, precision: 0, stepSize: 1 }, grid: { color: "rgba(255,255,255,0.06)" } },
                    y: { stacked: true, ticks: { color: "#c0d0e0", font: { size: 11 } }, grid: { display: false } }
                }
            }
        });
    }

    // ③ xG vs 실제 득점 (누적 라인)
    function renderXgCumulative(rows, meta, cov) {
        destroyChart("ta-xg");
        const el = document.getElementById("ta-xg");
        const scope = document.getElementById("ta-xg-scope");
        if (!rows.length) { el.closest(".chart-wrap").innerHTML = "<p class='chart-empty'>xG 데이터 없음</p>"; if (scope) scope.textContent = ""; return; }
        const last = rows[rows.length - 1];
        const diff = (last.goals - last.xg);
        if (scope) {
            let txt = `실득점 ${last.goals} vs xG ${last.xg.toFixed(1)} (${diff >= 0 ? "+" : ""}${diff.toFixed(1)})`;
            // xG 커버리지: 일부 경기 xG 미집계 시 비교가 과소평가됨을 명시 (분석 신뢰도)
            if (cov && cov.total) {
                const pct = Math.round(cov.with_xg / cov.total * 100);
                txt += (cov.with_xg < cov.total)
                    ? `  ·  ⚠ xG ${cov.with_xg}/${cov.total}경기(${pct}%) 기준 — 나머지 경기는 xG 미집계로 누적 xG가 실제보다 낮음`
                    : `  ·  xG 전 ${cov.total}경기 집계`;
            }
            scope.textContent = txt;
        }
        const ink = readableInk(meta.primary || "#34d399");
        charts["ta-xg"] = new Chart(el, {
            data: {
                labels: rows.map(r => `${r.i}R`),
                datasets: [
                    { type: "line", label: "실제 득점(누적)", data: rows.map(r => r.goals), borderColor: ink, backgroundColor: ink, tension: 0.25, pointRadius: 0, borderWidth: 2.6 },
                    { type: "line", label: "xG(누적)", data: rows.map(r => r.xg), borderColor: "#fbbf24", backgroundColor: "rgba(251,191,36,0.12)", borderDash: [5, 4], tension: 0.25, pointRadius: 0, borderWidth: 2, fill: false },
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    ...BASE_PLUGINS,
                    tooltip: { ...BASE_PLUGINS.tooltip, callbacks: { label: c => `${c.dataset.label}: ${(+c.parsed.y).toFixed(1)}` } }
                },
                scales: {
                    x: { ticks: { color: "#7a8fa8", font: { size: 9 }, maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false } },
                    y: { beginAtZero: true, ticks: { color: "#9fb2c8", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.06)" } }
                }
            }
        });
    }

    // ④ 득점 기여 분포 (선수별 득점+도움, 가로 스택)
    function renderScorers(rows, meta) {
        destroyChart("ta-scorers");
        const wrap = document.getElementById("ta-scorers-wrap");
        if (!rows.length) { wrap.innerHTML = "<p class='chart-empty'>득점 기록 없음</p>"; return; }
        if (!wrap.querySelector("canvas")) wrap.innerHTML = '<canvas id="ta-scorers"></canvas>';
        const el = document.getElementById("ta-scorers");
        const barH = clamp(220 / rows.length, 20, 34);
        wrap.style.height = (rows.length * barH + 46) + "px";
        const ink = readableInk(meta.primary || "#a78bfa");
        charts["ta-scorers"] = new Chart(el, {
            type: "bar",
            data: {
                labels: rows.map(r => r.name),
                datasets: [
                    { label: "득점", data: rows.map(r => r.g), backgroundColor: hexToRgba(meta.primary || "#a78bfa", 0.92) },
                    { label: "도움", data: rows.map(r => r.a), backgroundColor: hexToRgba(meta.primary || "#a78bfa", 0.4) },
                ]
            },
            options: {
                indexAxis: "y", responsive: true, maintainAspectRatio: false,
                plugins: {
                    ...BASE_PLUGINS,
                    tooltip: { ...BASE_PLUGINS.tooltip, callbacks: { label: c => `${c.dataset.label} ${c.parsed.x}`, afterBody: items => { const r = rows[items[0].dataIndex]; return `공격P ${r.g + r.a}`; } } }
                },
                scales: {
                    x: { stacked: true, beginAtZero: true, ticks: { color: "#7a8fa8", font: { size: 10 }, precision: 0, stepSize: 1 }, grid: { color: "rgba(255,255,255,0.06)" } },
                    y: { stacked: true, ticks: { color: "#dbe4f0", font: { size: 11, weight: "600" } }, grid: { display: false } }
                }
            }
        });
    }

    // ── 팀 형태 (평균 진형 피치 + 지표) ───────────────────────────
    const SHAPE_LINE_COLOR = { G: "#fbbf24", D: "#34d399", M: "#60a5fa", F: "#f87171" };
    function renderShape(shape, meta) {
        const cv = document.getElementById("ta-shape-pitch");
        const metricsEl = document.getElementById("ta-shape-metrics");
        const scope = document.getElementById("ta-shape-scope");
        if (!cv) return;
        const nodes = (shape && shape.nodes) || [];
        if (scope) scope.textContent = shape && shape.samples
            ? `${shape.year} · 표본 ${shape.samples}명 / ${shape.games}경기` : "데이터 없음";

        const ctx = cv.getContext("2d");
        const W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);
        // 잔디 + 라인
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, "#13401a"); g.addColorStop(1, "#185020");
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1.5;
        const PAD = 14;
        ctx.strokeRect(PAD, PAD, W - 2 * PAD, H - 2 * PAD);
        ctx.beginPath(); ctx.moveTo(W / 2, PAD); ctx.lineTo(W / 2, H - PAD); ctx.stroke();
        ctx.beginPath(); ctx.arc(W / 2, H / 2, 42, 0, Math.PI * 2); ctx.stroke();
        const boxH = H * 0.55, boxW = 64;
        ctx.strokeRect(PAD, (H - boxH) / 2, boxW, boxH);
        ctx.strokeRect(W - PAD - boxW, (H - boxH) / 2, boxW, boxH);

        if (!nodes.length) {
            ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "13px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("이 시즌 평균 위치 데이터가 없습니다", W / 2, H / 2);
            if (metricsEl) metricsEl.innerHTML = '<p class="tc-hint">데이터 없음</p>';
            return;
        }
        // x(0~100, 공격→오른쪽) → 캔버스 가로, y(0~100) → 세로
        const fx = v => PAD + (v / 100) * (W - 2 * PAD);
        const fy = v => PAD + (v / 100) * (H - 2 * PAD);
        nodes.forEach(n => {
            const x = fx(n.x), y = fy(n.y), col = SHAPE_LINE_COLOR[n.line] || "#cbd5e1";
            ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
            ctx.fillStyle = col; ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 1.5; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = "600 10.5px sans-serif"; ctx.textAlign = "center";
            const short = (n.name || "").split(" ").pop().slice(0, 4);
            ctx.fillText(short, x, y - 14);
        });

        // 지표 카드 (리그 평균 대비)
        if (metricsEl) {
            const m = (shape && shape.metrics) || {}, lg = (shape && shape.league) || {};
            const card = (label, key, unit, hint, hiGood) => {
                const v = m[key], l = lg[key];
                if (v == null) return "";
                let diff = "", cls = "";
                if (l != null) {
                    const d = Math.round((v - l) * 10) / 10;
                    if (d !== 0) {
                        const up = d > 0;
                        // hiGood=true면 높을수록 진함(초록), null이면 중립
                        cls = hiGood == null ? "" : ((up === hiGood) ? "ta-shape-pos" : "ta-shape-neg");
                        diff = `<span class="ta-shape-diff ${cls}">${up ? "▲" : "▼"} ${Math.abs(d)}</span>`;
                    }
                    diff += `<span class="ta-shape-lg">리그 ${l}</span>`;
                }
                return `<div class="ta-shape-card"><div class="ta-shape-k">${label}</div>
                    <div class="ta-shape-v">${v}${unit || ""}</div><div class="ta-shape-cmp">${diff}</div>
                    <div class="ta-shape-h">${hint}</div></div>`;
            };
            metricsEl.innerHTML =
                card("무게중심 높이", "centroidX", "", "팀 전체 평균 전진도", null) +
                card("수비라인", "defLine", "", "수비 평균 위치", null) +
                card("공격라인", "fwdLine", "", "공격 평균 위치", null) +
                card("팀 길이", "length", "", "공격~수비 간격(압축도)", false) +
                card("팀 폭", "width", "", "좌우 전개 폭", null);
        }
    }

    // ── 슛맵 (xG 버블 + 필터 + 요약) ──────────────────────────────
    const SHOT_COLOR = { goal: "#22c55e", save: "#60a5fa", post: "#a78bfa", block: "#f59e0b", miss: "#94a3b8" };
    const SHOT_LABEL = { goal: "골", save: "유효(선방)", post: "골대", block: "차단", miss: "빗나감" };
    const SHOT_ORDER = ["goal", "save", "post", "block", "miss"];
    function renderShotmap() {
        const cv = document.getElementById("ta-shotmap-canvas");
        const sumEl = document.getElementById("ta-shotmap-summary");
        const extraEl = document.getElementById("ta-shotmap-extra");
        const legEl = document.getElementById("ta-shotmap-legend");
        if (!cv) return;
        const data = _shotmapData[_shotmapSide] || {};
        const allShots = data.shots || [];
        const m = data.summary || {};
        const isFor = _shotmapSide === "for";
        const shots = allShots.filter(s => _shotFilter[s.outcome] !== false);

        const ctx = cv.getContext("2d");
        const W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#163d1c"; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1.5;
        ctx.strokeRect(8, 8, W - 16, H - 16);
        const cy = H / 2;
        ctx.strokeRect(W - 8 - 150, cy - 110, 150, 220);
        ctx.strokeRect(W - 8 - 55, cy - 55, 55, 110);
        ctx.beginPath(); ctx.arc(W - 8 - 100, cy, 2.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(W - 9, cy - 26); ctx.lineTo(W - 9, cy + 26); ctx.stroke();

        const XCAP = 50, PAD = 10;
        const fx = v => (W - 10) - (Math.min(v, XCAP) / XCAP) * (W - 20 - PAD);
        const fy = v => PAD + (v / 100) * (H - 2 * PAD);
        const order = { goal: 3, save: 2, post: 1 };
        [...shots].sort((a, b) => (order[a.outcome] || 0) - (order[b.outcome] || 0)).forEach(s => {
            const r = Math.max(3, Math.min(15, 3 + Math.sqrt(s.xg) * 22));
            ctx.beginPath(); ctx.arc(fx(s.x), fy(s.y), r, 0, Math.PI * 2);
            const col = SHOT_COLOR[s.outcome] || "#94a3b8";
            ctx.fillStyle = (s.outcome === "goal") ? col : col + "cc";
            ctx.fill();
            if (s.outcome === "goal") { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
        });
        if (!allShots.length) {
            ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "13px sans-serif"; ctx.textAlign = "center";
            ctx.fillText("이 시즌 슛 데이터가 없습니다", W / 2, cy);
        }

        // 결과별 필터 칩 (클릭 토글, 개수 표시)
        if (legEl) {
            const oc = m.outcomes || {};
            legEl.innerHTML = SHOT_ORDER.map(k =>
                `<button type="button" class="ta-sm-chip${_shotFilter[k] === false ? " off" : ""}" data-oc="${k}" aria-pressed="${_shotFilter[k] !== false}">
                    <i style="background:${SHOT_COLOR[k]}"></i>${SHOT_LABEL[k]} <b>${oc[k] || 0}</b></button>`
            ).join("");
            legEl.querySelectorAll(".ta-sm-chip").forEach(btn => {
                btn.addEventListener("click", () => {
                    const k = btn.dataset.oc;
                    _shotFilter[k] = _shotFilter[k] === false;  // 토글
                    renderShotmap();
                });
            });
        }

        const repEl = document.getElementById("ta-shotmap-report");
        if (sumEl) {
            if (!allShots.length) {
                sumEl.innerHTML = '<p class="tc-hint">데이터 없음</p>';
                if (extraEl) extraEl.innerHTML = "";
                if (repEl) repEl.innerHTML = "";
                return;
            }
            const fin = m.xgDiff;
            const good = isFor ? fin > 0 : fin < 0;
            const finCls = fin === 0 ? "" : (good ? "ta-shape-pos" : "ta-shape-neg");
            const stat = (label, value, sub, cls = "") => `<div class="ta-sm-stat">
                <div class="ta-sm-stat-label">${label}</div>
                <div class="ta-sm-stat-val ${cls}">${value}</div>
                <div class="ta-sm-stat-sub">${sub}</div></div>`;
            const ot = (m.outcomes || {});
            const lg = m.league || {};
            // 리그 평균 대비 (for=높을수록 좋음, against=낮을수록 좋음)
            const cmp = (v, lv, hiGood) => {
                if (lv == null) return "";
                const d = Math.round((v - lv) * 100) / 100;
                if (d === 0) return `리그 평균 ${lv}`;
                const up = d > 0, good = hiGood ? up : !up;
                return `<span class="${good ? "ta-shape-pos" : "ta-shape-neg"}">${up ? "▲" : "▼"}${Math.abs(d)}</span> vs 리그 ${lv}`;
            };
            sumEl.innerHTML =
                stat(isFor ? "경기당 슈팅" : "경기당 피슈팅", m.perGame, cmp(m.perGame, lg.perGame, isFor)) +
                stat(isFor ? "경기당 득점" : "경기당 실점", m.gpgPerGame, cmp(m.gpgPerGame, lg.gpgPerGame, isFor)) +
                stat(isFor ? "경기당 xG" : "경기당 피xG", m.xgPerGame, cmp(m.xgPerGame, lg.xgPerGame, isFor)) +
                stat("유효슛", m.onTargetPct + "%", `골+선방 ${(ot.goal || 0) + (ot.save || 0)}/${m.shots}`) +
                stat(isFor ? "결정력" : "실점 효율", `${fin > 0 ? "+" : ""}${fin}`, isFor ? "골 − xG(누적)" : "실점 − xG(누적)", finCls);

            if (extraEl) {
                const hidden = allShots.length - shots.length;
                const verdict = isFor
                    ? (fin >= 1 ? "기대(xG)보다 잘 마무리 — 결정력 우위" : fin <= -1 ? "기대(xG) 대비 마무리가 아쉬움 (찬스 대비 적은 득점)" : "기대치만큼 마무리")
                    : (fin <= -1 ? "실점이 xG보다 적음 — 골키퍼·수비 선전(또는 운)" : fin >= 1 ? "xG보다 많이 실점 — 수비 위기관리 과제" : "기대치만큼 실점");
                extraEl.innerHTML =
                    `<div class="ta-sm-verdict">💡 ${verdict}</div>` +
                    (hidden > 0 ? `<div class="ta-sm-note">지도에서 ${hidden}개 슛 숨김 (필터) — 요약·리포트는 전체 기준</div>` : "");
            }
        }

        // 상세 리포트 (지역·상황·부위·슈터)
        if (repEl) {
            const rep = data.report || {};
            if (!allShots.length) { repEl.innerHTML = ""; }
            else {
                const barSection = (title, items, useName) => {
                    if (!items || !items.length) return "";
                    const max = Math.max(...items.map(i => i.shots), 1);
                    const rows = items.map(i => {
                        const w = Math.round(i.shots / max * 100);
                        const gw = i.shots ? Math.round(i.goals / i.shots * 100) : 0;
                        const label = useName ? i.name : i.label;
                        return `<div class="ta-sm-bar-row">
                            <span class="ta-sm-bar-label" title="${label}">${label}</span>
                            <span class="ta-sm-bar-track"><span class="ta-sm-bar-fill" style="width:${w}%"><span class="ta-sm-bar-goal" style="width:${gw}%"></span></span></span>
                            <span class="ta-sm-bar-num">${i.shots}슛${i.goals ? ` · <b>${i.goals}골</b>` : ""} · xG ${i.xg}</span></div>`;
                    }).join("");
                    return `<div class="ta-sm-rep-block"><div class="ta-sm-rep-title">${title}</div>${rows}</div>`;
                };
                repEl.innerHTML =
                    barSection("📍 지역별 (박스 안/밖)", rep.byZone) +
                    barSection("🎬 상황별", rep.bySituation) +
                    barSection("🦶 슈팅 부위", rep.byBody) +
                    barSection(isFor ? "👟 슈터 TOP" : "🥅 실점 허용 상대 TOP", rep.topShooters, true);
            }
        }
    }

    // ── 상대 스카우팅 리포트 (형태 + 슛맵 for/against 자동 조합) ──────
    const SET_LABELS = ["코너", "프리킥", "세트피스", "페널티"];
    const LVL_W = { high: 3, med: 2, low: 1 };
    function renderScout(shape, smFor, smAgainst, meta) {
        const host = document.getElementById("ta-scout");
        if (!host) return;
        const M = (shape && shape.metrics) || {}, LG = (shape && shape.league) || {};
        const F = (smFor && smFor.summary) || {}, A = (smAgainst && smAgainst.summary) || {};
        const Frep = (smFor && smFor.report) || {}, Arep = (smAgainst && smAgainst.report) || {};
        const FL = F.league || {}, AL = A.league || {};
        const name = (meta && (meta.short || meta.name)) || (shape && shape.team) || "이 팀";

        const hasData = (smFor && (smFor.shots || []).length) ||
                        (smAgainst && (smAgainst.shots || []).length) ||
                        (shape && (shape.nodes || []).length);
        if (!hasData) {
            host.innerHTML = '<div class="tc-panel"><p class="tc-hint">스카우팅 리포트를 만들 슛맵·형태 데이터가 부족합니다 (이 시즌 표본 없음).</p></div>';
            return;
        }
        const pctDev = (v, lv) => (lv ? (v - lv) / lv : 0);   // 리그 평균 대비 비율 편차

        // 게임플랜 도출용 플래그
        const flag = { highLine: false, lowBlock: false, wide: false, narrow: false,
                       setThreat: false, setWeak: false, boxWeak: false,
                       highFire: false, lowShotVol: false, clinical: false };

        // ── 헤드라인 태그 ──
        const idTags = [];
        if (M.defLine != null && LG.defLine != null) {
            const d = Math.round((M.defLine - LG.defLine) * 10) / 10;
            if (d >= 2) { idTags.push("높은 라인"); flag.highLine = true; }
            else if (d <= -2) { idTags.push("낮은 블록"); flag.lowBlock = true; }
        }
        if (M.width != null && LG.width != null) {
            const d = M.width - LG.width;
            if (d >= 3) { idTags.push("넓은 측면 전개"); flag.wide = true; }
            else if (d <= -3) { idTags.push("중앙 집중"); flag.narrow = true; }
        }
        if (F.xgPerGame != null && FL.xgPerGame) {
            const p = pctDev(F.xgPerGame, FL.xgPerGame);
            if (p >= 0.12) { idTags.push("화력 상위"); flag.highFire = true; }
            else if (p <= -0.12) idTags.push("공격 빈곤");
        }
        if (A.xgPerGame != null && AL.xgPerGame) {
            const p = pctDev(A.xgPerGame, AL.xgPerGame);
            if (p >= 0.12) idTags.push("수비 불안");
            else if (p <= -0.12) idTags.push("수비 견고");
        }

        // ── 경계할 점 (상대 강점) — smFor + 공격 형태 ──
        const threats = [];
        const topF = (Frep.topShooters || [])[0];
        if (topF && topF.shots) threats.push({
            lvl: topF.goals >= 5 ? "high" : topF.goals >= 2 ? "med" : "low",
            text: `핵심 슈터 <b>${topF.name}</b> — ${topF.shots}슛 ${topF.goals}골 (xG ${topF.xg})`,
            tag: topF.goals >= 5 ? "집중 마크" : topF.goals >= 2 ? "주시" : "",
        });
        const routeF = (Frep.bySituation || []).filter(s => s.goals > 0).sort((a, b) => b.goals - a.goals)[0];
        if (routeF) {
            const isSet = SET_LABELS.includes(routeF.label);
            if (isSet && routeF.goals >= 2) flag.setThreat = true;
            threats.push({
                lvl: routeF.goals >= 4 ? "high" : "med",
                text: `주 득점 루트 <b>${routeF.label}</b> — ${routeF.goals}골 / ${routeF.shots}슛`,
                tag: isSet ? "세트피스 경계" : "",
            });
        }
        if (F.xgPerGame != null && FL.xgPerGame) {
            const p = pctDev(F.xgPerGame, FL.xgPerGame);
            if (p >= 0.1) threats.push({
                lvl: p >= 0.2 ? "high" : "med",
                text: `경기당 기대득점 <b>${F.xgPerGame}</b> (리그 ${FL.xgPerGame}) — 리그 평균 이상 화력`,
                tag: p >= 0.2 ? "화력 상위" : "",
            });
        }
        if (F.xgDiff != null && F.xgDiff >= 2) { flag.clinical = true; threats.push({
            lvl: "med",
            text: `마무리 효율 높음 — 실제 골이 xG보다 <b>+${F.xgDiff}</b> (적은 찬스도 골로)`, tag: "",
        }); }
        const boxF = (Frep.byZone || []).find(z => z.label === "박스 안");
        if (boxF && boxF.goals >= 4) threats.push({
            lvl: boxF.goals >= 8 ? "high" : "med",
            text: `박스 안 득점 ${boxF.goals} — 침투·크로스 마무리 활발`, tag: "",
        });

        // ── 공략 포인트 (상대 약점) — smAgainst + 수비 형태 ──
        const weak = [];
        if (A.perGame != null && AL.perGame) {
            const p = pctDev(A.perGame, AL.perGame);
            if (p >= 0.08) { flag.lowShotVol = false; weak.push({
                lvl: p >= 0.2 ? "high" : "med",
                text: `경기당 피슈팅 <b>${A.perGame}회</b> 허용 (리그 ${AL.perGame}) — 슛 기회를 많이 내줌`,
                tag: "슛 적극",
            }); }
        }
        const routeA = (Arep.bySituation || []).filter(s => s.goals > 0).sort((a, b) => b.goals - a.goals)[0];
        if (routeA) {
            const isSet = SET_LABELS.includes(routeA.label);
            if (isSet && routeA.goals >= 2) flag.setWeak = true;
            weak.push({
                lvl: routeA.goals >= 4 ? "high" : "med",
                text: `실점 多 상황 <b>${routeA.label}</b> — ${routeA.goals}실점`,
                tag: isSet ? "세트피스 기회" : "",
            });
        }
        const boxA = (Arep.byZone || []).find(z => z.label === "박스 안");
        if (boxA && boxA.goals >= 3) { flag.boxWeak = true; weak.push({
            lvl: boxA.goals >= 6 ? "high" : "med",
            text: `박스 안 실점 ${boxA.goals} — 침투·크로스 마무리에 취약`, tag: "박스 침투",
        }); }
        if (A.xgDiff != null && A.xgDiff >= 1) weak.push({
            lvl: "med",
            text: `xG보다 많이 실점 (+${A.xgDiff}) — 수비 위기관리 불안`, tag: "",
        });
        if (flag.highLine) weak.push({
            lvl: "high",
            text: `높은 수비라인 (리그 +${Math.round((M.defLine - LG.defLine) * 10) / 10}) — 배후 공간 노릴 수 있음`,
            tag: "배후 침투",
        });
        else if (flag.lowBlock) weak.push({
            lvl: "med",
            text: `낮은 블록 — 측면 폭·중거리로 끌어내 공략`, tag: "측면/중거리",
        });

        threats.sort((a, b) => LVL_W[b.lvl] - LVL_W[a.lvl]);
        weak.sort((a, b) => LVL_W[b.lvl] - LVL_W[a.lvl]);

        // ── 게임플랜 ──
        const plan = [];
        if (flag.highLine) plan.push("수비 배후로 빠른 스루패스·역습 — 라인 뒤 공간을 1순위로 공략");
        else if (flag.lowBlock) plan.push("낮은 블록 상대 — 측면 폭을 넓혀 끌어내고 중거리·세컨볼로 균열 만들기");
        if (flag.setWeak) plan.push("세트피스 공격 기회 多 — 코너·프리킥 루틴을 미리 준비");
        if (flag.setThreat) plan.push("상대 세트피스 경계 — 박스 안 마크 정리 + 세컨볼 차단");
        if (flag.boxWeak) plan.push("박스 안 침투·크로스로 마무리 기회를 늘려라");
        if (flag.highFire) plan.push("상대 화력 상위 — 볼 점유로 상대 공격 빈도를 줄이고 역습 차단 우선");
        if (flag.clinical) plan.push("상대는 적은 찬스도 골로 연결 — 결정적 기회 자체를 내주지 말 것");
        if (flag.wide) plan.push("측면 의존도 높음 — 풀백·윙 견제로 크로스 차단");

        // ── 렌더 ──
        const headline = idTags.length ? idTags.join(" · ") : "표본 기준 뚜렷한 스타일 특징은 약함";
        const bullet = (b, kind) => `<div class="scout-bullet kind-${kind} lvl-${b.lvl}">
            <span class="scout-dot"></span>
            <span class="scout-text">${b.text}</span>
            ${b.tag ? `<span class="scout-tag">${b.tag}</span>` : ""}</div>`;
        host.innerHTML =
            `<div class="tc-panel scout-head" style="--tc-accent:#f59e0b">
                <p class="tc-panel-label" style="margin:0 0 6px">🎯 ${name} 스카우팅 요약</p>
                <div class="scout-headline">${headline}</div>
                <p class="tc-hint" style="margin:6px 0 0">${(shape && shape.year) || ""} · 공격 ${F.games || 0}경기 / 수비 ${A.games || 0}경기(슛맵 보유 기준) · 리그 평균 대비 자동 분석</p>
            </div>
            <div class="scout-cols">
                <div class="tc-panel" style="--tc-accent:#f87171">
                    <p class="tc-panel-label">⚠️ 경계할 점 <span class="scout-sub">상대 강점</span></p>
                    ${threats.slice(0, 5).map(b => bullet(b, "threat")).join("") || '<p class="tc-hint">뚜렷한 위협 패턴 없음</p>'}
                </div>
                <div class="tc-panel" style="--tc-accent:#22c55e">
                    <p class="tc-panel-label">🎯 공략 포인트 <span class="scout-sub">상대 약점</span></p>
                    ${weak.slice(0, 5).map(b => bullet(b, "opp")).join("") || '<p class="tc-hint">뚜렷한 약점 패턴 없음</p>'}
                </div>
            </div>
            <div class="tc-panel" style="--tc-accent:#60a5fa">
                <p class="tc-panel-label">📝 권장 대응 <span class="scout-sub">게임플랜</span></p>
                ${plan.length ? `<ul class="scout-plan">${plan.slice(0, 4).map(p => `<li>${p}</li>`).join("")}</ul>`
                    : '<p class="tc-hint">데이터 기반 제안 생성 조건 미충족 (표본 부족)</p>'}
            </div>`;
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
