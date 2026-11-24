// node --test tests/js/
const test = require("node:test");
const assert = require("node:assert/strict");
const SL = require("../../static/js/recruit_shortlist.js");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fakeStorage(init) {
  const m = new Map(init ? [[SL.KEY, init]] : []);
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m };
}
const kr = (id, name) => ({ src: "kr", player_id: id, name: name || "선수" + id, team: "울산", league: "K1", age: 25, mins: 1200, goals: 3, assists: 2, score: 70, fitLabel: "적합도", fit: 75, metrics: [{ label: "키패스", pct: 81 }], mode: "position", saved: "2026-11-24" });
const os = (name, team) => ({ src: "os", name, team: team || "Leeds", league: "Championship", age: 24, mins: 1500, goals: 4, assists: 1, detail: "윙어", score: 66, fitLabel: "보정", fit: 59, metrics: [], mode: "position", saved: "2026-11-24" });

test("entry_id", () => {
  assert.equal(SL.entryId({ src: "kr", player_id: 5 }), "kr:5");
  assert.equal(SL.entryId({ src: "os", name: "A", team: "B" }), "os:A|B");
});

test("sanitize_rejects", () => {
  for (const bad of [null, "x", { src: "x", name: "a" }, { src: "kr", name: "a" }, { src: "os", name: "" }])
    assert.equal(SL.sanitize(bad), null);
});

test("sanitize_cleans", () => {
  const e = SL.sanitize({ src: "os", name: "A", team: "T", age: "abc", metrics: [{ label: "키패스", pct: "81" }, { bad: 1 }] });
  assert.equal(e.age, null);
  assert.equal(e.metrics.length, 1);
  assert.equal(e.metrics[0].pct, 81);
  assert.equal(SL.sanitize({ src: "os", name: "x".repeat(500) }).name.length, 120);
});

test("load_corrupt", () => {
  assert.deepEqual(SL.load(fakeStorage("not json")), {});
  assert.deepEqual(SL.load(fakeStorage("[1,2]")), {});
  const all = SL.load(fakeStorage('{"suwon":[{"src":"x"},{"src":"os","name":"A","team":"T"}],"bad":5}'));
  assert.equal(all.suwon.length, 1);
  assert.equal(all.bad, undefined);
});

test("load_storage_throws", () => {
  const st = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.deepEqual(SL.load(st), {});
  assert.equal(SL.save(st, {}), false);
  assert.deepEqual(SL.list(st, "suwon"), []);
});

test("add_dedupes", () => {
  const st = fakeStorage();
  assert.equal(SL.add(st, "suwon", kr(1)), "added");
  assert.equal(SL.add(st, "suwon", kr(1)), "exists");
  assert.equal(SL.list(st, "suwon").length, 1);
  assert.equal(SL.has(st, "suwon", "kr:1"), true);
});

test("add_invalid", () => {
  assert.equal(SL.add(fakeStorage(), "suwon", { src: "kr", name: "a" }), "invalid");
});

test("add_caps_at_10", () => {
  const st = fakeStorage();
  for (let i = 1; i <= 10; i++) assert.equal(SL.add(st, "suwon", kr(i)), "added");
  assert.equal(SL.MAX, 10);
  assert.equal(SL.add(st, "suwon", kr(11)), "full");
  assert.equal(SL.list(st, "suwon").length, 10);
});

test("add_per_team", () => {
  const st = fakeStorage();
  SL.add(st, "suwon", kr(1));
  assert.equal(SL.list(st, "ulsan").length, 0);
});

test("remove_clear", () => {
  const st = fakeStorage();
  SL.add(st, "suwon", kr(1)); SL.add(st, "suwon", os("A"));
  SL.remove(st, "suwon", "kr:1");
  assert.equal(SL.has(st, "suwon", "kr:1"), false);
  assert.equal(SL.list(st, "suwon").length, 1);
  SL.clear(st, "suwon");
  assert.equal(SL.list(st, "suwon").length, 0);
});

test("csvCell_injection", () => {
  assert.equal(SL.csvCell("=1+1"), "\"'=1+1\"");
  assert.equal(SL.csvCell("@x"), "\"'@x\"");
  assert.equal(SL.csvCell("-3"), "\"'-3\"");
  assert.equal(SL.csvCell("+3"), "\"'+3\"");
  assert.equal(SL.csvCell('a"b'), '"a""b"');
  assert.equal(SL.csvCell(null), '""');
  assert.equal(SL.csvCell(12), '"12"');
});

test("toCsv_bom_header", () => {
  const e = kr(1); e.metrics = [{ label: "키패스", pct: 81 }, { label: "태클", pct: 60 }];
  const csv = SL.toCsv([e, os("=HYPERLINK(1)")]);
  assert.equal(csv[0], "﻿");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], ["구분", "이름", "소속", "리그", "나이", "출전", "골", "도움", "세부 포지션", "점수 이름", "점수", "지표", "추천 방식", "담은 날짜"].map(x => `"${x}"`).join(","));
  assert.match(lines[1], /"키패스:81;태클:60"/);
  assert.match(lines[1], /^"국내"/);
  assert.match(lines[2], /^"해외","'=HYPERLINK\(1\)"/);
});

test("csvName", () => {
  assert.equal(SL.csvName("수원 삼성", "2026-11-24"), "영입후보_수원 삼성_20261124.csv");
  assert.equal(SL.csvName('a/b:c*?"<>|', "2026-11-24"), "영입후보_a_b_c______" + "_20261124.csv");
});

test("panelHtml_escapes_and_splits", () => {
  const x = kr(1, "<img src=x onerror=1>");
  const h = SL.panelHtml([x, os("B")], esc);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /국내 후보/);
  assert.match(h, /해외 후보/);
  assert.match(h, /직접 비교하지 마세요/);
  assert.match(h, /data-sl-remove="kr:1"/);
  assert.match(h, /data-sl-csv/);
  assert.doesNotMatch(SL.panelHtml([kr(2)], esc), /직접 비교하지 마세요/);
  assert.match(SL.panelHtml([], esc), /담은 후보가 없습니다/);
});

test("panelHtml_saved_line_without_mode", () => {
  const h = SL.panelHtml([{ src: "os", name: "A", team: "T", metrics: [] }], esc);
  assert.doesNotMatch(h, /rc-sl-saved rc-muted">\s*·/);
});

test("pick_rejects_stale_index", () => {
  const rows = [kr(1), kr(2)];
  assert.equal(SL.pick(rows, 1, "kr:2").name, "선수2");
  assert.equal(SL.pick(rows, 0, "kr:2"), null);   // 늦게 온 응답이 _rows 를 바꿔 인덱스가 어긋난 경우
  assert.equal(SL.pick(undefined, 0, "kr:1"), null);
  assert.equal(SL.pick(rows, 5, "kr:1"), null);
});
