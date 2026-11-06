// 팀 분석(단일 팀) 차트 빌더 — 순수 함수: API 응답 → TTChart.presets 입력 → spec (차트 개편 Phase 2a, spec §5.2)
// 새 통계를 만들지 않고 API 값의 표시 변환(합산·경기당 환산·정렬·필터)만 한다.
(function (root) {
  "use strict";
  const TT = root.TTChart || (typeof require === "function" ? require("./tt_charts.js") : null);
  const P = TT.presets, THEME = TT.THEME;
  const r2 = (v) => Math.round(v * 100) / 100;
  const ppg = (r) => (3 * r.w + r.d) / r.games;
  const MIN_GAMES = 4;     // 기존 화면과 같은 표본 기준(월·상대·날씨)

  // 시즌 누적 승점 vs 리그 평균 페이스 — 여러 시즌이면 최근 시즌만
  function pace(trend, color) {
    const all = (trend && trend.matches) || [];
    if (!all.length) return { __empty: true };
    const last = Math.max(...all.map((m) => m.season));
    const ms = all.filter((m) => m.season === last);
    const spec = P.paceLine({
      labels: ms.map((_, i) => "R" + (i + 1)),
      team: { name: trend.short || "팀", color, data: ms.map((m) => m.season_cum_pts) },
      ref: { name: "리그 평균", data: ms.map((m) => m.league_avg_cum_pts) },
    });
    if (ms.length !== all.length) spec.__note = `${last} 시즌만 표시`;
    return spec;
  }

  // 경기별 결과 띠 — 진하기 = 점수차, 글자 = W/D/L (최근 시즌)
  function strip(trend, label) {
    const all = (trend && trend.matches) || [];
    if (!all.length) return { __empty: true };
    const last = Math.max(...all.map((m) => m.season));
    const ms = all.filter((m) => m.season === last);
    return P.timelineGrid({ vMax: 4, legend: "칸 진하기 = 점수차 · W 승 · D 무 · L 패",
      rows: [{ label: label || "결과", cells: ms.map((m) => ({ v: Math.abs(m.gf - m.ga), mark: m.result })) }] });
  }

  function month(a) {
    const rows = ((a && a.by_month) || []).filter((r) => r.games > 0);
    if (!rows.length) return { __empty: true };
    const tot = rows.reduce((s, r) => ({ w: s.w + r.w, d: s.d + r.d, games: s.games + r.games }), { w: 0, d: 0, games: 0 });
    return P.barRef({
      categories: rows.map((r) => (r.games < MIN_GAMES ? `${r.month}월 (${r.games}경기)` : `${r.month}월`)),
      values: rows.map((r) => r2(ppg(r))), name: "경기당 승점", ref: r2(ppg(tot)), refLabel: "시즌 평균", unit: "",
    });
  }

  function homeAway(a) {
    const agg = { home: { games: 0, w: 0, d: 0, gf: 0, ga: 0 }, away: { games: 0, w: 0, d: 0, gf: 0, ga: 0 } };
    Object.values((a && a.by_year_ha) || {}).forEach((yr) => ["home", "away"].forEach((side) => {
      if (yr[side]) ["games", "w", "d", "gf", "ga"].forEach((k) => { agg[side][k] += yr[side][k] || 0; });
    }));
    if (!agg.home.games || !agg.away.games) return { __empty: true };
    const vals = (s) => [r2(ppg(s)), r2(s.gf / s.games), r2(s.ga / s.games)];
    return P.dumbbell({ categories: ["경기당 승점", "경기당 득점", "경기당 실점"],
      a: { name: "원정", color: THEME.sub, data: vals(agg.away) },
      b: { name: "홈", color: THEME.accent, data: vals(agg.home) } });
  }

  function vsOpp(a) {
    const rows = ((a && a.vs_opponents) || []);
    // 한 시즌은 대부분 상대와 3경기 → 4경기 미만도 그리되 라벨에 경기 수, 4경기↑ 먼저(각 그룹 안 PPG 내림차순)
    const ok = rows.filter((r) => r.games > 0).map((r) => ({
      name: r.games < MIN_GAMES ? `${r.name} (${r.games}경기)` : r.name, v: r2(ppg(r)), big: r.games >= MIN_GAMES }))
      .sort((x, y) => (y.big - x.big) || (y.v - x.v));
    if (!ok.length) return { __empty: true };
    const tot = rows.reduce((s, r) => ({ w: s.w + r.w, d: s.d + r.d, games: s.games + r.games }), { w: 0, d: 0, games: 0 });
    return P.barRef({ categories: ok.map((r) => r.name), values: ok.map((r) => r.v), name: "상대별 경기당 승점",
      ref: tot.games ? r2(ppg(tot)) : null, refLabel: "팀 평균", unit: "" });
  }

  function weather(a) {
    const W = (a && a.weather) || {};
    const PFX = { by_temp: "기온", by_hum: "습도", by_wind: "풍속" };
    const rows = ["by_temp", "by_hum", "by_wind"].flatMap((k) => (W[k] || []).map((r) => ({
      label: `${PFX[k]} · ${r.label}`, est: r.ppg, n: r.games, insufficient: r.ci == null,
      lo: r.ci == null ? null : r.ppg - r.ci, hi: r.ci == null ? null : r.ppg + r.ci })));
    if (!rows.length) return { __empty: true };
    return P.forest({ rows, zero: W.overall_ppg || 0, zeroLabel: "팀 평균", unit: "PPG" });
  }

  function timing(ins) {
    const g = (ins && ins.goal_timing) || {};
    if (!(g.for || []).length) return { __empty: true };
    return P.diverging({ categories: ["0-15", "16-30", "31-45", "46-60", "61-75", "76+"],
      left: { name: "실점", color: THEME.neg, data: g.against }, right: { name: "득점", color: THEME.pos, data: g.for } });
  }

  // 팀 비교: 두 팀 시즌 누적 승점 (+ 같은 리그면 리그 평균 페이스). 각 팀 최근 시즌, 짧은 쪽은 null 패딩.
  const hue = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(String(hex).replace("#", "").slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const hueDiff = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };
  const ALT_B = ["#f59e0b", "#22d3ee"];   // 대체색 후보(주황·청록) — A 와 더 다른 쪽을 고른다
  function paceCompare(trA, trB, o) {
    o = o || {};
    const latest = (tr) => {
      const ms = (tr && tr.matches) || [];
      if (!ms.length) return { ms: [], season: null };
      const s = Math.max(...ms.map((m) => m.season));
      return { ms: ms.filter((m) => m.season === s), season: s, all: ms.length };
    };
    const A = latest(trA), B = latest(trB);
    const n = Math.max(A.ms.length, B.ms.length);
    if (!n) return { __empty: true };
    const pad = (ms, f) => Array.from({ length: n }, (_, i) => (i < ms.length ? f(ms[i]) : null));
    const longer = A.ms.length >= B.ms.length ? A.ms : B.ms;
    // 실제로 그려지는 색(배경 대비 보정 후)의 '색상(hue)' 차이로 비교 — 60° 미만이면 A 와 가장 먼 대체색으로.
    // (밝기 대비는 주황·청록처럼 다른 색도 비슷하다고 판정해 부적합 — 리뷰 I1). B 는 점선이라 색만으로 구분하지 않는다.
    const drawn = (c) => TT.util.lighten(c, 3);
    const colorA = o.colorA || "#4a82c7";
    let colorB = o.colorB || ALT_B[0];
    if (hueDiff(drawn(colorA), drawn(colorB)) < 60) {
      colorB = ALT_B.slice().sort((x, y) => hueDiff(drawn(colorA), drawn(y)) - hueDiff(drawn(colorA), drawn(x)))[0];
    }
    const spec = P.paceLine({
      labels: Array.from({ length: n }, (_, i) => "R" + (i + 1)),
      team: { name: (trA && trA.short) || "A", color: colorA, data: pad(A.ms, (m) => m.season_cum_pts) },
      extra: [{ name: (trB && trB.short) || "B", color: colorB, dashArray: "6,3", data: pad(B.ms, (m) => m.season_cum_pts) }],
      // 리그 평균은 같은 리그·같은 시즌일 때만 의미가 있다(시즌이 다르면 어느 시즌 평균인지 모호)
      ref: o.sameLeague && A.season === B.season ? { name: "리그 평균", data: pad(longer, (m) => m.league_avg_cum_pts) } : null,
    });
    const notes = [];
    const nameA = (trA && trA.short) || "A", nameB = (trB && trB.short) || "B";
    if (!A.ms.length) notes.push(`${nameA} 데이터 없음`);
    else if (!B.ms.length) notes.push(`${nameB} 데이터 없음`);
    else if (A.season !== B.season) notes.push(`시즌이 다름 (${A.season} vs ${B.season}) — 리그 평균선 생략`);
    if (!o.sameLeague) notes.push("두 팀 리그가 달라 리그 평균선은 생략");
    if (A.ms.length && B.ms.length && A.season === B.season && (A.all > A.ms.length || (B.all || 0) > B.ms.length)) notes.push(`${A.season} 시즌만 표시`);
    if (notes.length) spec.__note = notes.join(" · ");
    return spec;
  }

  const TeamCharts = { pace, strip, month, homeAway, vsOpp, weather, timing, paceCompare };
  root.TeamCharts = TeamCharts;
  if (typeof module !== "undefined" && module.exports) module.exports = TeamCharts;
})(typeof globalThis !== "undefined" ? globalThis : this);
