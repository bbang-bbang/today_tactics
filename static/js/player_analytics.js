// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
// player_analytics.js — 선수 개인 분석 보고서 모달

(function () {
    const modal   = document.getElementById("player-analytics-modal");
    const overlay = modal.querySelector(".pa-overlay");
    const closeBtn = modal.querySelector(".pa-close");

    let radarChart = null;
    let monthChart = null;
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
        _loadSeq++;        // 닫은 뒤 늦게 도착한 응답·차트 모듈이 닫힌 모달에 렌더하지 않도록
        modal.classList.add("hidden");
        destroyCharts();
    }

    // ── 데이터 로딩 ──────────────────────────────────────────────
    let _loadSeq = 0;   // 선수·연도 연타 전환 시 늦게 온 이전 응답 무시
    function loadData(playerId, year) {
        const tok = ++_loadSeq;
        destroyCharts();   // 본문을 스켈레톤으로 바꾸기 전에 기존 차트 정리(분리된 슬롯의 옵저버·애니메이션 누수 방지)
        if (window.ttPlayerReady) window.ttPlayerReady().catch(() => {});   // 차트 모듈은 데이터와 병렬로
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
            .then(data => { if (tok === _loadSeq) render(data, playerId, year); })
            .catch(() => {
                if (tok !== _loadSeq) return;
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
                <td>${ttEsc(g.opponent)} <span class="pa-ha">${ha}</span></td>
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
                <span class="pa-player-name">${ttEsc(info.name)}</span>
                <span class="pa-team-name">${ttEsc(info.team)}</span>
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
            ${(trend||[]).length >= 1
                ? `<div class="tt-card-chart" data-chart-slot id="pa-rating-slot" style="height:220px"></div>
                   <div class="tt-card-chart" data-chart-slot id="pa-strip-slot" style="height:64px"></div>
                   <p class="pa-sub" id="pa-trend-note">굵은 선 = 경기별 평점 · 점선 = 시즌 평균 · 아래 띠 = 경기별 결과</p>`
                : `<div class="pa-empty">경기 기록 없음</div>`}
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
        const rs = document.getElementById("pa-rating-slot"), ss = document.getElementById("pa-strip-slot");
        if (!rs || !trend || !trend.length) return;
        const tok = _loadSeq;
        const pos = ["G", "D", "M", "F"].includes(position) ? position : "F";
        const fail = () => {
            [rs, ss].forEach((el) => { if (el) el.innerHTML = '<div class="tt-chart-error" role="alert">차트를 불러오지 못했습니다</div>'; });
        };
        const ready = window.ttPlayerReady ? window.ttPlayerReady() : Promise.reject(new Error("no loader"));
        ready.catch(() => {}).then(() => {
            if (tok !== _loadSeq || !document.body.contains(rs)) return;
            if (!(window.TTChart && window.PlayerCharts)) return fail();
            try {
                const spec = PlayerCharts.ratingLine(trend);
                const note = document.getElementById("pa-trend-note");
                if (note && spec.__note) note.textContent = `${spec.__note} · ` + note.textContent;
                TTChart.mount(rs, spec, { ariaLabel: "경기별 평점과 시즌 평균" });
                TTChart.mount(ss, PlayerCharts.strip(trend, pos), { ariaLabel: "경기별 결과 띠" });
            } catch (e) { console.warn("[player-analytics] trend chart failed", e); fail(); }
        });
    }

    function destroyCharts() {
        if (radarChart)    { radarChart.destroy();    radarChart    = null; }
        if (activityChart) { activityChart.destroy(); activityChart = null; }
        if (monthChart)    { monthChart.destroy();    monthChart    = null; }
        if (window.TTChart) TTChart.destroyAll(modal);
    }
})();
