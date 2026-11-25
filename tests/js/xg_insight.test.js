// node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const XI = require("../../static/js/xg_insight.js");

const league = { n_teams: 20, r_pts: 0.41, r_gd: 0.48, r_xgd: 0.62, r_xpts: 0.6 };
const pooled = { n_teams: 290, n_leagues: 15, r_pts: 0.35, r_gd: 0.42, r_xgd: 0.55, r_xpts: 0.54 };

test("xg_insight_bars_and_best", () => {
  const h = XI.validHtml(league, pooled, "<b>EPL</b>");
  assert.equal((h.match(/class="xi-row"/g) || []).length, 8);   // 리그 4 + 합산 4
  assert.match(h, /가장 잘 맞힌 지표.*xG 차/);
  assert.match(h, /0\.62/);
  assert.doesNotMatch(h, /<b>EPL<\/b>/);
});

test("xg_insight_pooled_only_when_league_small", () => {
  const h = XI.validHtml({ n_teams: 2, r_pts: null, r_gd: null, r_xgd: null, r_xpts: null }, pooled, "J1");
  assert.match(h, /표본 부족/);
  assert.equal((h.match(/class="xi-row"/g) || []).length, 4);
});

test("xg_insight_empty", () => {
  assert.equal(XI.validHtml(null, null, "x"), "");
  assert.equal(XI.validHtml({ n_teams: 0 }, { n_teams: 0 }, "x"), "");
});

test("xg_insight_negative_r_bar_width_zero", () => {
  const h = XI.validHtml({ ...league, r_pts: -0.2 }, null, "L");
  assert.match(h, /--w:0%/);
  assert.match(h, /-0\.20/);
});
