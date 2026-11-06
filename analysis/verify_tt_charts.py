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
            route.continue_()
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
