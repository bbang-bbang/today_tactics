// TERA CHART 어댑터 — 앱에서 TeraChart 전역을 만지는 유일한 파일 (spec §4.1)
// 화면 코드는 TTChart.presets.*(순수: 도메인 데이터 → config)와 TTChart.mount()만 쓴다.
// 라이브러리를 바꿔야 하면 이 파일만 교체한다.
(function (root) {
  "use strict";

  const THEME = {
    bg: "#0b1220", text: "#e5e7eb", sub: "#94a3b8", grid: "rgba(51,65,85,0.5)",
    pos: "#34d399", neg: "#f87171", neutral: "#475569", accent: "#e8435a",
    font: "'Noto Sans KR', system-ui, sans-serif", fontSize: 12,
  };
  const MIN_FONT = 12;
  const ANIM_MAX = 400, UPDATE_MS = 300, RESIZE_DEBOUNCE = 150;

  // ── 유틸 ───────────────────────────────────────────────────────────
  function lum(hex) {
    const h = String(hex).replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrast(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  // 그래픽 요소 대비 3:1(WCAG 1.4.11) 미만이면 밝은 외곽선을 붙인다.
  function ensureVisible(hex, bg) {
    return { fill: hex, stroke: contrast(hex, bg || THEME.bg) < 3 ? THEME.text : null };
  }
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  // defaults 위에 cfg 를 덮는다(cfg 우선). 둘 다 건드리지 않고 새 객체 반환.
  function merge(defaults, cfg) {
    const out = Array.isArray(defaults) ? defaults.slice() : { ...defaults };
    for (const k of Object.keys(cfg || {})) {
      out[k] = isObj(defaults[k]) && isObj(cfg[k]) ? merge(defaults[k], cfg[k]) : cfg[k];
    }
    return out;
  }
  function clampFonts(o) {
    if (Array.isArray(o)) return o.map(clampFonts);
    if (!isObj(o)) return o;
    const out = {};
    for (const k of Object.keys(o)) {
      out[k] = k === "fontSize" && typeof o[k] === "number" && o[k] < MIN_FONT ? MIN_FONT : clampFonts(o[k]);
    }
    return out;
  }

  // ── 테마 ───────────────────────────────────────────────────────────
  function themeDefaults() {
    const lbl = { color: THEME.sub, fontSize: THEME.fontSize, fontFamily: THEME.font };
    return {
      background: { color: "rgba(0,0,0,0)" },
      xAxis: { labels: { style: { ...lbl } }, titleStyle: { ...lbl } },
      yAxis: { labels: { style: { ...lbl } }, titleStyle: { ...lbl } },
      grid: { color: THEME.grid, lineWidth: 0.5 },
      legend: { labelStyle: { ...lbl } },
      tooltip: { enabled: true, backgroundColor: "rgba(11,17,32,0.95)", borderColor: "rgba(148,163,184,0.4)",
        textStyle: { color: THEME.text, fontSize: THEME.fontSize, fontFamily: THEME.font } },
      fontFamily: THEME.font,
    };
  }
  // 순수: 카드가 제목을 담당하므로 title/subtitle 제거, 다크 테마 기본값 + 폰트 하한 12.
  function withTheme(cfg) {
    const src = { ...(cfg || {}) };
    delete src.title; delete src.subtitle;
    const merged = merge(themeDefaults(), src);
    // yAxis 가 배열(다축)이면 각 축에 기본값을 입힌다
    if (Array.isArray(src.yAxis)) merged.yAxis = src.yAxis.map((ax) => merge(themeDefaults().yAxis, ax));
    merged.background = { ...(merged.background || {}), color: "rgba(0,0,0,0)" };
    return clampFonts(merged);
  }
  const isEmpty = (spec) => !!(spec && spec.__empty === true);

  // ── mount (브라우저 전용) ──────────────────────────────────────────
  const EMPTY_TXT = "표시할 데이터가 없습니다 (표본 부족)";
  const ERROR_TXT = "차트를 불러오지 못했습니다";
  const handles = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lib = () => (typeof root.TeraChart === "object" && root.TeraChart) || null;

  // 내부 표식(__*)을 빼고 테마·크기·애니메이션 상한을 입힌 최종 TERA config
  function finalConfig(spec, w, h) {
    const clean = {};
    for (const k of Object.keys(spec)) if (k.slice(0, 2) !== "__") clean[k] = spec[k];
    const cfg = withTheme(clean);
    cfg.width = w; cfg.height = h;
    const dur = cfg.animation && typeof cfg.animation.duration === "number" ? cfg.animation.duration : ANIM_MAX;
    cfg.animation = { ...(cfg.animation || {}), duration: Math.min(dur, ANIM_MAX) };
    return cfg;
  }
  function placeholder(slot, cls, text, role) {
    const d = document.createElement("div");
    d.className = cls; d.textContent = text;
    if (role) d.setAttribute("role", role);
    slot.appendChild(d);
  }
  function showError(slot, err) {
    if (err) console.warn("[TTChart] render failed:", err);
    slot.querySelectorAll("canvas").forEach((c) => c.remove());
    placeholder(slot, "tt-chart-error", ERROR_TXT, "alert");
    const card = slot.closest && slot.closest(".tt-card");
    const ev = card && card.querySelector("details.tt-card-evidence");
    if (ev) ev.open = true;
  }

  function mount(slot, spec, opts) {
    opts = opts || {};
    const prev = handles && handles.get(slot);
    if (prev) prev.destroy();
    slot.querySelectorAll(".tt-chart-empty, .tt-chart-error").forEach((n) => n.remove());

    const handle = { canvas: null, update: () => {}, destroy: () => {} };
    if (isEmpty(spec)) {
      placeholder(slot, "tt-chart-empty", EMPTY_TXT);
      handle.destroy = () => { slot.querySelectorAll(".tt-chart-empty").forEach((n) => n.remove()); handles && handles.delete(slot); };
      handles && handles.set(slot, handle);
      return handle;
    }

    let current = spec, canvas = null, io = null, ro = null, timer = null, dead = false, drawn = false;
    function size() { return [Math.max(1, Math.floor(slot.clientWidth)), Math.max(1, Math.floor(slot.clientHeight))]; }
    function draw(mode) {
      if (dead) return;
      const T = lib();
      if (!T) { showError(slot, new Error("TeraChart not loaded")); return; }
      try {
        const [w, h] = size();
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", opts.ariaLabel || spec.__aria || "차트");
          slot.appendChild(canvas);
          handle.canvas = canvas;
        }
        canvas.style.width = w + "px"; canvas.style.height = h + "px";
        const cfg = finalConfig(current, w, h);
        const reduce = reducedMotion();
        if (mode === "update" && !reduce) T.update(canvas, cfg, { duration: UPDATE_MS });
        else if (mode === "animate" && !reduce) T.animate(canvas, cfg);
        else T.render(canvas, cfg);
        drawn = true;
      } catch (e) { showError(slot, e); }
    }
    function start() {
      draw("animate");
      if (typeof ResizeObserver === "function") {
        let last = size().join("x");
        ro = new ResizeObserver(() => {
          const now = size().join("x");
          if (now === last) return;
          last = now;
          clearTimeout(timer);
          timer = setTimeout(() => draw("render"), RESIZE_DEBOUNCE);
        });
        ro.observe(slot);
      }
    }
    const lazy = opts.lazy !== false && typeof IntersectionObserver === "function";
    if (lazy) {
      io = new IntersectionObserver((ents) => {
        if (ents.some((e) => e.isIntersecting)) { io.disconnect(); io = null; start(); }
      }, { rootMargin: "200px" });
      io.observe(slot);
    } else start();

    handle.update = (next) => { current = next; if (drawn) draw("update"); };
    handle.destroy = () => {
      dead = true;
      clearTimeout(timer);
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      const T = lib();
      if (canvas && T && typeof T.stop === "function") { try { T.stop(canvas); } catch (_) { /* noop */ } }
      if (canvas) canvas.remove();
      handles && handles.delete(slot);
    };
    handles && handles.set(slot, handle);
    return handle;
  }

  // ── 프리셋 (순수: 도메인 데이터 → TERA config) ──────────────────────
  // 반환 config 의 __* 키는 테스트·접근성용 메타이며 finalConfig 가 TERA 에 넘기기 전에 제거한다.
  const EMPTY = () => ({ __empty: true });
  const r2 = (v) => Math.round(v * 100) / 100;

  // 순위 추이: y = nTeams+1-rank 로 뒤집어 1위가 위로 가게 그린다.
  function bump(o) {
    const teams = (o && o.teams) || [];
    if (!teams.length || !(o.rounds || []).length) return EMPTY();
    const n = o.nTeams;
    const hl = Array.isArray(o.highlight) && o.highlight.length ? new Set(o.highlight) : null;
    const series = teams.map((t) => {
      const on = !hl || hl.has(t.id);
      return {
        name: t.short,
        color: on ? t.color : THEME.neutral,
        lineWidth: hl ? (on ? 3 : 1.5) : 2,
        opacity: on ? 1 : 0.5,
        data: t.ranks.map((r) => (r == null ? null : { y: n + 1 - r })),
      };
    });
    const last = o.rounds.length - 1;
    const labels = teams.filter((t) => !hl || hl.has(t.id)).map((t) => {
      const r = t.ranks[last];
      return r == null ? null : { type: "text", x: last, y: n + 1 - r, text: t.short, style: { color: THEME.text, fontSize: 12 } };
    }).filter(Boolean);
    return {
      type: "line", smooth: true, showMarkers: false,
      xAxis: { categories: o.rounds.map((r) => "R" + r) },
      yAxis: { min: 1, max: n, tickInterval: 1, __rankLabels: true }, // SPIKE: 눈금을 'N위'로 — TERA 라벨 포매터 확인
      legend: { enabled: false },
      annotations: labels,
      series,
      __nTeams: n,
      __aria: `라운드별 순위 추이, ${teams.length}개 팀, ${o.rounds.length}라운드`,
    };
  }

  // forest plot 중간 표현: 행 순서 유지, 표본 부족은 구간·점 생략.
  function _forestModel(rows, zero) {
    const z = zero || 0;
    return {
      categories: rows.map((r) => (r.insufficient ? `${r.label} (표본 부족)` : r.label)),
      ranges: rows.map((r) => (r.insufficient ? null : { low: r.lo, high: r.hi })),
      points: rows.map((r) => (r.insufficient ? null : {
        y: r.est,
        color: r.significant ? (r.est > z ? THEME.pos : THEME.neg) : THEME.text,
      })),
    };
  }
  function forest(o) {
    const rows = (o && o.rows) || [];
    if (!rows.some((r) => !r.insufficient)) return EMPTY();
    const zero = o.zero || 0;
    const m = _forestModel(rows, zero);
    return {
      type: "range-bar",
      barWidth: "18%", borderRadius: 2,
      series: [{
        name: "95% 신뢰구간", color: "rgba(148,163,184,0.55)",
        data: m.categories.map((name, i) => (m.ranges[i] ? { name, low: m.ranges[i].low, high: m.ranges[i].high } : { name, low: null, high: null })),
      }],
      xAxis: { plotLines: [{ value: zero, color: "rgba(229,231,235,0.45)", width: 1.5, dashArray: "4,3" }] },
      __points: m.points, // SPIKE: 추정치 점을 range-bar 위에 겹치는 방법(annotations/mixed) 확인
      __zero: zero,
      __aria: `효과 추정치와 95% 신뢰구간, ${rows.length}개 구간${o.unit ? ` (${o.unit})` : ""}`,
    };
  }

  function dumbbell(o) {
    const cats = (o && o.categories) || [];
    if (!cats.length) return EMPTY();
    if (o.a.data.length !== cats.length || o.b.data.length !== cats.length) throw new RangeError("dumbbell: data length mismatch");
    const d = o.decimals == null ? 2 : o.decimals;
    const fix = (v) => (v == null ? null : Number(v.toFixed(d)));
    return {
      type: "dumbbell", orientation: "horizontal",
      categories: cats,
      series: [
        { name: o.a.name, color: o.a.color || THEME.neg, data: o.a.data.map(fix) },
        { name: o.b.name, color: o.b.color || THEME.pos, data: o.b.data.map(fix) },
      ],
      connectorWidth: 3, markerRadius: 7, showValueLabels: true, showDelta: true,
      legend: { enabled: true, position: "bottom" },
      __aria: `${o.a.name}와 ${o.b.name} 비교, ${cats.length}개 항목`,
    };
  }

  function quadrant(o) {
    const pts = (o && o.points) || [];
    if (!pts.length) return EMPTY();
    const hl = Array.isArray(o.highlight) && o.highlight.length ? new Set(o.highlight) : null;
    const data = pts.map((p) => {
      const v = ensureVisible(p.color || THEME.neutral);
      const on = !hl || hl.has(p.id);
      return {
        x: p.x, y: p.y, name: p.label,
        color: on ? v.fill : THEME.neutral,
        borderColor: v.stroke || v.fill, borderWidth: v.stroke ? 1.5 : 0,
        dataLabel: on ? p.label : "",
      };
    });
    const plotX = o.xMid != null ? [{ value: o.xMid, color: "rgba(148,163,184,0.5)", width: 1, dashArray: "4,3" }] : [];
    const plotY = o.yMid != null ? [{ value: o.yMid, color: "rgba(148,163,184,0.5)", width: 1, dashArray: "4,3" }] : [];
    const out = {
      type: "scatter",
      xAxis: { type: "linear", autoScale: true, title: o.xTitle, plotLines: plotX },
      yAxis: { type: "linear", autoScale: true, title: o.yTitle, plotLines: plotY },
      legend: { enabled: false },
      series: [{ name: "teams", marker: { size: 9, symbol: "circle" }, data }],
      __quadrantLabels: o.quadrantLabels || null, // SPIKE: 모서리 라벨 annotation 좌표계 확인
      __aria: `${o.xTitle} 대비 ${o.yTitle} 산점도, ${pts.length}개`,
    };
    if (o.diagonal) {
      const all = pts.flatMap((p) => [p.x, p.y]);
      const lo = Math.min(...all), hi = Math.max(...all);
      out.__diagonal = [{ x: lo, y: lo }, { x: hi, y: hi }]; // SPIKE: y=x 점선 그리는 방법 확인
    }
    return out;
  }

  function heatMatrix(o) {
    const rows = (o && o.rows) || [], cols = (o && o.cols) || [];
    if (!rows.length || !cols.length) return EMPTY();
    const data = [];
    rows.forEach((_, y) => cols.forEach((__, x) => {
      const v = o.values[y] ? o.values[y][x] : null;
      data.push({ x, y, value: v == null ? null : v });
    }));
    const nums = data.map((d) => d.value).filter((v) => v != null);
    if (!nums.length) return EMPTY();
    let scale, stops;
    if (o.center != null) {
      const span = Math.max(...nums.map((v) => Math.abs(v - o.center)));
      scale = { min: r2(o.center - span), max: r2(o.center + span) };
      stops = [THEME.neg, THEME.neutral, THEME.pos];
    } else {
      scale = { min: r2(Math.min(...nums)), max: r2(Math.max(...nums)) };
      stops = [THEME.neutral, THEME.pos];
    }
    return {
      type: "heatmap",
      xAxis: { categories: cols }, yAxis: { categories: rows },
      colorStops: stops.map((c, i) => ({ offset: i / (stops.length - 1), color: c })),
      min: scale.min, max: scale.max,
      nullColor: "#1e293b", cellRadius: 3, cellPadding: 2, showColorBar: true, showValues: true,
      valueTextStyle: { fontSize: 12, decimals: o.decimals == null ? 2 : o.decimals, color: "#f8fafc" },
      colorBarStyle: { title: o.colorTitle || "" },
      series: [{ name: o.colorTitle || "value", data }],
      __scale: scale,
      __aria: `${rows.length}×${cols.length} 히트맵 행렬`,
    };
  }

  const presets = { bump, _forestModel, forest, dumbbell, quadrant, heatMatrix };

  const TTChart = { THEME, util: { contrast, ensureVisible, merge }, withTheme, isEmpty, mount, presets };
  root.TTChart = TTChart;
  if (typeof module !== "undefined" && module.exports) module.exports = TTChart;
})(typeof globalThis !== "undefined" ? globalThis : this);
