// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
(function () {
    "use strict";

    const matchupArea = document.getElementById("matchup-area");

    let teamsData = [];

    function getTeam(id) { return teamsData.find(t => t.id === id) || null; }

    function formatDate(dateStr) {
        const p = dateStr.split("-");
        return `${p[0]}/${parseInt(p[1])}/${parseInt(p[2])}`;
    }

    function formatShortDate(dateStr) {
        const p = dateStr.split("-");
        return `${parseInt(p[1])}/${parseInt(p[2])}`;
    }

    function calcFormStats(results) {
        let w = 0, d = 0, l = 0;
        results.forEach(r => { if (r.result === "W") w++; else if (r.result === "D") d++; else l++; });
        return { w, d, l };
    }

    function pct(w, games) {
        if (!games) return 0;
        return Math.round((w / games) * 100);
    }

    // ── 최근 5경기 폼 뱃지 ────────────────────────────────
    function buildFormBadges(results) {
        const row = document.createElement("div");
        row.className = "matchup-form-row";
        results.forEach(r => {
            const badge = document.createElement("div");
            badge.className = `form-badge ${r.result}`;

            const resultSpan = document.createElement("span");
            resultSpan.textContent = r.result;

            const dateSpan = document.createElement("span");
            dateSpan.className = "form-badge-date";
            dateSpan.textContent = formatShortDate(r.date);

            badge.appendChild(resultSpan);
            badge.appendChild(dateSpan);

            const opp = getTeam(r.opponent);
            badge.title = `${r.home ? "홈" : "원정"} vs ${opp ? opp.short : r.opponent}  ${r.score}`;
            row.appendChild(badge);
        });
        return row;
    }

    // ── 팀 컬럼 (컴팩트: 헤더 + 순위 뱃지 + 최근 5경기 폼) ──
    // 상세 비교(평균 득실/승률/시간대/득점왕)는 예측 리포트에서 담당
    function buildTeamCol(team, results, isAway, ranking) {
        const col = document.createElement("div");
        col.className = `matchup-team-col${isAway ? " away" : ""}`;

        // 헤더
        const header = document.createElement("div");
        header.className = `matchup-team-header${isAway ? " away" : ""}`;

        const emblem = document.createElement("div");
        emblem.className = "matchup-team-emblem";
        emblem.style.borderColor = team.secondary || "#1c3a6e";
        if (team.emblem) {
            const img = document.createElement("img");
            img.src = `/static/img/emblems/${team.emblem}`;
            img.alt = team.short;
            emblem.appendChild(img);
        } else {
            emblem.style.background = team.primary;
            emblem.textContent = team.short;
        }

        const nameWrap = document.createElement("div");
        nameWrap.className = "matchup-team-name-wrap";

        const nameEl = document.createElement("div");
        nameEl.className = "matchup-team-name";
        nameEl.textContent = team.name;
        nameWrap.appendChild(nameEl);

        if (ranking && ranking.rank) {
            const rankBadge = document.createElement("div");
            rankBadge.className = "rank-inline-badge";
            rankBadge.innerHTML =
                `<span class="rank-inline-num">${ranking.rank}위</span>` +
                `<span class="rank-inline-pts">${ranking.pts}점</span>` +
                `<span class="rank-inline-gd">득실 ${ranking.gf > ranking.ga ? "+" : ""}${ranking.gf - ranking.ga}</span>`;
            nameWrap.appendChild(rankBadge);
        }

        header.appendChild(emblem);
        header.appendChild(nameWrap);
        col.appendChild(header);

        // 최근 5경기 폼 (날짜 포함)
        const formLabel = document.createElement("div");
        formLabel.className = "matchup-form-label";
        formLabel.textContent = "최근 5경기";
        col.appendChild(formLabel);
        col.appendChild(buildFormBadges(results));

        // 5경기 W/D/L 요약
        const fiveStats = calcFormStats(results);
        const statsRow = document.createElement("div");
        statsRow.className = "matchup-stats-row";
        [
            { label: "승", val: fiveStats.w, cls: "record-w" },
            { label: "무", val: fiveStats.d, cls: "record-d" },
            { label: "패", val: fiveStats.l, cls: "record-l" },
        ].forEach(({ label, val, cls }) => {
            const pill = document.createElement("div");
            pill.className = "stat-pill";
            pill.innerHTML = `${label} <strong class="${cls}">${val}</strong>`;
            statsRow.appendChild(pill);
        });
        col.appendChild(statsRow);

        return col;
    }

    // ── 가운데 센터 패널 (H2H 요약 + 경기 기록 나란히) ────────
    function buildCenterPanel(h2h, h2hMatches, teamA, teamB) {
        const panel = document.createElement("div");
        panel.className = "center-panel";

        // ── 왼쪽: VS + H2H 요약 ──
        const vsCol = document.createElement("div");
        vsCol.className = "matchup-vs-col";

        const vsText = document.createElement("div");
        vsText.className = "matchup-vs-text";
        vsText.textContent = "VS";
        vsCol.appendChild(vsText);

        const box = document.createElement("div");
        box.className = "matchup-record-box";

        const title = document.createElement("div");
        title.className = "matchup-record-title";
        title.textContent = "최근 10경기 맞대결";
        box.appendChild(title);

        const nums = document.createElement("div");
        nums.className = "matchup-record-nums";

        if (!h2h || h2h.total === 0) {
            nums.innerHTML = `<span style="font-size:0.75rem;color:#3a4a6a;">기록 없음</span>`;
            box.appendChild(nums);
        } else {
            nums.innerHTML =
                `<span class="record-w">${h2h.w}</span>` +
                `<span class="matchup-record-sep">-</span>` +
                `<span class="record-d">${h2h.d}</span>` +
                `<span class="matchup-record-sep">-</span>` +
                `<span class="record-l">${h2h.l}</span>`;
            const subLabel = document.createElement("div");
            subLabel.style.cssText = "font-size:0.82rem;color:#ffffff;margin-top:4px;";
            subLabel.textContent = `${teamA.short} 승 · 무 · ${teamB.short} 승`;
            box.appendChild(nums);
            box.appendChild(subLabel);
            const total = document.createElement("div");
            total.className = "matchup-record-total";
            total.textContent = `총 ${h2h.total}경기`;
            box.appendChild(total);

            // 비율 바
            const ratioWrap = document.createElement("div");
            ratioWrap.className = "record-ratio-wrap";
            const wPct = h2h.total ? Math.round((h2h.w / h2h.total) * 100) : 0;
            const dPct = h2h.total ? Math.round((h2h.d / h2h.total) * 100) : 0;
            const lPct = 100 - wPct - dPct;
            ratioWrap.innerHTML = `
                <div class="record-ratio-bar">
                    <div class="rrb-w" style="width:${wPct}%"></div>
                    <div class="rrb-d" style="width:${dPct}%"></div>
                    <div class="rrb-l" style="width:${lPct}%"></div>
                </div>
                <div class="record-ratio-labels">
                    <span class="record-w">${wPct}%</span>
                    <span class="record-d">${dPct}%</span>
                    <span class="record-l">${lPct}%</span>
                </div>`;
            box.appendChild(ratioWrap);
        }
        vsCol.appendChild(box);
        panel.appendChild(vsCol);

        // ── 오른쪽: 경기 기록 ──
        if (h2hMatches && h2hMatches.length > 0) {
            const recordCol = buildMatchRecordCol(h2hMatches, teamA, teamB);
            panel.appendChild(recordCol);
        }

        return panel;
    }

    // ── 단일팀 가운데 패널 ────────────────────────────────
    function buildSingleCenterPanel(results, team) {
        const panel = document.createElement("div");
        panel.className = "center-panel";

        const vsCol = document.createElement("div");
        vsCol.className = "matchup-vs-col";
        const vsText = document.createElement("div");
        vsText.className = "matchup-vs-text";
        vsText.textContent = "VS";
        vsCol.appendChild(vsText);
        const hint = document.createElement("div");
        hint.style.cssText = "font-size:0.72rem;color:#4a6080;margin-top:8px;text-align:center;white-space:pre-line;";
        hint.textContent = "상대팀을 선택하면\n맞대결 전적이 표시됩니다";
        vsCol.appendChild(hint);
        panel.appendChild(vsCol);

        if (results && results.length > 0) {
            panel.appendChild(buildMatchRecordCol(results.slice(0, 10), team, null));
        }

        return panel;
    }

    // ── 가운데 단일 팀 VS 칸 ────────────────────────────────
    function buildSingleVsCol() {
        const vsCol = document.createElement("div");
        vsCol.className = "matchup-vs-col";
        const vsText = document.createElement("div");
        vsText.className = "matchup-vs-text";
        vsText.textContent = "VS";
        vsCol.appendChild(vsText);
        const hint = document.createElement("div");
        hint.style.cssText = "font-size:0.72rem;color:#4a6080;margin-top:8px;text-align:center;white-space:pre-line;";
        hint.textContent = "상대팀을 선택하면\n맞대결 전적이 표시됩니다";
        vsCol.appendChild(hint);
        return vsCol;
    }

    // ── 경기 기록 컬럼 (4번째 컬럼) ─────────────────────────
    function buildMatchRecordCol(matches, teamA, teamB) {
        const col = document.createElement("div");
        col.className = "match-record-col";

        const label = document.createElement("div");
        label.className = "matchup-form-label";
        label.textContent = teamB ? "맞대결 경기 기록" : "최근 경기";
        col.appendChild(label);

        matches.forEach(m => {
            const row = document.createElement("div");
            row.className = `match-record-row result-${m.result_a || m.result}`;

            // 날짜 + H/A
            const meta = document.createElement("div");
            meta.className = "mr-meta";

            const dateEl = document.createElement("span");
            dateEl.className = "mr-date";
            dateEl.textContent = formatDate(m.date);
            meta.appendChild(dateEl);

            if (teamB) {
                const venueEl = document.createElement("span");
                venueEl.className = `mr-venue ${m.is_home_a ? "home" : "away"}`;
                venueEl.textContent = m.is_home_a ? "H" : "A";
                meta.appendChild(venueEl);
            }
            row.appendChild(meta);

            // 스코어
            const scoreEl = document.createElement("div");
            scoreEl.className = "mr-score";
            if (teamB) {
                const aShort = teamA.short;
                const bShort = teamB.short;
                scoreEl.innerHTML = m.is_home_a
                    ? `<span class="mr-team">${aShort}</span><span class="mr-num">${m.home_score}:${m.away_score}</span><span class="mr-team opp">${bShort}</span>`
                    : `<span class="mr-team opp">${bShort}</span><span class="mr-num">${m.home_score}:${m.away_score}</span><span class="mr-team">${aShort}</span>`;
            } else {
                const opp = getTeam(m.opponent);
                const oppName = opp ? opp.short : (m.opponent || "?");
                const venue = m.home ? "H" : "A";
                scoreEl.innerHTML =
                    `<span class="mr-venue-sm ${ttEsc(m.home ? 'home' : 'away')}">${venue}</span>` +
                    `<span class="mr-team opp">${oppName}</span>` +
                    `<span class="mr-num">${m.score || ""}</span>`;
            }
            row.appendChild(scoreEl);

            // 득점 선수
            const allScorers = [...(m.scorers_home || []), ...(m.scorers_away || [])];
            const totalTracked = allScorers.reduce((s, p) => s + p.goals, 0);
            const totalGoals = (m.home_score || 0) + (m.away_score || 0);
            if (allScorers.length > 0) {
                const scorersEl = document.createElement("div");
                scorersEl.className = "mr-scorers";
                if (totalTracked < totalGoals) {
                    const note = document.createElement("span");
                    note.className = "mr-scorer-note";
                    note.textContent = `(${totalTracked}/${totalGoals}골 집계)`;
                    scorersEl.appendChild(note);
                }

                (m.scorers_home || []).forEach(s => {
                    const sp = document.createElement("span");
                    sp.className = "mr-scorer home";
                    sp.textContent = `⚽ ${s.name}${s.goals > 1 ? " ×" + s.goals : ""}`;
                    scorersEl.appendChild(sp);
                });
                (m.scorers_away || []).forEach(s => {
                    const sp = document.createElement("span");
                    sp.className = "mr-scorer away";
                    sp.textContent = `⚽ ${s.name}${s.goals > 1 ? " ×" + s.goals : ""}`;
                    scorersEl.appendChild(sp);
                });
                row.appendChild(scorersEl);
            }

            col.appendChild(row);
        });

        return col;
    }

    // ── 팀 빈 플레이스홀더 칼럼 ────────────────────────────
    function buildEmptyTeamCol(isAway) {
        const col = document.createElement("div");
        col.className = `matchup-team-col${isAway ? " away" : ""}`;
        col.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:120px;";
        const msg = document.createElement("span");
        msg.style.cssText = "font-size:0.8rem;color:#4a6080;";
        msg.textContent = isAway ? "AWAY 팀을 선택해주세요" : "HOME 팀을 선택해주세요";
        col.appendChild(msg);
        return col;
    }

    // ── 단일 면(홈 or 원정 전용) 승률 바 ────────────────────
    function buildSideStatCol(team, stats, statsByYear, side, ranking) {
        const col = document.createElement("div");
        col.className = `matchup-team-col${side === "away" ? " away" : ""}`;

        // 헤더
        const header = document.createElement("div");
        header.className = `matchup-team-header${side === "away" ? " away" : ""}`;
        const emblem = document.createElement("div");
        emblem.className = "matchup-team-emblem";
        emblem.style.borderColor = team.secondary || "#1c3a6e";
        if (team.emblem) {
            const img = document.createElement("img");
            img.src = `/static/img/emblems/${team.emblem}`;
            img.alt = team.short;
            emblem.appendChild(img);
        } else {
            emblem.style.background = team.primary;
            emblem.textContent = team.short;
        }
        const nameWrap = document.createElement("div");
        nameWrap.className = "matchup-team-name-wrap";
        const nameEl = document.createElement("div");
        nameEl.className = "matchup-team-name";
        nameEl.textContent = team.name;
        nameWrap.appendChild(nameEl);
        if (ranking && ranking.rank) {
            const rankBadge = document.createElement("div");
            rankBadge.className = "rank-inline-badge";
            rankBadge.innerHTML =
                `<span class="rank-inline-num">${ranking.rank}위</span>` +
                `<span class="rank-inline-pts">${ranking.pts}점</span>` +
                `<span class="rank-inline-gd">득실 ${ranking.gf > ranking.ga ? "+" : ""}${ranking.gf - ranking.ga}</span>`;
            nameWrap.appendChild(rankBadge);
        }
        header.appendChild(emblem);
        header.appendChild(nameWrap);
        col.appendChild(header);

        // 사이드 레이블
        const sideLabel = document.createElement("div");
        sideLabel.className = "matchup-form-label";
        sideLabel.style.cssText = "margin-top:10px; font-size:0.75rem;";
        sideLabel.innerHTML = side === "home"
            ? `<span style="color:#7eb8ff;font-weight:700;">HOME</span> 성적`
            : `<span style="color:#b87ef8;font-weight:700;">AWAY</span> 성적`;
        col.appendChild(sideLabel);

        // 해당 면 승률만 표시
        function renderSideBar(sectionEl, data, yr) {
            sectionEl.innerHTML = "";
            if (!data || !data[side] || !data[side].games) {
                sectionEl.innerHTML = `<div style="font-size:0.7rem;color:#4a6080;padding:6px 0;">${yr}년 데이터 없음</div>`;
                return;
            }
            const d = data[side];
            const winPct = pct(d.w, d.games);
            const cls = side === "home" ? "home" : "away";

            const row = document.createElement("div");
            row.className = "winrate-row";
            const labelRow = document.createElement("div");
            labelRow.className = "winrate-label-row";
            const detail = document.createElement("span");
            detail.style.cssText = "font-size:0.78rem;color:#ffffff;";
            detail.textContent = `${d.w}승 ${d.d}무 ${d.l}패`;
            const pctEl = document.createElement("span");
            pctEl.className = "winrate-pct";
            pctEl.textContent = `승률 ${winPct}%`;
            labelRow.appendChild(detail);
            labelRow.appendChild(pctEl);
            const barWrap = document.createElement("div");
            barWrap.className = "winrate-bar-wrap";
            const bar = document.createElement("div");
            bar.className = `winrate-bar ${cls}`;
            bar.style.width = "0%";
            setTimeout(() => { bar.style.width = `${winPct}%`; }, 50);
            barWrap.appendChild(bar);
            row.appendChild(labelRow);
            row.appendChild(barWrap);
            sectionEl.appendChild(row);
        }

        const barsSection = document.createElement("div");
        barsSection.className = "winrate-section";

        const tabRow = document.createElement("div");
        tabRow.className = "winrate-year-tabs";
        const years = statsByYear ? Object.keys(statsByYear).filter(k => k !== "전체").sort() : [];
        const tabs = ["전체", ...years];
        const mainStats = stats && stats[side] ? stats : (statsByYear["전체"] || {});
        renderSideBar(barsSection, mainStats, "전체");

        tabs.forEach(yr => {
            const btn = document.createElement("button");
            btn.className = "wr-year-tab" + (yr === "전체" ? " active" : "");
            btn.dataset.yr = yr;
            btn.textContent = yr;
            btn.addEventListener("click", () => {
                tabRow.querySelectorAll(".wr-year-tab").forEach(b => b.classList.toggle("active", b.dataset.yr === yr));
                if (yr === "전체") renderSideBar(barsSection, mainStats, "전체");
                else renderSideBar(barsSection, statsByYear[yr], yr);
            });
            tabRow.appendChild(btn);
        });

        col.appendChild(tabRow);
        col.appendChild(barsSection);
        return col;
    }

    // ── 같은 팀 HOME/AWAY 선택 시 렌더 ──────────────────────
    async function renderSameTeam(team) {
        matchupArea.innerHTML = `<div class="matchup-placeholder"><span>불러오는 중...</span></div>`;
        try {
        const [results, stats, statsByYear, ranking] = await Promise.all([
            fetch(`/api/results?teamId=${team.id}`).then(r => r.json()),
            fetch(`/api/team-stats?teamId=${team.id}`).then(r => r.json()),
            fetch(`/api/team-stats-by-year?teamId=${team.id}`).then(r => r.json()),
            fetch(`/api/team-ranking?teamId=${team.id}`).then(r => r.json()),
        ]);

        matchupArea.innerHTML = "";
        const grid = document.createElement("div");
        grid.className = "matchup-grid";

        grid.appendChild(buildSideStatCol(team, stats, statsByYear, "home", ranking));

        // 가운데: VS + 최근 경기
        const centerPanel = buildSingleCenterPanel(results, team);
        grid.appendChild(centerPanel);

        grid.appendChild(buildSideStatCol(team, stats, statsByYear, "away", ranking));
        matchupArea.appendChild(grid);
        } catch (err) { console.warn("renderSameTeam error:", err); matchupArea.innerHTML = `<div class="matchup-placeholder"><span>데이터를 불러올 수 없습니다.</span></div>`; }
    }

    // ── 메인 렌더 ────────────────────────────────────────
    async function renderMatchup(teamA, teamB) {
        matchupArea.innerHTML = `<div class="matchup-placeholder"><span>불러오는 중...</span></div>`;
        try {
        const [resultsA, resultsB, h2h, h2hMatches, rankingA, rankingB] = await Promise.all([
            fetch(`/api/results?teamId=${teamA.id}`).then(r => r.json()),
            fetch(`/api/results?teamId=${teamB.id}`).then(r => r.json()),
            fetch(`/api/h2h?teamA=${teamA.id}&teamB=${teamB.id}`).then(r => r.json()),
            fetch(`/api/h2h-matches?teamA=${teamA.id}&teamB=${teamB.id}`).then(r => r.json()),
            fetch(`/api/team-ranking?teamId=${teamA.id}`).then(r => r.json()),
            fetch(`/api/team-ranking?teamId=${teamB.id}`).then(r => r.json()),
        ]);

        matchupArea.innerHTML = "";
        const grid = document.createElement("div");
        grid.className = "matchup-grid";
        grid.appendChild(buildTeamCol(teamA, resultsA, false, rankingA));
        grid.appendChild(buildCenterPanel(h2h, h2hMatches, teamA, teamB));
        grid.appendChild(buildTeamCol(teamB, resultsB, true, rankingB));
        matchupArea.appendChild(grid);
        } catch (err) { console.warn("renderMatchup error:", err); matchupArea.innerHTML = `<div class="matchup-placeholder"><span>데이터를 불러올 수 없습니다.</span></div>`; }
    }

    async function renderSingle(team, isAway) {
        matchupArea.innerHTML = `<div class="matchup-placeholder"><span>불러오는 중...</span></div>`;
        try {
        const [results, ranking] = await Promise.all([
            fetch(`/api/results?teamId=${team.id}`).then(r => r.json()),
            fetch(`/api/team-ranking?teamId=${team.id}`).then(r => r.json()),
        ]);

        matchupArea.innerHTML = "";
        const grid = document.createElement("div");
        grid.className = "matchup-grid";
        const centerPanel = buildSingleCenterPanel(results, team);

        if (isAway) {
            grid.appendChild(buildEmptyTeamCol(false));
            grid.appendChild(centerPanel);
            grid.appendChild(buildTeamCol(team, results, true, ranking));
        } else {
            grid.appendChild(buildTeamCol(team, results, false, ranking));
            grid.appendChild(centerPanel);
            grid.appendChild(buildEmptyTeamCol(true));
        }
        matchupArea.appendChild(grid);
        } catch (err) { console.warn("renderSingle error:", err); matchupArea.innerHTML = `<div class="matchup-placeholder"><span>데이터를 불러올 수 없습니다.</span></div>`; }
    }

    function clearMatchup() {
        matchupArea.innerHTML = `<div class="matchup-placeholder"><span>위에서 HOME · AWAY 팀을 선택하면 전적이 표시됩니다</span></div>`;
    }

    // ── 팀 배너 변화 감지 ────────────────────────────────
    function watchBanner() {
        const nameA = document.getElementById("fhud-name-a");
        const nameB = document.getElementById("fhud-name-b");
        if (!nameA || !nameB) return;

        const matchTeam = (text) => teamsData.find(t => t.short === text) || teamsData.find(t => t.name === text);

        const observer = new MutationObserver(() => {
            const textA = nameA.textContent.trim();
            const textB = nameB.textContent.trim();
            const teamA = matchTeam(textA);
            const teamB = matchTeam(textB);

            if (teamA && teamB) {
                document.dispatchEvent(new CustomEvent("teamsSelected", { detail: { home: teamA, away: teamB } }));
                if (teamA.id === teamB.id) { renderSameTeam(teamA); return; }
                renderMatchup(teamA, teamB); return;
            }
            document.dispatchEvent(new CustomEvent("teamsSelected", { detail: null }));
            if (teamA) { renderSingle(teamA, false); return; }
            if (teamB) { renderSingle(teamB, true); return; }
            clearMatchup();
        });

        observer.observe(nameA, { childList: true, characterData: true, subtree: true });
        observer.observe(nameB, { childList: true, characterData: true, subtree: true });
    }

    fetch("/api/teams").then(r => r.json()).then(t => {
        teamsData = t;
        watchBanner();
    });
})();
