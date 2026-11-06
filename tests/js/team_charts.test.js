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

test("vsOpp_min_games", () => {
  const c = TeamCharts.vsOpp(A);
  const ok = A.vs_opponents.filter((r) => r.games >= 4);
  assert.equal(c.yAxis.categories.length, ok.length);
  for (let i = 1; i < c.series[0].data.length; i++) assert.ok(c.series[0].data[i - 1] >= c.series[0].data[i]);
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
