// 선수 분석 모달 차트 빌더 — 순수 함수 (차트 개편 Phase 3, spec §5.4)
// 경기별 평점 선 + 시즌 평균선, 그 아래 경기 띠(진하기 = 공격포인트, 글자 = W/D/L). 최근 시즌만.
(function (root) {
  "use strict";
  const TT = root.TTChart || (typeof require === "function" ? require("./tt_charts.js") : null);
  const P = TT.presets, THEME = TT.THEME;
  const r2 = (v) => Math.round(v * 100) / 100;

  function latest(trend) {
    const ms = trend || [];
    if (!ms.length) return { ms: [], season: null, multi: false };
    const s = Math.max(...ms.map((m) => m.year));
    const cur = ms.filter((m) => m.year === s);
    return { ms: cur, season: s, multi: cur.length !== ms.length };
  }

  function ratingLine(trend) {
    const { ms, season, multi } = latest(trend);
    const rated = ms.filter((m) => m.rating != null);
    if (!rated.length) return { __empty: true };
    const avg = r2(rated.reduce((s, m) => s + m.rating, 0) / rated.length);
    const spec = P.paceLine({
      labels: ms.map((m) => m.date),
      team: { name: "평점", color: THEME.accent, data: ms.map((m) => m.rating) },
      ref: { name: "시즌 평균", data: ms.map(() => avg) },
    });
    if (multi) spec.__note = `${season} 시즌만 표시`;
    return spec;
  }

  function strip(trend) {
    const { ms } = latest(trend);
    if (!ms.length) return { __empty: true };
    return P.timelineGrid({ vMax: 3, legend: "칸 진하기 = 공격포인트(골+도움) · W 승 · D 무 · L 패",
      rows: [{ label: "경기", cells: ms.map((m) => ({ v: (m.goals || 0) + (m.assists || 0), mark: m.result })) }] });
  }

  const PlayerCharts = { ratingLine, strip };
  root.PlayerCharts = PlayerCharts;
  if (typeof module !== "undefined" && module.exports) module.exports = PlayerCharts;
})(typeof globalThis !== "undefined" ? globalThis : this);
