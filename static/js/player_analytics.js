// player_analytics.js — 선수 개인 분석 보고서 모달

(function () {
    const modal   = document.getElementById("player-analytics-modal");
    const overlay = modal.querySelector(".pa-overlay");
    const closeBtn = modal.querySelector(".pa-close");

    let radarChart = null;
    let monthChart = null;
    let trendChart = null;
    let currentPlayerId = null;

    // ── 모달 열기/닫기 ──────────────────────────────────────────
    document.addEventListener("playerSelected", (e) => {
        if (!e.detail) return;
        currentPlayerId = e.detail.playerId;
        modal.classList.remove("hidden");
        loadData(e.detail.playerId, null);
    });

    overlay.addEventListener("click", closeModal);
    closeBtn.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    function closeModal() {
        modal.classList.add("hidden");
        destroyCharts();
    }

    // ── 데이터 로딩 ──────────────────────────────────────────────
    function loadData(playerId, year) {
        const url = `/api/player-analytics?playerId=${playerId}${year ? `&year=${year}` : ""}`;
        modal.querySelector(".pa-body-inner").innerHTML = `
            <div class="pa-loading-skeleton">
                <div class="skeleton pa-skel-row w80"></div>
                <div class="skeleton pa-skel-row w60"></div>
                <div class="skeleton pa-skel-chart"></div>
                <div class="skeleton pa-skel-row w40"></div>
                <div class="skeleton pa-skel-chart"></div>
            </div>`;
        fetch(url)
            .then(r => r.json())
            .then(data => render(data, playerId, year))
            .catch(() => {
                modal.querySelector(".pa-body-inner").innerHTML = `<div class="pa-loading">데이터를 불러올 수 없습니다.</div>`;
            });
    }

    // ── 렌더링 ───────────────────────────────────────────────────
    function render(d, playerId, activeYear) {
        destroyCharts();
        const { info, available_years, season_summary, monthly, recent_form, radar, activity, trend } = d;
        const leagueLabel = d.league === "K1" ? "K리그1" : "K리그2";

        const posLabel = { "G": "GK", "D": "DF", "M": "MF", "F": "FW" }[info.position] || info.position;
        const ratingHtml = info.rating ? `<span class="pa-pill pa-pill-rating">${info.rating.toFixed(2)} ★</span>` : "";
        const footHtml   = info.preferred_foot ? `<span class="pa-pill">${info.preferred_foot === "right" ? "오른발" : info.preferred_foot === "left" ? "왼발" : "양발"}</span>` : "";
        const heightHtml = info.height ? `<span class="pa-pill">${info.height}cm</span>` : "";

        const yearBtns = ["전체", ...available_years].map(y => {
            const sel = (y === "전체" && !activeYear) || y === activeYear;
            return `<button class="pa-year-btn${sel ? " active" : ""}" data-year="${y}">${y}</button>`;
        }).join("");

        // 시즌별 요약 rows
        const ssRows = season_summary.map(s => `
            <tr>
                <td>${s.year}</td>
                <td>${s.games}</td>
                <td>${s.goals}</td>
                <td>${s.assists}</td>
                <td>${s.rating ? s.rating.toFixed(2) : "-"}</td>
                <td>${s.minutes ? Math.round(s.minutes / 90 * 10) / 10 + "시간" : "-"}</td>
            </tr>`).join("");

        // 최근 폼 rows
        const formRows = recent_form.map(g => {
            const resCls = g.result === "W" ? "pa-res-w" : g.result === "D" ? "pa-res-d" : "pa-res-l";
            const ha = g.is_home ? "홈" : "원정";
            const ga = g.goals > 0 || g.assists > 0 ? `${g.goals}G ${g.assists}A` : "-";
            const rat = g.rating ? g.rating.toFixed(1) : "-";
            return `<tr>
                <td>${g.date}</td>
                <td>${g.opponent} <span class="pa-ha">${ha}</span></td>
                <td>${g.score}</td>
                <td class="${resCls}">${g.result}</td>
                <td>${ga}</td>
                <td>${rat}</td>
            </tr>`;
        }).join("");

        modal.querySelector(".pa-body-inner").innerHTML = `
        <div class="pa-header">
            <div class="pa-name-area">
                <span class="pa-pos-badge">${posLabel}</span>
                <span class="pa-player-name">${info.name}</span>
                <span class="pa-team-name">${info.team}</span>
            </div>
            <div class="pa-pills">
                ${heightHtml}${footHtml}
                <span class="pa-pill pa-pill-games">${info.games}경기</span>
                <span class="pa-pill pa-pill-goals">${info.goals}골</span>
                <span class="pa-pill pa-pill-assists">${info.assists}도움</span>
                ${ratingHtml}
                <span class="pa-pill">${Math.round((info.minutes||0)/60)}분 출전</span>
                ${info.yellow_cards ? `<span class="pa-pill pa-pill-yellow">🟨 ${info.yellow_cards}</span>` : ""}
                ${info.red_cards    ? `<span class="pa-pill pa-pill-red">🟥 ${info.red_cards}</span>` : ""}
            </div>
            <div class="pa-year-filter">${yearBtns}</div>
        </div>

        <div class="pa-charts-row">
            <!-- 레이더 차트 -->
            <div class="pa-radar-wrap">
                <div class="pa-section-title">포지션 레이더 <span class="pa-sub">(${leagueLabel} 전체 선수 대비 백분위)</span></div>
                <canvas id="chart-pa-radar"></canvas>
            </div>

            <!-- 최근 폼 -->
            <div class="pa-form-wrap">
                <div class="pa-section-title">최근 경기 기록</div>
                ${recent_form.length ? `
                <table class="pa-table">
                    <thead><tr><th>날짜</th><th>상대</th><th>스코어</th><th>결과</th><th>G/A</th><th>평점</th></tr></thead>
                    <tbody>${formRows}</tbody>
                </table>` : `<div class="pa-empty">경기 기록 없음</div>`}
            </div>
        </div>

        <!-- 시즌 요약 -->
        <div class="pa-season-wrap">
            <div class="pa-section-title">시즌별 누적</div>
            <table class="pa-table">
                <thead><tr><th>시즌</th><th>경기</th><th>골</th><th>도움</th><th>평점</th><th>출전</th></tr></thead>
                <tbody>${ssRows}</tbody>
            </table>
        </div>

        <!-- 경기별 트렌드 -->
        <div class="pa-trend-wrap">
            <div class="pa-section-title">경기별 트렌드 <span class="pa-sub">(${(trend||[]).length}경기 · 시간순)</span></div>
            ${(trend||[]).length >= 3
                ? `<div style="position:relative;height:230px"><canvas id="chart-pa-trend"></canvas></div>`
                : `<div class="pa-empty">데이터 부족 (최소 3경기)</div>`}
        </div>

        <div class="pa-bottom-grid">
            <!-- 활동량 지수 -->
            <div class="pa-activity-wrap">
                <div class="pa-section-title">활동량 지수 <span class="pa-sub">(90분 환산 · 리그 내 백분위)</span>
                    <span class="tt-help" aria-label="활동량 지수 설명">?<span class="tt-help-tip">90분 환산 터치·듀얼·패스·드리블을 리그 전체 선수(3경기·150분 이상)와 비교한 백분위 점수입니다.<br>100점 = 리그 최상위 활동량</span></span>
                </div>
                ${activity && activity.values && Object.keys(activity.values).length ? `
                <div class="pa-activity-score-row">
                    <span class="pa-activity-score-label">종합 활동량 점수</span>
                    <span class="pa-activity-score-val">${activity.score}<span class="pa-activity-score-unit">/100</span></span>
                </div>
                <div style="position:relative;height:160px"><canvas id="chart-pa-activity"></canvas></div>
                ` : `<div class="pa-empty">활동량 데이터 없음 (경기 수 부족)</div>`}
            </div>

            <!-- 월별 차트 -->
            <div class="pa-monthly-wrap">
                <div class="pa-section-title">월별 공격 포인트 & 평점</div>
                <div style="position:relative;height:180px"><canvas id="chart-pa-monthly"></canvas></div>
            </div>
        </div>
        `;

        // 년도 필터 버튼 이벤트
        modal.querySelectorAll(".pa-year-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const y = btn.dataset.year === "전체" ? null : btn.dataset.year;
                loadData(playerId, y);
            });
        });

        // 차트 렌더
        renderRadar(radar);
        renderActivity(activity);
        renderMonthly(monthly);
        renderTrend(trend || [], info.position);
    }

    // ── 레이더 차트 ──────────────────────────────────────────────
    function renderRadar(radar) {
        const ctx = document.getElementById("chart-pa-radar");
        if (!ctx) return;
        radarChart = new Chart(ctx, {
            type: "radar",
            data: {
                labels: ["공격력", "슈팅", "패스", "수비", "드리블"],
                datasets: [{
                    label: "백분위",
                    data: [radar.attack, radar.shooting, radar.passing, radar.defense, radar.dribble],
                    backgroundColor: "rgba(78,164,248,0.2)",
                    borderColor: "rgba(78,164,248,0.9)",
                    pointBackgroundColor: "rgba(78,164,248,1)",
                    pointRadius: 4,
                    borderWidth: 2,
                }]
            },
            options: {
                animation: { duration: 600 },
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    r: {
                        min: 0, max: 100,
                        ticks: { stepSize: 25, color: "#667", font: { size: 10 }, backdropColor: "transparent" },
                        grid: { color: "rgba(255,255,255,0.08)" },
                        angleLines: { color: "rgba(255,255,255,0.08)" },
                        pointLabels: { color: "#aac", font: { size: 12 } }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => ` 상위 ${100 - ctx.parsed.r}%`
                        }
                    }
                }
            }
        });
    }

    // ── 월별 차트 ──────────────────────────────────────────────
    function renderMonthly(monthly) {
        const ctx = document.getElementById("chart-pa-monthly");
        if (!ctx || !monthly.length) return;

        const MONTHS = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
        const labels = monthly.map(m => MONTHS[m.month - 1]);
        const gaData = monthly.map(m => (m.goals || 0) + (m.assists || 0));
        const ratData = monthly.map(m => m.rating || null);

        const gradG = ctx.getContext("2d").createLinearGradient(0, 0, 0, 200);
        gradG.addColorStop(0, "rgba(78,164,248,0.7)");
        gradG.addColorStop(1, "rgba(78,164,248,0.1)");

        monthChart = new Chart(ctx, {
            data: {
                labels,
                datasets: [
                    {
                        type: "bar",
                        label: "G+A",
                        data: gaData,
                        backgroundColor: gradG,
                        borderRadius: 4,
                        yAxisID: "yGA",
                    },
                    {
                        type: "line",
                        label: "평점",
                        data: ratData,
                        borderColor: "rgba(251,191,36,0.9)",
                        backgroundColor: "transparent",
                        pointBackgroundColor: "rgba(251,191,36,1)",
                        pointRadius: 4,
                        tension: 0.4,
                        yAxisID: "yRating",
                        spanGaps: true,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: "#aac", font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: "rgba(10,15,30,0.92)",
                        titleColor: "#c8d8f0",
                        bodyColor: "#c8d8f0",
                    }
                },
                scales: {
                    x: { ticks: { color: "#778", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.05)" } },
                    yGA: {
                        position: "left",
                        ticks: { color: "#4ea4f8", stepSize: 1, font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        title: { display: true, text: "G+A", color: "#4ea4f8", font: { size: 10 } }
                    },
                    yRating: {
                        position: "right",
                        min: 5, max: 10,
                        ticks: { color: "#fbbf24", font: { size: 11 } },
                        grid: { display: false },
                        title: { display: true, text: "평점", color: "#fbbf24", font: { size: 10 } }
                    }
                }
            }
        });
    }

    // ── 활동량 차트 ─────────────────────────────────────────────
    let activityChart = null;

    function renderActivity(activity) {
        const ctx = document.getElementById("chart-pa-activity");
        if (!ctx || !activity || !activity.values || !Object.keys(activity.values).length) return;

        const LABELS = {
            touches_p90:  "터치 수",
            duels_p90:    "듀얼 참여",
            passes_p90:   "패스 시도",
            def_p90:      "수비 액션",
            dribbles_p90: "드리블 시도",
        };
        const keys   = Object.keys(LABELS);
        const vals   = keys.map(k => activity.values[k] || 0);
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
                        borderRadius: 4,
                    },
                    {
                        label: "리그 평균",
                        data: avgVals,
                        backgroundColor: "rgba(255,255,255,0.12)",
                        borderColor: "rgba(255,255,255,0.35)",
                        borderWidth: 1,
                        borderRadius: 4,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: "#aac", font: { size: 11 } } },
                    tooltip: {
                        backgroundColor: "rgba(10,15,30,0.92)",
                        titleColor: "#c8d8f0",
                        bodyColor: "#c8d8f0",
                        callbacks: {
                            afterLabel: (item) => {
                                if (item.datasetIndex !== 0) return "";
                                const key = keys[item.dataIndex];
                                const pct = activity.percentiles ? (activity.percentiles[key] || 0) : 0;
                                return `상위 ${100 - pct}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#778", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.05)" } },
                    y: {
                        ticks: { color: "#aac", font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        title: { display: true, text: "90분당", color: "#667", font: { size: 10 } }
                    }
                }
            }
        });
    }

    // ── 경기별 트렌드 차트 ──────────────────────────────────────
    function renderTrend(trend, position) {
        const ctx = document.getElementById("chart-pa-trend");
        if (!ctx || !trend || trend.length < 3) return;

        const pos = ["G","D","M","F"].includes(position) ? position : "F";

        // 포지션별 바 데이터 설정
        const BAR_CFG = {
            G: { label: "세이브",   data: trend.map(g => g.saves), color: "rgba(167,139,250,0.75)" },
            D: { label: "수비액션", data: trend.map(g => g.def),   color: "rgba(78,164,248,0.70)" },
            M: { label: "키패스",   data: trend.map(g => g.kp),    color: "rgba(52,211,153,0.70)" },
            F: { label: "G+A",      data: trend.map(g => g.goals + g.assists), color: "rgba(251,191,36,0.75)" },
        };
        // FW는 골/도움 스택
        const isFW = pos === "F";
        const barCfg = BAR_CFG[pos];

        const ratings = trend.map(g => g.rating);
        const ptColors = trend.map(g =>
            g.result === "W" ? "#22c55e" :
            g.result === "L" ? "#ef4444" : "#9ca3af"
        );

        // X축 레이블: 연도 경계는 "'YY M/D", 나머지는 M/D, 경기 많으면 간격 조정
        const step = trend.length > 20 ? Math.ceil(trend.length / 15) : 1;
        const yearBoundaries = new Set();
        const labels = trend.map((g, i) => {
            const isNewYear = i === 0 || g.year !== trend[i - 1].year;
            if (isNewYear && i > 0) yearBoundaries.add(i);
            if (i % step !== 0) return "";
            return isNewYear && i > 0 ? `'${String(g.year).slice(2)} ${g.date}` : g.date;
        });

        const datasets = [];
        if (isFW) {
            datasets.push({
                type: "bar", label: "골",
                data: trend.map(g => g.goals),
                backgroundColor: "rgba(251,191,36,0.85)",
                borderRadius: 3, yAxisID: "yBar", stack: "s", barPercentage: 0.6,
            });
            datasets.push({
                type: "bar", label: "도움",
                data: trend.map(g => g.assists),
                backgroundColor: "rgba(78,164,248,0.65)",
                borderRadius: 3, yAxisID: "yBar", stack: "s", barPercentage: 0.6,
            });
        } else {
            datasets.push({
                type: "bar", label: barCfg.label,
                data: barCfg.data,
                backgroundColor: barCfg.color,
                borderRadius: 3, yAxisID: "yBar", barPercentage: 0.55,
            });
        }
        datasets.push({
            type: "line", label: "평점",
            data: ratings,
            borderColor: "rgba(251,191,36,0.95)",
            backgroundColor: "transparent",
            pointBackgroundColor: ptColors,
            pointBorderColor: ptColors,
            pointRadius: 5, pointHoverRadius: 7,
            tension: 0.3, yAxisID: "yRating",
            spanGaps: true, borderWidth: 2.5,
        });

        // yBar 최대값 (정수 상한, 최소 3)
        const barMax = Math.max(3, ...datasets.filter(d => d.yAxisID === "yBar")
            .flatMap(d => d.data).filter(v => v != null));

        // 연도 경계 수직선 플러그인
        const yearDividerPlugin = {
            id: "yearDivider",
            afterDraw(chart) {
                if (!yearBoundaries.size) return;
                const { ctx, scales: { x, yBar } } = chart;
                const top    = yBar.top;
                const bottom = yBar.bottom;
                ctx.save();
                ctx.strokeStyle = "rgba(255,255,255,0.25)";
                ctx.lineWidth   = 1.5;
                ctx.setLineDash([4, 3]);
                yearBoundaries.forEach(idx => {
                    const xPos = x.getPixelForValue(idx);
                    ctx.beginPath();
                    ctx.moveTo(xPos, top - 4);
                    ctx.lineTo(xPos, bottom);
                    ctx.stroke();
                    // 연도 레이블
                    ctx.fillStyle = "rgba(200,216,240,0.6)";
                    ctx.font = "bold 10px sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText(`${trend[idx].year}`, xPos, top - 8);
                });
                ctx.restore();
            }
        };

        trendChart = new Chart(ctx, {
            data: { labels, datasets },
            plugins: [yearDividerPlugin],
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: {
                        labels: { color: "#aac", font: { size: 11 }, boxWidth: 12, padding: 12 }
                    },
                    tooltip: {
                        backgroundColor: "rgba(10,15,30,0.92)",
                        titleColor: "#c8d8f0", bodyColor: "#c8d8f0",
                        padding: 10,
                        callbacks: {
                            title: (items) => {
                                const g = trend[items[0].dataIndex];
                                const badge = g.result === "W" ? "●" : g.result === "L" ? "●" : "●";
                                return `${g.date} vs ${g.opp}  ${g.score}  ${g.result}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: "#778", font: { size: 10 }, maxRotation: 0, autoSkip: false },
                        grid: { color: "rgba(255,255,255,0.04)" }
                    },
                    yBar: {
                        position: "left", min: 0, max: barMax + 1,
                        ticks: { color: "#aac", stepSize: 1, font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        title: { display: true, text: barCfg.label, color: "#aac", font: { size: 10 } }
                    },
                    yRating: {
                        position: "right", min: 5, max: 10,
                        ticks: { color: "#fbbf24", font: { size: 11 } },
                        grid: { display: false },
                        title: { display: true, text: "평점", color: "#fbbf24", font: { size: 10 } }
                    },
                }
            }
        });
    }

    function destroyCharts() {
        if (radarChart)    { radarChart.destroy();    radarChart    = null; }
        if (activityChart) { activityChart.destroy(); activityChart = null; }
        if (monthChart)    { monthChart.destroy();    monthChart    = null; }
        if (trendChart)    { trendChart.destroy();    trendChart    = null; }
    }
})();
