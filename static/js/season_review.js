// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
// 현재 시즌 — 서버가 <body data-season>에 넣는 값. 여러 파일에 같은 정의(ttEsc와 같은 방식).
function ttSeason() { return (document.body && document.body.dataset.season) || String(new Date().getFullYear()); }
/* season_review.js — 팀 탭 '시즌 리뷰' (2026-11-10)
 * /api/season-review: 순위 흐름 · 홈/원정·전/후반기 · 월별 · 연속 기록 · 상대별 · 핵심 선수 · 예측 적중.
 * 차트는 단일 계열(한 색) — 순위 흐름 SVG 선(점마다 hover 툴팁) + 막대(크기). 표 보기 동반. */
(function () {
    "use strict";
    const root = () => document.getElementById("ws-team-review");
    let _teams = null, _team = null, _year = null, _req = 0;
    let _mode = "team", _lg = "k1";   // 'team' = 팀 시즌 리뷰, 'league' = 리그 총평 (/api/league-season-summary)
    const ACC = "#60a5fa";

    function teamsReady() {
        if (_teams) return Promise.resolve(_teams);
        return fetch("/api/teams").then(r => r.json()).then(list => {
            _teams = (list || []).filter(t => t.league === "K1" || t.league === "K2");
            return _teams;
        });
    }

    function controlsHtml() {
        const opt = (lg) => _teams.filter(t => t.league === lg)
            .map(t => `<option value="${ttEsc(t.id)}"${t.id === _team ? " selected" : ""}>${ttEsc(t.short || t.name)}</option>`).join("");
        const s = +ttSeason();
        const years = [s, s - 1, s - 2].map(y => `<option value="${y}"${String(y) === _year ? " selected" : ""}>${y}</option>`).join("");
        const mode = (k, label) => `<button type="button" class="sr-mode${_mode === k ? " is-on" : ""}" data-sr-mode="${k}" aria-pressed="${_mode === k}">${label}</button>`;
        const pick = _mode === "league"
            ? `<label class="rc-ctl"><span>리그</span><select id="sr-lg"><option value="k1"${_lg === "k1" ? " selected" : ""}>K리그1</option><option value="k2"${_lg === "k2" ? " selected" : ""}>K리그2</option></select></label>`
            : `<label class="rc-ctl"><span>팀</span><select id="sr-team"><optgroup label="K리그1">${opt("K1")}</optgroup><optgroup label="K리그2">${opt("K2")}</optgroup></select></label>`;
        return `<div class="sr-head">
            <h2 class="sr-title">📘 시즌 리뷰</h2>
            <div class="sr-modes" role="group" aria-label="보기 범위">${mode("team", "팀")}${mode("league", "리그 총평")}</div>
            <div class="sr-ctls">
                ${pick}
                <label class="rc-ctl"><span>시즌</span><select id="sr-year">${years}</select></label>
            </div>
        </div>
        <div id="sr-body"></div>`;
    }

    // ── 리그 총평 ────────────────────────────────────────────────
    function playerList(list, unit) {
        if (!list || !list.length) return `<p class="sr-muted">기록이 없습니다.</p>`;
        return `<ol class="sr-players">${list.map((x, i) => `<li><span class="sr-rank">${i + 1}</span>
            <button type="button" class="rc-plink" data-sr-player="${x.player_id}">${ttEsc(x.name)}</button>
            <span class="sr-muted">${ttEsc(x.team || "")} · ${ttEsc(x.pos || "")}</span>
            <span class="sr-score">${ttEsc(x.value)}${unit}</span></li>`).join("")}</ol>`;
    }

    function leagueBodyHtml(d) {
        const lg = d.league === "K1" ? "K리그1" : "K리그2";
        const status = d.in_progress ? `<span class="sr-badge">시즌 진행 중 · 잔여 ${d.remaining}경기</span>` : `<span class="sr-badge sr-badge-done">시즌 종료 · 최종</span>`;
        const cov = d.coverage && !d.coverage.complete
            ? `<div class="sr-warn" role="note">⚠ 이 시즌은 경기 기록이 일부 빠져 있습니다 (수집 ${d.coverage.db_games} / 공식 ${d.coverage.official_games}경기) — 순위·기록이 실제와 다를 수 있습니다.</div>` : "";
        const s = d.league_stats, r = d.records;
        const gm = (g) => g ? `${ttEsc(g.home)} ${ttEsc(g.score)} ${ttEsc(g.away)} <span class="sr-muted">(${ttEsc(g.date)})</span>` : "-";
        const stk = (x, unit) => x ? `${ttEsc(x.team)} <b>${x.n}${unit}</b>` : "-";
        const rows = d.standings.map(t => `<tr>
            <th scope="row" class="sr-num">${t.rank}</th>
            <td>${t.slug ? `<button type="button" class="rc-plink" data-sr-team="${ttEsc(t.slug)}" title="${ttEsc(t.team)} 시즌 리뷰 보기">${ttEsc(t.team)}</button>` : ttEsc(t.team)}${t.group ? ` <span class="sr-muted">파이널 ${t.group}</span>` : ""}</td>
            <td class="sr-num">${t.played}</td><td class="sr-num"><b>${t.pts}</b></td><td class="sr-num">${t.w}·${t.d}·${t.l}</td>
            <td class="sr-num">${t.gf}·${t.ga}</td><td class="sr-num">${t.gd > 0 ? "+" : ""}${t.gd}</td></tr>`).join("");
        return `${cov}
        <div class="sr-hero">
            ${tile("경기", d.games, `${lg} · ${d.teams}팀`)}
            ${tile("경기당 득점", s.goals_pg, `무득점 경기 ${s.zero_zero}`)}
            ${tile("홈 승", `${s.home_pct}<span class="sr-unit">%</span>`, `무 ${s.draw_pct}% · 원정 승 ${s.away_pct}%`)}
            <div class="sr-status">${status}</div>
        </div>
        <section class="sr-card"><h3>순위 ${d.final_stage ? `<span class="sr-muted">파이널 A/B 분리 반영</span>` : ""}</h3>
            <table class="sr-tbl"><thead><tr><th>순위</th><th>팀</th><th>경기</th><th>승점</th><th>승·무·패</th><th>득·실</th><th>득실</th></tr></thead>
            <tbody>${rows}</tbody></table></section>
        <div class="sr-grid2">
            <section class="sr-card"><h3>기록</h3><ul class="sr-list">
                <li>최다 득점 팀: ${stk(r.most_gf, "골")}</li>
                <li>최소 실점 팀: ${stk(r.least_ga, "실점")}</li>
                <li>최다 연승: ${stk(r.win_streak, "연승")}</li>
                <li>최장 무패: ${stk(r.unbeaten, "경기")}</li>
                <li>최다 점수차 경기: ${gm(r.biggest_win)}</li>
                <li>최다 득점 경기: ${gm(r.highest_scoring)}</li></ul></section>
            <section class="sr-card"><h3>득점 TOP5 <span class="sr-muted">공식 기록</span></h3>${playerList(d.top_scorers, "골")}</section>
        </div>
        <div class="sr-grid2">
            <section class="sr-card"><h3>도움 TOP5</h3>${playerList(d.top_assists, "도움")}</section>
            <section class="sr-card"><h3>종합 점수 TOP5 <span class="sr-muted">같은 포지션 백분위 · 900분+</span></h3>${playerList(d.top_rated, "")}</section>
        </div>`;
    }

    const num = (v, d = "-") => (v === null || v === undefined) ? d : v;

    function tile(label, value, sub) {
        return `<div class="sr-tile"><div class="sr-tile-k">${label}</div><div class="sr-tile-v">${value}</div>${sub ? `<div class="sr-tile-s">${sub}</div>` : ""}</div>`;
    }

    // 순위 흐름 — x: 팀의 경기 순서, y: 순위(1위가 위). 단일 계열이라 범례 없음(제목이 이름).
    function trajSvg(d) {
        const t = d.trajectory, N = d.final.n_teams;
        if (!t || t.length < 2) return `<p class="sr-muted">순위 흐름을 그릴 경기가 부족합니다.</p>`;
        const W = 1000, H = 220, L = 40, R = 16, T = 24, B = 28;
        const best = t.reduce((a, b) => (b.rank < a.rank ? b : a)), worst = t.reduce((a, b) => (b.rank > a.rank ? b : a));
        // y축은 1위 ~ (최저 순위+1, 최소 6위) — 상위권 팀 선이 맨 위에 눌려 붙지 않게. 전체 팀 수는 축 라벨로 표시
        const maxR = Math.min(N, Math.max(worst.rank + 1, 6));
        const x = (i) => L + (W - L - R) * (i - 1) / Math.max(1, t.length - 1);
        const y = (r) => T + (H - T - B) * (r - 1) / Math.max(1, maxR - 1);
        const path = t.map((p, i) => `${i ? "L" : "M"}${x(p.n).toFixed(1)},${y(p.rank).toFixed(1)}`).join(" ");
        const gridR = [...new Set([1, Math.ceil((1 + maxR) / 2), maxR])];
        const grid = gridR.map(r => `<line x1="${L}" x2="${W - R}" y1="${y(r)}" y2="${y(r)}" class="sr-grid"/>
            <text x="${L - 6}" y="${y(r) + 4}" class="sr-axis" text-anchor="end">${r}위</text>`).join("")
            + (maxR < N ? `<text x="${W - R}" y="${H - B + 14}" class="sr-axis" text-anchor="end">세로축 ${maxR}위까지 (전체 ${N}팀)</text>` : "");
        const xt = [1, Math.ceil(t.length / 2), t.length].map(n => `<text x="${x(n)}" y="${H - 6}" class="sr-axis" text-anchor="middle">${n}경기</text>`).join("");
        const pts = t.map(p => `<g class="sr-pt" tabindex="0" aria-label="${p.n}경기째 ${p.rank}위">
                <circle cx="${x(p.n)}" cy="${y(p.rank)}" r="9" class="sr-hit"/>
                <circle cx="${x(p.n)}" cy="${y(p.rank)}" r="4" class="sr-dot"/>
                <title>${p.n}경기째 (${ttEsc(p.date)}${p.round ? " · R" + p.round : ""}) — ${p.rank}위 · 승점 ${p.pts}</title></g>`).join("");
        const lbl = (p, txt, dy) => `<text x="${x(p.n)}" y="${y(p.rank) + dy}" class="sr-lbl" text-anchor="middle">${txt}</text>`;
        return `<svg class="sr-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${ttEsc(d.team.name)} ${d.year} 경기별 순위 흐름 — 최고 ${best.rank}위, 최저 ${worst.rank}위">
            ${grid}${xt}
            <path d="${path}" fill="none" stroke="${ACC}" stroke-width="2" stroke-linejoin="round"/>
            ${pts}
            ${lbl(best, `최고 ${best.rank}위`, -10)}${worst.rank !== best.rank ? lbl(worst, `최저 ${worst.rank}위`, 18) : ""}
        </svg>
        <details class="sr-table-view"><summary>표로 보기</summary>
            <table class="sr-tbl"><thead><tr><th>경기</th><th>날짜</th><th>라운드</th><th>순위</th><th>승점</th></tr></thead>
            <tbody>${t.map(p => `<tr><td>${p.n}</td><td>${ttEsc(p.date)}</td><td>${p.round ? "R" + p.round : "-"}</td><td>${p.rank}</td><td>${p.pts}</td></tr>`).join("")}</tbody></table>
        </details>`;
    }

    function bar(v, max) {
        const w = Math.max(0, Math.min(100, (v || 0) / max * 100));
        return `<span class="sr-bar" aria-hidden="true"><i style="width:${w.toFixed(1)}%"></i></span>`;
    }

    function splitsHtml(s) {
        const rows = [["전체", s.all], ["홈", s.home], ["원정", s.away], ["전반기", s.first], ["후반기", s.second]].filter(r => r[1]);
        return `<table class="sr-tbl"><thead><tr><th>구분</th><th>경기</th><th>승·무·패</th><th>경기당 승점</th><th>득점/경기</th><th>실점/경기</th></tr></thead>
            <tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v.games}</td><td>${v.w}·${v.d}·${v.l}</td>
                <td class="sr-num">${bar(v.ppg, 3)}${v.ppg}</td><td class="sr-num">${v.gf_pg}</td><td class="sr-num">${v.ga_pg}</td></tr>`).join("")}</tbody></table>`;
    }

    function monthlyHtml(m) {
        if (!m.length) return "";
        return `<table class="sr-tbl"><thead><tr><th>월</th><th>경기</th><th>경기당 승점</th><th>득·실</th><th title="SofaScore 수집 경기 기준">xG·xGA /경기</th></tr></thead>
            <tbody>${m.map(r => `<tr><th scope="row">${r.month}월</th><td>${r.games}</td><td class="sr-num">${bar(r.ppg, 3)}${r.ppg}</td>
                <td class="sr-num">${r.gf}·${r.ga}</td><td class="sr-num">${r.xg_f == null ? "-" : `${r.xg_f}·${num(r.xg_a)}`}</td></tr>`).join("")}</tbody></table>`;
    }

    function playersHtml(d) {
        const p = (x) => `<button type="button" class="rc-plink" data-sr-player="${x.player_id}">${ttEsc(x.name)}</button>`;
        const rows = d.key_players.map((x, i) => `<li><span class="sr-rank">${i + 1}</span>${p(x)}
            <span class="sr-muted">${ttEsc(x.pos || "")} · ${x.mins.toLocaleString()}분</span>
            <span class="sr-score" title="같은 리그·같은 세부 포지션 백분위 종합(0~100)">${x.score}</span>
            <span class="sr-muted">${num(x.goals, 0)}골 ${num(x.assists, 0)}도움</span></li>`).join("");
        const top = [d.top_scorer ? `득점 1위 ${p(d.top_scorer)} <b>${d.top_scorer.goals}골</b>` : "",
                     d.top_assist ? `도움 1위 ${p(d.top_assist)} <b>${d.top_assist.assists}도움</b>` : ""].filter(Boolean).join(" · ");
        return `${rows ? `<ol class="sr-players">${rows}</ol>` : `<p class="sr-muted">900분 이상 뛴 선수 기록이 없습니다.</p>`}
            ${top ? `<p class="sr-top">${top}</p>` : ""}`;
    }

    function oppHtml(list, empty) {
        if (!list.length) return `<p class="sr-muted">${empty}</p>`;
        return `<ul class="sr-list">${list.map(o => `<li><b>${ttEsc(o.opp)}</b> <span class="sr-muted">${o.games}경기 · 경기당 승점 ${o.ppg} · ${o.gf}-${o.ga}</span></li>`).join("")}</ul>`;
    }

    function bodyHtml(d) {
        const f = d.final;
        const lg = d.league === "K1" ? "K리그1" : "K리그2";
        const status = d.in_progress ? `<span class="sr-badge">시즌 진행 중 · 잔여 ${d.remaining}경기</span>` : `<span class="sr-badge sr-badge-done">시즌 종료</span>`;
        const cov = d.coverage && !d.coverage.complete
            ? `<div class="sr-warn" role="note">⚠ 이 시즌은 경기 기록이 일부 빠져 있습니다 (수집 ${d.coverage.db_games} / 공식 ${d.coverage.official_games}경기) — 순위·기록이 실제와 다를 수 있습니다.</div>` : "";
        const sk = d.streaks;
        const bw = d.big_win ? `${ttEsc(d.big_win.opp)}전 ${ttEsc(d.big_win.score)} <span class="sr-muted">(${ttEsc(d.big_win.date)}, ${d.big_win.home ? "홈" : "원정"})</span>` : "-";
        const bl = d.big_loss ? `${ttEsc(d.big_loss.opp)}전 ${ttEsc(d.big_loss.score)} <span class="sr-muted">(${ttEsc(d.big_loss.date)}, ${d.big_loss.home ? "홈" : "원정"})</span>` : "-";
        const pr = d.prediction;
        const ups = pr.upsets.map(u => `<li>${ttEsc(u.opp)}전 ${ttEsc(u.score)} <span class="sr-muted">(${ttEsc(u.date)}) — 이 결과 예측 확률 ${u.p_actual}%</span></li>`).join("");
        return `${cov}
        <div class="sr-hero">
            ${tile("순위", `${num(f.rank)}<span class="sr-unit">/${f.n_teams}</span>`, `${lg}${d.final_group ? " · 파이널 " + d.final_group : ""}`)}
            ${tile("승점", f.pts, `${f.played}경기 · 경기당 ${(f.pts / Math.max(1, f.played)).toFixed(2)}`)}
            ${tile("승·무·패", `${f.w}·${f.d}·${f.l}`, `승률 ${Math.round(f.w / Math.max(1, f.played) * 100)}%`)}
            ${tile("득점·실점", `${f.gf}·${f.ga}`, `득실 ${f.gf - f.ga > 0 ? "+" : ""}${f.gf - f.ga}`)}
            <div class="sr-status">${status}</div>
        </div>
        ${d.summary.length ? `<section class="sr-card"><h3>시즌 요약</h3><ul class="sr-summary">${d.summary.map(s => `<li>${ttEsc(s)}</li>`).join("")}</ul></section>` : ""}
        <section class="sr-card"><h3>경기별 순위 흐름</h3>${trajSvg(d)}</section>
        <div class="sr-grid2">
            <section class="sr-card"><h3>홈·원정 / 전·후반기</h3>${splitsHtml(d.splits)}</section>
            <section class="sr-card"><h3>월별</h3>${monthlyHtml(d.monthly)}</section>
        </div>
        <div class="sr-grid2">
            <section class="sr-card"><h3>핵심 선수 <span class="sr-muted">종합 점수 · 900분+</span></h3>${playersHtml(d)}</section>
            <section class="sr-card"><h3>기록</h3>
                <ul class="sr-list">
                    <li>최다 연승 <b>${sk.win}</b> · 최장 무패 <b>${sk.unbeaten}</b> · 최다 연패 <b>${sk.loss}</b> · 최장 무승 <b>${sk.winless}</b></li>
                    <li>최다 점수차 승리: ${bw}</li>
                    <li>최다 점수차 패배: ${bl}</li>
                </ul>
                <h4 class="sr-sub">강했던 상대 <span class="sr-muted">2경기 이상</span></h4>${oppHtml(d.best_opps, "2경기 이상 만난 상대가 없습니다.")}
                <h4 class="sr-sub">약했던 상대</h4>${oppHtml(d.worst_opps, "-")}
            </section>
        </div>
        <section class="sr-card"><h3>예측 모델과 비교 <span class="sr-muted">경기 직전 데이터만으로 예측</span></h3>
            ${pr.games ? `<p>이 팀 ${pr.games}경기 중 승·무·패 적중 <b>${pr.hit_pct}%</b></p>
                ${ups ? `<h4 class="sr-sub">가장 의외였던 결과</h4><ul class="sr-list">${ups}</ul>` : ""}`
              : `<p class="sr-muted">예측에 필요한 이전 기록이 없어 비교할 수 없습니다.</p>`}
        </section>`;
    }

    function load() {
        const body = document.getElementById("sr-body");
        if (!body || !_team) return;
        const id = ++_req;
        body.innerHTML = `<div class="rc-loading" role="status">시즌 기록 정리 중...</div>`;
        if (_mode === "league") {
            fetch(`/api/league-season-summary?league=${encodeURIComponent(_lg)}&year=${encodeURIComponent(_year)}`)
                .then(r => r.json().then(j => ({ ok: r.ok, j })))
                .then(({ ok, j }) => {
                    if (id !== _req) return;
                    body.innerHTML = ok ? leagueBodyHtml(j)
                        : `<div class="rc-empty">${j.error === "no games" ? "이 시즌에는 이 리그의 경기 기록이 없습니다." : "리그 총평을 만들 수 없습니다."}</div>`;
                })
                .catch(err => {
                    console.error("[리그 총평 실패]", err);
                    if (id === _req) body.innerHTML = `<div class="rc-error" role="alert">리그 총평을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</div>`;
                });
            return;
        }
        fetch(`/api/season-review?team=${encodeURIComponent(_team)}&year=${encodeURIComponent(_year)}`)
            .then(r => r.json().then(j => ({ ok: r.ok, j })))
            .then(({ ok, j }) => {
                if (id !== _req) return;
                body.innerHTML = ok ? bodyHtml(j)
                    : `<div class="rc-empty">${j.error === "no games" ? "이 시즌에는 이 팀의 K리그 경기 기록이 없습니다." : "시즌 리뷰를 만들 수 없습니다."}</div>`;
            })
            .catch(err => {
                console.error("[시즌 리뷰 실패]", err);
                if (id === _req) body.innerHTML = `<div class="rc-error" role="alert">시즌 리뷰를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</div>`;
            });
    }

    function bind(el) {
        if (el._srBound) return;
        el._srBound = true;
        el.addEventListener("change", (e) => {
            if (e.target.id === "sr-team") _team = e.target.value;
            else if (e.target.id === "sr-lg") _lg = e.target.value;
            else if (e.target.id === "sr-year") _year = e.target.value;
            else return;
            load();
        });
        el.addEventListener("click", (e) => {
            const m = e.target.closest("[data-sr-mode]");
            const tm = e.target.closest("[data-sr-team]");
            if (m || tm) {   // 모드 전환(팀↔리그 총평) / 순위표의 팀 클릭 → 그 팀 시즌 리뷰
                if (m) _mode = m.dataset.srMode;
                else { _mode = "team"; _team = tm.dataset.srTeam; }
                el.innerHTML = controlsHtml();
                load();
                return;
            }
            const b = e.target.closest("[data-sr-player]");
            if (!b) return;
            const pid = parseInt(b.dataset.srPlayer, 10);
            if (pid) document.dispatchEvent(new CustomEvent("playerSelected", { detail: { playerId: pid } }));
        });
    }

    window.ttSeasonReview = {
        show(slug) {
            const el = root();
            if (!el) return;
            teamsReady().then(() => {
                const want = slug && _teams.some(t => t.id === slug) ? slug : (_team || "suwon");
                if (el._srBound && want === _team) return;
                _team = want;
                _year = _year || ttSeason();
                el.innerHTML = controlsHtml();
                bind(el);
                load();
            }).catch(() => { el.innerHTML = `<div class="rc-error" role="alert">팀 목록을 불러오지 못했습니다.</div>`; });
        },
    };
})();
