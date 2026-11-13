// 외부·사용자 문자열을 HTML에 넣을 때 쓰는 이스케이프 (2026-11-03 보안 점검 — 여러 파일에 같은 정의, 전역 함수 재선언 허용)
function ttEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/**
 * global_league.js — 해외리그 탭 (🌍)
 * /api/league/<code>/... 엔드포인트 사용
 * 의존: workspace.js의 탭 전환 이벤트
 */

(function () {
  'use strict';

  /* ── 상태 ─────────────────────────────────────────── */
  const GL = {
    leagues:          [],     // 전체 리그 목록 (/api/leagues)
    activeLeague:     null,   // 현재 선택된 league code
    activeYear:       '2025',
    activeSection:    'standings',
    activePerfMetric: 'goals', // TOP퍼포머 현재 선택 metric
    teams:            [],
    initialized:      false,
  };

  /* 퍼포머 캐시: `${code}|${qs}|${metric}` → data[] */
  const _perfCache = {};

  const ROOT = () => document.getElementById('gl-root');

  /* ── 초기화 (탭 최초 진입 시) ────────────────────── */
  async function init() {
    if (GL.initialized) return;
    GL.initialized = true;
    ROOT().innerHTML = '<div class="gl-loading">리그 목록 로딩 중…</div>';

    try {
      const res = await fetch('/api/leagues');
      GL.leagues = await res.json();
      // kleague 제외 (해외 리그만)
      GL.leagues = GL.leagues.filter(l => l.code !== 'kleague');
    } catch (e) {
      ROOT().innerHTML = '<div class="gl-error">리그 목록 로드 실패</div>';
      return;
    }

    if (!GL.leagues.length) {
      ROOT().innerHTML = '<div class="gl-error">등록된 해외 리그가 없습니다.</div>';
      return;
    }

    GL.activeLeague = GL.leagues[0].code;
    GL.activeYear = latestYear(GL.activeLeague);
    render();
    await loadSection();
  }

  /* 리그별 시즌 선택지 — /api/leagues 의 seasons(최신순). 유럽식 '2025/26', 브라질 등 단일 연도 '2026' */
  function leagueSeasons(code) {
    const l = GL.leagues.find(x => x.code === code);
    return (l && l.seasons && l.seasons.length) ? l.seasons : [{ year: 2025, label: '2025/26' }];
  }
  function latestYear(code) { return String(leagueSeasons(code)[0].year); }
  function yearOptionsHtml(code) {
    return leagueSeasons(code).map(s =>
      `<option value="${s.year}" ${String(s.year) === GL.activeYear ? 'selected' : ''}>${ttEsc(s.label)}</option>`).join('');
  }

  /* ── 전체 렌더 ────────────────────────────────────── */
  function render() {
    ROOT().innerHTML = `
      <div class="gl-wrap">
        <div class="gl-toolbar">
          <div class="gl-league-btns" id="gl-league-btns"></div>
          <div class="gl-year-wrap">
            <label class="gl-label">시즌</label>
            <select id="gl-year" class="gl-select" aria-label="시즌">${yearOptionsHtml(GL.activeLeague)}</select>
          </div>
        </div>
        <div class="gl-league-head" id="gl-league-head" aria-live="polite"></div>
        <div class="gl-section-tabs" id="gl-section-tabs" role="tablist">
          ${['standings','team-rankings','top-performers'].map(s =>
            `<button type="button" role="tab" aria-selected="${GL.activeSection===s}" class="gl-sec-btn${GL.activeSection===s?' active':''}" data-sec="${s}">
              ${sectionLabel(s)}
            </button>`
          ).join('')}
        </div>
        <div id="gl-content" class="gl-content">
          <div class="gl-loading">로딩 중…</div>
        </div>
      </div>
    `;

    // 리그 버튼 렌더 — 나라별 한 줄(국기·나라명 + 1·2·3부 버튼). 2026-11-12 하위 리그 추가
    const btnWrap = document.getElementById('gl-league-btns');
    const byCountry = new Map();
    GL.leagues.forEach(l => {
      const k = l.country || '기타';
      if (!byCountry.has(k)) byCountry.set(k, []);
      byCountry.get(k).push(l);
    });
    byCountry.forEach((list, country) => {
      const row = document.createElement('div');
      row.className = 'gl-country-row';
      const lab = document.createElement('span');
      lab.className = 'gl-country-label';
      lab.textContent = `${list[0].flag || ''} ${country}`;
      row.appendChild(lab);
      list.sort((a, b) => (a.tier || 1) - (b.tier || 1)).forEach(l => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gl-league-btn' + (l.code === GL.activeLeague ? ' active' : '');
        btn.setAttribute('aria-pressed', String(l.code === GL.activeLeague));
        btn.dataset.code = l.code;
        btn.title = `${l.label} (${l.tier || 1}부)`;
        btn.setAttribute('aria-label', `${country} ${l.tier || 1}부 ${l.label}`);
        btn.innerHTML = `<span class="gl-tier">${l.tier || 1}부</span> ${ttEsc(l.label)}`;
        btn.addEventListener('click', () => switchLeague(l.code));
        row.appendChild(btn);
      });
      btnWrap.appendChild(row);
    });

    document.getElementById('gl-year').addEventListener('change', e => {
      GL.activeYear = e.target.value;
      renderLeagueHead();
      loadSection();
    });

    document.querySelectorAll('.gl-sec-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        GL.activeSection = btn.dataset.sec;
        document.querySelectorAll('.gl-sec-btn').forEach(b => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        loadSection();
      });
    });
    renderLeagueHead();
  }

  /* 선택 리그 머리말 — 국기·리그명·티어·시즌 + 데이터 출처/한계 */
  function renderLeagueHead() {
    const el = document.getElementById('gl-league-head');
    const l = GL.leagues.find(x => x.code === GL.activeLeague);
    if (!el || !l) return;
    const season = leagueSeasons(l.code).find(s => String(s.year) === GL.activeYear);
    el.innerHTML = `
      <span class="gl-lh-flag" aria-hidden="true">${ttEsc(l.flag || '')}</span>
      <span class="gl-lh-name">${ttEsc(l.label)}</span>
      <span class="gl-lh-chip">${ttEsc(l.country || '')} ${l.tier || 1}부</span>
      <span class="gl-lh-chip">${ttEsc(season ? season.label : GL.activeYear)} 시즌</span>
      <span class="gl-lh-note">${l.standingsOnly
        ? '순위표만 제공되는 리그'
        : '출처 API-Football · 시즌 누적 기록 (xG·히트맵 미제공)'}</span>`;
  }

  function sectionLabel(s) {
    return { standings: '📋 순위표', 'team-rankings': '📊 팀 지표', 'top-performers': '⭐ TOP 퍼포머' }[s] || s;
  }

  /* ── 리그 전환 ────────────────────────────────────── */
  async function switchLeague(code) {
    GL.activeLeague = code;
    GL.teams = [];
    // 리그마다 시즌 체계가 달라(유럽 2025/26 · 브라질 2026) 시즌 선택지를 다시 만든다
    GL.activeYear = latestYear(code);
    const ysel = document.getElementById('gl-year');
    if (ysel) ysel.innerHTML = yearOptionsHtml(code);
    document.querySelectorAll('.gl-league-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.code === code);
      b.setAttribute('aria-pressed', String(b.dataset.code === code));
    });
    renderLeagueHead();
    await loadSection();
  }

  /* ── 섹션 로드 ────────────────────────────────────── */
  async function loadSection() {
    const content = document.getElementById('gl-content');
    if (!content) return;
    content.innerHTML = '<div class="gl-loading">로딩 중…</div>';

    const code = GL.activeLeague;
    const year = GL.activeYear;
    const qs   = `?year=${year}`;

    const lg = GL.leagues.find(x => x.code === code);
    if (lg && lg.standingsOnly && GL.activeSection !== 'standings') {
      content.innerHTML = `<div class="gl-empty"><p><strong>${ttEsc(lg.label)}</strong>은(는) 순위표만 제공합니다.</p>
        <p class="gl-empty-sub">이 리그는 선수·팀 지표 데이터 제공원이 없어 📋 순위표 탭만 사용할 수 있습니다.</p></div>`;
      return;
    }

    try {
      switch (GL.activeSection) {
        case 'standings':      await renderStandings(code, qs);      break;
        case 'team-rankings':  await renderTeamRankings(code, qs);   break;
        case 'top-performers': await renderTopPerformers(code, qs);  break;
      }
    } catch (e) {
      content.innerHTML = `<div class="gl-error">데이터 로드 실패: ${ttEsc(e.message)}</div>`;
    }
  }

  /* ── 순위표 ───────────────────────────────────────── */
  async function renderStandings(code, qs) {
    const res  = await fetch(`/api/league/${code}/standings${qs}`);
    const data = await res.json();
    const content = document.getElementById('gl-content');

    if (!data.length) {
      content.innerHTML = noDataHtml('순위표', code);
      return;
    }

    content.innerHTML = `
      <div class="gl-table-wrap">
        <table class="gl-table">
          <thead>
            <tr>
              <th>#</th><th>팀</th><th>경기</th><th>승</th><th>무</th><th>패</th>
              <th>득</th><th>실</th><th>득실</th><th class="pts-col">승점</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(r => `
              <tr>
                <td class="gl-rank">${r.rank}</td>
                <td class="gl-team-name">${ttEsc(r.team)}</td>
                <td>${r.played}</td>
                <td class="w-col">${r.wins}</td>
                <td>${r.draws}</td>
                <td class="l-col">${r.losses}</td>
                <td>${r.gf}</td>
                <td>${r.ga}</td>
                <td class="${r.gd>0?'pos-gd':r.gd<0?'neg-gd':''}">${r.gd>0?'+':''}${r.gd}</td>
                <td class="pts-col"><strong>${r.pts}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ── 팀 지표 비교 ─────────────────────────────────── */
  async function renderTeamRankings(code, qs) {
    const res  = await fetch(`/api/league/${code}/team-rankings${qs}`);
    const data = await res.json();
    const content = document.getElementById('gl-content');

    if (!data.length) {
      content.innerHTML = noDataHtml('팀 지표', code);
      return;
    }

    GL.teamRows = data;
    GL.teamSort = GL.teamSort || { key: 'goals', dir: -1 };
    drawTeamTable();
  }

  // xG 는 데이터가 있는 리그(값>0)만 열을 보인다 — API-Football 수집 리그는 xG 미제공
  const TEAM_COLS = [
    ['matches', '경기'], ['goals', '득점'], ['xg', 'xG'], ['shots', '슈팅'], ['shotsOn', '유효슈팅'],
    ['keyPasses', '키패스'], ['dribbles', '드리블'], ['tackles', '태클'], ['interceptions', '인터셉트'],
    ['avgRating', '평균 평점'],
  ];

  function drawTeamTable() {
    const content = document.getElementById('gl-content');
    const rows = GL.teamRows || [];
    if (!content || !rows.length) return;
    const hasXg = rows.some(r => Number(r.xg) > 0);
    const cols = TEAM_COLS.filter(([k]) => k !== 'xg' || hasXg)
                          .filter(([k]) => rows.some(r => r[k] !== undefined));
    const { key, dir } = GL.teamSort;
    const sorted = rows.slice().sort((a, b) => ((Number(a[key]) || 0) - (Number(b[key]) || 0)) * dir);
    const fmt = (k, v) => (v === null || v === undefined) ? '-'
      : (k === 'avgRating' ? Number(v).toFixed(2) : v);

    content.innerHTML = `
      <div class="gl-table-wrap">
        <div class="gl-src-badge">📡 선수 시즌 누적 기록을 팀별로 합산 · 열 제목을 누르면 정렬</div>
        <table class="gl-table gl-sortable">
          <thead>
            <tr>
              <th>#</th><th>팀</th>
              ${cols.map(([k, lab]) => {
                const on = k === key;
                return `<th class="num-col${on ? ' gl-perf-primary' : ''}" aria-sort="${on ? (dir < 0 ? 'descending' : 'ascending') : 'none'}">
                  <button type="button" class="gl-sort-btn" data-key="${k}">${lab}${on ? (dir < 0 ? ' ▾' : ' ▴') : ''}</button></th>`;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((r, i) => `
              <tr>
                <td class="gl-rank">${i + 1}</td>
                <td class="gl-team-name">${ttEsc(r.team)}</td>
                ${cols.map(([k]) => `<td class="num-col${k === key ? ' gl-perf-primary' : ''}">${k === key ? `<strong>${fmt(k, r[k])}</strong>` : fmt(k, r[k])}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    content.querySelectorAll('.gl-sort-btn').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.key;
      GL.teamSort = (GL.teamSort.key === k) ? { key: k, dir: -GL.teamSort.dir } : { key: k, dir: -1 };
      drawTeamTable();
      const again = document.querySelector(`.gl-sort-btn[data-key="${k}"]`);
      if (again) again.focus();
    }));
  }

  /* ── TOP 퍼포머 ───────────────────────────────────── */

  // API-Football 수집 리그엔 xG 가 없어(전부 0) xG 지표는 뺐다 (2026-11-12)
  const PERF_METRICS = [
    { key: 'goals',         label: '⚽ 득점'     },
    { key: 'assists',       label: '🤝 도움'     },
    { key: 'shots',         label: '🎯 슈팅'     },
    { key: 'key_passes',    label: '🔑 키패스'   },
    { key: 'dribbles',      label: '💨 드리블'   },
    { key: 'tackles',       label: '🛡️ 태클'    },
    { key: 'interceptions', label: '✋ 인터셉트' },
    { key: 'rating',        label: '⭐ 평점'     },
  ];

  // [헤더 라벨, API 필드]  — 첫 번째가 주요 지표 (굵게 + 하이라이트)
  const PERF_COLS = {
    goals:         [['득점','goals'],         ['도움','assists'],      ['슈팅','shots'],      ['평점','avgRating']],
    assists:       [['도움','assists'],       ['키패스','keyPasses'],  ['득점','goals'],      ['평점','avgRating']],
    shots:         [['슈팅','shots'],         ['유효','shotsOn'],      ['득점','goals'],      ['평점','avgRating']],
    key_passes:    [['키패스','keyPasses'],   ['도움','assists'],      ['패스%','passPct'],   ['평점','avgRating']],
    dribbles:      [['드리블','dribbles'],    ['키패스','keyPasses'],  ['득점','goals'],      ['평점','avgRating']],
    tackles:       [['태클','tackles'],       ['인터셉트','interceptions'], ['패스%','passPct'], ['평점','avgRating']],
    interceptions: [['인터셉트','interceptions'], ['태클','tackles'], ['패스%','passPct'],   ['평점','avgRating']],
    rating:        [['평점','avgRating'],     ['득점','goals'],        ['도움','assists'],    ['키패스','keyPasses']],
  };

  function posLabel(pos) {
    return { F: '공', M: '미', D: '수', G: '골' }[pos] || pos || '-';
  }

  async function renderTopPerformers(code, qs) {
    const content = document.getElementById('gl-content');
    content.innerHTML = `
      <div class="gl-perf-wrap2">
        <div class="gl-perf-metrics" id="gl-perf-metrics">
          ${PERF_METRICS.map(m => `
            <button type="button" class="gl-perf-btn${GL.activePerfMetric === m.key ? ' active' : ''}"
                    aria-pressed="${GL.activePerfMetric === m.key}" data-metric="${m.key}">${m.label}</button>
          `).join('')}
        </div>
        <div id="gl-perf-table" class="gl-perf-table-area">
          <div class="gl-loading">로딩 중…</div>
        </div>
      </div>
    `;

    document.querySelectorAll('.gl-perf-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        GL.activePerfMetric = btn.dataset.metric;
        document.querySelectorAll('.gl-perf-btn').forEach(b => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        await _loadPerfTable(code, qs, GL.activePerfMetric);
      });
    });

    await _loadPerfTable(code, qs, GL.activePerfMetric);
  }

  async function _loadPerfTable(code, qs, metric) {
    const area = document.getElementById('gl-perf-table');
    if (!area) return;
    area.innerHTML = '<div class="gl-loading">로딩 중…</div>';

    const cKey = `${code}|${qs}|${metric}`;
    if (!_perfCache[cKey]) {
      try {
        const r = await fetch(`/api/league/${code}/top-performers${qs}&metric=${metric}&limit=20`);
        _perfCache[cKey] = await r.json();
      } catch (e) {
        area.innerHTML = '<div class="gl-error">데이터 로드 실패</div>';
        return;
      }
    }

    const data = _perfCache[cKey];
    if (!data.length) {
      area.innerHTML = noDataHtml('TOP 퍼포머', code);
      return;
    }

    const cols     = PERF_COLS[metric] || PERF_COLS.goals;

    area.innerHTML = `
      <div class="gl-table-wrap">
        <div class="gl-src-badge">📡 시즌 누적 · 3경기 이상 출전 선수${metric === 'rating' ? ' · 평점은 출전 시간이 적으면 높게 나올 수 있음' : ''}</div>
        <table class="gl-table gl-perf-tbl">
          <thead>
            <tr>
              <th>#</th><th>선수</th><th>팀</th><th>POS</th><th>경기</th><th>출전(분)</th>
              ${cols.map((c, i) => `<th class="num-col${i === 0 ? ' gl-perf-primary' : ''}">${c[0]}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${data.slice(0, 20).map((p, i) => {
              const cells = cols.map((c, ci) => {
                const val  = p[c[1]];
                const disp = (val === null || val === undefined) ? '-'
                  : (c[1] === 'avgRating' ? (Number(val) > 0 ? Number(val).toFixed(2) : '-') : val);
                const cls  = `num-col${ci === 0 ? ' gl-perf-primary' : ''}`;
                return `<td class="${cls}">${ci === 0 ? `<strong>${disp}</strong>` : disp}</td>`;
              }).join('');
              return `
                <tr>
                  <td class="gl-rank">${i + 1}</td>
                  <td class="gl-player-name">${ttEsc(p.name)}</td>
                  <td class="gl-team-sub">${ttEsc(p.team)}</td>
                  <td class="gl-pos">${posLabel(p.position)}</td>
                  <td>${p.games}</td>
                  <td class="gl-team-sub">${p.minutes ?? '-'}</td>
                  ${cells}
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ── 데이터 없음 안내 ─────────────────────────────── */
  // 사용자 화면용 — 내부 수집 명령은 노출하지 않는다
  function noDataHtml(section, code) {
    const l = GL.leagues.find(x => x.code === code);
    return `
      <div class="gl-empty">
        <p><strong>${ttEsc(l ? l.label : code)}</strong> ${ttEsc(section)} 데이터가 아직 없습니다.</p>
        <p class="gl-empty-sub">시즌 초반이거나 수집 전입니다. 주간 업데이트 뒤 다시 확인해 주세요.</p>
      </div>
    `;
  }

  /* ── 탭 전환 감지 ─────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    // workspace.js가 탭 전환 시 'ws-tab-changed' 이벤트를 발행한다고 가정
    // 없으면 MutationObserver로 패널 표시 감지
    const panel = document.getElementById('ws-global');
    if (!panel) return;

    const observer = new MutationObserver(() => {
      if (!panel.classList.contains('hidden')) {
        init();
      }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  });

  window.initGlobalLeagueView = init;
})();
