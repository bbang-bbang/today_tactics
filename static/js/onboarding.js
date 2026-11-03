// 온보딩 오버레이 + 도움말 모달 + 데이터 갱신 배지 (CSP: 인라인 스크립트 금지라 템플릿에서 분리)
(function () {
    // ── 온보딩 오버레이 ──────────────────────────────────────
    var overlay  = document.getElementById('onboarding-overlay');
    var startBtn = document.getElementById('ob-start-btn');
    function showOnboarding() {
        overlay.style.display = '';
        requestAnimationFrame(function () { overlay.classList.add('ob-visible'); });
    }
    function hideOnboarding() {
        overlay.classList.remove('ob-visible');
        overlay.classList.add('ob-hiding');
        setTimeout(function () { overlay.style.display = 'none'; overlay.classList.remove('ob-hiding'); }, 300);
        localStorage.setItem('tt_onboarded', '1');
    }
    if (!localStorage.getItem('tt_onboarded')) { showOnboarding(); }
    startBtn.addEventListener('click', hideOnboarding);
    // "다시 보기" 링크를 헤더 사용자 영역에 동적 추가
    var um = document.getElementById('user-menu');
    if (um) {
        var resetLink = document.createElement('button');
        resetLink.className = 'ob-reset-link';
        resetLink.textContent = '도움말';
        resetLink.title = '사용법 다시 보기';
        resetLink.addEventListener('click', function () {
            localStorage.removeItem('tt_onboarded');
            showOnboarding();
        });
        um.appendChild(resetLink);
    }

    // ── 분석 읽는 법 (도움말 모달) ─────────────────────────────
    var guide = document.getElementById('guide-overlay');
    var guideOpener = null;
    function openGuide() {
        guideOpener = document.activeElement;
        guide.style.display = '';
        requestAnimationFrame(function () { guide.classList.add('gd-visible'); });
        document.getElementById('gd-close').focus();
    }
    function closeGuide() {
        guide.classList.remove('gd-visible');
        setTimeout(function () { guide.style.display = 'none'; }, 200);
        if (guideOpener && guideOpener.focus) guideOpener.focus();
    }
    var guideOpen = document.getElementById('gd-open');
    if (guideOpen) guideOpen.addEventListener('click', openGuide);
    document.getElementById('gd-close').addEventListener('click', closeGuide);
    document.getElementById('gd-done').addEventListener('click', closeGuide);
    guide.addEventListener('click', function (e) { if (e.target === guide) closeGuide(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && guide.style.display !== 'none') closeGuide();
    });

    // ── 데이터 신선도 배지 ──────────────────────────────────
    var dfbText  = document.getElementById('dfb-text');
    var dfbBadge = document.getElementById('data-freshness-badge');
    fetch('/api/update-status').then(function (r) { return r.json(); }).then(function (d) {
        if (!dfbText) return;
        if (d.last_run) {
            dfbText.textContent = '데이터 ' + d.last_run.replace(' KST','');
            if (d.last_result === 'error') {
                dfbBadge.classList.add('dfb-error');
                dfbBadge.title = '마지막 업데이트 실패: ' + (d.last_msg || '') + (d.next_run ? ' / 다음: ' + d.next_run : '');
            } else if (d.last_result === 'partial') {
                // 스코어는 갱신됐지만 일부 수집(득점·라인업·슈팅맵 등) 실패 — 'last_run'만 보면 정상처럼 보이므로 경고 표시
                dfbBadge.classList.add('dfb-old');
                dfbText.textContent = '데이터 ' + d.last_run.replace(' KST','') + ' ⚠ 일부 미수집';
                dfbBadge.title = '일부 수집 실패: ' + (d.last_msg || '') + (d.next_run ? ' / 다음: ' + d.next_run : '');
            } else {
                dfbBadge.title = '마지막 업데이트: ' + d.last_run + (d.next_run ? ' / 다음: ' + d.next_run : '');
            }
        } else if (d.next_run) {
            dfbText.textContent = '다음 업데이트 ' + d.next_run.replace(' KST','');
            dfbBadge.classList.add('dfb-old');
            dfbBadge.title = '아직 업데이트 실행 전입니다. 다음 예정: ' + d.next_run;
        } else {
            dfbText.textContent = '데이터 기준 미확인';
            dfbBadge.classList.add('dfb-old');
        }
    }).catch(function () {
        if (dfbText) { dfbText.textContent = '업데이트 상태 확인 불가'; dfbBadge.classList.add('dfb-error'); }
    });
})();
