// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/* insights.js — 포지션별 인사이트 섹션 */
(function () {
  "use strict";

  let currentYear = "2026";
  let currentLeague = "all";  // "all" | "k1" | "k2"
  let currentPos = "all";     // "all"(통합) | "F" | "M" | "D" — 통합표 위 포지션 필터 칩
  let topExpanded = false;    // TOP 퍼포머 전체 펼침 여부 (기본은 미리보기)
  const TOP_PREVIEW = 20;     // 기본 노출 행 수 (나머지는 "더 보기")

  // 정렬 상태 — 컬럼이 고정 종합 세트라 단일 상태 (공격기여 우선, 평점 2차)
  const sortState = {
    all: [{ key: "attack_pts", dir: -1 }, { key: "rating", dir: -1 }],
  };

  // 카드 패널 — 표별 정렬 상태 + 컬럼 정의
  const cardSortState = {
    team:   [{ key: "score",  dir: -1 }],
    yellow: [{ key: "yellow", dir: -1 }],
    red:    [{ key: "red",    dir: -1 }],
  };
  const CARD_SORT_COLS = {
    team: [
      { label: "#",        key: null },
      { label: "팀",        key: "team" },
      { label: "경기",      key: "games" },
      { label: "🟨 옐로",   key: "yellow" },
      { label: "🟥 레드",   key: "red" },
      { label: "옐로/경기", key: "yc_per_g" },
      { label: "점수",      key: "score" },
    ],
    yellow: [
      { label: "#",     key: null },
      { label: "선수",   key: "name" },
      { label: "구단",   key: "team" },
      { label: "경기",   key: "games" },
      { label: "🟨",    key: "yellow" },
      { label: "🟥",    key: "red" },
    ],
    red: [
      { label: "#",     key: null },
      { label: "선수",   key: "name" },
      { label: "구단",   key: "team" },
      { label: "🟨",    key: "yellow" },
      { label: "🟥",    key: "red" },
    ],
  };

  // 컬럼 정의 — 포지션 무관 종합 세트. 공격수의 패스%, 미드의 몸싸움(공중볼%)까지 전부 한 표에서.
  //   col 메타: { label, key, suffix?, primary?(굵게), rcls?(평점 색상) }
  //   포지션 칩은 컬럼이 아니라 "행"만 필터한다.
  const LEAD = [
    { label: "#",     key: null },
    { label: "선수",   key: "name" },
    { label: "구단",   key: "team" },
    { label: "포지션", key: "pos" },
    { label: "경기",   key: "games" },
  ];
  const RATING = { label: "평점", key: "rating", rcls: true };
  // 슬림 컬럼 — 핵심 합성지표 위주(공격P·창출P·수비P)로 스캔 가능하게.
  //   raw 세부(xG·슈팅·패스%·키패스·공중볼%·결정력 등)는 행 클릭 → 선수 상세 드로어에서.
  const SORT_COLS = {
    all: [...LEAD,
      { label: "골", key: "goals" },
      { label: "도움", key: "assists" },
      { label: "공격P", key: "attack_pts", primary: true, tip: "공격 기여 = 골 + 도움" },
      { label: "창출P", key: "create_score", tip: "창출 = (키패스 + 도움×2) / 90분" },
      { label: "수비P", key: "def_score", tip: "수비 = (태클 + 인터셉트×1.5 + 클리어 + 슈팅차단 + 볼회수×0.5 − 피드리블) / 90분 — 순수 수비행동" },
      { label: "몸싸움P", key: "duel_score", tip: "몸싸움 = (지상+공중 듀얼 승) / 90분 — 타깃형 공격수·센터백 등 피지컬 지배력" },
      RATING],
  };

  // 부문별 TOP 카드 정의 (각 부문 1위를 박스로) — key로 최댓값 리더 산출
  const CATEGORY_DEFS = [
    { label: "최다 득점",  icon: "🔥", key: "goals",       fmt: v => `${v}골` },
    { label: "최다 도움",  icon: "🤝", key: "assists",     fmt: v => `${v}도움` },
    { label: "결정력",     icon: "🎯", key: "xg_diff",     fmt: v => `${v > 0 ? "+" : ""}${v}` },
    { label: "창출",       icon: "🧠", key: "create_score",fmt: v => `${v}` },
    { label: "수비",       icon: "🛡️", key: "def_score",   fmt: v => `${v}` },
    { label: "몸싸움",     icon: "💪", key: "duel_score",  fmt: v => `${v}` },
    { label: "평점",       icon: "⭐", key: "rating",      fmt: v => `${v}` },
  ];

  // 포지션 배지 표시용
  const POS_BADGE = { F: "공격", M: "미드", D: "수비", G: "GK" };
  // 세부 그룹 → 대분류(배지 색상 정합용)
  const DETAIL_BROAD = { CB:"D", FB:"D", DM:"M", CM:"M", AM:"M", W:"F", ST:"F", GK:"G" };

  // 셀 1개 렌더 (컬럼 메타 기반)
  function renderCell(col, r, rank) {
    if (col.key === null)   return `<td class="ins-rank">${rank}</td>`;
    if (col.key === "name") return `<td class="ins-name">${ttEsc(r.name)}</td>`;
    if (col.key === "team") return `<td class="ins-team">${ttEsc(r.team || "-")}</td>`;
    if (col.key === "pos") {
      // 색상은 detail 기준 대분류로 정합(윙어=공격색 등), 라벨은 세부 우선
      const broad = (r.detail && DETAIL_BROAD[r.detail]) || r.pos;
      const posCls = broad ? `ins-pos-badge ins-pos-${broad}` : "ins-pos-badge";
      const label = r.detail_label || POS_BADGE[r.pos] || "-";
      return `<td><span class="${posCls}">${label}</span></td>`;
    }
    let v = r[col.key];
    if (col.signed && typeof v === "number") {   // 결정력(G−xG) — ± 부호 + 색
      const cls = v > 0 ? "ins-pos" : v < 0 ? "ins-neg" : "";
      return `<td class="${cls}"><strong>${v > 0 ? "+" : ""}${v}</strong></td>`;
    }
    v = (v === null || v === undefined) ? "-" : (col.suffix ? `${v}${col.suffix}` : v);
    if (col.rcls) {
      const rc = r.rating >= 7.5 ? "ins-pos" : r.rating && r.rating < 6.5 ? "ins-neg" : "";
      return `<td class="${rc}">${v}</td>`;
    }
    return col.primary ? `<td><strong>${v}</strong></td>` : `<td>${v}</td>`;
  }

  function shortName(name) {
    if (!name) return "";
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return name;
    return parts[parts.length - 1] + " " + parts[0][0] + ".";
  }

  function destroyChart(c) { if (c) { try { c.destroy(); } catch (_) {} } }

  const CHART_DEFAULTS = {
    plugins: { legend: { labels: { color: "#ccc", font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: "#aaa" }, grid: { color: "rgba(255,255,255,0.07)" } },
      y: { ticks: { color: "#aaa" }, grid: { color: "rgba(255,255,255,0.07)" } },
    },
  };

  /* 블록 표시/숨김 */
  function showBlock(id, hasData) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("hidden", !hasData);
  }

  /* ── 연도 + 리그 필터 ── */
  function initYearFilter() {
    const wrap = document.getElementById("insights-year-filter");
    if (!wrap) return;
    const years = ["2026", "2025", "2024", "all"];
    const leagues = [
      { v: "all", label: "전체" },
      { v: "k1",  label: "K1" },
      { v: "k2",  label: "K2" },
    ];
    wrap.innerHTML =
      `<div class="ld-filter-row">
         <span class="ld-filter-label">리그</span>
         ${leagues.map(l =>
           `<button class="ld-league-btn${l.v === currentLeague ? " active" : ""}" data-league="${l.v}">${l.label}</button>`
         ).join("")}
       </div>
       <div class="ld-filter-row">
         <span class="ld-filter-label">시즌</span>
         ${years.map(y =>
           `<button class="ld-year-btn${y === currentYear ? " active" : ""}" data-year="${y}">${y === "all" ? "전체" : y}</button>`
         ).join("")}
       </div>`;

    wrap.addEventListener("click", e => {
      const yBtn = e.target.closest(".ld-year-btn");
      const lBtn = e.target.closest(".ld-league-btn");
      if (yBtn) {
        currentYear = yBtn.dataset.year;
        wrap.querySelectorAll(".ld-year-btn").forEach(b => b.classList.toggle("active", b === yBtn));
        loadAll();
      } else if (lBtn) {
        currentLeague = lBtn.dataset.league;
        wrap.querySelectorAll(".ld-league-btn").forEach(b => b.classList.toggle("active", b === lBtn));
        loadAll();
      }
    });
  }

  /* ── 포지션 필터 칩 (통합표 위 — 데이터셋 교체가 아닌 행 필터) ── */
  function initPosTab() {
    document.querySelectorAll(".ins-pos-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ins-pos-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentPos = btn.dataset.pos;   // "all" | "F" | "M" | "D"
        topExpanded = false;            // 필터 바꾸면 미리보기로 리셋
        renderTopTable(window._insTopData);
      });
    });
  }

  /* ══════════════════════════════════════════════════
     1. TOP 퍼포머
  ══════════════════════════════════════════════════ */
  function loadTopPerformers() {
    return fetch(`/api/insights/top-performers?year=${currentYear}&league=${currentLeague}`)
      .then(r => r.json())
      .then(data => {
        window._insTopData = data;
        topExpanded = false;   // 새 데이터(연도/리그 변경)면 미리보기로 리셋
        const hasData = (data.all?.length || 0) > 0;
        showBlock("ins-panel-top", hasData);
        if (hasData) renderTopTable(data);
      });
  }

  // 다중 정렬: keys 배열 순서대로 비교
  function sortRows(rows, keys) {
    if (!keys.length) return rows;
    return [...rows].sort((a, b) => {
      for (const { key, dir } of keys) {
        const av = a[key] ?? (typeof a[key] === "string" ? "" : -Infinity);
        const bv = b[key] ?? (typeof b[key] === "string" ? "" : -Infinity);
        let cmp = 0;
        if (typeof av === "string") cmp = av.localeCompare(bv);
        else cmp = av - bv;         // 오름차순 기준 — dir=-1이면 내림차순(▼, 큰 값 위로)
        if (cmp !== 0) return dir * cmp;
      }
      return 0;
    });
  }

  function buildThead(pos) {
    const cols  = SORT_COLS[pos];
    const sorts = sortState[pos];  // [{ key, dir }, ...]
    const ths = cols.map(col => {
      if (!col.key) return `<th>#</th>`;
      const idx = sorts.findIndex(s => s.key === col.key);
      const active = idx !== -1;
      const priority = active && sorts.length > 1 ? `<span class="ins-sort-badge">${idx + 1}</span>` : "";
      const arrow = active ? (sorts[idx].dir === -1 ? "▼" : "▲") : "";
      const hint = !active ? `<span class="ins-sort-hint">↕</span>` : "";
      const tipMark = col.tip ? `<span class="ins-th-tip">ⓘ</span>` : "";
      const tipAttr = col.tip ? ` title="${col.tip}"` : "";
      return `<th class="ins-th-sort${active ? " ins-th-active" : ""}" data-key="${col.key}"${tipAttr}>
        ${col.label}${tipMark}${priority}${active ? ` <span class="ins-sort-arrow">${arrow}</span>` : hint}
      </th>`;
    });
    return `<thead><tr>${ths.join("")}</tr></thead>`;
  }

  // 부문별 TOP 카드 — 현재 필터(리그+포지션 칩)된 집합에서 각 부문 1위를 박스로
  function renderCategoryBoxes(rows) {
    const host = document.getElementById("ins-top-cats");
    if (!host) return;
    host.innerHTML = CATEGORY_DEFS.map(c => {
      let best = null;
      for (const r of rows) {
        const v = r[c.key];
        if (v == null) continue;
        if (!best || v > best.v) best = { v, r };
      }
      if (!best) return "";
      const r = best.r;
      return `<button class="ins-cat-card" data-key="${c.key}" data-pid="${r.player_id}" title="${c.label} 1위 · 클릭하면 이 지표로 정렬">
        <div class="ins-cat-head"><span class="ins-cat-icon">${c.icon}</span><span class="ins-cat-label">${c.label}</span></div>
        <div class="ins-cat-val">${c.fmt(best.v)}</div>
        <div class="ins-cat-leader"><span class="ins-pos-badge ins-pos-${r.pos}">${POS_BADGE[r.pos] || "-"}</span> ${ttEsc(r.name)}</div>
      </button>`;
    }).join("");
    host.querySelectorAll(".ins-cat-card").forEach(btn => {
      btn.addEventListener("click", () => {
        sortState.all = [{ key: btn.dataset.key, dir: -1 }];
        topExpanded = false;
        renderTopTable(window._insTopData);
      });
    });
  }

  function renderTopTable(data) {
    const body = document.getElementById("ins-top-body");
    if (!body || !data) return;
    const base = data.all || [];
    // 포지션 칩은 데이터셋 교체가 아니라 통합표의 행 필터 (정렬 상태 유지)
    // currentPos: "all" | 세부그룹(CB/FB/DM/CM/AM/W/ST) | (구)대분류 F/M/D
    const DETAIL_TOKENS = new Set(["CB","FB","DM","CM","AM","W","ST"]);
    const raw = currentPos === "all" ? base
              : DETAIL_TOKENS.has(currentPos) ? base.filter(r => r.detail === currentPos)
              : base.filter(r => r.pos === currentPos);
    renderCategoryBoxes(raw);   // 부문 카드도 같은 필터 집합 기준
    if (!raw.length) { body.innerHTML = '<p class="ins-empty">데이터 없음</p>'; return; }

    const cols = SORT_COLS.all;          // 종합 컬럼 고정 — 칩은 행만 필터
    const rows = sortRows(raw, sortState.all);
    const total = rows.length;
    const shown = topExpanded ? rows : rows.slice(0, TOP_PREVIEW);

    const tbody = shown.map((r, i) =>
      `<tr>${cols.map(c => renderCell(c, r, i + 1)).join("")}</tr>`
    ).join("");

    const moreBtn = total > TOP_PREVIEW
      ? `<button class="ins-top-more" type="button">${topExpanded ? "접기 ▲" : `더 보기 (전체 ${total}명) ▼`}</button>`
      : "";

    // 리그 평균(현재 표 필터 기준) — 합성지표를 상대적으로 판단할 기준선
    const avg = (k) => {
      const v = raw.map(r => r[k]).filter(x => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    };
    const aAtk = avg("attack_pts").toFixed(1), aCre = avg("create_score").toFixed(1), aDef = avg("def_score").toFixed(1), aDuel = avg("duel_score").toFixed(1);
    const fRow = (name, formula, avgv) =>
      `<li><span class="ins-fm-name">${name}</span><span class="ins-fm-eq">${formula}</span><span class="ins-formula-avg">평균 ${avgv}</span></li>`;
    const formulaNote =
      `<div class="ins-formula">
         <div class="ins-formula-head">📐 합성 지수 <span class="ins-formula-tag">90분 환산 · 상대 비교용</span></div>
         <ul class="ins-formula-list">
           ${fRow("공격P", "골 + 도움", aAtk)}
           ${fRow("창출P", "(키패스 + 도움×2) ÷ 90분", aCre)}
           ${fRow("수비P", "(태클 + 인터셉트×1.5 + 클리어 + 슈팅차단 + 볼회수×0.5 − 피드리블) ÷ 90분", aDef)}
           ${fRow("몸싸움P", "(지상+공중 듀얼 승) ÷ 90분", aDuel)}
         </ul>
         <div class="ins-formula-sub">표본 5경기·450분↑(per-90 안정화) · 평균은 현재 표(리그·포지션) 기준 · 선수 행 클릭 시 xG·패스% 등 원자료</div>
       </div>`;
    body.innerHTML =
      `${formulaNote}<div class="ins-top-scroll"><table class="ins-table">${buildThead("all")}<tbody>${tbody}</tbody></table></div>${moreBtn}`;

    // 헤더 클릭 → 다중 정렬 (첫 클릭: 추가/내림 → 재클릭: 오름 → 한번 더: 제거)
    body.querySelectorAll(".ins-th-sort").forEach(th => {
      th.addEventListener("click", () => {
        const key  = th.dataset.key;
        const sorts = sortState.all;
        const idx  = sorts.findIndex(s => s.key === key);
        if (idx === -1)               sorts.push({ key, dir: -1 });
        else if (sorts[idx].dir === -1) sorts[idx].dir = 1;
        else                          sorts.splice(idx, 1);
        renderTopTable(window._insTopData);
      });
    });

    // 더 보기 / 접기 토글
    body.querySelector(".ins-top-more")?.addEventListener("click", () => {
      topExpanded = !topExpanded;
      renderTopTable(window._insTopData);
    });

    // 행 클릭 → 드로어 열기 (선수 실제 포지션으로 상세 차트 정확도 유지)
    body.querySelectorAll("tbody tr").forEach((tr, i) => {
      const r = shown[i];
      tr.classList.add("ins-row-clickable");
      tr.addEventListener("click", () => openDrawer(r.player_id, r.pos || "F"));
    });
  }


  /* ══════════════════════════════════════════════════
     선수 상세 드로어
  ══════════════════════════════════════════════════ */
  let drawerRatingChart = null, drawerStatChart = null;
  let currentDrawerPlayerId = null;
  let currentDrawerPos = "F";
  let currentDrawerYear = "2026";

  function openDrawer(playerId, pos) {
    currentDrawerPlayerId = playerId;
    currentDrawerPos = pos;
    currentDrawerYear = "2026";
    loadDrawerData();
    document.getElementById("player-drawer").classList.add("open");
    document.getElementById("player-drawer-overlay").classList.add("open");
  }

  function loadDrawerData() {
    if (!currentDrawerPlayerId) return;
    fetch(`/api/insights/player-detail?playerId=${currentDrawerPlayerId}&pos=${currentDrawerPos}&year=${currentDrawerYear}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) return;
        renderDrawer(data);
      });
  }

  function closeDrawer() {
    document.getElementById("player-drawer").classList.remove("open");
    document.getElementById("player-drawer-overlay").classList.remove("open");
    destroyChart(drawerRatingChart); drawerRatingChart = null;
    destroyChart(drawerStatChart);   drawerStatChart = null;
    currentDrawerPlayerId = null;
  }

  // ── 시즌 필터 버튼
  function renderDrawerYearFilter(seasons) {
    const wrap = document.getElementById("drawer-year-filter");
    if (!wrap) return;
    // 항상 보이는 옵션: 활동 시즌 + "전체"
    const options = [...seasons, "all"];
    wrap.innerHTML = options.map(y => {
      const isAll = y === "all";
      const active = String(y) === String(currentDrawerYear);
      return `<button class="drawer-year-btn${active ? " active" : ""}" data-year="${y}">${isAll ? "전체" : y}</button>`;
    }).join("");
    wrap.querySelectorAll(".drawer-year-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.year === currentDrawerYear) return;
        currentDrawerYear = btn.dataset.year;
        loadDrawerData();
      });
    });
  }

  // ── 요약 KPI 카드 (시즌 누적/평균)
  function renderDrawerSummary(data) {
    const wrap = document.getElementById("drawer-summary");
    if (!wrap) return;
    const s = data.own_summary || {};
    const pos = data.pos;
    const rating = s.avg_rating ?? "-";
    const ratingCls = s.avg_rating >= 7.5 ? "kpi-pos" : s.avg_rating && s.avg_rating < 6.5 ? "kpi-neg" : "";
    const items = [
      { label: "경기", val: s.games ?? 0 },
      { label: "출전(분)", val: (s.mins || 0).toLocaleString() },
      { label: "평균 평점", val: rating, cls: ratingCls },
    ];
    if (pos === "F") {
      items.push({ label: "골", val: s.goals ?? 0, cls: "kpi-accent-g" });
      items.push({ label: "xG", val: s.xg ?? 0 });
      items.push({ label: "도움", val: s.assists ?? 0 });
    } else if (pos === "M") {
      items.push({ label: "패스성공률", val: s.pass_acc != null ? s.pass_acc + "%" : "-" });
      items.push({ label: "키패스", val: s.key_passes ?? 0, cls: "kpi-accent-b" });
      items.push({ label: "태클", val: s.tackles ?? 0 });
    } else if (pos === "D") {
      items.push({ label: "태클", val: s.tackles ?? 0, cls: "kpi-accent-p" });
      items.push({ label: "키패스", val: s.key_passes ?? 0 });
      items.push({ label: "도움", val: s.assists ?? 0 });
    }
    wrap.innerHTML = items.map(it => `
      <div class="kpi-cell">
        <div class="kpi-val ${it.cls || ''}">${it.val}</div>
        <div class="kpi-lbl">${it.label}</div>
      </div>`).join("");
  }

  // 막대 차트 위에 데이터 값 표시하는 plugin
  const barValuePlugin = {
    id: "barValueLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      chart.data.datasets.forEach((ds, dsIdx) => {
        if (ds.type !== "bar") return;
        const meta = chart.getDatasetMeta(dsIdx);
        if (meta.hidden) return;
        meta.data.forEach((bar, i) => {
          const v = ds.data[i];
          if (v == null || v === 0) return;
          ctx.save();
          ctx.fillStyle = "#e8f0ff";
          ctx.font = "600 10px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : v,
                       bar.x, bar.y - 4);
          ctx.restore();
        });
      });
    },
  };

  function renderDrawer(data) {
    document.getElementById("drawer-name").textContent = data.name;
    const yearLabel = data.year && data.year !== "all" ? `${data.year}` : "전체";
    document.getElementById("drawer-sub").textContent =
      `${data.team || "-"}  ·  ${{ F:"공격수", M:"미드필더", D:"수비수", G:"골키퍼" }[data.pos] || data.pos}  ·  ${yearLabel} ${data.matches.length}경기`;

    // 시즌 필터 버튼 렌더 (선수가 활동한 시즌 + "전체")
    renderDrawerYearFilter(data.seasons || []);

    // 요약 KPI 카드
    renderDrawerSummary(data);

    const matches = [...data.matches].reverse(); // 날짜 오름차순
    // 차트 X축은 "MM-DD" (시각 제거 — 가독성), 테이블은 "YYYY-MM-DD" (사용자 요청)
    const labels  = matches.map(m => m.date ? m.date.slice(5, 10) : "");
    const posAvg  = data.pos_avg;

    if (!matches.length) {
      // 데이터 없을 때 차트 정리
      destroyChart(drawerRatingChart); drawerRatingChart = null;
      destroyChart(drawerStatChart);   drawerStatChart = null;
      const ctxR = document.getElementById("drawer-chart-rating");
      const ctxS = document.getElementById("drawer-chart-stat");
      if (ctxR) ctxR.getContext("2d").clearRect(0,0,ctxR.width,ctxR.height);
      if (ctxS) ctxS.getContext("2d").clearRect(0,0,ctxS.width,ctxS.height);
      const wrap = document.getElementById("drawer-match-table");
      if (wrap) wrap.innerHTML = '<p class="ins-empty">해당 시즌 데이터 없음</p>';
      return;
    }

    // ── 평점 차트
    destroyChart(drawerRatingChart);
    const ctxR = document.getElementById("drawer-chart-rating");
    if (ctxR) {
      const ratings = matches.map(m => m.rating);
      // 본인 평균
      const validRatings = ratings.filter(v => v != null);
      const ownAvg = validRatings.length
        ? +(validRatings.reduce((a,b) => a+b, 0) / validRatings.length).toFixed(2)
        : null;

      drawerRatingChart = new Chart(ctxR, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "경기 평점", data: ratings,
              borderColor: "rgba(100,200,255,0.95)",
              backgroundColor: "rgba(100,200,255,0.15)",
              borderWidth: 2.5, pointRadius: 5, pointHoverRadius: 9,
              pointBorderColor: "#0e1a2e", pointBorderWidth: 1.5,
              pointBackgroundColor: ratings.map(v =>
                v == null ? "transparent" : v >= 7.5 ? "#4ade80" : v >= 6.5 ? "#facc15" : "#f87171"),
              spanGaps: true, tension: 0.35, fill: true,
              order: 0,
            },
            ownAvg ? {
              label: `본인 평균 (${ownAvg})`,
              data: matches.map(() => ownAvg),
              borderColor: "rgba(100,200,255,0.7)", borderWidth: 2,
              borderDash: [8, 4], pointRadius: 0, fill: false, order: 1,
            } : null,
            posAvg.rating ? {
              label: `포지션 평균 (${posAvg.rating})`,
              data: matches.map(() => posAvg.rating),
              borderColor: "rgba(255,180,60,0.8)", borderWidth: 2,
              borderDash: [6, 5], pointRadius: 0, fill: false, order: 2,
            } : null,
            // 임계선 6.5 (위험)
            {
              label: "6.5 (저조)",
              data: matches.map(() => 6.5),
              borderColor: "rgba(248,113,113,0.3)", borderWidth: 1,
              borderDash: [3, 3], pointRadius: 0, fill: false, order: 3,
            },
            // 임계선 7.5 (우수)
            {
              label: "7.5 (우수)",
              data: matches.map(() => 7.5),
              borderColor: "rgba(74,222,128,0.3)", borderWidth: 1,
              borderDash: [3, 3], pointRadius: 0, fill: false, order: 3,
            },
          ].filter(Boolean),
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: {
              labels: { color: "#d8e4f0", font: { size: 11, weight: "500" }, padding: 12, boxWidth: 18 },
              position: "top", align: "end",
            },
            tooltip: {
              backgroundColor: "rgba(15, 25, 45, 0.95)",
              borderColor: "rgba(100,200,255,0.3)", borderWidth: 1,
              titleColor: "#fff", bodyColor: "#d8e4f0",
              titleFont: { size: 12, weight: "600" }, bodyFont: { size: 11 },
              padding: 10, cornerRadius: 6,
              callbacks: {
                title: (items) => {
                  const i = items[0].dataIndex;
                  const m = matches[i];
                  return `${m.date || ""} · ${m.is_home ? "홈" : "원정"} ${m.opponent || ""}`;
                },
                afterTitle: (items) => {
                  const m = matches[items[0].dataIndex];
                  return `${m.score || "-"}  ·  ${m.mins ?? "-"}분`;
                },
              },
            },
          },
          scales: {
            x: { ticks: { color: "#a8b8cc", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.06)" } },
            y: {
              min: 5, max: 10,
              ticks: { color: "#a8b8cc", font: { size: 11 }, stepSize: 1 },
              grid: { color: "rgba(255,255,255,0.10)" },
            },
          },
        },
      });
    }

    // ── 포지션별 핵심 스탯 차트
    destroyChart(drawerStatChart);
    const ctxS = document.getElementById("drawer-chart-stat");
    const statTitle = document.getElementById("drawer-stat-title");
    if (ctxS) {
      let statDatasets = [];
      let statLabel = "";

      if (data.pos === "F") {
        statLabel = "⚽ 경기별 득점 / xG";
        statTitle.textContent = statLabel;
        statDatasets = [
          {
            label: "득점", data: matches.map(m => m.goals),
            backgroundColor: "rgba(74,222,128,0.85)",
            borderColor: "rgba(74,222,128,1)", borderWidth: 1.5,
            borderRadius: 3, type: "bar",
          },
          {
            label: "xG",  data: matches.map(m => m.xg),
            backgroundColor: "rgba(255,200,60,0.55)",
            borderColor: "rgba(255,200,60,0.9)", borderWidth: 1.5,
            borderRadius: 3, type: "bar",
          },
        ];
      } else if (data.pos === "M") {
        statLabel = "🎯 경기별 패스 성공률 / 키패스";
        statTitle.textContent = statLabel;
        statDatasets = [
          {
            label: "패스성공률(%)", data: matches.map(m => m.pass_acc),
            borderColor: "rgba(100,180,255,0.95)",
            backgroundColor: "rgba(100,180,255,0.12)",
            borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 7,
            pointBackgroundColor: "rgba(100,180,255,1)",
            type: "line", yAxisID: "yAcc", spanGaps: true, tension: 0.3, fill: true,
          },
          {
            label: "키패스", data: matches.map(m => m.key_passes),
            backgroundColor: "rgba(255,160,60,0.75)",
            borderColor: "rgba(255,160,60,1)", borderWidth: 1.5,
            borderRadius: 3, type: "bar", yAxisID: "yKP",
          },
        ];
      } else if (data.pos === "D") {
        statLabel = "🛡 경기별 수비 점수";
        statTitle.textContent = statLabel;
        statDatasets = [
          {
            label: "수비점수/90", data: matches.map(m => m.def_score),
            borderColor: "rgba(160,120,255,0.95)",
            backgroundColor: "rgba(160,120,255,0.18)",
            borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 7,
            pointBackgroundColor: "rgba(160,120,255,1)",
            type: "line", tension: 0.3, fill: true,
          },
          {
            label: "태클", data: matches.map(m => m.tackles),
            backgroundColor: "rgba(100,160,255,0.7)",
            borderColor: "rgba(100,160,255,1)", borderWidth: 1.5,
            borderRadius: 3, type: "bar",
          },
        ];
      }

      const extraScales = data.pos === "M" ? {
        yAcc: {
          position: "left", min: 0, max: 100,
          title: { display: true, text: "패스성공률 (%)", color: "#a8b8cc", font: { size: 10 } },
          ticks: { color: "#a8b8cc", font: { size: 11 } },
          grid: { color: "rgba(255,255,255,0.10)" },
        },
        yKP: {
          position: "right", min: 0,
          title: { display: true, text: "키패스", color: "#a8b8cc", font: { size: 10 } },
          ticks: { color: "#a8b8cc", font: { size: 11 } },
          grid: { display: false },
        },
      } : {};

      drawerStatChart = new Chart(ctxS, {
        data: { labels, datasets: statDatasets },
        plugins: [barValuePlugin],
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          layout: { padding: { top: 16 } },
          plugins: {
            legend: {
              labels: { color: "#d8e4f0", font: { size: 11, weight: "500" }, padding: 12, boxWidth: 18 },
              position: "top", align: "end",
            },
            tooltip: {
              backgroundColor: "rgba(15, 25, 45, 0.95)",
              borderColor: "rgba(100,200,255,0.3)", borderWidth: 1,
              titleColor: "#fff", bodyColor: "#d8e4f0",
              titleFont: { size: 12, weight: "600" }, bodyFont: { size: 11 },
              padding: 10, cornerRadius: 6,
              callbacks: {
                title: (items) => {
                  const i = items[0].dataIndex;
                  const m = matches[i];
                  return `${m.date || ""} · ${m.is_home ? "홈" : "원정"} ${m.opponent || ""}`;
                },
              },
            },
          },
          scales: data.pos === "M" ? {
            x: { ticks: { color: "#a8b8cc", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.06)" } },
            ...extraScales,
          } : {
            x: { ticks: { color: "#a8b8cc", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.06)" } },
            y: { min: 0, ticks: { color: "#a8b8cc", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.10)" } },
          },
        },
      });
    }

    // ── 최근 경기 테이블
    const wrap = document.getElementById("drawer-match-table");
    if (wrap) {
      const recent = data.matches.slice(0, 15);
      let html = `<table class="ins-table" style="font-size:0.8rem">
        <thead><tr><th>날짜</th><th>상대</th><th>결과</th><th>출전</th><th>평점</th>`;
      if (data.pos === "F") html += `<th>골</th><th>xG</th><th>도움</th>`;
      if (data.pos === "M") html += `<th>패스%</th><th>키패스</th><th>태클</th>`;
      if (data.pos === "D") html += `<th>태클</th><th>수비점수</th>`;
      html += `</tr></thead><tbody>`;
      recent.forEach(m => {
        const rCls = m.rating >= 7.5 ? "ins-pos" : m.rating && m.rating < 6.5 ? "ins-neg" : "";
        html += `<tr>
          <td style="white-space:nowrap">${m.date ? m.date.slice(0, 10) : "-"}</td>
          <td class="ins-team">${ttEsc(m.opponent)}</td>
          <td>${m.score}</td>
          <td>${m.mins}'</td>
          <td class="${rCls}">${m.rating ?? "-"}</td>`;
        if (data.pos === "F") html += `<td>${m.goals}</td><td>${m.xg}</td><td>${m.assists}</td>`;
        if (data.pos === "M") html += `<td>${m.pass_acc != null ? m.pass_acc + "%" : "-"}</td><td>${m.key_passes}</td><td>${m.tackles}</td>`;
        if (data.pos === "D") html += `<td>${m.tackles}</td><td>${m.def_score}</td>`;
        html += `</tr>`;
      });
      html += "</tbody></table>";
      wrap.innerHTML = html;
    }
  }

  /* ── 카드 수령 순위 ── */
  let currentCardMode = "player";    // "player" | "team"
  let _cardCache = null;

  function initCardModeTab() {
    document.querySelectorAll(".ins-card-mode-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ins-card-mode-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentCardMode = btn.dataset.mode;
        renderCardBody(_cardCache);
      });
    });
  }

  function loadCardRankings() {
    return fetch(`/api/insights/card-rankings?year=${currentYear}&league=${currentLeague}`)
      .then(r => r.json())
      .then(d => {
        _cardCache = d;
        const has = (d.yellow_top?.length || d.red_top?.length || d.team_top?.length) > 0;
        showBlock("ins-panel-cards", has);
        if (has) renderCardBody(d);
      });
  }

  // 정렬 가능한 thead — cols + sorts 인자로 generic
  function buildSortableThead(cols, sorts) {
    const ths = cols.map(col => {
      if (!col.key) return `<th>#</th>`;
      const idx = sorts.findIndex(s => s.key === col.key);
      const active = idx !== -1;
      const priority = active && sorts.length > 1 ? `<span class="ins-sort-badge">${idx + 1}</span>` : "";
      const arrow = active ? (sorts[idx].dir === -1 ? "▼" : "▲") : "";
      const hint = !active ? `<span class="ins-sort-hint">↕</span>` : "";
      const tipMark = col.tip ? `<span class="ins-th-tip">ⓘ</span>` : "";
      const tipAttr = col.tip ? ` title="${col.tip}"` : "";
      return `<th class="ins-th-sort${active ? " ins-th-active" : ""}" data-key="${col.key}"${tipAttr}>
        ${col.label}${tipMark}${priority}${active ? ` <span class="ins-sort-arrow">${arrow}</span>` : hint}
      </th>`;
    });
    return `<thead><tr>${ths.join("")}</tr></thead>`;
  }

  // 카드 표 헤더 클릭 핸들러 (다중 정렬 — 추가→오름→제거)
  function bindCardSort(tableEl, sortKey) {
    tableEl.querySelectorAll(".ins-th-sort").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        const sorts = cardSortState[sortKey];
        const idx = sorts.findIndex(s => s.key === key);
        if (idx === -1) sorts.push({ key, dir: -1 });
        else if (sorts[idx].dir === -1) sorts[idx].dir = 1;
        else sorts.splice(idx, 1);
        renderCardBody(_cardCache);
      });
    });
  }

  function renderCardBody(d) {
    const wrap = document.getElementById("ins-card-body");
    if (!wrap || !d) return;

    if (currentCardMode === "team") {
      const teams = d.team_top || [];
      if (!teams.length) { wrap.innerHTML = '<p class="ins-empty">팀별 데이터 없음</p>'; return; }
      const sorted = sortRows(teams, cardSortState.team);
      const tbody = sorted.map((r, i) => `
        <tr>
          <td class="ins-rank">${i+1}</td>
          <td class="ins-name">${ttEsc(r.team)}</td>
          <td>${r.games}</td>
          <td><strong>${r.yellow}</strong></td>
          <td class="${r.red > 0 ? 'ins-neg' : ''}">${r.red}</td>
          <td>${r.yc_per_g}</td>
          <td><strong>${r.score}</strong></td>
        </tr>`).join("");
      wrap.innerHTML = `
        <table class="ins-table ins-card-table">
          ${buildSortableThead(CARD_SORT_COLS.team, cardSortState.team)}
          <tbody>${tbody}</tbody>
        </table>
        <div class="ins-card-foot">점수 = 옐로 + 레드×2 / 경기수. 카드 빈도 종합 지표. 헤더 클릭으로 정렬.</div>
      `;
      bindCardSort(wrap.querySelector("table"), "team");
      return;
    }

    // 선수별 — 옐로 + 레드 두 표
    const yel = d.yellow_top || [];
    const red = d.red_top || [];
    const yelSorted = sortRows(yel, cardSortState.yellow);
    const redSorted = sortRows(red, cardSortState.red);

    const yelHtml = yel.length ? `
      <div class="ins-card-half">
        <div class="ins-card-subtitle">🟨 옐로카드 TOP ${yel.length}</div>
        <table class="ins-table ins-card-table" data-sort-key="yellow">
          ${buildSortableThead(CARD_SORT_COLS.yellow, cardSortState.yellow)}
          <tbody>${yelSorted.map((r, i) => `
            <tr>
              <td class="ins-rank">${i+1}</td>
              <td class="ins-name">${ttEsc(r.name)}</td>
              <td class="ins-team">${ttEsc(r.team || "-")}</td>
              <td>${r.games}</td>
              <td><strong>${r.yellow}</strong></td>
              <td class="${r.red > 0 ? 'ins-neg' : ''}">${r.red}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>` : "";
    const redHtml = red.length ? `
      <div class="ins-card-half">
        <div class="ins-card-subtitle">🟥 레드카드 TOP ${red.length}</div>
        <table class="ins-table ins-card-table" data-sort-key="red">
          ${buildSortableThead(CARD_SORT_COLS.red, cardSortState.red)}
          <tbody>${redSorted.map((r, i) => `
            <tr>
              <td class="ins-rank">${i+1}</td>
              <td class="ins-name">${ttEsc(r.name)}</td>
              <td class="ins-team">${ttEsc(r.team || "-")}</td>
              <td>${r.yellow}</td>
              <td class="ins-neg"><strong>${r.red}</strong></td>
            </tr>`).join("")}</tbody>
        </table>
      </div>` : '<div class="ins-card-half"><div class="ins-empty">레드카드 0건</div></div>';
    wrap.innerHTML = `<div class="ins-card-grid">${yelHtml}${redHtml}</div>`;
    wrap.querySelectorAll("table[data-sort-key]").forEach(tbl => {
      bindCardSort(tbl, tbl.dataset.sortKey);
    });
  }

  /* ══════════════════════════════════════════════════
     심화 인사이트 — 승부처 · 슈팅 · 교체 · 수문장 · 듀얼
  ══════════════════════════════════════════════════ */
  function renderClutch(d) {
    const el = document.getElementById("ins-clutch-body"); if (!el) return;
    const dec = (d.decisive_top || []).slice(0, 5).map((p, i) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${escI(p.name)}</span><span class="ins-adv-sub">${escI(p.team)} · 결승 ${p.gwg}·동점 ${p.eq}</span><b>${p.total}</b></li>`).join("");
    const tl = d.timeline || [];
    const total = tl.reduce((s, t) => s + t.goals, 0) || 1;
    const max = Math.max(...tl.map(t => t.goals), 1);
    const peakIdx = tl.reduce((mi, t, i, a) => (t.goals > a[mi].goals ? i : mi), 0);
    const firstHalf = tl.filter(t => ["0-15", "15-30", "30-45"].includes(t.bucket)).reduce((s, t) => s + t.goals, 0);
    const secondHalf = total - firstHalf;
    const peak = tl[peakIdx];
    const bars = tl.map((t, i) => {
      const h = Math.round(t.goals / max * 100);
      const share = Math.round(t.goals / total * 100);
      const peakCls = i === peakIdx ? " ins-tl-peak" : "";
      return `<div class="ins-tl-col${peakCls}" title="${t.bucket}분 · ${t.goals}골 (${share}%)">
        <span class="ins-tl-val">${t.goals}</span>
        <div class="ins-tl-track"><div class="ins-tl-bar" style="height:${h}%"></div></div>
        <span class="ins-tl-lbl">${t.bucket}<span class="ins-tl-share">${share}%</span></span>
      </div>`;
    }).join("");
    el.innerHTML =
      `<div class="ins-adv-sub-h">🎯 결정적 골 해결사 <span class="ins-clutch-hint">결승골+동점골</span></div>
       <ol class="ins-adv-list">${dec || '<li class="ins-adv-empty">데이터 없음</li>'}</ol>
       <div class="ins-adv-sub-h">⏱ 시간대별 리그 득점 <span class="ins-tl-total">총 ${total}골</span></div>
       <div class="ins-tl">${bars}</div>
       <div class="ins-tl-summary"><span class="ins-tl-sg">🕐 전반 <b>${firstHalf}</b></span><span class="ins-tl-sg">🕝 후반 <b>${secondHalf}</b></span><span class="ins-tl-sg ins-tl-sg-peak">🔥 최다 <b>${peak ? peak.bucket : "-"}분</b> (${peak ? peak.goals : 0}골)</span></div>
       <div class="ins-method">근거 — 결승골=승자가 패자 최종+1 득점에 도달한 골 · 동점골=뒤지다 동점 만든 골 · 시간대=리그 전체 득점 분포</div>`;
  }
  function renderShooting(d) {
    const el = document.getElementById("ins-shooting-body"); if (!el) return;
    const f = d.funnel || {};
    if (!f.shots) { el.innerHTML = '<div class="ins-adv-empty">데이터 없음</div>'; return; }

    // 깔때기 — 시도 대비 비율로 줄어드는 가로 막대 3단 (시도=100%)
    const pctOf = v => f.shots ? Math.round(v / f.shots * 100) : 0;
    const frow = (lbl, val, w, tag, cls) =>
      `<div class="ins-fn-row"><span class="ins-fn-lbl">${lbl}</span>
        <div class="ins-fn-track"><div class="ins-fn-bar ${cls}" style="width:${w}%"></div></div>
        <span class="ins-fn-val">${val.toLocaleString()}${tag ? `<small>${tag}</small>` : ""}</span></div>`;
    const funnel = `<div class="ins-fn">
      ${frow("슛 시도", f.shots, 100, "", "b1")}
      ${frow("유효슛", f.on_target, pctOf(f.on_target), `${f.on_target_pct}%`, "b2")}
      ${frow("득점", f.goals, pctOf(f.goals), `${f.conversion_pct}%`, "b3")}</div>`;

    // 결정률 막대 — 세 항목 공통 스케일(전역 최대)로 비교 가능
    const all = [...(d.situation || []), ...(d.body_part || []), ...(d.zone || [])];
    const gmax = Math.max(...all.map(x => x.conversion_pct), 1);
    const block = (title, arr) => {
      const rows = arr.map(x =>
        `<div class="ins-cv-row">
          <span class="ins-cv-lbl">${x.label}</span>
          <div class="ins-cv-track"><div class="ins-cv-bar" style="width:${Math.round(x.conversion_pct / gmax * 100)}%"></div></div>
          <span class="ins-cv-pct">${x.conversion_pct}%</span>
          <span class="ins-cv-sub">${x.goals}골 / ${x.shots.toLocaleString()}슛</span>
        </div>`).join("");
      return `<div class="ins-adv-sub-h">${title}</div><div class="ins-cv">${rows}</div>`;
    };

    el.innerHTML =
      `<div class="ins-adv-sub-h">슛 → 득점 전환</div>` + funnel
      + block("⚙️ 상황별 결정률", d.situation || [])
      + block("🦶 부위별 결정률", d.body_part || [])
      + block("📍 거리존별 결정률", d.zone || [])
      + `<div class="ins-method">근거 — 슈팅맵 ${f.shots.toLocaleString()}개 · 유효슛=득점+선방 유발 · 결정률=골/슛 · 막대=세 항목 공통 스케일</div>`;
  }
  function renderSubstitution(d) {
    const el = document.getElementById("ins-sub-body"); if (!el) return;
    const ss = (d.supersub || []).slice(0, 5).map((p, i) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${escI(p.name)}</span><span class="ins-adv-sub">${escI(p.team)}</span><b>${p.goals}골</b></li>`).join("");
    const fq = (d.frequent || []).slice(0, 5).map((p, i) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${escI(p.name)}</span><span class="ins-adv-sub">${escI(p.team)}</span><b>${p.count}회</b></li>`).join("");
    const tl = d.timeline || [];
    const max = Math.max(...tl.map(t => t.count), 1);
    const total = tl.reduce((s, t) => s + t.count, 0) || 1;
    const bars = tl.map(t => {
      const h = Math.round(t.count / max * 100);
      const share = Math.round(t.count / total * 100);
      return `<div class="ins-tl-col" title="${t.bucket}분 · ${t.count}회 (${share}%)">
        <span class="ins-tl-val">${t.count}</span>
        <div class="ins-tl-track"><div class="ins-tl-bar" style="height:${h}%"></div></div>
        <span class="ins-tl-lbl">${t.bucket}<span class="ins-tl-share">${share}%</span></span></div>`;
    }).join("");
    el.innerHTML =
      `<div class="ins-adv-sub-h">🃏 슈퍼서브 <span class="ins-clutch-hint">교체 투입 후 득점</span></div>
       <ol class="ins-adv-list">${ss || '<li class="ins-adv-empty">데이터 없음</li>'}</ol>
       <div class="ins-adv-sub-h">⏱ 교체 시점 분포 ${d.avg_first ? `<span class="ins-tl-total">평균 첫 교체 ${d.avg_first}분</span>` : ""}</div>
       <div class="ins-tl">${bars}</div>
       <div class="ins-adv-sub-h">🔁 최다 교체 투입</div>
       <ol class="ins-adv-list">${fq || '<li class="ins-adv-empty">데이터 없음</li>'}</ol>
       <div class="ins-method">근거 — 슈퍼서브=교체 투입 분 이후 본인 득점 · 시점=리그 전체 교체 분포 · 부상 교체 ${d.injury_subs || 0}건</div>`;
  }
  function renderGoalkeeper(d) {
    const el = document.getElementById("ins-gk-body"); if (!el) return;
    const row = (p, i, metric, sub) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${ttEsc(p.name)}</span><span class="ins-adv-sub">${ttEsc(p.team)}${sub ? " · " + sub : ""}</span><b>${metric}</b></li>`;
    const sv = (d.saves_top || []).slice(0, 5).map((p, i) => row(p, i, `${p.saves}선방`, `${p.games}경기·CS${p.clean_sheets}`)).join("");
    const cs = (d.clean_sheets_top || []).slice(0, 5).map((p, i) => row(p, i, `CS ${p.clean_sheets}`, `${p.games}경기`)).join("");
    const pct = (d.save_pct_top || []).slice(0, 5).map((p, i) => row(p, i, `${p.save_pct}%`, `선방${p.saves}/실점${p.conceded}`)).join("");
    const empty = '<li class="ins-adv-empty">데이터 없음</li>';
    el.innerHTML =
      `<div class="ins-adv-sub-h">🧤 선방 TOP</div><ol class="ins-adv-list">${sv || empty}</ol>
       <div class="ins-adv-sub-h">🛡 클린시트 TOP</div><ol class="ins-adv-list">${cs || empty}</ol>
       <div class="ins-adv-sub-h">🎯 선방률 TOP <span class="ins-clutch-hint">10경기+</span></div><ol class="ins-adv-list">${pct || empty}</ol>
       <div class="ins-method">근거 — 선방=세이브 합 · 실점=경기 최종 스코어(상대 득점) · CS=무실점 경기 · 선방률=선방/(선방+실점) · 주전(60분+) 5경기↑</div>`;
  }
  function renderDuels(d) {
    const el = document.getElementById("ins-duel-body"); if (!el) return;
    const row = (p, i, metric, sub) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${ttEsc(p.name)}</span><span class="ins-adv-sub">${ttEsc(p.team)}${sub ? " · " + sub : ""}</span><b>${metric}</b></li>`;
    const empty = '<li class="ins-adv-empty">데이터 없음</li>';
    const dr = (d.dribble_top || []).slice(0, 5).map((p, i) => row(p, i, `${p.success}회`, `성공률 ${p.rate}%`)).join("");
    const ae = (d.aerial_top || []).slice(0, 5).map((p, i) => row(p, i, `${p.won}승`, `승률 ${p.rate}%`)).join("");
    el.innerHTML =
      `<div class="ins-adv-sub-h">🏃 돌파 (드리블 성공) <span class="ins-clutch-hint">시도 20+</span></div><ol class="ins-adv-list">${dr || empty}</ol>
       <div class="ins-adv-sub-h">🛫 공중 지배 <span class="ins-clutch-hint">공중볼 30+</span></div><ol class="ins-adv-list">${ae || empty}</ol>
       <div class="ins-method">근거 — 돌파=드리블 성공 합 · 공중=공중볼 경합 승 · 성공률/승률 병기 · 최소 표본 필터(드리블 20·공중 30)</div>`;
  }
  // xG 운 보정 순위 — 리그 필터 'all'이면 K1·K2를 차례로 표시
  function renderXgLuck(list) {
    const el = document.getElementById("ins-xgluck-body"); if (!el) return;
    const LUCK = { lucky: ["🍀 행운", "ins-xl-lucky"], unlucky: ["🌧 불운", "ins-xl-unlucky"], fair: ["= 부합", "ins-xl-fair"] };
    const gapTxt = g => g > 0 ? `<span class="ins-xl-up">▲${g}</span>` : g < 0 ? `<span class="ins-xl-down">▼${-g}</span>` : `<span class="ins-xl-flat">–</span>`;
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const rows = d.teams.map(t => {
        if (!t.eligible) {
          return `<tr class="ins-xl-skip"><td>${t.rank_actual}</td><td class="ins-xl-team">${ttEsc(t.short)}</td><td>${t.pts}</td><td colspan="4" class="ins-adv-empty">xG 표본 부족 (${t.xg_games}/${d.min_games}경기)</td></tr>`;
        }
        const [lbl, cls] = LUCK[t.luck];
        return `<tr><td>${t.rank_actual}</td><td class="ins-xl-team">${ttEsc(t.short)}</td><td>${t.pts}</td>
          <td>${t.rank_xg}</td><td title="xG 기준 순위가 실제보다 ${t.rank_gap > 0 ? "높음 (실제는 더 낮게 평가됨)" : t.rank_gap < 0 ? "낮음 (실제는 더 높게 평가됨)" : "같음"}">${gapTxt(t.rank_gap)}</td>
          <td title="xG 보유 ${t.xg_games}경기 기준">${t.ppg.toFixed(2)} / ${t.xppg.toFixed(2)}</td>
          <td><span class="ins-xl-badge ${cls}">${lbl} ${t.luck_ppg > 0 ? "+" : ""}${t.luck_ppg.toFixed(2)}</span></td></tr>`;
      }).join("");
      const warn = (d.warnings || []).map(w => `<div class="ins-xl-warn" role="note">⚠ ${escI(w)}</div>`).join("");
      return `<div class="ins-adv-sub-h">${d.league} ${d.year} <span class="ins-clutch-hint">xG 보유 ${d.matches_with_xg}/${d.matches}경기</span></div>${insTake(takeXgLuck(d))}${warn}
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>실제</th><th>팀</th><th>승점</th><th>xG 순위</th><th>차이</th><th title="경기당 승점: 실제 / 기대">PPG 실제/기대</th><th>판정</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — 기대 승점=경기별 양 팀 xG를 포아송 분포로 환산한 승·무 확률(3·1점) · <b>xG가 있는 경기만</b> 실제·기대 모두 같은 경기로 비교 · 차이=xG 기준으론 몇 계단 더 위(▲)/아래(▼)인지 · 판정 ±${list[0] && list[0].ppg_band || 0.25} PPG 이상 · 팀당 ${list[0] && list[0].min_games || 5}경기 미만 제외 · 소표본이라 참고용</div>`;
  }
  // 휴식일·연전 영향 — 막대=PPG, 가는 선=95% 신뢰구간. 구간이 겹치면 차이를 단정할 수 없다.
  function renderRestEffect(list) {
    const el = document.getElementById("ins-rest-body"); if (!el) return;
    const MAXP = 3, MIN_N = 20;
    const pctW = v => Math.max(0, Math.min(100, v / MAXP * 100));
    const row = r => {
      if (!r.n || r.n < MIN_N) {
        return `<div class="ins-rs-row ins-rs-low"><span class="ins-rs-lbl">${r.label}</span><span class="ins-rs-note">표본 부족 (${r.n}경기)</span></div>`;
      }
      const lo = Math.max(0, r.ppg - (r.ci || 0)), hi = r.ppg + (r.ci || 0);
      return `<div class="ins-rs-row"><span class="ins-rs-lbl">${r.label}</span>
        <span class="ins-rs-track" role="img" aria-label="${r.label} 경기당 승점 ${r.ppg.toFixed(2)}, 95% 구간 ${lo.toFixed(2)}~${hi.toFixed(2)}">
          <i class="ins-rs-bar" style="width:${pctW(r.ppg)}%"></i>
          <i class="ins-rs-ci" style="left:${pctW(lo)}%;width:${pctW(hi) - pctW(lo)}%"></i></span>
        <span class="ins-rs-val"><b>${r.ppg.toFixed(2)}</b><span class="ins-rs-pm"> ±${(r.ci || 0).toFixed(2)}</span><span class="ins-rs-n"> · ${r.n}경기</span></span></div>`;
    };
    const cmpTxt = (c, a, b) => c ? `<div class="ins-rs-cmp">${a} − ${b}: <b>${c.diff > 0 ? "+" : ""}${c.diff.toFixed(2)} PPG</b> (z=${c.z > 0 ? "+" : ""}${c.z.toFixed(1)}) · ${c.significant ? "유의한 차이" : "오차 범위 안 — 차이 단정 불가"}</div>` : "";
    const VERDICT = { none: ["ins-rs-v-none", "✔"], some: ["ins-rs-v-some", "❗"], insufficient: ["ins-rs-v-low", "…"] };
    el.innerHTML = list.map(d => {
      if (!d || !d.buckets) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const [vc, vi] = VERDICT[d.verdict.level] || VERDICT.insufficient;
      const warn = (d.warnings || []).map(w => `<div class="ins-xl-warn" role="note">⚠ ${escI(w)}</div>`).join("");
      return `<div class="ins-adv-sub-h">${d.league} ${d.year === "all" ? "전 시즌" : d.year} <span class="ins-clutch-hint">팀-경기 ${d.team_matches.toLocaleString()}건</span></div>
        <div class="ins-rs-verdict ${vc}" role="status"><span aria-hidden="true">${vi}</span> ${escI(d.verdict.text)}${d.year !== "all" ? ` <span class="ins-rs-hint">단일 시즌은 표본이 작아, 상단 시즌 필터를 '전체'로 두면 더 정확합니다.</span>` : ""}</div>${insTake(takeRest(d))}${warn}
        <div class="ins-rs-grid">
          <div><div class="ins-adv-sub-h">직전 경기와의 간격</div>${d.buckets.map(row).join("")}${cmpTxt(d.short_vs_normal, "3일 이하", "4일 이상")}</div>
          <div><div class="ins-adv-sub-h">홈·원정 휴식 격차 <span class="ins-clutch-hint">홈팀 PPG</span></div>${d.gap.map(row).join("")}${cmpTxt(d.gap_compare, "홈이 더 쉼", "원정이 더 쉼")}</div>
          <div><div class="ins-adv-sub-h">연전 (직전 14일 경기 수)</div>${d.congestion.map(row).join("")}${cmpTxt(d.congestion_compare, "3경기↑", "0~1경기")}</div>
        </div>`;
    }).join("") + `<div class="ins-method">근거 — 막대=경기당 승점(PPG)·가는 선=95% 신뢰구간(정규근사) · z≥1.96일 때만 '유의' · 휴식일=<b>같은 리그</b> 직전 경기 간격(컵·ACL 미반영, 21일 초과 공백 제외) · 각 팀-경기를 1건으로 집계(한 경기가 양 팀에 1건씩) · 20경기 미만 구간은 판정 제외</div>`;
  }
  // 교체 효과 심화 — 팀별 '첫 전술 교체 후−전 15분 순득실'을 리그 평균 대비로. 선이 0을 가로지르면 차이 단정 불가.
  function renderSubImpact(list) {
    const el = document.getElementById("ins-subimp-body"); if (!el) return;
    const RANGE = 1.0;   // 트랙 눈금: 리그 평균 대비 ±1.0골
    const pos = v => Math.max(0, Math.min(100, (v + RANGE) / (2 * RANGE) * 100));
    const sg = v => (v > 0 ? "+" : "") + v.toFixed(2);
    const VERDICT = { none: ["ins-rs-v-none", "✔"], some: ["ins-rs-v-some", "❗"], insufficient: ["ins-rs-v-low", "…"] };
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const [vc, vi] = VERDICT[d.verdict.level] || VERDICT.insufficient;
      const rows = d.teams.map(t => {
        if (!t.z && t.z !== 0) {
          return `<tr class="ins-xl-skip"><td class="ins-xl-team">${ttEsc(t.short)}</td><td>${t.n}</td><td colspan="2" class="ins-adv-empty">표본 부족 (${d.min_team_n}경기 미만)</td></tr>`;
        }
        const lo = t.vs_league - t.ci, hi = t.vs_league + t.ci;
        return `<tr><td class="ins-xl-team">${ttEsc(t.short)}${t.significant ? ` <span class="ins-sb-star" title="유의 기준 초과 (z≥1.96)">★</span>` : ""}</td>
          <td>${t.n}</td><td>${t.avg_first_min.toFixed(0)}분</td>
          <td><span class="ins-sb-track" role="img" aria-label="${ttEsc(t.short)} 리그 평균 대비 ${sg(t.vs_league)}골, 95% 구간 ${sg(lo)}~${sg(hi)}">
              <i class="ins-sb-zero"></i><i class="ins-sb-ci" style="left:${pos(lo)}%;width:${pos(hi) - pos(lo)}%"></i><i class="ins-sb-dot" style="left:${pos(t.vs_league)}%"></i></span>
              <span class="ins-sb-val">${sg(t.vs_league)}<span class="ins-rs-pm"> ±${t.ci.toFixed(2)}</span></span></td></tr>`;
      }).join("");
      const bench = d.bench.map((b, i) =>
        `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${ttEsc(b.name)}</span><span class="ins-adv-sub">${ttEsc(b.team)} · ${b.minutes}분 ${b.goals}골 ${b.assists}도움</span><b>${b.ga_per90.toFixed(2)}</b></li>`).join("");
      return `<div class="ins-adv-sub-h">${d.league} ${d.year === "all" ? "전 시즌" : d.year} <span class="ins-clutch-hint">첫 전술 교체 ${d.first_sub_samples.toLocaleString()}건</span></div>
        <div class="ins-rs-verdict ${vc}" role="status"><span aria-hidden="true">${vi}</span> ${escI(d.verdict.text)}
          <span class="ins-rs-hint">리그 전체 평균: 교체 후 순득실 ${sg(d.league_mean)}골${d.league_ci != null ? ` ±${d.league_ci.toFixed(2)}` : ""} (교체 전 15분 대비)${d.year !== "all" ? " · 단일 시즌은 표본이 작아 시즌 필터 '전체' 권장" : ""}</span></div>${insTake(takeSubImpact(d))}
        <div class="ins-rs-grid ins-sb-grid">
          <div><div class="ins-adv-sub-h">팀별 교체 후 득실 변화 <span class="ins-clutch-hint">리그 평균 대비</span></div>
            <div class="ins-top-scroll"><table class="ins-table ins-xl-table ins-sb-table"><thead><tr><th>팀</th><th>경기</th><th>첫 교체</th><th>변화 (골)</th></tr></thead><tbody>${rows}</tbody></table></div></div>
          <div><div class="ins-adv-sub-h">🪑 벤치 선수 90분당 득점+도움 <span class="ins-clutch-hint">교체 출전 ${d.bench_min_minutes}분↑·${d.bench_min_apps}경기↑ · 리그 평균 ${d.league_ga_per90 ?? "-"}</span></div>
            <ol class="ins-adv-list">${bench || '<li class="ins-adv-empty">조건을 넘는 선수 없음</li>'}</ol></div>
        </div>`;
    }).join("") + `<div class="ins-method">근거 — 변화=(첫 전술 교체 후 15분 순득실)−(전 15분 순득실), 경기별 평균 · 부상 교체 제외 · 앞뒤 15분이 모두 온전한 경기만 · 막대 점=리그 평균 대비, 선=95% 신뢰구간(0을 가로지르면 차이 단정 불가) · ★은 z≥1.96이나 여러 팀 동시 검정이라 우연히 나올 수 있음(검정당 약 5%) · 교체는 지고 있을 때 많아 경기 상황이 섞임 → 인과 아닌 참고 · 벤치 지표는 소표본 주의</div>`;
  }
  // 세트피스 공수 프로필 — 공격(생산)·수비(허용)를 한 표에. 순위는 xG(없으면 슈팅 수) 기준.
  function renderSetpieceProfile(list) {
    const el = document.getElementById("ins-spp-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const k = d.xg_ok ? "xg_pg" : "shots_pg", unit = d.metric;
      const warn = (d.warnings || []).map(w => `<div class="ins-xl-warn" role="note">⚠ ${escI(w)}</div>`).join("");
      const hl = (d.highlights || []).map(h =>
        `<li class="ins-spp-hl ins-spp-${h.kind}"><span class="ins-spp-tag">${h.kind === "attack" ? "▲ 강점" : "▼ 취약"}</span>${escI(h.text)}</li>`).join("");
      const types = d.league_types.map(t =>
        `<span class="ins-spp-chip"><b>${t.label}</b> ${t.shots.toLocaleString()}슛 · 득점률 ${t.goal_pct ?? "-"}%${t.xg_per_shot != null ? ` · 슈팅당 xG ${t.xg_per_shot}` : ""}</span>`).join("");
      const cell = (o, rank, total) => `${o[k].toFixed(2)}<span class="ins-rs-pm"> ${rank ? rank + "위" : ""}</span>`;
      const share = o => o.goal_share == null ? "-" : `${o.goal_share}%${o.small_goals ? `<span class="ins-spp-small" title="골 ${d.min_goals}개 미만 — 소표본">†</span>` : ""}`;
      const rows = d.teams.map(t => {
        if (!t.eligible) {
          return `<tr class="ins-xl-skip"><td class="ins-xl-team">${ttEsc(t.short)}</td><td>${t.games}</td><td colspan="6" class="ins-adv-empty">표본 부족 (${d.min_games}경기 미만)</td></tr>`;
        }
        const ty = Object.entries(t.for.by_type_pg).map(([a, v]) => `${a} ${v}`).join(" · ");
        return `<tr title="공격 유형별 슈팅/경기 — ${ty}"><td class="ins-xl-team">${ttEsc(t.short)}</td><td>${t.games}</td>
          <td>${cell(t.for, t.rank_for)}</td><td>${cell(t.against, t.rank_against)}</td>
          <td><b class="${t.net > 0 ? "ins-xl-up" : t.net < 0 ? "ins-xl-down" : ""}">${t.net > 0 ? "+" : ""}${t.net.toFixed(2)}</b></td>
          <td>${share(t.for)}</td><td>${share(t.against)}</td><td>${t.for.head_share ?? "-"}%</td></tr>`;
      }).join("");
      return `<div class="ins-adv-sub-h">${d.league} ${d.year === "all" ? "전 시즌" : d.year} <span class="ins-clutch-hint">기준 지표: 경기당 ${unit}</span></div>${insTake(takeSetpiece(d))}${warn}
        <ul class="ins-spp-hls">${hl}</ul><div class="ins-spp-chips">${types}</div>
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>팀</th><th>경기</th><th title="팀이 만든 세트피스 ${unit}/경기">공격 ${unit}</th><th title="상대에게 허용한 세트피스 ${unit}/경기 — 낮을수록 좋음">허용 ${unit}</th><th title="공격−허용">순</th><th title="팀 득점 중 세트피스 비중">득점 SP%</th><th title="팀 실점 중 세트피스 비중 — 높을수록 세트피스 수비 취약">실점 SP%</th><th title="세트피스 슈팅 중 헤더 비율">헤더</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — 슈팅맵 기반 · 세트피스=코너+프리킥+스로인+기타(PK 제외) · 순=공격−허용(경기당) · 순위는 정렬 가능한 ${list[0] && list[0].min_games || 8}경기↑ 팀만 · SP%는 득점·실점 중 세트피스 골 비중(†=골 ${list[0] && list[0].min_goals || 8}개 미만 소표본) · 행에 마우스를 올리면 공격 유형별 슈팅/경기</div>`;
  }
  // ── 신규 인사이트 4종 (2026-11-03): 득점 의존도 · 선발 로테이션 · 득점 직후 실점 · 패스 허브 ──────────────
  // DB 문자열(팀·선수명)은 모두 escI 를 거쳐 삽입한다. 소표본은 숨기지 않고 n 을 함께 보여 준다.
  const escI = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const insHead = d => `<div class="ins-adv-sub-h">${escI(d.league)} ${d.year === "all" ? "전 시즌" : escI(d.year)}</div>`;
  const insWarn = d => (d.warnings || []).map(w => `<div class="ins-xl-warn" role="note">⚠ ${escI(w)}</div>`).join("");
  const INS_VERDICT = { none: ["ins-rs-v-none", "✔"], some: ["ins-rs-v-some", "❗"], insufficient: ["ins-rs-v-low", "…"] };
  const insVerdict = v => { const [c, i] = INS_VERDICT[v.level] || INS_VERDICT.insufficient; return `<div class="ins-rs-verdict ${c}" role="status"><span aria-hidden="true">${i}</span> ${escI(v.text)}</div>`; };
  // PPG 막대(±95% 구간) — 휴식일 카드와 같은 시각 문법
  function insPpgRow(r) {
    const MAXP = 3;
    const w = v => Math.max(0, Math.min(100, v / MAXP * 100));
    if (!r || !r.n || r.n < 20) return `<div class="ins-rs-row ins-rs-low"><span class="ins-rs-lbl">${escI(r && r.label)}</span><span class="ins-rs-note">표본 부족 (${r ? r.n : 0}경기)</span></div>`;
    const lo = Math.max(0, r.ppg - (r.ci || 0)), hi = r.ppg + (r.ci || 0);
    return `<div class="ins-rs-row"><span class="ins-rs-lbl">${escI(r.label)}</span>
      <span class="ins-rs-track" role="img" aria-label="${escI(r.label)} 경기당 승점 ${r.ppg.toFixed(2)}, 95% 구간 ${lo.toFixed(2)}~${hi.toFixed(2)}"><i class="ins-rs-bar" style="width:${w(r.ppg)}%"></i><i class="ins-rs-ci" style="left:${w(lo)}%;width:${w(hi) - w(lo)}%"></i></span>
      <span class="ins-rs-val"><b>${r.ppg.toFixed(2)}</b><span class="ins-rs-pm"> ±${(r.ci || 0).toFixed(2)}</span><span class="ins-rs-n"> · ${r.n}경기</span></span></div>`;
  }
  const insCmp = (c, a, b) => c ? `<div class="ins-rs-cmp">${a} − ${b}: <b>${c.diff > 0 ? "+" : ""}${c.diff.toFixed(2)} PPG</b> (z=${c.z > 0 ? "+" : ""}${c.z.toFixed(1)}) · ${c.significant ? "유의한 차이" : "오차 범위 안 — 차이 단정 불가"}</div>` : "";
  const insBar = (pct, max) => `<span class="ins-mini-track" aria-hidden="true"><i class="ins-mini-bar" style="width:${Math.min(100, pct / max * 100)}%"></i></span>`;

  /* ── 카드별 '한 줄 해석' (2026-11-05) — 이미 받은 응답에서 규칙으로 문장을 만든다(신규 API 없음).
     근거 수치를 함께 적고, 임계값을 못 넘으면 '두드러진 차이 없음'을 그대로 말한다(억지 결론 금지).
     DB 문자열(팀·선수명)은 insJo/escI 로만 삽입. 숫자는 API가 준 값. */
  const insTake = lines => {
    const ls = (lines || []).filter(Boolean).slice(0, 2);
    return ls.length ? `<div class="ins-take" role="note" aria-label="한 줄 해석"><span class="ins-take-tag" aria-hidden="true">한 줄 해석</span><ul class="ins-take-list">${ls.map(l => `<li>${l}</li>`).join("")}</ul></div>` : "";
  };
  const insEv = s => `<span class="ins-take-ev">${s}</span>`;
  const isNum = v => typeof v === "number" && isFinite(v);
  const f2 = v => isNum(v) ? v.toFixed(2) : "-";
  const sgn2 = v => isNum(v) ? (v > 0 ? "+" : "") + v.toFixed(2) : "-";
  // 이름 + 조사(받침 유무) — <b>이름</b>은/는. 한글이 아닌 끝 글자는 받침 없음 형태.
  const insPp = (w, a, b) => { const s = String(w == null ? "" : w), c = s.charCodeAt(s.length - 1) - 0xAC00; return c >= 0 && c <= 11171 && c % 28 ? a : b; };
  const insJo = (w, a, b) => `<b>${escI(w)}</b>${insPp(w, a, b)}`;
  // 여러 팀 나열 + 조사 — 'A·B는' (조사는 마지막 이름 기준)
  const insNames = (arr, a, b) => arr.map(t => `<b>${escI(t.short)}</b>`).join("·") + insPp(arr[arr.length - 1].short, a, b);
  const insElig = d => (d && d.teams || []).filter(t => t && t.eligible);
  const insMax = (arr, f) => arr.reduce((a, b) => (f(b) > f(a) ? b : a), arr[0]);

  function takeXgLuck(d) {
    const ts = insElig(d).filter(t => isNum(t.luck_ppg)); if (ts.length < 3) return [];
    const band = d.ppg_band || 0.25, cov = d.matches ? d.matches_with_xg / d.matches : 0;
    const cav = cov && cov < 0.6 ? ` · xG 있는 경기 ${Math.round(cov * 100)}%만 비교 — 참고용` : "";
    const lucky = insMax(ts, t => t.luck_ppg), unlucky = insMax(ts, t => -t.luck_ppg), out = [];
    if (lucky.luck_ppg >= band) out.push(`${insJo(lucky.short, "은", "는")} 경기 내용(xG)보다 경기당 <b>${sgn2(lucky.luck_ppg)}점</b>을 더 가져갔습니다 — 결정력·선방이 받쳐 준 결과라 같은 페이스를 장담하긴 어렵습니다.${insEv(`실제 PPG ${f2(lucky.ppg)} / 기대 ${f2(lucky.xppg)}${cav}`)}`);
    if (unlucky.luck_ppg <= -band) out.push(`${insJo(unlucky.short, "은", "는")} 내용에 비해 결과가 경기당 <b>${sgn2(unlucky.luck_ppg)}점</b> 덜 나왔습니다 — 경기력이 유지되면 반등 여지가 가장 큰 팀입니다.${insEv(`실제 PPG ${f2(unlucky.ppg)} / 기대 ${f2(unlucky.xppg)}${cav}`)}`);
    if (!out.length) out.push(`모든 팀의 결과가 xG 기대 승점 ±${band} PPG 안 — 지금 순위는 경기 내용을 대체로 그대로 반영합니다.${cav ? insEv(cav.slice(3)) : ""}`);
    return out;
  }
  function takeRest(d) {
    const c = d.short_vs_normal, s = (d.buckets || []).find(b => b.key === "short");
    if (!c || !s || !s.n || s.n < 20) return ["3일 이하 휴식 경기 표본이 작아 아직 판단하기 이릅니다."];
    const ev = insEv(`3일 이하 PPG ${f2(s.ppg)} (${s.n}경기) · 차이 ${sgn2(c.diff)} · z=${isNum(c.z) ? c.z.toFixed(1) : "-"}`);
    const out = [c.significant
      ? `3일 이하로 쉬고 나온 경기는 4일 이상 쉰 경기보다 경기당 승점이 <b>${f2(Math.abs(c.diff))}점</b> ${c.diff < 0 ? "낮습니다 — 연전 구간의 체력 관리·로테이션이 실제 성적에 반영됩니다." : "높습니다 — 짧은 휴식이 오히려 흐름을 이어 주는 모습입니다."}${ev}`
      : `짧은 휴식(3일 이하) 뒤 성적 차이는 <b>${sgn2(c.diff)} PPG</b>로 오차 범위 안 — '체력 탓'이라는 패배 해석은 데이터로 뒷받침되지 않습니다.${ev}`];
    const g = d.congestion_compare;
    if (g && g.significant) out.push(`14일 안에 3경기 이상 치른 팀은 여유 있는 팀보다 경기당 <b>${sgn2(g.diff)}점</b> — 일정 밀집 자체가 의미 있는 변수입니다.`);
    return out;
  }
  function takeSubImpact(d) {
    const ts = (d.teams || []).filter(t => isNum(t.z) && isNum(t.vs_league)), out = [];
    const sig = ts.filter(t => t.significant).sort((a, b) => b.vs_league - a.vs_league);
    if (sig.length) {
      const up = sig.filter(t => t.vs_league > 0), dn = sig.filter(t => t.vs_league < 0);
      if (up.length) out.push(`${insNames(up, "은", "는")} 첫 교체 뒤 15분 순득실이 리그 평균보다 <b>${sgn2(up[0].vs_league)}골</b> 좋아집니다 — 벤치 카드가 실제로 흐름을 바꾸는 팀입니다.${insEv(`${up[0].n}경기 · ±${f2(up[0].ci)} · 여러 팀 동시 비교라 우연 가능성 있음`)}`);
      if (dn.length) out.push(`${insJo(dn[dn.length - 1].short, "은", "는")} 첫 교체 뒤 오히려 순득실이 <b>${sgn2(dn[dn.length - 1].vs_league)}골</b> 나빠집니다 — 교체 타이밍·카드 점검이 필요합니다.`);
    } else if (ts.length >= 3) {
      const best = insMax(ts, t => t.vs_league);
      out.push(`교체로 흐름이 확실히 바뀌는 팀은 아직 없습니다 — 가장 좋은 ${insJo(best.short, "도", "도")} 리그 평균 대비 ${sgn2(best.vs_league)}골로 오차 범위(±${f2(best.ci)}) 안입니다.`);
    }
    const b = (d.bench || [])[0], lg = d.league_ga_per90;
    if (b && isNum(b.ga_per90) && isNum(lg) && lg > 0 && b.ga_per90 >= lg * 2) {
      out.push(`가장 위협적인 조커는 <b>${escI(b.team)} ${escI(b.name)}</b> — 교체로 나와 90분당 공격포인트 <b>${f2(b.ga_per90)}</b>, 리그 평균(${f2(lg)})의 ${(b.ga_per90 / lg).toFixed(1)}배입니다.${insEv(`교체 출전 ${b.minutes}분 · ${b.goals}골 ${b.assists}도움 — 소표본`)}`);
    }
    return out;
  }
  function takeSetpiece(d) {
    const ts = insElig(d).filter(t => isNum(t.net)); if (ts.length < 3) return [];
    const k = d.xg_ok ? "xg_pg" : "shots_pg", unit = escI(d.metric || "슈팅"), out = [];
    const best = insMax(ts, t => t.net), worst = insMax(ts, t => -t.net);
    out.push(`세트피스 득실 1위는 <b>${escI(best.short)}</b>(경기당 순 ${unit} <b>${sgn2(best.net)}</b>), 최하위는 <b>${escI(worst.short)}</b>(<b>${sgn2(worst.net)}</b>)입니다.${insEv(`${escI(best.short)} 생산 ${f2(best.for && best.for[k])} / 허용 ${f2(best.against && best.against[k])} · ${escI(worst.short)} 생산 ${f2(worst.for && worst.for[k])} / 허용 ${f2(worst.against && worst.against[k])}`)}`);
    const vul = ts.filter(t => t.against && isNum(t.against.goal_share) && !t.against.small_goals);
    const v = vul.length && insMax(vul, t => t.against.goal_share);
    const atk = ts.filter(t => t.for && isNum(t.for.goal_share) && !t.for.small_goals);
    const a = atk.length && insMax(atk, t => t.for.goal_share);
    if (v && v.against.goal_share >= 30) out.push(`${insJo(v.short, "은", "는")} 실점의 <b>${v.against.goal_share}%</b>를 세트피스로 내줍니다 — 코너·프리킥 수비 정비가 가장 급한 팀입니다.${insEv(`세트피스 실점 ${v.against.goals}골`)}`);
    else if (a && a.for.goal_share >= 30) out.push(`${insJo(a.short, "은", "는")} 득점의 <b>${a.for.goal_share}%</b>를 세트피스로 만듭니다 — 상대라면 파울·코너 허용부터 줄여야 합니다.${insEv(`세트피스 득점 ${a.for.goals}골`)}`);
    return out;
  }
  function takeScoringDep(d) {
    const ts = insElig(d).filter(t => isNum(t.top1_share) && t.top && t.top[0]); if (ts.length < 3) return [];
    const avg = d.league_top1_share, out = [];
    const top = insMax(ts, t => t.top1_share);
    if (isNum(avg) && top.top1_share >= avg + 8) out.push(`${insJo(top.short, "은", "는")} <b>${escI(top.top[0].name)}</b> 한 명이 팀 득점의 <b>${top.top1_share}%</b>를 책임집니다(리그 평균 ${avg}%) — 이 선수 봉쇄가 곧 공략법입니다.${insEv(`${top.top[0].goals}골 / 팀 ${top.goals}골`)}`);
    const drops = ts.filter(t => t.ace && isNum(t.ace.ppg_with) && isNum(t.ace.ppg_without));
    const dr = drops.length && insMax(drops, t => t.ace.ppg_with - t.ace.ppg_without);
    if (dr && dr.ace.ppg_with - dr.ace.ppg_without >= 0.5) out.push(`${insJo(dr.short, "은", "는")} <b>${escI(dr.ace.name)}</b> 선발 시 경기당 <b>${f2(dr.ace.ppg_with)}점</b>, 비선발 시 <b>${f2(dr.ace.ppg_without)}점</b> — 에이스 결장 영향이 가장 큰 팀입니다.${insEv(`선발 ${dr.ace.n_with} · 비선발 ${dr.ace.n_without}경기 — 부상·로테이션이 섞여 인과 아님`)}`);
    if (!out.length) { const lo = insMax(ts, t => -t.top1_share); out.push(`특정 선수에게 득점이 크게 쏠린 팀은 없습니다 — 가장 고르게 나뉜 팀은 <b>${escI(lo.short)}</b>(1위 득점자 비중 ${lo.top1_share}%, 리그 평균 ${isNum(avg) ? avg : "-"}%)입니다.`); }
    return out;
  }
  function takeRotation(d) {
    const ts = insElig(d).filter(t => isNum(t.avg_changes)); if (ts.length < 3) return [];
    const hi = insMax(ts, t => t.avg_changes), lo = insMax(ts, t => -t.avg_changes), out = [];
    out.push(`${insJo(hi.short, "이", "가")} 직전 경기 대비 평균 <b>${hi.avg_changes.toFixed(1)}명</b>을 바꿔 로테이션이 가장 잦고, ${insJo(lo.short, "은", "는")} <b>${lo.avg_changes.toFixed(1)}명</b>으로 가장 고정적입니다.${d.year === "all" ? "" : insEv(`고정 주전(선발 70%↑) ${escI(hi.short)} ${hi.core_size}명 · ${escI(lo.short)} ${lo.core_size}명`)}`);
    const c = d.high_vs_stable;
    if (c && c.significant) out.push(`선발을 4명 이상 바꾼 경기는 안정 운영보다 경기당 <b>${sgn2(c.diff)}점</b> — 의미 있는 차이라 로테이션 폭 조절이 성적과 연결됩니다.`);
    return out;
  }
  function takeGameState(d) {
    const A = d.league_avg || {}, out = [];
    const led = insElig(d).filter(t => t.led && t.led.n >= 8 && isNum(t.led.hold_pct));
    if (led.length >= 3) {
      const best = insMax(led, t => t.led.hold_pct), worst = insMax(led, t => -t.led.hold_pct);
      out.push(`리드 지키기 1위는 <b>${escI(best.short)}</b>(앞선 경기의 <b>${best.led.hold_pct}%</b> 승리), 최하위는 <b>${escI(worst.short)}</b>(<b>${worst.led.hold_pct}%</b> · 놓친 승점 ${worst.led.dropped_pts}점)입니다.${insEv(`리그 평균 ${A.hold_pct ?? "-"}% · 리드 경기 ${best.led.n} / ${worst.led.n}경기`)}`);
    }
    const tr = insElig(d).filter(t => t.trailed && t.trailed.n >= 8 && isNum(t.trailed.ppg));
    const cb = tr.length && insMax(tr, t => t.trailed.ppg);
    if (cb && isNum(A.trailed_ppg) && cb.trailed.ppg >= A.trailed_ppg + 0.25) out.push(`뒤져도 가장 많이 따라붙는 팀은 ${insJo(cb.short, "입니다", "입니다")} — 뒤진 경기에서 경기당 <b>${f2(cb.trailed.ppg)}점</b>(리그 ${f2(A.trailed_ppg)}).${insEv(`${cb.trailed.n}경기 · ${cb.trailed.w}승 ${cb.trailed.d}무 ${cb.trailed.l}패`)}`);
    return out;
  }
  function takeAftermath(d) {
    const ts = insElig(d), w = d.window || 10, L = d.league_total, out = [];
    const bad = ts.filter(t => isNum(t.conc_z) && t.conc_z >= 2), calm = ts.filter(t => isNum(t.conc_z) && t.conc_z <= -2);
    const fight = ts.filter(t => isNum(t.resp_z) && t.resp_z >= 2);
    if (bad.length) out.push(`${insNames(bad, "은", "는")} 득점 후 ${w}분 안에 실점하는 일이 기대보다 잦습니다(${bad.map(t => `${t.conc_obs}회/기대 ${t.conc_exp.toFixed(1)}`).join(", ")}) — 골 직후 집중력 관리가 과제입니다.`);
    if (fight.length) out.push(`${insNames(fight, "은", "는")} 실점 후 ${w}분 안에 곧바로 받아치는 반격력이 돋보입니다(${fight.map(t => `${t.resp_obs}회/기대 ${t.resp_exp.toFixed(1)}`).join(", ")}).`);
    if (calm.length && out.length < 2) out.push(`${insNames(calm, "은", "는")} 득점 후 실점이 기대보다 적어 골 직후 버티는 힘이 좋습니다(${calm.map(t => `${t.conc_obs}회/기대 ${t.conc_exp.toFixed(1)}`).join(", ")}).`);
    if (!out.length && L && isNum(L.conc_exp)) out.push(`득점 직후 ${w}분 실점은 리그 전체 <b>${L.conc_obs}건</b>으로 기대(${L.conc_exp.toFixed(1)}건) ${L.conc_z <= -2 ? "보다 오히려 적습니다" : "수준입니다"} — '넣자마자 먹는' 팀은 통계적으로 두드러지지 않습니다.`);
    return out;
  }
  function takePassHub(d) {
    const ts = insElig(d).filter(t => isNum(t.hub_share)); if (ts.length < 3) return [];
    const POS = { GK: "GK", DF: "수비", MF: "미드", FW: "공격" };
    const hi = insMax(ts, t => t.hub_share), lo = insMax(ts, t => -t.hub_share), m = hi.main_hub, out = [];
    const avg = d.league_hub_share, hv = d.high_vs_low;
    // 리그 전체에서 '몰아준 날 vs 분산된 날' 성적 차이가 유의하면 그 의미를 첫 줄로
    if (hv && hv.significant && isNum(hv.diff)) out.push(hv.diff < 0
      ? `팀이 평소보다 한 선수에게 패스를 몰아준 날은 고르게 나눈 날보다 경기당 승점이 <b>${f2(Math.abs(hv.diff))}점</b> 낮았습니다 — 빌드업이 한 곳에 막히면 고전하는 리그입니다.${insEv(`z=${hv.z.toFixed(1)} · 점유율·상대 압박·경기 상황이 섞여 인과는 아님`)}`
      : `팀이 평소보다 핵심 선수에게 패스를 모은 날 경기당 승점이 <b>${f2(hv.diff)}점</b> 높았습니다 — 축이 되는 선수가 살아날 때 결과가 좋은 리그입니다.${insEv(`z=${hv.z.toFixed(1)} · 인과는 아님`)}`);
    // 리그 평균과 2%p 미만 차이면 '쏠림'이라 부르지 않는다(팀 간 차이가 작다는 사실만 전달)
    if (!isNum(avg) || hi.hub_share - avg < 2) {
      out.push(`팀 간 빌드업 집중도 차이는 크지 않습니다 — 허브 지분 최고 <b>${escI(hi.short)}</b> ${hi.hub_share}%, 최저 <b>${escI(lo.short)}</b> ${lo.hub_share}% (리그 ${isNum(avg) ? avg : "-"}%).`);
      return out;
    }
    const who = m && m.name && m.pct >= 40 ? ` 주로 <b>${escI(m.name)}</b>${m.pos ? `(${POS[m.pos] || escI(m.pos)})` : ""}${insPp(m.name, "을", "를")} 거쳐` : "";
    out.push(`${insJo(hi.short, "은", "는")}${who} 빌드업이 한 선수에게 가장 몰리는 팀입니다(허브 지분 <b>${hi.hub_share}%</b>, 리그 ${avg}%) — 상대는 이 연결고리 압박이 첫 번째 열쇠입니다.${m && m.name ? insEv(`${escI(m.name)} 허브 경기 ${m.times}/${hi.matches} (${m.pct}%)`) : ""}`);
    if (lo !== hi && avg - lo.hub_share >= 1) out.push(`${insJo(lo.short, "은", "는")} 허브 지분 <b>${lo.hub_share}%</b>로 패스가 가장 고르게 퍼진 팀 — 한 명만 막아서는 빌드업이 잘 끊기지 않습니다.${insEv(`시즌 중 허브가 된 선수 ${lo.hubs}명`)}`);
    return out;
  }

  // ⑤ 상대 수준별 성적 (2026-11-05) — 상위·중위·하위권 상대 PPG 를 '제 전력 대비'로 읽는다
  const OPP_TIER = { top: "상위권", mid: "중위권", bottom: "하위권" };
  const OPP_REL = 0.3;   // 전력 대비 ±0.3 PPG 이상이면 ▲/▼ 표시
  function takeOppStrength(d) {
    const ts = insElig(d), out = [];
    const pick = (k, sign) => {
      const c = ts.filter(t => t.tiers && t.tiers[k] && isNum(t.tiers[k].rel) && t.tiers[k].n >= 5);
      if (!c.length) return null;
      const t = insMax(c, x => sign * x.tiers[k].rel);
      return sign * t.tiers[k].rel >= OPP_REL ? { t, k, x: t.tiers[k] } : null;
    };
    const ev = (c) => insEv(`${c.x.w}승 ${c.x.d}무 ${c.x.l}패 · 전력 기준 기대 ${f2(c.x.exp)} · z=${isNum(c.x.z) ? c.x.z.toFixed(1) : "-"}${isNum(c.x.z) && Math.abs(c.x.z) >= 2 ? "" : " — 표본 오차 범위라 참고"}`);
    const cands = [];
    const g = pick("top", 1), w = pick("top", -1), s = pick("bottom", -1);
    if (g) cands.push({ c: g, html: `${insJo(g.t.short, "은", "는")} 제 전력(경기당 ${f2(g.t.ppg)})에 비해 상위권 상대로 <b>${sgn2(g.x.rel)}점</b> 더 따냅니다 — 큰 경기에 강한 팀입니다(상위권 상대 ${f2(g.x.ppg)}).` });
    if (w) cands.push({ c: w, html: `${insJo(w.t.short, "은", "는")} 상위권 상대로 경기당 <b>${f2(w.x.ppg)}점</b>에 그쳐 전력 대비 <b>${sgn2(w.x.rel)}</b> — 순위 경쟁 맞대결에서 승점을 놓치는 팀입니다.` });
    if (s) cands.push({ c: s, html: `${insJo(s.t.short, "은", "는")} 하위권 상대로 경기당 <b>${f2(s.x.ppg)}점</b>, 전력 대비 <b>${sgn2(s.x.rel)}</b> — 잡아야 할 경기에서 승점을 흘립니다.` });
    cands.sort((a, b) => Math.abs(b.c.x.z || 0) - Math.abs(a.c.x.z || 0));
    cands.slice(0, 2).forEach(o => out.push(o.html + ev(o.c)));
    if (!out.length && ts.length >= 3) out.push("상대 수준에 따른 뚜렷한 상성 패턴은 없습니다 — 모든 팀이 대체로 제 전력만큼 강팀에겐 덜, 약팀에겐 더 따냅니다.");
    return out;
  }
  function renderOppStrength(list) {
    const el = document.getElementById("ins-opp-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      if (!d.teams.length) return `${insHead(d)}${insWarn(d)}`;
      const LT = d.league_tiers || {}, sm = !!d.sos_meaningful;
      const cell = x => {
        if (!x || x.ppg == null) return `<span class="ins-rs-n">표본 부족${x ? ` (${x.n})` : ""}</span>`;
        const mark = isNum(x.rel) && x.rel >= OPP_REL ? ` <span class="ins-xl-up" aria-label="전력 대비 강함">▲</span>`
          : isNum(x.rel) && x.rel <= -OPP_REL ? ` <span class="ins-xl-down" aria-label="전력 대비 약함">▼</span>` : "";
        const tip = `${x.n}경기 ${x.w}승 ${x.d}무 ${x.l}패 · ±${f2(x.ci)} · 전력 기준 기대 ${f2(x.exp)} (차이 ${sgn2(x.rel)}${isNum(x.z) ? `, z=${x.z.toFixed(1)}` : ""})`;
        return `<span title="${tip}"><b>${f2(x.ppg)}</b>${mark}<span class="ins-rs-n"> ${x.w}-${x.d}-${x.l}</span></span>`;
      };
      const rows = d.teams.map(t => {
        if (!t.eligible) return `<tr class="ins-xl-skip"><td class="ins-xl-team">${escI(t.short)}</td><td>${t.games}</td><td colspan="${sm ? 6 : 4}" class="ins-adv-empty">표본 부족 (${d.min_games}경기 미만)</td></tr>`;
        const adj = sm ? `<td title="상대 평균 PPG — 높을수록 어려운 일정 (${t.rank_sos}위)">${f2(t.sos)}</td>
          <td title="일정 난이도 보정 PPG (실제 대비 ${sgn2(t.adj_diff)})"><b>${f2(t.adj_ppg)}</b>${t.rank_gap ? `<span class="${t.rank_gap > 0 ? "ins-xl-up" : "ins-xl-down"}"> ${t.rank_gap > 0 ? "▲" : "▼"}${Math.abs(t.rank_gap)}</span>` : ""}</td>` : "";
        return `<tr><td class="ins-xl-team">${escI(t.short)}</td><td>${t.games}</td><td><b>${f2(t.ppg)}</b></td>
          <td>${cell(t.tiers.top)}</td><td>${cell(t.tiers.mid)}</td><td>${cell(t.tiers.bottom)}</td>${adj}</tr>`;
      }).join("");
      const sos = d.sos_range ? (sm
        ? `일정 난이도(상대 평균 PPG)가 팀마다 ${f2(d.sos_range[0])}~${f2(d.sos_range[1])}로 달라, 보정 PPG와 순위 변화(▲▼)를 함께 표시합니다.`
        : `일정 난이도는 팀 간 차이가 거의 없습니다(상대 평균 PPG ${f2(d.sos_range[0])}~${f2(d.sos_range[1])}, 보정해도 최대 ${f2(d.max_adj)}점) — 서로 비슷한 횟수로 만나 순위가 곧 실력입니다.`) : "";
      return `${insHead(d)}${insTake(takeOppStrength(d))}${insWarn(d)}
        <div class="ins-rs-cmp">리그 전체 경기당 승점: 상위권 상대 <b>${f2(LT.top && LT.top.ppg)}</b> · 중위권 <b>${f2(LT.mid && LT.mid.ppg)}</b> · 하위권 <b>${f2(LT.bottom && LT.bottom.ppg)}</b></div>
        <div class="ins-rs-cmp">${sos}</div>
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>팀</th><th>경기</th><th title="경기당 승점">PPG</th>
          <th title="시즌 순위 상위 1/3 팀 상대 PPG · 승-무-패 (▲▼ = 제 전력 대비 ±${OPP_REL} 이상)">상위권 상대</th><th title="중위 1/3 팀 상대">중위권 상대</th><th title="하위 1/3 팀 상대">하위권 상대</th>
          ${sm ? `<th title="상대 평균 PPG (맞대결 제외)">일정 난이도</th><th title="상대 강도로 기대한 승점과의 차이를 리그 평균에 더한 값 · ▲▼=실제 순위 대비 변화">보정 PPG</th>` : ""}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — 상대 등급=같은 시즌 PPG 순위 3분할(상위·중위·하위) · ▲▼=이 팀 평소 PPG에 리그 전체의 등급별 낙폭을 적용한 기대보다 ±${OPP_REL}점 이상 · 셀에 마우스를 올리면 신뢰구간·z · 등급별 10경기 안팎이라 <b>대부분 참고용</b> · 일정 보정=상대 PPG(맞대결 제외)로 기대 승점을 적합해 보정 · 홈·원정·휴식일 미보정</div>`;
  }

  // ⑦ 포메이션 상성 (2026-11-05) — 내 포메이션 × 상대 포메이션. 승점−평소 PPG 잔차의 z≥1.96일 때만 '상성'이라고 말한다.
  function takeFormation(d) {
    const ms = (d.matchups || []).filter(m => !m.mirror && isNum(m.z)), out = [];
    const sig = ms.filter(m => m.significant).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    sig.slice(0, 2).forEach(m => out.push(`내 <b>${escI(m.formation)}</b> 대 상대 <b>${escI(m.opp)}</b> 조합에서 팀 평소보다 경기당 <b>${sgn2(m.resid)}점</b> ${m.resid > 0 ? "더 따냈습니다" : "덜 따냈습니다"}.${insEv(`${m.n}경기 ${m.w}승 ${m.d}무 ${m.l}패 · z=${m.z.toFixed(1)} · ${d.tested || "여러"}개 조합 중 하나라 우연일 수 있음 — 다음 라운드에도 이어지는지 확인`)}`));
    if (!out.length && (d.matches_with_formation || 0) >= 30) {
      const top = ms.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];
      out.push(`포메이션 조합만으로 승점이 갈린다는 통계적 근거는 없습니다 — 어떤 상성도 표본 오차 범위입니다.${top ? insEv(`가장 쏠린 조합: ${escI(top.formation)} vs ${escI(top.opp)} (${top.n}경기, 평소 대비 ${sgn2(top.resid)}점, z=${top.z.toFixed(1)} — 참고)`) : ""}`);
    }
    return out;
  }
  function renderFormation(list) {
    const el = document.getElementById("ins-fm-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.formations) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const ms = d.matchups || [];
      if (!ms.length) return `${insHead(d)}${insWarn(d)}<div class="ins-adv-empty">표시할 포메이션 조합 표본이 부족합니다(조합당 ${d.min_cell}경기 이상 필요).</div>`;
      const rowsF = [...new Set(ms.map(m => m.formation))], colsF = [...new Set(ms.map(m => m.opp))];
      const own = {}; d.formations.forEach(f => { own[f.formation] = f; });
      const cell = m => {
        if (!m) return `<td class="ins-rs-n">-</td>`;
        const rec = `${m.w}-${m.d}-${m.l}`;
        if (m.mirror) return `<td title="같은 포메이션끼리 ${m.n}경기 · 무승부 ${m.d}경기 (서로 상쇄되어 상성 계산 제외)"><span class="ins-rs-n">미러 ${rec}</span></td>`;
        const mark = m.significant ? ` <span class="${m.resid > 0 ? "ins-xl-up" : "ins-xl-down"}" aria-label="${m.resid > 0 ? "평소보다 유의하게 강함" : "평소보다 유의하게 약함"}">${m.resid > 0 ? "▲" : "▼"}</span>` : "";
        return `<td title="${m.n}경기 ${m.w}승 ${m.d}무 ${m.l}패 · 득실 ${f2(m.gf)}:${f2(m.ga)} · 평소 대비 ${sgn2(m.resid)}점 · z=${isNum(m.z) ? m.z.toFixed(1) : "-"}${m.significant ? "" : " (표본 오차 범위)"}"><b>${f2(m.ppg)}</b>${mark}<span class="ins-rs-n"> ${rec}</span></td>`;
      };
      const rows = rowsF.map(f => {
        const o = own[f];
        return `<tr><td class="ins-xl-team">${escI(f)}</td><td>${o ? o.n : "-"}</td><td title="이 포메이션을 쓴 팀-경기의 평소 대비 승점 ${o ? sgn2(o.resid) : "-"}"><b>${o ? f2(o.ppg) : "-"}</b></td>
          ${colsF.map(g => cell(ms.find(m => m.formation === f && m.opp === g))).join("")}</tr>`;
      }).join("");
      return `${insHead(d)}${insTake(takeFormation(d))}${insWarn(d)}
        <div class="ins-rs-cmp">포메이션 기록이 있는 ${d.matches_with_formation}/${d.matches}경기 · 칸 = 경기당 승점 · 승-무-패 · ▲▼ = 팀 평소 대비 통계적으로 유의(z≥1.96, ${d.min_sig}경기↑)</div>
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>내 포메이션</th><th>경기</th><th title="이 포메이션을 쓴 팀-경기의 경기당 승점">PPG</th>
          ${colsF.map(g => `<th title="상대가 ${escI(g)}일 때">vs ${escI(g)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — ${escI((list[0] && list[0].limits) || "")}</div>`;
  }

  // ⑧ 라운드별 순위 추이 (2026-11-05) — 라운드 종료 시점 누적 승점 순위. 선은 중립색, 선택한 팀만 강조(굵기+라벨, 색에만 의존 안 함)
  function takeTrend(d) {
    const T = d.teams || [], n = (d.rounds || []).length, out = [];
    if (!T.length) return out;
    const lead = T[0], second = T[1];
    out.push(`<b>${escI(lead.short)}</b>${insPp(lead.short, "이", "가")} <b>${lead.points}점</b>으로 선두${second ? ` — 2위 ${escI(second.short)}${insPp(second.short, "과", "와")} ${lead.points - second.points}점 차` : ""}입니다.${insEv(`${n}라운드 중 ${lead.weeks_first}라운드 선두 · 선두 교체 ${d.leader_changes}회${d.leader_changes === 0 ? "(선두가 한 번도 바뀌지 않음)" : ""}`)}`);
    const w = d.window || 5, up = T.slice().sort((a, b) => b.delta_recent - a.delta_recent)[0], dn = T.slice().sort((a, b) => a.delta_recent - b.delta_recent)[0];
    if (up && up.delta_recent >= 2) out.push(`최근 ${w}라운드 가장 많이 오른 팀은 <b>${escI(up.short)}</b> — <b>${up.delta_recent}계단</b> 상승해 ${up.rank}위입니다.${insEv(`${w}라운드 전 ${up.rank + up.delta_recent}위 → 현재 ${up.rank}위 · 승점 ${up.points}`)}`);
    if (dn && dn.delta_recent <= -2) out.push(`반대로 <b>${escI(dn.short)}</b>${insPp(dn.short, "은", "는")} 최근 ${w}라운드 <b>${-dn.delta_recent}계단</b> 하락해 ${dn.rank}위입니다.${insEv(`${w}라운드 전 ${dn.rank + dn.delta_recent}위 → 현재 ${dn.rank}위 · 승점 ${dn.points}`)}`);
    return out;
  }
  function renderTrend(list) {
    const el = document.getElementById("ins-trend-body"); if (!el) return;
    el.innerHTML = list.map((d, idx) => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      if (!d.teams.length) return `${insHead(d)}${insWarn(d)}<div class="ins-adv-empty">순위 추이를 그릴 라운드가 부족합니다(${d.min_rounds || 5}라운드 이상 필요).</div>`;
      const T = d.teams, N = T.length, n = d.rounds.length;
      const W = 640, L = 30, R = 58, TOP = 10, RH = 21, H = TOP + N * RH + 20;
      const X = i => L + (n > 1 ? i / (n - 1) : 0) * (W - L - R), Y = r => TOP + (r - 0.5) * RH;
      const lead = T[0].id;
      const lines = [...T.filter(t => t.id !== lead), ...T.filter(t => t.id === lead)].map(t => {   // 강조선이 맨 위에 그려지도록 선두를 마지막에
        const path = t.ranks.map((r, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(r).toFixed(1)}`).join(" ");
        return `<path class="ins-tr-line${t.id === lead ? " sel" : ""}" data-tid="${t.id}" d="${path}"><title>${escI(t.short)} — 현재 ${t.rank}위 (최고 ${t.best}위 · 최저 ${t.worst}위)</title></path>`;
      }).join("");
      const labs = T.map(t => `<text class="ins-tr-lab${t.id === lead ? " sel" : ""}" data-tid="${t.id}" x="${W - R + 6}" y="${Y(t.rank) + 4}">${escI(t.short)}</text>`).join("");
      const axisY = Array.from({ length: N }, (_, i) => `<text class="ins-tr-axis" x="${L - 8}" y="${Y(i + 1) + 4}" text-anchor="end">${i + 1}</text>`).join("");
      const ticks = d.rounds.map((r, i) => (i === 0 || i === n - 1 || (r % 5 === 0 && n - 1 - i > 2 && i > 2)) ? `<text class="ins-tr-axis" x="${X(i).toFixed(1)}" y="${H - 4}" text-anchor="middle">${r}R</text>` : "").join("");
      const rows = T.map(t => {
        const dl = t.delta_recent, mv = dl > 0 ? `<span class="ins-xl-up" aria-label="${dl}계단 상승">▲${dl}</span>` : dl < 0 ? `<span class="ins-xl-down" aria-label="${-dl}계단 하락">▼${-dl}</span>` : `<span class="ins-rs-n">–</span>`;
        return `<tr data-tid="${t.id}" class="${t.id === lead ? "sel" : ""}"><td>${t.rank}</td>
          <td class="ins-xl-team"><button type="button" class="ins-tr-pick" data-tid="${t.id}" aria-pressed="${t.id === lead}" title="이 팀의 순위선을 강조">${escI(t.short)}</button></td>
          <td><b>${t.points}</b></td><td>${t.gap_to_first ? "−" + t.gap_to_first : "–"}</td><td title="${d.window || 5}라운드 전 대비 순위 변화">${mv}</td>
          <td title="시즌 중 최고 · 최저 순위">${t.best}위 · ${t.worst}위</td><td title="라운드마다 평균 몇 계단 움직였나 — 클수록 순위가 자주 요동침">${f2(t.volatility)}</td></tr>`;
      }).join("");
      return `${insHead(d)}${insTake(takeTrend(d))}${insWarn(d)}
        <div class="ins-tr-wrap" data-trend="${idx}">
          <svg class="ins-tr-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escI(d.league)} ${d.season} 라운드별 순위 추이. 현재 1위 ${escI(T[0].short)}">${axisY}${ticks}${lines}${labs}</svg>
          <div class="ins-rs-cmp">아래 표에서 팀 이름을 누르면 그 팀의 순위선이 굵게 강조됩니다 (위쪽 = 높은 순위).</div>
          <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>순위</th><th>팀</th><th>승점</th><th title="1위와의 승점 차">1위와</th><th title="${d.window || 5}라운드 전 대비">최근 ${d.window || 5}R</th><th>최고·최저</th><th>변동성</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>`;
    }).join("") + `<div class="ins-method">근거 — ${escI((list[0] && list[0].limits) || "")}</div>`;
    el.querySelectorAll(".ins-tr-wrap").forEach(wrap => {
      wrap.addEventListener("click", e => {
        const b = e.target.closest(".ins-tr-pick"); if (!b) return;
        const tid = b.dataset.tid;
        wrap.querySelectorAll("[data-tid]").forEach(x => {
          const on = x.dataset.tid === tid;
          if (x.tagName === "BUTTON") x.setAttribute("aria-pressed", String(on));
          else x.classList.toggle("sel", on);
        });
        const line = wrap.querySelector(`path.ins-tr-line[data-tid="${tid}"]`);
        if (line) line.parentNode.appendChild(line);      // 강조선을 맨 위로
      });
    });
  }

  // ⑥ 실점 약점 지도 (2026-11-05) — 허용 슈팅이 '어디로·어떤 상황으로' 쏠리나 (비중 vs 리그 비중, |z|≥2만 표시)
  const WEAK_TIP = {
    goalmouth: "크로스·컷백 상황의 박스 안 마크", box_center: "수비 라인 사이·페널티 박스 중앙 공간 관리",
    box_wide: "측면 돌파 저지와 좁은 각도 슈팅 대응", out_center: "2선 압박 — 박스 앞 중거리 슈팅 허용",
    out_wide: "측면 바깥 슈팅 허용(위험도는 낮은 편)", open: "오픈 플레이 빌드업 저지",
    counter: "공격 전환 시 후방 대비(역습 허용)", setpiece: "코너·프리킥 등 세트피스 수비", penalty: "박스 안 파울(PK 허용)",
  };
  function takeWeakness(d) {
    const ts = insElig(d), out = [], lab = {};
    (d.zones || []).concat(d.situations || []).forEach(x => { lab[x.key] = x.label; });
    // 팀별 약점 목록(z 내림차순). '오픈 플레이'는 세트피스·역습 비중의 거울상(합 100%)이라 문장 후보에서 제외.
    const byTeam = ts.map(t => ({ t, f: (t.weak || []).filter(k => k !== "open").map(k => ({ k, c: (t.zones && t.zones[k]) || (t.situations && t.situations[k]) }))
      .filter(x => x.c && isNum(x.c.z)) })).filter(o => o.f.length);
    // 위험도 낮은 '중거리 측면'(득점 전환율 ~3%)은 문장 우선순위를 절반으로
    const pri = x => x.c.z * (x.k === "out_wide" ? 0.5 : 1);
    byTeam.forEach(o => o.f.sort((a, b) => pri(b) - pri(a)));
    byTeam.sort((a, b) => pri(b.f[0]) - pri(a.f[0]));
    byTeam.slice(0, 2).forEach(({ t, f }) => {
      const m = f[0], more = f.slice(1, 3).map(x => `${escI(lab[x.k] || x.k)} ${x.c.share}%(리그 ${x.c.lg_share}%)`).join(", ");
      out.push(`${insJo(t.short, "은", "는")} 허용 슈팅의 <b>${m.c.share}%</b>가 ${escI(lab[m.k] || m.k)}에서 나옵니다(리그 ${m.c.lg_share}%) — 점검 포인트: ${WEAK_TIP[m.k] || ""}.${insEv(`경기당 ${f2(m.c.shots_pg)}슈팅 · ${m.c.goals}실점 · z=${m.c.z.toFixed(1)}${more ? ` · 함께 쏠린 곳: ${more}` : ""}`)}`);
    });
    if (out.length < 2) {
      const hi = ts.filter(t => isNum(t.shots_pg)), top = hi.length && insMax(hi, t => t.shots_pg);
      if (top && isNum(top.shots_ratio) && top.shots_ratio >= 1.15) out.push(`${out.length ? "분포와 별개로, " : "허용 슈팅이 특정 지역으로 크게 쏠린 팀은 없습니다 — 차이는 '얼마나 많이 허용하나'에서 납니다. "}${insJo(top.short, "이", "가")} 경기당 <b>${f2(top.shots_pg)}개</b>로 가장 많이 허용합니다(리그 ${f2(d.league_shots_pg)}, ${top.shots_ratio.toFixed(2)}배).`);
    }
    return out;
  }
  function renderWeakness(list) {
    const el = document.getElementById("ins-weak-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      if (!d.teams.length) return `${insHead(d)}${insWarn(d)}`;
      const zs = d.zones || [], ss = (d.situations || []).filter(s => s.key !== "penalty" && d.league_situations[s.key] && d.league_situations[s.key].available);
      const cell = (c, lgShare) => {
        if (!c) return `<span class="ins-rs-n">-</span>`;
        const flag = isNum(c.z) && c.z >= (d.z_flag || 2) ? ` <span class="ins-xl-down" aria-label="리그보다 많이 허용">▲</span>`
          : isNum(c.z) && c.z <= -(d.z_flag || 2) ? ` <span class="ins-xl-up" aria-label="리그보다 적게 허용">▼</span>` : "";
        return `<span title="경기당 ${f2(c.shots_pg)}슈팅 허용 · ${c.goals}실점 · 리그 비중 ${lgShare}%${isNum(c.z) ? ` · z=${c.z.toFixed(1)}` : ""}">${c.share}%${flag}</span>`;
      };
      const rows = d.teams.map(t => {
        if (!t.eligible) return `<tr class="ins-xl-skip"><td class="ins-xl-team">${escI(t.short)}</td><td>${t.games}</td><td colspan="${1 + zs.length + ss.length}" class="ins-adv-empty">표본 부족 (${d.min_games}경기 미만)</td></tr>`;
        return `<tr><td class="ins-xl-team">${escI(t.short)}</td><td>${t.games}</td>
          <td title="리그 평균 대비 ${f2(t.shots_ratio)}배 (많이 허용한 순 ${t.rank_shots}위)"><b>${f2(t.shots_pg)}</b> ${insBar(t.shots_pg, 20)}</td>
          ${zs.map(z => `<td>${cell(t.zones[z.key], d.league_zones[z.key].share)}</td>`).join("")}
          ${ss.map(s => `<td class="${s === ss[0] ? "ins-wk-sep" : ""}">${cell(t.situations[s.key], d.league_situations[s.key].share)}</td>`).join("")}</tr>`;
      }).join("");
      const LZ = d.league_zones || {};
      // 구역 안내 — 하프 피치 도식(골문 위쪽) + 리그 득점 전환율
      const zl = k => LZ[k] && LZ[k].goal_pct != null ? LZ[k].goal_pct + "%" : "-";
      // 1m = 220/68 px (폭 68m). 깊이: 6야드 5.5m→18px, 페널티 박스 16.5m→53px. 구역 경계 = 폭 30%·70%(x 66·154), 깊이 53px.
      const zoneMap = `<svg class="ins-wk-pitch" viewBox="0 0 220 112" role="img" aria-label="구역 안내(리그 득점 전환율): 골문 앞 ${zl("goalmouth")}, 박스 중앙 ${zl("box_center")}, 박스 측면 ${zl("box_wide")}, 중거리 정면 ${zl("out_center")}, 중거리 측면 ${zl("out_wide")}">
          <rect class="ins-wk-bg" x="0" y="0" width="220" height="112"/>
          <rect class="ins-wk-hot" x="66" y="0" width="88" height="53"/><rect class="ins-wk-hot2" x="80" y="0" width="60" height="18"/>
          <rect class="ins-wk-mark" x="45" y="0" width="130" height="53"/>
          <line class="ins-wk-l" x1="0" y1="53" x2="220" y2="53"/><line class="ins-wk-l" x1="66" y1="0" x2="66" y2="112"/><line class="ins-wk-l" x1="154" y1="0" x2="154" y2="112"/>
          <rect class="ins-wk-goal" x="98" y="0" width="24" height="3"/>
          <text x="110" y="12" class="ins-wk-t">골문 앞 ${zl("goalmouth")}</text>
          <text x="110" y="38" class="ins-wk-t">박스 중앙 ${zl("box_center")}</text>
          <text x="33" y="25" class="ins-wk-t ins-wk-ts">박스 측면</text><text x="33" y="37" class="ins-wk-t ins-wk-ts">${zl("box_wide")}</text>
          <text x="187" y="25" class="ins-wk-t ins-wk-ts">박스 측면</text><text x="187" y="37" class="ins-wk-t ins-wk-ts">${zl("box_wide")}</text>
          <text x="110" y="84" class="ins-wk-t">중거리 정면 ${zl("out_center")}</text>
          <text x="33" y="78" class="ins-wk-t ins-wk-ts">중거리 측면</text><text x="33" y="90" class="ins-wk-t ins-wk-ts">${zl("out_wide")}</text>
          <text x="187" y="78" class="ins-wk-t ins-wk-ts">중거리 측면</text><text x="187" y="90" class="ins-wk-t ins-wk-ts">${zl("out_wide")}</text>
        </svg>`;
      return `${insHead(d)}${insTake(takeWeakness(d))}${insWarn(d)}
        <div class="ins-wk-legend">${zoneMap}<div class="ins-rs-cmp">구역별 숫자 = 리그 전체 슈팅의 <b>득점 전환율</b>. 골문 앞 슈팅은 중거리보다 훨씬 위험하므로, 같은 비중 차이라도 골문 앞·박스 중앙 쏠림이 더 치명적입니다.<br>표의 % = 그 팀이 허용한 슈팅 중 해당 구역·상황 비중 · <span class="ins-xl-down">▲</span> 리그보다 쏠림(약점) · <span class="ins-xl-up">▼</span> 리그보다 적음 (|z|≥${d.z_flag || 2})</div></div>
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table ins-wk-table"><thead>
          <tr><th rowspan="2">팀</th><th rowspan="2">경기</th><th rowspan="2" title="경기당 허용 슈팅 (막대 = 20개 기준)">허용 슈팅/경기<br><span class="ins-rs-n">리그 ${f2(d.league_shots_pg)}</span></th>
            <th colspan="${zs.length}">허용 슈팅 비중 — 지역</th><th colspan="${ss.length}" class="ins-wk-sep">— 상황</th></tr>
          <tr>${zs.map(z => `<th title="리그 비중 ${LZ[z.key] ? LZ[z.key].share : "-"}%">${escI(z.label)}</th>`).join("")}${ss.map(s => `<th class="${s === ss[0] ? "ins-wk-sep" : ""}" title="리그 비중 ${d.league_situations[s.key].share}%">${escI(s.label)}</th>`).join("")}</tr>
        </thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — 슈팅맵(SofaScore) 허용 슈팅·자책골 제외 · 구역=골라인 거리·폭 좌표를 105×68m 규격으로 환산(6야드 박스 5.5m, 페널티 박스 16.5m) · ▲▼는 허용 슈팅 '비중'을 리그 비중과 비교한 z(|z|≥2) — 많이 허용하는 팀이 모든 칸에서 약점이 되지 않도록 분포만 봄 · 좌우 측면은 구분하지 않음 · 앞서는 팀은 슈팅을 더 허용하는 등 경기 상황 미보정 · 점검 포인트는 데이터가 가리키는 방향일 뿐 원인 단정 아님</div>`;
  }

  // ① 득점 의존도
  function renderScoringDep(list) {
    const el = document.getElementById("ins-sdep-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const ppg = v => v == null ? "-" : v.toFixed(2);
      const rows = d.teams.map(t => {
        if (!t.eligible) return `<tr class="ins-xl-skip"><td class="ins-xl-team">${escI(t.short)}</td><td>${t.goals}</td><td colspan="4" class="ins-adv-empty">표본 부족 (${d.min_games}경기·${d.min_goals}득점 미만)</td></tr>`;
        const top = t.top.map(x => `${escI(x.name)} ${x.goals}골`).join(" · ");
        const a = t.ace;
        const ace = a ? `${ppg(a.ppg_with)}<span class="ins-rs-n"> (${a.n_with})</span>` : "-";
        const without = a ? (a.ppg_without == null ? `<span class="ins-adv-empty" title="비선발 ${a.n_without}경기 — ${d.min_without}경기 미만은 표시하지 않음">표본 부족 (${a.n_without})</span>` : `${ppg(a.ppg_without)}<span class="ins-rs-n"> (${a.n_without})</span>`) : "-";
        return `<tr><td class="ins-xl-team">${escI(t.short)}</td><td>${t.goals}</td>
          <td title="${top}"><b>${t.top1_share}%</b> ${insBar(t.top1_share, 50)}<span class="ins-sd-name">${escI(t.top[0].name)}</span></td>
          <td>${t.top2_share}%</td><td>${ace}</td><td>${without}</td></tr>`;
      }).join("");
      return `${insHead(d)}${insTake(takeScoringDep(d))}${insWarn(d)}
        <div class="ins-rs-cmp">리그 평균: 1위 득점자 <b>${d.league_top1_share ?? "-"}%</b> · 1·2위 합 <b>${d.league_top2_share ?? "-"}%</b></div>
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>팀</th><th title="자책골 제외 팀 득점">득점</th>
          <th title="팀 득점 1위 선수의 득점 비중 (막대 = 50% 기준)">1위 득점자 비중</th><th title="득점 1·2위 선수 합">1·2위 합</th>
          <th title="에이스(팀 득점 1위)가 선발이던 경기의 팀 경기당 승점 (경기 수)">에이스 선발 PPG</th><th title="에이스가 선발이 아니던 경기의 팀 경기당 승점 (경기 수)">비선발 PPG</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — 득점=자책골 제외 · 비중=선수 득점÷팀 득점 · 에이스=팀 득점 1위, 선발 여부는 K리그 포털 선발 명단 기준 · 비선발 PPG는 ${list[0] && list[0].min_without || 3}경기 미만이면 표시 안 함 · 비선발 경기는 부상·징계·로테이션이 섞여 <b>인과가 아닌 참고</b> · 표본이 작으니 (경기 수)를 함께 보세요</div>`;
  }

  // ② 선발 로테이션
  function renderRotation(list) {
    const el = document.getElementById("ins-rot-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.buckets) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const rows = d.teams.map(t => {
        if (!t.eligible) return `<tr class="ins-xl-skip"><td class="ins-xl-team">${escI(t.short)}</td><td>${t.matches}</td><td colspan="3" class="ins-adv-empty">표본 부족 (${d.min_games}경기 미만)</td></tr>`;
        const hp = t.high_ppg == null ? `<span class="ins-adv-empty">표본 부족</span>` : `${t.high_ppg.toFixed(2)}`;
        return `<tr><td class="ins-xl-team">${escI(t.short)}</td><td>${t.matches}</td><td><b>${t.avg_changes.toFixed(2)}</b>명 ${insBar(t.avg_changes, 6)}</td><td>${t.core_size}명</td><td>${t.high_n}경기 · PPG ${hp}</td></tr>`;
      }).join("");
      return `${insHead(d)}${insVerdict(d.verdict)}${insTake(takeRotation(d))}${insWarn(d)}
        <div class="ins-rs-grid ins-rs-grid-2">
          <div><div class="ins-adv-sub-h">직전 경기 대비 선발 교체 인원 <span class="ins-clutch-hint">팀-경기 ${d.team_matches.toLocaleString()}건</span></div>${d.buckets.map(insPpgRow).join("")}${insCmp(d.high_vs_stable, "대폭", "안정")}</div>
          <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>팀</th><th title="직전 경기와 비교 가능한 경기 수">경기</th><th title="직전 경기 대비 평균 선발 교체 인원 (막대 = 6명 기준)">평균 교체</th>
            <th title="팀 경기의 70% 이상 선발로 나선 선수 수">고정 주전</th><th title="선발 4명 이상 바꾼 경기 수와 그때 팀 경기당 승점 (3경기 미만은 표시 안 함)">대폭 로테 경기</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>`;
    }).join("") + `<div class="ins-method">근거 — 교체 인원=11−(직전 경기 선발과 겹치는 선수 수) · 직전 경기=<b>같은 리그</b>(컵·ACL 미반영, 21일 초과 공백 제외) · 선발은 K리그 포털 명단 · 막대=PPG·가는 선=95% 신뢰구간 · z≥1.96일 때만 '유의' · 로테이션은 연전·부상·직전 결과에 따라 달라져 <b>인과가 아님</b></div>`;
  }

  // ⓪ 경기 상황별 성적 (앞섬·동점·뒤짐)
  function renderGameState(list) {
    const el = document.getElementById("ins-gs-body"); if (!el) return;
    const zTxt = z => z == null ? "" : (Math.abs(z) >= 2 ? ` <b class="ins-gs-z">${z > 0 ? "▲" : "▼"} z=${z > 0 ? "+" : ""}${z.toFixed(1)}</b>` : ` <span class="ins-rs-n">z=${z > 0 ? "+" : ""}${z.toFixed(1)}</span>`);
    const wdl = o => `${o.w}승 ${o.d}무 ${o.l}패`;
    const share = s => `<span class="ins-gs-share" role="img" aria-label="경기 시간 중 앞섬 ${s[0]}%, 동점 ${s[1]}%, 뒤짐 ${s[2]}%">
        <i class="ins-gs-lead" style="width:${s[0]}%"></i><i class="ins-gs-level" style="width:${s[1]}%"></i><i class="ins-gs-trail" style="width:${s[2]}%"></i></span>
        <span class="ins-gs-pct">${s[0]} · ${s[1]} · ${s[2]}</span>`;
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const A = d.league_avg || {};
      const rows = d.teams.map(t => {
        if (!t.eligible) return `<tr class="ins-xl-skip"><td class="ins-xl-team">${escI(t.short)}</td><td>${t.games}</td><td colspan="5" class="ins-adv-empty">표본 부족 (${d.min_games}경기 미만)</td></tr>`;
        const L = t.led, T = t.trailed;
        const hold = L.n ? `<b>${L.hold_pct}%</b>${zTxt(L.z)}<span class="ins-rs-n"> (${L.n}경기 · ${wdl(L)})</span>` : `<span class="ins-rs-n">리드 경기 없음</span>`;
        const back = T.n ? `<b>${T.ppg.toFixed(2)}</b><span class="ins-rs-n"> (${T.n}경기 · ${wdl(T)})</span>` : `<span class="ins-rs-n">-</span>`;
        return `<tr><td class="ins-xl-team">${escI(t.short)}</td><td>${t.games}</td><td class="ins-gs-share-td">${share(t.share)}</td>
          <td>${hold}</td><td>${L.dropped_pts}</td><td>${back}</td></tr>`;
      }).join("");
      const gen = d.flagged.length
        ? `리드 지킨 비율이 리그 평균과 크게 다른 팀(|z|≥2): <b>${d.flagged.map(escI).join(", ")}</b> — 여러 팀을 동시에 보면 우연히도 나올 수 있어 참고용입니다.`
        : "리드 지킨 비율이 리그 평균과 크게 다른 팀은 없습니다 (모두 |z|&lt;2).";
      return `${insHead(d)}${insTake(takeGameState(d))}${insWarn(d)}
        <div class="ins-rs-cmp">리그 평균: 리드를 잡은 경기의 <b>${A.hold_pct ?? "-"}%</b>를 승리로 마무리 · 뒤진 적 있는 경기에서 경기당 <b>${A.trailed_ppg != null ? A.trailed_ppg.toFixed(2) : "-"}</b>점 회복 <span class="ins-rs-n">(${d.matches}경기${d.skipped ? ` · 득점 기록 불일치 ${d.skipped}경기 제외` : ""})</span></div>
        <div class="ins-rs-cmp">${gen}</div>
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>팀</th><th>경기</th>
          <th title="경기 시간 중 앞선·동점·뒤진 시간 비율(%) — 초록=앞섬, 회색=동점, 빨강=뒤짐">앞섬 · 동점 · 뒤짐 (%)</th>
          <th title="한 번이라도 앞선 경기 중 승리로 끝낸 비율 (z = 리그 평균 대비, |z|≥2만 강조)">리드 지킨 비율</th>
          <th title="앞선 적 있는 경기에서 놓친 승점 = Σ(3 − 얻은 승점)">놓친 승점</th>
          <th title="한 번이라도 뒤진 경기에서 얻은 경기당 승점">뒤진 경기 회복</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — K리그 공식 득점 기록(분+추가시간) · 리드·뒤짐 = 경기 중 한 번이라도 앞선/뒤진 경기(한 경기가 양쪽 다 해당 가능) · 리드 지킨 비율 = 그중 승리 비율, z = 리그 평균과의 이항 비교 · 놓친 승점 = Σ(3−얻은 승점) · 경기 종료는 95분(마지막 골이 더 늦으면 그 직후)으로 근사 · 득점 기록이 스코어와 맞는 경기만 · 상대 강도·퇴장 미보정이라 <b>참고용</b></div>`;
  }

  // ③ 득점 직후 실점 / 실점 후 반격
  function renderAftermath(list) {
    const el = document.getElementById("ins-aft-body"); if (!el) return;
    const zTxt = z => z == null ? `<span class="ins-rs-n">-</span>` : (Math.abs(z) >= 2 ? `<b>${z > 0 ? "▲" : "▼"} z=${z > 0 ? "+" : ""}${z.toFixed(1)}</b>` : `<span class="ins-rs-n">z=${z > 0 ? "+" : ""}${z.toFixed(1)}</span>`);
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const L = d.league_total;
      const rows = d.teams.map(t => t.eligible ? `<tr><td class="ins-xl-team">${escI(t.short)}</td><td>${t.scored}</td>
          <td>${t.conc_obs}<span class="ins-rs-n"> / 기대 ${t.conc_exp.toFixed(1)}</span></td><td>${zTxt(t.conc_z)}</td>
          <td>${t.conceded}</td><td>${t.resp_obs}<span class="ins-rs-n"> / 기대 ${t.resp_exp.toFixed(1)}</span></td><td>${zTxt(t.resp_z)}</td></tr>`
        : `<tr class="ins-xl-skip"><td class="ins-xl-team">${escI(t.short)}</td><td colspan="6" class="ins-adv-empty">표본 부족 (${d.min_games}경기 미만)</td></tr>`).join("");
      const gen = d.flagged.length ? `기대와 크게 다른 팀(|z|≥2): <b>${d.flagged.map(escI).join(", ")}</b> — 여러 팀을 동시에 보면 우연히도 나올 수 있어 참고용입니다.` : "기대와 크게 다른 팀은 없습니다 (모두 |z|&lt;2).";
      return `${insHead(d)}${insTake(takeAftermath(d))}${insWarn(d)}
        <div class="ins-rs-cmp">리그 전체: 득점 ${L.scored}골 중 ${d.window}분 안에 상대가 받아친 경우 <b>${L.conc_obs}</b>건 (평소 득실점률로 기대되는 <b>${L.conc_exp.toFixed(1)}</b>건) ${zTxt(L.conc_z)}</div>
        <div class="ins-rs-cmp">${gen}</div>
        <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>팀</th><th title="득점 횟수(자책골로 인정된 득점 포함)">득점</th>
          <th colspan="2" title="득점 후 ${d.window}분 안에 실점한 횟수 / 팀의 평소 실점률로 기대되는 횟수">득점 직후 실점</th><th title="실점 횟수">실점</th>
          <th colspan="2" title="실점 후 ${d.window}분 안에 득점한 횟수 / 팀의 평소 득점률로 기대되는 횟수">실점 직후 반격</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + `<div class="ins-method">근거 — 득점 직후=다음 ${list[0] && list[0].window || 10}분 · 기대=Σ(1−exp(−팀 평소 득실점률×남은 시간)) · z=(관측−기대)÷√기대, 기대 1.5건↑일 때만 계산 · ▲=기대보다 많음(실점은 취약, 반격은 강점)·▼=적음 · 경기 종료는 95분(마지막 골이 더 늦으면 그 직후)으로 근사 · 상대·시간대 강도 미보정이라 <b>참고용</b></div>`;
  }

  // ④ 패스 허브 의존도
  function renderPassHub(list) {
    const el = document.getElementById("ins-hub-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.teams) return `<div class="ins-adv-empty">데이터 없음</div>`;
      const POS = { GK: "GK", DF: "수비", MF: "미드", FW: "공격" };
      const rows = d.teams.map(t => {
        if (!t.eligible) return `<tr class="ins-xl-skip"><td class="ins-xl-team">${escI(t.short)}</td><td>${t.matches}</td><td colspan="3" class="ins-adv-empty">표본 부족 (${d.min_games}경기 미만)</td></tr>`;
        const m = t.main_hub;
        return `<tr><td class="ins-xl-team">${escI(t.short)}</td><td>${t.matches}</td><td><b>${t.hub_share}%</b> ${insBar(t.hub_share, 20)}</td><td>${t.top2_share}%</td>
          <td title="이 선수가 허브였던 경기 ${m.times}/${t.matches}">${escI(m.name)}${m.pos ? `<span class="ins-rs-n"> ${POS[m.pos] || escI(m.pos)}</span>` : ""} · ${m.pct}%</td><td>${t.hubs}명</td></tr>`;
      }).join("");
      return `${insHead(d)}${insVerdict(d.verdict)}${insTake(takePassHub(d))}
        <div class="ins-rs-cmp">리그 평균 허브 지분 <b>${d.league_hub_share ?? "-"}%</b> (한 선수가 팀 패스 관여의 몇 %를 차지하나 — 11명이 고르게 나누면 약 9%)</div>
        <div class="ins-rs-grid ins-rs-grid-2">
          <div><div class="ins-adv-sub-h">팀 평소 대비 허브 집중도별 성적 <span class="ins-clutch-hint">팀-경기 ${d.matches.toLocaleString()}건</span></div>${[d.hub_high, d.hub_low].map(insPpgRow).join("")}${insCmp(d.high_vs_low, "집중한 날", "분산된 날")}</div>
          <div class="ins-top-scroll"><table class="ins-table ins-xl-table"><thead><tr><th>팀</th><th title="패스 데이터가 있는 경기 수">경기</th><th title="경기별 1위 관여 선수의 (보낸+받은) 패스 관여 비중 평균 (막대 = 20% 기준)">허브 지분</th>
            <th title="관여 1·2위 선수 합">1·2위 합</th><th title="가장 자주 허브였던 선수와 그 비율">주 허브</th><th title="시즌 중 허브가 된 적 있는 서로 다른 선수 수 — 많을수록 허브가 자주 바뀜">허브 수</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>`;
    }).join("") + `<div class="ins-method">근거 — K리그 공식 패스 행렬(2023~) · 허브 지분=한 선수의 (보낸+받은) 패스 관여÷팀 총 관여(패스 1회=2관여) · 허브는 보통 센터백·수비형 미드(빌드업 거점) · 집중한 날=팀 평소보다 +2%p↑, 분산된 날=−2%p↓ · 점유율·상대 압박에 따라 달라져 <b>인과가 아님</b></div>`;
  }

  /* ── 데이터 기준일 배지 — SofaScore 의존 카드에 '마지막 수집일 · 미반영 경기 수' 표시 (P4 신뢰) ──
     빠진 경기가 없으면(과거 시즌·K2 등) 배지를 붙이지 않는다. 기준은 /api/data-freshness (리그 최신 종료 경기 대비). */
  const FRESH_CARDS = {
    // 값: 소스 키 또는 [소스 키, 탭 카드에서 해당하는 탭 이름]
    "ins-top-body": "mps", "ins-gk-body": "mps", "ins-duel-body": "mps", "ins-xgluck-body": "mps",
    "ins-subimp-body": ["mps", "팀별 교체 효과"], "ins-shooting-body": "shotmap", "ins-spp-body": "shotmap", "ins-weak-body": "shotmap",
  };
  const _freshCache = {};
  function md(d) { const p = (d || "").split("-"); return p.length === 3 ? `${+p[1]}/${+p[2]}` : (d || "?"); }
  function applyFreshBadges() {
    const year = currentYear, league = currentLeague;
    document.querySelectorAll(".ins-fresh").forEach(e => e.remove());   // 필터 변경 즉시 이전 기준 배지 제거(응답 전 잘못된 표시 방지)
    const get = _freshCache[year] || (_freshCache[year] = fetch(`/api/data-freshness?year=${year}`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null));
    get.then(d => {
      if (year !== currentYear || league !== currentLeague) return;      // 필터가 바뀐 뒤 늦게 온 응답은 버림
      document.querySelectorAll(".ins-fresh").forEach(e => e.remove());
      if (!d || !d.leagues) return;
      const lgs = league === "all" ? ["k1", "k2"] : [league];
      Object.entries(FRESH_CARDS).forEach(([bodyId, spec]) => {
        const [src, tabName] = Array.isArray(spec) ? spec : [spec, null];
        const parts = [], latest = [];
        lgs.forEach(lg => {
          const L = d.leagues[lg], s = L && L.sources && L.sources[src];
          if (s && s.missing > 0) {
            parts.push(`${lg.toUpperCase()} ${s.last ? md(s.last) + "까지" : "데이터 없음"} · 최근 ${s.missing}경기 미반영`);
            latest.push(`${lg.toUpperCase()} ${md(L.latest)}`);
          }
        });
        if (!parts.length) return;
        const head = bodyId === "ins-top-body"
          ? document.querySelector("#ins-panel-top .ins-block-title")
          : document.getElementById(bodyId)?.closest(".ins-adv-card")?.querySelector(".ins-adv-h");
        if (!head) return;
        const tip = `SofaScore 수집이 일부 차단되어 이후 경기가 이 카드 집계에 빠져 있습니다. 리그 최신 경기: ${latest.join(", ")}. K리그 공식 데이터로 전환 중입니다.`;
        const b = document.createElement("span");
        b.className = "ins-fresh";
        b.setAttribute("role", "note");
        b.setAttribute("tabindex", "0");
        b.setAttribute("aria-label", `데이터 기준: ${parts.join(", ")}. ${tip}`);
        b.title = tip;
        b.textContent = "⚠ " + (tabName ? `${tabName} 탭: ` : "") + parts.join(" / ");
        head.appendChild(b);
      });
    });
  }

  // ⓪ 리그 화제 포인트 — 규칙 기반 한 줄 해석 + 근거 수치 (팀 흐름 / 선수 발굴)
  const STORY_ICON = { rising: "📈", falling: "📉", win_streak: "🔥", unbeaten: "🛡️", clean_sheet: "🧱", scoring_run: "⚽",
    losing: "🥶", winless: "🕳️", fortress: "🏟️", road_warrior: "🚌", late_goals: "⏱️", player_rising: "🌟", player_gem: "💎" };
  function renderStorylines(list) {
    const el = document.getElementById("ins-story-body"); if (!el) return;
    el.innerHTML = list.map(d => {
      if (!d || !d.cards) return `<div class="ins-adv-empty">데이터 없음</div>`;
      if (!d.cards.length) return `${insHead(d)}<div class="ins-adv-empty">임계값을 넘는 화제 포인트가 아직 없습니다.</div>`;
      const card = c => `<li class="ins-story ins-story-${escI(c.kind)}">
          <span class="ins-story-ic" aria-hidden="true">${STORY_ICON[c.kind] || "•"}</span>
          <div class="ins-story-tx"><div class="ins-story-line">${escI(c.text)}</div><div class="ins-story-ev">${escI(c.evidence)}</div></div></li>`;
      const teams = d.cards.filter(c => !c.kind.startsWith("player_")), players = d.cards.filter(c => c.kind.startsWith("player_"));
      return `${insHead(d)}
        ${teams.length ? `<div class="ins-adv-sub-h">팀 흐름</div><ul class="ins-story-list">${teams.map(card).join("")}</ul>` : ""}
        ${players.length ? `<div class="ins-adv-sub-h">선수 발굴 <span class="ins-clutch-hint">공식 기록 기준</span></div><ul class="ins-story-list">${players.map(card).join("")}</ul>` : ""}
        <div class="ins-method">${escI(d.limits || "")}</div>`;
    }).join("");
  }

  function loadAdvanced() {
    const qs = `year=${currentYear}&league=${currentLeague}`;
    // 무음 실패 → 가시화: 실패한 인사이트명을 모아 1회 토스트 + console.warn (P5 견고성)
    const failed = [];
    const warn = name => e => { failed.push(name); console.warn("[insights] 로드 실패:", name, e); };
    const flushed = { v: false };
    const notify = () => { if (!flushed.v && failed.length && window.showToast) { flushed.v = true; window.showToast(`일부 인사이트를 불러오지 못했습니다: ${failed.join(", ")} (새로고침 해보세요)`); } };
    const xgLeagues = currentLeague === "all" ? ["k1", "k2"] : [currentLeague];
    Promise.allSettled([
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/storylines?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderStorylines).catch(warn("리그 화제 포인트")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/xg-luck?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderXgLuck).catch(warn("xG 운 보정")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/opponent-strength?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderOppStrength).catch(warn("상대 수준별 성적")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/formation-matchup?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderFormation).catch(warn("포메이션 상성")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/standings-trend?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderTrend).catch(warn("순위 추이")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/rest-effect?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderRestEffect).catch(warn("휴식일")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/substitution-impact?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderSubImpact).catch(warn("교체 효과")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/setpiece-profile?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderSetpieceProfile).catch(warn("세트피스")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/defensive-weakness?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderWeakness).catch(warn("실점 약점 지도")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/scoring-dependence?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderScoringDep).catch(warn("득점 의존도")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/rotation?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderRotation).catch(warn("선발 로테이션")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/game-state?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderGameState).catch(warn("경기 상황별 성적")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/goal-aftermath?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderAftermath).catch(warn("득점 직후 실점")),
      Promise.all(xgLeagues.map(lg => fetch(`/api/insights/pass-hub?year=${currentYear}&league=${lg}`).then(r => r.json())))
        .then(renderPassHub).catch(warn("패스 허브")),
      fetch(`/api/insights/clutch?${qs}`).then(r => r.json()).then(renderClutch).catch(warn("클러치")),
      fetch(`/api/insights/shooting?${qs}`).then(r => r.json()).then(renderShooting).catch(warn("슈팅")),
      fetch(`/api/insights/substitution?${qs}`).then(r => r.json()).then(renderSubstitution).catch(warn("교체")),
      fetch(`/api/insights/goalkeeper?${qs}`).then(r => r.json()).then(renderGoalkeeper).catch(warn("골키퍼")),
      fetch(`/api/insights/duels?${qs}`).then(r => r.json()).then(renderDuels).catch(warn("듀얼")),
    ]).then(notify);
  }

  /* ── 인사이트 탭 (랭킹 / 심화 / 규율) — 활성 탭만 지연 로드 ── */
  let _activeItab = "rank";
  let _itabLoaded = { rank: false, adv: false, discipline: false };
  function loadInsTab(tab) {
    if (tab === "rank" && !_itabLoaded.rank) { _itabLoaded.rank = true; loadTopPerformers(); }
    else if (tab === "adv" && !_itabLoaded.adv) { _itabLoaded.adv = true; loadAdvanced(); }
    else if (tab === "discipline" && !_itabLoaded.discipline) { _itabLoaded.discipline = true; loadCardRankings(); }
  }
  function initInsTabs() {
    document.querySelectorAll(".ins-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.itab;
        if (tab === _activeItab) return;
        _activeItab = tab;
        document.querySelectorAll(".ins-tab").forEach(b => b.classList.toggle("active", b === btn));
        document.querySelectorAll("[data-itab-panel]").forEach(p =>
          p.classList.toggle("hidden", p.dataset.itabPanel !== tab));
        loadInsTab(tab);
      });
    });
  }

  /* ── 카드 내부 탭 (교체 분석·경기 흐름) — 정적 HTML, 두 패널 모두 미리 로드되고 표시만 전환 ── */
  function initCardTabs() {
    document.querySelectorAll(".ins-ctabs").forEach(list => {
      const tabs = [...list.querySelectorAll(".ins-ctab")];
      const select = tab => tabs.forEach(t => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      tabs.forEach((t, i) => {
        t.addEventListener("click", () => select(t));
        t.addEventListener("keydown", e => {         // 좌우 화살표로 탭 이동 (WAI-ARIA 탭 패턴)
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          select(n); n.focus();
        });
      });
    });
  }

  /* ── 전체 로드 ── (필터 변경/최초) — 활성 탭만 로드, 나머지는 재방문 시 재로드 */
  function loadAll() {
    _itabLoaded = { rank: false, adv: false, discipline: false };
    loadInsTab(_activeItab);
    applyFreshBadges();   // 카드 머리말은 정적 HTML이라 탭 로드와 무관하게 바로 붙일 수 있다
  }

  function init() {
    // 토글 이벤트 — 인사이트 섹션 접기/펼치기 (첫 진입 friction 감소)
    const toggleBtn = document.getElementById("insights-toggle-btn");
    const section = document.getElementById("insights-section");
    let loaded = false;
    if (toggleBtn && section) {
      toggleBtn.addEventListener("click", () => {
        const collapsed = section.classList.toggle("insights-collapsed");
        toggleBtn.setAttribute("aria-expanded", String(!collapsed));
        if (!collapsed && !loaded) {
          // lazy load: 첫 펼침 시에만 API 호출
          initYearFilter();
          initInsTabs();
          initPosTab();
          initCardModeTab();
          initCardTabs();
          loadAll();
          loaded = true;
        }
      });
    } else {
      // 접기 UI 없으면 즉시 로드 (안전 fallback)
      initYearFilter();
      initInsTabs();
      initPosTab();
      initCardModeTab();
      initCardTabs();
      loadAll();
    }
    document.getElementById("drawer-close")?.addEventListener("click", closeDrawer);
    document.getElementById("player-drawer-overlay")?.addEventListener("click", closeDrawer);
    document.getElementById("drawer-full-analysis")?.addEventListener("click", () => {
        if (!currentDrawerPlayerId) return;
        closeDrawer();
        document.dispatchEvent(new CustomEvent("playerSelected", {
            detail: { playerId: currentDrawerPlayerId }
        }));
    });
  }

  // 드로어 열기 (외부에서 호출)
  window.openPlayerDrawer = openDrawer;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
