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
  // 배경 대비가 minRatio 이상이 될 때까지 흰색 쪽으로 섞는다(이미 충분하면 그대로).
  function lighten(hex, minRatio, bg) {
    const base = bg || THEME.bg;
    if (contrast(hex, base) >= minRatio) return hex;
    const h = String(hex).replace("#", "");
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const mix = "#" + rgb.map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, "0")).join("");
      if (contrast(mix, base) >= minRatio) return mix;
    }
    return "#ffffff";
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
      if (!T && current.__renderer !== "forest") { showError(slot, new Error("TeraChart not loaded")); return; }
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
        if (current.__renderer === "forest") { drawForest(canvas, current, w, h); drawn = true; return; }
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
      if (canvas && T && typeof T.stop === "function" && current.__renderer !== "forest") { try { T.stop(canvas); } catch (_) { /* noop */ } }
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
      // smooth(catmullrom)는 순위선이 고리처럼 튀어(스파이크) overshoot 없는 monotone 보간 사용
      type: "line", curveType: "monotone", showMarkers: false,
      xAxis: { categories: o.rounds.map((r) => "R" + r) },
      yAxis: { min: 1, max: n, autoScale: false,
        labels: { formatter: (v) => (Math.abs(v - Math.round(v)) < 1e-6 && v >= 1 && v <= n ? `${n + 1 - Math.round(v)}위` : "") } },
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
    // TERA range-bar/boxplot/dumbbell 은 기준선(plotLines)·소수 눈금을 그리지 못해(Phase 0 스파이크)
    // 이 프리셋만 어댑터 자체 Canvas 렌더러(drawForest)로 그린다. spec §4.6 대체 규칙.
    return {
      __renderer: "forest",
      __model: m,
      __zero: zero,
      __zeroLabel: o.zeroLabel || "기준",
      __unit: o.unit || "",
      __aria: `효과 추정치와 95% 신뢰구간, ${rows.length}개 구간${o.unit ? ` (${o.unit})` : ""}`,
    };
  }

  // forest 전용 Canvas 렌더러 (브라우저). 행마다: 라벨 | CI 선 + 추정치 점 | 값. 기준선은 점선.
  function drawForest(canvas, spec, w, h) {
    const dpr = (root.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const m = spec.__model, z = spec.__zero;
    const vals = [z];
    m.ranges.forEach((r) => { if (r) vals.push(r.low, r.high); });
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || 0.1; lo -= pad; hi += pad;
    const font = `${THEME.fontSize}px ${THEME.font}`;
    ctx.font = font;
    const labelW = Math.min(w * 0.38, Math.max(...m.categories.map((c) => ctx.measureText(c).width)) + 12);
    const valW = 64, top = 8, bottom = 28;
    const x0 = labelW, x1 = w - valW;
    const X = (v) => x0 + (v - lo) / (hi - lo) * (x1 - x0);
    const rowH = (h - top - bottom) / Math.max(1, m.categories.length);
    // 눈금 (소수 2자리)
    ctx.fillStyle = THEME.sub; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * i / 4, x = X(v);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h - bottom); ctx.stroke();
      ctx.fillText(v.toFixed(2), x, h - bottom + 6);
    }
    // 기준선
    ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = "rgba(229,231,235,0.6)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(z), top); ctx.lineTo(X(z), h - bottom); ctx.stroke(); ctx.restore();
    ctx.fillStyle = THEME.sub; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${spec.__zeroLabel} ${z.toFixed(2)}`, Math.min(X(z) + 4, x1 - 60), top);
    // 행
    m.categories.forEach((label, i) => {
      const cy = top + rowH * (i + 0.5);
      const r = m.ranges[i], p = m.points[i];
      ctx.textBaseline = "middle"; ctx.textAlign = "right";
      ctx.fillStyle = r ? THEME.text : THEME.sub;
      ctx.fillText(label, x0 - 10, cy);
      if (!r) return;
      ctx.strokeStyle = "rgba(148,163,184,0.85)"; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(X(r.low), cy); ctx.lineTo(X(r.high), cy); ctx.stroke();
      ctx.fillStyle = p.color; ctx.strokeStyle = THEME.bg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(X(p.y) - 5, cy - 5, 10, 10); ctx.fill(); ctx.stroke();
      ctx.textAlign = "left"; ctx.fillStyle = THEME.text;
      ctx.fillText(p.y.toFixed(2), x1 + 8, cy);
    });
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
    // TERA scatter 는 점별 색·마커 외곽선을 무시한다(스파이크) → 팀마다 series 1개, 어두운 색은 밝혀서 칠함
    const series = pts.map((p) => {
      const on = !hl || hl.has(p.id);
      return {
        name: p.label,
        color: on ? lighten(p.color || THEME.neutral, 3) : THEME.neutral,
        marker: { size: on ? 9 : 7, symbol: "circle" },
        data: [on ? { x: p.x, y: p.y, label: p.label } : { x: p.x, y: p.y }],
      };
    });
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    // 대각선이 있으면 x·y 공통 범위(정사각 좌표) — 그래야 y=x 가 비율 좌표 (0,1)→(1,0) 이 된다
    const span = (a) => { const lo = Math.min(...a), hi = Math.max(...a), pad = (hi - lo) * 0.08 || 0.1; return [r2(lo - pad), r2(hi + pad)]; };
    const [xMin, xMax] = o.diagonal ? span(xs.concat(ys)) : span(xs);
    const [yMin, yMax] = o.diagonal ? [xMin, xMax] : span(ys);
    const plotX = o.xMid != null ? [{ value: o.xMid, color: "rgba(148,163,184,0.5)", width: 1, dashArray: "4,3" }] : [];
    const plotY = o.yMid != null ? [{ value: o.yMid, color: "rgba(148,163,184,0.5)", width: 1, dashArray: "4,3" }] : [];
    const ann = [];
    if (o.diagonal) ann.push({ type: "line", x: 0, y: 1, x2: 1, y2: 0, style: { color: "#94a3b8", dashArray: "4,3" } });
    const ql = o.quadrantLabels || [];
    const pos = [[0.03, 0.04], [0.72, 0.04], [0.03, 0.9], [0.68, 0.9]]; // tl, tr, bl, br (비율, y 는 위에서부터)
    ql.forEach((t, i) => { if (t) ann.push({ type: "text", x: pos[i][0], y: pos[i][1], text: t, style: { color: THEME.sub, fontSize: 12 } }); });
    const out = {
      type: "scatter",
      pointLabels: { enabled: true },
      xAxis: { type: "linear", autoScale: false, min: xMin, max: xMax, title: o.xTitle, labels: { format: "number:0.0" }, plotLines: plotX },
      yAxis: { type: "linear", autoScale: false, min: yMin, max: yMax, title: o.yTitle, labels: { format: "number:0.0" }, plotLines: plotY },
      legend: { enabled: false },
      annotations: ann,
      series,
      __aria: `${o.xTitle} 대비 ${o.yTitle} 산점도, ${pts.length}개`,
    };
    if (o.diagonal) {
      const all = xs.concat(ys);
      out.__diagonal = [{ x: Math.min(...all), y: Math.min(...all) }, { x: Math.max(...all), y: Math.max(...all) }];
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
      data, // TERA heatmap 은 최상위 data 를 읽는다(series 안은 무시 — 스파이크)
      __scale: scale,
      __aria: `${rows.length}×${cols.length} 히트맵 행렬`,
    };
  }

  const presets = { bump, _forestModel, forest, dumbbell, quadrant, heatMatrix };

  const TTChart = { THEME, util: { contrast, ensureVisible, lighten, merge }, withTheme, isEmpty, mount, presets };
  root.TTChart = TTChart;
  if (typeof module !== "undefined" && module.exports) module.exports = TTChart;
})(typeof globalThis !== "undefined" ? globalThis : this);
