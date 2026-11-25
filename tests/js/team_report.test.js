// node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const TR = require("../../static/js/team_report.js");

const base = {
  label: "Premier League", team: { id: 42, name: "<i>Arsenal</i>" }, n_teams: 20, is_current: true,
  official: { rank: 1, pts: 27, played: 10, w: 9, d: 0, l: 1, gf: 15, ga: 5 },
  flow: [
    { round: 1, rank: 2, pts: 3, n: 20, res: "W", gf: 3, ga: 0 },
    { round: 2, rank: 5, pts: 3, n: 20, res: "L", gf: 0, ga: 1 },
    { round: 3, rank: 1, pts: 6, n: 20, res: "W", gf: 2, ga: 0 },
  ],
  form: ["W", "D", "L"],
  xg: { xg_for: 1.9, xg_against: 0.8, xg_diff: 1.1, g_minus_xg: -0.2, ga_minus_xga: 0.1, xg_rank: 1, n_ranked: 20, xg_games: 10,
        coverage: { games: 100, xg_games: 100, pct: 100 } },
  formations: { list: [{ formation: "4-3-3", n: 8 }, { formation: "4-2-3-1", n: 2 }], family: { "4백": 10 }, n: 10 },
  players: [{ id: 1, name: "D. Rice", position: "M", apps: 10, minutes: 827, goals: 0, assists: 5, rating: 7.44, market_value: 120000000 }],
  leaders: { goals: { name: "B. Saka", goals: 3 }, assists: { name: "D. Rice", assists: 5 }, rating: { name: "<b>X</b>", rating: 7.48 } },
  squad_value: { value: 1253000000, value_rank: 1, rank: 1, diff: 0, n_teams: 20 },
  notes: ["n1"],
};

test("team_report_header_and_form", () => {
  const h = TR.html(base);
  assert.match(h, /1위/);
  assert.match(h, /9승 0무 1패/);
  assert.equal((h.match(/class="tr-form-chip/g) || []).length, 3);
  assert.match(h, /aria-label="최근 3경기: 승, 무, 패"/);
});

test("team_report_flow_svg_points_and_inverted_y", () => {
  const h = TR.html(base);
  assert.equal((h.match(/<circle /g) || []).length, 3);
  // 1위가 5위보다 위(작은 y)
  const ys = [...h.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)"/g)].map(m => +m[1]);
  assert.ok(ys[2] < ys[1], `${ys}`);
  assert.match(h, /<title>R2 · 5위 · 패 0-1<\/title>/);
});

test("team_report_cards", () => {
  const h = TR.html(base);
  assert.match(h, /xG 차 <b>\+1\.10<\/b>/);
  assert.match(h, /4-3-3/);
  assert.match(h, /€1253M|€1,253M|€1253\.0M/);
});

test("team_report_escapes", () => {
  const h = TR.html(base);
  assert.doesNotMatch(h, /<i>Arsenal<\/i>/);
  assert.doesNotMatch(h, /<b>X<\/b>/);
});

test("team_report_missing_sections", () => {
  const h = TR.html({ ...base, xg: null, formations: { list: [], family: {}, n: 0 }, squad_value: null, flow: [], players: [] });
  assert.match(h, /팀 xG 데이터 없음/);
  assert.match(h, /선발 위치 데이터 없음/);
  assert.match(h, /시장가치 연결 선수 없음/);
  assert.match(h, /종료된 경기가 없습니다/);
  assert.doesNotMatch(h, /<circle /);
});

test("team_report_past_season_squad_note", () => {
  const h = TR.html({ ...base, is_current: false, squad_value: null });
  assert.match(h, /현재 시즌에서만/);
});

test("team_report_low_xg_coverage_warning", () => {
  const h = TR.html({ ...base, xg: { ...base.xg, coverage: { games: 100, xg_games: 20, pct: 20 } } });
  assert.match(h, /⚠/);
});

test("team_report_height_foot_column", () => {
  const h = TR.html({ ...base, players: [{ ...base.players[0], height: 185, foot: "Left", phys_src: "TM" }, { ...base.players[0], id: 2, height: null, foot: null }] });
  assert.match(h, /키·주발/);
  assert.match(h, /185cm · 왼발/);
  assert.match(h, /title="Transfermarkt 값으로 보완"/);
  assert.match(h, /<td>-<\/td>/);
});

// 2026-11-25 전문가 평가 반영: 평점 소수 2자리 통일 · 순위 흐름 텍스트 요약/표(키보드·화면낭독기·모바일)
test("team_report_rating_two_decimals", () => {
  const h = TR.html({ ...base, players: [{ ...base.players[0], rating: 7 }] });
  assert.match(h, /<td class="tr-num">7\.00<\/td>/);
});

test("team_report_flow_text_summary_and_table", () => {
  const h = TR.html(base);
  assert.match(h, /최고 <b>1위<\/b> \(R3\)/);
  assert.match(h, /최저 <b>5위<\/b> \(R2\)/);
  assert.match(h, /<details class="tr-flow-tbl">/);
  assert.equal((h.match(/<tr class="tr-fr">/g) || []).length, 3);
});
