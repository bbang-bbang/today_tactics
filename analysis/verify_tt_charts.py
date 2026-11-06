"""TERA CHART 어댑터·대시보드 셸 브라우저 검증 (Phase 0).

사용법 (Flask 서버가 http://127.0.0.1:5000 에 떠 있어야 함):
    python analysis/verify_tt_charts.py              # 전체
    python analysis/verify_tt_charts.py check_a ...  # 개별

운영 nginx 와 같은 CSP 헤더를 HTML 응답에 주입해서, self-host·인라인 금지 조건을
로컬에서 그대로 재현한다. 하나라도 FAIL 이면 exit 1.
"""
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5000"
PROD_CSP = (
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net/npm/chart.js@4.4.0/; "
    "object-src 'none'; base-uri 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; "
    "frame-ancestors 'none';"
)


def open_with_csp(page, url, wait="networkidle"):
    """HTML 문서 응답에만 운영 CSP 헤더를 붙여서 연다."""
    def handle(route):
        if route.request.resource_type == "document":
            resp = route.fetch()
            headers = dict(resp.headers)
            headers["content-security-policy"] = PROD_CSP
            route.fulfill(response=resp, headers=headers)
        else:
            route.fallback()  # 먼저 등록된 다른 라우트(예: vendor 404)에 양보
    page.route("**/*", handle)
    page.goto(BASE + url, wait_until=wait)


def collect_errors(page):
    """console error + pageerror 를 모으는 리스트를 반환 (페이지 열기 전에 호출)."""
    errs = []
    page.on("console", lambda m: errs.append(f"console: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    return errs


def _new_page(pw, browser_name="chromium", width=1440, height=900):
    browser = getattr(pw, browser_name).launch()
    ctx = browser.new_context(viewport={"width": width, "height": height})
    ctx.add_init_script("try{localStorage.setItem('tt_onboarded','1')}catch(e){}")
    return browser, ctx.new_page()


# ── checks ─────────────────────────────────────────────────────────────
def check_vendor_loads(pw):
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    open_with_csp(page, "/static/dev/__vendor_probe.html")
    probe = page.evaluate("window.__probe")
    browser.close()
    assert isinstance(probe, str) and probe.startswith("7.0.2"), f"probe={probe!r}"
    assert errs == [], errs


def check_not_loaded_on_home(pw):
    browser, page = _new_page(pw)
    urls = []
    page.on("request", lambda r: urls.append(r.url))
    errs = collect_errors(page)
    open_with_csp(page, "/")
    time.sleep(1)
    browser.close()
    assert not any("tera-chart" in u for u in urls), [u for u in urls if "tera" in u]
    assert errs == [], errs


def _probe(pw, width=1440):
    browser, page = _new_page(pw, width=width)
    errs = collect_errors(page)
    open_with_csp(page, "/static/dev/mount_probe.html")
    return browser, page, errs


def check_mount_renders_nonblank(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-a')"); time.sleep(1.2)
    n, ink = page.evaluate("probe.canvases('slot-a')"), page.evaluate("probe.inkRatio('slot-a')")
    browser.close()
    assert n == 1, f"canvases={n}"
    assert ink > 0.01, f"ink={ink}"
    assert errs == [], errs


def check_mount_empty_shows_placeholder(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.empty('slot-b')")
    n = page.evaluate("probe.canvases('slot-b')")
    txt = page.evaluate("(document.querySelector('#slot-b .tt-chart-empty')||{}).textContent")
    browser.close()
    assert n == 0, n
    assert txt == "표시할 데이터가 없습니다 (표본 부족)", txt
    assert errs == [], errs


def check_remount_same_slot_single_canvas(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.remount('slot-c', 5)"); time.sleep(0.8)
    n = page.evaluate("probe.canvases('slot-c')")
    browser.close()
    assert n == 1, f"canvases={n}"
    assert errs == [], errs


def check_destroy_cleans_up(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-a')"); time.sleep(0.5)
    page.evaluate("probe.destroy()")
    n = page.evaluate("probe.canvases('slot-a')")
    browser.close()
    assert n == 0, n
    assert errs == [], errs


def check_resize_rerenders(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-a')"); time.sleep(0.8)
    w1 = page.evaluate("probe.cssWidth('slot-a')")
    page.set_viewport_size({"width": 900, "height": 900}); time.sleep(0.6)
    w2 = page.evaluate("probe.cssWidth('slot-a')")
    ink = page.evaluate("probe.inkRatio('slot-a')")
    browser.close()
    assert w2 < w1, f"w1={w1} w2={w2}"
    assert ink > 0.01, f"ink after resize={ink}"
    assert errs == [], errs


def check_canvas_has_aria(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-a')")
    role, label = page.evaluate("probe.aria('slot-a')") or (None, None)
    browser.close()
    assert role == "img", role
    assert label, label
    assert errs == [], errs


SPIKE_IDS = ["sp-bump", "sp-quad", "sp-forest", "sp-dumb", "sp-heat"]


def _spike(pw, browser_name="chromium", width=1440, block_vendor=False):
    browser, page = _new_page(pw, browser_name=browser_name, width=width)
    errs = collect_errors(page)
    if block_vendor:
        page.route("**/static/vendor/**", lambda r: r.fulfill(status=404, body="nope"))
    open_with_csp(page, "/static/dev/chart_spike.html")
    # wait_for_function 은 문자열 eval 이라 CSP(unsafe-eval 없음)에 막힌다 → evaluate 폴링
    for _ in range(100):
        if page.evaluate("window.__spikeDone === true"):
            break
        time.sleep(0.2)
    else:
        raise AssertionError("spike did not finish in 20s")
    return browser, page, errs


def check_spike_all_presets_ok(pw, browser_name="chromium"):
    browser, page, errs = _spike(pw, browser_name)
    res = page.evaluate("window.__spikeResults")
    serr = page.evaluate("window.__spikeError || null")
    browser.close()
    assert serr is None, serr
    bad = {k: v for k, v in (res or {}).items() if not (v.get("ok") and v.get("nonBlank"))}
    assert set(res or {}) == set(SPIKE_IDS), res
    assert not bad, bad
    assert errs == [], errs


def check_spike_firefox(pw):
    check_spike_all_presets_ok(pw, "firefox")


def check_spike_screenshots(pw):
    import os
    os.makedirs("analysis/output", exist_ok=True)
    for w in (1440, 1280, 900):
        browser, page, errs = _spike(pw, width=w)
        page.screenshot(path=f"analysis/output/tt_spike_{w}.png", full_page=True)
        browser.close()
        assert errs == [], (w, errs)


def check_tera_missing_fallback(pw):
    browser, page, errs = _spike(pw, block_vendor=True)
    n_err = page.evaluate("document.querySelectorAll('.tt-chart-error').length")
    n_open = page.evaluate("document.querySelectorAll('details.tt-card-evidence[open]').length")
    browser.close()
    # forest 는 어댑터 자체 Canvas 렌더러라 TERA 없이도 그려진다 → 나머지 4장만 오류 표시
    assert n_err == 4, f"error placeholders={n_err}"
    assert n_open == 4, f"open evidence={n_open}"
    perr = [e for e in errs if e.startswith("pageerror")]
    assert perr == [], perr


def check_existing_tabs_clean(pw):
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    open_with_csp(page, "/")
    for ws in ["predict", "team", "player", "heatmap", "tactics"]:
        page.evaluate(f"document.querySelector('.ws-tab[data-ws={ws}]').click()")
        time.sleep(3)
    browser.close()
    assert errs == [], errs


def check_update_empty_to_data(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.empty('slot-b')")
    page.evaluate("probe.updateTo('slot-b', 'line')"); time.sleep(1.0)
    n, ink = page.evaluate("probe.canvases('slot-b')"), page.evaluate("probe.inkRatio('slot-b')")
    left = page.evaluate("document.querySelectorAll('#slot-b .tt-chart-empty').length")
    browser.close()
    assert (n, left) == (1, 0), (n, left)
    assert ink > 0.01, ink
    assert errs == [], errs


def check_update_data_to_empty(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-a')"); time.sleep(0.6)
    page.evaluate("probe.updateTo('slot-a', 'empty')"); time.sleep(0.4)
    n = page.evaluate("probe.canvases('slot-a')")
    empty = page.evaluate("document.querySelectorAll('#slot-a .tt-chart-empty').length")
    error = page.evaluate("document.querySelectorAll('#slot-a .tt-chart-error').length")
    browser.close()
    assert (n, empty, error) == (0, 1, 0), (n, empty, error)
    assert errs == [], errs


def check_tooltip_text_readable(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-a')"); time.sleep(1.2)
    box = page.locator("#slot-a").bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.40, box["y"] + box["height"] * 0.5); time.sleep(0.2)
    page.mouse.move(box["x"] + box["width"] * 0.42, box["y"] + box["height"] * 0.45); time.sleep(0.6)
    colors = page.evaluate("""Array.from(document.querySelectorAll('.tc-hover-tooltip, .tc-hover-tooltip *'))
        .filter(e => e.textContent.trim()).map(e => getComputedStyle(e).color)""")
    browser.close()
    assert colors, "tooltip not found"

    def lum(rgb):
        import re
        c = [int(x) / 255 for x in re.findall(r"\d+", rgb)[:3]]
        c = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    bg = lum("rgb(11,17,32)")
    worst = min((max(lum(c), bg) + 0.05) / (min(lum(c), bg) + 0.05) for c in colors)
    assert worst >= 4.5, f"tooltip contrast {worst:.2f} colors={set(colors)}"


def check_lazy_loader_tera_fail(pw):
    """실제 lazy 로더 경로: TERA 가 404 여도 어댑터는 로드돼 mount 가 오류 박스로 폴백해야 한다."""
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    page.route("**/static/vendor/**", lambda r: r.fulfill(status=404, body="nope"))
    open_with_csp(page, "/")
    ok = page.evaluate("""() => window.ttLoadCharts().then(() => {
        const s = document.createElement('div'); s.style.height = '100px'; document.body.appendChild(s);
        TTChart.mount(s, {type:'line', series:[{data:[1,2]}]}, {lazy:false});
        return !!s.querySelector('.tt-chart-error') && typeof TTDash === 'object';
    })""")
    browser.close()
    assert ok is True, ok
    perr = [e for e in errs if e.startswith("pageerror")]
    assert perr == [], perr


CHECKS = {name: fn for name, fn in globals().items() if name.startswith("check_")}


def main(argv):
    names = argv or list(CHECKS)
    failed = 0
    with sync_playwright() as pw:
        for n in names:
            try:
                CHECKS[n](pw)
                print(f"PASS {n}")
            except Exception as e:  # noqa: BLE001 — 리포트용
                failed += 1
                print(f"FAIL {n}: {e}")
    print(f"{len(names) - failed}/{len(names)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
