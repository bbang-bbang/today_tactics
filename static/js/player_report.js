// player_report.js — 선수 개별 분석 보고서 (전술판 아래 섹션)

(function () {
    const section  = document.getElementById("player-report-section");
    const body     = document.getElementById("pr-body");
    const yrFilter = document.getElementById("pr-year-filter");

    let currentName = null;
    let currentYear = null;
    let radarChart    = null;
    let activityChart = null;
    let vsTeamsChart  = null;

    /* ── 이벤트 수신 ─────────────────────────────────────── */
    document.addEventListener("openPlayerReport", (e) => {
        currentName = e.detail.name;
        currentYear = null;
        load();
    });

    /* ── 데이터 로드 ─────────────────────────────────────── */
    function load() {
        if (!currentName) return;
        body.innerHTML = `<div class="pr-loading">분석 중...</div>`;
        const url = `/api/player-stat-report?name=${encodeURIComponent(currentName)}${currentYear ? `&year=${currentYear}` : ""}`;
        fetch(url)
            .then(r => r.json())
            .then(d => {
                if (!d.found) { body.innerHTML = `<div class="pr-empty">선수 데이터를 찾을 수 없습니다.</div>`; return; }
                render(d);
            })
            .catch(() => { body.innerHTML = `<div class="pr-empty">오류가 발생했습니다.</div>`; });
    }

    /* ── 렌더링 ──────────────────────────────────────────── */
    function render(d) {
        const p = d.player;
        const activity = d.activity || {};
        if (radarChart)    { radarChart.destroy();    radarChart    = null; }
        if (activityChart) { activityChart.destroy(); activityChart = null; }
        if (vsTeamsChart)  { vsTeamsChart.destroy();  vsTeamsChart  = null; }

        // 연도 필터
        const years = ["전체", ...(d.available_years || [])];
        yrFilter.innerHTML = years.map(y => {
            const active = (y === "전체" && !currentYear) || y === currentYear;
            return `<button class="pr-yr-btn${active ? " active":""}" data-y="${y}">${y}</button>`;
        }).join("");
        yrFilter.querySelectorAll(".pr-yr-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                currentYear = btn.dataset.y === "전체" ? null : btn.dataset.y;
                load();
            });
        });

        // 신체 정보 뱃지
        const posLabel = p.pos_label || p.pos || "?";
        const posColor = {GK:"#fbbf24",DF:"#4ade80",MF:"#4ea4f8",FW:"#f87171"}[posLabel] || "#9ab";
        // 세부 포지션 라벨(센터백·풀백 등) 우선 표시 — 색상은 대분류 기준 유지
        const roleLabel = p.detail_label || posLabel;
        const peerLabel = p.peer_label || posLabel;
        const heightBadge = p.height ? physBadge("키", `${p.height}cm`, p.height_rank) : "";
        const weightBadge = p.weight ? physBadge("몸무게", `${p.weight}kg`, p.weight_rank) : "";

        // 스탯 카드 (퍼센타일 바)
        const statCards = d.stat_items.map(item => statCard(item, posLabel)).join("");

        // 최근 5경기 폼 테이블
        const formCols = getFormCols(p.pos);
        const formHead = formCols.map(c => `<th>${c.label}</th>`).join("");
        const formRows = d.recent_form.map(g => {
            const resCls = g.result==="W"?"pr-res-w":g.result==="D"?"pr-res-d":"pr-res-l";
            const ha = g.is_home ? "홈" : "원정";
            const cells = formCols.map(c => `<td>${g[c.key] ?? "-"}</td>`).join("");
            return `<tr>
                <td>${g.date}</td>
                <td>${g.opponent} <span class="pr-ha">${ha}</span></td>
                <td>${g.score}</td>
                <td class="${resCls}">${g.result}</td>
                ${cells}
                <td>${g.rating ?? "-"}</td>
            </tr>`;
        }).join("");

        body.innerHTML = `
        <div class="pr-card pr-info-card">
            <div class="pr-player-header">
                <div class="pr-pos-badge" style="background:${posColor}22;border-color:${posColor}55;color:${posColor}">${roleLabel}</div>
                <div class="pr-player-name">${p.name}</div>
                <div class="pr-player-team">${p.team}</div>
                <div class="pr-info-badges">
                    <span class="pr-badge">${p.games}경기</span>
                    <span class="pr-badge pr-badge-goal">${p.goals}골</span>
                    <span class="pr-badge pr-badge-assist">${p.assists}도움</span>
                    ${p.rating ? `<span class="pr-badge pr-badge-rating">★ ${p.rating}</span>` : ""}
                    ${p.yellows ? `<span class="pr-badge">🟨${p.yellows}</span>` : ""}
                    ${p.reds    ? `<span class="pr-badge">🟥${p.reds}</span>` : ""}
                    ${heightBadge}${weightBadge}
                </div>
                <div class="pr-peer-note">동일 포지션 <b>${peerLabel}</b> ${d.peer_count}명 대비 퍼센타일</div>
            </div>
        </div>

        <div class="pr-main-grid">
            <!-- 레이더 + 스탯 가로 배치 -->
            <div class="pr-card pr-radar-card">
                <div class="pr-radar-canvas-wrap">
                    <div class="pr-section-title">종합 능력치 레이더</div>
                    <canvas id="pr-radar-canvas"></canvas>
                </div>
                <div class="pr-stats-card">
                    <div class="pr-section-title">주요 지표 퍼센타일 <span class="pr-pos-tag">${posLabel} 기준</span></div>
                    <div class="pr-stat-list">${statCards}</div>
                </div>
            </div>
        </div>

        <div class="pr-bottom-grid">
            <!-- 상대팀별 성적 (나중에 JS로 채움) -->
            <div class="pr-card pr-vs-card" id="pr-vs-teams-card">
                <div class="pr-section-title">상대팀별 성적 <span class="pr-pos-tag">평점 기준 · 높을수록 좋은 상대</span></div>
                <div class="pr-loading" style="padding:12px">불러오는 중...</div>
            </div>

            <!-- 활동량 지수 -->
            <div class="pr-card pr-activity-card">
                <div class="pr-section-title">
                    활동량 지수 <span class="pr-pos-tag">90분 환산 · 리그 전체 대비</span>
                    ${activity.score != null ? `<span class="pr-activity-score">${activity.score}<small>/100</small></span>` : ""}
                </div>
                ${activity.values && Object.keys(activity.values).length
                    ? `<div style="position:relative;height:150px"><canvas id="pr-activity-canvas"></canvas></div>`
                    : `<div class="pr-loading" style="padding:12px">경기 수 부족</div>`}
            </div>
        </div>

        <!-- 최근 폼 -->
        <div class="pr-card">
            <div class="pr-section-title">최근 5경기</div>
            <div class="pr-table-wrap">
                <table class="pr-table">
                    <thead><tr><th>날짜</th><th>상대</th><th>스코어</th><th>결과</th>${formHead}<th>평점</th></tr></thead>
                    <tbody>${formRows || `<tr><td colspan="10" style="text-align:center;color:#4a6080;padding:16px">데이터 없음</td></tr>`}</tbody>
                </table>
            </div>
        </div>
        `;

        // 레이더 차트
        renderRadar(d.radar, posLabel);
        renderActivity(activity);
        loadVsTeams(p.id);
    }

    /* ── 신체 뱃지 ───────────────────────────────────────── */
    function physBadge(label, val, rank) {
        if (!rank) return `<span class="pr-badge">${label} ${val}</span>`;
        const color = rank.pct >= 70 ? "#4ade80" : rank.pct >= 40 ? "#9ab" : "#f87171";
        return `<span class="pr-badge pr-badge-phys" title="${rank.rank}위/${rank.total}명">
            ${label} ${val} <span style="color:${color};font-size:0.7em">상위 ${100-rank.pct}%</span>
        </span>`;
    }

    /* ── 스탯 카드 ───────────────────────────────────────── */
    function statCard(item, posLabel) {
        const pct = item.pctile;
        const color = pct >= 75 ? "#4ade80" : pct >= 50 ? "#4ea4f8" : pct >= 25 ? "#fbbf24" : "#f87171";
        const grade = pct >= 90 ? "탁월" : pct >= 75 ? "우수" : pct >= 50 ? "평균이상" : pct >= 25 ? "평균이하" : "하위";
        return `<div class="pr-stat-item">
            <div class="pr-stat-label">
                <span class="pr-stat-icon">${item.icon}</span>
                <span>${item.label}</span>
                <span class="pr-stat-val">${item.val}</span>
            </div>
            <div class="pr-pct-bar-wrap">
                <div class="pr-pct-bar" style="width:${pct}%;background:${color}"></div>
            </div>
            <div class="pr-pct-info">
                <span style="color:${color}">상위 ${100 - pct}%</span>
                <span class="pr-grade" style="color:${color}">${grade}</span>
            </div>
        </div>`;
    }

    /* ── 포지션별 폼 컬럼 ────────────────────────────────── */
    function getFormCols(pos) {
        const map = {
            G: [{key:"saves",label:"선방"},{key:"aer_w",label:"공중볼"}],
            D: [{key:"tackles",label:"태클"},{key:"ints",label:"인터셉트"},{key:"clears",label:"클리어"},{key:"aer_w",label:"공중볼"}],
            M: [{key:"key_passes",label:"키패스"},{key:"goals",label:"골"},{key:"assists",label:"도움"}],
            F: [{key:"goals",label:"골"},{key:"assists",label:"도움"},{key:"sot",label:"유효슈팅"}],
        };
        return map[pos] || map["M"];
    }

    /* ── 상대팀별 성적 ───────────────────────────────────── */
    function loadVsTeams(playerId) {
        fetch(`/api/player-vs-teams?playerId=${playerId}`)
            .then(r => r.json())
            .then(data => renderVsTeams(data))
            .catch(() => {
                const card = document.getElementById("pr-vs-teams-card");
                if (card) card.querySelector(".pr-loading").textContent = "데이터 없음";
            });
    }

    function renderVsTeams(data) {
        const card = document.getElementById("pr-vs-teams-card");
        if (!card) return;
        if (!data || !data.length) {
            card.querySelector(".pr-loading").textContent = "상대팀 데이터 없음";
            return;
        }

        // 평점 기준 정렬 (없으면 GA), 최대 8팀
        const sorted = [...data]
            .filter(d => d.games >= 1)
            .sort((a, b) => (b.avg_rating || 0) - (a.avg_rating || 0))
            .slice(0, 8);

        const labels   = sorted.map(d => d.opp_name);
        const ratings  = sorted.map(d => d.avg_rating || 0);
        const gaData   = sorted.map(d => d.ga);
        const colors   = ratings.map(r => r >= 7.5 ? "rgba(74,222,128,0.8)" : r >= 7.0 ? "rgba(78,164,248,0.8)" : r >= 6.5 ? "rgba(251,191,36,0.8)" : "rgba(248,113,113,0.7)");

        // 테이블 + 차트
        const rows = sorted.map((d, i) => {
            const ratingColor = d.avg_rating >= 7.5 ? "#4ade80" : d.avg_rating >= 7.0 ? "#4ea4f8" : d.avg_rating >= 6.5 ? "#fbbf24" : "#f87171";
            return `<tr>
                <td style="color:#9ab">${d.opp_name}</td>
                <td style="text-align:center;color:#778">${d.games}</td>
                <td style="text-align:center;color:#4ade80">${d.goals}</td>
                <td style="text-align:center;color:#4ea4f8">${d.assists}</td>
                <td style="text-align:center;font-weight:700;color:${ratingColor}">${d.avg_rating ? d.avg_rating.toFixed(1) : "-"}</td>
            </tr>`;
        }).join("");

        card.innerHTML = `
        <div class="pr-section-title">상대팀별 성적 <span class="pr-pos-tag">평점 기준 · 높을수록 좋은 상대</span></div>
        <div style="position:relative;height:160px;margin-bottom:12px"><canvas id="pr-vs-chart"></canvas></div>
        <div class="pr-table-wrap">
            <table class="pr-table">
                <thead><tr><th>상대</th><th style="text-align:center">경기</th><th style="text-align:center">골</th><th style="text-align:center">도움</th><th style="text-align:center">평점</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

        const ctx = document.getElementById("pr-vs-chart");
        if (!ctx) return;
        vsTeamsChart = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "평균 평점",
                    data: ratings,
                    backgroundColor: colors,
                    borderRadius: 4,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "rgba(10,15,30,0.92)",
                        titleColor: "#c8d8f0",
                        bodyColor: "#c8d8f0",
                        callbacks: {
                            afterLabel: (item) => {
                                const d = sorted[item.dataIndex];
                                return `G+A: ${d.ga} (${d.games}경기)`;
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#778", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
                    y: {
                        min: 5.5, max: 10,
                        ticks: { color: "#778", font: { size: 10 } },
                        grid: { color: "rgba(255,255,255,0.04)" },
                        title: { display: true, text: "평균 평점", color: "#556", font: { size: 9 } }
                    }
                }
            }
        });
    }

    /* ── 활동량 차트 ─────────────────────────────────────── */
    function renderActivity(activity) {
        const ctx = document.getElementById("pr-activity-canvas");
        if (!ctx || !activity.values || !Object.keys(activity.values).length) return;

        const LABELS = {
            touches_p90:  "터치",
            duels_p90:    "듀얼",
            passes_p90:   "패스",
            def_p90:      "수비액션",
            dribbles_p90: "드리블",
        };
        const keys    = Object.keys(LABELS);
        const vals    = keys.map(k => activity.values[k] || 0);
        const avgVals = keys.map(k => activity.league_avg ? (activity.league_avg[k] || 0) : 0);

        activityChart = new Chart(ctx, {
            type: "bar",
            data: {
                labels: keys.map(k => LABELS[k]),
                datasets: [
                    {
                        label: "선수",
                        data: vals,
                        backgroundColor: "rgba(78,164,248,0.75)",
                        borderRadius: 3,
                    },
                    {
                        label: "리그평균",
                        data: avgVals,
                        backgroundColor: "rgba(255,255,255,0.1)",
                        borderColor: "rgba(255,255,255,0.3)",
                        borderWidth: 1,
                        borderRadius: 3,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: "#9ab", font: { size: 10 }, boxWidth: 10 } },
                    tooltip: {
                        backgroundColor: "rgba(10,15,30,0.92)",
                        titleColor: "#c8d8f0",
                        bodyColor: "#c8d8f0",
                        callbacks: {
                            afterLabel: (item) => {
                                if (item.datasetIndex !== 0) return "";
                                const pct = activity.percentiles ? (activity.percentiles[keys[item.dataIndex]] || 0) : 0;
                                return `상위 ${100 - pct}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#778", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
                    y: {
                        ticks: { color: "#778", font: { size: 10 } },
                        grid: { color: "rgba(255,255,255,0.04)" },
                        title: { display: true, text: "90분당", color: "#556", font: { size: 9 } }
                    }
                }
            }
        });
    }

    /* ── 레이더 차트 ─────────────────────────────────────── */
    function renderRadar(radarData, posLabel) {
        const ctx = document.getElementById("pr-radar-canvas");
        if (!ctx || !radarData.length) return;
        const color = {GK:"rgba(251,191,36,",DF:"rgba(74,222,128,",MF:"rgba(78,164,248,",FW:"rgba(248,113,113,"}[posLabel] || "rgba(78,164,248,";
        radarChart = new Chart(ctx, {
            type: "radar",
            data: {
                labels: radarData.map(r => r.label),
                datasets: [{
                    label: "퍼센타일",
                    data:  radarData.map(r => r.pctile),
                    backgroundColor: color+"0.15)",
                    borderColor:     color+"0.9)",
                    pointBackgroundColor: color+"1)",
                    pointRadius: 4,
                    borderWidth: 2,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    r: {
                        min: 0, max: 100,
                        ticks: { stepSize:25, color:"#556", font:{size:10}, backdropColor:"transparent" },
                        grid: { color:"rgba(255,255,255,0.07)" },
                        angleLines: { color:"rgba(255,255,255,0.07)" },
                        pointLabels: { color:"#9ab", font:{size:12} }
                    }
                },
                plugins: {
                    legend: { display:false },
                    tooltip: { callbacks: { label: c => ` 상위 ${100 - c.parsed.r}%` } }
                }
            }
        });
    }

    /* ── 확장 모드 토글 ────────────────────────────────── */
    const expandBtn = document.getElementById("pr-expand-btn");
    const backdrop  = document.getElementById("pr-backdrop");

    function setExpanded(on) {
        section.classList.toggle("pr-expanded", on);
        if (backdrop) backdrop.classList.toggle("active", on);
        document.body.classList.toggle("pr-expanded-lock", on);
        if (expandBtn) expandBtn.setAttribute("aria-expanded", on ? "true" : "false");
        // Chart.js가 컨테이너 크기 변화를 감지하도록 resize 이벤트 발송
        // 트랜지션 끝난 뒤 차트들 재정렬
        setTimeout(() => {
            [radarChart, activityChart, vsTeamsChart].forEach(c => { try { c && c.resize(); } catch {} });
            window.dispatchEvent(new Event("resize"));
        }, 220);
    }

    if (expandBtn) {
        expandBtn.addEventListener("click", () => {
            setExpanded(!section.classList.contains("pr-expanded"));
        });
    }
    if (backdrop) {
        backdrop.addEventListener("click", () => setExpanded(false));
    }
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && section.classList.contains("pr-expanded")) {
            setExpanded(false);
        }
    });
})();
