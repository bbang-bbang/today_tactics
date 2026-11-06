// node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const TTChart = require("../../static/js/tt_charts.js");
const { THEME, util } = TTChart;

// ── Task 3: 테마·유틸 ─────────────────────────────────────────────────
test("contrast_known_pairs", () => {
  assert.ok(Math.abs(util.contrast("#ffffff", "#000000") - 21) < 0.01);
  assert.equal(util.contrast("#0b1220", "#0b1220"), 1);
});

test("ensureVisible_dark_team_gets_stroke", () => {
  assert.equal(util.ensureVisible("#0a4436").stroke, THEME.text); // 전북
  assert.ok(util.ensureVisible("#8e272b").stroke);               // 부천
});

test("ensureVisible_bright_team_no_stroke", () => {
  assert.equal(util.ensureVisible("#ef3744").stroke, null); // 서울
  assert.equal(util.ensureVisible("#01a0fc").stroke, null); // 인천
});

test("withTheme_keeps_explicit_values", () => {
  const out = TTChart.withTheme({ type: "line", title: "x", legend: { position: "top" } });
  assert.equal(out.legend.position, "top");
  assert.equal(out.legend.labelStyle.color, THEME.sub);
  assert.equal(out.background.color, "rgba(0,0,0,0)");
  assert.equal(out.title, undefined);
});

test("withTheme_font_floor", () => {
  const out = TTChart.withTheme({ type: "line", xAxis: { labels: { style: { fontSize: 9 } } } });
  assert.equal(out.xAxis.labels.style.fontSize, 12);
});

test("withTheme_pure", () => {
  const input = { type: "line", xAxis: { labels: { style: { fontSize: 9 } } } };
  const snap = structuredClone(input);
  TTChart.withTheme(input);
  assert.deepEqual(input, snap);
});

// ── Task 4: 프리셋 ────────────────────────────────────────────────────
const P = TTChart.presets;
const seoul = { id: 7646, short: "서울", color: "#ef3744", ranks: [3, 1, 1] };
const ulsan = { id: 1, short: "울산", color: "#1d5fa5", ranks: [1, 2, 2] };

test("bump_transforms_rank", () => {
  const c = P.bump({ rounds: [1, 2, 3], teams: [seoul], nTeams: 12 });
  assert.equal(c.type, "line");
  assert.deepEqual(c.series[0].data, [{ y: 10 }, { y: 12 }, { y: 12 }]);
  assert.deepEqual(c.xAxis.categories, ["R1", "R2", "R3"]);
});

test("bump_null_round", () => {
  const c = P.bump({ rounds: [1, 2, 3], teams: [{ ...seoul, ranks: [2, null, 4] }], nTeams: 12 });
  assert.deepEqual(c.series[0].data, [{ y: 11 }, null, { y: 9 }]);
});

test("bump_highlight_dims_others", () => {
  const c = P.bump({ rounds: [1, 2, 3], teams: [seoul, ulsan], nTeams: 12, highlight: [7646] });
  const s = c.series.find((x) => x.name === "서울"), u = c.series.find((x) => x.name === "울산");
  assert.equal(s.color, "#ef3744"); assert.equal(s.lineWidth, 3);
  assert.equal(u.color, THEME.neutral);
});

test("bump_empty", () => {
  assert.deepEqual(P.bump({ rounds: [1], teams: [], nTeams: 12 }), { __empty: true });
});

test("forest_model_basic", () => {
  const m = P._forestModel([
    { label: "3일 이하", est: 1.24, lo: 0.98, hi: 1.50, n: 82 },
    { label: "4~6일", est: 1.52, lo: 1.31, hi: 1.73, n: 147 },
  ], 0);
  assert.deepEqual(m.categories, ["3일 이하", "4~6일"]);
  assert.deepEqual(m.ranges, [{ low: 0.98, high: 1.5 }, { low: 1.31, high: 1.73 }]);
});

test("forest_model_insufficient", () => {
  const m = P._forestModel([{ label: "7일 이상", est: 1, lo: 0, hi: 2, n: 5, insufficient: true }], 0);
  assert.equal(m.categories[0], "7일 이상 (표본 부족)");
  assert.equal(m.ranges[0], null); assert.equal(m.points[0], null);
});

test("forest_significant_colors", () => {
  const m = P._forestModel([
    { label: "a", est: 0.31, lo: 0.1, hi: 0.5, n: 30, significant: true },
    { label: "b", est: -0.2, lo: -0.4, hi: -0.05, n: 30, significant: true },
    { label: "c", est: 0.1, lo: -0.1, hi: 0.3, n: 30 },
  ], 0);
  assert.deepEqual(m.points.map((p) => p.color), [THEME.pos, THEME.neg, THEME.text]);
});

test("forest_uses_canvas_renderer", () => {
  // TERA 로는 기준선·소수 눈금이 안 그려져(스파이크) 어댑터 자체 Canvas 렌더러로 그린다
  const c = P.forest({ rows: [{ label: "3일 이하", est: 1.24, lo: 0.98, hi: 1.5, n: 82 }], zero: 1.33 });
  assert.equal(c.__renderer, "forest");
  assert.equal(c.__zero, 1.33);
  assert.deepEqual(c.__model.ranges, [{ low: 0.98, high: 1.5 }]);
});

test("bump_monotone_rank_labels", () => {
  const c = P.bump({ rounds: [1, 2], teams: [seoul], nTeams: 12 });
  assert.equal(c.curveType, "monotone");
  assert.equal(c.yAxis.labels.formatter(12), "1위");
  assert.equal(c.yAxis.labels.formatter(1), "12위");
  assert.equal(c.yAxis.labels.formatter(2.5), "");
});

test("forest_empty", () => {
  assert.deepEqual(P.forest({ rows: [{ label: "a", est: 1, lo: 0, hi: 2, n: 3, insufficient: true }] }), { __empty: true });
});

test("dumbbell_shape", () => {
  const c = P.dumbbell({ categories: ["서울", "광주"], a: { name: "뒤질 때", color: "#f87171", data: [0.38, 0.2] },
    b: { name: "앞설 때", color: "#34d399", data: [2.62, 1.1] } });
  assert.equal(c.type, "dumbbell"); assert.equal(c.orientation, "horizontal");
  assert.deepEqual(c.series.map((s) => s.name), ["뒤질 때", "앞설 때"]);
});

test("dumbbell_length_mismatch", () => {
  assert.throws(() => P.dumbbell({ categories: ["a", "b"], a: { name: "x", data: [1] }, b: { name: "y", data: [1, 2] } }), RangeError);
});

test("quadrant_diagonal_range", () => {
  const c = P.quadrant({ points: [{ id: 1, label: "서울", x: 1.55, y: 1.89, color: "#ef3744" },
    { id: 2, label: "광주", x: 0.79, y: 0.78, color: "#f3ad02" }], xTitle: "x", yTitle: "y", diagonal: true });
  assert.deepEqual(c.__diagonal, [{ x: 0.78, y: 0.78 }, { x: 1.89, y: 1.89 }]);
});

test("quadrant_dark_color_lightened", () => {
  // TERA 가 마커 외곽선을 무시하므로(스파이크) 어두운 팀 색은 배경 대비 3:1 이 되도록 밝혀서 칠한다
  const c = P.quadrant({ points: [{ id: 1, label: "전북", x: 1, y: 1, color: "#0a4436" }], xTitle: "x", yTitle: "y" });
  assert.ok(util.contrast(c.series[0].color, THEME.bg) >= 3, c.series[0].color);
});

test("quadrant_series_per_point_with_label", () => {
  const c = P.quadrant({ points: [{ id: 1, label: "서울", x: 1.55, y: 1.89, color: "#ef3744" },
    { id: 2, label: "광주", x: 0.79, y: 0.78, color: "#f3ad02" }], xTitle: "x", yTitle: "y" });
  assert.equal(c.series.length, 2);
  assert.equal(c.series[0].color, "#ef3744");
  assert.deepEqual(c.series[1].data, [{ x: 0.79, y: 0.78, label: "광주" }]);
  assert.equal(c.pointLabels.enabled, true);
});

test("quadrant_diagonal_annotation_ratio", () => {
  const c = P.quadrant({ points: [{ id: 1, label: "a", x: 1.0, y: 1.0, color: "#ef3744" },
    { id: 2, label: "b", x: 2.0, y: 2.0, color: "#ef3744" }], xTitle: "x", yTitle: "y", diagonal: true });
  // 축 범위가 x·y 공통이면 y=x 는 좌하(0,1)→우상(1,0) 비율 좌표
  const line = c.annotations.find((a) => a.type === "line");
  assert.deepEqual([line.x, line.y, line.x2, line.y2], [0, 1, 1, 0]);
  assert.equal(c.xAxis.min, c.yAxis.min); assert.equal(c.xAxis.max, c.yAxis.max);
});

test("util_lighten_reaches_contrast", () => {
  const out = util.lighten("#0a4436", 3);
  assert.ok(util.contrast(out, THEME.bg) >= 3, out);
  assert.equal(util.lighten("#ef3744", 3), "#ef3744");
});

test("heatMatrix_cells", () => {
  const c = P.heatMatrix({ rows: ["서울", "광주"], cols: ["상위권", "중위권", "하위권"], values: [[2.17, 1.92, 1.8], [null, 1.1, 0.5]] });
  assert.equal(c.type, "heatmap");
  const data = c.data; // TERA heatmap 은 최상위 data 를 읽는다(스파이크)
  assert.equal(data.length, 6);
  assert.ok(data.some((d) => d.x === 0 && d.y === 1 && d.value === null));
});

test("heatMatrix_diverging_symmetric", () => {
  const c = P.heatMatrix({ rows: ["a", "b"], cols: ["x", "y"], values: [[2.17, 1.0], [0.5, 1.33]], center: 1.33 });
  assert.equal(c.__scale.min, 0.49); assert.equal(c.__scale.max, 2.17);
});

// ── Final review fixes ───────────────────────────────────────────────
test("withTheme_tooltip_text_readable", () => {
  // TERA 툴팁은 tooltip.style / headerStyle / rowStyle 의 color 를 읽는다(기본 #333 → 다크 배경에서 안 보임)
  const t = TTChart.withTheme({ type: "line" }).tooltip;
  assert.equal(t.style.color, THEME.text);
  assert.equal(t.headerStyle.color, THEME.text);
  assert.equal(t.rowStyle.color, THEME.text);
});

test("bump_dark_color_lightened", () => {
  const c = P.bump({ rounds: [1], teams: [{ id: 5, short: "전북", color: "#0a4436", ranks: [4] }], nTeams: 12 });
  assert.ok(util.contrast(c.series[0].color, THEME.bg) >= 3, c.series[0].color);
});

test("dumbbell_dark_color_lightened", () => {
  const c = P.dumbbell({ categories: ["a"], a: { name: "x", color: "#0a4436", data: [1] }, b: { name: "y", color: "#8e272b", data: [2] } });
  for (const s of c.series) assert.ok(util.contrast(s.color, THEME.bg) >= 3, s.color);
});

// ── Phase 1a: 행 수 메타 ──
test("dumbbell_rows_meta", () => {
  const cats = Array.from({ length: 12 }, (_, i) => "t" + i);
  const c = P.dumbbell({ categories: cats, a: { name: "a", data: cats.map(() => 1) }, b: { name: "b", data: cats.map(() => 2) } });
  assert.equal(c.__rows, 12);
});

test("heatMatrix_rows_meta", () => {
  const c = P.heatMatrix({ rows: ["a", "b", "c"], cols: ["x"], values: [[1], [2], [3]] });
  assert.equal(c.__rows, 3);
});

test("forest_rows_meta", () => {
  const c = P.forest({ rows: [{ label: "a", est: 1, lo: 0, hi: 2, n: 30 }, { label: "b", est: 1, lo: 0, hi: 2, n: 30 }] });
  assert.equal(c.__rows, 2);
});

// ── Phase 1b: stacked100 · barRef · sankey ──
test("stacked100_shape", () => {
  const c = P.stacked100({ categories: ["광주", "인천", "울산"], parts: [
    { name: "1위", color: "#e8435a", data: [36.7, 30, 25] }, { name: "나머지", color: "#475569", data: [63.3, 70, 75] }] });
  assert.equal(c.type, "row-bar"); assert.equal(c.stacking, "percent");
  assert.equal(c.series.length, 2); assert.equal(c.series[0].data.length, 3);
  assert.deepEqual(c.yAxis.categories, ["광주", "인천", "울산"]);
  assert.equal(c.__rows, 3);
});

test("stacked100_empty", () => {
  assert.deepEqual(P.stacked100({ categories: [], parts: [] }), { __empty: true });
});

test("barRef_reference_line_from_zero", () => {
  const c = P.barRef({ categories: ["인천", "대전"], values: [15.8, 13.1], ref: 14.8, refLabel: "리그 평균", unit: "%" });
  assert.equal(c.type, "row-bar");
  assert.equal(c.xAxis.min, 0);   // 잘린 축 금지(차이 과장 방지)
  assert.equal(c.xAxis.plotLines[0].value, 14.8);
  assert.match(c.xAxis.plotLines[0].label, /리그 평균 14\.8%/);
  assert.deepEqual(c.series[0].data, [15.8, 13.1]);
  assert.equal(c.__rows, 2);
});

test("barRef_empty", () => {
  assert.deepEqual(P.barRef({ categories: [], values: [] }), { __empty: true });
});

test("sankey_links", () => {
  const c = P.sankey({ nodes: ["득점", "추가골만", "실점만", "변화 없음"], links: [
    { source: "득점", target: "추가골만", value: 40 }, { source: "득점", target: "실점만", value: 48 },
    { source: "득점", target: "변화 없음", value: 410 }] });
  assert.equal(c.type, "sankey");
  assert.equal(c.nodes.length, 4);
  assert.ok(c.nodes.every((n) => n.id && n.label));
  const ids = new Set(c.nodes.map((n) => n.id));
  assert.ok(c.links.every((l) => ids.has(l.source) && ids.has(l.target)));
  assert.equal(c.links.reduce((s, l) => s + l.value, 0), 498);
});

test("sankey_empty", () => {
  assert.deepEqual(P.sankey({ nodes: ["a"], links: [] }), { __empty: true });
});

// ── Phase 1b: 자체 Canvas — timelineGrid · pitchZones ──
test("timelineGrid_model", () => {
  const c = P.timelineGrid({ rows: [
    { label: "서울", cells: [{ v: 2, mark: "W" }, { v: 5, mark: "L" }, { v: 0, mark: "D" }] },
    { label: "광주", cells: [{ v: 1, mark: "D" }] }], vMax: 11, legend: "범례" });
  assert.equal(c.__renderer, "timelineGrid");
  assert.equal(c.__rows, 2);
  assert.deepEqual(c.__model.rows[0].cells[1], { v: 5, mark: "L" });
  assert.equal(c.__model.vMax, 11);
});

test("timelineGrid_empty", () => {
  assert.deepEqual(P.timelineGrid({ rows: [], vMax: 11 }), { __empty: true });
});

test("timelineGrid_clips_to_width", () => {
  assert.deepEqual(P._gridLayout(300, 60, 40), { cell: 8, shown: 30, clipped: true });
  assert.deepEqual(P._gridLayout(300, 60, 10), { cell: 24, shown: 10, clipped: false });
});

const GEOM = [
  { key: "goalmouth", x0: 0, x1: 5.5, y0: 36.5, y1: 63.5 }, { key: "box_center", x0: 0, x1: 16.5, y0: 30, y1: 70 },
  { key: "box_wide", x0: 0, x1: 16.5, y0: 0, y1: 30 }, { key: "box_wide", x0: 0, x1: 16.5, y0: 70, y1: 100 },
  { key: "out_center", x0: 16.5, x1: 40, y0: 30, y1: 70 }, { key: "out_wide", x0: 16.5, x1: 40, y0: 0, y1: 30 },
  { key: "out_wide", x0: 16.5, x1: 40, y0: 70, y1: 100 }];

test("pitchZones_order", () => {
  const c = P.pitchZones({ geom: GEOM, values: { goalmouth: { label: "골문 앞", share: 10, lg_share: 9, z: 0.5 } } });
  assert.equal(c.__renderer, "pitchZones");
  assert.equal(c.__zones[c.__zones.length - 1].key, "goalmouth");   // 우선순위 높은 구역을 마지막에 덮어 그림
});

test("pitchZones_null_cells", () => {
  const c = P.pitchZones({ geom: GEOM, values: { box_center: null, out_wide: { label: "중거리 측면", share: 5, lg_share: 6, z: null } } });
  const bc = c.__zones.find((z) => z.key === "box_center"), ow = c.__zones.find((z) => z.key === "out_wide");
  assert.equal(bc.hatch, true); assert.equal(ow.hatch, true);
});

test("pitchZones_alert_mark", () => {
  const c = P.pitchZones({ geom: GEOM, values: { box_center: { label: "박스 중앙", share: 40, lg_share: 30, z: 2.4 } } });
  const z = c.__zones.find((x) => x.key === "box_center");
  assert.equal(z.alert, true); assert.equal(z.fill, THEME.neg);
});
