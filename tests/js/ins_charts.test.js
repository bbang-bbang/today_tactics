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
  "ins-rot-body", "ins-gs-body", "ins-aft-body", "ins-hub-body", "ins-clutch-body", "ins-shooting-body", "ins-gk-body", "ins-duel-body",
  "ins-sim-body"];

test("cards_cover_all_bodies", () => {
  assert.equal(InsCharts.CARDS.length, 22);
  assert.deepEqual(new Set(InsCharts.CARDS.map((c) => c.bodyId)), new Set(BODY_IDS));
  const charted = InsCharts.CARDS.filter((c) => c.chart).map((c) => c.key).sort();
  assert.deepEqual(charted, ["aft", "formation", "gs", "hub", "opp", "pv", "rest", "rot", "sdep", "sim", "spp", "subimp", "trend", "weak", "weather", "xgluck"]);
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


test("cards_order_packs_rows_without_dense", () => {
  // grid-auto-flow:dense 없이도 빈칸이 적도록 테마 안에서 L+S / M+M 짝으로 배치 (DOM 순서 = 화면 순서)
  assert.deepEqual(InsCharts.CARDS.map((c) => c.key), [
    "trend", "story", "xgluck", "opp", "sim", "weather",
    "formation", "hub", "gs", "pv", "aft",
    "subimp", "rest", "rot", "sdep", "sub", "clutch",
    "spp", "weak", "shooting", "gk", "duel"]);
  // 테마가 바뀌면 섹션 제목(12칸) 때문에 새 행에서 시작한다 → 테마 안에서 행이 정확히 12칸으로 닫혀야 한다
  const W = { F: 12, L: 8, M: 6, S: 4 };
  let row = 0, gaps = 0, prev = null;
  for (const c of InsCharts.CARDS) {
    if (c.theme !== prev) { gaps += row ? 12 - row : 0; row = 0; prev = c.theme; }
    if (row + W[c.size] > 12) { gaps += 12 - row; row = 0; }
    row += W[c.size];
  }
  gaps += row ? 12 - row : 0;
  assert.equal(gaps, 0, `빈 칸 ${gaps}칸 — 테마별로 행이 12칸으로 닫혀야 함`);
});

// ── Phase 1b: 카드 6장 ──
test("weather_rows_from_groups", () => {
  const d = fx("weather-effect");
  const c = InsCharts.weather(d);
  const n = ["temp", "precip", "wind"].reduce((s, k) => s + d.groups[k].length, 0);
  assert.equal(c.__model.categories.length, n);
  const r = ["temp", "precip", "wind"].flatMap((k) => d.groups[k]).find((x) => x.goals_resid != null && x.goals_ci != null);
  const i = c.__model.categories.findIndex((cat) => cat.endsWith(r.label));
  assert.deepEqual(c.__model.ranges[i], { low: r.goals_resid - r.goals_ci, high: r.goals_resid + r.goals_ci });
  assert.equal(c.__zero, 0);
});

test("weak_default_team_has_weak_zone", () => {
  const d = fx("defensive-weakness");
  const c = InsCharts.weak(d);
  const want = d.teams.find((t) => t.eligible && (t.weak || []).length) || d.teams.find((t) => t.eligible);
  assert.equal(c.__title, `${want.short} — 허용 슈팅 지역 비중`);
  assert.equal(c.__renderer, "pitchZones");
});

test("weak_unavailable_zone_hatched", () => {
  const d = fx("defensive-weakness");
  const t = JSON.parse(JSON.stringify(d.teams.find((x) => x.eligible)));
  t.zones.out_wide = null; t.weak = ["x"];
  const c = InsCharts.weak({ ...d, teams: [t] });
  assert.ok(c.__zones.filter((z) => z.key === "out_wide").every((z) => z.hatch));
});

test("sdep_parts_sum_100", () => {
  const c = InsCharts.sdep(fx("scoring-dependence"));
  for (let i = 0; i < c.yAxis.categories.length; i++) {
    const sum = c.series.reduce((s, p) => s + p.data[i], 0);
    assert.ok(Math.abs(sum - 100) <= 0.1, `${c.yAxis.categories[i]} ${sum}`);
  }
});

test("rot_marks", () => {
  const d = fx("rotation");
  const c = InsCharts.rot(d);
  const t = d.teams.find((x) => x.eligible);
  const row = c.__model.rows.find((r) => r.label === t.short);
  assert.deepEqual(row.cells.map((x) => x.mark), t.timeline.map((x) => (x.pts === 3 ? "W" : x.pts === 1 ? "D" : "L")));
  assert.equal(c.__model.vMax, 11);
});

test("aft_flow_links_sum", () => {
  const d = fx("goal-aftermath");
  const c = InsCharts.aft(d);
  assert.equal(c.links.reduce((s, l) => s + l.value, 0), d.league_total.scored);
});

test("hub_ref_is_league", () => {
  const d = fx("pass-hub");
  const c = InsCharts.hub(d);
  assert.equal(c.xAxis.plotLines[0].value, d.league_hub_share);
});

test("cards_chart_count_15", () => {
  assert.equal(InsCharts.CARDS.filter((c) => c.chart).length, 16);
  assert.equal(InsCharts.CARDS.filter((c) => c.collapse).length, 0);
});

test("phase1b_builders_empty", () => {
  assert.deepEqual(InsCharts.weather({ groups: {} }), { __empty: true });
  assert.deepEqual(InsCharts.weak({ teams: [], zones_geom: [], zones: [] }), { __empty: true });
  assert.deepEqual(InsCharts.sdep({ teams: [] }), { __empty: true });
  assert.deepEqual(InsCharts.rot({ teams: [] }), { __empty: true });
  assert.deepEqual(InsCharts.aft({ league_total: { scored: 0, flow: { extra_only: 0, conc_only: 0, both: 0, none: 0 } } }), { __empty: true });
  assert.deepEqual(InsCharts.hub({ teams: [] }), { __empty: true });
});


// ── Phase 4: 시즌 시뮬레이션 ──
test("sim_percent_matrix", () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "k1_season-simulation.json"), "utf8"));
  const c = InsCharts.sim(d);
  assert.equal(c.yAxis.categories.length, d.teams.length);
  assert.equal(c.xAxis.categories.length, d.n_teams);
  assert.equal(c.xAxis.categories[0], "1위");
  const t0 = d.teams[0], cell = c.data.find((x) => x.x === 0 && x.y === 0);
  assert.equal(cell.value, Math.round(t0.position_dist[0] / d.n_simulations * 100));
});

test("sim_zero_cells_null", () => {
  const c = InsCharts.sim({ ready: true, n_teams: 2, n_simulations: 10, teams: [{ name: "a", position_dist: [10, 0] }, { name: "b", position_dist: [0, 10] }] });
  assert.equal(c.data.find((x) => x.x === 1 && x.y === 0).value, null);
  assert.equal(c.data.find((x) => x.x === 0 && x.y === 0).value, 100);
});

test("sim_not_ready_empty", () => {
  assert.deepEqual(InsCharts.sim({ ready: false, teams: [] }), { __empty: true });
});
