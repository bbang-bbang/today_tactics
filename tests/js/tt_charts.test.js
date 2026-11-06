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
