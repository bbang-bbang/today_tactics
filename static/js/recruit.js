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
    // 추천 방식: position(약한 포지션 보강) · style(약한 플레이 지표 보강, 포지션 무관) · similar(고른 선수와 비슷한 플레이)
    let _mode = "position", _player = null, _squad = [];
    const MODES = [["position", "포지션 보강"], ["style", "플레이 보강"], ["similar", "비슷한 선수"]];

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
        <div class="rc-modes" role="tablist" aria-label="추천 방식">
            ${MODES.map(([k, l]) => `<button type="button" role="tab" class="rc-mode${k === _mode ? " is-on" : ""}" data-rc-mode="${k}"
                aria-selected="${k === _mode}">${l}</button>`).join("")}
            <span class="rc-mode-hint rc-muted" id="rc-mode-hint">${modeHint()}</span>
        </div>
        <div id="rc-body" class="rc-body"></div>`;
    }

    function modeHint() {
        return { position: "팀이 약한 세부 포지션에서, 같은 포지션 선수 중 약한 지표가 강한 선수",
                 style: "포지션과 무관하게 — 팀 전체가 약한 플레이 지표(수비 행동·창출 등)가 강한 선수",
                 similar: "고른 선수와 90분당 플레이 프로필이 가장 비슷한 선수 (포지션 무관 — 대체 자원 찾기)" }[_mode];
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

    // ── 플레이 기준 공통: 후보 표 ─────────────────────────────
    function playTable(cands, cols, scoreLabel, scoreKey, scoreTitle) {
        if (!cands.length) return `<p class="rc-empty">조건에 맞는 후보가 없습니다 — 필터를 완화해 보세요.</p>`;
        const rows = cands.map((c, i) => `<tr>
            <td class="rc-rank">${i + 1}</td>
            <td><button type="button" class="rc-plink rc-name" data-rc-player="${c.player_id}">${ttEsc(c.name)}</button>
                <span class="rc-sub">${ttEsc(c.pos || "")}${c.nationality ? " · " + ttEsc(c.nationality) : ""}${c.height ? " · " + c.height + "cm" : ""}</span></td>
            <td>${ttEsc(c.team || "")} <span class="rc-lg rc-lg-${ttEsc(c.league)}">${ttEsc(c.league)}</span></td>
            <td class="rc-num">${c.age ?? "-"}</td>
            <td class="rc-num">${c.mins.toLocaleString()}<span class="rc-muted">분</span></td>
            ${cols.map(([k]) => { const v = (c.focus_pcts || c.profile || {})[k]; return `<td class="rc-num">${bar(v)}${v ?? "-"}</td>`; }).join("")}
            <td class="rc-num rc-fit"><b>${c[scoreKey]}</b></td></tr>`).join("");
        return `<table class="rc-table"><thead><tr><th scope="col">#</th><th scope="col">후보</th><th scope="col">소속</th>
            <th scope="col">나이</th><th scope="col">출전</th>
            ${cols.map(([, l]) => `<th scope="col" title="같은 리그 필드 플레이어 전체 중 백분위(포지션 무관)">${ttEsc(l)}</th>`).join("")}
            <th scope="col" title="${ttEsc(scoreTitle)}">${scoreLabel}</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function styleHtml(d) {
        const lgLbl = d.team.league === "K1" ? "K리그1" : "K리그2";
        const chips = d.team_metrics.map(m => {
            const weak = d.weak_metrics.some(w => w.key === m.key);
            return `<span class="rc-gchip${weak ? " is-need" : ""}" title="스쿼드 백분위 출전 가중 평균 · ${lgLbl} ${m.n}팀 중 순위">
                ${ttEsc(m.label)} <b>${m.value}</b> <span class="rc-muted">${m.rank}/${m.n}위</span>${weak ? " · 보강" : ""}</span>`;
        }).join("");
        const cols = d.weak_metrics.map(w => [w.key, w.label]);
        return `<div class="rc-strip"><span class="rc-strip-lead">${ttEsc(d.team.name)} 플레이 지표 <span class="rc-muted">(${d.year} · 리그 순위)</span></span>${chips}</div>
            <section class="rc-need"><div class="rc-need-head"><h3>보강할 플레이: ${d.weak_metrics.map(w => ttEsc(w.label)).join(" · ")}</h3>
                <span class="rc-muted">포지션 무관 후보 ${d.pool_size}명 중 상위 ${d.candidates.length}명</span></div>
                ${playTable(d.candidates, cols, "적합도", "fit", "약한 지표 백분위 평균 70% + 종합 점수 30%")}</section>
            <details class="rc-notes"><summary>추천 기준</summary><ul>${d.notes.map(x => `<li>${ttEsc(x)}</li>`).join("")}</ul></details>`;
    }

    function similarHtml(d) {
        const t = d.target, keys = Object.keys(t.profile);
        const cols = keys.map(k => [k, d.metric_labels[k] || k]);
        const prof = keys.map(k => `<span class="rc-gchip">${ttEsc(d.metric_labels[k] || k)} <b>${t.profile[k]}</b></span>`).join("");
        return `<div class="rc-strip"><span class="rc-strip-lead">기준 선수
                <button type="button" class="rc-plink" data-rc-player="${t.player_id}">${ttEsc(t.name)}</button>
                <span class="rc-muted">${ttEsc(t.pos || "")} · ${t.mins.toLocaleString()}분 · 프로필(백분위)</span></span>${prof}</div>
            <section class="rc-need"><div class="rc-need-head"><h3>플레이가 비슷한 선수</h3>
                <span class="rc-muted">후보 ${d.pool_size}명 중 상위 ${d.candidates.length}명</span></div>
                ${playTable(d.candidates, cols, "유사도", "similarity", "100 − 지표 백분위 차이의 RMS")}</section>
            <details class="rc-notes"><summary>추천 기준</summary><ul>${d.notes.map(x => `<li>${ttEsc(x)}</li>`).join("")}</ul></details>`;
    }

    function playerPickerHtml() {
        if (_mode !== "similar" || !_squad.length) return "";
        return `<label class="rc-ctl rc-picker"><span>기준 선수 (우리 팀)</span><select id="rc-player">
            ${_squad.map(p => `<option value="${p.player_id}"${p.player_id === _player ? " selected" : ""}>${ttEsc(p.name)} · ${ttEsc(p.pos || "")} · ${p.mins}분</option>`).join("")}
        </select></label>`;
    }

    function load() {
        const body = document.getElementById("rc-body");
        if (!body || !_team) return;
        const id = ++_req;
        body.innerHTML = `<div class="rc-loading" role="status">영입 후보 분석 중...</div>`;
        const q = new URLSearchParams({ team: _team, scope: _f.scope, min_minutes: _f.min_minutes, mode: _mode });
        if (_f.max_age) q.set("max_age", _f.max_age);
        // '비슷한 선수'는 기준 선수가 필요 — 스쿼드를 아직 모르면 포지션 응답으로 스쿼드부터 받는다
        const needSquad = _mode === "similar" && !_player;
        if (needSquad) q.set("mode", "position");
        else if (_mode === "similar") q.set("player", _player);
        fetch(`/api/team-recruit?${q}`)
            .then(r => r.json().then(j => ({ ok: r.ok, j })))
            .then(({ ok, j }) => {
                if (id !== _req) return;
                if (!ok) throw new Error(j.error || "recruit");
                _squad = j.squad || _squad;
                if (needSquad) {
                    if (!_squad.length) { body.innerHTML = `<p class="rc-empty">기준으로 고를 선수 기록이 없습니다.</p>`; return; }
                    _player = _squad[0].player_id;
                    return load();
                }
                const inner = j.mode === "style" ? styleHtml(j) : j.mode === "similar" ? similarHtml(j) : bodyHtml(j);
                body.innerHTML = playerPickerHtml() + inner;
            })
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
            if (t.id === "rc-team") { _team = t.value; _player = null; _squad = []; }
            else if (t.id === "rc-scope") _f.scope = t.value;
            else if (t.id === "rc-age") _f.max_age = t.value;
            else if (t.id === "rc-mins") _f.min_minutes = t.value;
            else if (t.id === "rc-player") _player = parseInt(t.value, 10);
            else return;
            load();
        });
        el.addEventListener("click", (e) => {
            const m = e.target.closest("[data-rc-mode]");
            if (m) {
                _mode = m.dataset.rcMode;
                el.querySelectorAll("[data-rc-mode]").forEach(b => {
                    const on = b.dataset.rcMode === _mode;
                    b.classList.toggle("is-on", on); b.setAttribute("aria-selected", on);
                });
                const h = document.getElementById("rc-mode-hint");
                if (h) h.textContent = modeHint();
                load();
                return;
            }
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
