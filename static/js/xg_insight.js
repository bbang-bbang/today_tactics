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

    const api = { validHtml };
    if (root) root.ttXgInsight = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
