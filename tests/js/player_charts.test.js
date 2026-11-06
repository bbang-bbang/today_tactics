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

test("strip_position_aware", () => {
  // 골키퍼는 선방, 수비수는 수비 행동으로 칸 진하기 (공격포인트로 재면 늘 빈 띠)
  const gk = PlayerCharts.strip([{ year: 2026, date: "3/1", rating: 7, goals: 0, assists: 0, saves: 5, def: 1, result: "W" }], "G");
  assert.equal(gk.__model.rows[0].cells[0].v, 5); assert.match(gk.__model.legend, /선방/);
  const df = PlayerCharts.strip([{ year: 2026, date: "3/1", rating: 7, goals: 0, assists: 0, saves: 0, def: 6, result: "D" }], "D");
  assert.equal(df.__model.rows[0].cells[0].v, 6); assert.match(df.__model.legend, /수비/);
});

test("ratingLine_axis_zoomed", () => {
  // 평점은 6~8 사이에서 움직임 — 선 그래프라 축을 0부터 둘 필요 없음(최저 평점 -1 ~ 10)
  const c = PlayerCharts.ratingLine([m(2026, "3/1", 6.3, 0, 0, "D"), m(2026, "3/8", 8.5, 2, 0, "W")]);
  assert.equal(c.yAxis.min, 5); assert.equal(c.yAxis.max, 10); assert.equal(c.yAxis.autoScale, false);
});
