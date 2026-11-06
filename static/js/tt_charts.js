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
      // TERA 툴팁은 style/headerStyle/rowStyle 의 color 를 읽는다(미지정 시 #333 → 다크 배경에서 안 보임)
      tooltip: { enabled: true, backgroundColor: "rgba(11,17,32,0.95)", borderColor: "rgba(148,163,184,0.4)",
        style: { color: THEME.text, fontSize: THEME.fontSize, fontFamily: THEME.font },
        headerStyle: { color: THEME.text, fontSize: THEME.fontSize, fontWeight: "700" },
        rowStyle: { color: THEME.text, fontSize: THEME.fontSize } },
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
    slot.querySelectorAll("canvas, .tt-chart-error").forEach((c) => c.remove());
    placeholder(slot, "tt-chart-error", ERROR_TXT, "alert");
    // 카드(인사이트 .tt-card) 또는 팀 분석 패널(.tc-panel) 안의 근거 표를 펼친다
    const card = slot.closest && slot.closest(".tt-card, .tc-panel");
    const ev = card && card.querySelector("details.tt-card-evidence");
    if (ev) ev.open = true;
  }

  // 화면 코드가 들고 있는 핸들이 계속 유효하도록, 새 mount 결과의 메서드를 기존 핸들 객체로 옮긴다
  function rebind(target, fresh) {
    target.update = fresh.update; target.destroy = fresh.destroy;
    Object.defineProperty(target, "canvas", { configurable: true, enumerable: true, get: () => fresh.canvas });
    if (handles) handles.set(fresh.__slot, target);
    return target;
  }

  const NOOP_HANDLE = () => ({ canvas: null, update: () => {}, destroy: () => {} });
  const ROW_PX = 26, ROW_PAD = 56;

  function mount(slot, spec, opts) {
    opts = opts || {};
    if (!slot || !spec || typeof spec !== "object") {
      console.warn("[TTChart] mount: slot/spec 없음 — 무시", slot, spec);
      return NOOP_HANDLE();
    }
    const prev = handles && handles.get(slot);
    if (prev) prev.destroy();
    slot.querySelectorAll(".tt-chart-empty, .tt-chart-error").forEach((n) => n.remove());

    const handle = { canvas: null, update: () => {}, destroy: () => {}, __slot: slot };
    if (isEmpty(spec)) {
      placeholder(slot, "tt-chart-empty", EMPTY_TXT);
      handle.destroy = () => { slot.querySelectorAll(".tt-chart-empty").forEach((n) => n.remove()); handles && handles.delete(slot); };
      handle.update = (next) => rebind(handle, mount(slot, next, opts));
      handles && handles.set(slot, handle);
      return handle;
    }

    // 행이 많은 차트(dumbbell·heatMatrix·forest)는 행 수에 비례해 슬롯을 키운다
    // HTML 에 직접 적은 높이(예: 결과 띠 64px)는 기준 높이로 보존하고, 어댑터가 늘린 높이만 되돌린다
    if (slot.dataset.ttBaseH === undefined) slot.dataset.ttBaseH = slot.style.height || "";
    slot.style.height = slot.dataset.ttBaseH;
    if (spec.__rows > 0) {
      const base = parseFloat(getComputedStyle(slot).height) || 0;
      slot.style.height = Math.max(base, spec.__rows * (opts.rowPx || ROW_PX) + ROW_PAD) + "px";
    }

    let current = spec, canvas = null, io = null, ro = null, timer = null, dead = false, drawn = false;
    let failed = false;   // 오류 표시 후에는 리사이즈로 다시 그리지 않는다(update 로만 재시도)
    const dropCanvas = () => { canvas = null; handle.canvas = null; failed = true; };
    function size() { return [Math.max(1, Math.floor(slot.clientWidth)), Math.max(1, Math.floor(slot.clientHeight))]; }
    function draw(mode) {
      if (dead || failed) return;
      const T = lib();
      if (!T && !CUSTOM[current.__renderer]) { showError(slot, new Error("TeraChart not loaded")); dropCanvas(); return; }
      try {
        const [w, h] = size();
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", opts.ariaLabel || current.__aria || "차트");
          slot.appendChild(canvas);
          handle.canvas = canvas;
        }
        canvas.style.width = w + "px"; canvas.style.height = h + "px";
        if (CUSTOM[current.__renderer]) { CUSTOM[current.__renderer](canvas, current, w, h); drawn = true; return; }
        const cfg = finalConfig(current, w, h);
        const reduce = reducedMotion();
        if (mode === "update" && !reduce) T.update(canvas, cfg, { duration: UPDATE_MS });
        else if (mode === "animate" && !reduce) T.animate(canvas, cfg);
        else T.render(canvas, cfg);
        drawn = true;
      } catch (e) { showError(slot, e); dropCanvas(); }
    }
    function start() {
      // 숨겨진 패널(폭 0)에서는 그리지 않고, 처음 폭이 생길 때 그린다
      if (slot.clientWidth > 0) draw("animate");
      if (typeof ResizeObserver === "function") {
        let last = size().join("x");
        ro = new ResizeObserver(() => {
          if (!drawn && slot.clientWidth > 0) { last = size().join("x"); draw("animate"); return; }
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

    handle.update = (next) => {
      // 빈 데이터로 바뀌거나 렌더러(TERA ↔ 자체 Canvas)가 바뀌면 같은 canvas 를 재사용할 수 없다 → 다시 mount
      if (isEmpty(next) || (next && next.__renderer) !== (current && current.__renderer)) { rebind(handle, mount(slot, next, opts)); return; }
      current = next;
      if (canvas) canvas.setAttribute("aria-label", opts.ariaLabel || current.__aria || "차트");
      if (drawn) draw("update");
    };
    handle.destroy = () => {
      dead = true;
      clearTimeout(timer);
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      const T = lib();
      if (canvas && T && typeof T.stop === "function" && !CUSTOM[current.__renderer]) { try { T.stop(canvas); } catch (_) { /* noop */ } }
      if (canvas) canvas.remove();
      handles && handles.delete(slot);
    };
    handles && handles.set(slot, handle);
    return handle;
  }

  // container 안 모든 차트 슬롯의 핸들을 해제한다(innerHTML 교체 전 호출). 해제 개수 반환.
  function destroyAll(container) {
    if (!container || !handles) return 0;
    let n = 0;
    container.querySelectorAll("[data-chart-slot]").forEach((sl) => {
      const h = handles.get(sl);
      if (h) { h.destroy(); n++; }
    });
    return n;
  }

  // ── 프리셋 (순수: 도메인 데이터 → TERA config) ──────────────────────
  // 반환 config 의 __* 키는 테스트·접근성용 메타이며 finalConfig 가 TERA 에 넘기기 전에 제거한다.
  const EMPTY = () => ({ __empty: true });
  const r2 = (v) => Math.round(v * 100) / 100;
  // 가로 막대 카테고리 라벨 폭: 가장 긴 라벨 글자 수 × 12px(+여백), 40~160px
  const labelW = (cats) => Math.max(40, Math.min(160, 8 + 12 * Math.max(0, ...cats.map((c) => String(c).length))));

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
        color: on ? lighten(t.color || THEME.neutral, 3) : THEME.neutral,
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
        y: r.est, n: r.n,
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
      __rows: rows.length,
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
    const valW = 104, top = 8, bottom = 28;
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
      ctx.fillText(_fitText((t) => ctx.measureText(t).width, label, x0 - 12), x0 - 10, cy);
      if (!r) return;
      ctx.strokeStyle = "rgba(148,163,184,0.85)"; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(X(r.low), cy); ctx.lineTo(X(r.high), cy); ctx.stroke();
      ctx.fillStyle = p.color; ctx.strokeStyle = THEME.bg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(X(p.y) - 5, cy - 5, 10, 10); ctx.fill(); ctx.stroke();
      ctx.textAlign = "left"; ctx.fillStyle = THEME.text;
      ctx.fillText(p.n != null ? `${p.y.toFixed(2)} · n=${p.n}` : p.y.toFixed(2), x1 + 8, cy);
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
        { name: o.a.name, color: lighten(o.a.color || THEME.neg, 3), data: o.a.data.map(fix) },
        { name: o.b.name, color: lighten(o.b.color || THEME.pos, 3), data: o.b.data.map(fix) },
      ],
      connectorWidth: 3, markerRadius: 7, showValueLabels: true, showDelta: true,
      legend: { enabled: true, position: "bottom" },
      __rows: cats.length,
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
      __rows: rows.length,
      __aria: `${rows.length}×${cols.length} 히트맵 행렬`,
    };
  }

  // 100% 누적 가로 막대 (TERA row-bar stacking:'percent' — Phase 1b 랩 검증)
  function stacked100(o) {
    const cats = (o && o.categories) || [], parts = (o && o.parts) || [];
    if (!cats.length || !parts.length) return EMPTY();
    return {
      type: "row-bar", stacking: "percent", borderRadius: 2,
      yAxis: { categories: cats, labelWidth: labelW(cats) },
      xAxis: { min: 0, max: 100, labels: { format: "number:0" } },
      legend: { enabled: true, position: "bottom" },
      series: parts.map((p) => ({ name: p.name, color: lighten(p.color || THEME.neutral, 3), data: p.data.map((v) => (v == null ? 0 : r2(v))) })),
      __rows: cats.length,
      __aria: `${parts.map((p) => p.name).join("·")} 비중, ${cats.length}개 항목`,
    };
  }

  // 기준선이 있는 가로 막대 — 축은 0부터(잘린 축은 차이를 과장). TERA lollipop 은 기준선을 못 그려 row-bar 사용.
  function barRef(o) {
    const cats = (o && o.categories) || [];
    if (!cats.length) return EMPTY();
    const unit = o.unit || "";
    const lines = o.ref != null ? [{ value: o.ref, color: "rgba(229,231,235,0.8)", width: 1.5, dashArray: "4,3",
      label: `${o.refLabel || "기준"} ${o.ref}${unit}` }] : [];
    return {
      type: "row-bar", borderRadius: 3,
      yAxis: { categories: cats, labelWidth: labelW(cats) },
      xAxis: { min: 0, autoScale: true, plotLines: lines, labels: { format: "number:0" } },
      dataLabels: { enabled: true, position: "outside", style: { color: THEME.text, fontSize: 12 } },
      legend: { enabled: false },
      series: [{ name: o.name || "값", color: lighten(o.color || THEME.accent, 3), data: o.values.map((v) => (v == null ? null : r2(v))) }],
      __rows: cats.length,
      __aria: `${o.name || "값"} 막대, ${cats.length}개${o.ref != null ? `, ${o.refLabel || "기준"} ${o.ref}${unit}` : ""}`,
    };
  }

  // Sankey — 노드 라벨을 id 로 쓰고 값 0 링크는 뺀다
  function sankey(o) {
    const links = ((o && o.links) || []).filter((l) => l.value > 0);
    if (!links.length) return EMPTY();
    const PAL = [THEME.accent, THEME.pos, THEME.neg, "#f59e0b", THEME.neutral, "#60a5fa"];
    const colors = o.colors || {};
    const nodes = (o.nodes || []).map((n, i) => ({ id: n, label: n, color: colors[n] || PAL[i % PAL.length] }));
    return {
      type: "sankey", nodeWidth: 16, nodePadding: 12, linkOpacity: 0.5, linkGradient: true,
      nodeLabelStyle: { color: THEME.text, fontSize: 12, fontWeight: 600 },
      nodes, links: links.map((l) => ({ source: l.source, target: l.target, value: l.value })),
      __aria: `흐름도: ${links.map((l) => `${l.source}→${l.target} ${l.value}`).join(", ")}`,
    };
  }

  // 누적 페이스 선: 팀(굵게) vs 기준(회색 점선). 누적값은 계단처럼 움직여 곡선 보간 대신 직선.
  function paceLine(o) {
    const labels = (o && o.labels) || [];
    if (!labels.length || !o.team || !(o.team.data || []).length) return EMPTY();
    const pt = (v) => (v == null ? null : { y: v });
    const series = [{ name: o.team.name, color: lighten(o.team.color || THEME.accent, 3), lineWidth: 3, data: o.team.data.map(pt) }];
    (o.extra || []).forEach((e) => {
      const ser = { name: e.name, color: lighten(e.color || THEME.pos, 3), lineWidth: 3, data: e.data.map(pt) };
      if (e.dashArray) ser.dashArray = e.dashArray;          // 색만으로 구분하지 않도록 선 모양도 다르게
      series.push(ser);
    });
    if (o.ref && (o.ref.data || []).some((v) => v != null)) {
      series.push({ name: o.ref.name, color: THEME.sub, lineWidth: 1.5, dashArray: "4,3", data: o.ref.data.map(pt) });
    }
    return { type: "line", curveType: "linear", showMarkers: false, legend: { enabled: true, position: "bottom" },
      xAxis: { categories: labels }, series,
      __aria: `${series.map((x) => x.name).join(" vs ")} 누적 승점, ${labels.length}경기` };
  }

  // 좌우 대칭 막대: 왼쪽(음수로 그림)·오른쪽 — 축은 ±최댓값으로 대칭
  function diverging(o) {
    const cats = (o && o.categories) || [];
    if (!cats.length) return EMPTY();
    const L = o.left.data.map((v) => -(v || 0)), R = o.right.data.map((v) => v || 0);
    const m = Math.max(1, ...L.map(Math.abs), ...R);
    return { type: "row-bar", stacking: "normal", borderRadius: 2,
      yAxis: { categories: cats, labelWidth: 50 },
      xAxis: { min: -m, max: m, autoScale: false, plotLines: [{ value: 0, color: THEME.text, width: 1 }] },
      legend: { enabled: true, position: "bottom" },
      series: [{ name: o.left.name, color: lighten(o.left.color || THEME.neg, 3), data: L },
               { name: o.right.name, color: lighten(o.right.color || THEME.pos, 3), data: R }],
      __rows: cats.length,
      __aria: `${o.left.name}(왼쪽)·${o.right.name}(오른쪽) 비교, ${cats.length}개 구간` };
  }

  // ── 자체 Canvas 렌더러 공통 ──
  function prepCanvas(canvas, w, h) {
    const dpr = root.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${THEME.fontSize}px ${THEME.font}`;
    return ctx;
  }
  const mixHex = (a, b, t) => {
    const p = (h) => [0, 2, 4].map((i) => parseInt(String(h).replace("#", "").slice(i, i + 2), 16));
    const A = p(a), B = p(b);
    return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
  };

  // 폭을 넘는 라벨은 말줄임(…) — 전체 문구는 근거 표에 있다
  function _fitText(measure, text, maxW) {
    if (measure(text) <= maxW) return text;
    let t = text;
    while (t.length > 1 && measure(t + "…") > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  // 칸 배치: 가용 폭에 n 칸. 칸이 14px 미만이면 글자(W/D/L)를 못 넣어 색만 남으므로
  // 최근 floor(가용/14) 칸만 그린다 (칸 최대 32px)
  const CELL_MIN = 14;
  function _gridLayout(width, labelW, n) {
    const avail = Math.max(0, width - labelW);
    const raw = n ? avail / n : 0;
    if (raw < CELL_MIN) return { cell: CELL_MIN, shown: Math.floor(avail / CELL_MIN), clipped: true };
    return { cell: Math.min(32, Math.floor(raw)), shown: n, clipped: false };
  }

  // 타임라인 칸 색: 교체 수가 많을수록 진하게(accent 섞기, 최대 55%) + 글자는 칸 배경 대비가 더 큰 쪽(4.5:1 보장)
  const DARK_TEXT = "#0b1220";
  function _cellStyle(v, vMax) {
    const fill = mixHex("#1e293b", THEME.accent, Math.min(0.55, Math.max(0, v || 0) / (vMax || 11)));
    const text = contrast(THEME.text, fill) >= contrast(DARK_TEXT, fill) ? THEME.text : DARK_TEXT;
    return { fill, text };
  }

  // 로테이션 타임라인 그리드: 행 = 팀, 칸 = 경기(시간순), 진하기 = v/vMax, 글자/띠 = W·D·L
  function timelineGrid(o) {
    const rows = ((o && o.rows) || []).filter((r) => r.cells && r.cells.length);
    if (!rows.length) return EMPTY();
    return { __renderer: "timelineGrid", __model: { rows, vMax: o.vMax || 11, legend: o.legend || "" },
      __rows: rows.length, __aria: `${rows.length}개 팀 경기별 타임라인. ${o.legend || ""}` };
  }
  function drawTimelineGrid(canvas, spec, w, h) {
    const ctx = prepCanvas(canvas, w, h);
    const { rows, vMax, legend } = spec.__model;
    const labelW = Math.min(80, Math.max(...rows.map((r) => ctx.measureText(r.label).width)) + 12);
    const nMax = Math.max(...rows.map((r) => r.cells.length));
    const L = _gridLayout(w - 8, labelW, nMax);
    const top = 22, rowH = Math.max(16, Math.min(24, (h - top - 8) / rows.length));
    ctx.textBaseline = "middle";
    ctx.fillStyle = THEME.sub; ctx.textAlign = "left";
    ctx.fillText(legend, 0, 10);
    if (L.clipped) { ctx.textAlign = "right"; ctx.fillText(`최근 ${L.shown}경기`, w - 4, 10); }
    rows.forEach((r, i) => {
      const y = top + i * rowH;
      ctx.textAlign = "right"; ctx.fillStyle = THEME.text;
      ctx.fillText(r.label, labelW - 8, y + rowH / 2);
      const cells = L.shown ? r.cells.slice(-L.shown) : [];
      cells.forEach((c, j) => {
        const x = labelW + j * L.cell, cw = L.cell - 2, ch = rowH - 3;
        const st = _cellStyle(c.v, vMax);
        ctx.fillStyle = st.fill; ctx.fillRect(x, y, cw, ch);
        ctx.fillStyle = st.text; ctx.textAlign = "center";       // 결과는 글자로(색 의존 없음)
        ctx.fillText(c.mark || "", x + cw / 2, y + ch / 2 + 1);
      });
    });
  }

  // 실점 약점 지도: 하프 피치(골라인이 위) 위 구역 색칠 — 색 + ⚠/✓ 기호 + 비중 % 글자
  function pitchZones(o) {
    const geom = (o && o.geom) || [], vals = (o && o.values) || {}, names = (o && o.labels) || {};
    if (!geom.length) return EMPTY();
    const zones = geom.map((g, i) => {
      const v = vals[g.key];
      const z = v && v.z != null ? v.z : null;
      const fill = z == null ? "#1e293b" : z >= 2 ? THEME.neg : z <= -2 ? THEME.pos : "#334155";
      const light = contrast(THEME.text, fill) >= 4.5;   // 강조 구역(밝은 빨강·초록)은 어두운 글자
      return { ...g, prio: i, label: (v && v.label) || names[g.key] || "", share: v ? v.share : null, lg_share: v ? v.lg_share : null, z,
        hatch: !v || z == null, alert: z != null && z >= 2, good: z != null && z <= -2, fill,
        textColor: light ? THEME.text : DARK_TEXT, subColor: light ? (contrast(THEME.sub, fill) >= 4.5 ? THEME.sub : THEME.text) : DARK_TEXT };
    }).sort((a, b) => b.prio - a.prio);   // 넓은 구역 먼저, 우선순위 높은(goalmouth) 구역을 마지막에
    return { __renderer: "pitchZones", __zones: zones, __title: o.title || "",
      __aria: `실점 약점 지도${o.title ? " — " + o.title : ""}: ${zones.filter((z) => z.alert).map((z) => z.label).join(", ") || "두드러진 약점 없음"}` };
  }
  function drawPitchZones(canvas, spec, w, h) {
    const ctx = prepCanvas(canvas, w, h);
    const top = spec.__title ? 22 : 6, pad = 8;
    const pitchH = h - top - pad, pitchW = Math.min(w - pad * 2, pitchH * 68 / 40 * 1.0);
    const ox = (w - pitchW) / 2, oy = top;
    const X = (yPct) => ox + yPct / 100 * pitchW, Y = (m) => oy + m / 40 * pitchH;
    if (spec.__title) { ctx.fillStyle = THEME.text; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(spec.__title, w / 2, 4); }
    spec.__zones.forEach((z) => {
      const x0 = X(z.y0), x1 = X(z.y1), y0 = Y(z.x0), y1 = Y(z.x1);
      ctx.fillStyle = z.fill;                 // 불투명 — 글자 대비 계산이 칠한 색 그대로 맞도록
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (z.hatch) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
        ctx.strokeStyle = "rgba(148,163,184,0.35)"; ctx.lineWidth = 1;
        for (let k = -pitchH; k < pitchW; k += 8) { ctx.beginPath(); ctx.moveTo(x0 + k, y0); ctx.lineTo(x0 + k + (y1 - y0), y1); ctx.stroke(); }
        ctx.restore();
      }
      ctx.strokeStyle = "rgba(229,231,235,0.55)"; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    });
    // 사각형마다 구역 이름 + 비중(같은 구역의 좌우 사각형 모두 표기). 골문 앞은 작아서 한 줄만.
    spec.__zones.forEach((z) => {
      if (!z.label) return;
      // 다른 구역(골문 앞)이 위쪽을 덮는 사각형은 그 아래 남은 영역의 중앙에 라벨을 둔다
      const cover = spec.__zones.find((o) => o !== z && o.prio < z.prio && o.x0 <= z.x0 && o.y0 >= z.y0 && o.y1 <= z.y1);
      const topM = cover ? Math.max(z.x0, cover.x1) : z.x0;
      const cx = (X(z.y0) + X(z.y1)) / 2, cy = (Y(topM) + Y(z.x1)) / 2, small = Y(z.x1) - Y(z.x0) < 44;
      const mark = z.alert ? "⚠ " : z.good ? "✓ " : "";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (small) {
        ctx.fillStyle = z.textColor;
        ctx.fillText(z.share == null ? `${z.label} · 분류 불가` : `${mark}${z.label} ${z.share}%`, cx, cy);
        return;
      }
      ctx.fillStyle = z.subColor; ctx.fillText(z.label, cx, cy - 16);
      ctx.fillStyle = z.textColor;
      ctx.fillText(z.share == null ? "분류 불가" : `${mark}${z.share}%`, cx, cy);
      if (z.share != null) { ctx.fillStyle = z.subColor; ctx.fillText(`리그 ${z.lg_share}%`, cx, cy + 16); }
    });
    ctx.strokeStyle = "rgba(229,231,235,0.8)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + pitchW, oy); ctx.stroke();   // 골라인
  }

  const CUSTOM = { forest: (c, s, w, h) => drawForest(c, s, w, h), timelineGrid: drawTimelineGrid, pitchZones: drawPitchZones };

  const presets = { bump, _forestModel, forest, dumbbell, quadrant, heatMatrix, stacked100, barRef, sankey,
    _gridLayout, _cellStyle, _fitText, timelineGrid, pitchZones, paceLine, diverging };

  const TTChart = { THEME, util: { contrast, ensureVisible, lighten, merge }, withTheme, isEmpty, mount, destroyAll, presets };
  root.TTChart = TTChart;
  if (typeof module !== "undefined" && module.exports) module.exports = TTChart;
})(typeof globalThis !== "undefined" ? globalThis : this);
