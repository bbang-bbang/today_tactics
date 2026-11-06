// analysis/verify_tt_charts.py 의 mount 계열 check 가 호출하는 프로브
(function () {
  const LINE = { type: "line", __aria: "테스트 라인", xAxis: { categories: ["R1", "R2", "R3", "R4"] },
    series: [{ name: "서울", color: "#ef3744", data: [{ y: 3 }, { y: 5 }, { y: 4 }, { y: 8 }] }] };
  const slot = (id) => document.getElementById(id);
  window.probe = {
    line: (id) => { window.__h = TTChart.mount(slot(id), LINE, { lazy: false }); return true; },
    empty: (id) => { window.__hs = window.__hs || {}; window.__hs[id] = TTChart.mount(slot(id), { __empty: true }, { lazy: false }); return true; },
    remount: (id, n) => { for (let i = 0; i < n; i++) TTChart.mount(slot(id), LINE, { lazy: false }); return true; },
    updateTo: (id, kind) => { const h = window.__hs && window.__hs[id]; (h || window.__h).update(kind === "empty" ? { __empty: true } : LINE); return true; },
    rows: (id, n) => { TTChart.mount(slot(id), Object.assign({}, LINE, { __rows: n }), { lazy: false }); return slot(id).offsetHeight; },
    show: (id) => { document.getElementById(id).style.display = "block"; return true; },
    destroyAll: () => TTChart.destroyAll(document.getElementById("grid")),
    nullSafe: () => { TTChart.mount(null, {}); TTChart.mount(slot("slot-c"), null); return true; },
    custom: (id, kind) => {
      const spec = kind === "grid"
        ? TTChart.presets.timelineGrid({ rows: [{ label: "서울", cells: [{ v: 2, mark: "W" }, { v: 7, mark: "L" }, { v: 0, mark: "D" }] }, { label: "광주", cells: [{ v: 4, mark: "W" }] }], vMax: 11, legend: "테스트" })
        : TTChart.presets.pitchZones({ geom: [{ key: "goalmouth", x0: 0, x1: 5.5, y0: 36.5, y1: 63.5 }, { key: "box_center", x0: 0, x1: 16.5, y0: 30, y1: 70 }],
            values: { goalmouth: { label: "골문 앞", share: 12, lg_share: 10, z: 2.5 }, box_center: { label: "박스 중앙", share: 40, lg_share: 38, z: 0.4 } } });
      TTChart.mount(slot(id), spec, { lazy: false }); return true;
    },
    destroy: () => { window.__h.destroy(); return true; },
    canvases: (id) => slot(id).querySelectorAll("canvas").length,
    cssWidth: (id) => { const c = slot(id).querySelector("canvas"); return c ? c.getBoundingClientRect().width : 0; },
    inkRatio: (id) => {
      const c = slot(id).querySelector("canvas"); if (!c) return 0;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
      return ink / (d.length / 4);
    },
    aria: (id) => { const c = slot(id).querySelector("canvas"); return c ? [c.getAttribute("role"), c.getAttribute("aria-label")] : null; },
  };
})();
