// 대시보드 셸 — 카드·KPI 줄·테마 칩·리그 토글 HTML 빌더 (spec §4.2)
// 순수 빌더(*Html)는 문자열만 반환한다. evidenceHtml/methodHtml 은 기존 렌더러가 이스케이프를
// 마친 HTML 로 간주해 그대로 넣고, 그 밖의 모든 문자열은 esc() 를 거친다.
(function (root) {
  "use strict";

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) { return s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ESC[c]); }

  const SIZES = { F: 1, L: 1, M: 1, S: 1 };   // F=전체 폭(12), L=8, M=6, S=4 (12칼럼 그리드)
  const DIR = { up: "▲", down: "▼", flat: "–" };

  function leagueToggleHtml(leagues, active) {
    if (!Array.isArray(leagues) || leagues.length < 2) return "";
    const cur = leagues.includes(active) ? active : leagues[0];
    const btns = leagues.map((lg) => {
      const on = lg === cur;
      return `<button type="button" class="tt-lg-btn" role="tab" data-league="${esc(lg)}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(lg)}</button>`;
    }).join("");
    return `<div class="tt-lg-toggle" role="tablist" aria-label="리그 선택">${btns}</div>`;
  }

  function cardHtml(o) {
    if (!o || !Array.isArray(o.warnings)) throw new TypeError("warnings required");
    const size = SIZES[o.size] ? o.size : "M";
    const take = o.take ? `<div class="tt-card-take">${esc(o.take)}</div>` : "";
    const warns = o.warnings.map((w) => `<div class="tt-card-warn" role="note">⚠ ${esc(w)}</div>`).join("");
    const ev = (o.evidenceHtml || o.methodHtml)
      ? `<details class="tt-card-evidence"><summary>근거 보기</summary>${o.evidenceHtml || ""}${o.methodHtml || ""}</details>`
      : "";
    return `<section class="tt-card tt-card--${size}" id="${esc(o.id)}" data-theme="${esc(o.theme || "")}">`
      + `<header class="tt-card-h"><div class="tt-card-hl">`
      + `<h3 class="tt-card-title"><span class="tt-card-icon" aria-hidden="true">${esc(o.icon || "")}</span>${esc(o.title)}</h3>`
      + `<p class="tt-card-q">${esc(o.question)}</p></div>`
      + leagueToggleHtml(o.leagues, o.activeLeague)
      + `</header>${take}${warns}<div class="tt-card-lead"></div>`
      + (o.chart === false ? "" : `<div class="tt-card-chart" data-chart-slot></div>`)
      + (o.bodyHtml ? `<div class="tt-card-body" tabindex="0">${o.bodyHtml}</div>` : "")
      + `${ev}</section>`;
  }

  function kpiStripHtml(items) {
    const cells = (items || []).map((it) => {
      const dir = DIR[it.dir] ? it.dir : null;
      const d = it.delta != null && it.delta !== ""
        ? `<div class="tt-kpi-d${dir ? ` tt-kpi-d--${dir}` : ""}">${dir ? `<span aria-hidden="true">${DIR[dir]}</span> ` : ""}${esc(it.delta)}</div>`
        : "";
      const hint = it.hint ? `<div class="tt-kpi-hint">${esc(it.hint)}</div>` : "";
      return `<div class="tt-kpi"><div class="tt-kpi-l">${esc(it.label)}</div><div class="tt-kpi-v">${esc(it.value)}</div>${d}${hint}</div>`;
    }).join("");
    return `<div class="tt-kpis">${cells}</div>`;
  }

  function chipsHtml(themes, active) {
    const btns = (themes || []).map((t) => {
      const on = t.key === active;
      return `<button type="button" class="tt-chip" role="tab" data-theme-key="${esc(t.key)}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(t.label)}</button>`;
    }).join("");
    return `<div class="tt-chips" role="tablist" aria-label="테마">${btns}</div>`;
  }

  // ── DOM 바인딩 (브라우저 전용) ─────────────────────────────────────
  function bindTabs(container, btnSel, keyAttr, onChange) {
    if (!container) return;
    const btns = () => Array.from(container.querySelectorAll(btnSel));
    function select(btn, focus) {
      btns().forEach((b) => {
        const on = b === btn;
        b.setAttribute("aria-selected", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
      if (focus) btn.focus();
      onChange(btn.getAttribute(keyAttr));
    }
    container.addEventListener("click", (e) => {
      const b = e.target.closest(btnSel);
      if (b && container.contains(b)) select(b, false);
    });
    container.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const list = btns();
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
      select(n, true);
    });
  }
  function bindChips(rootEl, onChange) {
    bindTabs(rootEl && rootEl.querySelector(".tt-chips"), ".tt-chip", "data-theme-key", onChange);
  }
  function bindLeagueToggle(cardEl, onChange) {
    bindTabs(cardEl && cardEl.querySelector(".tt-lg-toggle"), ".tt-lg-btn", "data-league", onChange);
  }

  const TTDash = { esc, cardHtml, kpiStripHtml, chipsHtml, bindChips, bindLeagueToggle };
  root.TTDash = TTDash;
  if (typeof module !== "undefined" && module.exports) module.exports = TTDash;
})(typeof globalThis !== "undefined" ? globalThis : this);
