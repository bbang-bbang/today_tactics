// node --test "tests/js/*.test.js" — TeamCharts 빌더 (강원 2026 실응답 fixture)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const TTChart = require("../../static/js/tt_charts.js");
const TeamCharts = require("../../static/js/team_charts.js");

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `gangwon_${n}.json`), "utf8"));
const A = fx("2026_team-analytics"), T = fx("2026_team-trend"), I = fx("2026_team-insights"), TALL = fx("all_team-trend");
const ppg = (r) => (3 * r.w + r.d) / r.games;

test("pace_season_series", () => {
  const c = TeamCharts.pace(T, "#f55947");
  assert.equal(c.series.length, 2);
  assert.deepEqual(c.series[0].data.map((p) => p.y), T.matches.map((m) => m.season_cum_pts));
  assert.deepEqual(c.series[1].data.map((p) => p.y), T.matches.map((m) => m.league_avg_cum_pts));
  assert.equal(c.xAxis.categories[0], "R1");
});

test("pace_year_all_uses_latest_season", () => {
  const c = TeamCharts.pace(TALL, "#f55947");
  const last = Math.max(...TALL.matches.map((m) => m.season));
  assert.equal(c.series[0].data.length, TALL.matches.filter((m) => m.season === last).length);
  assert.equal(c.__note, `${last} 시즌만 표시`);
});

test("trend_without_league_avg", () => {
  const t = JSON.parse(JSON.stringify(T)); t.matches.forEach((m) => { m.league_avg_cum_pts = null; });
  assert.equal(TeamCharts.pace(t, "#f55947").series.length, 1);
});

test("strip_marks_and_shading", () => {
  const c = TeamCharts.strip(T, "강원");
  const cells = c.__model.rows[0].cells;
  assert.equal(cells.length, T.matches.length);
  assert.deepEqual(cells[0], { v: Math.abs(T.matches[0].gf - T.matches[0].ga), mark: T.matches[0].result });
  assert.equal(c.__model.vMax, 4);
});

test("month_small_sample", () => {
  const c = TeamCharts.month(A);
  const small = A.by_month.find((r) => r.games < 4);
  if (small) assert.ok(c.yAxis.categories.includes(`${small.month}월 (${small.games}경기)`));
  const all = A.by_month.reduce((s, r) => ({ w: s.w + r.w, d: s.d + r.d, games: s.games + r.games }), { w: 0, d: 0, games: 0 });
  assert.equal(c.xAxis.plotLines[0].value, Math.round(ppg(all) * 100) / 100);
});

test("homeAway_values", () => {
  const c = TeamCharts.homeAway(A);
  const h = A.by_year_ha["2026"].home, a = A.by_year_ha["2026"].away;
  assert.deepEqual(c.categories, ["경기당 승점", "경기당 득점", "경기당 실점"]);
  assert.equal(c.series[0].name, "원정"); assert.equal(c.series[1].name, "홈");
  assert.equal(c.series[1].data[0], Math.round(ppg(h) * 100) / 100);
  assert.equal(c.series[0].data[1], Math.round(a.gf / a.games * 100) / 100);
});

test("vsOpp_includes_small_samples_labelled", () => {
  // 한 시즌은 대부분 상대와 3경기 → 4경기 미만도 그리되 라벨에 경기 수 표기, 4경기↑ 먼저
  const c = TeamCharts.vsOpp(A);
  assert.equal(c.yAxis.categories.length, A.vs_opponents.length);
  const small = A.vs_opponents.find((r) => r.games < 4);
  if (small) assert.ok(c.yAxis.categories.includes(`${small.name} (${small.games}경기)`));
  const firstSmall = c.yAxis.categories.findIndex((x) => /경기\)$/.test(x));
  if (firstSmall >= 0) assert.ok(c.yAxis.categories.slice(firstSmall).every((x) => /경기\)$/.test(x)));
});

test("weather_small_sample", () => {
  const c = TeamCharts.weather(A);
  const rows = ["by_temp", "by_hum", "by_wind"].flatMap((k) => A.weather[k]);
  assert.equal(c.__model.categories.length, rows.length);
  rows.forEach((r, i) => { if (r.ci == null) assert.match(c.__model.categories[i], /\(표본 부족\)$/); });
  assert.equal(c.__zero, A.weather.overall_ppg);
});

test("timing_diverging", () => {
  const c = TeamCharts.timing(I);
  assert.deepEqual(c.series[0].data, I.goal_timing.against.map((v) => -v));
  assert.deepEqual(c.series[1].data, I.goal_timing.for);
});

test("team_builders_empty", () => {
  assert.deepEqual(TeamCharts.pace({ matches: [] }, "#fff"), { __empty: true });
  assert.deepEqual(TeamCharts.strip({ matches: [] }, "x"), { __empty: true });
  assert.deepEqual(TeamCharts.month({ by_month: [] }), { __empty: true });
  assert.deepEqual(TeamCharts.homeAway({ by_year_ha: {} }), { __empty: true });
  assert.deepEqual(TeamCharts.vsOpp({ vs_opponents: [] }), { __empty: true });
  assert.deepEqual(TeamCharts.weather({ weather: {} }), { __empty: true });
  assert.deepEqual(TeamCharts.timing({ goal_timing: {} }), { __empty: true });
});

// ── Phase 2b: 팀 비교 페이스 ──
const mk = (season, cums, avgs) => ({ short: "X", matches: cums.map((c, i) => ({ season, season_cum_pts: c, league_avg_cum_pts: avgs ? avgs[i] : null })) });

test("paceCompare_unequal_lengths", () => {
  const c = TeamCharts.paceCompare(mk(2026, [3, 4, 7], [1, 2, 3]), mk(2026, [1, 4], [1, 2]), { colorA: "#f55947", colorB: "#1d5fa5", sameLeague: true });
  assert.deepEqual(c.xAxis.categories, ["R1", "R2", "R3"]);
  assert.deepEqual(c.series[1].data, [{ y: 1 }, { y: 4 }, null]);
  assert.deepEqual(c.series[2].data.map((p) => p && p.y), [1, 2, 3]);
});

test("paceCompare_cross_league_no_ref", () => {
  const c = TeamCharts.paceCompare(mk(2026, [3], [1]), mk(2026, [1], [1]), { colorA: "#f55947", colorB: "#1d5fa5", sameLeague: false });
  assert.equal(c.series.length, 2);
  assert.match(c.__note, /리그가 달라/);
});

test("paceCompare_close_colors", () => {
  const c = TeamCharts.paceCompare(mk(2026, [3], [1]), mk(2026, [1], [1]), { colorA: "#ef3744", colorB: "#df242b", sameLeague: true });
  assert.equal(c.series[1].color, TTChart.util.lighten("#f59e0b", 3));
});

test("paceCompare_latest_season", () => {
  const a = { short: "A", matches: [...mk(2025, [3, 6]).matches, ...mk(2026, [1]).matches] };
  const c = TeamCharts.paceCompare(a, mk(2026, [3]), { colorA: "#f55947", colorB: "#1d5fa5", sameLeague: true });
  assert.deepEqual(c.series[0].data, [{ y: 1 }]);
});

test("paceCompare_empty", () => {
  assert.deepEqual(TeamCharts.paceCompare({ matches: [] }, { matches: [] }, {}), { __empty: true });
});
