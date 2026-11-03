// 전역 에러 핸들링 + fetch 래퍼 + GET API 캐시 + 이미지 로드 실패 숨김 (CSP: 인라인 스크립트 금지라 템플릿에서 분리)
window.addEventListener("unhandledrejection", (e) => { console.warn("Unhandled:", e.reason); e.preventDefault(); });
window._fetch = window.fetch;

const _apiCache = new Map();
const _API_CACHE_TTL = 30000; // 30초
// 캐시 제외: 폴링 엔드포인트, 사용자 저장 데이터
const _CACHE_EXCLUDE = ['/api/update-status', '/api/trigger-update', '/api/saves', '/api/squads'];
// 뮤테이션 발생 시 관련 GET 캐시 무효화: prefix → 무효화할 캐시 prefix 목록
const _CACHE_INVALIDATE = { '/api/saves': ['/api/saves'], '/api/squads': ['/api/squads'] };

function _shouldCache(urlStr, method) {
    return method === 'GET' && urlStr.startsWith('/api/') &&
           !_CACHE_EXCLUDE.some(p => urlStr.startsWith(p));
}

window.fetch = function(url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const urlStr = typeof url === 'string' ? url : (url && url.url) || String(url);

    // 뮤테이션 시 관련 캐시 무효화
    if (method !== 'GET') {
        for (const [prefix, targets] of Object.entries(_CACHE_INVALIDATE)) {
            if (urlStr.startsWith(prefix)) {
                for (const [k] of _apiCache) {
                    if (targets.some(t => k.startsWith(t))) _apiCache.delete(k);
                }
            }
        }
    }

    if (_shouldCache(urlStr, method)) {
        const hit = _apiCache.get(urlStr);
        if (hit && Date.now() - hit.ts < _API_CACHE_TTL) {
            return Promise.resolve(new Response(JSON.stringify(hit.data),
                { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
    }

    return window._fetch(url, opts).then(r => {
        if (!r.ok) { console.warn(`API ${r.status}: ${urlStr}`); return r; }
        if (_shouldCache(urlStr, method)) {
            r.clone().json().then(data => _apiCache.set(urlStr, { ts: Date.now(), data })).catch(() => {});
        }
        return r;
    }).catch(err => {
        console.warn(`Network error: ${urlStr}`, err.message);
        throw err;
    });
};

// 엠블럼 등 data-hide-err 이미지가 로드 실패하면 숨긴다 (인라인 onerror 대체 — error 이벤트는 버블링되지 않아 캡처 단계에서 받음)
document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.hasAttribute("data-hide-err")) t.style.display = "none";
}, true);
