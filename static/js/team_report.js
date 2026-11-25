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
        // 텍스트 요약 + 라운드별 표(키보드·화면낭독기·모바일 — SVG 툴팁은 마우스에서만 보임)
        const rl = (p, i) => (p.round != null ? "R" + p.round : (i + 1) + "경기");
        let bi = 0, wi = 0;
        flow.forEach((p, i) => { if (p.rank < flow[bi].rank) bi = i; if (p.rank > flow[wi].rank) wi = i; });
        const summary = `<p class="tr-flow-sum">최고 <b>${flow[bi].rank}위</b> (${rl(flow[bi], bi)}) · 최저 <b>${flow[wi].rank}위</b> (${rl(flow[wi], wi)}) · 마지막 <b>${last.rank}위</b> (${rl(last, flow.length - 1)})</p>`;
        const tbl = `<details class="tr-flow-tbl"><summary>라운드별 표</summary><div class="tr-scroll"><table class="tr-table">
            <thead><tr><th scope="col">라운드</th><th scope="col">결과</th><th scope="col">순위</th><th scope="col">승점</th></tr></thead><tbody>
            ${flow.map((p, i) => `<tr class="tr-fr"><td>${rl(p, i)}</td><td>${RES[p.res] || "-"} ${p.gf}-${p.ga}</td><td class="tr-num">${p.rank}</td><td class="tr-num">${p.pts}</td></tr>`).join("")}
            </tbody></table></div></details>`;
        return `<svg class="tr-flow" viewBox="0 0 ${W} ${H}" role="img" aria-label="라운드별 순위 흐름: ${first.rank}위에서 ${last.rank}위">${grid}`
            + `<polyline points="${pts}" class="tr-line"/>${dots}${xl}</svg>${summary}${tbl}`;
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
            <td class="tr-num">${p.rating != null ? Number(p.rating).toFixed(2) : "-"}</td><td class="tr-num">${mv(p.market_value)}</td></tr>`).join("");
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

    // ── 두 팀 비교 (2026-11-25) — 같은 리그 두 리포트 나란히 ──────────────
    function compareFlowSvg(a, b, n) {
        const fa = a.flow || [], fb = b.flow || [];
        if (!fa.length && !fb.length) return empty("종료된 경기가 없습니다.");
        const W = 640, H = 180, L = 30, R = 10, T = 12, B = 22;
        const N = Math.max(n || 0, ...fa.map(p => p.rank), ...fb.map(p => p.rank));
        const len = Math.max(fa.length, fb.length);
        const x = (i) => L + (len <= 1 ? (W - L - R) / 2 : i * (W - L - R) / (len - 1));
        const y = (r) => T + (N <= 1 ? 0 : (r - 1) * (H - T - B) / (N - 1));
        const line = (f, cls) => f.length ? `<polyline points="${f.map((p, i) => `${x(i).toFixed(1)},${y(p.rank).toFixed(1)}`).join(" ")}" class="${cls}"/>` : "";
        const grid = [1, Math.ceil(N / 2), N].filter((v, i, arr) => arr.indexOf(v) === i)
            .map(r => `<line x1="${L}" x2="${W - R}" y1="${y(r).toFixed(1)}" y2="${y(r).toFixed(1)}" class="tr-grid"/>`
                + `<text x="${L - 6}" y="${(y(r) + 4).toFixed(1)}" class="tr-axis" text-anchor="end">${r}</text>`).join("");
        const la = fa.length ? fa[fa.length - 1].rank : "-", lb = fb.length ? fb[fb.length - 1].rank : "-";
        return `<svg class="tr-flow" viewBox="0 0 ${W} ${H}" role="img" aria-label="순위 흐름 비교: ${ttEsc(a.team.name)} 마지막 ${la}위, ${ttEsc(b.team.name)} 마지막 ${lb}위">${grid}`
            + `${line(fa, "trc-line-a")}${line(fb, "trc-line-b")}</svg>`;
    }

    function compareHtml(a, b) {
        const num = (v, d = 2) => (v == null ? null : Number(v));
        const xa = a.xg || {}, xb = b.xg || {}, sa = a.squad_value || {}, sb = b.squad_value || {};
        const oa = a.official || {}, ob = b.official || {};
        const fm = (f) => (f && f.n ? `${f.list[0].formation} (${f.list[0].n}/${f.n})` : null);
        const fam = (f) => (f && f.n ? Object.entries(f.family || {}).map(([k, v]) => `${k} ${v}`).join(" · ") : null);
        const top = (d) => (d.leaders && d.leaders.goals && d.leaders.goals.goals ? `${d.leaders.goals.name} ${d.leaders.goals.goals}골` : null);
        const form = (d) => ((d.form || []).length ? (d.form || []).slice().reverse().map(r => RES[r] || "?").join(" ") : null);
        // [라벨, A 표시, B 표시, A 값, B 값, 좋은 방향('high'|'low'|null)]
        const rows = [
            ["순위", oa.rank != null ? oa.rank + "위" : null, ob.rank != null ? ob.rank + "위" : null, oa.rank, ob.rank, "low"],
            ["승점", oa.pts, ob.pts, oa.pts, ob.pts, "high"],
            ["전적", oa.w != null ? `${oa.w}승 ${oa.d}무 ${oa.l}패` : null, ob.w != null ? `${ob.w}승 ${ob.d}무 ${ob.l}패` : null, null, null, null],
            ["득실", oa.gf != null ? `${oa.gf}-${oa.ga}` : null, ob.gf != null ? `${ob.gf}-${ob.ga}` : null,
                oa.gf != null ? oa.gf - oa.ga : null, ob.gf != null ? ob.gf - ob.ga : null, "high"],
            ["최근 경기(오래된→최근)", form(a), form(b), null, null, null],
            ["xG 차 / 경기", xa.xg_diff != null ? sgn(xa.xg_diff) : null, xb.xg_diff != null ? sgn(xb.xg_diff) : null, num(xa.xg_diff), num(xb.xg_diff), "high"],
            ["xG / 경기", xa.xg_for != null ? Number(xa.xg_for).toFixed(2) : null, xb.xg_for != null ? Number(xb.xg_for).toFixed(2) : null, num(xa.xg_for), num(xb.xg_for), "high"],
            ["xGA / 경기", xa.xg_against != null ? Number(xa.xg_against).toFixed(2) : null, xb.xg_against != null ? Number(xb.xg_against).toFixed(2) : null, num(xa.xg_against), num(xb.xg_against), "low"],
            ["승점 − xPts", xa.pts_minus_xpts != null ? sgn(xa.pts_minus_xpts, 1) : null, xb.pts_minus_xpts != null ? sgn(xb.pts_minus_xpts, 1) : null, null, null, null],
            ["주 포메이션", fm(a.formations), fm(b.formations), null, null, null],
            ["3백 / 4백", fam(a.formations), fam(b.formations), null, null, null],
            ["스쿼드 가치", sa.value ? mv(sa.value) : null, sb.value ? mv(sb.value) : null, sa.value || null, sb.value || null, "high"],
            ["가치 순위 → 실제", sa.value_rank ? `${sa.value_rank}위 → ${sa.rank}위` : null, sb.value_rank ? `${sb.value_rank}위 → ${sb.rank}위` : null, null, null, null],
            ["득점 1위", top(a), top(b), null, null, null],
        ];
        const body = rows.map(([lab, da, db, va, vb, dir]) => {
            let wa = "", wb = "";
            if (dir && va != null && vb != null && va !== vb) {
                const aBetter = dir === "high" ? va > vb : va < vb;
                (aBetter ? (wa = " trc-win") : (wb = " trc-win"));
            }
            return `<tr class="trc-row"><td class="trc-a${wa}">${da == null ? "-" : ttEsc(da)}</td><th scope="row">${lab}</th><td class="trc-b${wb}">${db == null ? "-" : ttEsc(db)}</td></tr>`;
        }).join("");
        return `<div class="tr-wrap trc">
            <div class="trc-head"><span class="trc-name trc-name-a"><span class="trc-key" aria-hidden="true"></span>${ttEsc(a.team.name)}</span>
              <span class="tr-muted">vs</span><span class="trc-name trc-name-b"><span class="trc-key" aria-hidden="true"></span>${ttEsc(b.team.name)}</span></div>
            <section class="tr-card tr-card-wide"><h4>📈 순위 흐름 <span class="tr-muted">실선 = ${ttEsc(a.team.name)} · 점선 = ${ttEsc(b.team.name)}</span></h4>${compareFlowSvg(a, b, a.n_teams || b.n_teams)}</section>
            <section class="tr-card tr-card-wide"><h4>⚖️ 지표 비교 <span class="tr-muted">굵은 초록 = 더 나은 쪽</span></h4>
              <div class="tr-scroll"><table class="trc-table"><thead><tr><th scope="col" class="trc-a">${ttEsc(a.team.name)}</th><th scope="col">항목</th><th scope="col" class="trc-b">${ttEsc(b.team.name)}</th></tr></thead>
              <tbody>${body}</tbody></table></div></section>
            <details class="tr-notes"><summary>기준</summary><ul>${(a.notes || []).map(n => `<li>${ttEsc(n)}</li>`).join("")}</ul></details></div>`;
    }

    const api = { html, compareHtml };
    if (root) root.ttTeamReport = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
