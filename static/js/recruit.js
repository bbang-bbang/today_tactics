// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/* recruit.js — 팀 탭 '영입 추천' (2026-11-10)
 * /api/team-recruit: 팀의 약한 세부 포지션·지표 진단 → K1·K2 후보(리그·나이·출전 필터).
 * 선수 이름 클릭 → 선수 분석 모달(playerSelected 이벤트, player_analytics.js). */
(function () {
    "use strict";
    const root = () => document.getElementById("ws-team-recruit");
    let _teams = null, _team = null, _req = 0;
    const _f = { scope: "all", max_age: "", min_minutes: "900", real: "1", max_value: "5000000" };   // real: 해외 후보 현실성 필터(1=상위 구단 제외) · max_value: 시장가치 상한(유로, ""=제한 없음)
    // 추천 방식: position(약한 포지션 보강) · style(약한 플레이 지표 보강, 포지션 무관) · similar(고른 선수와 비슷한 플레이)
    let _mode = "position", _player = null, _squad = [];
    const MODES = [["position", "포지션 보강"], ["style", "플레이 보강"], ["similar", "비슷한 선수"]];

    // ── 후보 목록(숏리스트, recruit_shortlist.js) ── 표를 그릴 때 행 스냅샷을 _rows[표 키]에 보관(DOM에 JSON 안 넣음)
    const SL = () => window.ttShortlist;
    let _rows = {};
    function store() {
        try { return window.localStorage; }
        catch (_) { return { getItem() { return null; }, setItem() { throw new Error("no storage"); } }; }
    }
    function today() {
        const d = new Date(), p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    let _onIds = null;      // 표를 그리는 동안 담긴 id 집합(행마다 localStorage 재파싱 방지) — keep() 첫 호출에서 채움
    function starBtn(tbl, idx, entry) {
        if (!SL()) return "";
        if (!_onIds) _onIds = SL().idSet(store(), _team);
        const id = SL().entryId(entry), on = _onIds.has(id);
        return `<button type="button" class="rc-star${on ? " is-on" : ""}" data-sl-add="${idx}" data-sl-tbl="${ttEsc(tbl)}" data-sl-id="${ttEsc(id)}"
            aria-pressed="${on}" aria-label="후보 목록: ${ttEsc(entry.name)}" title="${on ? "후보 목록에서 빼기" : "후보 목록에 담기"}">${on ? "★" : "☆"}</button>`;
    }
    function keep(tbl, entries) { _rows[tbl] = entries; _onIds = null; return entries; }
    function slCount() { return SL() ? SL().list(store(), _team).length : 0; }
    function refreshShortlist() {
        const btn = document.getElementById("rc-sl-btn"), panel = document.getElementById("rc-sl-panel");
        if (!btn || !panel || !SL()) return;
        btn.querySelector(".rc-sl-n").textContent = slCount();
        if (!panel.hidden) panel.innerHTML = SL().panelHtml(SL().list(store(), _team), ttEsc);
        const ids = SL().idSet(store(), _team);
        document.querySelectorAll("#ws-team-recruit [data-sl-id]").forEach(b => {
            const on = ids.has(b.dataset.slId);
            b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on); b.textContent = on ? "★" : "☆";
            b.title = on ? "후보 목록에서 빼기" : "후보 목록에 담기";
        });
    }
    function slMsg(text) {
        const m = document.getElementById("rc-sl-msg");
        if (m) m.textContent = text;
    }

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
                ${sel("rc-real", "해외 후보", _f.real, [["1", "현실적 후보만"], ["0", "상위 구단 포함"]])}
                ${sel("rc-mvcap", "시장가치", _f.max_value, [["1000000", "€1M 이하"], ["3000000", "€3M 이하"], ["5000000", "€5M 이하"], ["10000000", "€10M 이하"], ["", "제한 없음"]])}
            </div>
        </div>
        <div class="rc-modes" role="tablist" aria-label="추천 방식">
            ${MODES.map(([k, l]) => `<button type="button" role="tab" class="rc-mode${k === _mode ? " is-on" : ""}" data-rc-mode="${k}"
                aria-selected="${k === _mode}">${l}</button>`).join("")}
            <span class="rc-mode-hint rc-muted" id="rc-mode-hint">${modeHint()}</span>
            <button type="button" class="rc-sl-btn" id="rc-sl-btn" aria-expanded="false" aria-controls="rc-sl-panel">★ 후보 목록 (<span class="rc-sl-n">${slCount()}</span>)</button>
        </div>
        <p class="rc-sl-msg" id="rc-sl-msg" role="status" aria-live="polite"></p>
        <div id="rc-sl-panel" class="rc-sl-panel" hidden></div>
        <div id="rc-body" class="rc-body"></div>`;
    }

    function modeHint() {
        return { position: "팀이 약한 세부 포지션에서, 같은 포지션 선수 중 약한 지표가 강한 선수",
                 style: "포지션과 무관하게 — 팀 전체가 약한 플레이 지표(수비 행동·창출 등)가 강한 선수",
                 similar: "고른 선수와 90분당 플레이 프로필이 가장 비슷한 선수 (포지션 무관 — 대체 자원 찾기)" }[_mode];
    }

    // K2 후보의 K1 환산(골+도움/90 ×0.68 → K1 같은 포지션 백분위) — K1 팀 추천일 때만 서버가 채움
    function k1EquivHtml(c) {
        const e = c.k1_equiv;
        if (!e) return "";
        return `<span class="rc-k1eq" title="K2 골+도움/90 ${e.atk90} → K1 환산 ${e.atk90_k1} (리그 이동 팀 측정 계수 ×0.68). 수비 지표는 환산 근거가 없어 미보정">
            K1 환산 공격 ${e.pct_k1}%ile</span>`;
    }

    // Transfermarkt 추정 시장가치(공개 데이터셋, 업데이트 중단 — 기준일 함께) · 연결 안 된 선수는 표시 없음
    function mvText(c) {
        const v = Number(c && c.market_value);
        if (!isFinite(v) || v <= 0) return "";
        const t = v >= 1e6 ? `€${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : `€${Math.round(v / 1e3)}K`;
        return t;
    }
    function mvHtml(c) {
        const t = mvText(c);
        if (!t) return "";
        const tip = `Transfermarkt 추정 시장가치 ${t}${c.mv_date ? " (" + c.mv_date + " 기준)" : ""}${c.mv_peak ? " · 최고 €" + (c.mv_peak / 1e6).toFixed(1) + "M" : ""}${c.contract_until ? " · 계약 ~" + c.contract_until : ""}`;
        return ` · <span class="rc-mv" title="${ttEsc(tip)}">💶 ${ttEsc(t)}</span>`;
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
        const tbl = "pos-" + n.group;
        const ents = keep(tbl, n.candidates.map(c => ({ src: "kr", player_id: c.player_id, name: c.name, team: c.team, league: c.league,
            age: c.age, mins: c.mins, goals: c.goals, assists: c.assists, detail: n.label, score: c.score, fitLabel: "적합도", fit: c.fit,
            metrics: n.weak_metrics.map(w => ({ label: w.label, pct: c.focus_pcts[w.key] })), mode: "position", saved: today() })));
        const rows = n.candidates.map((c, i) => `<tr>
                <td class="rc-idx">${starBtn(tbl, i, ents[i])}${i + 1}</td>
                <td><button type="button" class="rc-plink rc-name" data-rc-player="${c.player_id}">${ttEsc(c.name)}</button>
                    <span class="rc-sub">${ttEsc(c.nationality || "")}${c.height ? " · " + c.height + "cm" : ""}${c.foot ? " · " + ttEsc(({ Right: "오른발", Left: "왼발", Both: "양발" })[c.foot] || c.foot) : ""}${c.detail_est ? " · 포지션 추정" : ""}${mvHtml(c)}</span></td>
                <td>${ttEsc(c.team || "")} <span class="rc-lg rc-lg-${ttEsc(c.league)}">${ttEsc(c.league)}</span>${k1EquivHtml(c)}</td>
                <td class="rc-num">${c.age ?? "-"}</td>
                <td class="rc-num">${c.mins.toLocaleString()}<span class="rc-muted">분</span></td>
                <td class="rc-num">${c.goals ?? 0}·${c.assists ?? 0}</td>
                ${focusKeys.map(k => `<td class="rc-num">${bar(c.focus_pcts[k])}${c.focus_pcts[k] ?? "-"}</td>`).join("")}
                <td class="rc-num">${c.score}</td>
                <td class="rc-num rc-fit"><b>${c.fit}</b></td>
            </tr>`).join("");
        const table = n.candidates.length ? `<table class="rc-table">
                <thead><tr><th scope="col" title="☆ 후보 목록에 담기">#</th><th scope="col">후보</th><th scope="col">소속</th><th scope="col">나이</th><th scope="col">출전</th><th scope="col">골·도움</th>
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
            <p class="rc-pool rc-muted">조건 충족 후보 ${n.pool_size}명 중 적합도 상위 ${n.candidates.length}명${n.excluded_over_value ? ` · 시장가치 상한 초과 ${n.excluded_over_value}명 제외` : ""}</p>
            <button type="button" class="rc-os-btn" data-rc-os="${ttEsc(n.group)}" data-rc-focus="${ttEsc(focusKeys.map(k => OS_FOCUS[k]).filter(Boolean).join(","))}"
                aria-expanded="false">🌍 해외 후보 보기 <span class="rc-muted">(유럽 1~3부·브라질·일본)</span></button>
            <div class="rc-os" id="rc-os-${ttEsc(n.group)}" aria-live="polite"></div>
        </section>`;
    }

    // ── 해외 후보 (/api/overseas-recruit) — 약한 지표(K리그 키)를 해외 API 지표 키로 매핑 ──
    const OS_FOCUS = { goals90: "goals90", atk90: "assists90", create: "kp90", def: "def90", pass_acc: "pass_acc", duel: "dribble90" };
    const OS_TIER = { 1: "1부", 2: "2부", 3: "3부" };
    const OS_DETAIL = { GK: "골키퍼", CB: "센터백", FB: "풀백·윙백", DM: "수비형 MF", CM: "중앙 MF", AM: "공격형 MF", W: "윙어", ST: "스트라이커" };
    // 포메이션 사실 표시(점수 미반영) — '4-3-3 위주 · 3백 선발 2/18', 우리 팀 계열 선발 0이면 ⚠ 문구
    function osFormText(c) {
        if (!c.formation_main) return "";
        const m = c.fam_match;
        const fam = m ? (m.n ? `${m.family} ${m.n}/${m.tot}경기` : `⚠ ${m.family} 선발 경험 없음`) : "";
        return `${c.formation_main} 위주${fam ? " · " + fam : ""}`;
    }
    function osHtml(d, group) {
        if (!d.candidates.length) return `<p class="rc-empty">해외 후보가 없습니다 — 데이터가 수집된 리그가 없거나 필터가 너무 좁습니다.</p>`;
        const keys = Object.keys(d.metric_labels);
        const tbl = "os-" + group;
        const ents = keep(tbl, d.candidates.map(c => {
            const noAdj = c.factor === 1 || c.adj === c.raw;
            return { src: "os", name: c.name, team: c.team, league: c.league, age: c.age, mins: c.mins,
                goals: c.goals, assists: c.assists, detail: [OS_DETAIL[c.detail], c.formation_main ? c.formation_main + " 위주" : ""].filter(Boolean).join(" · "), score: c.raw,
                fitLabel: noAdj ? "종합" : "보정", fit: noAdj ? c.raw : c.adj,
                metrics: keys.map(k => ({ label: d.metric_labels[k], pct: c.pcts[k] })), mode: "position", saved: today() };
        }));
        const rows = d.candidates.map((c, i) => `<tr>
            <td class="rc-idx">${starBtn(tbl, i, ents[i])}${i + 1}</td>
            <td><span class="rc-name">${ttEsc(c.name)}</span><span class="rc-sub">${ttEsc(c.nationality || "")}${c.height ? " · " + c.height + "cm" : ""}${c.detail && OS_DETAIL[c.detail] ? ` · ${OS_DETAIL[c.detail]}${c.starts ? ` (선발 ${c.starts})` : ""}` : ""}${mvHtml(c)}</span>${osFormText(c)
                ? `<span class="rc-sub rc-os-form${c.fam_match && !c.fam_match.n ? " is-miss" : ""}"${c.fam_match ? ` title="포메이션을 확인할 수 있는 선발 ${c.fam_match.tot}경기 중 ${ttEsc(c.fam_match.family)} 계열 ${c.fam_match.n}경기 — 세부 포지션 '선발 N'과는 집계 기준이 다를 수 있음"` : ""}>${ttEsc(osFormText(c))}</span>` : ""}</td>
            <td>${ttEsc(c.team || "")} <span class="rc-lg" title="${ttEsc(c.league)}">${ttEsc(c.country || "")} ${OS_TIER[c.tier] || ""}</span>
                <span class="rc-sub">${ttEsc(c.league)}${c.season_label ? ` · <b class="rc-os-season">${ttEsc(c.season_label)}</b>` : ""}${c.team_rank ? ` · 팀 ${c.team_rank}/${c.team_n}위` : ""}</span></td>
            <td class="rc-num">${c.age ?? "-"}</td>
            <td class="rc-num">${c.mins.toLocaleString()}<span class="rc-muted">분</span></td>
            <td class="rc-num">${c.goals}·${c.assists}</td>
            ${keys.map(k => `<td class="rc-num" title="${ttEsc(d.metric_labels[k])}: ${c.stats[k] ?? "-"}">${bar(c.pcts[k])}${c.pcts[k] ?? "-"}</td>`).join("")}
            <td class="rc-num">${c.raw}</td>
            ${c.factor === 1 || c.adj === c.raw
                ? `<td class="rc-num rc-muted" title="리그 수준 보정 없음(계수 1.0) — 종합과 같은 값">–</td>`
                : `<td class="rc-num rc-fit" title="리그 내 점수 ${c.raw} × 리그 수준 계수 ${c.factor} (추정)"><b>${c.adj}</b></td>`}</tr>`).join("");
        const tf = d.team_formation;
        const tfLine = tf ? `<p class="rc-os-team">우리 팀 주 포메이션 <b>${ttEsc(tf.formation)}</b> <span class="rc-muted">(${ttEsc(tf.family)}, ${tf.of}경기 중 ${tf.games})</span>
            <span class="rc-muted">— 후보 포메이션은 사실 표시만, 점수에 반영하지 않음</span></p>` : "";
        return `${tfLine}<table class="rc-table"><thead><tr><th scope="col" title="☆ 후보 목록에 담기">#</th><th scope="col">후보</th><th scope="col">소속</th><th scope="col">나이</th>
            <th scope="col">출전</th><th scope="col">골·도움</th>
            ${keys.map(k => `<th scope="col" title="같은 리그·같은 포지션 중 백분위">${ttEsc(d.metric_labels[k])}</th>`).join("")}
            <th scope="col" title="리그 내 종합 백분위(0~100)">종합</th><th scope="col" title="종합 × 리그 수준 추정 계수 — 참고용">보정</th></tr></thead>
            <tbody>${rows}</tbody></table>
            <p class="rc-pool rc-muted">후보 ${d.pool_size}명 중 상위 ${d.candidates.length}명${d.detail_label ? ` · ${ttEsc(d.detail_label)}${d.unlabeled ? ` (라인업 라벨 없는 ${d.unlabeled}명 제외)` : ""}` : ""}${d.filters.realistic ? ` · 상위 구단 소속 ${d.excluded_top_clubs}명 제외` : " · 상위 구단 포함"}${d.excluded_over_value ? ` · 시장가치 상한 초과 ${d.excluded_over_value}명 제외` : ""} · 보정 점수는 추정 계수 적용(검증 전, 참고용)</p>
            <details class="rc-notes"><summary>해외 후보 기준</summary><ul>${d.notes.map(x => `<li>${ttEsc(x)}</li>`).join("")}</ul></details>`;
    }
    function loadOverseas(btn) {
        const box = document.getElementById("rc-os-" + btn.dataset.rcOs);
        if (!box) return;
        if (btn.getAttribute("aria-expanded") === "true") {      // 토글: 접기
            btn.setAttribute("aria-expanded", "false"); box.innerHTML = ""; return;
        }
        btn.setAttribute("aria-expanded", "true");
        box.innerHTML = `<div class="rc-loading" role="status">해외 후보 분석 중...</div>`;
        const q = new URLSearchParams({ pos: btn.dataset.rcOs, min_minutes: _f.min_minutes, limit: "10", realistic: _f.real });
        if (_team) q.set("team", _team);      // 팀 미선택이면 team=null 문자열을 보내지 않음(캐시 키 낭비)
        if (_f.max_value) q.set("max_value", _f.max_value);
        if (_f.max_age) q.set("max_age", _f.max_age);
        if (btn.dataset.rcFocus) q.set("focus", btn.dataset.rcFocus);
        fetch(`/api/overseas-recruit?${q}`).then(r => r.json().then(j => ({ ok: r.ok, j })))
            .then(({ ok, j }) => { if (!box.isConnected) return;   // 화면을 다시 그린 뒤 늦게 온 응답 — 옛 표·_rows 를 덮지 않음
                if (!ok) throw new Error(j.error || "overseas"); box.innerHTML = osHtml(j, btn.dataset.rcOs); })
            .catch(err => { console.error("[해외 후보 실패]", err);
                box.innerHTML = `<div class="rc-error" role="alert">해외 후보를 불러오지 못했습니다.</div>`; });
    }

    // ── 플레이 기준 공통: 후보 표 ─────────────────────────────
    function playTable(cands, cols, scoreLabel, scoreKey, scoreTitle, tbl) {
        if (!cands.length) return `<p class="rc-empty">조건에 맞는 후보가 없습니다 — 필터를 완화해 보세요.</p>`;
        const ents = keep(tbl, cands.map(c => ({ src: "kr", player_id: c.player_id, name: c.name, team: c.team, league: c.league,
            age: c.age, mins: c.mins, goals: c.goals, assists: c.assists, detail: c.pos || "", score: c.score, fitLabel: scoreLabel, fit: c[scoreKey],
            metrics: cols.map(([k, l]) => ({ label: l, pct: (c.focus_pcts || c.profile || {})[k] })), mode: tbl, saved: today() })));
        const rows = cands.map((c, i) => `<tr>
            <td class="rc-idx">${starBtn(tbl, i, ents[i])}${i + 1}</td>
            <td><button type="button" class="rc-plink rc-name" data-rc-player="${c.player_id}">${ttEsc(c.name)}</button>
                <span class="rc-sub">${ttEsc(c.pos || "")}${c.nationality ? " · " + ttEsc(c.nationality) : ""}${c.height ? " · " + c.height + "cm" : ""}${mvHtml(c)}</span></td>
            <td>${ttEsc(c.team || "")} <span class="rc-lg rc-lg-${ttEsc(c.league)}">${ttEsc(c.league)}</span>${k1EquivHtml(c)}</td>
            <td class="rc-num">${c.age ?? "-"}</td>
            <td class="rc-num">${c.mins.toLocaleString()}<span class="rc-muted">분</span></td>
            ${cols.map(([k]) => { const v = (c.focus_pcts || c.profile || {})[k]; return `<td class="rc-num">${bar(v)}${v ?? "-"}</td>`; }).join("")}
            <td class="rc-num rc-fit"><b>${c[scoreKey]}</b></td></tr>`).join("");
        return `<table class="rc-table"><thead><tr><th scope="col" title="☆ 후보 목록에 담기">#</th><th scope="col">후보</th><th scope="col">소속</th>
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
                <span class="rc-muted">포지션 무관 후보 ${d.pool_size}명 중 상위 ${d.candidates.length}명${d.excluded_over_value ? ` · 시장가치 상한 초과 ${d.excluded_over_value}명 제외` : ""}</span></div>
                ${playTable(d.candidates, cols, "적합도", "fit", "약한 지표 백분위 평균 70% + 종합 점수 30%", "style")}</section>
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
                <span class="rc-muted">후보 ${d.pool_size}명 중 상위 ${d.candidates.length}명${d.excluded_over_value ? ` · 시장가치 상한 초과 ${d.excluded_over_value}명 제외` : ""}</span></div>
                ${playTable(d.candidates, cols, "유사도", "similarity", "100 − 지표 백분위 차이의 RMS", "similar")}</section>
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
        if (_f.max_value) q.set("max_value", _f.max_value);
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
                _rows = {};
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
            if (t.id === "rc-team") { _team = t.value; _player = null; _squad = []; slMsg(""); refreshShortlist(); }
            else if (t.id === "rc-scope") _f.scope = t.value;
            else if (t.id === "rc-age") _f.max_age = t.value;
            else if (t.id === "rc-mins") _f.min_minutes = t.value;
            else if (t.id === "rc-mvcap") {     // 국내 추천 다시 조회 + 열려 있는 해외 표도 다시
                _f.max_value = t.value;
                el.querySelectorAll('[data-rc-os][aria-expanded="true"]').forEach(b => { b.setAttribute("aria-expanded", "false"); });
            }
            else if (t.id === "rc-real") {      // 해외 후보에만 적용 — 열려 있는 해외 표만 다시 불러온다(국내 추천 재조회 불필요)
                _f.real = t.value;
                el.querySelectorAll('[data-rc-os][aria-expanded="true"]').forEach(b => { b.setAttribute("aria-expanded", "false"); loadOverseas(b); });
                return;
            }
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
            if (handleShortlist(e)) return;
            const os = e.target.closest("[data-rc-os]");
            if (os) { loadOverseas(os); return; }
            const b = e.target.closest("[data-rc-player]");
            if (!b) return;
            const pid = parseInt(b.dataset.rcPlayer, 10);
            if (pid) document.dispatchEvent(new CustomEvent("playerSelected", { detail: { playerId: pid } }));
        });
    }

    function handleShortlist(e) {
        if (!SL()) return false;
        const add = e.target.closest("[data-sl-add]");
        if (add) {
            const entry = SL().pick(_rows[add.dataset.slTbl], parseInt(add.dataset.slAdd, 10), add.dataset.slId);
            if (!entry) return true;
            const id = SL().entryId(entry);
            if (SL().has(store(), _team, id)) {
                SL().remove(store(), _team, id); refreshShortlist();
                slMsg(`${entry.name} — 후보 목록에서 뺐습니다.`);
                return true;
            }
            const r = SL().add(store(), _team, entry);
            refreshShortlist();
            slMsg(r === "full" ? `후보는 팀당 ${SL().MAX}명까지 담을 수 있습니다. 목록에서 빼고 다시 담아 주세요.`
                : r === "added" ? `${entry.name} — 후보 목록에 담았습니다.`
                : r === "nostore" ? "이 브라우저에서는 후보 목록을 저장할 수 없습니다(사생활 보호 모드·저장 공간 부족 등)."
                : r === "invalid" ? "이 후보는 정보가 부족해 담을 수 없습니다." : "");
            return true;
        }
        if (e.target.closest("#rc-sl-btn")) {
            const btn = document.getElementById("rc-sl-btn"), panel = document.getElementById("rc-sl-panel");
            const open = panel.hidden;
            panel.hidden = !open; btn.setAttribute("aria-expanded", open);
            if (open) refreshShortlist(); else panel.innerHTML = "";
            return true;
        }
        const rm = e.target.closest("[data-sl-remove]");
        if (rm) {
            SL().remove(store(), _team, rm.dataset.slRemove); refreshShortlist();
            const btn = document.getElementById("rc-sl-btn");
            if (btn) btn.focus();
            return true;
        }
        if (e.target.closest("[data-sl-clear]")) {
            if (confirm("이 팀 후보 목록을 모두 비울까요?")) { SL().clear(store(), _team); refreshShortlist(); }
            return true;
        }
        if (e.target.closest("[data-sl-csv]")) {
            const t = (_teams || []).find(x => x.id === _team);
            const blob = new Blob([SL().toCsv(SL().list(store(), _team))], { type: "text/csv;charset=utf-8" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = SL().csvName(t ? t.name : _team, today());
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            return true;
        }
        return false;
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
