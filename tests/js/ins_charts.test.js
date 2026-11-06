// node --test "tests/js/*.test.js" — InsCharts 빌더 (K1 2026 실응답 fixture)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const TTChart = require("../../static/js/tt_charts.js");
const InsCharts = require("../../static/js/ins_charts.js");

const fx = (ep) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `k1_2026_${ep}.json`), "utf8"));
const noColor = () => undefined;
const BODY_IDS = ["ins-story-body", "ins-xgluck-body", "ins-opp-body", "ins-fm-body", "ins-trend-body", "ins-wx-body",
  "ins-pv-body", "ins-rest-body", "ins-subimp-body", "ins-sub-body", "ins-spp-body", "ins-weak-body", "ins-sdep-body",
  "ins-rot-body", "ins-gs-body", "ins-aft-body", "ins-hub-body", "ins-clutch-body", "ins-shooting-body", "ins-gk-body", "ins-duel-body"];

test("cards_cover_all_bodies", () => {
  assert.equal(InsCharts.CARDS.length, 21);
  assert.deepEqual(new Set(InsCharts.CARDS.map((c) => c.bodyId)), new Set(BODY_IDS));
  const charted = InsCharts.CARDS.filter((c) => c.chart).map((c) => c.key).sort();
  assert.deepEqual(charted, ["formation", "gs", "opp", "pv", "rest", "spp", "subimp", "trend", "xgluck"]);
  for (const c of InsCharts.CARDS.filter((c) => c.chart)) assert.equal(typeof InsCharts[c.key], "function", c.key);
});

test("trend_highlights_top3_bottom2", () => {
  const d = fx("standings-trend");
  const c = InsCharts.trend(d, noColor);
  const final = d.teams.slice().sort((a, b) => a.rank - b.rank);
  const lit = c.series.filter((s) => s.lineWidth === 3).map((s) => s.name);
  assert.equal(lit.length, 5);
  assert.ok(lit.includes(final[0].short));
  assert.ok(lit.includes(final[final.length - 1].short));
});

test("xgluck_only_eligible", () => {
  const d = fx("xg-luck");
  assert.equal(InsCharts.xgluck(d).series.length, d.teams.filter((t) => t.eligible).length);
});

test("opp_rows_sorted_by_rank", () => {
  const d = fx("opponent-strength");
  const c = InsCharts.opp(d);
  const first = d.teams.filter((t) => t.eligible).sort((a, b) => a.rank_actual - b.rank_actual)[0];
  assert.equal(c.yAxis.categories[0], first.short);
});

test("formation_null_below_min_cell", () => {
  const d = fx("formation-matchup");
  const c = InsCharts.formation(d);
  const rows = c.yAxis.categories, cols = c.xAxis.categories;
  for (const cell of c.data) {
    const m = d.matchups.find((x) => x.formation === rows[cell.y] && x.opp === cols[cell.x]);
    if (!m || m.n < d.min_cell) assert.equal(cell.value, null, `${rows[cell.y]} vs ${cols[cell.x]}`);
    else assert.equal(cell.value, m.ppg);
  }
  assert.ok(rows.length <= 6);
});

test("gs_sorted_and_filtered", () => {
  const c = InsCharts.gs(fx("game-state"));
  const b = c.series[1].data;
  for (let i = 1; i < b.length; i++) assert.ok(b[i - 1] >= b[i], `index ${i}`);
});

test("pv_decimals_1", () => {
  const c = InsCharts.pv(fx("pass-volume"));
  for (const s of c.series) for (const v of s.data) assert.equal(v, Math.round(v * 10) / 10);
});

test("subimp_insufficient_last", () => {
  const d = fx("substitution-impact");
  const c = InsCharts.subimp(d);
  const cats = c.__model.categories;
  const nIns = d.teams.filter((t) => t.z == null).length;
  if (nIns) assert.match(cats[cats.length - 1], /\(표본 부족\)$/);
  const ests = c.__model.points.filter(Boolean).map((p) => p.y);
  for (let i = 1; i < ests.length; i++) assert.ok(ests[i - 1] >= ests[i]);
});

test("rest_reference_weighted_mean", () => {
  const d = fx("rest-effect");
  const n = d.buckets.reduce((s, b) => s + b.n, 0);
  const exp = Math.round(d.buckets.reduce((s, b) => s + b.ppg * b.n, 0) / n * 100) / 100;
  const c = InsCharts.rest(d);
  assert.equal(c.__zero, exp);
  assert.equal(c.__zeroLabel, "전체 평균");
  assert.equal(c.__model.categories.length, d.buckets.length + d.congestion.length);
});

test("spp_uses_metric_key", () => {
  const d = fx("setpiece-profile");
  const c = InsCharts.spp(d, noColor);
  const k = d.xg_ok ? "xg_pg" : "shots_pg";
  const t = d.teams.find((x) => x.eligible);
  const s = c.series.find((x) => x.name === t.short);
  assert.equal(s.data[0].x, t.for[k]);
  assert.equal(s.data[0].y, t.against[k]);
});

test("builders_empty", () => {
  assert.deepEqual(InsCharts.trend({ rounds: [1], teams: [] }, noColor), { __empty: true });
  assert.deepEqual(InsCharts.xgluck({ teams: [] }), { __empty: true });
  assert.deepEqual(InsCharts.opp({ teams: [], league_ppg: 1.3, tier_min: 3 }), { __empty: true });
  assert.deepEqual(InsCharts.formation({ formations: [], matchups: [], min_cell: 8 }), { __empty: true });
  assert.deepEqual(InsCharts.gs({ teams: [], min_games: 8 }), { __empty: true });
  assert.deepEqual(InsCharts.pv({ teams: [] }), { __empty: true });
  assert.deepEqual(InsCharts.subimp({ teams: [] }), { __empty: true });
  assert.deepEqual(InsCharts.rest({ buckets: [], congestion: [] }), { __empty: true });
  assert.deepEqual(InsCharts.spp({ teams: [], xg_ok: false, metric: "슈팅" }, noColor), { __empty: true });
});

test("labels_are_plain_strings", () => {
  const evil = "<b>x</b>";
  const c = InsCharts.xgluck({ teams: [{ eligible: true, id: 1, short: evil, xppg: 1, ppg: 1, primary: "#ef3744" }] });
  assert.equal(c.series[0].name, evil);
  assert.equal(c.series[0].data[0].label, evil);
  assert.ok(!JSON.stringify(c).includes("__html"));
});
