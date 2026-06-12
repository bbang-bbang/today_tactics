// K리그 선수 히트맵 모달 (K1/K2 토글)
(function () {
    const modal       = document.getElementById("k2-heatmap-modal");
    const btnOpen     = document.getElementById("btn-k2-heatmap");
    const btnClose    = document.getElementById("k2-heatmap-close");
    const backdrop    = modal.querySelector(".modal-backdrop");

    const stepTeam    = document.getElementById("k2-step-team");
    const stepPlayer  = document.getElementById("k2-step-player");
    const stepHeatmap = document.getElementById("k2-step-heatmap");

    const teamGrid    = document.getElementById("k2-team-grid");
    const playerList  = document.getElementById("k2-player-list");
    const matchList   = document.getElementById("k2-match-list");

    const backTeam    = document.getElementById("k2-back-team");
    const backPlayer  = document.getElementById("k2-back-player");

    const selTeamName   = document.getElementById("k2-selected-team-name");
    const selPlayerName = document.getElementById("k2-selected-player-name");
    const loading       = document.getElementById("k2-heatmap-loading");
    const canvas        = document.getElementById("k2-heatmap-canvas");
    const ctx           = canvas.getContext("2d");
    const leagueTabs    = document.querySelectorAll("#heatmap-league-tabs .hm-league-tab");

    let currentLeague = "k1";  // 기본 K리그1
    let currentTeam   = null;  // { sofascore_id, name, primary }
    let currentPlayer = null;  // { playerId, name }
    let allMatches    = [];

    // ── 비교 오버레이 상태 ──
    let currentBasePoints = [];   // 화면에 그려지는 내 선수 좌표 (비교 시 빨강 층)
    let cumulativePoints  = [];   // 선수 누적 좌표 (모드 전환 시 base 복원용)
    let compareMode   = "none";   // none | position | player | venue
    let overlayPoints = null;     // 비교 대상 좌표 (파랑 층)
    let baseLabel     = "";
    let overlayLabel  = "";
    let currentYear   = null;     // null/"all" = 전 시즌, "2026" 등 = 해당 시즌만
    let currentSeasons = [];
    let currentPlayerDetail = null;  // 선수 본인 세부 포지션 그룹(선택 시즌 기준) — 비교 기본값

    const yearFilter = document.getElementById("k2-year-filter");
    const yearQS = () => (currentYear ? `&year=${currentYear}` : "");
    const cmpModes  = document.querySelectorAll(".k2-cmp-mode");
    const cmpSub    = document.getElementById("k2-cmp-sub");
    const cmpLegend = document.getElementById("k2-cmp-legend");
    const cmpInsight   = document.getElementById("k2-cmp-insight");
    const quickSearch  = document.getElementById("k2-quick-search");
    const quickResults = document.getElementById("k2-quick-results");
    const POS_LABEL = { G:"GK", D:"DF", M:"MF", F:"FW" };
    // 세부 포지션 그룹 (서버 detail 토큰과 일치) — 비교 필터 세분화
    const DETAIL_LABEL = {
        GK:"골키퍼", CB:"센터백", FB:"풀백·윙백", DM:"수비형 MF",
        CM:"중앙 MF", AM:"공격형 MF", W:"윙어", ST:"스트라이커"
    };
    const DETAIL_ORDER = ["GK","CB","FB","DM","CM","AM","W","ST"];
    // 대분류(G/D/M/F) → 그 안의 세부 그룹 (기본값 폴백용)
    const POS_TO_DETAILS = {
        G:["GK"], D:["CB","FB"], M:["DM","CM","AM"], F:["W","ST"]
    };
    const RED  = [255, 60, 30];
    const BLUE = [40, 120, 255];
    // 히트맵 점을 경기장(라인 5~95%) 안쪽으로 매핑 — 살짝 더 들여 경기장보다 작게
    const FIELD_PAD = 0.06, FIELD_SPAN = 0.88;
    const fieldX = (x, W) => (FIELD_PAD + (x / 100) * FIELD_SPAN) * W;
    const fieldY = (y, H) => (FIELD_PAD + (y / 100) * FIELD_SPAN) * H;

    const apiBase = () => `/api/kleague${currentLeague === "k1" ? "1" : "2"}`;

    // ── 열기/닫기 ──────────────────────────────────────────
    // 히트맵 뷰 초기화 (팀 그리드 로드 + 검색 포커스). 워크스페이스 탭 최초 노출 시 호출.
    let _viewInited = false;
    function initView() {
        modal.classList.remove("hidden");
        if (!_viewInited) {
            _viewInited = true;
            showStep("team");
            loadTeams();
        }
        if (quickSearch) setTimeout(() => quickSearch.focus(), 60);
    }
    // 워크스페이스(workspace.js)에서 탭 노출 시 호출 — 레거시 버튼(btnOpen)도 있으면 지원
    window.initK2HeatmapView = initView;
    if (btnOpen) btnOpen.addEventListener("click", initView);
    // 인라인 패널에서는 backdrop/닫기 버튼이 CSS로 숨겨짐 — 존재 시에만 바인딩(레거시 모달 호환)
    [btnClose, backdrop].forEach(el =>
        el && el.addEventListener("click", () => modal.classList.add("hidden"))
    );
    backTeam.addEventListener("click",   () => showStep("team"));
    backPlayer.addEventListener("click", () => showStep("player"));

    leagueTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            if (tab.classList.contains("active")) return;
            leagueTabs.forEach(t => t.classList.toggle("active", t === tab));
            currentLeague = tab.dataset.league;
            currentTeam = null;
            currentPlayer = null;
            showStep("team");
            loadTeams();
        });
    });

    function showStep(step) {
        stepTeam.classList.toggle("hidden",    step !== "team");
        stepPlayer.classList.toggle("hidden",  step !== "player");
        stepHeatmap.classList.toggle("hidden", step !== "heatmap");
    }

    // ── 팀 목록 ─────────────────────────────────────────────
    let _teamLoadSeq = 0;
    async function loadTeams() {
        const seq = ++_teamLoadSeq;           // 리그 빠른 전환 시 늦게 끝난 응답이 덮어쓰지 않게 가드
        const league = currentLeague;
        teamGrid.innerHTML = "<p style='color:#aaa'>로딩 중...</p>";
        const res  = await fetch(`${apiBase()}/teams`);
        const teams = await res.json();
        if (seq !== _teamLoadSeq) return;     // 그 사이 다른 리그 클릭됨 → 이 응답 폐기
        teamGrid.innerHTML = "";
        teams.forEach(t => {
            const el = document.createElement("div");
            el.className = "k2-team-card";
            el.innerHTML = `
                <img src="/static/img/emblems/${t.emblem}" onerror="this.style.display='none'">
                <span>${t.short}</span>`;
            el.style.borderColor = t.primary;
            el.addEventListener("click", () => selectTeam(t));
            teamGrid.appendChild(el);
        });
    }

    // ── 선수 검색 핸들러 ─────────────────────────────────────
    let _allPlayerRows = [];  // {el, name, pos} — selectTeam 후 채워짐
    const searchInput  = document.getElementById("k2-player-search");
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            const q = searchInput.value.trim().toLowerCase();
            _allPlayerRows.forEach(({ el, name }) => {
                const match = !q || name.toLowerCase().includes(q);
                el.style.display = match ? "" : "none";
            });
            // 포지션 헤더도 표시/숨김 (해당 포지션 선수가 모두 숨으면 헤더도 숨김)
            playerList.querySelectorAll(".k2-pos-header").forEach(hdr => {
                let sib = hdr.nextElementSibling;
                let any = false;
                while (sib && !sib.classList.contains("k2-pos-header")) {
                    if (sib.style.display !== "none") { any = true; break; }
                    sib = sib.nextElementSibling;
                }
                hdr.style.display = any ? "" : "none";
            });
        });
    }

    // ── 팀 선택 → 선수 목록 ──────────────────────────────────
    async function selectTeam(team) {
        currentTeam = team;
        selTeamName.textContent = team.name;
        playerList.innerHTML = "<p style='color:#aaa'>로딩 중...</p>";
        if (searchInput) { searchInput.value = ""; }
        _allPlayerRows = [];
        showStep("player");

        const res     = await fetch(`${apiBase()}/players?teamId=${team.sofascore_id}`);
        const players = await res.json();
        playerList.innerHTML = "";

        const positions = ["G", "D", "M", "F"];
        const grouped = {};
        positions.forEach(p => grouped[p] = []);
        players.forEach(p => {
            const pos = grouped[p.position] ? p.position : "M";
            grouped[pos].push(p);
        });

        positions.forEach(pos => {
            if (!grouped[pos].length) return;
            const label = { G:"GK", D:"DF", M:"MF", F:"FW" }[pos];
            const pc = "pos-" + pos.toLowerCase();
            const header = document.createElement("div");
            header.className = "k2-pos-header " + pc;
            header.innerHTML = `${label}<span class="k2-pos-count">${grouped[pos].length}</span>`;
            playerList.appendChild(header);

            grouped[pos].forEach(p => {
                const el = document.createElement("div");
                el.className = "k2-player-row " + pc;
                el.innerHTML = `
                    <span class="k2-player-name">${p.name}</span>
                    <span class="k2-player-meta">${p.avgRating ? `<b class="k2-rt">⭐ ${p.avgRating}</b>` : ""}<span class="k2-gm">${p.games}경기</span></span>`;
                el.addEventListener("click", () => selectPlayer(p));
                playerList.appendChild(el);
                _allPlayerRows.push({ el, name: p.name, pos });
            });
        });
    }

    // ── 선수 선택 → 히트맵 ───────────────────────────────────
    async function selectPlayer(player) {
        currentPlayer = player;
        selPlayerName.textContent = player.name;
        showStep("heatmap");
        loading.style.display = "flex";
        matchList.innerHTML = "";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // 선수 컨텍스트 배너
        const ctxArea = document.getElementById("k2-player-context-area");
        if (ctxArea) {
            const posLabel = { G:"GK", D:"DF", M:"MF", F:"FW" }[player.position] || player.position;
            const posClass = { G:"pos-g", D:"pos-d", M:"pos-m", F:"pos-f" }[player.position] || "";
            ctxArea.innerHTML = `<div class="k2-player-context">
                <span class="k2-ctx-pill ${posClass}">${posLabel}</span>
                <span>${currentTeam.name}</span>
                ${player.games ? `<span class="k2-ctx-pill">${player.games}경기</span>` : ""}
                ${player.avgRating ? `<span class="k2-ctx-pill">⭐ ${player.avgRating}</span>` : ""}
            </div>`;
        }

        currentYear = null;   // 새 선수는 전 시즌부터
        const res  = await fetch(`${apiBase()}/heatmap?playerId=${player.playerId}&teamId=${currentTeam.sofascore_id}`);
        const data = await res.json();
        loading.style.display = "none";

        allMatches = data.matches || [];
        cumulativePoints = data.points || [];
        currentSeasons = data.seasons || [];
        currentPlayerDetail = data.detailPos || null;
        baseLabel = player.name;
        // 새 선수 선택 시 비교 모드 초기화
        compareMode = "none";
        overlayPoints = null;
        cmpModes.forEach(b => b.classList.toggle("active", b.dataset.cmp === "none"));
        cmpSub.innerHTML = "";
        renderYearFilter();
        renderMatchList(allMatches, null);
        // 다중 시즌(이적 선수 등)은 '전체 누적'이 과포화 → 최신 시즌을 기본으로
        if (currentSeasons.length > 1) {
            changeYear(currentSeasons[0].year);
        } else {
            setBase(cumulativePoints);
        }
    }

    // ── 경기별 히트맵 ────────────────────────────────────────
    async function loadMatchHeatmap(eventId) {
        if (compareMode === "venue") return;   // 홈vs원정 모드에선 경기 선택 무시
        loading.style.display = "flex";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const res  = await fetch(`${apiBase()}/heatmap?playerId=${currentPlayer.playerId}&teamId=${currentTeam.sofascore_id}&eventId=${eventId}`);
        const data = await res.json();
        loading.style.display = "none";
        baseLabel = currentPlayer.name + " (이 경기)";
        setBase(data.points || []);
    }

    function renderMatchList(matches, activeId) {
        matchList.innerHTML = "";

        // 전체 보기
        const allLi = document.createElement("li");
        allLi.className = "k2-match-item" + (activeId === null ? " active" : "");
        allLi.textContent = "전체 누적";
        allLi.addEventListener("click", async () => {
            if (compareMode === "venue") return;
            renderMatchList(allMatches, null);
            baseLabel = currentPlayer ? currentPlayer.name : baseLabel;
            setBase(cumulativePoints);
        });
        matchList.appendChild(allLi);

        matches.forEach(m => {
            const date = m.datets ? new Date(m.datets * 1000).toLocaleDateString("ko-KR", { month:"numeric", day:"numeric" }) : "";
            const score = (m.homeScore != null && m.awayScore != null) ? `${m.homeScore}:${m.awayScore}` : "-:-";
            const li = document.createElement("li");
            li.className = "k2-match-item" + (activeId === m.id ? " active" : "");
            li.innerHTML = `<span class="k2-match-date">${date}</span> ${m.home} ${score} ${m.away}`;
            li.addEventListener("click", () => {
                renderMatchList(allMatches, m.id);
                loadMatchHeatmap(m.id);
            });
            matchList.appendChild(li);
        });
    }

    // ── 히트맵 그리기 ────────────────────────────────────────
    function drawHeatmap(points) {
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // 잔디 배경
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0,   "#1a4a1a");
        grad.addColorStop(0.5, "#1e5c1e");
        grad.addColorStop(1,   "#1a4a1a");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // 필드 라인
        drawFieldLines(ctx, W, H);

        if (!points.length) return;

        // 히트맵
        const offscreen = document.createElement("canvas");
        offscreen.width = W; offscreen.height = H;
        const off = offscreen.getContext("2d");

        const R = 20;
        points.forEach(p => {
            const x = fieldX(p.x, W);
            const y = fieldY(p.y, H);
            const g = off.createRadialGradient(x, y, 0, x, y, R);
            g.addColorStop(0,   "rgba(255,50,0,0.15)");
            g.addColorStop(1,   "rgba(255,50,0,0)");
            off.fillStyle = g;
            off.beginPath();
            off.arc(x, y, R, 0, Math.PI * 2);
            off.fill();
        });

        // 색상 매핑
        const imgData = off.getImageData(0, 0, W, H);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = d[i + 3] / 255;
            if (v < 0.01) continue;
            const [r, g, b] = heatColor(Math.min(v * 3, 1));
            d[i]     = r;
            d[i + 1] = g;
            d[i + 2] = b;
            d[i + 3] = Math.min(v * 600, 220);
        }
        off.putImageData(imgData, 0, 0);
        ctx.drawImage(offscreen, 0, 0);
    }

    function heatColor(t) {
        if (t < 0.25) return lerp([0,0,255], [0,255,255], t/0.25);
        if (t < 0.5)  return lerp([0,255,255], [0,255,0], (t-0.25)/0.25);
        if (t < 0.75) return lerp([0,255,0], [255,255,0], (t-0.5)/0.25);
        return lerp([255,255,0], [255,0,0], (t-0.75)/0.25);
    }
    function lerp(a, b, t) {
        return a.map((v, i) => Math.round(v + (b[i] - v) * t));
    }

    function drawFieldLines(ctx, W, H) {
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;

        // 외곽
        ctx.strokeRect(W*0.05, H*0.05, W*0.9, H*0.9);
        // 센터라인
        ctx.beginPath(); ctx.moveTo(W*0.5, H*0.05); ctx.lineTo(W*0.5, H*0.95); ctx.stroke();
        // 센터서클
        ctx.beginPath(); ctx.arc(W*0.5, H*0.5, H*0.15, 0, Math.PI*2); ctx.stroke();
        // 페널티 박스 (왼쪽)
        ctx.strokeRect(W*0.05, H*0.2, W*0.18, H*0.6);
        ctx.strokeRect(W*0.05, H*0.33, W*0.08, H*0.34);
        // 페널티 박스 (오른쪽)
        ctx.strokeRect(W*0.77, H*0.2, W*0.18, H*0.6);
        ctx.strokeRect(W*0.87, H*0.33, W*0.08, H*0.34);
    }

    // ── 비교 오버레이 ────────────────────────────────────────
    // base 좌표를 저장하고 현재 모드에 맞게 렌더 (단일 or 듀얼)
    function setBase(points) {
        currentBasePoints = points || [];
        render();
    }
    function render() {
        if (compareMode === "none" || !overlayPoints) {
            cmpLegend.classList.add("hidden");
            cmpInsight.classList.add("hidden");
            drawHeatmap(currentBasePoints);
        } else {
            drawCompare(currentBasePoints, overlayPoints);
            renderLegend();
            renderInsight();
        }
    }

    // 모드 버튼
    cmpModes.forEach(btn => {
        btn.addEventListener("click", () => {
            if (!currentPlayer) return;
            const mode = btn.dataset.cmp;
            cmpModes.forEach(b => b.classList.toggle("active", b === btn));
            compareMode = mode;
            cmpSub.innerHTML = "";
            overlayPoints = null;
            if (mode === "venue") {
                loadVenueCompare();
            } else {
                // 누적 기준 복원 (직전 venue 모드의 홈-only base 등 되돌림)
                baseLabel = currentPlayer.name;
                currentBasePoints = cumulativePoints;
                if (mode === "none")          render();
                else if (mode === "position") buildPositionSub();
                else if (mode === "player")   buildPlayerSub();
            }
        });
    });

    // A. 포지션 평균 — 세부 포지션(8그룹) 비교. 기본값 = 선수 본인 세부 포지션.
    function defaultDetail() {
        if (currentPlayerDetail && DETAIL_LABEL[currentPlayerDetail]) return currentPlayerDetail;
        const cands = POS_TO_DETAILS[currentPlayer && currentPlayer.position] || ["CM"];
        return cands[Math.floor(cands.length / 2)] || cands[0];
    }
    function buildPositionSub() {
        const sel = document.createElement("select");
        sel.className = "k2-cmp-select";
        sel.setAttribute("aria-label", "비교 세부 포지션 선택");
        DETAIL_ORDER.forEach(dp => {
            const o = document.createElement("option");
            o.value = dp; o.textContent = DETAIL_LABEL[dp] + " 평균";
            sel.appendChild(o);
        });
        sel.value = defaultDetail();
        sel.addEventListener("change", () => fetchPositionOverlay(sel.value));
        cmpSub.appendChild(sel);
        fetchPositionOverlay(sel.value);
    }
    async function fetchPositionOverlay(detail) {
        loading.style.display = "flex";
        try {
            const data = await (await fetch(`${apiBase()}/position-heatmap?detail=${detail}${yearQS()}`)).json();
            overlayPoints = data.points || [];
            overlayLabel = (DETAIL_LABEL[detail] || detail) + " 평균";
        } catch (e) { overlayPoints = []; }
        loading.style.display = "none";
        render();
    }

    // B. 다른 선수 (팀 + 선수 2단 선택, 크로스팀 가능)
    async function buildPlayerSub() {
        const teamSel   = document.createElement("select");
        const playerSel = document.createElement("select");
        teamSel.className = playerSel.className = "k2-cmp-select";
        teamSel.setAttribute("aria-label", "비교 팀 선택");
        playerSel.setAttribute("aria-label", "비교 선수 선택");
        playerSel.innerHTML = "<option value=''>선수…</option>";
        cmpSub.appendChild(teamSel);
        cmpSub.appendChild(playerSel);

        const teams = await (await fetch(`${apiBase()}/teams`)).json();
        teamSel.innerHTML = "";
        teams.forEach(t => {
            const o = document.createElement("option");
            o.value = t.sofascore_id;
            o.textContent = t.short || t.name;
            teamSel.appendChild(o);
        });
        teamSel.value = currentTeam.sofascore_id;

        async function loadPlayers() {
            playerSel.innerHTML = "<option value=''>선수…</option>";
            const pls = await (await fetch(`${apiBase()}/players?teamId=${teamSel.value}`)).json();
            pls.forEach(p => {
                if (String(teamSel.value) === String(currentTeam.sofascore_id) &&
                    p.playerId === currentPlayer.playerId) return;  // 자기 자신 제외
                const o = document.createElement("option");
                o.value = p.playerId;
                o.dataset.name = p.name;
                o.textContent = `${p.name}${p.position ? " ("+(POS_LABEL[p.position]||p.position)+")" : ""}`;
                playerSel.appendChild(o);
            });
        }
        teamSel.addEventListener("change", loadPlayers);
        playerSel.addEventListener("change", async () => {
            if (!playerSel.value) { overlayPoints = null; render(); return; }
            const nm = playerSel.options[playerSel.selectedIndex].dataset.name;
            loading.style.display = "flex";
            try {
                const data = await (await fetch(`${apiBase()}/heatmap?playerId=${playerSel.value}&teamId=${teamSel.value}${yearQS()}`)).json();
                overlayPoints = data.points || [];
                overlayLabel = nm;
            } catch (e) { overlayPoints = []; }
            loading.style.display = "none";
            render();
        });
        await loadPlayers();
    }

    // C. 홈 vs 원정 (같은 선수)
    async function loadVenueCompare() {
        loading.style.display = "flex";
        const url = `${apiBase()}/heatmap?playerId=${currentPlayer.playerId}&teamId=${currentTeam.sofascore_id}${yearQS()}`;
        try {
            const [hp, ap] = await Promise.all([
                fetch(`${url}&venue=home`).then(r => r.json()),
                fetch(`${url}&venue=away`).then(r => r.json()),
            ]);
            currentBasePoints = hp.points || [];
            overlayPoints     = ap.points || [];
            baseLabel    = `${currentPlayer.name} (홈)`;
            overlayLabel = `${currentPlayer.name} (원정)`;
        } catch (e) { overlayPoints = []; }
        loading.style.display = "none";
        render();
    }

    // 듀얼 컬러 오버레이 렌더 (빨강=base, 파랑=overlay, 보라=겹침)
    function drawCompare(basePts, overPts) {
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "#1a4a1a");
        grad.addColorStop(0.5, "#1e5c1e");
        grad.addColorStop(1, "#1a4a1a");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
        drawFieldLines(ctx, W, H);

        const comp = document.createElement("canvas");
        comp.width = W; comp.height = H;
        const c = comp.getContext("2d");
        const rl = renderLayer(basePts, RED, W, H);
        const bl = renderLayer(overPts, BLUE, W, H);
        if (rl) c.drawImage(rl, 0, 0);
        c.globalCompositeOperation = "lighter";   // 겹치면 빨강+파랑 → 보라
        if (bl) c.drawImage(bl, 0, 0);
        ctx.drawImage(comp, 0, 0);
    }

    // 한 층을 단색 밀도 필드로 렌더 — 각 층 자기 피크로 정규화(표본 크기 무관 공정 비교)
    function renderLayer(points, rgb, W, H) {
        if (!points || !points.length) return null;
        const off = document.createElement("canvas");
        off.width = W; off.height = H;
        const o = off.getContext("2d");
        const R = 22;
        points.forEach(p => {
            const x = fieldX(p.x, W), y = fieldY(p.y, H);
            const g = o.createRadialGradient(x, y, 0, x, y, R);
            g.addColorStop(0, "rgba(0,0,0,0.12)");
            g.addColorStop(1, "rgba(0,0,0,0)");
            o.fillStyle = g;
            o.beginPath(); o.arc(x, y, R, 0, Math.PI * 2); o.fill();
        });
        const img = o.getImageData(0, 0, W, H), d = img.data;
        let maxA = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > maxA) maxA = d[i];
        if (!maxA) return null;
        for (let i = 0; i < d.length; i += 4) {
            const norm = d[i + 3] / maxA;
            if (norm < 0.05) { d[i + 3] = 0; continue; }
            d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
            d[i + 3] = Math.round(Math.min(norm, 1) * 200);
        }
        o.putImageData(img, 0, 0);
        return off;
    }

    function renderLegend() {
        cmpLegend.classList.remove("hidden");
        cmpLegend.innerHTML =
            `<span class="k2-lg"><i style="background:rgb(${RED.join(",")})"></i>${baseLabel}</span>` +
            `<span class="k2-lg"><i style="background:rgb(${BLUE.join(",")})"></i>${overlayLabel}</span>` +
            `<span class="k2-lg"><i style="background:rgb(170,70,200)"></i>겹침</span>`;
    }

    // 비교 인사이트 배너 — 두 좌표군의 차이를 자동 해석 (x=공격방향, y=세로 폭)
    function pointStats(pts) {
        if (!pts || !pts.length) return null;
        let sx = 0, sy = 0;
        for (const p of pts) { sx += p.x; sy += p.y; }
        const n = pts.length, mx = sx / n, my = sy / n;
        let vy = 0;
        for (const p of pts) vy += (p.y - my) * (p.y - my);
        return { mx, my, spreadY: Math.sqrt(vy / n) };
    }
    function renderInsight() {
        const b = pointStats(currentBasePoints), o = pointStats(overlayPoints);
        if (!b || !o) { cmpInsight.classList.add("hidden"); return; }
        const chips = [];
        const adv = Math.round(b.mx - o.mx);            // +면 base가 더 전진
        if (adv >= 3)       chips.push(`<b>↑ 전진</b> 평균보다 ${adv}칸 높은 위치`);
        else if (adv <= -3) chips.push(`<b>↓ 후방</b> 평균보다 ${-adv}칸 낮은 위치`);
        else                chips.push(`<b>≈ 전후 위치 유사</b>`);

        const bc = Math.abs(b.my - 50), oc = Math.abs(o.my - 50);
        const side = b.my < 47 ? "위쪽" : (b.my > 53 ? "아래쪽" : "중앙");
        if (bc - oc >= 6)       chips.push(`<b>측면 지향</b> (${side} 치우침)`);
        else if (bc - oc <= -6) chips.push(`<b>중앙 지향</b>`);

        const sd = Math.round(b.spreadY - o.spreadY);
        if (sd >= 4)       chips.push(`활동 폭 넓음`);
        else if (sd <= -4) chips.push(`활동 폭 좁음`);

        cmpInsight.classList.remove("hidden");
        cmpInsight.innerHTML =
            `<span class="k2-ins-title">${baseLabel} vs ${overlayLabel}</span>` +
            chips.map(c => `<span class="k2-ins-chip">${c}</span>`).join("");
    }

    // ── 시즌 필터 ──────────────────────────────────────────
    function renderYearFilter() {
        if (!yearFilter) return;
        yearFilter.innerHTML = "";
        if (currentSeasons.length < 1) { yearFilter.style.display = "none"; return; }  // 데이터 없을 때만 숨김
        yearFilter.style.display = "";
        // 라벨: 시즌 필터임을 명시
        const lbl = document.createElement("span");
        lbl.className = "k2-year-label";
        lbl.textContent = "시즌";
        yearFilter.appendChild(lbl);
        // 전체 버튼
        const allBtn = document.createElement("button");
        allBtn.type = "button";
        allBtn.className = "k2-year-btn" + (!currentYear ? " active" : "");
        allBtn.textContent = "전체";
        allBtn.addEventListener("click", () => changeYear(null));
        yearFilter.appendChild(allBtn);
        // 연도별 + 해당 시즌 소속팀 (이적 선수 구분)
        currentSeasons.forEach(s => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.dataset.year = s.year;
            btn.className = "k2-year-btn" + (s.year === currentYear ? " active" : "");
            btn.innerHTML = `${s.year}${s.team ? `<span class="k2-year-team">${s.team}</span>` : ""}`;
            btn.addEventListener("click", () => changeYear(s.year));
            yearFilter.appendChild(btn);
        });
    }
    async function changeYear(y) {
        if (y === currentYear) return;
        currentYear = y;
        yearFilter.querySelectorAll(".k2-year-btn").forEach(b => {
            const v = b.dataset.year || null;   // 전체 버튼은 dataset 없음 → null
            b.classList.toggle("active", v === currentYear);
        });
        loading.style.display = "flex";
        try {
            const d = await (await fetch(`${apiBase()}/heatmap?playerId=${currentPlayer.playerId}&teamId=${currentTeam.sofascore_id}${yearQS()}`)).json();
            cumulativePoints = d.points || [];
            allMatches = d.matches || [];
            currentPlayerDetail = d.detailPos || null;   // 시즌별 세부 포지션 갱신
        } catch (e) {}
        loading.style.display = "none";
        renderMatchList(allMatches, null);

        if (compareMode === "venue") {
            loadVenueCompare();
        } else if (compareMode === "position") {
            currentBasePoints = cumulativePoints;
            const sel = cmpSub.querySelector("select");
            fetchPositionOverlay(sel ? sel.value : defaultDetail());
        } else if (compareMode === "player") {
            currentBasePoints = cumulativePoints;
            const sels = cmpSub.querySelectorAll("select");
            const psel = sels[1];
            if (psel && psel.value) {
                const nm = psel.options[psel.selectedIndex].dataset.name;
                try {
                    const d2 = await (await fetch(`${apiBase()}/heatmap?playerId=${psel.value}&teamId=${sels[0].value}${yearQS()}`)).json();
                    overlayPoints = d2.points || [];
                    overlayLabel = nm;
                } catch (e) {}
            }
            render();
        } else {
            setBase(cumulativePoints);
        }
    }

    // ── 통합 선수 검색 (전 구단 → 바로 히트맵 진입) ──────────
    let quickTimer = null;
    if (quickSearch) {
        quickSearch.addEventListener("input", () => {
            const q = quickSearch.value.trim();
            clearTimeout(quickTimer);
            if (q.length < 1) { quickResults.classList.add("hidden"); quickResults.innerHTML = ""; return; }
            quickTimer = setTimeout(() => runQuickSearch(q), 200);
        });
        document.addEventListener("click", (e) => {
            if (!e.target.closest("#k2-quick-search-wrap")) quickResults.classList.add("hidden");
        });
    }
    async function runQuickSearch(q) {
        let list = [];
        try { list = await (await fetch(`/api/heatmap-player-search?q=${encodeURIComponent(q)}`)).json(); }
        catch (e) { list = []; }
        quickResults.innerHTML = "";
        if (!list.length) {
            quickResults.innerHTML = `<li class="k2-quick-empty">검색 결과 없음</li>`;
            quickResults.classList.remove("hidden");
            return;
        }
        list.forEach(r => {
            const li = document.createElement("li");
            li.className = "k2-quick-item";
            li.setAttribute("role", "option");
            li.tabIndex = 0;
            li.innerHTML =
                `<span class="k2-quick-name">${r.name}</span>` +
                `<span class="k2-quick-meta">${r.teamShort || r.teamName} · ${POS_LABEL[r.position] || r.position || ""} · ${r.games}경기 · ${r.league.toUpperCase()}</span>`;
            const go = () => jumpToPlayer(r);
            li.addEventListener("click", go);
            li.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
            quickResults.appendChild(li);
        });
        quickResults.classList.remove("hidden");
    }
    function jumpToPlayer(r) {
        quickResults.classList.add("hidden");
        quickSearch.value = "";
        currentLeague = r.league;
        leagueTabs.forEach(t => t.classList.toggle("active", t.dataset.league === r.league));
        currentTeam = { sofascore_id: r.teamId, name: r.teamName, short: r.teamShort, primary: "#888" };
        selTeamName.textContent = r.teamName;
        selectPlayer({ playerId: r.playerId, name: r.name, position: r.position, games: r.games, avgRating: null });
    }
})();
