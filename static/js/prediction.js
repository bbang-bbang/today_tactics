// prediction.js — 경기 예측 보고서 + 다음 경기 일정

(function () {
    // 팀 슬러그 → { p: primary, a: accent, e: emblem }
    const SLUG_COLOR = {
        "ulsan":    { p:"#1d5fa5", a:"#f2a900", e:"emblem_K01.png" },
        "pohang":   { p:"#d41123", a:"#ffffff", e:"emblem_K03.png" },
        "jeju":     { p:"#f47920", a:"#ffffff", e:"emblem_K04.png" },
        "jeonbuk":  { p:"#0a4436", a:"#ffd700", e:"emblem_K05.png" },
        "fcseoul":  { p:"#ef3744", a:"#ffd700", e:"emblem_K09.png" },
        "daejeon":  { p:"#059a86", a:"#ffffff", e:"emblem_K10.png" },
        "incheon":  { p:"#01a0fc", a:"#ffffff", e:"emblem_K18.png" },
        "gangwon":  { p:"#f55947", a:"#f47920", e:"emblem_K21.png" },
        "gwangju":  { p:"#f3ad02", a:"#000000", e:"emblem_K22.png" },
        "bucheon":  { p:"#8e272b", a:"#ffffff", e:"emblem_K26.png" },
        "anyang":   { p:"#501b85", a:"#ffd700", e:"emblem_K27.png" },
        "gimcheon": { p:"#df242b", a:"#ffffff", e:"emblem_K35.png" },
        "suwon":    { p:"#2553a5", a:"#c8102e", e:"emblem_K02.png" },
        "busan":    { p:"#b4050f", a:"#ffffff", e:"emblem_K06.png" },
        "jeonnam":  { p:"#fbea09", a:"#000000", e:"emblem_K07.png" },
        "seongnam": { p:"#0e131b", a:"#ffffff", e:"emblem_K08.png" },
        "daegu":    { p:"#86c5e8", a:"#ffffff", e:"emblem_K17.png" },
        "gyeongnam":{ p:"#ac101b", a:"#ffffff", e:"emblem_K20.png" },
        "suwon_fc": { p:"#07306a", a:"#ffffff", e:"emblem_K29.png" },
        "seouland": { p:"#030a1b", a:"#1e3a8a", e:"emblem_K31.png" },
        "ansan":    { p:"#0087a7", a:"#ffd700", e:"emblem_K32.png" },
        "asan":     { p:"#12122c", a:"#e30613", e:"emblem_K34.png" },
        "gimpo":    { p:"#78bc36", a:"#ffffff", e:"emblem_K36.png" },
        "cheongju": { p:"#0d1026", a:"#ffffff", e:"emblem_K37.png" },
        "cheonan":  { p:"#3e8fb3", a:"#e30613", e:"emblem_K38.png" },
        "hwaseong": { p:"#d45820", a:"#ffffff", e:"emblem_K39.png" },
        "paju":     { p:"#042ba0", a:"#c8102e", e:"emblem_K40.png" },
        "gimhae":   { p:"#ac0d0e", a:"#ffd700", e:"emblem_K41.png" },
        "yongin":   { p:"#910c26", a:"#ffd700", e:"emblem_K42.png" },
    };
    function tc(slug) { return SLUG_COLOR[slug] || { p:"#334", a:"#aaa", e:"" }; }

    // 전술 보기 키트 색: /api/teams로 main.py의 TEAMS 직접 가져옴.
    // primary/secondary/accent/border_home/border_away 포함 — 메인 전술판과 동일 시스템.
    const _teamKit = {};
    fetch("/api/teams").then(r => r.json()).then(arr => {
        if (Array.isArray(arr)) arr.forEach(t => { _teamKit[t.id] = t; });
    }).catch(() => {});
    function kit(slug) { return _teamKit[slug] || null; }

    // 한글 short_name → slug (29팀, K1+K2)
    const KO_TO_SLUG = {
        "울산":"ulsan","포항":"pohang","제주":"jeju","전북":"jeonbuk","FC서울":"fcseoul",
        "대전":"daejeon","인천":"incheon","강원":"gangwon","광주":"gwangju","부천":"bucheon",
        "안양":"anyang","김천":"gimcheon","수원삼성":"suwon","부산":"busan","전남":"jeonnam",
        "성남":"seongnam","대구":"daegu","경남":"gyeongnam","수원FC":"suwon_fc",
        "서울이랜드":"seouland","안산":"ansan","충남아산":"asan","김포":"gimpo",
        "충북청주":"cheongju","천안":"cheonan","화성":"hwaseong","파주":"paju",
        "김해":"gimhae","용인":"yongin",
    };
    function koSlug(name) { return KO_TO_SLUG[name] || null; }
    function koColor(name) { return tc(KO_TO_SLUG[name]); }

    const section   = document.getElementById("prediction-section");
    const report    = document.getElementById("prediction-report");
    const closeBtn  = document.getElementById("prediction-close");
    const _bm       = document.getElementById("banner-matchup");

    // banner-matchup: 예측 섹션과 공존하면 H2H 이중 노출 → 예측 열리면 숨김
    function _hideBannerMatchup() { if (_bm) _bm.classList.add("hidden"); }
    function _restoreBannerMatchup() {
        if (!_bm) return;
        const nameA = document.getElementById("fhud-name-a");
        const nameB = document.getElementById("fhud-name-b");
        const hasA = nameA && nameA.textContent.trim() !== "HOME" && nameA.textContent.trim() !== "";
        const hasB = nameB && nameB.textContent.trim() !== "AWAY" && nameB.textContent.trim() !== "";
        if (hasA || hasB) _bm.classList.remove("hidden");
    }

    if (closeBtn) {
        closeBtn.addEventListener("click", () => {
            section.classList.add("hidden");
            _restoreBannerMatchup();
        });
    }

    // ── 매치 컨텍스트 초기화 (리그/라운드 전환 시 호출) ─────
    function clearMatchContext() {
        section.classList.add("hidden");
        if (report) report.innerHTML = "";
        _lastHome = null;
        _lastAway = null;
        _restoreBannerMatchup();
    }

    // ── 리그 탭 전환 ─────────────────────────────────────
    document.querySelectorAll(".league-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".league-tab-btn").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".league-tab-panel").forEach(p => p.classList.remove("active"));
            btn.classList.add("active");
            const league = btn.dataset.league;
            document.getElementById(`${league}-schedule-banner-wrap`).classList.add("active");
            if (league === "k1" && !k1Loaded) loadScheduleK1();
            if (league === "k2" && !k2Loaded) loadSchedule();
            clearMatchContext();
        });
    });

    // ── 라운드 일정 (페이지 로드 시 자동) ──────────────────
    let scheduleCache = null;
    let roundsCache   = null;
    let activeRound   = null;
    let k2Loaded      = false;

    let k1ScheduleCache = null;
    let k1RoundsCache   = null;
    let k1ActiveRound   = null;
    let k1Loaded        = false;

    function loadSchedule() {
        k2Loaded = true;
        Promise.all([
            fetch("/api/k2/schedule").then(r => r.json()),
            fetch("/api/k2/rounds").then(r => r.json()),
        ]).then(([sched, rounds]) => {
            scheduleCache = sched;
            roundsCache   = rounds;
            activeRound   = rounds.current_round;
            renderRoundsBanner(rounds, sched, "k2");
        }).catch(() => { k2Loaded = false; });
    }

    function loadScheduleK1() {
        k1Loaded = true;
        Promise.all([
            fetch("/api/k1/schedule").then(r => r.json()),
            fetch("/api/k1/rounds").then(r => r.json()),
        ]).then(([sched, rounds]) => {
            k1ScheduleCache = sched;
            k1RoundsCache   = rounds;
            k1ActiveRound   = rounds.current_round;
            renderRoundsBanner(rounds, sched, "k1");
        }).catch(() => {});
    }

    function renderRoundsBanner(roundsData, schedData, league) {
        const wrapId = league === "k1" ? "k1-schedule-banner-wrap" : "k2-schedule-banner-wrap";
        const wrap = document.getElementById(wrapId);
        if (!wrap) return;

        const rounds = roundsData.rounds || [];
        if (!rounds.length) return;

        const curRound = league === "k1" ? k1ActiveRound : activeRound;
        const leagueLabel = league === "k1" ? "K리그1 2026" : "K리그2 2026";

        wrap.innerHTML = `
        <div class="ksb-banner" id="${league}-schedule-banner">
            <div class="ksb-header">
                <span class="ksb-title">${leagueLabel}</span>
                <span class="ksb-sub">라운드 선택 후 경기 클릭 → 예측 보고서</span>
            </div>
            <div class="ksb-round-tabs" id="${league}-round-tabs">
                ${rounds.map(r => `
                <button class="ksb-round-btn${r.round === curRound ? " active" : ""}" data-round="${r.round}" data-league="${league}">
                    R${r.round}
                    <span class="ksb-round-done">${r.finished}/${r.total}</span>
                </button>`).join("")}
            </div>
            <div class="ksb-pred-panel" id="${league}-pred-panel"></div>
            <div class="ksb-list" id="${league}-game-list"></div>
        </div>`;

        renderRoundGames(curRound, rounds, league);

        wrap.querySelectorAll(".ksb-round-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const rnd = parseInt(btn.dataset.round);
                const prev = (league === "k1") ? k1ActiveRound : activeRound;
                wrap.querySelectorAll(".ksb-round-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                if (league === "k1") k1ActiveRound = rnd;
                else activeRound = rnd;
                // 다른 라운드로 이동하면 이전 매치 카드 자동 닫기 (잔류 방지)
                if (prev !== null && prev !== rnd) clearMatchContext();
                renderRoundGames(rnd, rounds, league);
            });
        });
    }

    // 라운드 사전 예측 캐시 (key: "k1_10")
    const _roundPredCache = {};

    async function renderRoundPredPanel(roundNum, league) {
        const panel = document.getElementById(`${league}-pred-panel`);
        if (!panel) return;
        panel.innerHTML = `<div class="rpp-loading">⏳ R${roundNum} 모델 사전 예측 로딩...</div>`;
        const cacheKey = `${league}_${roundNum}`;
        let data = _roundPredCache[cacheKey];
        if (!data) {
            try {
                const r = await fetch(`/api/round-predictions?league=${league}&round=${roundNum}`);
                data = await r.json();
                _roundPredCache[cacheKey] = data;
            } catch (e) { panel.innerHTML = ""; return; }
        }
        const matches = (data && data.matches) || [];
        const summary = data && data.summary;
        const asOf    = data && data.as_of_date;
        const predicted = matches.filter(m => m.pred);
        if (!predicted.length) {
            panel.innerHTML = `<div class="rpp-empty">📊 R${roundNum} 모델 예측 — 표본 부족</div>`;
            return;
        }

        const rows = predicted.map(m => {
            const p = m.pred;
            const max = Math.max(p.home_pct, p.draw_pct, p.away_pct);
            const cls = v => v === max ? " rpp-pick" : "";
            const ts = p.top_score ? `${p.top_score.home}-${p.top_score.away}` : "—";
            const actual = m.actual_score ? `${m.actual_score.home}-${m.actual_score.away}` : "";
            const hitCell = ("hit" in p)
                ? (p.hit ? `<td class="rpp-hit-ok">✓</td>` : `<td class="rpp-hit-no">✗</td>`)
                : `<td class="rpp-hit-na">—</td>`;
            const actualCell = m.actual_score
                ? `<td class="rpp-actual">${actual}</td>`
                : `<td class="rpp-actual rpp-actual-tbd">예정</td>`;
            return `<tr>
                <td class="rpp-mu"><span class="rpp-h">${m.home_short}</span><span class="rpp-vs">vs</span><span class="rpp-a">${m.away_short}</span></td>
                <td class="rpp-pct${cls(p.home_pct)}">${p.home_pct}</td>
                <td class="rpp-pct${cls(p.draw_pct)}">${p.draw_pct}</td>
                <td class="rpp-pct${cls(p.away_pct)}">${p.away_pct}</td>
                <td class="rpp-ts">${ts}</td>
                ${actualCell}
                ${hitCell}
            </tr>`;
        }).join("");

        panel.innerHTML = `
            <div class="rpp-head">
                <span class="rpp-title">📊 R${roundNum} 모델 사전 예측</span>
                <span class="rpp-cutoff">R${roundNum-1}까지의 데이터로 예측 · cutoff ${asOf}</span>
            </div>
            <table class="rpp-table">
                <thead><tr>
                    <th>매치업</th><th>홈%</th><th>무%</th><th>원정%</th><th>예상</th><th>실제</th><th></th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    // ── 즐겨찾기 팀 (localStorage) ─────────────────────────
    const FAV_KEY = "tt_fav_teams";
    function _loadFavorites() {
        try {
            return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]"));
        } catch (_) { return new Set(); }
    }
    function _saveFavorites(set) {
        try { localStorage.setItem(FAV_KEY, JSON.stringify([...set])); } catch (_) {}
    }
    function _toggleFavorite(slug) {
        const s = _loadFavorites();
        if (s.has(slug)) s.delete(slug); else s.add(slug);
        _saveFavorites(s);
    }

    function renderRoundGames(roundNum, rounds, league) {
        const list = document.getElementById(`${league}-game-list`);
        if (!list) return;
        const rndData = rounds.find(r => r.round === roundNum);
        if (!rndData) return;

        // 사전 예측 패널은 비동기 로드 (게임 카드와 병렬)
        renderRoundPredPanel(roundNum, league);


        const favs = _loadFavorites();
        // 즐겨찾기 매치 최상단 정렬 (그룹 내부 date+time 순서 유지 — sort는 ES2019+ stable)
        const sortedGames = [...rndData.games].sort((a, b) => {
            const aFav = favs.has(a.home_id) || favs.has(a.away_id);
            const bFav = favs.has(b.home_id) || favs.has(b.away_id);
            if (aFav === bFav) return 0;
            return aFav ? -1 : 1;
        });
        // 라운드 탭에 ★ 인디케이터 갱신 (해당 라운드에 즐겨찾기 매치 있을 때)
        const tabContainer = document.getElementById(`${league}-round-tabs`);
        if (tabContainer) {
            tabContainer.querySelectorAll(".ksb-round-btn").forEach(btn => {
                const rnd = parseInt(btn.dataset.round, 10);
                const round = rounds.find(r => r.round === rnd);
                const hasFav = !!(round && round.games.some(g => favs.has(g.home_id) || favs.has(g.away_id)));
                btn.classList.toggle("ksb-round-fav", hasFav);
            });
        }
        list.innerHTML = sortedGames.map(g => {
            const finished  = g.finished;
            const canPredict = !finished && g.home_id && g.away_id && g.home_id !== "null" && g.away_id !== "null";
            const hc = tc(g.home_id), ac = tc(g.away_id);
            const dateShort = g.date.replace(/\./g,"/").slice(5);
            const isFav = favs.has(g.home_id) || favs.has(g.away_id);

            const centerContent = finished
                ? `<div class="kmc-score">${g.home_score} <span class="kmc-score-sep">:</span> ${g.away_score}</div>
                   <div class="kmc-meta">${dateShort}</div>
                   <div class="kmc-tag kmc-tag-done">결과</div>`
                : canPredict
                    ? `<div class="kmc-time">${g.time || "-"}</div>
                       <div class="kmc-meta">${dateShort}</div>
                       <div class="kmc-tag kmc-tag-pred">예측 →</div>`
                    : `<div class="kmc-time">-</div>
                       <div class="kmc-meta">${dateShort}</div>`;

            const homeEmb  = hc.e ? `<img class="kmc-emb" src="/static/img/emblems/${hc.e}" alt="" onerror="this.style.display='none'">` : "";
            const awayEmb  = ac.e ? `<img class="kmc-emb" src="/static/img/emblems/${ac.e}" alt="" onerror="this.style.display='none'">` : "";

            return `
            <div class="kmc${finished ? " kmc-done" : canPredict ? " kmc-upcoming" : ""}${isFav ? " kmc-fav" : ""}"
                 data-home="${g.home_id}" data-away="${g.away_id}"
                 data-finished="${finished}"
                 data-full-date="${g.date}">
                <div class="kmc-side kmc-home${favs.has(g.home_id) ? " kmc-side-fav" : ""}" style="background:linear-gradient(135deg,${hc.p}55 0%,${hc.p}22 100%)">
                    <button class="kmc-fav-btn" data-team="${g.home_id}" title="${favs.has(g.home_id) ? "즐겨찾기 해제" : "즐겨찾기"}" type="button">${favs.has(g.home_id) ? "★" : "☆"}</button>
                    ${homeEmb}
                    <span class="kmc-name">${g.home_short}</span>
                </div>
                <div class="kmc-mid">${centerContent}</div>
                <div class="kmc-side kmc-away${favs.has(g.away_id) ? " kmc-side-fav" : ""}" style="background:linear-gradient(225deg,${ac.p}55 0%,${ac.p}22 100%)">
                    <button class="kmc-fav-btn" data-team="${g.away_id}" title="${favs.has(g.away_id) ? "즐겨찾기 해제" : "즐겨찾기"}" type="button">${favs.has(g.away_id) ? "★" : "☆"}</button>
                    ${awayEmb}
                    <span class="kmc-name">${g.away_short}</span>
                </div>
            </div>`;
        }).join("");

        // 즐겨찾기 토글 이벤트
        list.querySelectorAll(".kmc-fav-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const slug = btn.dataset.team;
                _toggleFavorite(slug);
                renderRoundGames(roundNum, rounds, league);  // 즉시 재렌더
            });
        });

        list.querySelectorAll(".kmc").forEach(item => {
            item.addEventListener("click", () => {
                const homeId = item.dataset.home;
                const awayId = item.dataset.away;
                if (!homeId || !awayId || homeId === "null" || awayId === "null") return;
                list.querySelectorAll(".kmc.kmc-active").forEach(el => el.classList.remove("kmc-active"));
                item.classList.add("kmc-active");
                section.classList.remove("hidden");
                const gameDate = item.dataset.fullDate || null;
                const isFinished = item.dataset.finished === "true";
                // URL 공유 — 사용자 클릭 시 URL 자동 갱신
                try {
                    const u = new URL(window.location);
                    u.searchParams.set("home", homeId);
                    u.searchParams.set("away", awayId);
                    if (gameDate) u.searchParams.set("date", gameDate.replace(/\./g, "-"));
                    window.history.replaceState(null, "", u);
                } catch (_) {}
                loadPrediction(homeId, awayId, gameDate, isFinished);
                // 경기 선택 시 "경기에서 불러오기" 버튼 글로우 강조 (2초)
                const matchLoadBtn = document.getElementById("btn-match-load");
                if (matchLoadBtn) {
                    matchLoadBtn.classList.add("match-load-glow");
                    setTimeout(() => matchLoadBtn.classList.remove("match-load-glow"), 4000);
                }
                // 라인업 유무와 무관하게 fhud-name 즉시 업데이트
                // → MutationObserver(info.js) 트리거 → H2H / 전술판 팀명 동기화
                const hTeam = kit(homeId), aTeam = kit(awayId);
                if (hTeam && aTeam) {
                    const nameA = document.getElementById("fhud-name-a");
                    const nameB = document.getElementById("fhud-name-b");
                    if (nameA) nameA.textContent = hTeam.short || hTeam.name;
                    if (nameB) nameB.textContent = aTeam.short || aTeam.name;
                }
                // 메인 전술판 자동 적용은 finished 매치만
                if (isFinished && gameDate) {
                    fetch(`/api/match-lineup?date=${encodeURIComponent(gameDate)}&home_slug=${encodeURIComponent(homeId)}&away_slug=${encodeURIComponent(awayId)}`)
                        .then(r => r.json())
                        .then(data => {
                            if (homeId !== _lastHome || awayId !== _lastAway) return;
                            if (data && data.ready) {
                                document.dispatchEvent(new CustomEvent("matchLineupLoaded", { detail: data }));
                            } else {
                                // 라인업 없는 완료 매치 — 이전 전술판 잔류 제거
                                document.dispatchEvent(new CustomEvent("matchLineupCleared", { detail: { home: homeId, away: awayId } }));
                            }
                        })
                        .catch(() => {});
                } else {
                    // 예정(미완료) 매치 — 이전에 적용된 전술판이 남지 않도록 새 매치 팀으로 리셋
                    document.dispatchEvent(new CustomEvent("matchLineupCleared", { detail: { home: homeId, away: awayId } }));
                }
            });
        });

        // 자동 매치 선택 정책:
        //  - 새로고침(reload)·뒤로가기 → 선택 초기화(빈 화면). URL의 매치 파라미터도 제거.
        //  - 공유 링크(?home=&away=)로 "처음" 진입(navigate) → 해당 매치만 자동 선택.
        if (!_autoSelectedOnce) {
            _autoSelectedOnce = true;
            let navType = "navigate";
            try {
                const navEntry = performance.getEntriesByType("navigation")[0];
                if (navEntry && navEntry.type) navType = navEntry.type;
            } catch (_) {}

            if (navType === "reload" || navType === "back_forward") {
                // 새로고침 → 초기화: 주소창의 매치 파라미터 제거(공유 링크 잔류 방지)
                try {
                    const u = new URL(window.location);
                    let changed = false;
                    ["home", "away", "date"].forEach(k => {
                        if (u.searchParams.has(k)) { u.searchParams.delete(k); changed = true; }
                    });
                    if (changed) window.history.replaceState(null, "", u);
                } catch (_) {}
            } else {
                // 공유 링크 첫 진입 시에만 해당 매치 자동 선택
                let target = null;
                try {
                    const params = new URLSearchParams(window.location.search);
                    const uHome = params.get("home"), uAway = params.get("away"), uDate = params.get("date");
                    if (uHome && uAway) {
                        const wrappers = document.querySelectorAll(".ksb-list");
                        for (const w of wrappers) {
                            const cand = w.querySelector(
                                `.kmc[data-home="${uHome}"][data-away="${uAway}"]` +
                                (uDate ? `[data-full-date="${uDate.replace(/-/g, ".")}"]` : "")
                            );
                            if (cand) { target = cand; break; }
                        }
                    }
                } catch (_) {}
                if (target) requestAnimationFrame(() => target.click());
            }
        }
    }
    // 자동 선택 1회만 (사용자 후속 클릭 방해 X)
    let _autoSelectedOnce = false;

    // ── 팀 선택 이벤트 수신 (기존 info.js 연동) ─────────────
    document.addEventListener("teamsSelected", (e) => {
        if (!e.detail || e.detail.home.id === e.detail.away.id) {
            section.classList.add("hidden");
            return;
        }
        // 매치 카드로 이미 같은 매치 로딩 중이면 무시 (race로 extras를 null로 덮어쓰는 것 방지).
        // 흐름: 매치 클릭 → matchLineupLoaded → fhud-name textContent 변경 → MutationObserver → 여기.
        // 이 경로로 들어오면 gameDate=null로 재호출되어 전술보기 카드 사라짐.
        if (e.detail.home.id === _lastHome && e.detail.away.id === _lastAway) return;
        section.classList.remove("hidden");
        // 팀 선택만 → 매치 컨텍스트(=날짜) 없음, 전술 보기 카드 미표시
        loadPrediction(e.detail.home.id, e.detail.away.id, null, false);
    });


    // ── 클라이언트 세션 캐시 (페이지 새로고침 전까지 유지) ──────
    const _predCache   = {};  // "homeId|awayId"      → prediction data
    const _extrasCache = {};  // "date|homeId|awayId" → match-extras data
    const _retroCache  = {};  // "date|homeId|awayId" → match-retrospective data
    const _speCache    = {};  // "homeId|awayId"      → setpiece-efficiency data

    function _cachedFetch(cache, key, fetchFn) {
        if (key in cache) return Promise.resolve(cache[key]);
        return fetchFn().then(d => { cache[key] = d; return d; })
                        .catch(() => { cache[key] = null; return null; });
    }

    // 백테스트 정확도 — 리그별 캐시
    let _backtestCache = {};
    function loadBacktest(league) {
        const key = (league || "k2").toLowerCase();
        if (_backtestCache[key]) return Promise.resolve(_backtestCache[key]);
        return fetch(`/api/prediction-backtest?league=${key}&year=2026`)
            .then(r => r.json())
            .then(d => { _backtestCache[key] = d; return d; })
            .catch(() => null);
    }
    function backtestBannerHtml(d) {
        if (!d || !d.ready) return "";
        const leagueLabel = d.league === "K1" ? "K리그1 2026" : "K리그2 2026";
        return `<div class="pred-backtest">
            <span class="pbt-label">📊 ${leagueLabel} 모델 정확도</span>
            <span class="pbt-stat"><span class="pbt-v">${d.hit_1x2_pct}%</span><span class="pbt-k">1X2</span></span>
            <span class="pbt-stat"><span class="pbt-v">${d.exact_score_pct}%</span><span class="pbt-k">정확 스코어</span></span>
            <span class="pbt-stat"><span class="pbt-v">${d.top3_score_pct}%</span><span class="pbt-k">TOP3</span></span>
            <span class="pbt-stat"><span class="pbt-v">${d.brier_score}</span><span class="pbt-k">Brier</span></span>
            <span class="pbt-sub">${d.n_total}경기 rolling · 무작위 ${d.baseline_random}%</span>
            ${backtestChartHtml(d.per_round)}
            ${backtestWorstHtml(d.worst_residuals)}
        </div>`;
    }

    // 빗나감 큰 매치 5건 (잔차 분석 표시)
    function backtestWorstHtml(worst) {
        if (!Array.isArray(worst) || worst.length === 0) return "";
        const outcomeLabel = { home: "홈", draw: "무", away: "원" };
        const confColor = { high: "#7bed9f", med: "#facc15", low: "#f87171" };
        const rows = worst.map(w => {
            const c = confColor[w.confidence] || "#94a3b8";
            const predPct = w.predicted_pct[w.predicted_outcome];
            return `<div class="pbt-worst-row">
                <span class="pbt-worst-date">${w.date.slice(5)}</span>
                <span class="pbt-worst-match">${w.home} ${w.actual_score} ${w.away}</span>
                <span class="pbt-worst-pred">예측 ${outcomeLabel[w.predicted_outcome]} ${predPct}%</span>
                <span class="pbt-worst-arrow">→</span>
                <span class="pbt-worst-actual">${outcomeLabel[w.actual_outcome]}</span>
                <span class="pbt-worst-conf" style="color:${c}">신뢰 ${w.confidence}</span>
                <span class="pbt-worst-brier">Brier ${w.brier}</span>
            </div>`;
        }).join("");
        return `<details class="pbt-worst">
            <summary>📌 빗나간 매치 ${worst.length}건 보기 (Brier 큰 순)</summary>
            <div class="pbt-worst-list">${rows}</div>
        </details>`;
    }

    // 라운드별 적중률 막대 차트
    function backtestChartHtml(perRound) {
        if (!perRound || perRound.length < 2) return "";
        const W = 380, H = 100, PAD_L = 30, PAD_R = 12, PAD_T = 14, PAD_B = 22;
        const innerW = W - PAD_L - PAD_R;
        const innerH = H - PAD_T - PAD_B;
        const n = perRound.length;
        const BAR_GAP = 0.25;
        const barW = (innerW / n) * (1 - BAR_GAP);
        const slotW = innerW / n;
        const yAt = pct => PAD_T + (1 - pct / 100) * innerH;
        const zeroY = yAt(0);

        // 막대 — 성과 구간별 색상
        const bars = perRound.map((r, i) => {
            const pct = r.round_pct || 0;
            const x = (PAD_L + i * slotW + slotW * BAR_GAP / 2).toFixed(1);
            const y = yAt(pct).toFixed(1);
            const bh = Math.max(1, zeroY - yAt(pct)).toFixed(1);
            const fill = pct >= 50 ? "#4ade80" : pct >= 33 ? "#facc15" : "#f87171";
            const isLast = i === n - 1;
            const opacity = isLast ? "1" : "0.75";
            const label = isLast || pct >= 60 || pct === 0
                ? `<text x="${(+x + barW / 2).toFixed(1)}" y="${(+y - 2).toFixed(1)}" font-size="7.5" fill="${fill}" text-anchor="middle" font-weight="700">${pct}%</text>`
                : "";
            return `<rect x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${bh}" rx="2" fill="${fill}" opacity="${opacity}">
                <title>R${r.round} · ${pct}% (${r.hit}/${r.total})</title></rect>${label}`;
        }).join("");

        // 50% / 33% 기준선
        const ref50Y = yAt(50).toFixed(1);
        const ref33Y = yAt(33.3).toFixed(1);

        // y축 라벨
        const yLabels = [0, 50, 100].map(v => `
            <text x="${PAD_L - 4}" y="${(yAt(v) + 3).toFixed(1)}" font-size="8" fill="#4a6a88" text-anchor="end">${v}</text>
            <line x1="${PAD_L}" y1="${yAt(v).toFixed(1)}" x2="${W - PAD_R}" y2="${yAt(v).toFixed(1)}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
        `).join("");

        // x축 라벨 (라운드 수 많으면 짝수만)
        const xLabels = perRound.map((r, i) => {
            if (n > 8 && i % 2 !== 0) return "";
            const cx = (PAD_L + i * slotW + slotW / 2).toFixed(1);
            return `<text x="${cx}" y="${H - PAD_B + 12}" font-size="8" fill="#4a6a88" text-anchor="middle">R${r.round}</text>`;
        }).join("");

        return `
        <div class="pred-backtest-chart">
            <svg class="pbc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
                ${yLabels}
                <!-- 50% 기준선 -->
                <line x1="${PAD_L}" y1="${ref50Y}" x2="${W - PAD_R}" y2="${ref50Y}" stroke="rgba(255,255,255,0.12)" stroke-width="1" stroke-dasharray="4,3"/>
                <!-- 33% 무작위 기준선 -->
                <line x1="${PAD_L}" y1="${ref33Y}" x2="${W - PAD_R}" y2="${ref33Y}" stroke="#f87171" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
                <text x="${W - PAD_R - 2}" y="${(+ref33Y - 2).toFixed(1)}" font-size="7" fill="#f87171" text-anchor="end" opacity="0.7">랜덤 33%</text>
                <!-- 라운드별 막대 -->
                ${bars}
                ${xLabels}
            </svg>
            <div class="pbc-legend">
                <span class="pbc-lg"><span class="pbc-lg-bar" style="background:#4ade80"></span>50%↑</span>
                <span class="pbc-lg"><span class="pbc-lg-bar" style="background:#facc15"></span>33~50%</span>
                <span class="pbc-lg"><span class="pbc-lg-bar" style="background:#f87171"></span>33%↓</span>
            </div>
        </div>`;
    }

    function _inferLeague(homeId, awayId) {
        // teamId → league 매핑: K1 스케줄 캐시에 있으면 k1, 아니면 k2
        const scan = (cache) => cache && (cache.upcoming || []).some(
            g => g.home_id === homeId || g.away_id === homeId || g.home_id === awayId || g.away_id === awayId
        );
        if (scan(k1ScheduleCache)) return "k1";
        return "k2";
    }

    function loadPrediction(homeId, awayId, gameDate, isFinished) {
        _lastHome = homeId; _lastAway = awayId;
        _hideBannerMatchup();  // 예측 열리면 H2H 중복 방지
        console.log(`[예측 시작] ${homeId} vs ${awayId} date=${gameDate} finished=${isFinished}`);
        report.innerHTML = `<div class="pred-loading">분석 중...</div>`;
        const league = _inferLeague(homeId, awayId);
        // 전술 보기 + 사후 분석은 종료된 과거 경기에서만
        const extrasKey = `${gameDate}|${homeId}|${awayId}`;
        const retroKey  = `${gameDate}|${homeId}|${awayId}`;
        const extrasFetch = (isFinished && gameDate)
            ? _cachedFetch(_extrasCache, extrasKey, () =>
                fetch(`/api/match-extras?date=${encodeURIComponent(gameDate)}&home_slug=${encodeURIComponent(homeId)}&away_slug=${encodeURIComponent(awayId)}`)
                    .then(r => r.json()).catch(() => null))
            : Promise.resolve(null);
        const retroFetch = (isFinished && gameDate)
            ? _cachedFetch(_retroCache, retroKey, () =>
                fetch(`/api/match-retrospective?date=${encodeURIComponent(gameDate)}&home_slug=${encodeURIComponent(homeId)}&away_slug=${encodeURIComponent(awayId)}`)
                    .then(r => r.ok ? r.json() : null).catch(() => null))
            : Promise.resolve(null);
        const speFetch = _cachedFetch(_speCache, `${homeId}|${awayId}`, () =>
            fetch(`/api/setpiece-efficiency?home_slug=${encodeURIComponent(homeId)}&away_slug=${encodeURIComponent(awayId)}`)
                .then(r => r.json()).catch(() => null));
        Promise.all([
            _cachedFetch(_predCache, `${homeId}|${awayId}`, () =>
                fetch(`/api/match-prediction?homeTeam=${homeId}&awayTeam=${awayId}`)
                    .then(r => { if (!r.ok) throw new Error(`prediction ${r.status}`); return r.json(); })
                    .catch(e => { console.error("[예측 API 실패]", e); return null; })),
            loadBacktest(league),
            extrasFetch,
            retroFetch,
            speFetch,
        ])
            .then(([data, bt, extras, retro, spe]) => {
                if (homeId !== _lastHome || awayId !== _lastAway) return;
                if (!data || !data.home || !data.away) {
                    console.error("[예측] data 누락:", data);
                    report.innerHTML = `<div class="pred-loading" style="color:#f87171">예측 데이터 로드 실패 — 잠시 후 다시 시도해주세요.</div>`;
                    return;
                }
                try {
                    render(data, homeId, awayId, bt);
                } catch (err) {
                    console.error("[render 실패]", err);
                    report.innerHTML = `<div class="pred-loading" style="color:#f87171">렌더 오류: ${err.message}</div>`;
                    return;
                }
                if (retro && retro.ready) {
                    try { renderRetroCard(data, retro, homeId, awayId); }
                    catch (err) { console.error("[사후분석 렌더 실패]", err); }
                }
                if (extras && extras.ready) {
                    try { renderTacticsCard(extras, homeId, awayId); }
                    catch (err) { console.error("[전술보기 렌더 실패]", err); }
                }
                if (spe && spe.ready) {
                    try { renderSetpieceEffCard(spe); }
                    catch (err) { console.error("[세트피스 효율 렌더 실패]", err); }
                }
            })
            .catch(err => {
                console.error("[Promise.all 실패]", err);
                if (homeId === _lastHome && awayId === _lastAway)
                    report.innerHTML = `<div class="pred-loading" style="color:#f87171">오류: ${err.message}</div>`;
            });
    }

    // ── 예상 라인업 카드 ───────────────────────────────────
    // ── 순위 뱃지 ────────────────────────────────────────────
    function standingBadge(st) {
        if (!st) return "";
        return `<div class="pred-standing">
            <span class="pst-rank">${st.rank}위</span>
            <span class="pst-pts">${st.pts}pts</span>
            <span class="pst-record">${st.w}승 ${st.d}무 ${st.l}패</span>
            <span class="pst-gd" style="color:${st.gd>0?"#4ade80":st.gd<0?"#f87171":"#9ab"}">GD ${st.gd>0?"+":""}${st.gd}</span>
        </div>`;
    }

    // ── 예상 스코어 (포아송 λ 우선, fallback = 평균 득실) ───────
    function predictedScore(home, away, predHome, poisson) {
        if (poisson && typeof poisson.lambda_home === "number" && typeof poisson.lambda_away === "number") {
            return {
                home: poisson.lambda_home.toFixed(1),
                away: poisson.lambda_away.toFixed(1),
            };
        }
        const hAvg = home.avg_gf || 0;
        const aAvg = away.avg_gf || 0;
        const hGA  = home.avg_ga || 0;
        const aGA  = away.avg_ga || 0;
        const expH = Math.max(0, (hAvg + aGA) / 2);
        const expA = Math.max(0, (aAvg + hGA) / 2);
        const bias = (predHome - 50) / 100;
        const adjH = Math.round((expH + bias * 0.5) * 10) / 10;
        const adjA = Math.round((expA - bias * 0.5) * 10) / 10;
        return { home: Math.max(0, adjH).toFixed(1), away: Math.max(0, adjA).toFixed(1) };
    }

    // ── 핵심 매치업 ───────────────────────────────────────────
    function keyMatchups(home, away) {
        const items = [];
        const hGF = home.avg_gf, aGF = away.avg_gf;
        const hGA = home.avg_ga, aGA = away.avg_ga;
        if (hGF && aGA) {
            const advantage = hGF - aGA;
            if (Math.abs(advantage) >= 0.3) {
                items.push(advantage > 0
                    ? `${home.name} 공격(${hGF.toFixed(1)}) > ${away.name} 수비(${aGA.toFixed(1)})`
                    : `${away.name} 수비(${aGA.toFixed(1)}) > ${home.name} 공격(${hGF.toFixed(1)})`);
            }
        }
        if (aGF && hGA) {
            const advantage = aGF - hGA;
            if (Math.abs(advantage) >= 0.3) {
                items.push(advantage > 0
                    ? `${away.name} 공격(${aGF.toFixed(1)}) > ${home.name} 수비(${hGA.toFixed(1)})`
                    : `${home.name} 수비(${hGA.toFixed(1)}) > ${away.name} 공격(${aGF.toFixed(1)})`);
            }
        }
        return items;
    }

    // ── 신뢰도 배지 ─────────────────────────────────────────
    function confidenceBadge(conf, isK1) {
        if (!conf) return "";
        const meta = {
            high: { icon: "🟢", label: "신뢰도 높음", color: "#7bed9f" },
            med:  { icon: "🟡", label: "신뢰도 보통", color: "#facc15" },
            low:  { icon: "🔴", label: "신뢰도 낮음", color: "#f87171" },
        };
        const m = meta[conf.level] || meta.low;

        // 실측 적중률 (backtest 캐시 lookup) — 사용자 신뢰도 텍스트 보정
        const bt = _backtestCache[isK1 ? "k1" : "k2"];
        const bc = bt && bt.by_confidence && bt.by_confidence[conf.level];
        const actualHtml = (bc && bc.total) ? `<span class="pc-actual" style="color:${m.color}aa">실측 ${bc.pct}% (${bc.hit}/${bc.total})</span>` : "";

        const badge = `<div class="pred-confidence" style="border-color:${m.color}55">
            <span class="pc-icon">${m.icon}</span>
            <span class="pc-label" style="color:${m.color}">${m.label}</span>
            ${actualHtml}
            <span class="pc-sub">H2H ${conf.h2h_games}경기 · 시즌 ${conf.season_games}경기</span>
        </div>`;
        if (!isK1 || conf.level === "high") return badge;
        const warn = conf.level === "low"
            ? { bg: "rgba(239,68,68,0.12)", border: "#ef4444", icon: "⚠️", text: "K1 예측 신뢰도 매우 낮음 — 참고 불가" }
            : { bg: "rgba(251,191,36,0.10)", border: "#f59e0b", icon: "📊", text: "K1 데이터 부족 — 참고용으로만 활용" };
        return `${badge}<div class="pred-uncertainty-warn" style="background:${warn.bg};border-color:${warn.border}">
            <span class="puw-icon">${warn.icon}</span>
            <span class="puw-text">${warn.text}</span>
        </div>`;
    }

    // ── 스코어 매트릭스 히트맵 (6x6) ───────────────────────
    function scoreMatrixHtml(matrix, topScores) {
        if (!matrix || !matrix.length) return "";
        // 최대값으로 색 강도 정규화
        let maxP = 0;
        for (const row of matrix) for (const v of row) if (v > maxP) maxP = v;
        const N = matrix.length;
        const topSet = new Set((topScores || []).slice(0, 3).map(s => `${s.home}-${s.away}`));
        const cells = [];
        // 헤더
        cells.push(`<div class="psm-cell psm-corner"></div>`);
        for (let j = 0; j < N; j++) {
            cells.push(`<div class="psm-cell psm-head psm-head-away">${j}${j===N-1?"+":""}</div>`);
        }
        for (let i = 0; i < N; i++) {
            cells.push(`<div class="psm-cell psm-head psm-head-home">${i}${i===N-1?"+":""}</div>`);
            for (let j = 0; j < N; j++) {
                const p = matrix[i][j];
                const intensity = maxP ? p / maxP : 0;
                const diag = i === j;
                const homeWin = i > j;
                const base = diag ? "148,163,184" : homeWin ? "78,164,248" : "184,126,248";
                const bg = `rgba(${base}, ${Math.max(0.05, intensity).toFixed(2)})`;
                const isTop = topSet.has(`${i}-${j}`);
                cells.push(`<div class="psm-cell psm-val${isTop ? " psm-top" : ""}" style="background:${bg}" title="${i}-${j}: ${p.toFixed(1)}%">${p.toFixed(1)}</div>`);
            }
        }
        return `
        <div class="pred-score-matrix">
            <div class="psm-title">스코어 확률 매트릭스</div>
            <div class="psm-axis-label psm-axis-away">원정 →</div>
            <div class="psm-axis-label psm-axis-home">↓ 홈</div>
            <div class="psm-grid" style="grid-template-columns: repeat(${N+1}, 1fr)">
                ${cells.join("")}
            </div>
        </div>`;
    }

    // ── 상위 예측 스코어 ───────────────────────────────────
    function topScoresHtml(top) {
        if (!top || !top.length) return "";
        return `
        <div class="pred-top-scores">
            <div class="pts-title">유력 스코어 TOP 5</div>
            <div class="pts-list">
                ${top.map((s, i) => `
                <div class="pts-row${i === 0 ? " pts-best" : ""}">
                    <span class="pts-rank">${i+1}</span>
                    <span class="pts-score"><span class="pts-h">${s.home}</span>-<span class="pts-a">${s.away}</span></span>
                    <span class="pts-bar-wrap"><span class="pts-bar" style="width:${Math.min(100, s.pct*6)}%"></span></span>
                    <span class="pts-pct">${s.pct}%</span>
                </div>`).join("")}
            </div>
        </div>`;
    }


    // ── 폼 트렌드 라인 (최근 10경기 누적 승점 SVG) ──────────
    function trendLineSvg(points, color) {
        if (!points || points.length < 2) return "";
        const W = 140, H = 36, PAD = 2;
        // 누적 승점
        let cum = 0;
        const cums = points.map(p => (cum += p));
        const maxCum = Math.max(...cums, 1);
        const coords = cums.map((v, i) => {
            const x = PAD + (i / (cums.length - 1)) * (W - PAD*2);
            const y = H - PAD - (v / maxCum) * (H - PAD*2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        return `<svg class="pred-trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            ${cums.map((v, i) => {
                const x = PAD + (i / (cums.length - 1)) * (W - PAD*2);
                const y = H - PAD - (v / maxCum) * (H - PAD*2);
                return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="${color}"/>`;
            }).join("")}
        </svg>`;
    }

    function trendBlockHtml(points, label, color) {
        if (!points || !points.length) return "";
        const total = points.reduce((a, b) => a + b, 0);
        const maxPts = points.length * 3;
        const pct = maxPts ? Math.round(total / maxPts * 100) : 0;
        return `<div class="pred-trend-block">
            <div class="ptb-head"><span class="ptb-label">${label}</span><span class="ptb-pct">${total}/${maxPts}pt · ${pct}%</span></div>
            ${trendLineSvg(points, color)}
        </div>`;
    }

    // ── 세트피스 매치업 카드 ──────────────────────────────
    function setpieceCardHtml(home, away) {
        const h = home.setpiece, a = away.setpiece;
        if (!h || !a) return "";
        if (!h.goals_total && !a.goals_total) return "";
        // 인사이트: 매치업 강/약점
        const insights = [];
        if (h.setpiece_pct !== null && a.setpiece_conceded_pct !== null) {
            if (h.setpiece_pct >= 20 && a.setpiece_conceded_pct >= 25) {
                insights.push(`⚡ ${home.name} 세트피스 강세 (${h.setpiece_pct}%) × ${away.name} 세트피스 수비 약점 (${a.setpiece_conceded_pct}%)`);
            }
        }
        if (a.setpiece_pct !== null && h.setpiece_conceded_pct !== null) {
            if (a.setpiece_pct >= 20 && h.setpiece_conceded_pct >= 25) {
                insights.push(`⚡ ${away.name} 세트피스 강세 (${a.setpiece_pct}%) × ${home.name} 세트피스 수비 약점 (${h.setpiece_conceded_pct}%)`);
            }
        }
        const teamCol = (name, sp, cls) => `
            <div class="sp-team ${cls}">
                <div class="sp-team-name">${name}</div>
                <div class="sp-stat">
                    <div class="sp-stat-bar">
                        <div class="sp-stat-bar-fill sp-off" style="width:${Math.min(100, (sp.setpiece_pct || 0) * 3)}%"></div>
                        <span class="sp-stat-val">${sp.setpiece_pct !== null ? sp.setpiece_pct + "%" : "—"}</span>
                    </div>
                    <div class="sp-stat-lbl">세트피스 득점 비율 <span class="sp-stat-sub">(${sp.setpiece_goals}/${sp.goals_total}골)</span></div>
                </div>
                <div class="sp-stat">
                    <div class="sp-stat-bar">
                        <div class="sp-stat-bar-fill sp-def" style="width:${Math.min(100, (sp.setpiece_conceded_pct || 0) * 3)}%"></div>
                        <span class="sp-stat-val">${sp.setpiece_conceded_pct !== null ? sp.setpiece_conceded_pct + "%" : "—"}</span>
                    </div>
                    <div class="sp-stat-lbl">세트피스 실점 비율 <span class="sp-stat-sub">(${sp.setpiece_conceded}/${sp.conceded_total}골)</span></div>
                </div>
                <div class="sp-split">
                    <span class="sp-tag sp-pk">PK ${sp.penalty_goals}</span>
                    <span class="sp-tag sp-fk">FK/세트 ${sp.freekick_goals}</span>
                </div>
            </div>`;
        return `
        <div class="pred-setpiece">
            <div class="sp-title">⚽ 세트피스 매치업</div>
            <div class="sp-grid">
                ${teamCol(home.name, h, "sp-home")}
                ${teamCol(away.name, a, "sp-away")}
            </div>
            ${insights.length ? `<div class="sp-insights">${insights.map(i => `<div class="sp-insight">${i}</div>`).join("")}</div>` : ""}
        </div>`;
    }

    // ── 카드(옐로/레드) 매치업 카드 ──────────────────────────
    function cardsCardHtml(home, away) {
        const h = home.cards, a = away.cards;
        if (!h || !a || (!h.games && !a.games)) return "";

        // 인사이트: 거친 팀 / 신사적 팀 매치업
        const insights = [];
        if (h.y_per_game !== null && h.y_per_game >= 3.0)
            insights.push(`🟨 ${home.name} 거친 경기 운영 (경기당 옐로 ${h.y_per_game}장)`);
        if (a.y_per_game !== null && a.y_per_game >= 3.0)
            insights.push(`🟨 ${away.name} 거친 경기 운영 (경기당 옐로 ${a.y_per_game}장)`);
        if (h.r_per_game !== null && h.r_per_game >= 0.2)
            insights.push(`🟥 ${home.name} 퇴장 잦음 (${h.red}회/${h.games}경기)`);
        if (a.r_per_game !== null && a.r_per_game >= 0.2)
            insights.push(`🟥 ${away.name} 퇴장 잦음 (${a.red}회/${a.games}경기)`);

        // 두 팀 비교: y_per_game 더 큰 쪽 강조
        const maxYpg = Math.max(h.y_per_game || 0, a.y_per_game || 0, 1);
        const teamCol = (name, c, cls) => `
            <div class="cd-team ${cls}">
                <div class="cd-team-name">${name}</div>
                <div class="cd-stat">
                    <div class="cd-stat-bar">
                        <div class="cd-stat-bar-fill cd-yellow" style="width:${Math.min(100, (c.y_per_game || 0) / maxYpg * 100)}%"></div>
                        <span class="cd-stat-val">${c.y_per_game !== null ? c.y_per_game : "—"}</span>
                    </div>
                    <div class="cd-stat-lbl">경기당 옐로 <span class="cd-stat-sub">(${c.yellow}장 / ${c.games}경기)</span></div>
                </div>
                <div class="cd-split">
                    <span class="cd-tag cd-y">🟨 ${c.yellow}</span>
                    <span class="cd-tag cd-r">🟥 ${c.red}</span>
                </div>
            </div>`;
        return `
        <div class="pred-cards">
            <div class="cd-title">🟨 카드 추세</div>
            <div class="cd-grid">
                ${teamCol(home.name, h, "cd-home")}
                ${teamCol(away.name, a, "cd-away")}
            </div>
            ${insights.length ? `<div class="cd-insights">${insights.map(i => `<div class="cd-insight">${i}</div>`).join("")}</div>` : ""}
        </div>`;
    }

    // ── 팀 스타일(빌드업/경합/돌파) 매치업 카드 ────────────────
    function styleCardHtml(home, away) {
        const h = home.style, a = away.style;
        if (!h || !a || (!h.games && !a.games)) return "";

        // 인사이트: 빌드업/경합 매치업 강·약점
        const insights = [];
        // 롱볼 빌드업 vs 빌드업 약점 (한 쪽만 강하면 의미)
        if (h.long_ball_pct !== null && h.long_ball_pct >= 60 && h.long_ball_pg >= 35)
            insights.push(`📡 ${home.name} 롱볼 빌드업 강세 (정확도 ${h.long_ball_pct}%, 경기당 ${h.long_ball_pg}회)`);
        if (a.long_ball_pct !== null && a.long_ball_pct >= 60 && a.long_ball_pg >= 35)
            insights.push(`📡 ${away.name} 롱볼 빌드업 강세 (정확도 ${a.long_ball_pct}%, 경기당 ${a.long_ball_pg}회)`);
        // 경합 우위
        if (h.duel_pct !== null && a.duel_pct !== null && Math.abs(h.duel_pct - a.duel_pct) >= 5) {
            const winner = h.duel_pct > a.duel_pct ? home.name : away.name;
            const wp = Math.max(h.duel_pct, a.duel_pct);
            insights.push(`⚔ ${winner} 듀얼 우위 (승률 ${wp}%)`);
        }
        // 공중볼 강세
        if (h.aerial_pct !== null && h.aerial_pct >= 55)
            insights.push(`🦅 ${home.name} 공중볼 강세 (승률 ${h.aerial_pct}%)`);
        if (a.aerial_pct !== null && a.aerial_pct >= 55)
            insights.push(`🦅 ${away.name} 공중볼 강세 (승률 ${a.aerial_pct}%)`);
        // 돌파 강세
        if (h.dribble_pct !== null && h.dribble_pct >= 55 && h.dribble_pg >= 8)
            insights.push(`💨 ${home.name} 돌파 강세 (성공률 ${h.dribble_pct}%, 경기당 ${h.dribble_pg}회)`);
        if (a.dribble_pct !== null && a.dribble_pct >= 55 && a.dribble_pg >= 8)
            insights.push(`💨 ${away.name} 돌파 강세 (성공률 ${a.dribble_pct}%, 경기당 ${a.dribble_pg}회)`);

        // 각 팀의 "리그 대비 상위 능력" 표시 (동일지표 맞대결 X)
        const META = {
            long_ball_pct: { icon: "📡", label: "롱볼 정확도" },
            cross_pct:     { icon: "🎯", label: "크로스 정확도" },
            duel_pct:      { icon: "⚔",  label: "듀얼 승률" },
            aerial_pct:    { icon: "🦅", label: "공중볼 승률" },
            dribble_pct:   { icon: "💨", label: "드리블 성공률" },
        };
        const strengths = (s) => {
            const r = s.ranks || {};
            const items = [];
            for (const [key, meta] of Object.entries(META)) {
                const rk = r[key];
                if (!rk || s[key] == null) continue;
                if (rk.rank <= Math.ceil(rk.total / 2)) {   // 리그 상위 절반만 = "상위 능력"
                    items.push({ ...meta, value: s[key], rank: rk.rank, total: rk.total });
                }
            }
            items.sort((x, y) => x.rank - y.rank);
            return items;
        };
        const teamCol = (name, s, cls) => {
            const items = strengths(s);
            const body = items.length
                ? items.map(it => {
                    const topTier = it.rank <= Math.ceil(it.total / 3);
                    return `<div class="ts-strength${topTier ? " ts-strength-top" : ""}">
                        <span class="ts-st-ic">${it.icon}</span>
                        <span class="ts-st-lbl">${it.label}</span>
                        <span class="ts-st-rank">리그 ${it.rank}/${it.total}위</span>
                        <span class="ts-st-val">${it.value}%</span>
                    </div>`;
                  }).join("")
                : `<div class="ts-strength-none">리그 상위 능력 없음</div>`;
            return `<div class="ts-team ${cls}">
                <div class="ts-team-name">${name}</div>
                ${body}
            </div>`;
        };
        return `
        <div class="pred-style">
            <div class="ts-title">⚔ 팀 스타일 — 리그 대비 강점</div>
            <div class="ts-grid">
                ${teamCol(home.name, h, "ts-home")}
                ${teamCol(away.name, a, "ts-away")}
            </div>
            ${insights.length ? `<div class="ts-insights">${insights.map(i => `<div class="ts-insight">${i}</div>`).join("")}</div>` : ""}
        </div>`;
    }

    // ── 골 타이밍 (15분 구간 히트맵) ──────────────────────────
    function timingBarsHtml(timing, label) {
        if (!timing) return "";
        const tf = timing["for"] || [], ta = timing["against"] || [];
        // 6버킷(15분) 기대. 구형 2버킷 데이터면 전/후반만이라도 방어 표시.
        const LABELS = (tf.length > 2 || ta.length > 2)
            ? ["0-15", "16-30", "31-45", "46-60", "61-75", "76-90"]
            : ["전반", "후반"];
        const cols = LABELS.length;
        const maxF = Math.max(1, ...tf), maxA = Math.max(1, ...ta);
        const cell = (v, max, type) => {
            const op = v ? (0.18 + 0.60 * (v / max)) : 0;
            const bg = type === "f" ? `rgba(78,164,248,${op.toFixed(2)})` : `rgba(248,113,113,${op.toFixed(2)})`;
            return `<td class="ptm-cell" style="background:${bg}">${v || "·"}</td>`;
        };
        const sum = arr => arr.reduce((s, v) => s + (v || 0), 0);
        const hdr = LABELS.map(l => `<th>${l}</th>`).join("");
        const fRow = Array.from({length: cols}, (_, i) => cell(tf[i] || 0, maxF, "f")).join("");
        const aRow = Array.from({length: cols}, (_, i) => cell(ta[i] || 0, maxA, "a")).join("");
        return `<div class="pred-timing">
            <div class="ptm-head">${label} 골 타이밍 <span class="ptm-sub">15분 구간 · 색 진할수록 多</span></div>
            <table class="ptm-table">
                <thead><tr><th class="ptm-corner"></th>${hdr}<th class="ptm-tot">계</th></tr></thead>
                <tbody>
                    <tr><td class="ptm-rlbl ptm-rlbl-f">득점</td>${fRow}<td class="ptm-totv">${sum(tf)}</td></tr>
                    <tr><td class="ptm-rlbl ptm-rlbl-a">실점</td>${aRow}<td class="ptm-totv">${sum(ta)}</td></tr>
                </tbody>
            </table>
        </div>`;
    }

    // ── 렌더링 ───────────────────────────────────────────────
    function render(d, homeId, awayId, backtest) {
        const { home, away, h2h, prediction } = d;
        const MONTHS = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
        const nowMonth = new Date().getMonth();
        const score = predictedScore(home, away, prediction.home, d.poisson);
        const matchups = keyMatchups(home, away);
        const isK1 = _inferLeague(homeId, awayId) === "k1";
        const isUncertain = isK1 && d.confidence && d.confidence.level !== "high";

        // 다음 경기 배너에서 이 매치의 정보 가져오기 (K1/K2 모두 참조)
        let nextInfo = null;
        for (const cache of [scheduleCache, k1ScheduleCache]) {
            if (!cache) continue;
            nextInfo = (cache.upcoming || []).find(
                g => g.home_id === homeId && g.away_id === awayId
            );
            if (nextInfo) break;
        }

        report.innerHTML = `
        ${nextInfo ? `
        <div class="pred-match-header">
            <span class="pmh-round">R${nextInfo.round || "-"}</span>
            <span class="pmh-date">${nextInfo.date.replace(/\./g,"/")} ${nextInfo.time}</span>
            <span class="pmh-venue">${nextInfo.venue}</span>
        </div>` : ""}
        ${backtestBannerHtml(backtest)}

        <div class="pred-grid">

            <!-- 홈팀 -->
            <div class="pred-team-panel pred-home">
                <div class="pred-team-name">${home.name}</div>
                ${standingBadge(home.standing)}
                <div class="pred-badges">${formBadges(home.form)}</div>
                ${trendBlockHtml(home.form_points, "최근 10경기 승점", "#4ea4f8")}
                <div class="pred-stats-row">
                    <div class="pred-stat"><span class="ps-val">${home.home_wr.toFixed(0)}%</span><span class="ps-lbl">홈 승률</span></div>
                    <div class="pred-stat"><span class="ps-val">${home.avg_gf.toFixed(1)}</span><span class="ps-lbl">경기당 득점</span></div>
                    <div class="pred-stat"><span class="ps-val">${home.avg_ga.toFixed(1)}</span><span class="ps-lbl">경기당 실점</span></div>
                    ${home.month_wr !== null ? `<div class="pred-stat"><span class="ps-val" style="color:${monthColor(home.month_wr)}">${home.month_wr.toFixed(0)}%</span><span class="ps-lbl">${MONTHS[nowMonth]} 승률</span></div>` : ""}
                    ${typeof home.xg_for === "number" ? `<div class="pred-stat"><span class="ps-val">${home.xg_for.toFixed(2)}</span><span class="ps-lbl">경기당 xG</span></div>` : ""}
                </div>
                <div class="pred-notes">
                    ${home.notes.map(n => `<div class="pred-note">• ${n}</div>`).join("") || "<div class='pred-note pred-note-none'>특이사항 없음</div>"}
                </div>
                ${home.top_scorers.length ? `
                <div class="pred-scorers">
                    <div class="pred-scorers-title">이번 시즌 득점</div>
                    ${home.top_scorers.map(s => `<div class="pred-scorer-row"><span class="scorer-name scorer-link" data-player-id="${s.id}">${s.name}</span><span class="scorer-g">${s.goals}골</span></div>`).join("")}
                </div>` : ""}
            </div>

            <!-- 중앙 예측 -->
            <div class="pred-center${isUncertain ? " pred-center--uncertain" : ""}">
                ${confidenceBadge(d.confidence, isK1)}
                <div class="pred-center-title">예상 결과</div>
                <div class="pred-prob-bar${isUncertain ? " pred-prob-bar--uncertain" : ""}">
                    <div class="ppb-home" style="width:${prediction.home}%">${prediction.home}%</div>
                    <div class="ppb-draw" style="width:${prediction.draw}%">${prediction.draw}%</div>
                    <div class="ppb-away" style="width:${prediction.away}%">${prediction.away}%</div>
                </div>
                <div class="pred-prob-labels">
                    <span style="color:#4ea4f8">홈 승</span>
                    <span style="color:#888">무승부</span>
                    <span style="color:#b87ef8">원정 승</span>
                </div>

                <div class="pred-score-est">
                    <span class="pse-label">예상 스코어 (λ)</span>
                    <span class="pse-score">${score.home} - ${score.away}</span>
                </div>

                <div class="pred-h2h">
                    <div class="pred-h2h-title">직접 전적 (K2)</div>
                    ${h2h.games > 0 ? `
                    <div class="pred-h2h-row">
                        <span class="h2h-val" style="color:#4ea4f8">${h2h.home_w}승</span>
                        <span class="h2h-sep">${h2h.games}경기</span>
                        <span class="h2h-val" style="color:#b87ef8">${h2h.away_w}승</span>
                    </div>
                    <div class="pred-h2h-draw">${h2h.draw}무</div>
                    ` : `<div class="pred-note-none">전적 없음</div>`}
                </div>

                ${matchups.length ? `
                <div class="pred-matchup-keys">
                    <div class="pmk-title">핵심 지표</div>
                    ${matchups.map(m => `<div class="pmk-item">⚡ ${m}</div>`).join("")}
                </div>` : ""}
            </div>

            <!-- 원정팀 -->
            <div class="pred-team-panel pred-away">
                <div class="pred-team-name">${away.name}</div>
                ${standingBadge(away.standing)}
                <div class="pred-badges">${formBadges(away.form)}</div>
                ${trendBlockHtml(away.form_points, "최근 10경기 승점", "#b87ef8")}
                <div class="pred-stats-row">
                    <div class="pred-stat"><span class="ps-val">${away.away_wr.toFixed(0)}%</span><span class="ps-lbl">원정 승률</span></div>
                    <div class="pred-stat"><span class="ps-val">${away.avg_gf.toFixed(1)}</span><span class="ps-lbl">경기당 득점</span></div>
                    <div class="pred-stat"><span class="ps-val">${away.avg_ga.toFixed(1)}</span><span class="ps-lbl">경기당 실점</span></div>
                    ${away.month_wr !== null ? `<div class="pred-stat"><span class="ps-val" style="color:${monthColor(away.month_wr)}">${away.month_wr.toFixed(0)}%</span><span class="ps-lbl">${MONTHS[nowMonth]} 승률</span></div>` : ""}
                    ${typeof away.xg_for === "number" ? `<div class="pred-stat"><span class="ps-val">${away.xg_for.toFixed(2)}</span><span class="ps-lbl">경기당 xG</span></div>` : ""}
                </div>
                <div class="pred-notes">
                    ${away.notes.map(n => `<div class="pred-note">• ${n}</div>`).join("") || "<div class='pred-note pred-note-none'>특이사항 없음</div>"}
                </div>
                ${away.top_scorers.length ? `
                <div class="pred-scorers">
                    <div class="pred-scorers-title">이번 시즌 득점</div>
                    ${away.top_scorers.map(s => `<div class="pred-scorer-row"><span class="scorer-name scorer-link" data-player-id="${s.id}">${s.name}</span><span class="scorer-g">${s.goals}골</span></div>`).join("")}
                </div>` : ""}
            </div>

        </div>

        <!-- 확장 분석 섹션 -->
        <div class="pred-extras">
            <div class="pred-extras-row">
                ${scoreMatrixHtml(d.score_matrix, d.top_scores)}
                ${topScoresHtml(d.top_scores)}
            </div>
            <div class="pred-extras-row">
                ${timingBarsHtml(home.goal_timing, home.name)}
                ${timingBarsHtml(away.goal_timing, away.name)}
            </div>
            ${setpieceCardHtml(home, away)}
            <div class="pred-style-cards-grid">
                ${styleCardHtml(home, away)}
                ${cardsCardHtml(home, away)}
            </div>
        </div>`;

        // 이벤트 위임: 선수 클릭(scorer-link) → 선수 분석
        report.addEventListener("click", (e) => {
            const playerEl = e.target.closest(".scorer-link");
            if (playerEl) {
                const pid = parseInt(playerEl.dataset.playerId);
                if (!pid) return;
                document.dispatchEvent(new CustomEvent("playerSelected", {
                    detail: { playerId: pid, playerName: playerEl.textContent.trim() }
                }));
                return;
            }
        });
    }

    function formBadges(form) {
        return (form || []).map(r => {
            const cls = r === "W" ? "fb-w" : r === "D" ? "fb-d" : "fb-l";
            const lbl = r === "W" ? "승" : r === "D" ? "무" : "패";
            return `<span class="form-badge ${cls}">${lbl}</span>`;
        }).join("");
    }

    function monthColor(pct) {
        if (pct >= 55) return "#7bed9f";
        if (pct <= 30) return "#f87171";
        return "#c8d8f0";
    }

    let _lastHome = null, _lastAway = null;

    // ── 예측 사후 분석 카드 ─────────────────────────────────
    function renderRetroCard(predData, retro, homeId, awayId) {
        const wrap = report.querySelector(".pred-extras");
        if (!wrap) return;
        const old = wrap.querySelector(".pred-retro");
        if (old) old.remove();

        const home = predData.home, away = predData.away, pred = predData.prediction;
        const result = retro.result;
        const xg = retro.xg;

        // 1X2 적중 판정
        const predMax = Math.max(pred.home, pred.draw, pred.away);
        const predOut = pred.home === predMax ? "home" : pred.draw === predMax ? "draw" : "away";
        const actOut = result.home > result.away ? "home" : result.home < result.away ? "away" : "draw";
        const hit1x2 = predOut === actOut;
        const labelMap = { home: home.name + " 승", draw: "무승부", away: away.name + " 승" };
        const predPctMap = { home: pred.home, draw: pred.draw, away: pred.away };

        // 스코어 적중
        const exp = predictedScore(home, away, pred.home, predData.poisson);
        const topScores = predData.top_scores || [];
        const exactHit = topScores.length > 0
            && topScores[0].home === result.home && topScores[0].away === result.away;
        const top3Hit = topScores.slice(0, 3).some(s => s.home === result.home && s.away === result.away);
        const expGap = Math.abs((parseFloat(exp.home) + parseFloat(exp.away)) - (result.home + result.away));

        // 핀인 생성
        const pins = [];
        // xG-실득 괴리
        if (xg.home > 0 && result.home - xg.home >= 0.8)
            pins.push(`⚡ ${home.name} 결정력 폭발 — xG ${xg.home.toFixed(1)} 대비 ${result.home}득점`);
        else if (xg.home > 0 && xg.home - result.home >= 0.8 && result.home === 0)
            pins.push(`💧 ${home.name} 마무리 부진 — xG ${xg.home.toFixed(1)} 만들고도 무득점`);
        if (xg.away > 0 && result.away - xg.away >= 0.8)
            pins.push(`⚡ ${away.name} 결정력 폭발 — xG ${xg.away.toFixed(1)} 대비 ${result.away}득점`);
        else if (xg.away > 0 && xg.away - result.away >= 0.8 && result.away === 0)
            pins.push(`💧 ${away.name} 마무리 부진 — xG ${xg.away.toFixed(1)} 만들고도 무득점`);
        // 세트피스
        if (retro.setpiece.home > 0)
            pins.push(`🎯 ${home.name} 세트피스 ${retro.setpiece.home}골`);
        if (retro.setpiece.away > 0)
            pins.push(`🎯 ${away.name} 세트피스 ${retro.setpiece.away}골`);
        // PK / 자책골
        if (retro.penalty.home > 0)
            pins.push(`⚽ ${home.name} PK ${retro.penalty.home}골`);
        if (retro.penalty.away > 0)
            pins.push(`⚽ ${away.name} PK ${retro.penalty.away}골`);
        if (retro.owngoal.home > 0)
            pins.push(`💔 ${away.name} 자책골로 ${home.name} 득점`);
        if (retro.owngoal.away > 0)
            pins.push(`💔 ${home.name} 자책골로 ${away.name} 득점`);
        // 조기 퇴장
        if (retro.redcard.earliest_min != null && retro.redcard.earliest_min < 70) {
            const side = retro.redcard.home > 0 ? home.name : away.name;
            pins.push(`🟥 ${side} ${retro.redcard.earliest_min}' 퇴장 — 인원 우위/열세 영향`);
        }
        // 무승부에 예측 빗나간 케이스
        if (!hit1x2 && actOut === "draw")
            pins.push(`🤝 무승부 가능성(${pred.draw}%) 빗나감 — 양 팀 결정력 균형`);

        // ── 빗나간 매치 한정 — 실패 분석 핀인 ──────────────────
        if (!hit1x2) {
            // 1) 모델 예측 분포 — 사용자가 모델이 얼마나 빗나갔나 한눈에
            pins.unshift(`🎯 모델 예측 ${labelMap[predOut]} ${predPctMap[predOut]}% → 실제 ${labelMap[actOut]} (모델 ${predPctMap[actOut]}%)`);

            // 2) 폼 격차 무시 — 최근 10경기 승점 합산 비교
            const homePts = (home.form_points || []).reduce((a, b) => a + b, 0);
            const awayPts = (away.form_points || []).reduce((a, b) => a + b, 0);
            if (Math.abs(homePts - awayPts) >= 6) {
                const strongerOut = homePts > awayPts ? "home" : "away";
                if (actOut !== strongerOut && actOut !== "draw") {
                    const stronger = homePts > awayPts ? home : away;
                    const weaker   = homePts > awayPts ? away : home;
                    pins.push(`📉 폼 격차 무시: 최근 10경기 ${stronger.name} ${Math.max(homePts, awayPts)}점 vs ${weaker.name} ${Math.min(homePts, awayPts)}점 — 약팀 upset`);
                }
            }

            // 3) H2H 우세 역전
            const h2h = predData.h2h;
            if (h2h && h2h.games >= 5) {
                const dom = h2h.home_w > h2h.away_w + 1 ? "home"
                          : h2h.away_w > h2h.home_w + 1 ? "away" : null;
                if (dom && dom !== actOut) {
                    const domName = dom === "home" ? home.name : away.name;
                    pins.push(`🔄 H2H 우세 역전: 직전 ${h2h.games}경기 ${domName} 우세(${h2h.home_w}승 ${h2h.draw}무 ${h2h.away_w}패)였으나 결과 반대`);
                }
            }

            // 4) xG 거의 동률 + non-draw 결과 → 결정력 차이
            const xgDiff = Math.abs((xg.home || 0) - (xg.away || 0));
            if (xgDiff < 0.5 && (xg.home > 0 || xg.away > 0) && actOut !== "draw") {
                const winner = actOut === "home" ? home.name : away.name;
                pins.push(`⚡ xG 거의 동률(${xg.home.toFixed(1)} vs ${xg.away.toFixed(1)}) — ${winner} 결정력 우위`);
            }
        }

        // 스코어 태그
        let scoreTag, scoreTagClass;
        if (exactHit) { scoreTag = "정확"; scoreTagClass = "rr-tag-exact"; }
        else if (top3Hit) { scoreTag = "TOP3"; scoreTagClass = "rr-tag-top3"; }
        else { scoreTag = `±${expGap.toFixed(1)}골`; scoreTagClass = "rr-tag-near"; }

        const html = `
        <div class="pred-retro">
            <div class="retro-header">
                <span class="retro-title">🎯 예측 후기</span>
                <span class="retro-verdict ${hit1x2 ? "retro-hit" : "retro-miss"}">
                    ${hit1x2 ? "✅ 적중" : "❌ 빗나감"}
                </span>
                <button class="retro-share" title="이 매치 URL 복사 — 공유" type="button">🔗 공유</button>
                ${retro.event_id ? `<a class="retro-export"
                    href="/api/match-lineup.csv?event_id=${retro.event_id}"
                    title="라인업 CSV 다운로드 — 분석가/코치 export"
                    download>📥 CSV</a>` : ""}
            </div>
            <div class="retro-rows">
                <div class="retro-row">
                    <span class="rr-label">1X2</span>
                    <span class="rr-pred">${labelMap[predOut]} <em>(${predPctMap[predOut]}%)</em></span>
                    <span class="rr-arrow">→</span>
                    <span class="rr-actual">${labelMap[actOut]}</span>
                </div>
                <div class="retro-row">
                    <span class="rr-label">스코어</span>
                    <span class="rr-pred">${exp.home}-${exp.away} 예상</span>
                    <span class="rr-arrow">→</span>
                    <span class="rr-actual">${result.home}-${result.away} 실제</span>
                    <span class="rr-tag ${scoreTagClass}">${scoreTag}</span>
                </div>
                ${(xg.home || xg.away) ? `
                <div class="retro-row">
                    <span class="rr-label">xG (실제 슛 ${xg.shots_home + xg.shots_away}개)</span>
                    <span class="rr-actual">${xg.home.toFixed(2)} - ${xg.away.toFixed(2)}</span>
                </div>` : ""}
            </div>
            ${pins.length ? `
            <div class="retro-pins">
                ${pins.map(p => `<div class="retro-pin">${p}</div>`).join("")}
            </div>` : ""}
        </div>`;
        wrap.insertAdjacentHTML("beforeend", html);
        // 공유 버튼 — URL 클립보드 복사
        const shareBtn = wrap.querySelector(".pred-retro:last-child .retro-share");
        if (shareBtn) {
            shareBtn.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(window.location.href);
                    const orig = shareBtn.textContent;
                    shareBtn.textContent = "✓ 복사됨";
                    shareBtn.classList.add("retro-share-ok");
                    setTimeout(() => {
                        shareBtn.textContent = orig;
                        shareBtn.classList.remove("retro-share-ok");
                    }, 1500);
                } catch (e) {
                    shareBtn.textContent = "복사 실패";
                }
            });
        }
    }

    // ── 전술 보기 카드 (평균 포지션 + 슛맵) ─────────────────
    function renderTacticsCard(extras, homeId, awayId) {
        const hc = tc(homeId), ac = tc(awayId);
        // 키트 색 (메인 전술판과 동일 규칙): 홈 팀=home 키트(primary), 어웨이=away 키트(흰색 + border_away)
        const hKit = kit(homeId), aKit = kit(awayId);
        const homeFill   = (hKit && hKit.primary) || hc.p || "#4ea4f8";
        const homeStroke = (hKit && (hKit.border_home || hKit.secondary)) || "#ffffff";
        const homeText   = "#ffffff";
        const awayFill   = "#ffffff";
        const awayStroke = (aKit && (aKit.border_away || aKit.primary)) || ac.p || "#b87ef8";
        const awayText   = "#000000";
        // 헤더/패널 색 표기는 fill 색 사용 (홈=team primary, 어웨이=흰색은 가독성 떨어져 stroke 색으로)
        const homeColor = homeFill;
        const awayColor = awayStroke;

        // 기존 pred-extras 안에 카드 삽입 (중복 방지)
        const wrap = report.querySelector(".pred-extras");
        if (!wrap) return;
        let card = wrap.querySelector(".pred-tactics");
        if (card) card.remove();

        const subs = Array.isArray(extras.subs) ? extras.subs : [];
        const subRow = (s) => {
            const out = s.out ? `<span class="pt-sub-out">${s.out.shirt ? '#' + s.out.shirt + ' ' : ''}${s.out.name || '-'}</span>` : '<span class="pt-sub-out pt-sub-empty">-</span>';
            const inn = s.in  ? `<span class="pt-sub-in">${s.in.shirt ? '#' + s.in.shirt + ' ' : ''}${s.in.name || '-'}</span>`     : '<span class="pt-sub-in pt-sub-empty">-</span>';
            return `<div class="pt-sub-item"><span class="pt-sub-min">${s.minute}'</span>${out}<span class="pt-sub-arrow">→</span>${inn}</div>`;
        };
        const homeSubs = subs.filter(s => s.is_home === 1).map(subRow).join("");
        const awaySubs = subs.filter(s => s.is_home === 0).map(subRow).join("");
        const subsPanelHtml = (homeSubs || awaySubs) ? `
            <div class="pt-subs">
                <div class="pt-subs-col">
                    <div class="pt-subs-title" style="color:${homeColor}">↻ 홈 교체</div>
                    ${homeSubs || '<div class="pt-subs-empty">교체 없음</div>'}
                </div>
                <div class="pt-subs-col">
                    <div class="pt-subs-title" style="color:${awayColor}">↻ 원정 교체</div>
                    ${awaySubs || '<div class="pt-subs-empty">교체 없음</div>'}
                </div>
            </div>` : "";

        const html = `
        <div class="pred-tactics">
            <div class="pt-header">
                <div class="pt-title-row">
                    <span class="pt-title">전술 보기</span>
                </div>
                <div class="pt-filter-row">
                    <div class="pt-filter" role="tablist">
                        <button class="pt-filter-btn active" data-filter="all">전체</button>
                        <button class="pt-filter-btn" data-filter="home" style="--c:${homeColor}">홈</button>
                        <button class="pt-filter-btn" data-filter="away" style="--c:${awayColor}">원정</button>
                    </div>
                    <div class="pt-mode" role="tablist">
                        <button class="pt-mode-btn active" data-mode="starter">선발</button>
                        <button class="pt-mode-btn" data-mode="post">교체 후</button>
                    </div>
                </div>
            </div>
            ${subsPanelHtml}
            <div class="pt-grid">
                <div class="pt-panel">
                    <div class="pt-panel-title">평균 포지션</div>
                    <canvas class="pt-canvas" id="pt-canvas-avg" width="520" height="340"></canvas>
                    <div class="pt-hint">홈 좌→우 / 원정 우→좌 공격 · 점에 마우스를 올리면 선수 정보</div>
                    <div class="pt-tooltip" id="pt-tooltip-avg" hidden></div>
                </div>
                <div class="pt-panel">
                    <div class="pt-panel-title">슛맵 <span class="pt-shotcount"></span></div>
                    <canvas class="pt-canvas" id="pt-canvas-shot" width="520" height="340"></canvas>
                    <div class="pt-shot-legend">
                        <span class="pt-sl"><i class="psl-dot psl-goal"></i>골</span>
                        <span class="pt-sl"><i class="psl-dot psl-save"></i>세이브</span>
                        <span class="pt-sl"><i class="psl-dot psl-miss"></i>빗나감</span>
                        <span class="pt-sl"><i class="psl-dot psl-block"></i>블록</span>
                        <span class="pt-sl"><i class="psl-dot psl-post"></i>골대</span>
                    </div>
                    <div class="pt-tooltip" id="pt-tooltip-shot" hidden></div>
                </div>
            </div>
        </div>`;
        wrap.insertAdjacentHTML("beforeend", html);
        card = wrap.querySelector(".pred-tactics");

        const avgCanvas = card.querySelector("#pt-canvas-avg");
        const shotCanvas = card.querySelector("#pt-canvas-shot");
        const avgTooltip  = card.querySelector("#pt-tooltip-avg");
        const shotTooltip = card.querySelector("#pt-tooltip-shot");
        const sct = card.querySelector(".pt-shotcount");

        const allPositions = Array.isArray(extras.avg_positions) ? extras.avg_positions : [];
        const allShots     = Array.isArray(extras.shots)         ? extras.shots         : [];
        // 교체 후 모드용 — OUT된 선발 player_id 집합 (교체로 빠진 사람 제외)
        const outPids = new Set();
        (Array.isArray(extras.subs) ? extras.subs : []).forEach(s => {
            const pid = s && s.out && s.out.player_id;
            if (pid) outPids.add(pid);
        });

        function getCurrentFilter() {
            const active = card.querySelector(".pt-filter-btn.active");
            return active ? active.dataset.filter : "all";
        }
        function getCurrentMode() {
            const active = card.querySelector(".pt-mode-btn.active");
            return active ? active.dataset.mode : "starter";
        }

        function redraw() {
            const filter = getCurrentFilter();
            const mode   = getCurrentMode();
            // 팀 필터 + 출전 종류 필터
            //   - starter 모드: 선발 11명만 (시작 라인업)
            //   - post    모드: 선발 - OUT + 교체 IN = 현재 11명 (교체 반영 후)
            const positions = allPositions.filter(p => {
                if (filter === "home" && p.is_home !== 1) return false;
                if (filter === "away" && p.is_home !== 0) return false;
                const isStarter = p.is_starter === 1 || p.is_starter === true;
                if (mode === "starter") return isStarter;
                // post: 선발 중 OUT 안 된 사람 + 교체로 들어온 sub
                if (isStarter && outPids.has(p.player_id)) return false;
                return true;
            });
            // 슛맵은 출전 종류와 무관 (선수가 누구건 슛은 슛)
            const shots = allShots.filter(s =>
                filter === "all" ? true :
                filter === "home" ? s.is_home === 1 : s.is_home === 0
            );
            try {
                const homeKit = { fill: homeFill, stroke: homeStroke, text: homeText };
                const awayKit = { fill: awayFill, stroke: awayStroke, text: awayText };
                drawAvgPositions(avgCanvas, positions, homeKit, awayKit, avgTooltip);
                drawShotmap(shotCanvas, shots, homeKit, awayKit, shotTooltip);
            } catch (err) {
                console.error("[전술 보기 redraw 실패]", err);
            }
            if (sct) sct.textContent = `(${shots.length}슛)`;
        }

        // 초기 렌더 + 토글 이벤트
        redraw();
        card.querySelectorAll(".pt-filter-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                card.querySelectorAll(".pt-filter-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                redraw();
            });
        });
        card.querySelectorAll(".pt-mode-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                card.querySelectorAll(".pt-mode-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                redraw();
            });
        });
    }

    // ── 세트피스 효율 카드 (코너킥/프리킥/PK 분리 + 리그 평균) ──────
    function renderSetpieceEffCard(spe) {
        const wrap = report.querySelector(".pred-extras");
        if (!wrap) return;
        const old = wrap.querySelector(".pred-setpiece-eff");
        if (old) old.remove();

        const TYPES = [
            { key: "corner",    icon: "⛳", label: "코너킥",     desc: "Corner Kick" },
            { key: "free-kick", icon: "🎯", label: "프리킥 슛",   desc: "Direct Free-kick" },
            { key: "penalty",   icon: "🥅", label: "페널티킥",   desc: "Penalty Kick" },
        ];

        const home = spe.home, away = spe.away, avg = spe.league_avg;
        const homeColor = home.primary || "#4ea4f8";
        const awayColor = away.primary || "#b87ef8";

        const SIT_ICON = { "corner": "⛳", "free-kick": "🎯", "penalty": "🥅" };
        const spContribRow = (p, color) => {
            const sits = Object.entries(p.by_sit || {})
                .sort((a, b) => b[1].goals - a[1].goals || b[1].shots - a[1].shots)
                .map(([sit, v]) => `<span class="spe-contrib-sit" title="${sit} ${v.shots}시도 ${v.goals}골">${SIT_ICON[sit] || "·"}${v.goals ? `<b>${v.goals}</b>` : v.shots}</span>`)
                .join("");
            const xgTip = p.total_xg > 0 ? ` · xG ${p.total_xg}` : "";
            return `<div class="spe-contrib-row scorer-link" data-player-id="${p.player_id}"
                         title="${p.name} — ${p.total_shots}시도 ${p.total_goals}골${xgTip}">
                <span class="spe-contrib-name" style="color:${color}">${p.name}</span>
                <span class="spe-contrib-sits">${sits}</span>
                <span class="spe-contrib-goals">${p.total_goals}골</span>
            </div>`;
        };

        // 한 행 (한 종류) 시각화 — 양 팀 시도 막대 + 리그 평균선 + xG 효율 라벨
        const rowHtml = (t) => {
            const h = home.by_type[t.key], a = away.by_type[t.key];
            const la = avg.by_type[t.key];
            const maxShots = Math.max(h.shots, a.shots, la.avg_shots || 0, 1);
            const hBarW = (h.shots / maxShots) * 100;
            const aBarW = (a.shots / maxShots) * 100;
            const lineL = (la.avg_shots / maxShots) * 100;

            const xgClass = (diff) => diff > 0.5 ? "spe-xg-up" : diff < -0.5 ? "spe-xg-down" : "spe-xg-flat";
            const xgSign  = (diff) => diff > 0 ? "+" : "";
            const xgChip  = (diff) => diff === null || diff === undefined
                ? "" : `<span class="spe-xg ${xgClass(diff)}">xG ${xgSign(diff)}${diff}</span>`;

            return `
            <div class="spe-row">
                <div class="spe-row-head">
                    <span class="spe-row-icon" aria-hidden="true">${t.icon}</span>
                    <span class="spe-row-lbl">${t.label}</span>
                    <span class="spe-row-avg">리그 평균 ${la.avg_shots} 시도 · ${la.avg_conversion_pct ?? "—"}%</span>
                </div>
                <div class="spe-row-bars">
                    <div class="spe-side spe-home">
                        <div class="spe-stats">
                            <span class="spe-shots">${h.shots}<small>시도</small></span>
                            <span class="spe-goals">${h.goals}<small>골</small></span>
                            <span class="spe-conv">${h.conversion_pct ?? "—"}${h.conversion_pct !== null ? "%" : ""}</span>
                            ${xgChip(h.xg_diff)}
                        </div>
                        <div class="spe-bar-wrap">
                            <div class="spe-bar" style="--w:${hBarW}%;--c:${homeColor}"></div>
                            <div class="spe-avg-line" style="right:${100 - lineL}%" title="리그 평균 ${la.avg_shots} 시도"></div>
                        </div>
                    </div>
                    <div class="spe-side spe-away">
                        <div class="spe-bar-wrap spe-bar-wrap-r">
                            <div class="spe-bar spe-bar-r" style="--w:${aBarW}%;--c:${awayColor}"></div>
                            <div class="spe-avg-line" style="left:${100 - lineL}%" title="리그 평균 ${la.avg_shots} 시도"></div>
                        </div>
                        <div class="spe-stats spe-stats-r">
                            ${xgChip(a.xg_diff)}
                            <span class="spe-conv">${a.conversion_pct ?? "—"}${a.conversion_pct !== null ? "%" : ""}</span>
                            <span class="spe-goals">${a.goals}<small>골</small></span>
                            <span class="spe-shots">${a.shots}<small>시도</small></span>
                        </div>
                    </div>
                </div>
            </div>`;
        };

        // 자동 인사이트 — 효율 강점/약점 (xG 있는 경우만, 시도 5 이상 + xG_diff 1 이상)
        // 그리고 시도 수가 리그 평균 1.5배 이상이면 시도량 우위 인사이트 (xG 무관)
        const insights = [];
        for (const t of TYPES) {
            const h = home.by_type[t.key], a = away.by_type[t.key];
            const la = avg.by_type[t.key];
            if (h.xg_diff !== null && h.shots >= 5 && h.xg_diff >= 1.0)
                insights.push(`⚡ ${home.short} ${t.label} 효율 우수 (xG +${h.xg_diff})`);
            if (a.xg_diff !== null && a.shots >= 5 && a.xg_diff >= 1.0)
                insights.push(`⚡ ${away.short} ${t.label} 효율 우수 (xG +${a.xg_diff})`);
            if (h.xg_diff !== null && h.shots >= 5 && h.xg_diff <= -1.0)
                insights.push(`⚠ ${home.short} ${t.label} 효율 미달 (xG ${h.xg_diff})`);
            if (a.xg_diff !== null && a.shots >= 5 && a.xg_diff <= -1.0)
                insights.push(`⚠ ${away.short} ${t.label} 효율 미달 (xG ${a.xg_diff})`);
            // xG 없는 리그(K1)도 변환률 비교
            if (la.avg_conversion_pct !== null && h.conversion_pct !== null
                && h.shots >= 5 && h.conversion_pct >= la.avg_conversion_pct * 1.5)
                insights.push(`🎯 ${home.short} ${t.label} 변환률 ${h.conversion_pct}% (리그 ${la.avg_conversion_pct}%)`);
            if (la.avg_conversion_pct !== null && a.conversion_pct !== null
                && a.shots >= 5 && a.conversion_pct >= la.avg_conversion_pct * 1.5)
                insights.push(`🎯 ${away.short} ${t.label} 변환률 ${a.conversion_pct}% (리그 ${la.avg_conversion_pct}%)`);
        }

        const html = `
        <div class="pred-setpiece-eff">
            <div class="spe-header">
                <span class="spe-title">⚙ 세트피스 효율 — ${spe.year} 시즌${spe.xg_estimated ? ` <span class="spe-xg-badge" data-tip="K1은 SofaScore 원천 xG가 없어 거리·각도·상황 기반 자체 모델로 추정한 값입니다. 수비 압박·골키퍼 위치 미반영으로 K2 실측 대비 참고용으로 활용하세요." role="tooltip" tabindex="0" aria-label="xG 추정 안내">xG 추정 <span class="spe-tip-icon" aria-hidden="true">?</span></span>` : ""}</span>
                <span class="spe-sub">시도 / 골 / 변환률 / xG차(실득점-기댓값)</span>
            </div>
            <div class="spe-teams">
                <span class="spe-team spe-team-home" style="color:${homeColor}">${home.short}</span>
                <span class="spe-team-divider">vs 리그 평균 vs</span>
                <span class="spe-team spe-team-away" style="color:${awayColor}">${away.short}</span>
            </div>
            ${TYPES.map(rowHtml).join("")}
            ${insights.length ? `
            <div class="spe-insights">${insights.map(t => `<div class="spe-insight">${t}</div>`).join("")}</div>` : ""}
            ${(home.players?.length || away.players?.length) ? `
            <div class="spe-contributors">
                <div class="spe-contrib-title">세트피스 기여 선수 (시즌 누적)</div>
                <div class="spe-contrib-grid">
                    <div class="spe-contrib-col">
                        ${(home.players || []).map(p => spContribRow(p, homeColor)).join("")}
                    </div>
                    <div class="spe-contrib-col spe-contrib-away">
                        ${(away.players || []).map(p => spContribRow(p, awayColor)).join("")}
                    </div>
                </div>
            </div>` : ""}
            <div class="spe-foot">xG차 = 실득점 − 누적 xG. 양수면 기댓값 초과 효율. 출처: SofaScore shotmap${spe.xg_estimated ? " (xG는 자체 모델 추정)" : " (xG 실측)"}.</div>
        </div>`;
        wrap.insertAdjacentHTML("beforeend", html);
    }

    // ── 필드 그리기 헬퍼 (가로 방향 풀 피치) ─────────────────
    function drawPitch(ctx, w, h) {
        ctx.fillStyle = "#0d2b1a";
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = "#3a8c5a";
        ctx.lineWidth = 1.4;
        // 외곽
        ctx.strokeRect(8, 8, w - 16, h - 16);
        // 센터 라인
        ctx.beginPath();
        ctx.moveTo(w / 2, 8);
        ctx.lineTo(w / 2, h - 8);
        ctx.stroke();
        // 센터 서클
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, 35, 0, Math.PI * 2);
        ctx.stroke();
        // 페널티 박스 좌
        ctx.strokeRect(8, h * 0.22, w * 0.14, h * 0.56);
        // 페널티 박스 우
        ctx.strokeRect(w - 8 - w * 0.14, h * 0.22, w * 0.14, h * 0.56);
        // 골 박스 좌
        ctx.strokeRect(8, h * 0.36, w * 0.05, h * 0.28);
        // 골 박스 우
        ctx.strokeRect(w - 8 - w * 0.05, h * 0.36, w * 0.05, h * 0.28);
    }

    // SofaScore 좌표(x: 자기진영=0→상대골=100, y: 본인 시점 우측=0→좌측=100, 본인 시점 기준).
    //   HOME 공격방향: 좌→우 (x 그대로)
    //   AWAY 공격방향: 우→좌 (x 반전: 100-x)
    // broadcast 표준:
    //   HOME LB(본인 좌측=avg_y 큰) → 캔버스 위쪽 → py = 100 - y
    //   HOME RB(avg_y 작) → 캔버스 아래쪽
    //   AWAY LB(avg_y 큰) → 캔버스 아래쪽 (HOME mirror) → py = y
    //   AWAY RB(avg_y 작) → 캔버스 위쪽
    // 즉 y는 HOME 100-y, AWAY 그대로 (build_side와 동일한 broadcast mirror 표준).
    function mapPos(x, y, isHome, w, h) {
        const px = isHome ? x : (100 - x);
        const py = isHome ? (100 - y) : y;
        return [
            8 + (px / 100) * (w - 16),
            8 + (py / 100) * (h - 16),
        ];
    }

    function drawAvgPositions(canvas, positions, homeKit, awayKit, tooltip) {
        const ctx = canvas.getContext("2d");
        const w = canvas.width, h = canvas.height;
        drawPitch(ctx, w, h);

        // B 방식: 원 반지름 축소(13→10) + fill alpha 0.75로 겹침 시 뒤 점도 비침.
        //         캔버스 텍스트는 등번호만 표기, 한글 이름은 호버 툴팁으로.
        const RADIUS = 10;
        const drawPts = [];
        for (const p of positions) {
            if (p.x == null || p.y == null) continue;
            const [px, py] = mapPos(p.x, p.y, p.is_home === 1, w, h);
            const k = p.is_home === 1 ? homeKit : awayKit;

            ctx.globalAlpha = 0.78;
            ctx.fillStyle = k.fill;
            ctx.beginPath();
            ctx.arc(px, py, RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = k.stroke;
            ctx.lineWidth = p.is_home === 1 ? 1.4 : 2.2;
            ctx.stroke();

            // 등번호만 (이름은 호버 시)
            ctx.fillStyle = k.text;
            ctx.font = "bold 11px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(p.shirt_number || "·", px, py);

            drawPts.push({ px, py, r: RADIUS + 2, data: p });
        }

        // 호버 툴팁 (shotmap과 동일 패턴)
        if (!tooltip) return;
        canvas.onmousemove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
            const my = (e.clientY - rect.top) * (canvas.height / rect.height);
            // 가장 가까운 점 1개 (반지름 내). 겹친 그룹은 마우스 위치에 가장 가까운 점 우선.
            let hit = null, bestDist = Infinity;
            for (const d of drawPts) {
                const dist = Math.hypot(mx - d.px, my - d.py);
                if (dist <= d.r && dist < bestDist) { hit = d; bestDist = dist; }
            }
            if (hit) {
                const p = hit.data;
                const side = p.is_home === 1 ? "홈" : "원정";
                const shirt = p.shirt_number ? `#${p.shirt_number} ` : "";
                tooltip.innerHTML = `<b>${shirt}${p.name || "선수"}</b><br>` +
                    `<span style="opacity:0.75">${side} · 평균 (${p.x.toFixed(1)}, ${p.y.toFixed(1)})</span>`;
                tooltip.style.left = (e.clientX - rect.left + 12) + "px";
                tooltip.style.top  = (e.clientY - rect.top  + 12) + "px";
                tooltip.hidden = false;
            } else {
                tooltip.hidden = true;
            }
        };
        canvas.onmouseleave = () => { tooltip.hidden = true; };
    }

    const SHOT_COLORS = {
        goal:  "#fbbf24",
        save:  "#60a5fa",
        miss:  "#94a3b8",
        block: "#f472b6",
        post:  "#f87171",
    };

    function drawShotmap(canvas, shots, homeKit, awayKit, tooltip) {
        const ctx = canvas.getContext("2d");
        const w = canvas.width, h = canvas.height;
        drawPitch(ctx, w, h);

        // 좌표 정규화는 백엔드(/api/match-extras)에서 완료 — 프론트 변환 불필요.
        const drawShots = [];
        for (const s of shots) {
            if (s.x == null || s.y == null) continue;
            const isHome = s.is_home === 1;
            const [px, py] = mapPos(s.x, s.y, isHome, w, h);
            const color = SHOT_COLORS[s.shot_type] || "#888";
            const r = s.shot_type === "goal" ? 8 : 5.5;

            ctx.fillStyle = color;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = isHome ? homeKit.stroke : awayKit.stroke;
            ctx.lineWidth = 1.6;
            ctx.stroke();

            drawShots.push({ px, py, r: r + 2, data: s });
        }

        // 호버 툴팁
        canvas.onmousemove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
            const my = (e.clientY - rect.top) * (canvas.height / rect.height);
            const hit = drawShots.find(d => Math.hypot(mx - d.px, my - d.py) <= d.r);
            if (hit) {
                const s = hit.data;
                const xgStr = s.xg != null ? ` · xG ${s.xg.toFixed(2)}` : "";
                tooltip.innerHTML = `<b>${s.name || "선수"}</b> · ${s.time_min}'<br>` +
                    `${s.shot_type}${xgStr}<br>` +
                    `<span style="opacity:0.75">${s.body_part || ""} / ${s.situation || ""}</span>`;
                tooltip.style.left = (e.clientX - rect.left + 12) + "px";
                tooltip.style.top  = (e.clientY - rect.top  + 12) + "px";
                tooltip.hidden = false;
            } else {
                tooltip.hidden = true;
            }
        };
        canvas.onmouseleave = () => { tooltip.hidden = true; };
    }

    // 페이지 로드 시 K2 일정 불러오기 + 백테스트 캐시 워밍 + 헤더 정확도 표시
    loadSchedule();
    Promise.all([loadBacktest("k1"), loadBacktest("k2")]).then(([k1, k2]) => {
        renderHeaderAccuracy(k1, k2);
    });
    // 시즌 시뮬레이션 (지연 로드 — 무거우니 비동기)
    Promise.all([
        fetch("/api/season-simulation?league=k1&n=500").then(r => r.json()).catch(() => null),
        fetch("/api/season-simulation?league=k2&n=500").then(r => r.json()).catch(() => null),
    ]).then(([k1s, k2s]) => renderSeasonSim(k1s, k2s));

    function renderSeasonSim(k1, k2) {
        const el = document.getElementById("season-sim-bar");
        if (!el) return;
        const renderLeague = (d, name) => {
            if (!d || !d.ready) return `<span class="ssb-empty">${name} 데이터 부족</span>`;
            const champ = d.teams[0];
            const afcCount = d.league === "K1" ? 4 : 2;
            const top = d.teams.slice(0, 3);
            const bot = d.teams.slice(-2);
            // 경기 수 → 라운드 환산 (라운드당 = 팀수/2, 홀수팀이면 1팀 휴식)
            const perRound = Math.max(1, Math.floor(d.n_teams / 2));
            const totalR = Math.round((d.finished_games + d.pending_games) / perRound);
            const curR   = Math.round(d.finished_games / perRound);
            const remainR = Math.max(0, totalR - curR);
            return `
                <div class="ssb-league">
                    <span class="ssb-name">${d.league}</span>
                    <span class="ssb-sub" title="${d.n_teams}팀 · ${d.pending_games}경기 · ${d.n_simulations}회 시뮬">R${curR}/${totalR} · ${remainR}R 남음</span>
                    <span class="ssb-champ" title="우승 확률 ${champ.win_pct}%">🏆 ${champ.name} ${champ.win_pct}%</span>
                    <span class="ssb-divider">·</span>
                    <span class="ssb-afc" title="AFC/승격권 TOP ${afcCount}">
                        ${top.map(t => `${t.name} ${t.afc_pct}%`).join(" · ")}
                    </span>
                    <span class="ssb-divider">·</span>
                    <span class="ssb-rel" title="강등 위험">
                        ⚠ ${bot.map(t => `${t.name} ${t.rel_pct}%`).join(" · ")}
                    </span>
                </div>`;
        };
        el.innerHTML = `
            <span class="ssb-lead">🎲 시즌 시뮬</span>
            ${renderLeague(k1, "K1")}
            ${renderLeague(k2, "K2")}
        `;
    }

    function renderHeaderAccuracy(k1, k2) {
        const el = document.getElementById("header-accuracy");
        if (!el) return;
        const stat = (d) => d && d.ready
            ? `<span class="hab-stat"><span class="hab-v">${d.hit_1x2_pct}%</span><span class="hab-k">1X2</span> · <span class="hab-v">${d.exact_score_pct}%</span><span class="hab-k">정확</span> · <span class="hab-v">${d.top3_score_pct}%</span><span class="hab-k">TOP3</span></span>`
            : `<span class="hab-stat hab-na">데이터 부족</span>`;
        const n = (d) => d && d.ready ? `${d.n_total}경기` : "-";
        el.innerHTML = `
            <span class="hab-lead">📊 모델 정확도</span>
            <span class="hab-league"><span class="hab-name">K1</span> ${stat(k1)} <span class="hab-n">${n(k1)}</span></span>
            <span class="hab-sep">|</span>
            <span class="hab-league"><span class="hab-name">K2</span> ${stat(k2)} <span class="hab-n">${n(k2)}</span></span>
            <span class="hab-sub">2026 rolling backtest</span>
        `;
    }

})();
