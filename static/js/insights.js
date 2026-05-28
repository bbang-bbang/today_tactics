/* insights.js — 포지션별 인사이트 섹션 */
(function () {
  "use strict";

  let currentYear = "2026";
  let currentLeague = "all";  // "all" | "k1" | "k2"
  let currentPos = "F";

  // 포지션별 다중 정렬 상태: [{ key, dir }, ...] 우선순위 순
  const sortState = {
    F: [{ key: "goals", dir: -1 }],
    M: [{ key: "pass_acc", dir: -1 }],
    D: [{ key: "def_score_p90", dir: -1 }],
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

  // 정렬 컬럼 정의
  const SORT_COLS = {
    F: [
      { label: "#",        key: null },
      { label: "선수",      key: "name" },
      { label: "구단",      key: "team" },
      { label: "경기",      key: "games" },
      { label: "총 골",     key: "goals" },
      { label: "PK",       key: "pk_goals" },
      { label: "PK제외",   key: "np_goals" },
      { label: "PK제외/90",key: "np_goals_p90" },
      { label: "xG효율",   key: "xg_eff" },
      { label: "평점",      key: "rating" },
    ],
    M: [
      { label: "#",        key: null },
      { label: "선수",      key: "name" },
      { label: "구단",      key: "team" },
      { label: "경기",      key: "games" },
      { label: "패스성공률", key: "pass_acc" },
      { label: "패스/90",  key: "passes_p90" },
      { label: "태클/90",  key: "tackles_p90" },
      { label: "평점",      key: "rating" },
    ],
    D: [
      { label: "#",        key: null },
      { label: "선수",      key: "name" },
      { label: "구단",      key: "team" },
      { label: "경기",      key: "games" },
      { label: "수비점수/90", key: "def_score_p90" },
      { label: "태클/90",  key: "tackles_p90" },
      { label: "클리어/90", key: "clearances_p90" },
      { label: "평점",      key: "rating" },
    ],
  };

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

  /* ── 포지션 탭 ── */
  function initPosTab() {
    document.querySelectorAll(".ins-pos-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ins-pos-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentPos = btn.dataset.pos;
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
        const hasData = (data.F?.length || data.M?.length || data.D?.length) > 0;
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
        else cmp = bv - av;         // 기본 내림차순 기준
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
      return `<th class="ins-th-sort${active ? " ins-th-active" : ""}" data-key="${col.key}">
        ${col.label}${priority}${active ? ` <span class="ins-sort-arrow">${arrow}</span>` : hint}
      </th>`;
    });
    return `<thead><tr>${ths.join("")}</tr></thead>`;
  }

  function renderTopTable(data) {
    const body = document.getElementById("ins-top-body");
    if (!body || !data) return;
    const raw = data[currentPos] || [];
    if (!raw.length) { body.innerHTML = '<p class="ins-empty">데이터 없음</p>'; return; }

    const rows = sortRows(raw, sortState[currentPos]);

    let tbody = "";
    if (currentPos === "F") {
      rows.forEach((r, i) => {
        const eff = r.xg_eff != null ? `${r.xg_eff > 1 ? "+" : ""}${(r.xg_eff - 1).toFixed(2)}` : "-";
        const effClass = r.xg_eff > 1 ? "ins-pos" : r.xg_eff < 1 ? "ins-neg" : "";
        tbody += `<tr>
          <td class="ins-rank">${i + 1}</td><td class="ins-name">${r.name}</td>
          <td class="ins-team">${r.team || "-"}</td>
          <td>${r.games}</td><td>${r.goals}</td>
          <td class="ins-team">${r.pk_goals > 0 ? r.pk_goals : "-"}</td>
          <td><strong>${r.np_goals}</strong></td>
          <td>${r.np_goals_p90}</td>
          <td class="${effClass}">${eff}</td><td>${r.rating ?? "-"}</td>
        </tr>`;
      });
    } else if (currentPos === "M") {
      rows.forEach((r, i) => {
        tbody += `<tr>
          <td class="ins-rank">${i + 1}</td><td class="ins-name">${r.name}</td>
          <td class="ins-team">${r.team || "-"}</td>
          <td>${r.games}</td><td><strong>${r.pass_acc ?? "-"}%</strong></td>
          <td>${r.passes_p90}</td><td>${r.tackles_p90}</td><td>${r.rating ?? "-"}</td>
        </tr>`;
      });
    } else if (currentPos === "D") {
      rows.forEach((r, i) => {
        tbody += `<tr>
          <td class="ins-rank">${i + 1}</td><td class="ins-name">${r.name}</td>
          <td class="ins-team">${r.team || "-"}</td>
          <td>${r.games}</td><td><strong>${r.def_score_p90}</strong></td>
          <td>${r.tackles_p90}</td><td>${r.clearances_p90}</td><td>${r.rating ?? "-"}</td>
        </tr>`;
      });
    }

    body.innerHTML = `<table class="ins-table">${buildThead(currentPos)}<tbody>${tbody}</tbody></table>`;

    // 헤더 클릭 → 다중 정렬
    // 첫 클릭: 추가(내림차순), 재클릭: 오름차순, 한번 더: 제거
    body.querySelectorAll(".ins-th-sort").forEach(th => {
      th.addEventListener("click", () => {
        const key  = th.dataset.key;
        const sorts = sortState[currentPos];
        const idx  = sorts.findIndex(s => s.key === key);
        if (idx === -1) {
          // 새로 추가 (내림차순)
          sorts.push({ key, dir: -1 });
        } else if (sorts[idx].dir === -1) {
          // 오름차순으로 변경
          sorts[idx].dir = 1;
        } else {
          // 제거
          sorts.splice(idx, 1);
          // 제거 후 뒤 항목들 재번호는 자동
        }
        renderTopTable(window._insTopData);
      });
    });

    // 행 클릭 → 드로어 열기
    body.querySelectorAll("tbody tr").forEach((tr, i) => {
      const r = rows[i];
      tr.classList.add("ins-row-clickable");
      tr.addEventListener("click", () => openDrawer(r.player_id, currentPos));
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
  let currentCardLeague = "all";     // 카드 패널 전용 — 전역 currentLeague와 독립
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

  function initCardLeagueTab() {
    document.querySelectorAll(".ins-card-league-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.cardLeague === currentCardLeague) return;
        document.querySelectorAll(".ins-card-league-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentCardLeague = btn.dataset.cardLeague;
        loadCardRankings();
      });
    });
  }

  function loadCardRankings() {
    return fetch(`/api/insights/card-rankings?year=${currentYear}&league=${currentCardLeague}`)
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
      return `<th class="ins-th-sort${active ? " ins-th-active" : ""}" data-key="${col.key}">
        ${col.label}${priority}${active ? ` <span class="ins-sort-arrow">${arrow}</span>` : hint}
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

  /* ── xG 효율 리더보드 ── */
  let currentXgLeague = "all";
  let currentXgMode   = "diff";   // diff | goals | xg
  let _xgCache = null;

  function initXgModeTab() {
    document.querySelectorAll(".ins-xg-mode-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.mode === currentXgMode) return;
        document.querySelectorAll(".ins-xg-mode-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentXgMode = btn.dataset.mode;
        if (_xgCache) renderXg(_xgCache);
      });
    });
  }
  function initXgLeagueTab() {
    document.querySelectorAll(".ins-xg-league-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.xgLeague === currentXgLeague) return;
        document.querySelectorAll(".ins-xg-league-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentXgLeague = btn.dataset.xgLeague;
        loadXgLeaders();
      });
    });
  }
  function loadXgLeaders() {
    return fetch(`/api/insights/xg-efficiency?year=${currentYear}&league=${currentXgLeague}`)
      .then(r => r.json())
      .then(d => {
        _xgCache = Array.isArray(d) ? d : [];
        showBlock("ins-panel-xg", _xgCache.length > 0);
        renderXg(_xgCache);
      });
  }
  function renderXg(rows) {
    const wrap = document.getElementById("ins-xg-body");
    if (!wrap) return;
    if (!rows.length) { wrap.innerHTML = '<p class="ins-empty">데이터 없음</p>'; return; }
    const sorted = [...rows].sort((a, b) => {
      if (currentXgMode === "diff")  return b.diff - a.diff;
      if (currentXgMode === "goals") return b.goals - a.goals;
      return b.xg - a.xg;
    }).slice(0, 15);
    const tbody = sorted.map((r, i) => {
      const diffCls = r.diff >= 0 ? "ins-pos" : "ins-neg";
      const sign    = r.diff > 0 ? "+" : "";
      return `
        <tr>
          <td class="ins-rank">${i+1}</td>
          <td class="ins-name">${r.name}</td>
          <td class="ins-team-cell">${r.team || "—"}</td>
          <td>${r.games}</td>
          <td><strong>${r.goals}</strong>${r.pk_goals > 0 ? ` <span class="ins-sub">(NP ${r.np_goals})</span>` : ""}</td>
          <td>${r.xg}</td>
          <td class="${diffCls}"><strong>${sign}${r.diff}</strong></td>
          <td>${r.shots}</td>
        </tr>`;
    }).join("");
    const modeNote = currentXgMode === "diff"  ? "결정력(G−xG) 내림차순. + = xG 대비 초과 득점 (마무리 능력)."
                   : currentXgMode === "goals" ? "절대 득점 내림차순."
                   : "절대 xG(슈팅 질) 내림차순.";
    wrap.innerHTML = `
      <table class="ins-table">
        <thead><tr>
          <th>#</th><th>선수</th><th>팀</th><th>경기</th>
          <th>G</th><th>xG</th><th>G−xG</th><th>슈팅</th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
      <div class="ins-card-foot">${modeNote} TOP 15. 조건: 포지션 F · 출전 ≥3경기 · xG ≥0.5.</div>
    `;
  }

  /* ── 전체 로드 ── */
  function loadAll() {
    loadTopPerformers();
    loadXgLeaders();
    loadCardRankings();
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
          initPosTab();
          initCardModeTab();
          initCardLeagueTab();
          initXgModeTab();
          initXgLeagueTab();
          loadAll();
          loaded = true;
        }
      });
    } else {
      // 접기 UI 없으면 즉시 로드 (안전 fallback)
      initYearFilter();
      initPosTab();
      initCardModeTab();
      initCardLeagueTab();
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
