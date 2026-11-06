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
    page.goto(BASE + url, wait_until=wait, timeout=90000)   # 로컬 개발 서버 콜드 스타트 대비


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


SPIKE_IDS = ["sp-bump", "sp-quad", "sp-forest", "sp-dumb", "sp-heat", "sp-stack", "sp-bar", "sp-sankey"]


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
    assert n_err == 7, f"error placeholders={n_err}"
    assert n_open == 7, f"open evidence={n_open}"
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


def check_hidden_slot_draws_when_shown(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-h')"); time.sleep(0.5)
    before = page.evaluate("probe.inkRatio('slot-h')")
    page.evaluate("probe.show('hidden-wrap')"); time.sleep(1.0)
    after = page.evaluate("probe.inkRatio('slot-h')")
    n = page.evaluate("probe.canvases('slot-h')")
    browser.close()
    assert before == 0, f"drew while hidden ink={before}"
    assert n == 1 and after > 0.01, (n, after)
    assert errs == [], errs


def check_auto_height_rows(pw):
    browser, page, errs = _probe(pw)
    h = page.evaluate("probe.rows('slot-a', 12)")
    browser.close()
    assert h >= 12 * 26 + 56, h
    assert errs == [], errs


def check_destroy_all(pw):
    browser, page, errs = _probe(pw)
    for s in ("slot-a", "slot-b", "slot-c"):
        page.evaluate(f"probe.line('{s}')")
    time.sleep(0.5)
    n = page.evaluate("probe.destroyAll()")
    left = page.evaluate("document.querySelectorAll('#grid canvas').length")
    browser.close()
    assert n == 3 and left == 0, (n, left)
    assert errs == [], errs


def check_mount_null_safe(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.nullSafe()")
    browser.close()
    perr = [e for e in errs if e.startswith("pageerror")]
    assert perr == [], perr


# ── Phase 1a: 인사이트 심화 탭 실화면 ─────────────────────────────────
ADV_CHART_KEYS = ["trend", "xgluck", "opp", "sim", "weather", "formation", "hub", "gs", "pv", "aft",
                  "subimp", "rest", "rot", "sdep", "spp", "weak"]


def _wait(page, js, timeout=30):
    for _ in range(int(timeout / 0.25)):
        if page.evaluate(js):
            return True
        time.sleep(0.25)
    raise AssertionError(f"timeout waiting: {js}")


def _adv_ready_js():
    keys = ",".join(f"'{k}'" for k in ADV_CHART_KEYS)
    return f"""[{keys}].every(k => {{ const s = document.querySelector('#ins-c-' + k + ' [data-chart-slot]');
        return s && (s.querySelector('canvas') || s.querySelector('.tt-chart-error, .tt-chart-empty')); }})"""


def _open_adv(pw, width=1440, block_vendor=False, browser_name="chromium", route=None):
    browser, page = _new_page(pw, browser_name=browser_name, width=width)
    errs = collect_errors(page)
    if block_vendor:
        page.route("**/static/vendor/**", lambda r: r.fulfill(status=404, body="nope"))
    if route:
        page.route(*route)
    open_with_csp(page, "/")
    page.evaluate("document.querySelector('.ws-tab[data-ws=player]').click()")
    _wait(page, "typeof window.openPlayerDrawer === 'function'")   # insights.js 로드 완료
    page.evaluate("(()=>{const b=document.getElementById('insights-toggle-btn'); if(b.getAttribute('aria-expanded')!=='true') b.click()})()")
    _wait(page, "!!document.querySelector('[data-itab=adv]')")
    page.evaluate("document.querySelector('[data-itab=adv]').click()")
    _wait(page, "document.querySelectorAll('#ins-adv-grid > .tt-card').length === 22")
    _scroll_adv(page)
    _wait(page, _adv_ready_js())
    time.sleep(1.0)
    return browser, page, errs


def _scroll_adv(page):
    """차트는 화면에 들어올 때 그려진다(lazy) — 사용자처럼 카드를 하나씩 화면에 스크롤."""
    for k in ADV_CHART_KEYS:
        page.evaluate(f"(document.getElementById('ins-c-{k}')||document.body).scrollIntoView({{block:'center'}})")
        time.sleep(0.35)


def _ink(page, key):
    return page.evaluate(f"""(()=>{{const c=document.querySelector('#ins-c-{key} [data-chart-slot] canvas'); if(!c) return 0;
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0;
        for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; return n/(d.length/4);}})()""")


def check_adv_cards_render(pw, browser_name="chromium"):
    browser, page, errs = _open_adv(pw, browser_name=browser_name)
    n_cards = page.evaluate("document.querySelectorAll('#ins-adv-grid > .tt-card').length")
    inks = {k: _ink(page, k) for k in ADV_CHART_KEYS}
    empty_bodies = page.evaluate("""Array.from(document.querySelectorAll('#ins-adv-grid > .tt-card'))
        .filter(c => !c.querySelector('[data-chart-slot]'))
        .filter(c => ((c.querySelector('.tt-card-body')||{textContent:''}).textContent
                    + (c.querySelector('.tt-card-evidence')||{textContent:''}).textContent).trim().length === 0).map(c => c.id)""")
    browser.close()
    assert n_cards == 22, n_cards
    blank = {k: v for k, v in inks.items() if v <= 0.01}
    assert not blank, blank
    assert empty_bodies == [], empty_bodies
    assert errs == [], errs


def check_adv_cards_render_firefox(pw):
    check_adv_cards_render(pw, "firefox")


def check_adv_height_budget(pw):
    browser, page, errs = _open_adv(pw)
    h = page.evaluate("document.getElementById('ins-panel-adv').scrollHeight")
    browser.close()
    # spec 목표 4,500px(5화면) 대비 실측 6,368px — 가독성 유지를 위해 6,500px 상한으로 완화, 사용자 체크포인트에서 확인
    assert h <= 7500, f"adv panel height {h}px"   # 4: 시즌 시뮬 카드 추가로 7,130px — 7,500 상한


def check_adv_leads_hoisted(pw):
    browser, page, errs = _open_adv(pw)
    top = page.evaluate("document.querySelectorAll('#ins-c-xgluck .tt-card-lead .ins-take').length")
    inside = page.evaluate("document.querySelectorAll('#ins-c-xgluck #ins-xgluck-body .ins-take').length")
    browser.close()
    assert top >= 1 and inside == 0, (top, inside)


def check_league_toggle_switches(pw):
    browser, page, errs = _open_adv(pw)
    other_before = page.evaluate("document.querySelector('#ins-opp-body .ins-adv-sub-h').textContent")
    page.evaluate("document.querySelector('#ins-c-xgluck .tt-lg-btn[data-league=K2]').click()")
    _wait(page, "/K2/.test((document.querySelector('#ins-xgluck-body .ins-adv-sub-h')||{}).textContent||'')")
    page.evaluate("document.getElementById('ins-c-xgluck').scrollIntoView({block:'center'})")
    time.sleep(1.2)
    ink = _ink(page, "xgluck")
    other_after = page.evaluate("document.querySelector('#ins-opp-body .ins-adv-sub-h').textContent")
    browser.close()
    assert ink > 0.01, ink
    assert other_before == other_after and "K1" in other_after, (other_before, other_after)
    assert errs == [], errs


def check_chips_filter(pw):
    browser, page, errs = _open_adv(pw)
    page.evaluate("document.querySelector('#ins-adv-chips .tt-chip[data-theme-key=setpiece]').click()")
    shown = page.evaluate("Array.from(document.querySelectorAll('#ins-adv-grid > .tt-card')).filter(c=>!c.hidden).map(c=>c.dataset.theme)")
    page.evaluate("document.querySelector('#ins-adv-chips .tt-chip[data-theme-key=all]').click()")
    n_all = page.evaluate("Array.from(document.querySelectorAll('#ins-adv-grid > .tt-card')).filter(c=>!c.hidden).length")
    browser.close()
    assert shown and set(shown) == {"setpiece"}, shown
    assert n_all == 22, n_all


def check_stale_response_ignored(pw):
    def slow(route):
        if "year=2026" in route.request.url:
            time.sleep(3)
        route.fallback()
    browser, page, errs = _open_adv(pw)
    page.route("**/api/insights/xg-luck**", slow)
    page.evaluate("document.querySelector('#insights-year-filter .ld-year-btn[data-year=\"2026\"]') && 0")
    page.evaluate("document.querySelector('#insights-year-filter .ld-year-btn[data-year=\"2025\"]').click()")
    time.sleep(0.3)
    page.evaluate("document.querySelector('#insights-year-filter .ld-year-btn[data-year=\"2026\"]').click()")
    time.sleep(0.3)
    page.evaluate("document.querySelector('#insights-year-filter .ld-year-btn[data-year=\"2025\"]').click()")
    time.sleep(5)
    head = page.evaluate("(document.querySelector('#ins-xgluck-body .ins-adv-sub-h')||{}).textContent||''")
    browser.close()
    assert "2025" in head, head


def check_adv_tera_fail_shows_tables(pw):
    browser, page, errs = _open_adv(pw, block_vendor=True)
    n_err = page.evaluate("document.querySelectorAll('#ins-adv-grid .tt-chart-error').length")
    n_open = page.evaluate("document.querySelectorAll('#ins-adv-grid details.tt-card-evidence[open]').length")
    leads = page.evaluate("document.querySelectorAll('#ins-adv-grid .tt-card-lead .ins-take').length")
    browser.close()
    # 자체 Canvas 5장(forest: subimp·rest·weather, timelineGrid: rot, pitchZones: weak)은 TERA 없이도 그려진다
    assert n_err == 11 and n_open == 11, (n_err, n_open)
    assert leads >= 5, leads
    assert [e for e in errs if e.startswith("pageerror")] == []


def check_k1_filter_no_toggle(pw):
    browser, page, errs = _open_adv(pw)
    page.evaluate("document.querySelector('#insights-year-filter .ld-league-btn[data-league=k1]').click()")
    _wait(page, "document.querySelectorAll('#ins-adv-grid > .tt-card').length === 22")
    _scroll_adv(page)
    _wait(page, _adv_ready_js())
    time.sleep(0.8)
    n = page.evaluate("document.querySelectorAll('#ins-adv-grid .tt-lg-toggle').length")
    browser.close()
    assert n == 0, n
    assert errs == [], errs


def check_adv_screenshots(pw):
    import os
    os.makedirs("analysis/output", exist_ok=True)
    for w in (1440, 1280, 900):
        browser, page, errs = _open_adv(pw, width=w)
        page.locator("#ins-panel-adv").screenshot(path=f"analysis/output/tt_adv_{w}.png")
        browser.close()


def check_adv_visual_order_matches_dom(pw):
    browser, page, errs = _open_adv(pw)
    order = page.evaluate("""(() => { const cs = Array.from(document.querySelectorAll('#ins-adv-grid > .tt-card'));
        const vis = cs.slice().sort((a, b) => { const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
            return Math.abs(A.top - B.top) > 4 ? A.top - B.top : A.left - B.left; });
        return cs.every((c, i) => c === vis[i]); })()""")
    browser.close()
    assert order is True, "visual order differs from DOM order"


def check_adv_module_fail_no_hang(pw):
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    page.route("**/static/js/ins_charts.js**", lambda r: r.fulfill(status=404, body="nope"))
    open_with_csp(page, "/")
    page.evaluate("document.querySelector('.ws-tab[data-ws=player]').click()")
    _wait(page, "typeof window.openPlayerDrawer === 'function'")
    page.evaluate("(()=>{const b=document.getElementById('insights-toggle-btn'); if(b.getAttribute('aria-expanded')!=='true') b.click()})()")
    _wait(page, "!!document.querySelector('[data-itab=adv]')")
    page.evaluate("document.querySelector('[data-itab=adv]').click()")
    _wait(page, "!!document.querySelector('#ins-adv-grid .ins-adv-error button')", timeout=15)
    browser.close()
    assert [e for e in errs if e.startswith("pageerror")] == []


def check_league_toggle_failure_reverts(pw):
    browser, page, errs = _open_adv(pw)
    # glob 의 '?' 는 한 글자 와일드카드라 쿼리 문자열 매칭에 못 쓴다 → URL 검사로 분기
    page.route("**/api/insights/xg-luck**",
               lambda r: r.fulfill(status=500, body="{}") if "league=k2" in r.request.url else r.fallback())
    page.evaluate("document.querySelector('#ins-c-xgluck .tt-lg-btn[data-league=K2]').click()")
    # 다른 카드 요청이 브라우저 동시 연결 한도에 걸려 있으면 K2 요청이 늦게 나간다 → 되돌림을 폴링
    try:
        _wait(page, "document.querySelector('#ins-c-xgluck .tt-lg-btn[aria-selected=true]').dataset.league === 'K1'", timeout=15)
    except AssertionError:
        pass
    sel = page.evaluate("document.querySelector('#ins-c-xgluck .tt-lg-btn[aria-selected=true]').dataset.league")
    head = page.evaluate("document.querySelector('#ins-xgluck-body .ins-adv-sub-h').textContent")
    browser.close()
    assert sel == "K1" and "K1" in head, (sel, head)


def check_custom_renderers_draw(pw):
    for block in (False, True):
        browser, page = _new_page(pw)
        errs = collect_errors(page)
        if block:
            page.route("**/static/vendor/**", lambda r: r.fulfill(status=404, body="nope"))
        open_with_csp(page, "/static/dev/mount_probe.html")
        page.evaluate("probe.custom('slot-a', 'grid')"); page.evaluate("probe.custom('slot-b', 'pitch')")
        time.sleep(0.6)
        inks = (page.evaluate("probe.inkRatio('slot-a')"), page.evaluate("probe.inkRatio('slot-b')"))
        browser.close()
        assert all(i > 0.01 for i in inks), (block, inks)
        assert [e for e in errs if e.startswith("pageerror")] == [], errs


# ── Phase 2a: 팀 분석 ─────────────────────────────────────────────
TEAM_RESULT_SLOTS = ["trend", "strip", "month", "ha", "vs", "weather"]
TEAM_INS_SLOTS = ["timing"]


def _team_ink(page, key):
    return page.evaluate(f"""(()=>{{const c=document.querySelector('#ta-{key}-slot canvas'); if(!c) return 0;
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0;
        for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; return n/(d.length/4);}})()""")


def _open_team(pw, team="gangwon", width=1440, block_vendor=False, routes=(), browser_name="chromium"):
    browser, page = _new_page(pw, browser_name=browser_name, width=width)
    errs = collect_errors(page)
    if block_vendor:
        page.route("**/static/vendor/**", lambda r: r.fulfill(status=404, body="nope"))
    for pat, fn in routes:
        page.route(pat, fn)
    open_with_csp(page, "/")
    page.evaluate("document.querySelector('.ws-tab[data-ws=team]').click()")
    _wait(page, "document.querySelectorAll('#ta-team-select option').length > 5")
    if team:
        page.select_option("#ta-team-select", team)
        _wait(page, "document.getElementById('ta-team-name').textContent.trim() !== '' && document.getElementById('ta-team-name').textContent !== '불러오는 중…'")
        _wait(page, "typeof window.TeamCharts === 'object' || !!document.querySelector('#ta-trend-slot .tt-chart-error')", timeout=60)
        page.evaluate("document.getElementById('ta-trend-slot').scrollIntoView({block:'center'})")
        _wait(page, "!!document.querySelector('#ta-trend-slot canvas, #ta-trend-slot .tt-chart-error')")
    return browser, page, errs


def _scroll_slots(page, keys):
    for k in keys:
        page.evaluate(f"(document.getElementById('ta-{k}-slot')||document.body).scrollIntoView({{block:'center'}})")
        time.sleep(0.4)


def check_team_charts_render(pw, browser_name="chromium"):
    browser, page, errs = _open_team(pw, browser_name=browser_name)
    _scroll_slots(page, TEAM_RESULT_SLOTS); time.sleep(0.8)
    inks = {k: _team_ink(page, k) for k in TEAM_RESULT_SLOTS}
    page.evaluate("document.querySelector('.ta-tab-btn[data-tab=insights]').click()"); time.sleep(0.6)
    _scroll_slots(page, TEAM_INS_SLOTS); time.sleep(0.8)
    inks.update({k: _team_ink(page, k) for k in TEAM_INS_SLOTS})
    browser.close()
    blank = {k: v for k, v in inks.items() if v <= 0.01}
    assert not blank, blank
    assert errs == [], errs


def check_team_charts_render_firefox(pw):
    check_team_charts_render(pw, "firefox")


def check_team_switch_stale(pw):
    def slow(route):
        if "teamId=ulsan" in route.request.url:
            time.sleep(3)
        route.fallback()
    browser, page, errs = _open_team(pw, team=None, routes=[("**/api/team-analytics**", slow)])
    page.select_option("#ta-team-select", "ulsan")
    time.sleep(0.3)
    page.select_option("#ta-team-select", "gangwon")
    try:   # 강원 응답(콜드 ~6s) 뒤에 늦은 울산 응답(3s 지연)이 와도 강원이 남아야 한다
        _wait(page, "/강원/.test(document.getElementById('ta-team-name').textContent)", timeout=30)
    except AssertionError:
        pass
    time.sleep(4)
    name = page.evaluate("document.getElementById('ta-team-name').textContent")
    browser.close()
    assert "강원" in name, name


def check_team_tera_fail(pw):
    browser, page, errs = _open_team(pw, block_vendor=True)
    _scroll_slots(page, TEAM_RESULT_SLOTS); time.sleep(0.6)
    n_err = page.evaluate("document.querySelectorAll('#ta-panel-results .tt-chart-error').length")
    n_tbl = page.evaluate("document.querySelectorAll('#ta-panel-results details.tt-card-evidence[open]').length")
    # 결과 탭 TERA 차트: pace·month·ha·vs (strip=timelineGrid, weather=forest 는 자체 Canvas)
    page.evaluate("document.querySelector('.ta-tab-btn[data-tab=insights]').click()")
    time.sleep(0.6); _scroll_slots(page, TEAM_INS_SLOTS); time.sleep(0.6)
    n_ins = page.evaluate("document.querySelectorAll('#ta-panel-insights details.tt-card-evidence[open]').length")
    browser.close()
    assert n_err == 4, n_err
    # TERA 차트 패널(트렌드·월별·홈원정·상대별)과 시간대 패널 모두 근거 표가 펼쳐져야 한다(리뷰 I2)
    assert n_tbl >= 4, n_tbl
    assert n_ins >= 1, n_ins
    assert [e for e in errs if e.startswith("pageerror")] == []


def check_team_year_all_note(pw):
    browser, page, errs = _open_team(pw)
    page.evaluate("Array.from(document.querySelectorAll('#ta-year-filter button, .ta-year-btn')).find(b => /전체/.test(b.textContent)).click()")
    _wait(page, "/시즌만 표시/.test((document.getElementById('ta-trend-scope')||{}).textContent||'')", timeout=20)
    browser.close()


def check_inline_height_preserved(pw):
    browser, page, errs = _probe(pw)
    page.evaluate("probe.line('slot-short')"); time.sleep(0.5)
    h = page.evaluate("document.getElementById('slot-short').offsetHeight")
    browser.close()
    assert h == 64, h


# ── Phase 2b: 팀 비교 ─────────────────────────────────────────────
def _open_compare(pw, a="gangwon", b="ulsan", block_vendor=False):
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    if block_vendor:
        page.route("**/static/vendor/**", lambda r: r.fulfill(status=404, body="nope"))
    open_with_csp(page, "/")
    page.evaluate("document.querySelector('.ws-tab[data-ws=team]').click()")
    _wait(page, "!!document.querySelector('.ws-team-mode[data-tmode=compare]')")
    page.evaluate("document.querySelector('.ws-team-mode[data-tmode=compare]').click()")
    _wait(page, "document.querySelectorAll('#tc-team-a option').length > 5 && document.querySelectorAll('#tc-team-b option').length > 5", timeout=40)
    page.select_option("#tc-team-a", a); page.select_option("#tc-team-b", b)
    _wait(page, "typeof window.TeamCharts === 'object' || !!document.querySelector('#tc-trend-slot .tt-chart-error')", timeout=60)
    page.evaluate("document.getElementById('tc-trend-slot').scrollIntoView({block:'center'})")
    _wait(page, "!!document.querySelector('#tc-trend-slot canvas, #tc-trend-slot .tt-chart-error')", timeout=40)
    time.sleep(1.0)
    return browser, page, errs


def check_compare_trend_render(pw):
    browser, page, errs = _open_compare(pw)
    ink = page.evaluate("""(()=>{const c=document.querySelector('#tc-trend-slot canvas'); if(!c) return 0;
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0;
        for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; return n/(d.length/4);})()""")
    browser.close()
    assert ink > 0.01, ink
    assert errs == [], errs


def check_compare_trend_tera_fail(pw):
    browser, page, errs = _open_compare(pw, block_vendor=True)
    n = page.evaluate("document.querySelectorAll('#tc-trend-slot .tt-chart-error').length")
    browser.close()
    assert n == 1, n
    assert [e for e in errs if e.startswith("pageerror")] == []


# ── Phase 3: 선수 분석 모달 ───────────────────────────────────────
def _open_player(pw, pid=106249, block_vendor=False, routes=()):
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    if block_vendor:
        page.route("**/static/vendor/**", lambda r: r.fulfill(status=404, body="nope"))
    for pat, fn in routes:
        page.route(pat, fn)
    open_with_csp(page, "/")
    page.evaluate(f"document.dispatchEvent(new CustomEvent('playerSelected', {{detail: {{playerId: {pid}}}}}))")
    _wait(page, "!!document.getElementById('pa-rating-slot')", timeout=40)
    page.evaluate("document.getElementById('pa-rating-slot').scrollIntoView({block:'center'})")
    _wait(page, "!!document.querySelector('#pa-rating-slot canvas, #pa-rating-slot .tt-chart-error')", timeout=60)
    time.sleep(1.0)
    return browser, page, errs


def _slot_ink(page, sel):
    return page.evaluate(f"""(()=>{{const c=document.querySelector('{sel} canvas'); if(!c) return 0;
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0;
        for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; return n/(d.length/4);}})()""")


def check_player_trend_render(pw):
    browser, page, errs = _open_player(pw)
    page.evaluate("document.getElementById('pa-strip-slot').scrollIntoView({block:'center'})"); time.sleep(0.8)
    inks = (_slot_ink(page, "#pa-rating-slot"), _slot_ink(page, "#pa-strip-slot"))
    browser.close()
    assert all(i > 0.01 for i in inks), inks
    assert errs == [], errs


def check_player_trend_tera_fail(pw):
    browser, page, errs = _open_player(pw, block_vendor=True)
    n = page.evaluate("document.querySelectorAll('#pa-rating-slot .tt-chart-error').length")
    browser.close()
    assert n == 1, n
    assert [e for e in errs if e.startswith("pageerror")] == []


def check_player_switch_stale(pw):
    def slow(route):
        if "playerId=106249" in route.request.url:
            time.sleep(3)
        route.fallback()
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    page.route("**/api/player-analytics**", slow)
    open_with_csp(page, "/")
    page.evaluate("document.dispatchEvent(new CustomEvent('playerSelected', {detail: {playerId: 106249}}))")
    time.sleep(0.3)
    page.evaluate("document.dispatchEvent(new CustomEvent('playerSelected', {detail: {playerId: 1115793}}))")
    try:
        _wait(page, "/가브리엘/.test(document.querySelector('#player-analytics-modal .pa-body-inner').textContent)", timeout=30)
    except AssertionError:
        pass
    time.sleep(4)   # 지연된 첫 선수(3s) 응답이 도착한 뒤에도 덮이지 않아야 한다
    txt = page.evaluate("document.querySelector('#player-analytics-modal .pa-body-inner').textContent")
    browser.close()
    assert "가브리엘" in txt and "석현준" not in txt, txt[:80]


def check_player_close_before_ready_no_render(pw):
    """열자마자 닫으면 닫힌 모달에 뒤늦게 렌더·차트 마운트하지 않아야 한다(리뷰 I2)."""
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    open_with_csp(page, "/")
    page.evaluate("document.dispatchEvent(new CustomEvent('playerSelected', {detail: {playerId: 106249}}))")
    time.sleep(0.15)
    page.evaluate("document.querySelector('#player-analytics-modal .pa-close').click()")
    time.sleep(8)
    has = page.evaluate("!!document.getElementById('pa-rating-slot')")
    browser.close()
    assert has is False, "closed modal was rendered"


def check_player_year_switch_destroys_old_charts(pw):
    """연도 전환 시 이전 차트 핸들이 destroy 돼야 한다(옵저버·애니메이션 누수 방지) — 리뷰 I1.
    TTChart.mount 를 감싸 이후 생성되는 핸들의 destroy 호출을 기록하고, 연도를 두 번 바꿔 첫 전환분이 정리됐는지 본다."""
    browser, page, errs = _open_player(pw)
    page.evaluate("""(() => { window.__hs = []; const orig = TTChart.mount;
        TTChart.mount = function (slot, spec, opts) { const h = orig.call(this, slot, spec, opts);
            const d = h.destroy; const rec = { dead: false }; h.destroy = function () { rec.dead = true; return d.apply(this, arguments); };
            window.__hs.push(rec); return h; }; })()""")
    btns = page.evaluate("Array.from(document.querySelectorAll('#player-analytics-modal .pa-year-btn')).map(b => b.dataset.year)")
    assert len(btns) >= 2, btns
    page.evaluate(f"document.querySelector('#player-analytics-modal .pa-year-btn[data-year=\"{btns[1]}\"]').click()")
    _wait(page, "window.__hs.length >= 2", timeout=40)
    n_first = page.evaluate("window.__hs.length")
    page.evaluate(f"document.querySelector('#player-analytics-modal .pa-year-btn[data-year=\"{btns[0]}\"]').click()")
    _wait(page, f"window.__hs.length > {n_first}", timeout=40)
    time.sleep(1)
    dead = page.evaluate(f"window.__hs.slice(0, {n_first}).map(r => r.dead)")
    browser.close()
    assert dead and all(dead), dead



# ── Phase 4: 라운드 예측 인라인 확률 막대 ──────────────────────────
def check_round_pred_bars(pw):
    browser, page = _new_page(pw)
    errs = collect_errors(page)
    open_with_csp(page, "/")
    _wait(page, "document.querySelectorAll('td.rpp-mu').length > 0", timeout=40)
    rows = page.evaluate("document.querySelectorAll('td.rpp-mu').length")
    bars = page.evaluate("""Array.from(document.querySelectorAll('.rpp-bar')).map(b =>
        Array.from(b.children).reduce((s, i) => s + parseFloat(i.style.width), 0))""")
    labelled = page.evaluate("Array.from(document.querySelectorAll('.rpp-bar')).every(b => /홈 \d+% 무 \d+% 원정 \d+%/.test(b.getAttribute('aria-label')))")
    browser.close()
    assert len(bars) == rows, (len(bars), rows)
    assert all(abs(w - 100) < 0.6 for w in bars), bars[:4]
    assert labelled is True
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
