// 외부·사용자 문자열 이스케이프 (여러 파일에 같은 정의)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/* team_report.js — 해외 리그 팀 리포트 렌더러 (2026-11-25). 해외리그 탭 '🧾 팀 리포트'.
 * 데이터: /api/league/<code>/team-report?team_id=&year= — 공식 순위·순위 흐름·최근 폼·팀 xG·포메이션·핵심 선수·스쿼드 가치. */
(function (root) {
    "use strict";
    const RES = { W: "승", D: "무", L: "패" };
    const mv = (v) => (v == null ? "-" : "€" + (v / 1e6 >= 100 ? Math.round(v / 1e6) : (v / 1e6).toFixed(1)) + "M");
    const sgn = (v, d = 2) => (v == null ? "-" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
    const FOOT = { Right: "오른발", Left: "왼발", Both: "양발" };
    const phys = (p) => [p.height ? p.height + "cm" : "", p.foot ? (FOOT[p.foot] || p.foot) : ""].filter(Boolean).join(" · ") || "-";
    const empty = (msg) => `<p class="tr-empty">${msg}</p>`;

    function flowSvg(flow, n) {
        if (!flow || !flow.length) return empty("이 시즌 종료된 경기가 없습니다.");
        const W = 640, H = 180, L = 30, R = 10, T = 12, B = 22;
        const N = Math.max(n || 0, ...flow.map(p => p.rank));
        const x = (i) => L + (flow.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (flow.length - 1));
        const y = (r) => T + (N <= 1 ? 0 : (r - 1) * (H - T - B) / (N - 1));      // 1위 = 위
        const pts = flow.map((p, i) => `${x(i).toFixed(1)},${y(p.rank).toFixed(1)}`).join(" ");
        const grid = [1, Math.ceil(N / 2), N].filter((v, i, a) => a.indexOf(v) === i)
            .map(r => `<line x1="${L}" x2="${W - R}" y1="${y(r).toFixed(1)}" y2="${y(r).toFixed(1)}" class="tr-grid"/>`
                + `<text x="${L - 6}" y="${(y(r) + 4).toFixed(1)}" class="tr-axis" text-anchor="end">${r}</text>`).join("");
        const dots = flow.map((p, i) => {
            const lab = `${p.round != null ? "R" + p.round : (i + 1) + "경기"} · ${p.rank}위 · ${RES[p.res] || ""} ${p.gf}-${p.ga}`;
            return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.rank).toFixed(1)}" r="4" class="tr-dot tr-dot-${ttEsc(p.res)}"><title>${ttEsc(lab)}</title></circle>`;
        }).join("");
        const first = flow[0], last = flow[flow.length - 1];
        const xl = `<text x="${L}" y="${H - 4}" class="tr-axis">${first.round != null ? "R" + first.round : "1경기"}</text>`
            + `<text x="${W - R}" y="${H - 4}" class="tr-axis" text-anchor="end">${last.round != null ? "R" + last.round : flow.length + "경기"}</text>`;
        return `<svg class="tr-flow" viewBox="0 0 ${W} ${H}" role="img" aria-label="라운드별 순위 흐름: ${first.rank}위에서 ${last.rank}위">${grid}`
            + `<polyline points="${pts}" class="tr-line"/>${dots}${xl}</svg>`;
    }

    function xgCard(x) {
        if (!x) return empty("팀 xG 데이터 없음 (공급자 미제공 리그이거나 xG 경기 3경기 미만)");
        const c = x.coverage || {};
        const warn = c.pct != null && c.pct < 60 ? `<p class="tr-warn" role="note">⚠ 리그 xG 제공 ${c.xg_games}/${c.games}경기(${c.pct}%) — 참고만</p>` : "";
        return `<p class="tr-big">xG 차 <b>${sgn(x.xg_diff)}</b> <span class="tr-muted">리그 ${x.xg_rank}/${x.n_ranked}위</span></p>
            <dl class="tr-kv"><dt>xG / 경기</dt><dd>${sgn(x.xg_for).replace("+", "")}</dd><dt>xGA / 경기</dt><dd>${sgn(x.xg_against).replace("+", "")}</dd>
            <dt title="+면 기대보다 많이 넣음">득점−xG</dt><dd>${sgn(x.g_minus_xg)}</dd><dt title="−면 기대보다 적게 먹음">실점−xGA</dt><dd>${sgn(x.ga_minus_xga)}</dd>
            <dt>표본</dt><dd>${x.xg_games}경기</dd></dl>${warn}`;
    }

    function formCard(f) {
        if (!f || !f.n) return empty("선발 위치 데이터 없음 (라인업 미제공)");
        const fam = Object.entries(f.family || {}).map(([k, v]) => `${ttEsc(k)} ${v}`).join(" · ");
        return `<p class="tr-big"><b>${ttEsc(f.list[0].formation)}</b> <span class="tr-muted">${f.list[0].n}/${f.n}경기</span></p>
            <ul class="tr-forms">${f.list.slice(0, 4).map(r => `<li><span>${ttEsc(r.formation)}</span><span class="tr-bar" style="--w:${Math.round(r.n / f.n * 100)}%"></span><span class="tr-muted">${r.n}</span></li>`).join("")}</ul>
            ${fam ? `<p class="tr-muted">${fam}경기</p>` : ""}`;
    }

    function svCard(s, current) {
        if (!current) return empty("스쿼드 가치는 현재 시즌에서만 보여 줍니다 (시장가치·소속이 현재 기준).");
        if (!s) return empty("시장가치 연결 선수 없음");
        const cls = !s.diff ? "" : (s.diff > 0 ? " tr-pos" : " tr-neg");
        const msg = s.diff > 0 ? "몸값보다 잘함" : s.diff < 0 ? "몸값만큼 못 함" : "몸값만큼";
        return `<p class="tr-big"><b>${mv(s.value)}</b> <span class="tr-muted">가치 ${s.value_rank}/${s.n_teams}위</span></p>
            <p>실제 ${s.rank}위 · 차이 <b class="${cls.trim()}">${s.diff > 0 ? "+" : ""}${s.diff}</b> <span class="tr-muted">(${msg})</span></p>
            <p class="tr-muted">시장가치 있는 선수 ${s.n_valued}/${s.n_linked}명 합</p>`;
    }

    function playersHtml(d) {
        const ps = d.players || [];
        if (!ps.length) return empty("선수 시즌 기록 없음");
        const ld = d.leaders || {};
        const lead = [ld.goals && ld.goals.goals ? `득점 1위 <b>${ttEsc(ld.goals.name)}</b> ${ld.goals.goals}골` : "",
            ld.assists && ld.assists.assists ? `도움 1위 <b>${ttEsc(ld.assists.name)}</b> ${ld.assists.assists}` : "",
            ld.rating ? `평점 1위 <b>${ttEsc(ld.rating.name)}</b> ${ld.rating.rating}` : ""].filter(Boolean).join(" · ");
        const rows = ps.map(p => `<tr><td>${ttEsc(p.name)}</td><td>${ttEsc(p.position || "-")}</td><td${p.phys_src === "TM" ? ' title="Transfermarkt 값으로 보완"' : ""}>${ttEsc(phys(p))}</td><td class="tr-num">${p.apps ?? "-"}</td>
            <td class="tr-num">${p.minutes ?? "-"}</td><td class="tr-num">${p.goals}</td><td class="tr-num">${p.assists}</td>
            <td class="tr-num">${p.rating ?? "-"}</td><td class="tr-num">${mv(p.market_value)}</td></tr>`).join("");
        return `${lead ? `<p class="tr-lead">${lead}</p>` : ""}<div class="tr-scroll"><table class="tr-table">
            <caption class="tr-muted">출전 시간 상위 ${ps.length}명${d.stats_label ? " · " + ttEsc(d.stats_label) : ""}</caption>
            <thead><tr><th scope="col">선수</th><th scope="col">포지션</th><th scope="col">키·주발</th><th scope="col">경기</th><th scope="col">분</th><th scope="col">골</th>
            <th scope="col">도움</th><th scope="col">평점</th><th scope="col">시장가치</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function html(d) {
        const o = d.official, form = d.form || [];
        const head = `<div class="tr-head"><h3 class="tr-name">${ttEsc(d.team && d.team.name)}</h3>
            ${o ? `<span class="tr-rank"><b>${o.rank}위</b> / ${d.n_teams || "-"}</span><span class="tr-muted">승점 ${o.pts} · ${o.w}승 ${o.d}무 ${o.l}패 · ${o.gf}득 ${o.ga}실</span>` : ""}
            ${form.length ? `<span class="tr-form" aria-label="최근 ${form.length}경기: ${form.map(r => RES[r]).join(", ")}">${form.slice().reverse().map(r => `<span class="tr-form-chip tr-f-${ttEsc(r)}">${RES[r] || "?"}</span>`).join("")}</span>` : ""}</div>`;
        return `<div class="tr-wrap">${head}
            <section class="tr-card tr-card-wide"><h4>📈 순위 흐름</h4>${flowSvg(d.flow, d.n_teams)}</section>
            <div class="tr-grid3">
              <section class="tr-card"><h4>🎯 팀 xG</h4>${xgCard(d.xg)}</section>
              <section class="tr-card"><h4>🧩 포메이션</h4>${formCard(d.formations)}</section>
              <section class="tr-card"><h4>💰 스쿼드 가치</h4>${svCard(d.squad_value, d.is_current)}</section>
            </div>
            <section class="tr-card tr-card-wide"><h4>⭐ 핵심 선수</h4>${playersHtml(d)}</section>
            <details class="tr-notes"><summary>기준</summary><ul>${(d.notes || []).map(n => `<li>${ttEsc(n)}</li>`).join("")}</ul></details></div>`;
    }

    const api = { html };
    if (root) root.ttTeamReport = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
