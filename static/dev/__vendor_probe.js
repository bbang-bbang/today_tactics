// TERA 번들이 운영 CSP 아래에서 로드되는지 확인용 (analysis/verify_tt_charts.py check_vendor_loads)
window.__probe = (typeof TeraChart === "object" && TeraChart.version) ? String(TeraChart.version) : null;
