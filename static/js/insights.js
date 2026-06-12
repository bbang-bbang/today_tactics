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
    if (col.key === "name") return `<td class="ins-name">${r.name}</td>`;
    if (col.key === "team") return `<td class="ins-team">${r.team || "-"}</td>`;
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
        <div class="ins-cat-leader"><span class="ins-pos-badge ins-pos-${r.pos}">${POS_BADGE[r.pos] || "-"}</span> ${r.name}</div>
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
          <td class="ins-team">${m.opponent}</td>
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
          <td class="ins-name">${r.team}</td>
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
              <td class="ins-name">${r.name}</td>
              <td class="ins-team">${r.team || "-"}</td>
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
              <td class="ins-name">${r.name}</td>
              <td class="ins-team">${r.team || "-"}</td>
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
     심화 인사이트 — 날씨 · 승부처 · 폼 · 활동량
  ══════════════════════════════════════════════════ */
  function renderWeather(d) {
    const el = document.getElementById("ins-weather-body"); if (!el) return;
    const tb = d.temp_buckets || [];
    const rows = tb.map(b =>
      `<tr><td>${b.label}</td><td>${b.games}</td><td>${b.rating ?? "-"}</td><td><strong>${b.gpm ?? "-"}</strong></td></tr>`).join("");
    const hot = (d.hot_top || []).slice(0, 4).map((p, i) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${p.name}</span><span class="ins-adv-sub">${p.team}</span><b>${p.rating}</b></li>`).join("");
    el.innerHTML =
      `<table class="ins-adv-tbl"><thead><tr><th>기온</th><th>경기</th><th>평점</th><th>경기당 골</th></tr></thead><tbody>${rows}</tbody></table>
       <div class="ins-adv-sub-h">🔥 더위(≥25°C) 강자</div><ol class="ins-adv-list">${hot || '<li class="ins-adv-empty">표본 부족</li>'}</ol>
       <div class="ins-method">근거 — 경기 당시 실측 기상(Open-Meteo) · 경기당 골=양 팀 합/경기 · 강자=더위 3경기↑ 평균 평점순</div>`;
  }
  function renderClutch(d) {
    const el = document.getElementById("ins-clutch-body"); if (!el) return;
    const dec = (d.decisive_top || []).slice(0, 5).map((p, i) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${p.name}</span><span class="ins-adv-sub">${p.team} · 결승 ${p.gwg}·동점 ${p.eq}</span><b>${p.total}</b></li>`).join("");
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
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${p.name}</span><span class="ins-adv-sub">${p.team}</span><b>${p.goals}골</b></li>`).join("");
    const fq = (d.frequent || []).slice(0, 5).map((p, i) =>
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${p.name}</span><span class="ins-adv-sub">${p.team}</span><b>${p.count}회</b></li>`).join("");
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
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${p.name}</span><span class="ins-adv-sub">${p.team}${sub ? " · " + sub : ""}</span><b>${metric}</b></li>`;
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
      `<li><span class="ins-adv-rank">${i + 1}</span><span class="ins-adv-nm">${p.name}</span><span class="ins-adv-sub">${p.team}${sub ? " · " + sub : ""}</span><b>${metric}</b></li>`;
    const empty = '<li class="ins-adv-empty">데이터 없음</li>';
    const dr = (d.dribble_top || []).slice(0, 5).map((p, i) => row(p, i, `${p.success}회`, `성공률 ${p.rate}%`)).join("");
    const ae = (d.aerial_top || []).slice(0, 5).map((p, i) => row(p, i, `${p.won}승`, `승률 ${p.rate}%`)).join("");
    el.innerHTML =
      `<div class="ins-adv-sub-h">🏃 돌파 (드리블 성공) <span class="ins-clutch-hint">시도 20+</span></div><ol class="ins-adv-list">${dr || empty}</ol>
       <div class="ins-adv-sub-h">🛫 공중 지배 <span class="ins-clutch-hint">공중볼 30+</span></div><ol class="ins-adv-list">${ae || empty}</ol>
       <div class="ins-method">근거 — 돌파=드리블 성공 합 · 공중=공중볼 경합 승 · 성공률/승률 병기 · 최소 표본 필터(드리블 20·공중 30)</div>`;
  }
  function loadAdvanced() {
    const qs = `year=${currentYear}&league=${currentLeague}`;
    fetch(`/api/insights/weather?${qs}`).then(r => r.json()).then(renderWeather).catch(() => {});
    fetch(`/api/insights/clutch?${qs}`).then(r => r.json()).then(renderClutch).catch(() => {});
    fetch(`/api/insights/shooting?${qs}`).then(r => r.json()).then(renderShooting).catch(() => {});
    fetch(`/api/insights/substitution?${qs}`).then(r => r.json()).then(renderSubstitution).catch(() => {});
    fetch(`/api/insights/goalkeeper?${qs}`).then(r => r.json()).then(renderGoalkeeper).catch(() => {});
    fetch(`/api/insights/duels?${qs}`).then(r => r.json()).then(renderDuels).catch(() => {});
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

  /* ── 전체 로드 ── (필터 변경/최초) — 활성 탭만 로드, 나머지는 재방문 시 재로드 */
  function loadAll() {
    _itabLoaded = { rank: false, adv: false, discipline: false };
    loadInsTab(_activeItab);
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
