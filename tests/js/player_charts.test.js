// node --test "tests/js/*.test.js" — PlayerCharts (선수 분석 모달 경기별 트렌드)
const test = require("node:test");
const assert = require("node:assert/strict");
const PlayerCharts = require("../../static/js/player_charts.js");

const m = (year, date, rating, g, a, result) => ({ year, date, rating, goals: g, assists: a, result });

test("ratingLine_latest_season_and_avg", () => {
  const t = [m(2025, "10/1", 7.0, 0, 0, "W"), m(2026, "3/1", 6.0, 0, 0, "D"), m(2026, "3/8", 8.0, 1, 0, "W")];
  const c = PlayerCharts.ratingLine(t);
  assert.deepEqual(c.xAxis.categories, ["3/1", "3/8"]);
  assert.deepEqual(c.series[0].data, [{ y: 6 }, { y: 8 }]);
  assert.deepEqual(c.series[1].data, [{ y: 7 }, { y: 7 }]);       // 시즌 평균(평점 있는 경기)
  assert.equal(c.__note, "2026 시즌만 표시");
});

test("ratingLine_null_gaps", () => {
  const c = PlayerCharts.ratingLine([m(2026, "3/1", 6.5, 0, 0, "D"), m(2026, "3/8", null, 0, 0, "L"), m(2026, "3/15", 7.5, 0, 1, "W")]);
  assert.deepEqual(c.series[0].data, [{ y: 6.5 }, null, { y: 7.5 }]);
  assert.equal(c.series[1].data[0].y, 7);
});

test("ratingLine_single", () => {
  const c = PlayerCharts.ratingLine([m(2026, "3/1", 6.5, 0, 0, "D")]);
  assert.equal(c.series[0].data.length, 1);
  assert.notEqual(c.__empty, true);
});

test("ratingLine_empty", () => {
  assert.deepEqual(PlayerCharts.ratingLine([]), { __empty: true });
  assert.deepEqual(PlayerCharts.ratingLine([m(2026, "3/1", null, 0, 0, "D")]), { __empty: true });
});

test("strip_contribution_and_result", () => {
  const c = PlayerCharts.strip([m(2026, "3/1", 6.5, 2, 1, "W"), m(2026, "3/8", 6.0, 0, 0, "L")]);
  assert.deepEqual(c.__model.rows[0].cells, [{ v: 3, mark: "W" }, { v: 0, mark: "L" }]);
  assert.equal(c.__model.vMax, 3);
});

test("strip_empty", () => {
  assert.deepEqual(PlayerCharts.strip([]), { __empty: true });
});
