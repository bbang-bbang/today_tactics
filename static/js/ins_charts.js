// 인사이트 심화 탭 — 카드 정의(CARDS) + 카드별 차트 빌더 (spec §5.1, Phase 1a)
// 빌더는 순수 함수: API 응답 1개(한 리그) → TTChart.presets 입력 → spec. 새 통계를 계산하지 않고
// API 값의 표시 변환(필터·정렬·부호·가중평균 기준선)만 한다. 라벨은 평문 문자열(Canvas/TERA 가 그림).
(function (root) {
  "use strict";
  const TT = root.TTChart || (typeof require === "function" ? require("./tt_charts.js") : null);
  const P = TT.presets, THEME = TT.THEME;
  const r2 = (v) => Math.round(v * 100) / 100;
  const elig = (d) => ((d && d.teams) || []).filter((t) => t.eligible !== false);

  // ── 카드 정의 ── (index.html 심화 패널의 기존 body id·제목·설명을 그대로 옮김)
  // 순서·크기: 테마 안에서 L+S / M+M 짝으로 12열을 채운다(dense 미사용 → DOM 순서 = 화면 순서 = Tab 순서)
  const CARDS = [
    { key: "trend", bodyId: "ins-trend-body", size: "L", theme: "flow", icon: "📈", title: "라운드별 순위 추이", question: "시즌 내내 순위가 어떻게 움직였나? 선두 교체·최근 상승/하락 팀", endpoint: "standings-trend", perLeague: true, render: "renderTrend", chart: true },
    { key: "story", bodyId: "ins-story-body", size: "S", theme: "flow", icon: "📰", title: "리그 화제 포인트", question: "지금 흐름이 좋은 팀·나쁜 팀, 진행 중인 기록, 눈여겨볼 선수", endpoint: "storylines", perLeague: true, render: "renderStorylines", chart: false },
    { key: "xgluck", bodyId: "ins-xgluck-body", size: "M", theme: "flow", icon: "🍀", title: "xG 운 보정", question: "실력(xG)만큼 승점을 땄나? 실제 vs 기대 승점", endpoint: "xg-luck", perLeague: true, render: "renderXgLuck", chart: true },
    { key: "opp", bodyId: "ins-opp-body", size: "M", theme: "flow", icon: "🧗", title: "상대 수준별 성적", question: "상위·중위·하위권 상대로 각각 얼마나 따나? 강팀 킬러·승점 흘리는 팀", endpoint: "opponent-strength", perLeague: true, render: "renderOppStrength", chart: true },
    { key: "sim", bodyId: "ins-sim-body", size: "M", theme: "flow", icon: "🎲", title: "시즌 시뮬레이션 — 최종 순위 확률", question: "남은 경기를 500번 시뮬레이션하면 몇 위로 끝나나? (칸 숫자 = 확률 %)", endpoint: "season-simulation", url: (lg) => `/api/season-simulation?league=${lg}&n=500`, perLeague: true, render: "renderSim", chart: true },
    { key: "weather", bodyId: "ins-wx-body", size: "M", theme: "flow", icon: "🌦", title: "날씨 영향", question: "기온·비·바람이 득점과 홈 승률을 바꾸나? 통계적으로 확실할 때만 말함", endpoint: "weather-effect", perLeague: false, render: "renderWeather", chart: true },
    { key: "formation", bodyId: "ins-fm-body", size: "L", theme: "tactics", icon: "♟️", title: "포메이션 상성", question: "내 포메이션이 상대 포메이션을 만나면? 경기당 승점 (표본 부족 칸은 비움)", endpoint: "formation-matchup", perLeague: true, render: "renderFormation", chart: true },
    { key: "hub", bodyId: "ins-hub-body", size: "S", theme: "tactics", icon: "🕸️", title: "패스 허브 의존도", question: "팀 패스가 한 선수에게 얼마나 몰리나?", endpoint: "pass-hub", perLeague: true, render: "renderPassHub", chart: true },
    { key: "gs", bodyId: "ins-gs-body", size: "M", theme: "tactics", icon: "🎢", title: "경기 상황별 성적", question: "앞서면 지켜내나, 뒤지면 따라가나?", endpoint: "game-state", perLeague: true, render: "renderGameState", chart: true },
    { key: "pv", bodyId: "ins-pv-body", size: "M", theme: "tactics", icon: "🔁", title: "패스량과 결과", question: "앞설 때 패스를 줄이고, 뒤질 때 늘리나? (평소 대비 %)", endpoint: "pass-volume", perLeague: true, render: "renderPassVolume", chart: true },
    { key: "aft", bodyId: "ins-aft-body", size: "F", theme: "tactics", icon: "⚡", title: "득점 직후 실점·반격", question: "골 넣은 직후 10분, 무너지나 몰아치나?", endpoint: "goal-aftermath", perLeague: true, render: "renderAftermath", chart: true },
    { key: "subimp", bodyId: "ins-subimp-body", size: "M", theme: "squad", icon: "🔁", title: "팀별 교체 효과", question: "첫 전술 교체 뒤 15분 득실이 리그 평균보다 나아지나?", endpoint: "substitution-impact", perLeague: true, render: "renderSubImpact", chart: true },
    { key: "rest", bodyId: "ins-rest-body", size: "M", theme: "squad", icon: "😴", title: "휴식일·연전 영향", question: "짧은 휴식·밀집 일정이 정말 성적을 떨어뜨리나?", endpoint: "rest-effect", perLeague: true, render: "renderRestEffect", chart: true },
    { key: "rot", bodyId: "ins-rot-body", size: "M", theme: "squad", icon: "🔀", title: "선발 로테이션", question: "직전 경기와 선발이 얼마나 바뀌나, 성적과 관계는?", endpoint: "rotation", perLeague: true, render: "renderRotation", chart: true },
    { key: "sdep", bodyId: "ins-sdep-body", size: "M", theme: "squad", icon: "🎯", title: "득점 의존도", question: "득점의 몇 %를 1·2위 득점자가 만드나? 에이스가 빠지면?", endpoint: "scoring-dependence", perLeague: true, render: "renderScoringDep", chart: true },
    { key: "sub", bodyId: "ins-sub-body", size: "M", theme: "squad", icon: "🦸", title: "슈퍼서브·교체 시점", question: "누가 벤치에서 터지나? 언제 바꾸나?", endpoint: "substitution", perLeague: false, render: "renderSubstitution", chart: false },
    { key: "clutch", bodyId: "ins-clutch-body", size: "M", theme: "squad", icon: "⏱️", title: "승부처 해결사", question: "막판·결정적 순간에 누가 넣나?", endpoint: "clutch", perLeague: false, render: "renderClutch", chart: false },
    { key: "spp", bodyId: "ins-spp-body", size: "M", theme: "setpiece", icon: "⛳", title: "세트피스 공수 프로필", question: "코너·프리킥·스로인 (PK 제외) — 만든 것 vs 허용한 것", endpoint: "setpiece-profile", perLeague: true, render: "renderSetpieceProfile", chart: true },
    { key: "weak", bodyId: "ins-weak-body", size: "M", theme: "setpiece", icon: "🛡️", title: "실점 약점 지도", question: "허용 슈팅이 어느 지역·어떤 상황으로 쏠리나?", endpoint: "defensive-weakness", perLeague: true, render: "renderWeakness", chart: true },
    { key: "shooting", bodyId: "ins-shooting-body", size: "S", theme: "setpiece", icon: "🎯", title: "슈팅 인사이트", question: "어디서, 얼마나 정확하게 차나?", endpoint: "shooting", perLeague: false, render: "renderShooting", chart: false },
    { key: "gk", bodyId: "ins-gk-body", size: "S", theme: "setpiece", icon: "🧤", title: "수문장 (골키퍼)", question: "누가 가장 많이 막아 내나?", endpoint: "goalkeeper", perLeague: false, render: "renderGoalkeeper", chart: false },
    { key: "duel", bodyId: "ins-duel-body", size: "S", theme: "setpiece", icon: "⚔️", title: "듀얼 지배", question: "경합에서 누가 이기나?", endpoint: "duels", perLeague: false, render: "renderDuels", chart: false },
  ];
  const THEMES = [
    { key: "all", label: "전체" },
    { key: "flow", label: "흐름·운", desc: "시즌 순위 흐름과 행운·환경 요인" },
    { key: "tactics", label: "전술", desc: "포메이션·패스·경기 상황별 운영" },
    { key: "squad", label: "스쿼드 운용", desc: "교체·로테이션·득점 의존도·승부처" },
    { key: "setpiece", label: "세트피스·수비", desc: "세트피스·슈팅·실점 약점·골키퍼·듀얼" },
  ];

  // ── 빌더 ──
  function trend(d, colorOf) {
    const teams = (d && d.teams) || [];
    if (!teams.length) return P.bump({ rounds: (d && d.rounds) || [], teams: [], nTeams: 0 });
    const byRank = teams.slice().sort((a, b) => a.rank - b.rank);
    const highlight = byRank.slice(0, 3).concat(byRank.slice(-2)).map((t) => t.id);
    return P.bump({
      rounds: d.rounds, nTeams: teams.length, highlight,
      teams: teams.map((t) => ({ id: t.id, short: t.short, color: colorOf(t.short), ranks: t.ranks })),
    });
  }

  function xgluck(d) {
    return P.quadrant({
      points: elig(d).map((t) => ({ id: t.id, label: t.short, x: t.xppg, y: t.ppg, color: t.primary })),
      xTitle: "기대 승점 (xPPG)", yTitle: "실제 승점 (PPG)", diagonal: true,
      quadrantLabels: ["↖ 행운 (기대 이상)", "", "", "불운 (기대 이하) ↘"],
    });
  }

  function opp(d) {
    const ts = elig(d).slice().sort((a, b) => a.rank_actual - b.rank_actual);
    const KEYS = ["top", "mid", "bottom"];
    return P.heatMatrix({
      rows: ts.map((t) => t.short), cols: ["상위권", "중위권", "하위권"], colorTitle: "PPG", center: d.league_ppg,
      values: ts.map((t) => KEYS.map((k) => {
        const c = t.tiers && t.tiers[k];
        return c && c.n >= (d.tier_min || 0) ? c.ppg : null;
      })),
    });
  }

  function formation(d) {
    const fs = ((d && d.formations) || []).slice().sort((a, b) => b.n - a.n).slice(0, 6).map((f) => f.formation);
    const ms = (d && d.matchups) || [];
    if (!fs.length || !ms.length) return P.heatMatrix({ rows: [], cols: [], values: [] });
    const nSum = ms.reduce((s, m) => s + m.n, 0);
    const center = nSum ? r2(ms.reduce((s, m) => s + m.ppg * m.n, 0) / nSum) : undefined;
    return P.heatMatrix({
      rows: fs, cols: fs, colorTitle: "PPG", center,
      values: fs.map((f) => fs.map((o) => {
        const m = ms.find((x) => x.formation === f && x.opp === o);
        return m && m.n >= d.min_cell ? m.ppg : null;
      })),
    });
  }

  function gs(d) {
    const min = (d && d.min_games) || 0;
    const ts = elig(d).filter((t) => t.led && t.trailed && t.led.n >= min && t.trailed.n >= min)
      .map((t) => ({ short: t.short, lead: (3 * t.led.w + t.led.d) / t.led.n, trail: t.trailed.ppg }))
      .sort((a, b) => b.lead - a.lead);
    return P.dumbbell({
      categories: ts.map((t) => t.short),
      a: { name: "뒤질 때 PPG", color: THEME.neg, data: ts.map((t) => t.trail) },
      b: { name: "앞설 때 PPG", color: THEME.pos, data: ts.map((t) => t.lead) },
    });
  }

  function pv(d) {
    const ts = ((d && d.teams) || []).filter((t) => t.lead_dev != null && t.trail_dev != null)
      .sort((a, b) => b.avg_passes - a.avg_passes);
    return P.dumbbell({
      categories: ts.map((t) => t.short), decimals: 1,
      a: { name: "뒤질 때 패스 변화 %", color: THEME.neg, data: ts.map((t) => t.trail_dev) },
      b: { name: "앞설 때 패스 변화 %", color: THEME.pos, data: ts.map((t) => t.lead_dev) },
    });
  }

  function subimp(d) {
    const rows = ((d && d.teams) || []).map((t) => {
      const ins = t.z == null;
      return { label: t.short, est: t.vs_league, lo: ins ? null : t.vs_league - t.ci, hi: ins ? null : t.vs_league + t.ci,
        n: t.n, significant: !!t.significant, insufficient: ins };
    }).sort((a, b) => (a.insufficient - b.insufficient) || (b.est - a.est));
    return P.forest({ rows, zero: 0, zeroLabel: "리그 평균", unit: "골" });
  }

  function rest(d) {
    const bs = (d && d.buckets) || [], cs = (d && d.congestion) || [];
    const n = bs.reduce((s, b) => s + b.n, 0);
    const zero = n ? r2(bs.reduce((s, b) => s + b.ppg * b.n, 0) / n) : 0;
    const row = (pfx) => (b) => ({ label: `${pfx} · ${b.label}`, est: b.ppg, lo: b.ppg - b.ci, hi: b.ppg + b.ci, n: b.n, insufficient: b.n < 20 });
    return P.forest({ rows: bs.map(row("간격")).concat(cs.map(row("연전"))), zero, zeroLabel: "전체 평균", unit: "PPG" });
  }

  function spp(d, colorOf) {
    const k = d && d.xg_ok ? "xg_pg" : "shots_pg";
    const ts = elig(d).filter((t) => t.for && t.against && t.for[k] != null && t.against[k] != null);
    if (!ts.length) return P.quadrant({ points: [] });
    const mean = (a) => r2(a.reduce((s, v) => s + v, 0) / a.length);
    return P.quadrant({
      points: ts.map((t) => ({ id: t.id, label: t.short, x: t.for[k], y: t.against[k], color: colorOf(t.short) })),
      xTitle: `만든 세트피스 ${d.metric}/경기`, yTitle: `허용 세트피스 ${d.metric}/경기`,
      xMid: mean(ts.map((t) => t.for[k])), yMid: mean(ts.map((t) => t.against[k])),
      quadrantLabels: ["", "↗ 공격↑ 수비 약함", "↙ 둘 다 적음", "↘ 공격↑ 수비 탄탄"],
    });
  }

  // ── Phase 1b ──
  function weather(d) {
    const G = (d && d.groups) || {};
    const PFX = { temp: "기온", precip: "강수", wind: "바람" };
    const rows = ["temp", "precip", "wind"].flatMap((k) => (G[k] || []).map((r) => {
      const ins = r.goals_resid == null || r.goals_ci == null;
      return { label: `${PFX[k]} · ${r.label}`, est: r.goals_resid, lo: ins ? null : r.goals_resid - r.goals_ci,
        hi: ins ? null : r.goals_resid + r.goals_ci, n: r.n, significant: !!r.goals_diff, insufficient: ins };
    }));
    return P.forest({ rows, zero: 0, zeroLabel: "리그 평균", unit: "경기당 골(평균 대비)" });
  }

  // 실점 약점 지도 — 팀 1개: 약점 구역이 있는 첫 팀(없으면 첫 eligible 팀)
  function weak(d) {
    const ts = elig(d);
    const t = ts.find((x) => (x.weak || []).length) || ts[0];
    if (!t || !(d.zones_geom || []).length) return P.pitchZones({ geom: [] });
    const label = {}; (d.zones || []).forEach((z) => { label[z.key] = z.label; });
    const values = {};
    Object.keys(label).forEach((k) => {
      const v = t.zones && t.zones[k];
      values[k] = v ? { label: label[k], share: v.share, lg_share: v.lg_share, z: v.z } : null;
    });
    return P.pitchZones({ geom: d.zones_geom, values, labels: label, title: `${t.short} — 허용 슈팅 지역 비중` });
  }

  function sdep(d) {
    const ts = elig(d).filter((t) => t.top1_share != null && t.top2_share != null).sort((a, b) => b.top1_share - a.top1_share);
    return P.stacked100({ categories: ts.map((t) => t.short), parts: [
      { name: "1위 득점자", color: THEME.accent, data: ts.map((t) => t.top1_share) },
      { name: "2위 득점자", color: "#f59e0b", data: ts.map((t) => r2(t.top2_share - t.top1_share)) },
      { name: "나머지", color: THEME.neutral, data: ts.map((t) => r2(100 - t.top2_share)) }] });
  }

  function rot(d) {
    const ts = elig(d).filter((t) => (t.timeline || []).length).sort((a, b) => b.avg_changes - a.avg_changes);
    return P.timelineGrid({ vMax: 11, legend: "칸 진하기 = 선발 교체 수 · W 승 · D 무 · L 패",
      rows: ts.map((t) => ({ label: t.short, cells: t.timeline.map((c) => ({ v: c.changes, mark: c.pts === 3 ? "W" : c.pts === 1 ? "D" : "L" })) })) });
  }

  function aft(d) {
    const f = (d && d.league_total && d.league_total.flow) || {};
    return P.sankey({ nodes: ["득점", "추가골만", "실점만", "둘 다", "변화 없음"],
      colors: { "득점": THEME.accent, "추가골만": THEME.pos, "실점만": THEME.neg, "둘 다": "#f59e0b", "변화 없음": THEME.neutral },
      links: [["추가골만", "extra_only"], ["실점만", "conc_only"], ["둘 다", "both"], ["변화 없음", "none"]]
        .map(([tgt, k]) => ({ source: "득점", target: tgt, value: f[k] || 0 })) });
  }

  function hub(d) {
    const ts = elig(d).filter((t) => t.hub_share != null).sort((a, b) => b.hub_share - a.hub_share);
    return P.barRef({ categories: ts.map((t) => t.short), values: ts.map((t) => t.hub_share), name: "허브 1인 패스 지분",
      ref: d.league_hub_share, refLabel: "리그 평균", unit: "%" });
  }

  // 시즌 시뮬레이션: 팀 × 최종 순위 확률(%) — 0% 칸은 비워 노이즈를 줄인다
  function sim(d) {
    if (!d || !d.ready || !(d.teams || []).length) return { __empty: true };
    const n = d.n_teams || d.teams.length, runs = d.n_simulations || 1;
    return P.heatMatrix({
      rows: d.teams.map((t) => t.name), cols: Array.from({ length: n }, (_, i) => `${i + 1}위`),
      values: d.teams.map((t) => Array.from({ length: n }, (_, i) => {
        const v = Math.round(((t.position_dist || [])[i] || 0) / runs * 100);
        return v > 0 ? v : null;
      })),
      colorTitle: "%", decimals: 0,
    });
  }

  const InsCharts = { CARDS, THEMES, sim, trend, xgluck, opp, formation, gs, pv, subimp, rest, spp, weather, weak, sdep, rot, aft, hub };
  root.InsCharts = InsCharts;
  if (typeof module !== "undefined" && module.exports) module.exports = InsCharts;
})(typeof globalThis !== "undefined" ? globalThis : this);
