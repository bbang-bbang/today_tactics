(function () {
    "use strict";

    const bannerMatchup = document.getElementById("banner-matchup");

    function showPanel() {
        // 예측 보고서가 열려 있으면 banner-matchup 미표시 (H2H 이중 노출 방지)
        const predSection = document.getElementById("prediction-section");
        if (predSection && !predSection.classList.contains("hidden")) return;
        bannerMatchup.classList.remove("hidden");
    }

    function hidePanel() {
        bannerMatchup.classList.add("hidden");
    }

    function watchBanner() {
        const nameA = document.getElementById("fhud-name-a");
        const nameB = document.getElementById("fhud-name-b");
        if (!nameA || !nameB) return;

        const observer = new MutationObserver(() => {
            const textA = nameA.textContent.trim();
            const textB = nameB.textContent.trim();
            const hasA = textA !== "HOME" && textA !== "";
            const hasB = textB !== "AWAY" && textB !== "";
            (hasA || hasB) ? showPanel() : hidePanel();
        });

        observer.observe(nameA, { childList: true, characterData: true, subtree: true });
        observer.observe(nameB, { childList: true, characterData: true, subtree: true });
    }

    watchBanner();
})();
