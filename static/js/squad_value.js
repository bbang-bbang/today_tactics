// 외부·사용자 문자열 이스케이프 (여러 파일에 같은 정의)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/* squad_value.js — 스쿼드 시장가치 vs 성적 표 (2026-11-25). K리그(시즌 리뷰 > 리그 총평)·해외리그 탭 공통 렌더러.
 * 데이터: /api/squad-value?league=k1|k2|<해외 코드>. 시장가치 = Transfermarkt 추정치(기준일 표시). */
(function (root) {
    "use strict";
    const m = (v) => (v == null ? "-" : (v / 1e6 >= 100 ? Math.round(v / 1e6) : (v / 1e6).toFixed(1)));
    const sgn = (v) => (v == null ? "-" : (v > 0 ? "+" + v : String(v)));
    function html(d) {
        const rows = (d && d.teams) || [];
        if (!rows.some(r => r.value)) {
            return `<p class="sv-empty">이 리그는 시장가치가 연결된 선수가 없어 스쿼드 가치를 계산할 수 없습니다.</p>`;
        }
        const h = d.highlights || {}, cov = d.coverage || {};
        const lead = `<p class="sv-lead">`
            + (h.over ? `몸값 대비 가장 잘하는 팀 <b>${ttEsc(h.over.name)}</b> (가치 순위보다 ${h.over.diff}계단 위)` : "")
            + (h.under ? ` · 몸값만큼 못 하는 팀 <b>${ttEsc(h.under.name)}</b> (${Math.abs(h.under.diff)}계단 아래)` : "")
            + ` <span class="sv-muted">— 선수 ${cov.players || 0}명 중 시장가치 ${cov.valued || 0}명 기준</span></p>`;
        const body = rows.map(r => {
            const cls = r.diff == null || r.diff === 0 ? "" : (r.diff > 0 ? " sv-pos" : " sv-neg");
            return `<tr><td class="sv-num">${r.rank ?? "-"}</td><td>${ttEsc(r.name)}</td><td class="sv-num">${r.pts ?? "-"}</td>
                <td class="sv-num"><b>€${m(r.value)}M</b> <span class="sv-muted">${r.n_valued}/${r.n_linked}명</span></td>
                <td class="sv-num">${r.value_rank ?? "-"}</td><td class="sv-num${cls}"><b>${sgn(r.diff)}</b></td>
                <td class="sv-num">${r.value_per_pt_m != null ? "€" + r.value_per_pt_m + "M" : "-"}</td></tr>`;
        }).join("");
        return `<div class="sv-wrap">${lead}<div class="sv-scroll"><table class="sv-table">
            <caption class="sv-muted">실제 순위 순 · 차이 = 가치 순위 − 실제 순위(+ 몸값보다 잘함, 초록) · 괄호 = 시장가치 있는 선수/연결된 선수</caption>
            <thead><tr><th scope="col">순위</th><th scope="col">팀</th><th scope="col">승점</th><th scope="col">스쿼드 가치</th>
              <th scope="col" title="시장가치 합 순위">가치 순위</th><th scope="col" title="가치 순위 − 실제 순위">차이</th>
              <th scope="col" title="스쿼드 가치 ÷ 승점">승점당 가치</th></tr></thead>
            <tbody>${body}</tbody></table></div>
            <details class="sv-notes"><summary>기준</summary><ul>${((d && d.notes) || []).map(n => `<li>${ttEsc(n)}</li>`).join("")}</ul></details></div>`;
    }
    const api = { html };
    if (root) root.ttSquadValue = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
