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

  const TTChart = { THEME, util: { contrast, ensureVisible, merge }, withTheme, isEmpty, mount, presets: {} };
  root.TTChart = TTChart;
  if (typeof module !== "undefined" && module.exports) module.exports = TTChart;
})(typeof globalThis !== "undefined" ? globalThis : this);
