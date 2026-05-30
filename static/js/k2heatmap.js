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

    const apiBase = () => `/api/kleague${currentLeague === "k1" ? "1" : "2"}`;

    // ── 열기/닫기 ──────────────────────────────────────────
    btnOpen.addEventListener("click", () => {
        modal.classList.remove("hidden");
        showStep("team");
        loadTeams();
    });
    [btnClose, backdrop].forEach(el =>
        el.addEventListener("click", () => modal.classList.add("hidden"))
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
    async function loadTeams() {
        teamGrid.innerHTML = "<p style='color:#aaa'>로딩 중...</p>";
        const res  = await fetch(`${apiBase()}/teams`);
        const teams = await res.json();
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
            const header = document.createElement("div");
            header.className = "k2-pos-header";
            header.textContent = label;
            playerList.appendChild(header);

            grouped[pos].forEach(p => {
                const el = document.createElement("div");
                el.className = "k2-player-row";
                el.innerHTML = `
                    <span class="k2-player-name">${p.name}</span>
                    <span class="k2-player-meta">${p.games}경기 ${p.avgRating ? "⭐"+p.avgRating : ""}</span>`;
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

        const res  = await fetch(`${apiBase()}/heatmap?playerId=${player.playerId}&teamId=${currentTeam.sofascore_id}`);
        const data = await res.json();
        loading.style.display = "none";

        allMatches = data.matches || [];
        drawHeatmap(data.points || []);
        renderMatchList(allMatches, null);
    }

    // ── 경기별 히트맵 ────────────────────────────────────────
    async function loadMatchHeatmap(eventId) {
        loading.style.display = "flex";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const res  = await fetch(`${apiBase()}/heatmap?playerId=${currentPlayer.playerId}&teamId=${currentTeam.sofascore_id}&eventId=${eventId}`);
        const data = await res.json();
        loading.style.display = "none";
        drawHeatmap(data.points || []);
    }

    function renderMatchList(matches, activeId) {
        matchList.innerHTML = "";

        // 전체 보기
        const allLi = document.createElement("li");
        allLi.className = "k2-match-item" + (activeId === null ? " active" : "");
        allLi.textContent = "전체 누적";
        allLi.addEventListener("click", async () => {
            renderMatchList(allMatches, null);
            loading.style.display = "flex";
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const res  = await fetch(`${apiBase()}/heatmap?playerId=${currentPlayer.playerId}&teamId=${currentTeam.sofascore_id}`);
            const data = await res.json();
            loading.style.display = "none";
            drawHeatmap(data.points || []);
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
            const x = (p.x / 100) * W;
            const y = (p.y / 100) * H;
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
})();
