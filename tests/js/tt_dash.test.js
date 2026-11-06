// node --test tests/js/
const test = require("node:test");
const assert = require("node:assert/strict");
const TTDash = require("../../static/js/tt_dash.js");

const XSS = "<img src=x onerror=alert(1)>";
const base = () => ({
  id: "ins-xgluck", size: "L", icon: "🍀", title: "xG 운 보정",
  question: "실력만큼 승점을 땄나?", warnings: [],
});

test("cardHtml_structure", () => {
  const h = TTDash.cardHtml(base());
  assert.match(h, /class="tt-card tt-card--L"/);
  assert.match(h, /id="ins-xgluck"/);
  assert.equal(h.split("data-chart-slot").length - 1, 1);
});

test("cardHtml_requires_warnings", () => {
  const o = base(); delete o.warnings;
  assert.throws(() => TTDash.cardHtml(o), /warnings required/);
});

test("cardHtml_escapes", () => {
  const h = TTDash.cardHtml({ ...base(), title: XSS, question: XSS, take: XSS, warnings: [XSS] });
  assert.ok(!h.includes("<img"), "raw <img must not appear");
  assert.ok(h.includes("&lt;img"));
});

test("cardHtml_league_toggle", () => {
  const h = TTDash.cardHtml({ ...base(), leagues: ["K1", "K2"], activeLeague: "K2" });
  assert.match(h, /data-league="K2"[^>]*aria-selected="true"/);
  assert.match(h, /data-league="K1"[^>]*aria-selected="false"/);
  const one = TTDash.cardHtml({ ...base(), leagues: ["K1"] });
  assert.ok(!one.includes("tt-lg-toggle"));
});

test("cardHtml_evidence_optional", () => {
  assert.ok(!TTDash.cardHtml(base()).includes("<details"));
  const h = TTDash.cardHtml({ ...base(), evidenceHtml: "<table></table>" });
  assert.match(h, /<details class="tt-card-evidence"><summary>근거 보기<\/summary><table><\/table>/);
});

test("kpiStripHtml_dirs", () => {
  const h = TTDash.kpiStripHtml([
    { label: "a", value: 1, delta: "x", dir: "up" },
    { label: "b", value: 2, delta: "y", dir: "down" },
    { label: "c", value: 3, delta: "z", dir: "flat" },
  ]);
  assert.ok(h.includes("▲") && h.includes("▼") && h.includes("–"));
  assert.match(h, /tt-kpi-d--up/);
});

test("kpiStripHtml_escapes", () => {
  const h = TTDash.kpiStripHtml([{ label: "<b>x</b>", value: 1 }]);
  assert.ok(h.includes("&lt;b&gt;") && !h.includes("<b>"));
});

test("chipsHtml_active", () => {
  const h = TTDash.chipsHtml([{ key: "all", label: "전체" }, { key: "flow", label: "흐름·운" }], "flow");
  assert.match(h, /data-theme-key="flow"[^>]*aria-selected="true"/);
  assert.match(h, /data-theme-key="all"[^>]*aria-selected="false"/);
});

// ── Phase 1a ──
test("cardHtml_chart_false_no_slot", () => {
  assert.ok(!TTDash.cardHtml({ ...base(), chart: false }).includes("data-chart-slot"));
});

test("cardHtml_body_html_raw", () => {
  const h = TTDash.cardHtml({ ...base(), chart: false, bodyHtml: '<table id="t"></table>' });
  assert.match(h, /<div class="tt-card-body"[^>]*><table id="t"><\/table><\/div>/);
});

test("cardHtml_has_lead_slot", () => {
  assert.equal(TTDash.cardHtml(base()).split("tt-card-lead").length - 1, 1);
});
