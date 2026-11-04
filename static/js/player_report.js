// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
// player_report.js — 선수 개별 분석 보고서 (전술판 아래 섹션)

(function () {
    const section  = document.getElementById("player-report-section");
    const body     = document.getElementById("pr-body");
    const yrFilter = document.getElementById("pr-year-filter");
    const srcSlot  = document.getElementById("pr-src-slot");   // 출처 전환 — 연도 필터와 같은 줄(고정 영역, 본문 갱신과 무관)

    let currentName = null;
    let currentYear = null;
    let currentDob  = "";
    let currentShirt = null;
    let currentSource = "sofa";   // "sofa" | "official"(K리그 공식 기록, 베타)
    let currentPid    = null;     // SofaScore 리포트에서 확정된 선수 id (공식 탭 조회 키)
    // 선수를 새로 열면 공식 기록을 먼저 보여주고, 연결 불가·오류면 자동으로 SofaScore 로 되돌린다(2026-11-04).
    // SofaScore 는 8월 이후 수집이 끊겨 있어 최신 시즌은 공식 쪽이 더 신선하다.
    let tryOfficialFirst = false;
    let lastSofa = null;          // 폴백용 — 첫 SofaScore 응답
    let radarChart    = null;
    let activityChart = null;
    let vsTeamsChart  = null;

    /* ── 이벤트 수신 ─────────────────────────────────────── */
    document.addEventListener("openPlayerReport", (e) => {
        currentName  = e.detail.name;
        currentDob   = e.detail.dob || "";
        currentShirt = e.detail.shirt || null;
        currentYear  = null;
        currentSource = "sofa";
        currentPid    = null;
        lastSofa      = null;
        tryOfficialFirst = true;
        if (srcSlot) srcSlot.innerHTML = "";
        load();
    });

    /* ── 데이터 출처 전환 (SofaScore ↔ 공식 K리그) ──────────── */
    function srcToggle(active) {
        const b = (src, label, tip) =>
            `<button type="button" class="pr-src-btn${active === src ? " active" : ""}" data-src="${src}" aria-pressed="${active === src}" title="${tip}">${label}</button>`;
        const html = `<div class="pr-source-toggle" role="group" aria-label="데이터 출처">
            <span class="pr-src-label">데이터 출처</span>
            ${b("sofa", "SofaScore", "기존 리포트 — 90분=풀타임 90분 기준")}
            ${b("official", "공식 K리그 <small>베타</small>", "K리그 공식 경기 기록 — 출전분이 추가시간 포함, 일부 지표 정의가 다름")}
        </div>`;
        if (srcSlot) srcSlot.innerHTML = html; else return html;
        return "";
    }
    function bindSource() {
        (srcSlot || body).querySelectorAll(".pr-src-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                if (btn.dataset.src === currentSource) return;
                tryOfficialFirst = false;
                currentSource = btn.dataset.src;
                currentYear = null;
                load();
            });
        });
    }

    /* ── 데이터 로드 ─────────────────────────────────────── */
    function load() {
        if (!currentName) return;
        if (currentSource === "official" && currentPid) { loadOfficial(); return; }
        body.innerHTML = `<div class="pr-loading">분석 중...</div>`;
        let url = `/api/player-stat-report?name=${encodeURIComponent(currentName)}`;
        if (currentDob)   url += `&dob=${encodeURIComponent(currentDob)}`;
        if (currentShirt) url += `&shirt=${encodeURIComponent(currentShirt)}`;
        if (currentYear)  url += `&year=${currentYear}`;
        fetch(url)
            .then(r => r.json())
            .then(d => {
                if (!d.found) {
                    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
                    const who = currentName ? `<b>${esc(currentName)}</b> 선수의 ` : "";
                    body.innerHTML =
                        `<div class="pr-empty">` +
                        `📭 ${who}수집된 경기 데이터가 아직 없습니다.<br>` +
                        `<span class="pr-empty-sub">신규 영입·유스·출전 기록이 없는 선수는 SofaScore 스탯이 집계되지 않습니다.</span>` +
                        `</div>`;
                    return;
                }
                if (tryOfficialFirst && !currentYear && d.player && d.player.id) {
                    lastSofa = d;
                    currentPid = d.player.id;
                    currentSource = "official";
                    loadOfficial();
                    return;
                }
                tryOfficialFirst = false;
                render(d);
            })
            .catch(() => { body.innerHTML = `<div class="pr-empty">⚠️ 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>`; });
    }

    /* ── 렌더링 ──────────────────────────────────────────── */
    function render(d) {
        const p = d.player;
        currentPid = p.id;
        const activity = d.activity || {};
        if (radarChart)    { radarChart.destroy();    radarChart    = null; }
        if (activityChart) { activityChart.destroy(); activityChart = null; }
        if (vsTeamsChart)  { vsTeamsChart.destroy();  vsTeamsChart  = null; }

        // 연도 필터
        const years = ["전체", ...(d.available_years || [])];
        yrFilter.innerHTML = years.map(y => {
            const active = (y === "전체" && !currentYear) || y === currentYear;
            return `<button class="pr-yr-btn${active ? " active":""}" data-y="${y}">${y}</button>`;
        }).join("");
        yrFilter.querySelectorAll(".pr-yr-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                currentYear = btn.dataset.y === "전체" ? null : btn.dataset.y;
                load();
            });
        });

        // 신체 정보 뱃지
        const posLabel = p.pos_label || p.pos || "?";
        const posColor = {GK:"#fbbf24",DF:"#4ade80",MF:"#4ea4f8",FW:"#f87171"}[posLabel] || "#9ab";
        // 세부 포지션 라벨(센터백·풀백 등) 우선 표시 — 색상은 대분류 기준 유지
        const roleLabel = p.detail_label || posLabel;
        const peerLabel = p.peer_label || posLabel;
        const heightBadge = p.height ? physBadge("키", `${p.height}cm`, p.height_rank) : "";
        const weightBadge = p.weight ? physBadge("몸무게", `${p.weight}kg`, p.weight_rank) : "";

        // 스탯 카드 (퍼센타일 바)
        const statCards = d.stat_items.map(item => statCard(item, posLabel)).join("");

        // 최근 5경기 폼 테이블
        const formCols = getFormCols(p.pos);
        const formHead = formCols.map(c => `<th>${c.label}</th>`).join("");
        const formRows = d.recent_form.map(g => {
            const resCls = g.result==="W"?"pr-res-w":g.result==="D"?"pr-res-d":"pr-res-l";
            const ha = g.is_home ? "홈" : "원정";
            const cells = formCols.map(c => `<td>${g[c.key] ?? "-"}</td>`).join("");
            return `<tr>
                <td>${g.date}</td>
                <td>${ttEsc(g.opponent)} <span class="pr-ha">${ha}</span></td>
                <td>${g.score}</td>
                <td class="${resCls}">${g.result}</td>
                ${cells}
                <td>${g.rating ?? "-"}</td>
            </tr>`;
        }).join("");

        body.innerHTML = srcToggle("sofa") + `
        <div class="pr-card pr-info-card">
            <div class="pr-player-header">
                <div class="pr-pos-badge" style="background:${posColor}22;border-color:${posColor}55;color:${posColor}">${roleLabel}</div>
                <div class="pr-player-name">${ttEsc(p.name)}</div>
                <div class="pr-player-team">${ttEsc(p.team)}</div>
                <div class="pr-info-badges">
                    <span class="pr-badge">${p.games}경기</span>
                    <span class="pr-badge pr-badge-goal">${p.goals}골</span>
                    <span class="pr-badge pr-badge-assist">${p.assists}도움</span>
                    ${p.rating ? `<span class="pr-badge pr-badge-rating">★ ${p.rating}</span>` : ""}
                    ${p.yellows ? `<span class="pr-badge">🟨${p.yellows}</span>` : ""}
                    ${p.reds    ? `<span class="pr-badge">🟥${p.reds}</span>` : ""}
                    ${heightBadge}${weightBadge}
                </div>
                <div class="pr-peer-note">동일 포지션 <b>${peerLabel}</b> ${d.peer_count}명 대비 퍼센타일</div>
            </div>
        </div>

        <div class="pr-main-grid">
            <!-- 레이더 + 스탯 가로 배치 -->
            <div class="pr-card pr-radar-card">
                <div class="pr-radar-canvas-wrap">
                    <div class="pr-section-title">종합 능력치 레이더</div>
                    <canvas id="pr-radar-canvas"></canvas>
                </div>
                <div class="pr-stats-card">
                    <div class="pr-section-title">주요 지표 퍼센타일 <span class="pr-pos-tag">${posLabel} 기준</span></div>
                    <div class="pr-stat-list">${statCards}</div>
                </div>
            </div>
        </div>

        <div class="pr-bottom-grid">
            <!-- 상대팀별 성적 (나중에 JS로 채움) -->
            <div class="pr-card pr-vs-card" id="pr-vs-teams-card">
                <div class="pr-section-title">상대팀별 성적 <span class="pr-pos-tag">평점 기준 · 높을수록 좋은 상대</span></div>
                <div class="pr-loading" style="padding:12px">불러오는 중...</div>
            </div>

            <!-- 활동량 지수 -->
            <div class="pr-card pr-activity-card">
                <div class="pr-section-title">
                    활동량 지수 <span class="pr-pos-tag">90분 환산 · 리그 전체 대비</span>
                    ${activity.score != null ? `<span class="pr-activity-score">${activity.score}<small>/100</small></span>` : ""}
                </div>
                ${activity.values && Object.keys(activity.values).length
                    ? `<div style="position:relative;height:150px"><canvas id="pr-activity-canvas"></canvas></div>`
                    : `<div class="pr-loading" style="padding:12px">경기 수 부족</div>`}
            </div>
        </div>

        <!-- 최근 폼 -->
        <div class="pr-card">
            <div class="pr-section-title">최근 5경기</div>
            <div class="pr-table-wrap">
                <table class="pr-table">
                    <thead><tr><th>날짜</th><th>상대</th><th>스코어</th><th>결과</th>${formHead}<th>평점</th></tr></thead>
                    <tbody>${formRows || `<tr><td colspan="10" style="text-align:center;color:#4a6080;padding:16px">데이터 없음</td></tr>`}</tbody>
                </table>
            </div>
        </div>
        `;

        bindSource();
        // 레이더 차트
        renderRadar(d.radar, posLabel);
        renderActivity(activity);
        loadVsTeams(p.id);
    }

    /* ── 공식 K리그 기록 리포트 (베타) ────────────────────────
       값·백분위·비교군 모두 공식 데이터끼리만 계산된 /api/player-stat-report-official 응답.
       SofaScore 리포트와 수치를 섞어 보여주지 않는다(정의가 다른 지표가 많음). */
    const OFFICIAL_REASON = {
        no_official_table: "공식 기록 테이블이 아직 준비되지 않았습니다.",
        no_match:          "이 선수의 공식 K리그 기록과 안전하게 연결되지 않았습니다(동명이인·표기 차이). SofaScore 탭을 이용해 주세요.",
        ambiguous:         "공식 기록 후보가 여러 명이라 연결하지 않았습니다. SofaScore 탭을 이용해 주세요.",
        unverifiable:      "출전 경기가 적어 공식 기록과의 연결을 검증하지 못했습니다. SofaScore 탭을 이용해 주세요.",
        no_games:          "공식 기록이 수집된 경기가 없습니다.",
        no_year:           "선택한 연도의 공식 기록이 없습니다.",
    };

    function loadOfficial() {
        body.innerHTML = `<div class="pr-loading">공식 기록 분석 중...</div>`;
        let url = `/api/player-stat-report-official?playerId=${encodeURIComponent(currentPid)}`;
        if (currentYear) url += `&year=${encodeURIComponent(currentYear)}`;
        fetch(url)
            .then(r => r.json())
            .then(renderOfficial)
            .catch(() => {
                if (fallbackToSofa()) return;
                body.innerHTML = srcToggle("official") + `<div class="pr-empty">⚠️ 공식 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>`;
                bindSource();
            });
    }

    // 공식 탭 연도 필터 — [전체(현재 리그 누적), 연도…]. '전체'는 API year=all.
    function bindYears(years, active) {
        const list = (years && years.length) ? ["전체", ...years] : [];
        const act = active === "all" ? "전체" : active;
        yrFilter.innerHTML = list.map(y =>
            `<button class="pr-yr-btn${y === act ? " active" : ""}" data-y="${ttEsc(y)}" aria-pressed="${y === act}">${ttEsc(y)}</button>`).join("");
        yrFilter.querySelectorAll(".pr-yr-btn").forEach(btn => {
            btn.addEventListener("click", () => { currentYear = btn.dataset.y === "전체" ? "all" : btn.dataset.y; load(); });
        });
    }

    // 공식 우선 모드에서 연결 불가·오류면 첫 SofaScore 응답으로 조용히 되돌린다. 되돌렸으면 true.
    function fallbackToSofa() {
        if (!tryOfficialFirst || !lastSofa) return false;
        tryOfficialFirst = false;
        currentSource = "sofa";
        render(lastSofa);
        return true;
    }

    function renderOfficial(d) {
        if (radarChart)    { radarChart.destroy();    radarChart    = null; }
        if (activityChart) { activityChart.destroy(); activityChart = null; }
        if (vsTeamsChart)  { vsTeamsChart.destroy();  vsTeamsChart  = null; }

        if (!d || !d.official) {
            if (fallbackToSofa()) return;
            bindYears(d && d.available_years, null);
            const who = d && d.player && d.player.name ? `<b>${ttEsc(d.player.name)}</b> 선수의 ` : "";
            const msg = OFFICIAL_REASON[d && d.reason] || "공식 기록을 불러오지 못했습니다.";
            body.innerHTML = srcToggle("official") +
                `<div class="pr-empty">📭 ${who}공식 K리그 기록을 표시할 수 없습니다.<br><span class="pr-empty-sub">${ttEsc(msg)}</span></div>`;
            bindSource();
            return;
        }

        tryOfficialFirst = false;
        const p = d.player;
        bindYears(d.available_years, d.year);
        const posLabel = p.pos_label || p.pos || "?";
        const posColor = {GK:"#fbbf24",DF:"#4ade80",MF:"#4ea4f8",FW:"#f87171"}[posLabel] || "#9ab";
        const statCards = d.stat_items.map(item => statCard(item, posLabel)).join("");

        const formCols = getFormCols(p.pos);
        const formHead = formCols.map(c => `<th>${c.label}</th>`).join("");
        const formRows = d.recent_form.map(g => {
            const resCls = g.result === "W" ? "pr-res-w" : g.result === "D" ? "pr-res-d" : "pr-res-l";
            const cells = formCols.map(c => `<td>${g[c.key] ?? "-"}</td>`).join("");
            return `<tr>
                <td>${ttEsc(g.date)}</td>
                <td>${ttEsc(g.opponent)} <span class="pr-ha">${g.is_home ? "홈" : "원정"}</span></td>
                <td>${ttEsc(g.score)}</td>
                <td class="${resCls}">${ttEsc(g.result)}</td>
                ${cells}
                <td>${g.rating ?? "-"}</td>
            </tr>`;
        }).join("");

        const cov = d.coverage || {};
        const covNote = cov.sofa_games && cov.sofa_games !== cov.official_games
            ? `<li>공식 기록 <b>${cov.official_games}경기</b> · SofaScore 기록 ${cov.sofa_games}경기 — 수집 범위·선수 연결 차이로 경기 수가 다를 수 있습니다.</li>` : "";

        const ga = d.goals_adjusted || {};
        const adjNote = ga.added > 0
            ? `<li><b>이 선수는 득점 ${ga.added}골(${ga.games}경기)이 보정되어 있습니다.</b> 공식 기록에서 빠진 골을 경기 기록으로 채운 값입니다.</li>` : "";
        const goalBadgeTitle = ga.added > 0 ? ` title="공식 기록 ${p.goals - ga.added}골 + 경기 기록으로 보정 ${ga.added}골"` : "";

        body.innerHTML = srcToggle("official") + `
        <div class="pr-card pr-info-card">
            <div class="pr-player-header">
                <div class="pr-pos-badge" style="background:${posColor}22;border-color:${posColor}55;color:${posColor}">${ttEsc(posLabel)}</div>
                <div class="pr-player-name">${ttEsc(p.name)}</div>
                <div class="pr-player-team">${ttEsc(p.team)} · ${ttEsc(p.league)} ${d.year === "all" ? "전체 시즌 누적(" + ttEsc((d.scope_years || []).join("·")) + ")" : ttEsc(d.year)}</div>
                <div class="pr-info-badges">
                    <span class="pr-badge">${p.games}경기</span>
                    <span class="pr-badge">${p.mins}분</span>
                    <span class="pr-badge pr-badge-goal"${goalBadgeTitle}>${p.goals}골${ga.added > 0 ? "*" : ""}</span>
                    <span class="pr-badge pr-badge-assist">${p.assists}도움</span>
                    ${p.rating ? `<span class="pr-badge pr-badge-rating" title="공식 playerPoint — SofaScore 평점과 산식이 다릅니다">공식 평점 ${p.rating}</span>` : ""}
                    ${p.xg != null ? `<span class="pr-badge" title="공식 xG (2023~2025 시즌만 제공)">xG ${p.xg}</span>` : ""}
                    ${p.yellows ? `<span class="pr-badge">🟨${p.yellows}</span>` : ""}
                    ${p.reds    ? `<span class="pr-badge">🟥${p.reds}</span>` : ""}
                </div>
                <div class="pr-peer-note pr-peer-note-official">같은 리그·같은 포지션 <b>${ttEsc(p.peer_label)}</b> ${d.peer_count}명 대비 퍼센타일 (공식 기록 기준${d.year === "all" ? " · 이 리그에서 뛴 모든 시즌을 합산(다른 리그 시즌은 제외)" : ""})</div>
            </div>
        </div>

        <div class="pr-main-grid">
            <div class="pr-card pr-radar-card">
                <div class="pr-radar-canvas-wrap">
                    <div class="pr-section-title">종합 능력치 레이더</div>
                    <canvas id="pr-radar-canvas"></canvas>
                </div>
                <div class="pr-stats-card">
                    <div class="pr-section-title">주요 지표 퍼센타일 <span class="pr-pos-tag">${ttEsc(posLabel)} · 공식 기준</span></div>
                    <div class="pr-stat-list">${statCards}</div>
                </div>
            </div>
        </div>

        <div class="pr-card">
            <div class="pr-section-title">최근 5경기 <span class="pr-pos-tag">공식 기록</span></div>
            <div class="pr-table-wrap">
                <table class="pr-table">
                    <thead><tr><th>날짜</th><th>상대</th><th>스코어</th><th>결과</th>${formHead}<th>공식평점</th></tr></thead>
                    <tbody>${formRows || `<tr><td colspan="10" style="text-align:center;color:#8aa0b8;padding:16px">데이터 없음</td></tr>`}</tbody>
                </table>
            </div>
        </div>

        <div class="pr-card pr-official-note">
            <div class="pr-section-title">공식 기록 읽는 법</div>
            <ul>
                <li>출전 시간은 <b>추가시간 포함 실제 시간</b>(풀타임 ≈ 98분)이라, 90분 환산값이 SofaScore 탭보다 약 8% 낮게 나옵니다.</li>
                <li>태클·인터셉트·드리블·경합·볼 회수 등은 <b>공식 정의</b>라 SofaScore 탭 수치와 직접 비교하지 마세요. 백분위도 공식 기록을 가진 선수끼리만 계산합니다.</li>
                <li>'기록 없음'은 공식이 해당 지표를 집계하지 않는 경우(예: 골키퍼 공중볼)입니다. 0으로 보지 마세요.</li>
                <li><b>득점은 보정된 값</b>입니다. 공식 기록은 추가시간 득점 등을 일부 빠뜨리는데(다시 받아도 동일), 최종 스코어와 맞는 경기 기록으로 부족분만 채웠습니다. 누가 넣었는지 모호한 경기는 건드리지 않습니다.</li>
                ${adjNote}
                ${covNote}
            </ul>
        </div>`;

        bindSource();
        renderRadar(d.radar, posLabel);
    }

    /* ── 신체 뱃지 ───────────────────────────────────────── */
    function physBadge(label, val, rank) {
        if (!rank) return `<span class="pr-badge">${label} ${val}</span>`;
        const color = rank.pct >= 70 ? "#4ade80" : rank.pct >= 40 ? "#9ab" : "#f87171";
        return `<span class="pr-badge pr-badge-phys" title="${rank.rank}위/${rank.total}명">
            ${label} ${val} <span style="color:${color};font-size:0.7em">상위 ${100-rank.pct}%</span>
        </span>`;
    }

    /* ── 스탯 카드 ───────────────────────────────────────── */
    function statCard(item, posLabel) {
        if (item.pctile == null) {   // 공식 미기록 지표(예: 골키퍼 공중볼) — 0%로 오해하지 않게 별도 표기
            return `<div class="pr-stat-item pr-stat-nodata">
                <div class="pr-stat-label"><span class="pr-stat-icon">${item.icon}</span><span>${item.label}</span><span class="pr-stat-val">-</span></div>
                <div class="pr-pct-info"><span>기록 없음</span></div>
            </div>`;
        }
        // 막대 길이 = 퍼센타일(길수록 좋음). 라벨은 위치를 그대로 말한다: 50 이상 "상위 N%", 미만 "하위 N%".
        // 색 + 기호(▲▼)를 같이 써서 색만으로 좋고 나쁨을 전달하지 않는다.
        const pct = Math.max(0, Math.min(100, item.pctile));
        const color = pct >= 75 ? "#4ade80" : pct >= 50 ? "#4ea4f8" : pct >= 25 ? "#fbbf24" : "#f87171";
        const grade = pct >= 90 ? "탁월" : pct >= 75 ? "우수" : pct >= 50 ? "평균이상" : pct >= 25 ? "평균이하" : "하위";
        const good = pct >= 50;
        const where = good ? `상위 ${Math.max(1, 100 - pct)}%` : (pct <= 0 ? "최하위" : `하위 ${pct}%`);
        const aria = `${item.label} ${item.val}, 비교군 대비 ${where}, ${grade}`;
        return `<div class="pr-stat-item" role="group" aria-label="${ttEsc(aria)}">
            <div class="pr-stat-label">
                <span class="pr-stat-icon">${item.icon}</span>
                <span>${item.label}</span>
                <span class="pr-stat-val">${item.val}</span>
            </div>
            <div class="pr-pct-bar-wrap">
                <div class="pr-pct-bar" style="width:${pct}%;background:${color}"></div>
            </div>
            <div class="pr-pct-info">
                <span style="color:${color}">${good ? "▲" : "▼"} ${where}</span>
                <span class="pr-grade" style="color:${color}">${grade}</span>
            </div>
        </div>`;
    }

    /* ── 포지션별 폼 컬럼 ────────────────────────────────── */
    function getFormCols(pos) {
        const map = {
            G: [{key:"saves",label:"선방"},{key:"aer_w",label:"공중볼"}],
            D: [{key:"tackles",label:"태클"},{key:"ints",label:"인터셉트"},{key:"clears",label:"클리어"},{key:"aer_w",label:"공중볼"}],
            M: [{key:"key_passes",label:"키패스"},{key:"goals",label:"골"},{key:"assists",label:"도움"}],
            F: [{key:"goals",label:"골"},{key:"assists",label:"도움"},{key:"sot",label:"유효슈팅"}],
        };
        return map[pos] || map["M"];
    }

    /* ── 상대팀별 성적 ───────────────────────────────────── */
    function loadVsTeams(playerId) {
        fetch(`/api/player-vs-teams?playerId=${playerId}`)
            .then(r => r.json())
            .then(data => renderVsTeams(data))
            .catch(() => {
                const card = document.getElementById("pr-vs-teams-card");
                if (card) card.querySelector(".pr-loading").textContent = "데이터 없음";
            });
    }

    function renderVsTeams(data) {
        const card = document.getElementById("pr-vs-teams-card");
        if (!card) return;
        if (!data || !data.length) {
            card.querySelector(".pr-loading").textContent = "상대팀 데이터 없음";
            return;
        }

        // 평점 기준 정렬, 단 표본 충분(MIN+경기)한 상대를 먼저 — 1경기 고평점이 "좋은 상대"로
        // 오인되지 않게(표본 함정 방지). 최대 8팀.
        const MIN = 2;
        const sorted = [...data]
            .filter(d => d.games >= 1)
            .sort((a, b) => {
                const ae = a.games >= MIN, be = b.games >= MIN;
                if (ae !== be) return ae ? -1 : 1;
                return (b.avg_rating || 0) - (a.avg_rating || 0);
            })
            .slice(0, 8);
        let anyLow = false;

        const labels   = sorted.map(d => d.opp_name);
        const ratings  = sorted.map(d => d.avg_rating || 0);
        const gaData   = sorted.map(d => d.ga);
        const colors   = sorted.map(d => d.games < MIN ? "rgba(120,134,153,0.5)"
            : d.avg_rating >= 7.5 ? "rgba(74,222,128,0.8)" : d.avg_rating >= 7.0 ? "rgba(78,164,248,0.8)" : d.avg_rating >= 6.5 ? "rgba(251,191,36,0.8)" : "rgba(248,113,113,0.7)");

        // 테이블 + 차트
        const rows = sorted.map((d, i) => {
            const low = d.games < MIN;
            if (low) anyLow = true;
            const ratingColor = low ? "#7a8898"
                : d.avg_rating >= 7.5 ? "#4ade80" : d.avg_rating >= 7.0 ? "#4ea4f8" : d.avg_rating >= 6.5 ? "#fbbf24" : "#f87171";
            return `<tr${low ? ' title="표본 1경기 — 참고용"' : ''}>
                <td style="color:#9ab">${d.opp_name}</td>
                <td style="text-align:center;color:#778">${d.games}</td>
                <td style="text-align:center;color:#4ade80">${d.goals}</td>
                <td style="text-align:center;color:#4ea4f8">${d.assists}</td>
                <td style="text-align:center;font-weight:700;color:${ratingColor}">${d.avg_rating ? d.avg_rating.toFixed(1) : "-"}${low ? '<sup style="color:#f0a25c">*</sup>' : ''}</td>
            </tr>`;
        }).join("");

        card.innerHTML = `
        <div class="pr-section-title">상대팀별 성적 <span class="pr-pos-tag">평점 기준 · 높을수록 좋은 상대</span></div>
        <div style="position:relative;height:160px;margin-bottom:12px"><canvas id="pr-vs-chart"></canvas></div>
        <div class="pr-table-wrap">
            <table class="pr-table">
                <thead><tr><th>상대</th><th style="text-align:center">경기</th><th style="text-align:center">골</th><th style="text-align:center">도움</th><th style="text-align:center">평점</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>${anyLow ? '<div class="pr-vs-note">* 1경기뿐인 상대는 표본이 적어 참고용(흐리게·후순위)</div>' : ''}`;

        const ctx = document.getElementById("pr-vs-chart");
        if (!ctx) return;
        vsTeamsChart = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "평균 평점",
                    data: ratings,
                    backgroundColor: colors,
                    borderRadius: 4,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "rgba(10,15,30,0.92)",
                        titleColor: "#c8d8f0",
                        bodyColor: "#c8d8f0",
                        callbacks: {
                            afterLabel: (item) => {
                                const d = sorted[item.dataIndex];
                                return `G+A: ${d.ga} (${d.games}경기)`;
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#778", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
                    y: {
                        min: 5.5, max: 10,
                        ticks: { color: "#778", font: { size: 10 } },
                        grid: { color: "rgba(255,255,255,0.04)" },
                        title: { display: true, text: "평균 평점", color: "#556", font: { size: 9 } }
                    }
                }
            }
        });
    }

    /* ── 활동량 차트 ─────────────────────────────────────── */
    function renderActivity(activity) {
        const ctx = document.getElementById("pr-activity-canvas");
        if (!ctx || !activity.values || !Object.keys(activity.values).length) return;

        const LABELS = {
            touches_p90:  "터치",
            duels_p90:    "듀얼",
            passes_p90:   "패스",
            def_p90:      "수비액션",
            dribbles_p90: "드리블",
        };
        const keys    = Object.keys(LABELS);
        const vals    = keys.map(k => activity.values[k] || 0);
        const avgVals = keys.map(k => activity.league_avg ? (activity.league_avg[k] || 0) : 0);

        activityChart = new Chart(ctx, {
            type: "bar",
            data: {
                labels: keys.map(k => LABELS[k]),
                datasets: [
                    {
                        label: "선수",
                        data: vals,
                        backgroundColor: "rgba(78,164,248,0.75)",
                        borderRadius: 3,
                    },
                    {
                        label: "리그평균",
                        data: avgVals,
                        backgroundColor: "rgba(255,255,255,0.1)",
                        borderColor: "rgba(255,255,255,0.3)",
                        borderWidth: 1,
                        borderRadius: 3,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: "#9ab", font: { size: 10 }, boxWidth: 10 } },
                    tooltip: {
                        backgroundColor: "rgba(10,15,30,0.92)",
                        titleColor: "#c8d8f0",
                        bodyColor: "#c8d8f0",
                        callbacks: {
                            afterLabel: (item) => {
                                if (item.datasetIndex !== 0) return "";
                                const pct = activity.percentiles ? (activity.percentiles[keys[item.dataIndex]] || 0) : 0;
                                return `상위 ${100 - pct}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: "#778", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
                    y: {
                        ticks: { color: "#778", font: { size: 10 } },
                        grid: { color: "rgba(255,255,255,0.04)" },
                        title: { display: true, text: "90분당", color: "#556", font: { size: 9 } }
                    }
                }
            }
        });
    }

    /* ── 레이더 차트 ─────────────────────────────────────── */
    function renderRadar(radarData, posLabel) {
        const ctx = document.getElementById("pr-radar-canvas");
        if (!ctx || !radarData.length) return;
        const color = {GK:"rgba(251,191,36,",DF:"rgba(74,222,128,",MF:"rgba(78,164,248,",FW:"rgba(248,113,113,"}[posLabel] || "rgba(78,164,248,";
        radarChart = new Chart(ctx, {
            type: "radar",
            data: {
                labels: radarData.map(r => r.label),
                datasets: [{
                    label: "퍼센타일",
                    data:  radarData.map(r => r.pctile),
                    backgroundColor: color+"0.15)",
                    borderColor:     color+"0.9)",
                    pointBackgroundColor: color+"1)",
                    pointRadius: 4,
                    borderWidth: 2,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    r: {
                        min: 0, max: 100,
                        ticks: { stepSize:25, color:"#556", font:{size:10}, backdropColor:"transparent" },
                        grid: { color:"rgba(255,255,255,0.07)" },
                        angleLines: { color:"rgba(255,255,255,0.07)" },
                        pointLabels: { color:"#9ab", font:{size:12} }
                    }
                },
                plugins: {
                    legend: { display:false },
                    tooltip: { callbacks: { label: c => ` 상위 ${100 - c.parsed.r}%` } }
                }
            }
        });
    }

    /* ── 확장 모드 토글 ────────────────────────────────── */
    const expandBtn = document.getElementById("pr-expand-btn");
    const backdrop  = document.getElementById("pr-backdrop");

    function setExpanded(on) {
        section.classList.toggle("pr-expanded", on);
        if (backdrop) backdrop.classList.toggle("active", on);
        document.body.classList.toggle("pr-expanded-lock", on);
        if (expandBtn) expandBtn.setAttribute("aria-expanded", on ? "true" : "false");
        // Chart.js가 컨테이너 크기 변화를 감지하도록 resize 이벤트 발송
        // 트랜지션 끝난 뒤 차트들 재정렬
        setTimeout(() => {
            [radarChart, activityChart, vsTeamsChart].forEach(c => { try { c && c.resize(); } catch {} });
            window.dispatchEvent(new Event("resize"));
        }, 220);
    }

    if (expandBtn) {
        expandBtn.addEventListener("click", () => {
            setExpanded(!section.classList.contains("pr-expanded"));
        });
    }
    if (backdrop) {
        backdrop.addEventListener("click", () => setExpanded(false));
    }
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && section.classList.contains("pr-expanded")) {
            setExpanded(false);
        }
    });
})();
