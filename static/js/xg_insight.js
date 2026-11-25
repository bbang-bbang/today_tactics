// 외부·사용자 문자열 이스케이프 (여러 파일에 같은 정의)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/* xg_insight.js — xG 예측력 검증 카드 (2026-11-25). 해외리그 탭 '📈 팀 xG' 아래.
 * 데이터: /api/league/<code>/team-xg 의 validation(이 리그) + /api/overseas-xg-validation 의 pooled(전 리그 합산).
 * 전반기 경기당 지표 ↔ 후반기 경기당 승점 상관계수 r. */
(function (root) {
    "use strict";
    const METRICS = [["pts", "승점"], ["gd", "득실차"], ["xgd", "xG 차"], ["xpts", "xPts(기대 승점)"]];
    const fmt = (r) => (r == null ? "-" : (r > 0 ? "" : "") + Number(r).toFixed(2));
    const ciTxt = (v, k) => { const c = v["ci_" + k]; return c ? `${Number(c[0]).toFixed(2)}~${Number(c[1]).toFixed(2)}` : ""; };
    const ok = (v) => v && v.n_teams >= 3 && METRICS.some(([k]) => v["r_" + k] != null);

    function block(v, title) {
        const best = METRICS.filter(([k]) => v["r_" + k] != null).sort((a, b) => v["r_" + b[0]] - v["r_" + a[0]])[0];
        const rows = METRICS.map(([k, lab]) => {
            const r = v["r_" + k];
            const w = r == null ? 0 : Math.max(0, Math.min(1, r)) * 100;
            return `<div class="xi-row"${best && best[0] === k ? ' data-best="1"' : ""}><span class="xi-lab">${lab}</span>`
                + `<span class="xi-bar" style="--w:${w.toFixed(0)}%" aria-hidden="true"></span><span class="xi-val"${ciTxt(v, k) ? ` title="95% 신뢰구간 ${ciTxt(v, k)}"` : ""}>${fmt(r)}</span></div>`;
        }).join("");
        return `<div class="xi-block"><h5>${title} <span class="xi-muted">팀 ${v.n_teams}${v.n_leagues ? " · " + v.n_leagues + "개 리그" : ""}</span></h5>${rows}
            ${best ? `<p class="xi-muted">가장 잘 맞힌 지표: <b>${best[1]}</b>${ciTxt(v, best[0]) ? ` (95% 구간 ${ciTxt(v, best[0])})` : ""}</p>` : ""}</div>`;
    }

    function validHtml(league, pooled, label) {
        const lo = ok(league), po = ok(pooled);
        if (!lo && !po) return "";
        return `<section class="xi-card" aria-label="xG 예측력 검증"><h4>🔮 전반기 지표로 후반기 승점 맞히기</h4>
            <p class="xi-lead">팀마다 이번 시즌을 반으로 나눠, 전반기 경기당 지표가 후반기 경기당 승점과 얼마나 같이 움직였는지(상관계수 r, 1에 가까울수록 잘 맞힘)</p>
            <div class="xi-grid">${lo ? block(league, ttEsc(label)) : `<div class="xi-block"><h5>${ttEsc(label)}</h5><p class="xi-muted">표본 부족 (경기 10경기 이상인 팀이 3팀 미만)</p></div>`}
            ${po ? block(pooled, "전 리그 합산") : ""}</div></section>`;
    }

    // ── 팀 xG 표 (해외리그 탭 · K리그 시즌 리뷰 공용, 2026-11-25) ─────────────
    const sg = (v, d = 2) => (v == null ? "-" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
    const tone = (v, goodPositive) => (v == null || Math.abs(v) < 0.05 ? "" : ((v > 0) === goodPositive ? " gl-xg-pos" : " gl-xg-neg"));

    function tableHtml(d, slotId) {
        const all = (d && d.teams) || [];
        const rows = all.filter(r => r.xg_for != null);
        if (!rows.length) return "";
        const hasBox = rows.some(r => r.box_share != null), hasPoss = rows.some(r => r.possession != null);
        const cov = d.coverage || {};
        const low = cov.pct != null && cov.pct < 60;
        const covHtml = cov.games ? `<p class="gl-xg-cov${low ? " gl-xg-cov-low" : ""}" ${low ? 'role="note"' : ""}>${low ? "⚠ " : ""}xG 제공 <b>${cov.xg_games}/${cov.games}경기</b> (${cov.pct}%)`
            + (low ? " — xG 가 일부 경기에만 있어 표본이 작습니다. 순위·결론은 참고만 하세요." : "")
            + (rows.length < all.length ? ` · xG 경기 ${d.min_games || 3}경기 미만 팀 ${all.length - rows.length}곳은 표에서 뺌` : "")
            + `</p>` : "";
        const h = d.highlights || {};
        const lead = `<p class="gl-xg-lead">경기 내용(xG 차) 1위 <b>${ttEsc(h.best_xg_diff || "-")}</b>`
            + (h.over ? ` · 기대보다 많이 넣은 팀 <b>${ttEsc(h.over.name)}</b> (경기당 ${sg(h.over.value)})` : "")
            + (h.under ? ` · 기대보다 못 넣은 팀 <b>${ttEsc(h.under.name)}</b> (경기당 ${sg(h.under.value)})` : "")
            + ` <span class="gl-muted">— ${d.games || 0}경기 기준</span></p>`;
        const body = rows.map((r, i) => `<tr>
            <td class="gl-xg-rank">${i + 1}</td><td>${ttEsc(r.name)}</td><td class="gl-num">${r.xg_games}</td>
            <td class="gl-num">${Number(r.xg_for).toFixed(2)}</td><td class="gl-num">${Number(r.xg_against).toFixed(2)}</td>
            <td class="gl-num${tone(r.xg_diff, true)}"><b>${sg(r.xg_diff)}</b></td>
            <td class="gl-num${tone(r.g_minus_xg, true)}">${sg(r.g_minus_xg)}</td>
            <td class="gl-num${tone(r.ga_minus_xga, false)}">${sg(r.ga_minus_xga)}</td>
            <td class="gl-num">${r.xpts != null ? Number(r.xpts).toFixed(1) : "-"} <span class="gl-muted">/ ${r.pts_x ?? "-"}</span></td>
            <td class="gl-num${tone(r.pts_minus_xpts, true)}">${sg(r.pts_minus_xpts, 1)}</td>
            <td class="gl-num">${r.shots_pg ?? "-"}</td>${hasBox ? `<td class="gl-num">${r.box_share != null ? r.box_share + "%" : "-"}</td>` : ""}
            ${hasPoss ? `<td class="gl-num">${r.possession != null ? r.possession + "%" : "-"}</td>` : ""}</tr>`).join("");
        return `<div class="gl-xg">${lead}${covHtml}
          <div class="gl-xg-scroll"><table class="gl-table gl-xg-table">
            <caption class="gl-muted">경기당 평균 · xG 차 큰 순 · 초록/빨강은 좋음/나쁨 방향(부호 함께 표시)</caption>
            <thead><tr><th scope="col">#</th><th scope="col">팀</th><th scope="col" title="xG 있는 경기 수">경기</th>
              <th scope="col" title="경기당 기대득점">xG</th><th scope="col" title="경기당 허용 기대득점">xGA</th>
              <th scope="col" title="xG − xGA (경기당)">xG 차</th><th scope="col" title="득점 − xG (경기당): +면 기대보다 많이 넣음">득점−xG</th>
              <th scope="col" title="실점 − xGA (경기당): −면 기대보다 적게 먹음">실점−xGA</th>
              <th scope="col" title="기대 승점(xG 로 계산한 승·무·패 확률 합) / 실제 승점 — xG 있는 경기 합계">xPts / 승점</th>
              <th scope="col" title="실제 승점 − 기대 승점: +면 경기 내용보다 승점을 많이 챙김(운 또는 결정력)">승점−xPts</th><th scope="col">슈팅/경기</th>
              ${hasBox ? `<th scope="col" title="전체 슈팅 중 박스 안 슈팅">박스 안</th>` : ""}${hasPoss ? `<th scope="col">점유율</th>` : ""}</tr></thead>
            <tbody>${body}</tbody></table></div>
          <div id="${ttEsc(slotId || "gl-xi-slot")}"></div>
          <details class="gl-xg-notes"><summary>기준</summary><ul>${(d.notes || []).map(n => `<li>${ttEsc(n)}</li>`).join("")}</ul></details>
        </div>`;
    }

    // 한 팀 줄 (K리그 팀 시즌 리뷰) — xG 3경기 미만이면 ""
    function teamLine(d, teamId) {
        const rows = ((d && d.teams) || []).filter(r => r.xg_for != null);
        const i = rows.findIndex(r => String(r.team_id) === String(teamId));
        if (i < 0) return "";
        const r = rows[i], c = d.coverage || {};
        return `<p class="sv-team">xG 차 <b>${sg(r.xg_diff)}</b> <span class="sv-muted">(경기당 · 리그 ${i + 1}/${rows.length}위)</span> · xG ${Number(r.xg_for).toFixed(2)} / xGA ${Number(r.xg_against).toFixed(2)}`
            + ` · 승점−xPts <b class="${r.pts_minus_xpts > 0 ? "sv-pos" : r.pts_minus_xpts < 0 ? "sv-neg" : ""}">${sg(r.pts_minus_xpts, 1)}</b>`
            + ` <span class="sv-muted">— xG 있는 ${r.xg_games}경기 기준${c.pct != null && c.pct < 60 ? ` · ⚠ 리그 xG 제공 ${c.pct}%` : ""}</span></p>`;
    }

    const api = { validHtml, tableHtml, teamLine };
    if (root) root.ttXgInsight = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
