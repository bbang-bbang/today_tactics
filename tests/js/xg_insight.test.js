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

test("xg_insight_ci_shown", () => {
  const p2 = { ...pooled, ci_xgd: [0.46, 0.63], ci_pts: [0.24, 0.45] };
  const h = XI.validHtml(league, p2, "L");
  assert.match(h, /95% 구간 0\.46~0\.63/);
  assert.match(h, /title="95% 신뢰구간 0\.24~0\.45"/);
});

// 2026-11-25 팀 xG 표 공용화 (해외 리그 탭 + K리그 시즌 리뷰)
const xd = {
  teams: [
    { team_id: 1, name: "<b>서울</b>", xg_games: 10, xg_for: 1.8, xg_against: 1.0, xg_diff: 0.8, g_minus_xg: 0.1, ga_minus_xga: -0.2, xpts: 20.1, pts_x: 22, pts_minus_xpts: 1.9, shots_pg: 14.2, box_share: null, possession: null },
    { team_id: 2, name: "울산", xg_games: 9, xg_for: 1.1, xg_against: 1.4, xg_diff: -0.3, g_minus_xg: -0.2, ga_minus_xga: 0.3, xpts: 11.0, pts_x: 9, pts_minus_xpts: -2.0, shots_pg: 11, box_share: null, possession: null },
    { team_id: 3, name: "표본부족", xg_games: 2, xg_for: null },
  ],
  games: 30, coverage: { games: 30, xg_games: 16, pct: 53.3 }, min_games: 3,
  highlights: { best_xg_diff: "서울", over: { name: "서울", value: 0.1 }, under: { name: "울산", value: -0.2 } }, notes: ["n<i>"],
};

test("xg_table_rows_and_hidden_columns", () => {
  const h = XI.tableHtml(xd);
  assert.equal((h.match(/<tr>/g) || []).length, 1 + 2);
  assert.doesNotMatch(h, /박스 안/);           // 전부 null 이면 열 숨김
  assert.doesNotMatch(h, /점유율/);
  assert.match(h, /⚠ xG 제공 <b>16\/30경기<\/b>/);
  assert.match(h, /3경기 미만 팀 1곳/);
  assert.doesNotMatch(h, /<b>서울<\/b><\/td>/);
});

test("xg_table_overseas_keeps_columns", () => {
  const h = XI.tableHtml({ ...xd, teams: xd.teams.map(t => ({ ...t, box_share: 60, possession: 50 })) });
  assert.match(h, /박스 안/);
  assert.match(h, /점유율/);
});

test("xg_table_empty", () => {
  assert.equal(XI.tableHtml({ teams: [{ xg_for: null }] }), "");
});

test("xg_team_line", () => {
  const h = XI.teamLine(xd, 2);
  assert.match(h, /xG 차 <b>-0\.30<\/b>/);
  assert.match(h, /2\/2위/);
  assert.match(h, /승점−xPts <b[^>]*>-2\.0<\/b>/);
  assert.equal(XI.teamLine(xd, 3), "");
});
