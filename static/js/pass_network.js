/* pass_network.js — 팀 분석 모달 '🕸 패스 네트워크' 탭
 * /api/pass-network (K리그 공식 getPassData 집계): 선수 간 성공 패스 횟수. 노드 위치는 선발 라인업 배치(실제 평균 위치 아님).
 * 시즌 누적 / 경기별 전환, 연결 표시 기준 슬라이더, 선수 선택(호버·클릭·키보드), 규칙 기반 인사이트.
 */
(function () {
  "use strict";
  const panel = document.getElementById("ta-panel-pass");
  const root = document.getElementById("pn-root");
  if (!panel || !root) return;

  const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  const POS_KO = { GK: "골키퍼", DF: "수비", MF: "미드필더", FW: "공격" };
  const POS_LETTER = { GK: "G", DF: "D", MF: "M", FW: "F" };
  const W = 420, H = 560, PAD = 30, MAX_EDGES_DEFAULT = 36;

  const state = { mode: "season", eventId: null, data: null, matches: null, minCombined: 1, selected: null, seq: 0, dirty: true };
  let ctx = (window.taState && window.taState()) || null;

  const isVisible = () => !panel.classList.contains("hidden");

  // ── 데이터 로드 ───────────────────────────────────────────────
  function load() {
    if (!ctx || !ctx.teamId) { root.innerHTML = `<div class="pn-empty" role="status">팀을 선택하면 패스 네트워크가 표시됩니다.</div>`; return; }
    state.dirty = false;
    const my = ++state.seq;
    root.innerHTML = `<div class="pn-empty" role="status">패스 네트워크 불러오는 중…</div>`;
    const yp = ctx.year && ctx.year !== "전체" ? `&year=${encodeURIComponent(ctx.year)}` : "";
    const url = state.mode === "match" && state.eventId
      ? `/api/pass-network?teamId=${encodeURIComponent(ctx.teamId)}&eventId=${state.eventId}&minPasses=1`
      : `/api/pass-network?teamId=${encodeURIComponent(ctx.teamId)}${yp}&minPasses=1`;
    fetch(url).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then(({ ok, d }) => {
      if (my !== state.seq) return;
      state.data = d;
      state.selected = null;
      if (!d || !d.ready) { renderEmpty(d); return; }
      state.minCombined = defaultThreshold(d);
      render();
      if (state.mode === "season" || !state.matches) ensureMatches(d.year);
    }).catch((e) => {
      if (my !== state.seq) return;
      console.error("[pass-network]", e);
      root.innerHTML = `<div class="pn-empty pn-error" role="alert">패스 네트워크를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</div>`;
    });
  }

  function ensureMatches(year) {
    if (!year || (state.matches && state.matches.year === year && state.matches.team === ctx.teamId)) return;
    fetch(`/api/pass-network/matches?teamId=${encodeURIComponent(ctx.teamId)}&year=${year}`)
      .then((r) => r.json()).then((m) => { state.matches = m; if (state.data && state.data.ready) render(); })
      .catch(() => {});
  }

  function renderEmpty(d) {
    const msg = d && d.reason === "no_pass_data"
      ? "이 팀·시즌의 패스 데이터가 아직 없습니다. 패스 데이터는 경기 다음 날 공개되며, 수집 전일 수도 있습니다."
      : "패스 네트워크 데이터를 표시할 수 없습니다.";
    root.innerHTML = `<div class="pn-empty" role="status">${esc(msg)}</div>`;
  }

  // 시즌 평균 좌표는 포메이션 변경으로 한곳에 몰려 노드가 겹친다. 겹침만 풀도록 결정적(무작위 없음) 반발 보정:
  // 쌍마다 최소 거리(반지름 합 + 여백 · 가로 이동을 더 크게 요구 = 이름 라벨 폭 고려)를 만족하게 밀고,
  // 원래 위치로 되돌리는 약한 복원력으로 배치의 전체 모양은 유지한다.
  function relax(nodes, nx, ny, r) {
    const pts = nodes.map((n, i) => ({ k: n.kid, x0: nx(n), y0: ny(n), x: nx(n) + (i % 2 ? 0.01 : -0.01) * i, y: ny(n), r: r(n) }));
    for (let it = 0; it < 90; it++) {
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt((dx * 0.62) * (dx * 0.62) + dy * dy) || 0.001;
          const min = a.r + b.r + 16;
          if (d < min) {
            const push = (min - d) / 2 / d;
            a.x -= dx * push * 0.62; a.y -= dy * push; b.x += dx * push * 0.62; b.y += dy * push;
          }
        }
      }
      for (const p of pts) {
        p.x += (p.x0 - p.x) * 0.03; p.y += (p.y0 - p.y) * 0.03;
        p.x = Math.max(PAD, Math.min(W - PAD, p.x)); p.y = Math.max(PAD, Math.min(H - PAD, p.y));
      }
    }
    return new Map(pts.map((p) => [p.k, [p.x, p.y]]));
  }

  // ── 계산 ──────────────────────────────────────────────────────
  // 양방향을 합쳐 한 쌍으로 그린다(선 굵기=쌍방 합계). 방향별 횟수는 툴팁/목록에 병기.
  function combine(edges) {
    const m = new Map();
    for (const e of edges) {
      const a = Math.min(e.from, e.to), b = Math.max(e.from, e.to), k = a + "-" + b;
      let c = m.get(k);
      if (!c) { c = { a, b, ab: 0, ba: 0, total: 0 }; m.set(k, c); }
      if (e.from === a) c.ab += e.passes; else c.ba += e.passes;
      c.total += e.passes;
    }
    return [...m.values()].sort((x, y) => y.total - x.total);
  }
  function defaultThreshold(d) {
    const c = combine(d.edges);
    if (d.scope === "match" || c.length <= MAX_EDGES_DEFAULT) return 1;
    return Math.max(1, c[MAX_EDGES_DEFAULT - 1].total);
  }

  // ── 렌더 ──────────────────────────────────────────────────────
  function render() {
    const d = state.data;
    const byKid = new Map(d.nodes.map((n) => [n.kid, n]));
    const all = combine(d.edges);
    const maxTotal = all.length ? all[0].total : 1;
    const th = Math.min(Math.max(1, state.minCombined), Math.max(1, maxTotal));
    const shown = all.filter((c) => c.total >= th);
    const placed = d.nodes.filter((n) => n.x != null && n.y != null && n.involvement > 0);
    const unplaced = d.nodes.filter((n) => (n.x == null || n.y == null) && n.involvement > 0);
    const maxInv = Math.max(1, ...placed.map((n) => n.involvement));
    const sel = state.selected;
    const r = (n) => 9 + 13 * Math.sqrt(n.involvement / maxInv);
    const pos = relax(placed, (n) => PAD + n.x / 100 * (W - 2 * PAD), (n) => PAD + n.y / 100 * (H - 2 * PAD), r);
    const nx = (n) => pos.get(n.kid)[0];
    const ny = (n) => pos.get(n.kid)[1];

    root.style.setProperty("--pn-team", d.team.primary || "#7ecfff");

    // 경기장(공격 방향 ↑)
    const pitch = `<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="6" class="pn-line"/>
      <line x1="6" y1="${H / 2}" x2="${W - 6}" y2="${H / 2}" class="pn-line"/><circle cx="${W / 2}" cy="${H / 2}" r="44" class="pn-line"/>
      <rect x="${W / 2 - 80}" y="6" width="160" height="62" class="pn-line"/><rect x="${W / 2 - 80}" y="${H - 68}" width="160" height="62" class="pn-line"/>
      <rect x="${W / 2 - 34}" y="6" width="68" height="24" class="pn-line"/><rect x="${W / 2 - 34}" y="${H - 30}" width="68" height="24" class="pn-line"/>`;

    const edgeSvg = shown.map((c) => {
      const A = byKid.get(c.a), B = byKid.get(c.b);
      if (!A || !B || A.x == null || B.x == null) return "";
      const ratio = c.total / maxTotal;
      const hot = sel && (sel === c.a || sel === c.b);
      const dim = sel && !hot;
      const tip = `${A.name} → ${B.name} ${c.ab}회 · ${B.name} → ${A.name} ${c.ba}회 (합계 ${c.total}회${d.matches > 1 ? `, 경기당 ${(c.total / d.matches).toFixed(1)}` : ""})`;
      return `<line class="pn-edge${hot ? " is-hot" : ""}${dim ? " is-dim" : ""}" x1="${nx(A).toFixed(1)}" y1="${ny(A).toFixed(1)}" x2="${nx(B).toFixed(1)}" y2="${ny(B).toFixed(1)}"
        stroke-width="${(1 + 8 * Math.pow(ratio, 0.8)).toFixed(1)}" style="opacity:${(dim ? 0.08 : 0.28 + 0.55 * ratio).toFixed(2)}"><title>${esc(tip)}</title></line>`;
    }).join("");

    const nodeSvg = placed.map((n) => {
      const isSel = sel === n.kid;
      const lab = `${n.name} · ${POS_KO[n.pos] || "포지션 미상"} · 패스 ${n.made}회, 받은 패스 ${n.received}회`;
      return `<g class="pn-node pn-n-${esc(n.pos || "NA")}${isSel ? " is-sel" : ""}" data-pn-node="${n.kid}" tabindex="0" role="button" aria-pressed="${isSel}" aria-label="${esc(lab)}" transform="translate(${nx(n).toFixed(1)} ${ny(n).toFixed(1)})">
        <title>${esc(lab)}</title><circle r="${r(n).toFixed(1)}"/><text class="pn-pos" dy="4">${POS_LETTER[n.pos] || "?"}</text>
        <text class="pn-name" y="${(r(n) + 14).toFixed(1)}">${esc(n.name)}</text></g>`;
    }).join("");

    root.innerHTML = `
      ${controlsHtml(d)}
      <div class="pn-grid">
        <div class="pn-pitch-wrap">
          <svg class="pn-pitch" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(d.team.short)} 패스 네트워크 — 공격 방향 위쪽" data-pn-bg="1">
            ${pitch}<g>${edgeSvg}</g><g>${nodeSvg}</g>
          </svg>
          <div class="pn-legend" aria-hidden="true"><span class="pn-lg pn-n-GK">G 골키퍼</span><span class="pn-lg pn-n-DF">D 수비</span><span class="pn-lg pn-n-MF">M 미드필더</span><span class="pn-lg pn-n-FW">F 공격</span><span class="pn-lg-note">원 크기 = 패스 관여량 · 선 굵기 = 쌍방 패스 합계 · 겹치는 선수는 보기 좋게 약간 옮겨 그렸습니다</span></div>
          <div class="pn-slider"><label for="pn-th">연결 표시 기준 <b id="pn-th-val">${th}</b>회 이상 <span class="pn-muted">(표시 ${shown.length}/${all.length}쌍)</span></label>
            <input id="pn-th" type="range" min="1" max="${Math.max(1, maxTotal)}" value="${th}"></div>
        </div>
        <div class="pn-side">${sideHtml(d, byKid, all, unplaced)}</div>
      </div>`;
  }

  function controlsHtml(d) {
    const isMatch = state.mode === "match";
    const opts = (state.matches && state.matches.matches || []).map((m) => {
      const dt = new Date(m.date_ts * 1000);
      const label = `${dt.getMonth() + 1}/${String(dt.getDate()).padStart(2, "0")} ${m.home ? "홈" : "원정"} vs ${m.opponent} (${m.score[0]}-${m.score[1]})${m.has_data ? "" : " · 미공개"}`;
      return `<option value="${m.event_id}"${m.has_data ? "" : " disabled"}${state.eventId === m.event_id ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
    const scope = d.scope === "season"
      ? `${d.year} 시즌 · ${d.matches}경기 누적${d.matches < d.team_matches ? ` (전체 ${d.team_matches}경기 중)` : ""}`
      : `${d.year} · ${d.match.home ? "홈" : "원정"} vs ${esc(d.match.opponent || "-")} (${d.match.score[0]}-${d.match.score[1]})`;
    return `<div class="pn-controls">
      <div class="pn-modes" role="group" aria-label="보기 범위">
        <button type="button" class="pn-mode${isMatch ? "" : " is-on"}" data-pn-mode="season" aria-pressed="${!isMatch}">시즌 누적</button>
        <button type="button" class="pn-mode${isMatch ? " is-on" : ""}" data-pn-mode="match" aria-pressed="${isMatch}">경기별</button>
        ${isMatch ? `<select id="pn-match" aria-label="경기 선택">${opts || '<option disabled>경기 목록 없음</option>'}</select>` : ""}
      </div><span class="pn-scope">${scope}</span></div>`;
  }

  function sideHtml(d, byKid, all, unplaced) {
    const nm = (k) => esc((byKid.get(k) || {}).name || "?");
    const notes = (d.insights.notes || []).map((n) =>
      `<li class="pn-note pn-note-${esc(n.kind)}"><div class="pn-note-t">${esc(n.text)}</div><div class="pn-note-e">근거: ${esc(n.evidence)}</div></li>`).join("");
    const hubs = d.insights.hubs.map((n, i) =>
      `<li><span class="pn-rank">${i + 1}</span><b>${esc(n.name)}</b><span class="pn-muted"> ${esc(POS_KO[n.pos] || "")}</span>
       <span class="pn-val">${(n.share * 100).toFixed(1)}%<span class="pn-muted"> · 패스 ${n.made} / 수신 ${n.received}</span></span></li>`).join("");
    const links = all.slice(0, 5).map((c, i) =>
      `<li><span class="pn-rank">${i + 1}</span><b>${nm(c.a)}</b> ⇄ <b>${nm(c.b)}</b>
       <span class="pn-val">${c.total}회<span class="pn-muted"> (${nm(c.a)}→${c.ab} · ${nm(c.b)}→${c.ba})</span></span></li>`).join("");
    let selHtml = "";
    if (state.selected && byKid.has(state.selected)) {
      const s = byKid.get(state.selected);
      const out = d.edges.filter((e) => e.from === s.kid).sort((a, b) => b.passes - a.passes).slice(0, 4);
      const inn = d.edges.filter((e) => e.to === s.kid).sort((a, b) => b.passes - a.passes).slice(0, 4);
      const li = (arr, key) => arr.map((e) => `<li>${nm(e[key])} <span class="pn-val">${e.passes}회</span></li>`).join("") || `<li class="pn-muted">없음</li>`;
      selHtml = `<section class="pn-box pn-sel"><h4>선택: ${esc(s.name)} <span class="pn-muted">${esc(POS_KO[s.pos] || "")} · ${s.matches}경기 출전</span></h4>
        <div class="pn-cols"><div><div class="pn-sub">가장 많이 패스한 대상</div><ul class="pn-list">${li(out, "to")}</ul></div>
        <div><div class="pn-sub">가장 많이 받은 상대</div><ul class="pn-list">${li(inn, "from")}</ul></div></div></section>`;
    }
    const un = unplaced.slice(0, 6).map((n) =>
      `<li><b>${esc(n.name)}</b><span class="pn-muted"> ${esc(POS_KO[n.pos] || "")}</span><span class="pn-val">${n.involvement}회</span></li>`).join("");
    const warn = (d.warnings || []).map((w) => `<div>ⓘ ${esc(w)}</div>`).join("");
    return `${selHtml}
      <section class="pn-box"><h4>핵심 요약</h4><ul class="pn-notes">${notes || '<li class="pn-muted">요약할 데이터가 부족합니다.</li>'}</ul></section>
      <section class="pn-box"><h4>패스 허브 TOP 3</h4><ul class="pn-list">${hubs || '<li class="pn-muted">없음</li>'}</ul></section>
      <section class="pn-box"><h4>가장 강한 연결 TOP 5</h4><ul class="pn-list">${links || '<li class="pn-muted">없음</li>'}</ul></section>
      ${un ? `<section class="pn-box"><h4>경기장에 표시되지 않는 선수 <span class="pn-muted">(교체 투입 · 라인업 좌표 없음)</span></h4><ul class="pn-list">${un}</ul></section>` : ""}
      <div class="pn-warn" role="note">${warn}</div>`;
  }

  // ── 이벤트 ────────────────────────────────────────────────────
  root.addEventListener("click", (e) => {
    const mode = e.target.closest("[data-pn-mode]");
    if (mode) {
      const m = mode.dataset.pnMode;
      if (m === state.mode) return;
      state.mode = m;
      if (m === "match") {
        const first = ((state.matches && state.matches.matches) || []).find((x) => x.has_data);
        state.eventId = first ? first.event_id : null;
        if (!state.eventId) { state.mode = "season"; return; }
      }
      load();
      return;
    }
    const node = e.target.closest("[data-pn-node]");
    if (node) { state.selected = state.selected === +node.dataset.pnNode ? null : +node.dataset.pnNode; render(); return; }
    if (e.target.closest("[data-pn-bg]") && state.selected) { state.selected = null; render(); }
  });
  root.addEventListener("keydown", (e) => {
    const node = e.target.closest && e.target.closest("[data-pn-node]");
    if (node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); node.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "pn-th") { state.minCombined = +e.target.value; render(); const s = document.getElementById("pn-th"); if (s) s.focus(); }
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "pn-match") { state.eventId = +e.target.value; load(); }
  });

  // 팀·시즌이 바뀌면(analytics.js) 시즌 누적으로 되돌리고, 탭이 열려 있을 때만 즉시 로드
  document.addEventListener("teamAnalyticsLoaded", (e) => {
    ctx = e.detail; state.mode = "season"; state.eventId = null; state.matches = null; state.dirty = true;
    if (isVisible()) load();
  });
  // 탭 버튼 클릭(analytics.js가 패널을 연 뒤) — 최초 또는 컨텍스트 변경 시 로드
  document.querySelectorAll('.ta-tab-btn[data-tab="pass"]').forEach((b) =>
    b.addEventListener("click", () => setTimeout(() => { ctx = (window.taState && window.taState()) || ctx; if (state.dirty) load(); }, 0)));
})();
