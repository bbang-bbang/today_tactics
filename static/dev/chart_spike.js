// Phase 0 게이트 판정용 실데이터 스파이크 (analysis/verify_tt_charts.py check_spike_*)
(async function () {
  const Q = "year=2026&league=K1";
  const get = (p) => fetch(`/api/insights/${p}?${Q}`).then((r) => r.json());
  const results = {};
  window.__spikeResults = results;

  const [st, xg, rest, opp, gs, sdep, hub, aft] = await Promise.all(
    ["standings-trend", "xg-luck", "rest-effect", "opponent-strength", "game-state",
     "scoring-dependence", "pass-hub", "goal-aftermath"].map(get));

  const colorOf = {};
  (xg.teams || []).forEach((t) => { colorOf[t.short] = t.primary; });
  const col = (short) => colorOf[short] || TTChart.THEME.neutral;
  const xgOk = (xg.teams || []).filter((t) => t.eligible);

  // KPI 줄 + 칩
  const top = (st.teams || [])[0] || {};
  const lucky = xgOk.slice().sort((a, b) => b.luck_ppg - a.luck_ppg)[0] || {};
  const unlucky = xgOk.slice().sort((a, b) => a.luck_ppg - b.luck_ppg)[0] || {};
  document.getElementById("spike-kpis").innerHTML = TTDash.kpiStripHtml([
    { label: "선두", value: `${top.short || "-"} ${top.points ?? ""}`, delta: `선두 교체 ${st.leader_changes ?? 0}회`, dir: "flat" },
    { label: "가장 운 좋은 팀", value: `${lucky.short || "-"} +${(lucky.luck_ppg || 0).toFixed(2)}`, delta: "PPG − 기대 PPG", dir: "up" },
    { label: "가장 억울한 팀", value: `${unlucky.short || "-"} ${(unlucky.luck_ppg || 0).toFixed(2)}`, delta: "기대보다 승점 손해", dir: "down" },
    { label: "xG 보유 경기", value: `${xg.matches_with_xg ?? "-"}/${xg.matches ?? "-"}`, hint: "xG 운 보정 표본" },
  ]);
  document.getElementById("spike-chips").innerHTML = TTDash.chipsHtml([
    { key: "all", label: "전체" }, { key: "flow", label: "흐름·운" }, { key: "tactics", label: "전술" },
    { key: "squad", label: "스쿼드 운용" }, { key: "setpiece", label: "세트피스·수비" }], "all");
  TTDash.bindChips(document.getElementById("spike-chips"), (k) => { window.__chip = k; });

  const evidence = "<p>스파이크 — 근거 표는 Phase 1</p>";
  const cards = [
    { id: "sp-bump", size: "L", icon: "📈", title: "라운드별 순위 추이", question: "누가 올라오고 있나?", warnings: st.warnings || [],
      spec: () => TTChart.presets.bump({ rounds: st.rounds, nTeams: st.teams.length,
        teams: st.teams.map((t) => ({ id: t.id, short: t.short, color: col(t.short), ranks: t.ranks })) }) },
    { id: "sp-quad", size: "M", icon: "🍀", title: "xG 운 보정", question: "실력만큼 승점을 땄나?", warnings: xg.warnings || [],
      spec: () => TTChart.presets.quadrant({ xTitle: "기대 승점 (xPPG)", yTitle: "실제 승점 (PPG)", diagonal: true,
        quadrantLabels: ["↖ 행운 (기대 이상)", "", "", "불운 (기대 이하) ↘"],
        points: xgOk.map((t) => ({ id: t.id, label: t.short, x: t.xppg, y: t.ppg, color: t.primary })) }) },
    { id: "sp-forest", size: "M", icon: "😴", title: "휴식일 영향", question: "짧은 휴식이 정말 손해인가?", warnings: rest.warnings || [],
      spec: () => TTChart.presets.forest({ zero: opp.league_ppg, zeroLabel: "리그 평균", unit: "PPG",
        rows: (rest.buckets || []).map((b) => ({ label: b.label, est: b.ppg, lo: b.ppg - b.ci, hi: b.ppg + b.ci, n: b.n, insufficient: b.n < 20 })) }) },
    { id: "sp-dumb", size: "M", icon: "⚖️", title: "경기 상황별 성적", question: "앞서면 지키고, 뒤지면 따라가나?", warnings: gs.warnings || [],
      spec: () => {
        const ok = (gs.teams || []).filter((t) => t.eligible && t.led && t.led.n && t.trailed);
        return TTChart.presets.dumbbell({ categories: ok.map((t) => t.short),
          a: { name: "뒤질 때 PPG", color: TTChart.THEME.neg, data: ok.map((t) => t.trailed.ppg) },
          b: { name: "앞설 때 PPG", color: TTChart.THEME.pos, data: ok.map((t) => (3 * t.led.w + t.led.d) / t.led.n) } });
      } },
    { id: "sp-heat", size: "L", icon: "🧗", title: "상대 수준별 성적", question: "강팀에게 강한가?", warnings: opp.warnings || [],
      spec: () => {
        const ok = (opp.teams || []).filter((t) => t.eligible);
        return TTChart.presets.heatMatrix({ rows: ok.map((t) => t.short), cols: ["상위권", "중위권", "하위권"], center: opp.league_ppg,
          colorTitle: "PPG", values: ok.map((t) => ["top", "mid", "bottom"].map((k) => (t.tiers[k] ? t.tiers[k].ppg : null))) });
      } },
    { id: "sp-stack", size: "M", icon: "🎯", title: "득점 의존도", question: "1·2위 득점자 비중", warnings: sdep.warnings || [],
      spec: () => { const ts = (sdep.teams || []).filter((t) => t.eligible).sort((a, b) => b.top1_share - a.top1_share);
        return TTChart.presets.stacked100({ categories: ts.map((t) => t.short), parts: [
          { name: "1위 득점자", color: TTChart.THEME.accent, data: ts.map((t) => t.top1_share) },
          { name: "2위 득점자", color: "#f59e0b", data: ts.map((t) => t.top2_share - t.top1_share) },
          { name: "나머지", color: TTChart.THEME.neutral, data: ts.map((t) => 100 - t.top2_share) }] }); } },
    { id: "sp-bar", size: "M", icon: "🕸️", title: "패스 허브 의존도", question: "허브 1인 지분", warnings: [],
      spec: () => { const ts = (hub.teams || []).filter((t) => t.eligible).sort((a, b) => b.hub_share - a.hub_share);
        return TTChart.presets.barRef({ categories: ts.map((t) => t.short), values: ts.map((t) => t.hub_share), ref: hub.league_hub_share, refLabel: "리그 평균", unit: "%", name: "허브 지분" }); } },
    { id: "sp-sankey", size: "M", icon: "⚡", title: "득점 직후 10분", question: "골 넣고 무슨 일이?", warnings: aft.warnings || [],
      spec: () => { const f = (aft.league_total || {}).flow || {};
        return TTChart.presets.sankey({ nodes: ["득점", "추가골만", "실점만", "둘 다", "변화 없음"], links: [
          { source: "득점", target: "추가골만", value: f.extra_only || 0 }, { source: "득점", target: "실점만", value: f.conc_only || 0 },
          { source: "득점", target: "둘 다", value: f.both || 0 }, { source: "득점", target: "변화 없음", value: f.none || 0 }] }); } },
  ];
  const grid = document.getElementById("spike-grid");
  grid.innerHTML = cards.map((c) => TTDash.cardHtml({ ...c, evidenceHtml: evidence })).join("");

  const inkOf = (slot) => {
    const c = slot.querySelector("canvas"); if (!c) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
    return ink / (d.length / 4);
  };
  for (const c of cards) {
    const slot = document.querySelector(`#${c.id} [data-chart-slot]`);
    const t0 = performance.now();
    let note = "";
    try { TTChart.mount(slot, c.spec(), { lazy: false }); } catch (e) { note = String(e); }
    results[c.id] = { ms: Math.round(performance.now() - t0), note };
  }
  await new Promise((r) => setTimeout(r, 1200));
  for (const c of cards) {
    const slot = document.querySelector(`#${c.id} [data-chart-slot]`);
    const ink = inkOf(slot);
    const err = !!slot.querySelector(".tt-chart-error");
    Object.assign(results[c.id], { nonBlank: ink > 0.01, ink: Math.round(ink * 1000) / 1000, ok: !err && !results[c.id].note });
  }
  window.__spikeDone = true;
})().catch((e) => { console.warn("spike failed", e); window.__spikeDone = true; window.__spikeError = String(e); });
