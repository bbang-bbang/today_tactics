// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/* recruit.js — 팀 탭 '영입 추천' (2026-11-10)
 * /api/team-recruit: 팀의 약한 세부 포지션·지표 진단 → K1·K2 후보(리그·나이·출전 필터).
 * 선수 이름 클릭 → 선수 분석 모달(playerSelected 이벤트, player_analytics.js). */
(function () {
    "use strict";
    const root = () => document.getElementById("ws-team-recruit");
    let _teams = null, _team = null, _req = 0;
    const _f = { scope: "all", max_age: "", min_minutes: "900" };

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
        const sel = (id, label, cur, items) => `<label class="rc-ctl"><span>${label}</span>
            <select id="${id}">${items.map(([v, l]) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${l}</option>`).join("")}</select></label>`;
        return `<div class="rc-head">
            <h2 class="rc-title">🧭 영입 추천</h2>
            <div class="rc-ctls">
                <label class="rc-ctl"><span>팀</span><select id="rc-team"><optgroup label="K리그1">${opt("K1")}</optgroup><optgroup label="K리그2">${opt("K2")}</optgroup></select></label>
                ${sel("rc-scope", "후보 리그", _f.scope, [["all", "K1·K2 전체"], ["same", "같은 리그만"], ["k1", "K1만"], ["k2", "K2만"]])}
                ${sel("rc-age", "최대 나이", _f.max_age, [["", "제한 없음"], ["23", "23세 이하"], ["25", "25세 이하"], ["28", "28세 이하"], ["31", "31세 이하"]])}
                ${sel("rc-mins", "최소 출전", _f.min_minutes, [["900", "900분+"], ["1350", "1350분+"], ["1800", "1800분+"]])}
            </div>
        </div>
        <div id="rc-body" class="rc-body"></div>`;
    }

    function bar(p) {
        const v = Math.max(0, Math.min(100, p || 0));
        return `<span class="rc-pbar" aria-hidden="true"><i style="width:${v}%"></i></span>`;
    }

    function bodyHtml(d) {
        const lgLbl = d.team.league === "K1" ? "K리그1" : "K리그2";
        const strip = d.all_groups.map(n => {
            const isNeed = d.needs.some(x => x.group === n.group);
            const rk = n.rank ? `${n.rank}/${n.n_teams}위` : "기록 없음";
            return `<span class="rc-gchip${isNeed ? " is-need" : ""}" title="출전 시간 가중 평균 종합 점수 · ${lgLbl} ${n.n_teams}팀 중 순위">
                ${ttEsc(n.label)} <b>${n.team_score ?? "-"}</b> <span class="rc-muted">${rk}</span>${isNeed ? " · 보강" : ""}</span>`;
        }).join("");
        const needs = d.needs.map(n => needHtml(d, n)).join("") ||
            `<p class="rc-empty">모든 포지션이 리그 상위권입니다 — 보강이 시급한 포지션이 없습니다.</p>`;
        return `<div class="rc-strip" aria-label="포지션별 팀 강도">
                <span class="rc-strip-lead">${ttEsc(d.team.name)} 포지션 강도 <span class="rc-muted">(${d.year} ${lgLbl} · 리그 순위)</span></span>${strip}</div>
            ${needs}
            <details class="rc-notes"><summary>추천 기준</summary><ul>${d.notes.map(x => `<li>${ttEsc(x)}</li>`).join("")}</ul></details>`;
    }

    function needHtml(d, n) {
        const weak = n.weak_metrics.length
            ? n.weak_metrics.map(w => `<span class="rc-weak">${ttEsc(w.label)} <b>${w.pct}</b><span class="rc-muted">백분위</span></span>`).join("")
            : `<span class="rc-muted">해당 포지션 선수 기록 부족</span>`;
        const cur = n.current.length
            ? n.current.map(p => `<button type="button" class="rc-plink" data-rc-player="${p.player_id}">${ttEsc(p.name)}</button>
                 <span class="rc-muted">${p.score} · ${p.share}%</span>`).join("<span class='rc-sep'>·</span>")
            : `<span class="rc-muted">없음</span>`;
        const focusKeys = n.weak_metrics.map(w => w.key);
        const rows = n.candidates.map((c, i) => `<tr>
                <td class="rc-rank">${i + 1}</td>
                <td><button type="button" class="rc-plink rc-name" data-rc-player="${c.player_id}">${ttEsc(c.name)}</button>
                    <span class="rc-sub">${ttEsc(c.nationality || "")}${c.height ? " · " + c.height + "cm" : ""}${c.foot ? " · " + ttEsc(({ Right: "오른발", Left: "왼발", Both: "양발" })[c.foot] || c.foot) : ""}${c.detail_est ? " · 포지션 추정" : ""}</span></td>
                <td>${ttEsc(c.team || "")} <span class="rc-lg rc-lg-${ttEsc(c.league)}">${ttEsc(c.league)}</span></td>
                <td class="rc-num">${c.age ?? "-"}</td>
                <td class="rc-num">${c.mins.toLocaleString()}<span class="rc-muted">분</span></td>
                <td class="rc-num">${c.goals ?? 0}·${c.assists ?? 0}</td>
                ${focusKeys.map(k => `<td class="rc-num">${bar(c.focus_pcts[k])}${c.focus_pcts[k] ?? "-"}</td>`).join("")}
                <td class="rc-num">${c.score}</td>
                <td class="rc-num rc-fit"><b>${c.fit}</b></td>
            </tr>`).join("");
        const table = n.candidates.length ? `<table class="rc-table">
                <thead><tr><th scope="col">#</th><th scope="col">후보</th><th scope="col">소속</th><th scope="col">나이</th><th scope="col">출전</th><th scope="col">골·도움</th>
                    ${n.weak_metrics.map(w => `<th scope="col" title="이 팀이 약한 지표 — 후보의 리그 내 백분위">${ttEsc(w.label)}</th>`).join("")}
                    <th scope="col" title="리그×포지션 백분위 종합(0~100)">종합</th><th scope="col" title="종합 50% + 보강 지표 50%">적합도</th></tr></thead>
                <tbody>${rows}</tbody></table>`
            : `<p class="rc-empty">조건에 맞는 후보가 없습니다 — 필터를 완화해 보세요.</p>`;
        const rk = n.rank ? `리그 ${n.rank}/${n.n_teams}위 · 팀 ${n.team_score} vs 리그 중앙 ${n.league_median}` : "해당 포지션 선수 기록 없음";
        return `<section class="rc-need" aria-label="${ttEsc(n.label)} 보강">
            <div class="rc-need-head"><h3>${ttEsc(n.label)}</h3><span class="rc-muted">${rk}</span></div>
            <div class="rc-need-meta"><span class="rc-k">보강 포인트</span>${weak}</div>
            <div class="rc-need-meta"><span class="rc-k">현재 주전</span>${cur}</div>
            ${table}
            <p class="rc-pool rc-muted">조건 충족 후보 ${n.pool_size}명 중 적합도 상위 ${n.candidates.length}명</p>
        </section>`;
    }

    function load() {
        const body = document.getElementById("rc-body");
        if (!body || !_team) return;
        const id = ++_req;
        body.innerHTML = `<div class="rc-loading" role="status">영입 후보 분석 중...</div>`;
        const q = new URLSearchParams({ team: _team, scope: _f.scope, min_minutes: _f.min_minutes });
        if (_f.max_age) q.set("max_age", _f.max_age);
        fetch(`/api/team-recruit?${q}`)
            .then(r => { if (!r.ok) throw new Error(`recruit ${r.status}`); return r.json(); })
            .then(d => { if (id === _req) body.innerHTML = bodyHtml(d); })
            .catch(err => {
                console.error("[영입 추천 실패]", err);
                if (id === _req) body.innerHTML = `<div class="rc-error" role="alert">영입 추천을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</div>`;
            });
    }

    function bind(el) {
        if (el._rcBound) return;
        el._rcBound = true;
        el.addEventListener("change", (e) => {
            const t = e.target;
            if (t.id === "rc-team") _team = t.value;
            else if (t.id === "rc-scope") _f.scope = t.value;
            else if (t.id === "rc-age") _f.max_age = t.value;
            else if (t.id === "rc-mins") _f.min_minutes = t.value;
            else return;
            load();
        });
        el.addEventListener("click", (e) => {
            const b = e.target.closest("[data-rc-player]");
            if (!b) return;
            const pid = parseInt(b.dataset.rcPlayer, 10);
            if (pid) document.dispatchEvent(new CustomEvent("playerSelected", { detail: { playerId: pid } }));
        });
    }

    window.ttRecruit = {
        show(slug) {
            const el = root();
            if (!el) return;
            teamsReady().then(() => {
                const want = slug && _teams.some(t => t.id === slug) ? slug : (_team || "suwon");
                if (el._rcBound && want === _team) return;      // 이미 그 팀을 보고 있으면 다시 그리지 않음
                _team = want;
                el.innerHTML = controlsHtml();
                bind(el);
                load();
            }).catch(() => { el.innerHTML = `<div class="rc-error" role="alert">팀 목록을 불러오지 못했습니다.</div>`; });
        },
    };
})();
