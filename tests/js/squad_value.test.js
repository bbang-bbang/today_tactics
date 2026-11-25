// node --test tests/js/
const test = require("node:test");
const assert = require("node:assert/strict");
const SV = require("../../static/js/squad_value.js");

const d = {
  teams: [
    { rank: 1, name: "서울", pts: 67, value: 27230000, n_valued: 37, n_linked: 42, value_rank: 1, diff: 0, value_per_pt_m: 0.41 },
    { rank: 4, name: "<b>인천</b>", pts: 49, value: 8050000, n_valued: 31, n_linked: 34, value_rank: 11, diff: 7, value_per_pt_m: 0.16 },
    { rank: 12, name: "광주", pts: 22, value: 8880000, n_valued: 29, n_linked: 33, value_rank: 7, diff: -5, value_per_pt_m: 0.4 },
  ],
  highlights: { over: { name: "인천", diff: 7 }, under: { name: "광주", diff: -5 } },
  coverage: { players: 687, linked: 422, valued: 390 }, notes: ["n<script>"],
};

test("squad_value_rows_and_signs", () => {
  const h = SV.html(d);
  assert.equal((h.match(/<tr>/g) || []).length, 1 + 3);
  assert.match(h, /€27\.2M/);
  assert.match(h, /sv-pos"><b>\+7</);
  assert.match(h, /sv-neg"><b>-5</);
});

test("squad_value_escapes", () => {
  const h = SV.html(d);
  assert.doesNotMatch(h, /<b>인천<\/b><\/td>/);
  assert.doesNotMatch(h, /<script>/);
});

test("squad_value_empty", () => {
  assert.match(SV.html({ teams: [{ rank: 1, name: "A", value: null }] }), /계산할 수 없습니다/);
});

// 2026-11-25 K리그 팀 시즌 리뷰용 — 리그 표에서 한 팀 카드
test("squad_value_team_card", () => {
  const dd = { ...d, teams: d.teams.map((t, i) => ({ ...t, team_id: 100 + i })) };
  const h = SV.teamHtml(dd, 101);
  assert.match(h, /€8\.1M/);
  assert.match(h, /가치 11\/3위|가치 11위/);
  assert.match(h, /\+7/);
  assert.doesNotMatch(h, /<b>인천<\/b><\/span>/);
});

test("squad_value_team_card_missing", () => {
  assert.equal(SV.teamHtml(d, 999), "");
  assert.equal(SV.teamHtml(null, 1), "");
});
