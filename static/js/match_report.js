/* match_report.js — 경기 단일 심층 리포트 모달
 * window.openMatchReport(eventId) 로 호출. /api/match-report 데이터를
 * 헤더·지표비교·xG흐름차트·양팀 슛맵·평균위치·골 타임라인으로 렌더.
 * 좌표: shotmap x=골문거리(0=골라인) / avg x=공격방향(0 자기골문~100)·y=좌우. */
(function () {
    "use strict";
    const HOME = "#5b9bf3", AWAY = "#f0776c";       // 홈/원정 고정 컬러(혼동 방지)
    const SHOT_COLOR = { goal: "#22c55e", save: "#60a5fa", post: "#a78bfa", block: "#f59e0b", miss: "#94a3b8" };
    const SHOT_LABEL = { goal: "골", save: "유효(선방)", post: "골대", block: "차단", miss: "빗나감" };
    let _chart = null;

    const modal = document.getElementById("match-report-modal");
    const body = document.getElementById("mr-body");
    if (!modal || !body) return;

    function close() {
        modal.classList.add("hidden");
        if (_chart) { try { _chart.destroy(); } catch (_) {} _chart = null; }
    }
    modal.querySelectorAll("[data-mr-close]").forEach(el => el.addEventListener("click", close));
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
    });

    window.openMatchReport = async function (eventId) {
        if (!eventId) return;
        modal.classList.remove("hidden");
        body.innerHTML = '<div class="mr-loading">⏳ 경기 리포트 불러오는 중…</div>';
        let d;
        try {
            const r = await fetch("/api/match-report?eventId=" + encodeURIComponent(eventId));
            d = await r.json();
        } catch (e) {
            body.innerHTML = '<div class="mr-loading">리포트를 불러오지 못했습니다.</div>';
            return;
        }
        if (!d || !d.event) {
            body.innerHTML = '<div class="mr-loading">이 경기의 상세 데이터가 없습니다.</div>';
            return;
        }
        render(d);
    };

    function render(d) {
        const ev = d.event, sh = d.stats.home, sa = d.stats.away;
        const goals = d.goals || [];

        // ── 헤더 ──
        const fmt = f => f ? `<span class="mr-form">${f}</span>` : "";
        const headerHTML = `
            <div class="mr-header">
                <div class="mr-team mr-team-home">
                    <div class="mr-team-name" style="color:${HOME}">${ev.home}</div>
                    ${fmt(ev.homeFormation)}
                </div>
                <div class="mr-score">
                    <div class="mr-score-num">${ev.homeScore} <span>:</span> ${ev.awayScore}</div>
                    <div class="mr-score-meta">${ev.tournament}${ev.round ? " R" + ev.round : ""} · ${ev.date}${ev.venue ? " · " + ev.venue : ""}</div>
                </div>
                <div class="mr-team mr-team-away">
                    <div class="mr-team-name" style="color:${AWAY}">${ev.away}</div>
                    ${fmt(ev.awayFormation)}
                </div>
            </div>`;

        // ── 지표 비교 바 ──
        const ROWS = [
            { k: "shots", label: "슈팅" },
            { k: "onTarget", label: "유효슛" },
            { k: "xg", label: "xG", dec: 2 },
            { k: "possession", label: "패스 점유(추정)", suf: "%" },
            { k: "passAcc", label: "패스 정확도", suf: "%" },
            { k: "keyPasses", label: "키패스" },
            { k: "rating", label: "평균 평점", dec: 2 },
        ];
        const fmtV = (v, r) => v == null ? "—" : (r.dec ? (+v).toFixed(r.dec) : v) + (r.suf || "");
        const barRow = r => {
            const hv = sh[r.k], av = sa[r.k];
            const hn = +hv || 0, an = +av || 0, tot = hn + an;
            const hp = tot ? Math.round(hn / tot * 100) : 50;
            const hWin = hn > an, aWin = an > hn;
            return `<div class="mr-stat-row">
                <span class="mr-stat-v ${hWin ? "win" : ""}" style="${hWin ? "color:" + HOME : ""}">${fmtV(hv, r)}</span>
                <div class="mr-stat-mid">
                    <div class="mr-stat-label">${r.label}</div>
                    <div class="mr-stat-bar">
                        <span class="mr-bar-h" style="width:${hp}%;background:${HOME}"></span>
                        <span class="mr-bar-a" style="width:${100 - hp}%;background:${AWAY}"></span>
                    </div>
                </div>
                <span class="mr-stat-v ${aWin ? "win" : ""}" style="${aWin ? "color:" + AWAY : ""}">${fmtV(av, r)}</span>
            </div>`;
        };
        // 결정력(골−xG) — 음수 가능하므로 별도 표기
        const clin = (v, col) => {
            const s = v > 0 ? "+" + v : "" + v;
            const c = v > 0 ? "#34d399" : v < 0 ? "#f87171" : "#9aa7b4";
            return `<span style="color:${c};font-weight:800">${s}</span>`;
        };
        const statsHTML = `
            <div class="mr-section">
                <div class="mr-sec-title">📊 핵심 지표 비교</div>
                ${ROWS.map(barRow).join("")}
                <div class="mr-stat-row mr-stat-clin">
                    <span class="mr-stat-v">${clin(sh.xgDiff)}</span>
                    <div class="mr-stat-mid"><div class="mr-stat-label">결정력 (골 − xG)</div>
                        <div class="mr-clin-hint">+면 기대(xG)보다 잘 마무리</div></div>
                    <span class="mr-stat-v">${clin(sa.xgDiff)}</span>
                </div>
            </div>`;

        // ── xG 흐름 차트 ──
        const flowHTML = `
            <div class="mr-section">
                <div class="mr-sec-title">📈 xG 흐름 <span class="mr-sec-sub">누적 기대득점 · ⚽=실제 골</span></div>
                <div class="mr-chart-wrap"><canvas id="mr-xg-flow"></canvas></div>
            </div>`;

        // ── 슛맵 (양 팀) ──
        const legend = Object.keys(SHOT_LABEL).map(k =>
            `<span class="mr-leg"><i style="background:${SHOT_COLOR[k]}"></i>${SHOT_LABEL[k]}</span>`).join("");
        const shotmapHTML = `
            <div class="mr-section">
                <div class="mr-sec-title">🎯 슛맵 <span class="mr-sec-sub">점 크기 = xG · 오른쪽이 공격 골문</span></div>
                <div class="mr-leg-row">${legend}</div>
                <div class="mr-duo">
                    <div class="mr-duo-cell"><div class="mr-duo-cap" style="color:${HOME}">${ev.home}</div>
                        <canvas id="mr-sm-home" width="360" height="232"></canvas></div>
                    <div class="mr-duo-cell"><div class="mr-duo-cap" style="color:${AWAY}">${ev.away}</div>
                        <canvas id="mr-sm-away" width="360" height="232"></canvas></div>
                </div>
            </div>`;

        // ── 평균 위치 (양 팀) ──
        const avgHTML = `
            <div class="mr-section">
                <div class="mr-sec-title">🧭 평균 위치 <span class="mr-sec-sub">선발 평균 포지션 · 오른쪽이 공격 방향</span></div>
                <div class="mr-duo">
                    <div class="mr-duo-cell"><div class="mr-duo-cap" style="color:${HOME}">${ev.home}${ev.homeFormation ? " · " + ev.homeFormation : ""}</div>
                        <canvas id="mr-ap-home" width="360" height="232"></canvas></div>
                    <div class="mr-duo-cell"><div class="mr-duo-cap" style="color:${AWAY}">${ev.away}${ev.awayFormation ? " · " + ev.awayFormation : ""}</div>
                        <canvas id="mr-ap-away" width="360" height="232"></canvas></div>
                </div>
            </div>`;

        // ── 골 타임라인 ──
        const maxMin = Math.max(95, ...goals.map(g => g.min + (g.added || 0)));
        const goalMark = g => {
            const t = g.min + (g.added || 0);
            const pct = Math.min(100, t / maxMin * 100);
            const tag = (g.pen ? " (PK)" : "") + (g.own ? " (OG)" : "");
            return `<div class="mr-tl-goal ${g.isHome ? "home" : "away"}" style="left:${pct}%"
                        title="${t}' ${g.name}${tag}">
                        <span class="mr-tl-dot" style="background:${g.isHome ? HOME : AWAY}"></span>
                        <span class="mr-tl-label">${g.name.split(" ").pop()} ${t}'${tag}</span>
                    </div>`;
        };
        const timelineHTML = goals.length ? `
            <div class="mr-section">
                <div class="mr-sec-title">⚽ 골 타임라인</div>
                <div class="mr-timeline">
                    <div class="mr-tl-axis"></div>
                    <div class="mr-tl-half" style="left:${50 / maxMin * 100}%" title="하프타임"></div>
                    ${goals.map(goalMark).join("")}
                </div>
                <div class="mr-tl-legend"><span style="color:${HOME}">▲ ${ev.home}</span><span style="color:${AWAY}">▼ ${ev.away}</span></div>
            </div>` : "";

        body.innerHTML = headerHTML + statsHTML + flowHTML + shotmapHTML + avgHTML + timelineHTML;

        // ── 캔버스/차트 그리기 ──
        drawShotmap(document.getElementById("mr-sm-home"), d.shots.home);
        drawShotmap(document.getElementById("mr-sm-away"), d.shots.away);
        drawPitch(document.getElementById("mr-ap-home"), d.avg.home, HOME);
        drawPitch(document.getElementById("mr-ap-away"), d.avg.away, AWAY);
        drawXgFlow(d);
    }

    // 누적 xG 흐름 점 생성 (분 단위, time_sec 우선)
    function flowPts(arr) {
        let cum = 0; const pts = [{ x: 0, y: 0 }];
        arr.forEach(s => {
            cum += s.xg || 0;
            const t = s.sec ? s.sec / 60 : s.min;
            pts.push({ x: +t.toFixed(2), y: +cum.toFixed(3) });
        });
        return pts;
    }
    function cumAt(pts, t) {
        let y = 0;
        for (const p of pts) { if (p.x <= t) y = p.y; else break; }
        return y;
    }

    function drawXgFlow(d) {
        const el = document.getElementById("mr-xg-flow");
        if (!el || typeof Chart === "undefined") return;
        const hp = flowPts(d.shots.home), ap = flowPts(d.shots.away);
        const goals = d.goals || [];
        const maxMin = Math.max(95, ...goals.map(g => g.min + (g.added || 0)),
            ...hp.map(p => p.x), ...ap.map(p => p.x));
        // 끝점 연장(경기 종료까지 수평 유지)
        const endH = hp[hp.length - 1].y, endA = ap[ap.length - 1].y;
        hp.push({ x: maxMin, y: endH }); ap.push({ x: maxMin, y: endA });

        const goalPts = (isHome, pts) => goals.filter(g => g.isHome === isHome).map(g => {
            const t = g.min + (g.added || 0);
            return { x: t, y: cumAt(pts, t) };
        });

        if (_chart) { try { _chart.destroy(); } catch (_) {} }
        _chart = new Chart(el, {
            type: "line",
            data: {
                datasets: [
                    { label: d.event.home, data: hp, borderColor: HOME, backgroundColor: HOME + "22",
                      stepped: true, fill: true, borderWidth: 2.4, pointRadius: 0, tension: 0 },
                    { label: d.event.away, data: ap, borderColor: AWAY, backgroundColor: AWAY + "22",
                      stepped: true, fill: true, borderWidth: 2.4, pointRadius: 0, tension: 0 },
                    { label: d.event.home + " 골", data: goalPts(true, hp), borderColor: HOME,
                      backgroundColor: "#fff", pointStyle: "circle", showLine: false,
                      pointRadius: 6, pointBorderColor: HOME, pointBorderWidth: 3 },
                    { label: d.event.away + " 골", data: goalPts(false, ap), borderColor: AWAY,
                      backgroundColor: "#fff", pointStyle: "circle", showLine: false,
                      pointRadius: 6, pointBorderColor: AWAY, pointBorderWidth: 3 },
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: "nearest", intersect: false },
                scales: {
                    x: { type: "linear", min: 0, max: maxMin,
                         title: { display: true, text: "경기 시간(분)", color: "#8a98a7" },
                         ticks: { color: "#8a98a7", stepSize: 15 }, grid: { color: "rgba(255,255,255,0.06)" } },
                    y: { beginAtZero: true, title: { display: true, text: "누적 xG", color: "#8a98a7" },
                         ticks: { color: "#8a98a7" }, grid: { color: "rgba(255,255,255,0.06)" } },
                },
                plugins: {
                    legend: { labels: { color: "#cdd8e8", usePointStyle: true, padding: 12,
                              filter: i => !i.text.endsWith(" 골") } },
                    tooltip: {
                        callbacks: {
                            title: items => `${Math.round(items[0].parsed.x)}분`,
                            label: c => c.dataset.label.endsWith(" 골")
                                ? `⚽ ${c.dataset.label.replace(" 골", "")} 득점`
                                : `${c.dataset.label}: 누적 xG ${c.parsed.y.toFixed(2)}`,
                        }
                    }
                }
            }
        });
    }

    function drawShotmap(cv, arr) {
        if (!cv) return;
        const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#163d1c"; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(255,255,255,0.26)"; ctx.lineWidth = 1.4;
        ctx.strokeRect(6, 6, W - 12, H - 12);
        const cy = H / 2;
        ctx.strokeRect(W - 6 - 95, cy - 78, 95, 156);
        ctx.strokeRect(W - 6 - 36, cy - 40, 36, 80);
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(W - 7, cy - 20); ctx.lineTo(W - 7, cy + 20); ctx.stroke();
        const XCAP = 45, PAD = 8;
        const fx = v => (W - 7) - (Math.min(v, XCAP) / XCAP) * (W - 14 - PAD);
        const fy = v => PAD + (v / 100) * (H - 2 * PAD);
        const order = { goal: 3, save: 2, post: 1 };
        [...(arr || [])].sort((a, b) => (order[a.outcome] || 0) - (order[b.outcome] || 0)).forEach(s => {
            const r = Math.max(3, Math.min(14, 3 + Math.sqrt(s.xg) * 22));
            ctx.beginPath(); ctx.arc(fx(s.x), fy(s.y), r, 0, Math.PI * 2);
            const col = SHOT_COLOR[s.outcome] || "#94a3b8";
            ctx.fillStyle = (s.outcome === "goal") ? col : col + "cc"; ctx.fill();
            if (s.outcome === "goal") { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
        });
        if (!arr || !arr.length) {
            ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "12px sans-serif";
            ctx.textAlign = "center"; ctx.fillText("슛 데이터 없음", W / 2, cy);
        }
    }

    function drawPitch(cv, nodes, color) {
        if (!cv) return;
        const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, "#13401a"); g.addColorStop(1, "#185020");
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(255,255,255,0.24)"; ctx.lineWidth = 1.3;
        const P = 10;
        ctx.strokeRect(P, P, W - 2 * P, H - 2 * P);
        ctx.beginPath(); ctx.moveTo(W / 2, P); ctx.lineTo(W / 2, H - P); ctx.stroke();
        ctx.beginPath(); ctx.arc(W / 2, H / 2, 28, 0, Math.PI * 2); ctx.stroke();
        const bh = H * 0.5, bw = 42;
        ctx.strokeRect(P, (H - bh) / 2, bw, bh);
        ctx.strokeRect(W - P - bw, (H - bh) / 2, bw, bh);
        const fx = v => P + (v / 100) * (W - 2 * P), fy = v => P + (v / 100) * (H - 2 * P);
        if (!nodes || !nodes.length) {
            ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "12px sans-serif";
            ctx.textAlign = "center"; ctx.fillText("평균 위치 데이터 없음", W / 2, H / 2);
            return;
        }
        nodes.forEach(n => {
            const x = fx(n.x), y = fy(n.y);
            ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2);
            ctx.fillStyle = color; ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 1.4; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = "600 9.5px sans-serif"; ctx.textAlign = "center";
            const short = (n.name || "").split(" ").pop().slice(0, 4);
            ctx.fillText(short, x, y - 12);
        });
    }
})();
