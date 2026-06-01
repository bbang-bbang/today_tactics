// team_compare.js — 두 팀 주요 스탯 비교 모달 (Chart.js 레이더 오버레이)

(function () {
    const modal      = document.getElementById("team-compare-modal");
    if (!modal) return;
    const backdrop   = modal.querySelector(".modal-backdrop");
    const closeBtn   = document.getElementById("tc-close");
    const selA       = document.getElementById("tc-team-a");
    const selB       = document.getElementById("tc-team-b");
    const body       = document.getElementById("tc-body");
    const empty      = document.getElementById("tc-empty");
    const yearFilter = document.getElementById("tc-year-filter");

    let teamsLoaded = false;
    let currentYear = "전체";
    let radarChart  = null;
    // 조회 최적화 상태
    const _cache = new Map();           // key: `${teamA}|${teamB}|${year}` → data
    const _matchesCache = new Map();    // key: `${teamA}|${teamB}|${year}` → matches[]
    const _rankingsCache = new Map();   // key: `${league}|${year}` → rankings payload
    const _trendCache = new Map();      // key: `${teamId}|${year}` → trend payload
    let _inFlight = null;
    let _matchesInFlight = null;
    let _rankingsInFlight = { K1: null, K2: null };
    const _trendInFlight = {};
    let _debounceTimer = null;
    // Chart.js 인스턴스 캐시 (destroy 대신 update)
    let trendChart   = null;
    let balanceChart = null;
    const _sparkCharts = {}; // key: "A"|"B" → Chart instance
    // 골 타이밍 비교(두 팀 오버레이)
    let _gtChartFor = null, _gtChartAgainst = null;
    const _gtCache = new Map();   // key: `${teamA}|${teamB}|${year}` → {gtA, gtB, names}

    function populateSelects() {
        if (teamsLoaded) return;
        fetch("/api/teams").then(r => r.json()).then(teams => {
            teamsLoaded = true;
            const grouped = { K1: [], K2: [] };
            teams.forEach(t => { if (grouped[t.league]) grouped[t.league].push(t); });
            Object.values(grouped).forEach(arr => arr.sort((a, b) => a.name.localeCompare(b.name, "ko")));
            [selA, selB].forEach(sel => {
                sel.innerHTML = '<option value="">팀 선택...</option>';
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
                    sel.appendChild(og);
                });
            });
        });
    }

    function buildYearFilter(years) {
        yearFilter.innerHTML = "";
        ["전체", ...years].forEach(y => {
            const btn = document.createElement("button");
            btn.className = "year-filter-btn" + (y === currentYear ? " active" : "");
            btn.textContent = y === "전체" ? "전체" : y + "년";
            btn.dataset.year = y;
            btn.addEventListener("click", () => {
                currentYear = y;
                yearFilter.querySelectorAll(".year-filter-btn").forEach(b => {
                    b.classList.toggle("active", b.dataset.year === y);
                });
                loadIfReady();
            });
            yearFilter.appendChild(btn);
        });
    }

    function open() {
        modal.classList.remove("hidden");
        populateSelects();
    }
    function close() { modal.classList.add("hidden"); }

    document.getElementById("btn-team-compare").addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);

    selA.addEventListener("change", debouncedLoad);
    selB.addEventListener("change", debouncedLoad);

    function debouncedLoad() {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(loadIfReady, 180);
    }

    function loadIfReady() {
        const a = selA.value, b = selB.value;
        if (!a || !b || a === b) {
            body.classList.add("hidden");
            empty.classList.remove("hidden");
            if (a && b && a === b) empty.textContent = "같은 팀은 비교할 수 없습니다.";
            else empty.textContent = "좌/우 팀을 선택하면 비교가 표시됩니다.";
            return;
        }
        const yp = currentYear !== "전체" ? `&year=${currentYear}` : "";
        const cacheKey = `${a}|${b}|${currentYear}`;
        const matchesKey = `${a}|${b}|${currentYear}`;

        // 캐시 히트: 즉시 렌더 (네트워크 스킵)
        if (_cache.has(cacheKey)) {
            render(_cache.get(cacheKey));
            if (_matchesCache.has(matchesKey)) renderMatches(_matchesCache.get(matchesKey));
            else fetchMatches(a, b, matchesKey);
            return;
        }

        // in-flight 취소
        if (_inFlight) _inFlight.abort();
        _inFlight = new AbortController();

        empty.classList.remove("hidden");
        empty.textContent = "불러오는 중...";

        fetch(`/api/team-compare?teamA=${a}&teamB=${b}${yp}`, { signal: _inFlight.signal })
            .then(r => r.json())
            .then(data => {
                _cache.set(cacheKey, data);
                render(data);
                // 캐시 크기 제한 (가장 오래된 항목 제거)
                if (_cache.size > 30) _cache.delete(_cache.keys().next().value);
            })
            .catch(err => {
                if (err.name === "AbortError") return; // 취소는 무시
                empty.textContent = "데이터를 가져오지 못했습니다.";
            });

        // 맞대결 경기 리스트는 병렬 fetch
        if (_matchesCache.has(matchesKey)) renderMatches(_matchesCache.get(matchesKey));
        else fetchMatches(a, b, matchesKey);

        // 골 타이밍 두 팀 비교 (병렬 fetch)
        const gtNames = {
            a: (selA.options[selA.selectedIndex] || {}).text || "팀 A",
            b: (selB.options[selB.selectedIndex] || {}).text || "팀 B",
        };
        if (_gtCache.has(cacheKey)) renderGoalTimingCompare(_gtCache.get(cacheKey));
        else fetchGoalTiming(a, b, cacheKey, gtNames);
    }

    function fetchGoalTiming(a, b, cacheKey, names) {
        const yp = currentYear !== "전체" ? `&year=${currentYear}` : "";
        Promise.all([
            fetch(`/api/goal-timing?teamId=${a}${yp}`).then(r => r.json()).catch(() => null),
            fetch(`/api/goal-timing?teamId=${b}${yp}`).then(r => r.json()).catch(() => null),
        ]).then(([gtA, gtB]) => {
            const payload = { gtA, gtB, names };
            _gtCache.set(cacheKey, payload);
            if (_gtCache.size > 30) _gtCache.delete(_gtCache.keys().next().value);
            renderGoalTimingCompare(payload);
        }).catch(() => {});
    }

    function renderGoalTimingCompare(payload) {
        const elFor = document.getElementById("tc-gt-for");
        const elAg  = document.getElementById("tc-gt-against");
        if (!elFor || !elAg) return;
        const { gtA, gtB, names } = payload;
        const ok = gtA && gtA.buckets && gtB && gtB.buckets;
        const wrap = elFor.closest(".tc-gt-grid");
        const note = document.getElementById("tc-gt-note");
        if (!ok) {
            if (_gtChartFor) { _gtChartFor.destroy(); _gtChartFor = null; }
            if (_gtChartAgainst) { _gtChartAgainst.destroy(); _gtChartAgainst = null; }
            if (wrap) wrap.style.opacity = "0.4";
            if (note) note.textContent = "골 타이밍 데이터 없음 (해당 리그/시즌 미수집)";
            return;
        }
        if (wrap) wrap.style.opacity = "1";
        if (note) note.textContent = "막대 = 시간대별 골 수 · 팀 A(파랑) vs 팀 B(주황)";
        const labels = gtA.buckets.map(x => x.label + "'");
        const COL_A = "rgba(78,164,248,0.85)", COL_B = "rgba(248,161,78,0.85)";
        const mk = (el, prev, dA, dB) => {
            if (prev) prev.destroy();
            return new Chart(el, {
                type: "bar",
                data: { labels, datasets: [
                    { label: names.a, data: dA, backgroundColor: COL_A, borderRadius: 4 },
                    { label: names.b, data: dB, backgroundColor: COL_B, borderRadius: 4 },
                ] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: "#c8d0e8", font: { size: 11 }, boxWidth: 12, usePointStyle: true } },
                        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}골` } } },
                    scales: {
                        x: { ticks: { color: "#8a9fb8", font: { size: 10 } }, grid: { display: false } },
                        y: { beginAtZero: true, ticks: { color: "#8a9fb8", precision: 0, font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.06)" } }
                    }
                }
            });
        };
        _gtChartFor     = mk(elFor, _gtChartFor, gtA.buckets.map(x => x.for),     gtB.buckets.map(x => x.for));
        _gtChartAgainst = mk(elAg,  _gtChartAgainst, gtA.buckets.map(x => x.against), gtB.buckets.map(x => x.against));
    }

    function fetchMatches(a, b, cacheKey) {
        if (_matchesInFlight) _matchesInFlight.abort();
        _matchesInFlight = new AbortController();
        const yp = currentYear !== "전체" ? `&year=${currentYear}` : "";
        fetch(`/api/h2h-matches?teamA=${a}&teamB=${b}${yp}&limit=20`, { signal: _matchesInFlight.signal })
            .then(r => r.json())
            .then(matches => {
                _matchesCache.set(cacheKey, matches);
                renderMatches(matches);
                if (_matchesCache.size > 30) _matchesCache.delete(_matchesCache.keys().next().value);
            })
            .catch(err => {
                if (err.name === "AbortError") return;
                renderMatches([]);
            });
    }

    function render(data) {
        if (!data || !data.teamA || !data.teamB) return;
        empty.classList.add("hidden");
        body.classList.remove("hidden");
        buildYearFilter(data.available_years || []);
        renderHeader(data);
        renderRadar(data);
        renderHA(data);
        renderBars(data);
        // 리그 순위 (+ 공수 밸런스 H + 선제득점 D)
        loadRankingsFor(data.teamA, data.teamB);
        // 트렌드 (+ 스파크라인 B) — 병렬 fetch
        loadTrendFor(data.teamA, data.teamB);
    }

    // hex → "r,g,b" 문자열
    function hexRgb(hex, fallback) {
        const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex || "");
        if (!m) return fallback;
        return `${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)}`;
    }

    function renderHeader(data) {
        const a = data.teamA, b = data.teamB, h = data.h2h || {};
        document.getElementById("tc-name-a").textContent = a.name || "";
        document.getElementById("tc-name-b").textContent = b.name || "";
        document.getElementById("tc-league-a").textContent = a.league || "";
        document.getElementById("tc-league-b").textContent = b.league || "";
        const embA = document.getElementById("tc-emblem-a");
        const embB = document.getElementById("tc-emblem-b");
        const setEmblem = (img, emblem) => {
            if (emblem) {
                img.src = `/static/img/emblems/${emblem}`;
                img.style.display = "";
                img.onerror = () => { img.style.display = "none"; };
            } else {
                img.removeAttribute("src");
                img.style.display = "none";
            }
        };
        setEmblem(embA, a.emblem);
        setEmblem(embB, b.emblem);

        // 매치업 포스터 배경에 팀 컬러 라디얼 그라디언트 주입
        const titleRow = document.querySelector(".tc-title-row");
        if (titleRow) {
            const rgbA = hexRgb(a.primary, "78,164,248");
            const rgbB = hexRgb(b.primary, "184,126,248");
            titleRow.style.setProperty("--tc-color-a", `rgba(${rgbA},0.32)`);
            titleRow.style.setProperty("--tc-color-b", `rgba(${rgbB},0.32)`);
        }

        const h2h = document.getElementById("tc-h2h-summary");
        if (h.games > 0) {
            h2h.textContent = `${h.a_wins}  ${h.draws}  ${h.b_wins}`;
            h2h.title = `${h.games}경기 · ${a.short}기준 ${h.a_wins}승 ${h.draws}무 ${h.b_wins}패, 득실 ${h.a_gf}:${h.a_ga}`;
        } else {
            h2h.textContent = "— vs —";
            h2h.title = "맞대결 기록 없음";
        }
    }

    // 팀 색상 → 레이더 데이터셋 색상
    function teamColors(team, isSecond) {
        const base = team.primary || (isSecond ? "#b87ef8" : "#4ea4f8");
        // hex → rgb
        const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(base);
        const rgb = m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : [78,164,248];
        return {
            border: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.95)`,
            fill:   `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.18)`,
            point:  `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`,
        };
    }

    function renderRadar(data) {
        const el = document.getElementById("tc-radar");
        if (!el) return;

        const a = data.teamA, b = data.teamB;
        const labels = ["승률(%)", "경기당 승점×30", "평균 득점×30", "평균 실점⁻¹×50", "홈 승률(%)", "원정 승률(%)"];
        const pct = (n, g) => g > 0 ? (n / g * 100) : 0;

        const toRow = (t) => {
            const homeG = t.home && t.home.games || 0;
            const awayG = t.away && t.away.games || 0;
            return [
                t.win_pct || 0,
                (t.ppg || 0) * 30,
                (t.avg_gf || 0) * 30,
                t.avg_ga > 0 ? Math.min(100, 50 / t.avg_ga) : 50,
                pct((t.home && t.home.w) || 0, homeG),
                pct((t.away && t.away.w) || 0, awayG),
            ];
        };

        const cA = teamColors(a, false);
        const cB = teamColors(b, true);
        const rowA = toRow(a), rowB = toRow(b);

        // 인스턴스 재사용 (destroy 없이 data만 교체 → 렌더 비용 절감)
        if (radarChart) {
            radarChart.data.datasets[0].label = a.short || a.name;
            radarChart.data.datasets[0].data  = rowA;
            radarChart.data.datasets[0].borderColor = cA.border;
            radarChart.data.datasets[0].backgroundColor = cA.fill;
            radarChart.data.datasets[0].pointBackgroundColor = cA.point;
            radarChart.data.datasets[1].label = b.short || b.name;
            radarChart.data.datasets[1].data  = rowB;
            radarChart.data.datasets[1].borderColor = cB.border;
            radarChart.data.datasets[1].backgroundColor = cB.fill;
            radarChart.data.datasets[1].pointBackgroundColor = cB.point;
            radarChart.update();
            return;
        }

        radarChart = new Chart(el, {
            type: "radar",
            data: {
                labels,
                datasets: [
                    {
                        label: a.short || a.name,
                        data: rowA,
                        borderColor: cA.border,
                        backgroundColor: cA.fill,
                        pointBackgroundColor: cA.point,
                        pointRadius: 4,
                        borderWidth: 2,
                    },
                    {
                        label: b.short || b.name,
                        data: rowB,
                        borderColor: cB.border,
                        backgroundColor: cB.fill,
                        pointBackgroundColor: cB.point,
                        pointRadius: 4,
                        borderWidth: 2,
                        borderDash: [6, 4],
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 600, easing: "easeOutQuart" },
                plugins: {
                    legend: { labels: { color: "#cdd8e8", font: { weight: "600" }, usePointStyle: true, padding: 12 } },
                    tooltip: {
                        backgroundColor: "#ffffff",
                        borderColor: "rgba(74,130,199,0.35)",
                        borderWidth: 1,
                        titleColor: "#cdd8e8",
                        bodyColor: "#cdd8e8",
                        padding: 10,
                        cornerRadius: 8,
                        boxShadow: "0 6px 18px rgba(70,90,140,0.15)",
                        callbacks: {
                            label: (c) => `${c.dataset.label}: ${(+c.parsed.r).toFixed(1)}`
                        }
                    }
                },
                scales: {
                    r: {
                        min: 0, max: 100,
                        angleLines: { color: "rgba(255,255,255,0.12)" },
                        grid: { color: "rgba(255,255,255,0.10)" },
                        pointLabels: { color: "#cdd8e8", font: { size: 11, weight: "600" } },
                        ticks: { color: "#9aa7bd", backdropColor: "transparent", stepSize: 25, font: { size: 9 } }
                    }
                }
            }
        });
    }

    function renderHA(data) {
        const a = data.teamA, b = data.teamB;
        const pct = (n, g) => g > 0 ? Math.round(n / g * 100) : 0;
        const ha = (t, side) => {
            const r = (t[side] || {});
            return { games: r.games||0, w: r.w||0, d: r.d||0, l: r.l||0, pct: pct(r.w||0, r.games||0) };
        };
        const aHome = ha(a,"home"), aAway = ha(a,"away"), bHome = ha(b,"home"), bAway = ha(b,"away");
        const pctBadge = (p) => `<span class="tc-ha-pct" style="color:${p>=50?'#7bed9f':p>=30?'#ffd77a':'#f87171'}">${p}%</span>`;
        const tbl = document.getElementById("tc-ha-table");
        tbl.innerHTML = `
            <tr><th>팀</th><th>홈 승률</th><th>홈 전적</th><th>원정 승률</th><th>원정 전적</th></tr>
            <tr>
                <td style="color:${a.primary||'#4ea4f8'};font-weight:700">${a.short||a.name}</td>
                <td>${pctBadge(aHome.pct)}</td>
                <td>${aHome.w}-${aHome.d}-${aHome.l}</td>
                <td>${pctBadge(aAway.pct)}</td>
                <td>${aAway.w}-${aAway.d}-${aAway.l}</td>
            </tr>
            <tr>
                <td style="color:${b.primary||'#b87ef8'};font-weight:700">${b.short||b.name}</td>
                <td>${pctBadge(bHome.pct)}</td>
                <td>${bHome.w}-${bHome.d}-${bHome.l}</td>
                <td>${pctBadge(bAway.pct)}</td>
                <td>${bAway.w}-${bAway.d}-${bAway.l}</td>
            </tr>`;
    }

    // 숫자 카운트업 애니메이션 (integer/decimal 모두 처리)
    function animateCount(el, target, duration = 700) {
        const isInt = Number.isInteger(target);
        const start = performance.now();
        function tick(now) {
            const t = Math.min(1, (now - start) / duration);
            // easeOutCubic
            const eased = 1 - Math.pow(1 - t, 3);
            const v = target * eased;
            el.textContent = isInt ? Math.round(v).toString() : (+v.toFixed(2)).toString();
            if (t < 1) requestAnimationFrame(tick);
            else el.textContent = fmtNum(target);
        }
        requestAnimationFrame(tick);
    }

    function renderBars(data) {
        const a = data.teamA, b = data.teamB;
        const metrics = [
            { label: "경기",        va: a.games,   vb: b.games,   higher: "higher" },
            { label: "승",          va: a.w,       vb: b.w,       higher: "higher" },
            { label: "무",          va: a.d,       vb: b.d,       higher: "neutral" },
            { label: "패",          va: a.l,       vb: b.l,       higher: "lower" },
            { label: "승점",        va: a.pts,     vb: b.pts,     higher: "higher" },
            { label: "승점/경기",   va: a.ppg,     vb: b.ppg,     higher: "higher" },
            { label: "승률 %",      va: a.win_pct, vb: b.win_pct, higher: "higher" },
            { label: "평균 득점",   va: a.avg_gf,  vb: b.avg_gf,  higher: "higher" },
            { label: "평균 실점",   va: a.avg_ga,  vb: b.avg_ga,  higher: "lower" },
            { label: "득실차",      va: a.gd,      vb: b.gd,      higher: "higher" },
        ];
        if (a.xg_home != null || b.xg_home != null) {
            metrics.push({ label: "홈 xG(경기당)", va: a.xg_home || 0, vb: b.xg_home || 0, higher: "higher" });
        }

        const host = document.getElementById("tc-bars");
        host.innerHTML = "";
        const rgbA = hexRgb(a.primary, "74,130,199");
        const rgbB = hexRgb(b.primary, "184,126,248");

        metrics.forEach(m => {
            const max = Math.max(Math.abs(m.va), Math.abs(m.vb), 0.0001);
            const pctA = Math.abs(m.va) / max * 100;
            const pctB = Math.abs(m.vb) / max * 100;

            let winner = "none";
            if (m.higher === "higher") {
                winner = m.va > m.vb ? "A" : m.va < m.vb ? "B" : "none";
            } else if (m.higher === "lower") {
                winner = m.va < m.vb ? "A" : m.va > m.vb ? "B" : "none";
            }

            const aWin = winner === "A" ? " tc-bar-side-winner" : "";
            const bWin = winner === "B" ? " tc-bar-side-winner" : "";

            const row = document.createElement("div");
            row.className = "tc-bar-row";
            row.innerHTML = `
                <div class="tc-bar-side tc-bar-side-a${aWin}" style="--tc-team-rgb:${rgbA}">
                    <span class="tc-bar-val ${winner==='A'?'tc-bar-winner':''}" data-target="${m.va}">0</span>
                    <div class="tc-bar-fill" style="width:0"></div>
                </div>
                <div class="tc-bar-label">${m.label}</div>
                <div class="tc-bar-side${bWin}" style="--tc-team-rgb:${rgbB}">
                    <div class="tc-bar-fill" style="width:0"></div>
                    <span class="tc-bar-val ${winner==='B'?'tc-bar-winner':''}" data-target="${m.vb}">0</span>
                </div>`;
            host.appendChild(row);

            // 바 너비 트랜지션 (다음 프레임에 적용해 애니메이션 발동)
            const fills = row.querySelectorAll(".tc-bar-fill");
            requestAnimationFrame(() => {
                fills[0].style.width = pctA + "%";
                fills[1].style.width = pctB + "%";
            });
            // 숫자 카운트업
            const vals = row.querySelectorAll(".tc-bar-val");
            animateCount(vals[0], +m.va || 0);
            animateCount(vals[1], +m.vb || 0);
        });
    }

    function fmtNum(v) {
        if (v == null) return "-";
        if (typeof v !== "number") return String(v);
        if (Number.isInteger(v)) return v.toString();
        return (+v.toFixed(2)).toString();
    }

    // ─── 경기별 뷰 (H2H 맞대결 리스트) ─────────────────────
    function renderMatches(matches) {
        const list  = document.getElementById("tc-matches-list");
        const count = document.getElementById("tc-matches-count");
        if (!list) return;
        list.innerHTML = "";
        const n = (matches || []).length;
        count.textContent = n > 0 ? `${n}경기` : "";
        if (!n) {
            list.innerHTML = `<div class="tc-matches-empty">해당 조건의 맞대결 기록이 없습니다.</div>`;
            return;
        }

        const aId = selA.value;
        const bId = selB.value;
        // teamA의 sofascore 관점에서 결과를 결정하려면 data.teamA 필요, 단순화: is_home_a 플래그 활용

        matches.forEach((m, idx) => {
            const card = document.createElement("div");
            card.className = "tc-match-card tc-match-" + m.result_a.toLowerCase();
            const resultText = m.result_a === "W" ? "승" : m.result_a === "D" ? "무" : "패";
            // 홈/원정 박스 - A가 홈이면 왼쪽이 A
            // 득점자 표시 — goal_events(분 포함) 있으면 "이름 51'", 없으면 폴백("이름 ⚽")
            const fmtScorer = (s) => {
                const nm = escapeHtml(s.name);
                if (s.minute != null) {
                    const t = s.added ? `${s.minute}+${s.added}'` : `${s.minute}'`;
                    const tag = s.og ? ' <span class="tc-scorer-tag tc-scorer-og">OG</span>'
                              : (s.pen ? ' <span class="tc-scorer-tag tc-scorer-pk">PK</span>' : '');
                    return `<span class="tc-scorer">${nm}${tag} <span class="tc-scorer-min">${t}</span></span>`;
                }
                return `<span class="tc-scorer">${nm}${s.goals > 1 ? ` ⚽×${s.goals}` : " ⚽"}</span>`;
            };
            const homeScorerHTML = (m.scorers_home || []).map(fmtScorer).join("");
            const awayScorerHTML = (m.scorers_away || []).map(fmtScorer).join("");

            card.innerHTML = `
                <div class="tc-match-date">${m.date}</div>
                <div class="tc-match-body">
                    <div class="tc-match-team tc-match-team-home">
                        <span class="tc-match-team-name">${escapeHtml(m.home)}</span>
                        <div class="tc-match-scorers">${homeScorerHTML || '<span class="tc-scorer-empty">—</span>'}</div>
                    </div>
                    <div class="tc-match-score">
                        <span class="tc-match-score-num">${m.home_score}</span>
                        <span class="tc-match-score-sep">:</span>
                        <span class="tc-match-score-num">${m.away_score}</span>
                    </div>
                    <div class="tc-match-team tc-match-team-away">
                        <span class="tc-match-team-name">${escapeHtml(m.away)}</span>
                        <div class="tc-match-scorers">${awayScorerHTML || '<span class="tc-scorer-empty">—</span>'}</div>
                    </div>
                </div>
                <div class="tc-match-result tc-match-result-${m.result_a.toLowerCase()}" title="${selA.selectedOptions[0]?.textContent || ''} 기준">${resultText}</div>`;
            card.style.animationDelay = (idx * 0.04) + "s";
            list.appendChild(card);
        });
    }

    function escapeHtml(s) {
        if (s == null) return "";
        return String(s).replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));
    }

    // ─── 리그 순위 비교 (고급 지표 7개) ───────────────────
    function loadRankingsFor(teamA, teamB) {
        const leagues = [...new Set([teamA.league, teamB.league])].filter(Boolean);
        Promise.all(leagues.map(lg => fetchRankings(lg)))
            .then(rs => renderRankings(rs, teamA, teamB))
            .catch(() => renderRankings([], teamA, teamB));
    }

    function fetchRankings(league) {
        const key = `${league}|${currentYear}`;
        if (_rankingsCache.has(key)) {
            return Promise.resolve(_rankingsCache.get(key));
        }
        // in-flight 취소
        if (_rankingsInFlight[league]) _rankingsInFlight[league].abort();
        _rankingsInFlight[league] = new AbortController();
        const yp = currentYear !== "전체" ? `&year=${currentYear}` : "";
        return fetch(`/api/league-rankings?league=${league}${yp}`, { signal: _rankingsInFlight[league].signal })
            .then(r => r.json())
            .then(data => {
                _rankingsCache.set(key, data);
                if (_rankingsCache.size > 20) _rankingsCache.delete(_rankingsCache.keys().next().value);
                return data;
            })
            .catch(err => {
                if (err.name !== "AbortError") console.warn("rankings fetch failed:", err);
                return null;
            });
    }

    function findTeamRank(rankings, teamId) {
        if (!rankings || !rankings.teams) return null;
        return rankings.teams.find(t => t.id === teamId) || null;
    }

    function fmtMetricValue(val, fmt) {
        if (val == null) return "—";
        if (fmt === "pct1")   return (+val).toFixed(1) + "%";
        if (fmt === "ratio2") return (+val).toFixed(2);
        if (fmt === "num2")   return (+val).toFixed(2);
        if (fmt === "num1")   return (+val).toFixed(1);
        return String(val);
    }

    // 순위를 색상 등급으로 — 상위 20% = 골드, 상위 50% = 민트, 하위 20% = 로즈, 중간 = 중립
    function rankTone(rank, total) {
        if (rank == null || !total) return "neutral";
        const pct = rank / total;
        if (pct <= 0.2) return "gold";
        if (pct <= 0.5) return "mint";
        if (pct >= 0.8) return "rose";
        return "neutral";
    }

    function renderRankings(rankingsList, teamA, teamB) {
        const host  = document.getElementById("tc-rank-rows");
        const scope = document.getElementById("tc-rank-scope");
        if (!host) return;

        // 팀A, 팀B 각 리그에 맞는 rankings 찾기
        const rankA = rankingsList.find(r => r && r.league === teamA.league);
        const rankB = rankingsList.find(r => r && r.league === teamB.league);
        // metrics 메타 (둘 중 먼저 있는 것)
        const metrics = (rankA && rankA.metrics) || (rankB && rankB.metrics) || [];

        // scope 문구
        const scopeText = teamA.league === teamB.league
            ? `${teamA.league} · ${currentYear}`
            : `${teamA.league}/${teamB.league} · ${currentYear}`;
        scope.textContent = scopeText;

        if (!metrics.length) {
            host.innerHTML = `<div class="tc-rank-empty">리그 순위 데이터를 불러오지 못했습니다.</div>`;
            return;
        }

        const teamAInRank = rankA ? findTeamRank(rankA, teamA.id) : null;
        const teamBInRank = rankB ? findTeamRank(rankB, teamB.id) : null;
        const totalsA = (rankA && rankA.totals) || {};
        const totalsB = (rankB && rankB.totals) || {};

        host.innerHTML = "";
        metrics.forEach((m, idx) => {
            const vA    = teamAInRank && teamAInRank.values ? teamAInRank.values[m.key] : null;
            const rA    = teamAInRank && teamAInRank.ranks  ? teamAInRank.ranks[m.key]  : null;
            const totA  = totalsA[m.key] || 0;
            const eligA = teamAInRank ? teamAInRank.eligible : false;

            const vB    = teamBInRank && teamBInRank.values ? teamBInRank.values[m.key] : null;
            const rB    = teamBInRank && teamBInRank.ranks  ? teamBInRank.ranks[m.key]  : null;
            const totB  = totalsB[m.key] || 0;
            const eligB = teamBInRank ? teamBInRank.eligible : false;

            // 두 팀 중 더 잘한 쪽 (값 기준 — direction에 따라)
            let winner = "none";
            if (vA != null && vB != null) {
                if (m.direction === "higher") winner = vA > vB ? "A" : vA < vB ? "B" : "none";
                else                           winner = vA < vB ? "A" : vA > vB ? "B" : "none";
            }

            const toneA = rankTone(rA, totA);
            const toneB = rankTone(rB, totB);

            const rankBadge = (rank, total, elig, val, league) => {
                if (rank != null && elig) {
                    const tone = rankTone(rank, total);
                    return `<span class="tc-rank-badge tc-rank-tone-${tone}">${league} ${rank}위/${total}</span>`;
                }
                if (!elig)       return `<span class="tc-rank-badge tc-rank-tone-na">샘플 부족</span>`;
                if (val == null) return `<span class="tc-rank-badge tc-rank-tone-na">데이터 없음</span>`;
                return `<span class="tc-rank-badge tc-rank-tone-na">순위 미집계</span>`;
            };

            const rowA = `
                <div class="tc-rank-cell tc-rank-cell-a ${winner==='A'?'tc-rank-winner':''}">
                    <span class="tc-rank-val">${fmtMetricValue(vA, m.format)}</span>
                    ${rankBadge(rA, totA, eligA, vA, teamA.league)}
                </div>`;
            const rowB = `
                <div class="tc-rank-cell tc-rank-cell-b ${winner==='B'?'tc-rank-winner':''}">
                    <span class="tc-rank-val">${fmtMetricValue(vB, m.format)}</span>
                    ${rankBadge(rB, totB, eligB, vB, teamB.league)}
                </div>`;

            const row = document.createElement("div");
            row.className = "tc-rank-row";
            row.style.animationDelay = (idx * 0.05) + "s";
            const arrow = m.direction === "higher" ? "↑" : "↓";
            row.innerHTML = `
                ${rowA}
                <div class="tc-rank-metric">
                    <span class="tc-rank-metric-name">${escapeHtml(m.label)}</span>
                    <span class="tc-rank-metric-dir" title="${m.direction === 'higher' ? '클수록 좋음' : '작을수록 좋음'}">${arrow}</span>
                </div>
                ${rowB}`;
            host.appendChild(row);
        });

        // 선제득점 카드 (D) — rankings 데이터 재사용 (공수밸런스 산점도는 중복으로 제거됨)
        renderFirstGoal(rankingsList, teamA, teamB);
    }

    // ─── D. 선제득점 / 선제실점 후 성적 카드 ─────────────
    function renderFirstGoal(rankingsList, teamA, teamB) {
        const host = document.getElementById("tc-first-goal-grid");
        if (!host) return;
        const rankA = rankingsList.find(r => r && r.league === teamA.league);
        const rankB = rankingsList.find(r => r && r.league === teamB.league);
        const tA = rankA ? rankA.teams.find(t => t.id === teamA.id) : null;
        const tB = rankB ? rankB.teams.find(t => t.id === teamB.id) : null;
        const totalsA = (rankA && rankA.totals) || {};
        const totalsB = (rankB && rankB.totals) || {};

        const card = (team, tData, totals, league) => {
            if (!tData) return `<div class="tc-fg-card tc-fg-empty">
                <div class="tc-fg-team">${escapeHtml(team.short || team.name)}</div>
                <div class="tc-fg-na">데이터 없음</div>
            </div>`;
            const fgVal = tData.values.first_goal_win_pct;
            const fcVal = tData.values.first_conceded_win_pct;
            const fgRank = tData.ranks.first_goal_win_pct;
            const fcRank = tData.ranks.first_conceded_win_pct;
            const fgGames = (tData.extras && tData.extras.first_goal_games) || 0;
            const fcGames = (tData.extras && tData.extras.first_conceded_games) || 0;
            const avgMin  = (tData.extras && tData.extras.first_goal_avg_min);

            const renderRow = (label, val, rank, total, sample) => {
                if (val == null) {
                    return `<div class="tc-fg-row">
                        <div class="tc-fg-row-label">${label}</div>
                        <div class="tc-fg-row-val tc-fg-na-text">— <span class="tc-fg-sample">(샘플 ${sample}경기)</span></div>
                    </div>`;
                }
                const tone = rankTone(rank, total);
                return `<div class="tc-fg-row">
                    <div class="tc-fg-row-label">${label}</div>
                    <div class="tc-fg-row-val">
                        <span class="tc-fg-pct">${val.toFixed(1)}%</span>
                        <span class="tc-fg-sub">${sample}경기</span>
                        ${rank != null ? `<span class="tc-rank-badge tc-rank-tone-${tone}">${league} ${rank}위/${total}</span>` : ''}
                    </div>
                </div>`;
            };

            return `<div class="tc-fg-card" style="--tc-fg-color: ${team.primary || '#4a82c7'}">
                <div class="tc-fg-team">${escapeHtml(team.short || team.name)}</div>
                ${renderRow("선제득점 시 승률", fgVal, fgRank, totals.first_goal_win_pct || 0, fgGames)}
                ${renderRow("선제실점 후 승률", fcVal, fcRank, totals.first_conceded_win_pct || 0, fcGames)}
                <div class="tc-fg-meta">
                    첫 득점 평균 시간: <strong>${avgMin != null ? avgMin.toFixed(1) + '분' : '—'}</strong>
                </div>
            </div>`;
        };

        host.innerHTML = card(teamA, tA, totalsA, teamA.league) + card(teamB, tB, totalsB, teamB.league);
    }

    // ─── H. 공수 밸런스 산점도 ──────────────────────────
    function renderBalance(rankingsList, teamA, teamB) {
        const el = document.getElementById("tc-balance");
        const scope = document.getElementById("tc-balance-scope");
        if (!el) return;

        // 리그가 같으면 하나의 리그 전체 점, 다르면 양쪽 리그 전체 (라벨 구분)
        const crossLeague = teamA.league !== teamB.league;
        scope.textContent = crossLeague
            ? `${teamA.league} + ${teamB.league} · ${currentYear}`
            : `${teamA.league} · ${currentYear}`;

        // 모든 팀 좌표 수집
        const leaguePoints = {}; // league → [{x, y, name, id, primary}]
        let leagueAvg = {};      // league → {x, y}

        rankingsList.forEach(rk => {
            if (!rk) return;
            const pts = [];
            let sumX = 0, sumY = 0, n = 0;
            rk.teams.forEach(t => {
                const x = t.values.gf_per_game;
                const y = t.values.ga_per_game;
                if (x == null || y == null) return;
                pts.push({ x, y, name: t.short || t.name, id: t.id, primary: t.primary });
                sumX += x; sumY += y; n++;
            });
            leaguePoints[rk.league] = pts;
            if (n > 0) leagueAvg[rk.league] = { x: sumX / n, y: sumY / n };
        });

        // 두 팀 좌표
        const findPt = (leagueCode, teamId) =>
            (leaguePoints[leagueCode] || []).find(p => p.id === teamId);
        const ptA = findPt(teamA.league, teamA.id);
        const ptB = findPt(teamB.league, teamB.id);

        const bgPoints = [];
        Object.entries(leaguePoints).forEach(([lg, pts]) => {
            pts.forEach(p => {
                if (p.id !== teamA.id && p.id !== teamB.id) bgPoints.push(p);
            });
        });
        // 평균선 (리그 통합 평균)
        const avgs = Object.values(leagueAvg);
        const avgX = avgs.length ? avgs.reduce((s,a)=>s+a.x,0)/avgs.length : 0;
        const avgY = avgs.length ? avgs.reduce((s,a)=>s+a.y,0)/avgs.length : 0;

        const datasets = [
            {
                label: "리그 전 팀",
                data: bgPoints,
                backgroundColor: "rgba(160, 170, 185, 0.45)",
                borderColor: "rgba(160, 170, 185, 0.7)",
                pointRadius: 4,
                pointHoverRadius: 6,
            },
        ];
        if (ptA) datasets.push({
            label: teamA.short || teamA.name,
            data: [ptA],
            backgroundColor: teamA.primary || "#4a82c7",
            borderColor: "#fff",
            borderWidth: 2,
            pointRadius: 10,
            pointHoverRadius: 13,
        });
        if (ptB) datasets.push({
            label: teamB.short || teamB.name,
            data: [ptB],
            backgroundColor: teamB.primary || "#e06d4f",
            borderColor: "#fff",
            borderWidth: 2,
            pointRadius: 10,
            pointHoverRadius: 13,
            pointStyle: "triangle",
        });

        if (balanceChart) {
            balanceChart.data.datasets = datasets;
            balanceChart.options.plugins.annotation = quadrantAnno(avgX, avgY);
            balanceChart.update();
            return;
        }

        balanceChart = new Chart(el, {
            type: "scatter",
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 500 },
                scales: {
                    x: {
                        title: { display: true, text: "경기당 득점 →", color: "#9fb0c8", font: { weight: 600 } },
                        min: 0,
                        ticks: { color: "#8a9fb8", font: { weight: 600 } },
                        grid: { color: "rgba(255,255,255,0.07)" },
                    },
                    y: {
                        title: { display: true, text: "← 경기당 실점 (낮을수록 좋음)", color: "#9fb0c8", font: { weight: 600 } },
                        min: 0,
                        reverse: true,
                        ticks: { color: "#8a9fb8", font: { weight: 600 } },
                        grid: { color: "rgba(255,255,255,0.07)" },
                    },
                },
                plugins: {
                    legend: { labels: { color: "#cdd8e8", font: { weight: 600 }, usePointStyle: true, padding: 12 } },
                    tooltip: {
                        backgroundColor: "#ffffff",
                        borderColor: "rgba(74,130,199,0.35)",
                        borderWidth: 1,
                        titleColor: "#cdd8e8",
                        bodyColor: "#cdd8e8",
                        callbacks: {
                            label: (c) => {
                                const p = c.raw;
                                return `${p.name}  득 ${p.x.toFixed(2)} / 실 ${p.y.toFixed(2)}`;
                            }
                        }
                    }
                },
            }
        });
        // 사분면 평균선은 커스텀 플러그인 없이 Chart.js 내장으로는 annotation plugin 필요 → 텍스트 라벨은 생략
        // (간소화: 배경점 + 하이라이트 2팀으로 "공격형/수비형" 위치 충분히 전달)
    }

    function quadrantAnno(avgX, avgY) { return {}; }

    // ─── B. 폼 스파크라인 (최근 10경기 PPG 이동평균) ─────
    function renderFormSparkline(side, trendData, teamInfo) {
        const host = document.getElementById(`tc-form-row-${side.toLowerCase()}`);
        if (!host) return;

        const matches = (trendData && trendData.matches) || [];
        const recent = matches.slice(-10);  // 최근 10경기
        const recent5 = matches.slice(-5);  // 최근 5 W/D/L 뱃지

        // 최근 5경기 PPG → 직전 5경기 PPG 비교로 상승/하락 판정
        const avg = (arr) => arr.length ? arr.reduce((s,m)=>s+m.pts,0)/arr.length : 0;
        const last5ppg = avg(recent5);
        const prev5 = matches.slice(-10, -5);
        const prev5ppg = avg(prev5);
        let trend = "→";
        let trendCls = "flat";
        if (last5ppg > prev5ppg + 0.2) { trend = "↑"; trendCls = "up"; }
        else if (last5ppg < prev5ppg - 0.2) { trend = "↓"; trendCls = "down"; }

        // 이동평균 (3경기) 라인 차트용 데이터
        const ppgSeries = [];
        for (let i = 0; i < recent.length; i++) {
            const win = recent.slice(Math.max(0, i - 2), i + 1);
            ppgSeries.push(win.reduce((s,m)=>s+m.pts,0) / win.length);
        }

        // W/D/L 배지 (최근 5)
        const badges = recent5.map(m => {
            return `<span class="tc-form-badge tc-form-${m.result}">${m.result}</span>`;
        }).join("");

        host.innerHTML = `
            <div class="tc-form-team-header">
                <span class="tc-form-team-name" style="color:${teamInfo.primary || '#4a82c7'}">${escapeHtml(teamInfo.short || teamInfo.name || '')}</span>
                <div class="tc-form-badges">${badges || '<span class="tc-scorer-empty">경기 없음</span>'}</div>
            </div>
            <div class="tc-form-spark-row">
                <canvas class="tc-form-spark" id="tc-form-spark-${side}" width="160" height="38"></canvas>
                <span class="tc-form-ppg">PPG <strong>${last5ppg.toFixed(2)}</strong></span>
                <span class="tc-form-trend tc-form-trend-${trendCls}" title="직전 5경기 대비">${trend}</span>
            </div>
        `;

        // mini line chart
        const canvas = document.getElementById(`tc-form-spark-${side}`);
        if (!canvas || !ppgSeries.length) return;

        const color = teamInfo.primary || (side === "A" ? "#4a82c7" : "#e06d4f");
        if (_sparkCharts[side]) {
            _sparkCharts[side].data.labels = ppgSeries.map((_, i) => i + 1);
            _sparkCharts[side].data.datasets[0].data = ppgSeries;
            _sparkCharts[side].data.datasets[0].borderColor = color;
            _sparkCharts[side].update();
            return;
        }
        _sparkCharts[side] = new Chart(canvas, {
            type: "line",
            data: {
                labels: ppgSeries.map((_, i) => i + 1),
                datasets: [{
                    data: ppgSeries,
                    borderColor: color,
                    backgroundColor: color + "33",
                    fill: true,
                    tension: 0.35,
                    pointRadius: 0,
                    borderWidth: 2,
                }]
            },
            options: {
                responsive: false,
                maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: { x: { display: false }, y: { display: false, min: 0, max: 3 } }
            }
        });
    }

    // ─── A. 시즌 득/실 트렌드 라인차트 ──────────────────
    function renderTrend(trendA, trendB, teamA, teamB) {
        const el = document.getElementById("tc-trend");
        const scope = document.getElementById("tc-trend-scope");
        if (!el) return;

        // 두 팀 경기 날짜를 통합해 x축으로
        const matchesA = (trendA && trendA.matches) || [];
        const matchesB = (trendB && trendB.matches) || [];
        scope.textContent = `${currentYear} · A ${matchesA.length}경기 · B ${matchesB.length}경기`;

        // 경기 번호(시퀀스)를 x축으로 사용 (날짜 통합 대신 각 팀의 경기 순서)
        const maxN = Math.max(matchesA.length, matchesB.length);
        const labels = Array.from({ length: maxN }, (_, i) => i + 1);

        const colorA = teamA.primary || "#4a82c7";
        const colorB = teamB.primary || "#e06d4f";

        const datasets = [
            {
                label: `${teamA.short} 득점`,
                data: matchesA.map(m => m.gf),
                borderColor: colorA,
                backgroundColor: colorA + "22",
                borderWidth: 2.5,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 5,
            },
            {
                label: `${teamA.short} 실점`,
                data: matchesA.map(m => m.ga),
                borderColor: colorA,
                backgroundColor: "transparent",
                borderWidth: 1.5,
                borderDash: [5, 4],
                tension: 0.35,
                pointRadius: 2,
                pointHoverRadius: 4,
            },
            {
                label: `${teamB.short} 득점`,
                data: matchesB.map(m => m.gf),
                borderColor: colorB,
                backgroundColor: colorB + "22",
                borderWidth: 2.5,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 5,
            },
            {
                label: `${teamB.short} 실점`,
                data: matchesB.map(m => m.ga),
                borderColor: colorB,
                backgroundColor: "transparent",
                borderWidth: 1.5,
                borderDash: [5, 4],
                tension: 0.35,
                pointRadius: 2,
                pointHoverRadius: 4,
            },
        ];

        if (trendChart) {
            trendChart.data.labels = labels;
            trendChart.data.datasets = datasets;
            trendChart.options.scales.x.title.text = "경기 순서 →";
            trendChart.update();
            return;
        }

        trendChart = new Chart(el, {
            type: "line",
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 600 },
                plugins: {
                    legend: { labels: { color: "#cdd8e8", font: { weight: 600 }, usePointStyle: true, padding: 12 } },
                    tooltip: {
                        backgroundColor: "#ffffff",
                        borderColor: "rgba(74,130,199,0.35)",
                        borderWidth: 1,
                        titleColor: "#cdd8e8",
                        bodyColor: "#cdd8e8",
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: "경기 순서 →", color: "#9fb0c8", font: { weight: 600 } },
                        ticks: { color: "#8a9fb8", maxTicksLimit: 10, font: { weight: 600 } },
                        grid: { color: "rgba(255,255,255,0.06)" },
                    },
                    y: {
                        title: { display: true, text: "골", color: "#9fb0c8", font: { weight: 600 } },
                        beginAtZero: true,
                        ticks: { color: "#8a9fb8", stepSize: 1, font: { weight: 600 } },
                        grid: { color: "rgba(255,255,255,0.07)" },
                    },
                }
            }
        });
    }

    // ─── 트렌드 데이터 병렬 로드 + 렌더 ─────────────────
    function loadTrendFor(teamA, teamB) {
        Promise.all([fetchTrend(teamA.id), fetchTrend(teamB.id)])
            .then(([trA, trB]) => {
                renderTrend(trA, trB, teamA, teamB);
                renderFormSparkline("A", trA, teamA);
                renderFormSparkline("B", trB, teamB);
            })
            .catch(() => {});
    }

    function fetchTrend(teamId) {
        const key = `${teamId}|${currentYear}`;
        if (_trendCache.has(key)) return Promise.resolve(_trendCache.get(key));

        if (_trendInFlight[teamId]) _trendInFlight[teamId].abort();
        _trendInFlight[teamId] = new AbortController();

        const yp = currentYear !== "전체" ? `&year=${currentYear}` : "";
        return fetch(`/api/team-trend?teamId=${teamId}${yp}`, { signal: _trendInFlight[teamId].signal })
            .then(r => r.json())
            .then(data => {
                _trendCache.set(key, data);
                if (_trendCache.size > 40) _trendCache.delete(_trendCache.keys().next().value);
                return data;
            })
            .catch(err => {
                if (err.name === "AbortError") return null;
                return { matches: [] };
            });
    }
})();
