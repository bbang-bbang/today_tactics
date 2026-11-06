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
    // 평점은 좁은 범위(6~8)에서 움직여 0부터 그리면 평평해 보인다 — 선 그래프라 축을 줌인(최저 평점 -1, 하한 3)
    const lo = Math.max(3, Math.floor(Math.min(...rated.map((m) => m.rating))) - 1);
    spec.yAxis = { ...(spec.yAxis || {}), min: lo, max: 10, autoScale: false };
    spec.showMarkers = true;   // 경기 1개·평점 사이 null 이어도 점이 보이게
    if (multi) spec.__note = `${season} 시즌만 표시`;
    return spec;
  }

  // 포지션별 칸 진하기 지표 — 골키퍼 선방, 수비수 수비 행동, 그 외 공격포인트(골+도움)
  const STRIP_BY_POS = {
    G: { f: (m) => m.saves || 0, vMax: 8, what: "선방" },
    D: { f: (m) => m.def || 0, vMax: 8, what: "수비 행동(태클·인터셉트)" },   // API def = tackles + interceptions
    X: { f: (m) => (m.goals || 0) + (m.assists || 0), vMax: 3, what: "공격포인트(골+도움)" },
  };
  function strip(trend, pos) {
    const { ms } = latest(trend);
    if (!ms.length) return { __empty: true };
    const k = STRIP_BY_POS[pos] || STRIP_BY_POS.X;
    return P.timelineGrid({ vMax: k.vMax, legend: `칸 진하기 = ${k.what} · W 승 · D 무 · L 패`,
      rows: [{ label: "경기", cells: ms.map((m) => ({ v: k.f(m), mark: m.result })) }] });
  }

  const PlayerCharts = { ratingLine, strip };
  root.PlayerCharts = PlayerCharts;
  if (typeof module !== "undefined" && module.exports) module.exports = PlayerCharts;
})(typeof globalThis !== "undefined" ? globalThis : this);
