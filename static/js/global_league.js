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
        <div class="gl-section-tabs" id="gl-section-tabs" role="tablist"></div>
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

    document.getElementById('gl-section-tabs').addEventListener('click', e => {
      const btn = e.target.closest('.gl-sec-btn');
      if (!btn) return;
      GL.activeSection = btn.dataset.sec;
      renderSectionTabs();
      loadSection();
    });
    renderSectionTabs();
    renderLeagueHead();
  }

  /* 섹션 탭 — '팀 슈팅·진형'은 SofaScore 슈팅맵이 있는 리그만(현재 J1, 2026-11-24) */
  function sectionsFor(code) {
    const l = GL.leagues.find(x => x.code === code);
    return ['standings', 'team-rankings', 'top-performers', 'players']
      .concat(l && l.hasSquadValue ? ['squad-value'] : [])
      .concat(l && l.hasTeamXg ? ['team-xg'] : [])
      .concat(l && l.hasShotmap ? ['team-tactics'] : []);
  }
  function renderSectionTabs() {
    const wrap = document.getElementById('gl-section-tabs');
    if (!wrap) return;
    const secs = sectionsFor(GL.activeLeague);
    if (!secs.includes(GL.activeSection)) GL.activeSection = 'standings';
    wrap.innerHTML = secs.map(s =>
      `<button type="button" role="tab" aria-selected="${GL.activeSection === s}" class="gl-sec-btn${GL.activeSection === s ? ' active' : ''}" data-sec="${s}">${sectionLabel(s)}</button>`).join('');
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
        : l.hasShotmap
          ? '출처 API-Football(기록) · SofaScore(슈팅 좌표·xG·평균 위치) · 히트맵 미제공'
          : l.hasTeamXg
          ? '출처 API-Football · 시즌 누적 기록 + 경기별 팀 xG (슈팅 좌표·히트맵 미제공)'
          : '출처 API-Football · 시즌 누적 기록 (xG·히트맵 미제공)'}</span>`;
  }

  function sectionLabel(s) {
    return { standings: '📋 순위표', 'team-rankings': '📊 팀 지표', 'top-performers': '⭐ TOP 퍼포머', players: '🔎 선수 탐색',
             'squad-value': '💰 스쿼드 가치', 'team-xg': '📈 팀 xG', 'team-tactics': '🎯 팀 슈팅·진형' }[s] || s;
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
    renderSectionTabs();
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
        case 'players':        await renderPlayerExplorer(code, qs); break;
        case 'team-xg':        await renderTeamXg(code, qs);         break;
        case 'squad-value': {
          const sv = await (await fetch(`/api/squad-value?league=${encodeURIComponent(code)}`)).json();
          document.getElementById('gl-content').innerHTML = window.ttSquadValue ? window.ttSquadValue.html(sv) : noDataHtml('스쿼드 가치', code);
          break;
        }
        case 'team-tactics':   await renderTeamTactics(code, qs);    break;
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
    // 미지의 값은 API-Football 원문이 그대로 오므로 이스케이프 (innerHTML 로 들어감)
    return { F: '공', M: '미', D: '수', G: '골' }[pos] || ttEsc(pos || '-');
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
                  <td class="gl-player-name"><button type="button" class="gl-pname-btn" data-pid="${Number(p.playerId) || ''}"
                      title="경기별 기록 보기" aria-label="${ttEsc(p.name)} 경기별 기록 보기">${ttEsc(p.name)}</button></td>
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
    area.querySelectorAll('.gl-pname-btn').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.pid) openPlayerMatches(code, b.dataset.pid, b);
    }));
  }

  /* ── 선수 경기별 기록 모달 (2026-11-13) ───────────────── */
  const RES_LABEL = { W: '승', D: '무', L: '패' };

  function ratingBand(r) {
    return r >= 7.5 ? 'hi' : r >= 6.5 ? 'mid' : 'lo';
  }

  // 평점 막대 — 막대 위 숫자로 값을 함께 표기(색에만 의존하지 않음)
  function ratingChartSvg(matches) {
    const pts = matches.filter(m => m.rating);
    if (pts.length < 2) return '';
    const W = Math.max(pts.length * 34, 300), H = 120, base = 5, top = 10, plotH = 78;
    const y = r => H - 22 - ((Math.min(Math.max(r, base), top) - base) / (top - base)) * plotH;
    const avg = pts.reduce((s, m) => s + m.rating, 0) / pts.length;
    const bars = pts.map((m, i) => {
      const x = i * 34 + 8, yy = y(m.rating);
      return `<g><title>${m.round ? m.round + 'R ' : ''}vs ${ttEsc(m.opponent)} · 평점 ${m.rating.toFixed(1)}</title>
        <rect class="gl-pm-bar ${ratingBand(m.rating)}" x="${x}" y="${yy}" width="20" height="${H - 22 - yy}" rx="3"></rect>
        <text class="gl-pm-bar-val" x="${x + 10}" y="${yy - 4}" text-anchor="middle">${m.rating.toFixed(1)}</text>
        <text class="gl-pm-bar-lab" x="${x + 10}" y="${H - 6}" text-anchor="middle">${m.round ? m.round + 'R' : i + 1}</text></g>`;
    }).join('');
    return `
      <div class="gl-pm-chart" role="img" aria-label="경기별 평점 추이, 평균 ${avg.toFixed(2)}">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
          <line class="gl-pm-avg" x1="0" x2="${W}" y1="${y(avg)}" y2="${y(avg)}"></line>
          ${bars}
        </svg>
      </div>`;
  }

  let _pmCleanup = null;   // 모달 안에서 다른 선수를 열 때 이전 Esc 리스너 정리

  async function openPlayerMatches(code, pid, opener) {
    if (_pmCleanup) _pmCleanup();
    document.querySelector('.gl-pm-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'gd-overlay gl-pm-overlay';
    ov.innerHTML = `
      <div class="gd-card gl-pm-card" role="dialog" aria-modal="true" aria-labelledby="gl-pm-title">
        <div class="gd-head">
          <h2 class="gd-title" id="gl-pm-title">경기별 기록</h2>
          <button type="button" class="gd-close" aria-label="닫기">✕</button>
        </div>
        <div class="gl-pm-body"><div class="gl-loading">로딩 중…</div></div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('gd-visible'));
    const close = () => {
      _pmCleanup();
      ov.remove();
      if (opener?.isConnected) opener.focus();
    };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    _pmCleanup = () => { document.removeEventListener('keydown', onKey); _pmCleanup = null; };
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('.gd-close').addEventListener('click', close);
    ov.querySelector('.gd-close').focus();

    const body = ov.querySelector('.gl-pm-body');
    let d;
    try {
      const r = await fetch(`/api/league/${encodeURIComponent(code)}/player-matches?playerId=${encodeURIComponent(pid)}&year=${encodeURIComponent(GL.activeYear || '')}`);
      d = await r.json();
      if (!r.ok && r.status !== 404) throw new Error(d.error || r.status);
    } catch (e) {
      body.innerHTML = `<div class="gl-error">데이터 로드 실패: ${ttEsc(e.message)}</div>`;
      return;
    }
    if (!ov.isConnected) return;
    const p = d.player || {}, s = d.summary || {}, ms = d.matches || [];
    ov.querySelector('#gl-pm-title').textContent = p.name || '경기별 기록';
    if (!ms.length) {
      body.innerHTML = `<div class="gl-empty"><p>경기별 기록이 아직 없습니다.</p>
        <p class="gl-empty-sub">이 리그는 시즌 누적 기록만 있습니다. 1부 6개 리그는 매주 경기별 기록을 받습니다.</p></div>
        <div class="gl-sim" id="gl-sim"></div>`;
      loadSimilar(code, pid, opener, 'league');
      return;
    }
    const isGk = p.position === 'G';
    const age = p.birthDate ? Math.floor((Date.now() - new Date(p.birthDate)) / 31557600000) : null;
    const tile = (lab, val) => `<div class="gl-pm-tile"><span class="gl-pm-tile-val">${val ?? '-'}</span><span class="gl-pm-tile-lab">${lab}</span></div>`;
    const fmtDate = ts => new Date(ts * 1000).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
    const n = v => (v === null || v === undefined) ? '-' : v;

    body.innerHTML = `
      <p class="gl-pm-sub">${ttEsc(p.team)} · ${posLabel(p.position)}${p.nationality ? ' · ' + ttEsc(p.nationality) : ''}${age ? ` · ${age}세` : ''}</p>
      <div class="gl-pm-tiles">
        ${tile('경기', s.games)}${tile('출전(분)', s.minutes)}${tile('득점', s.goals)}${tile('도움', s.assists)}
        ${tile('평균 평점', s.avgRating != null ? Number(s.avgRating).toFixed(2) : '-')}
        ${tile('팀 성적', `${s.wins}승 ${s.draws}무 ${s.losses}패`)}
      </div>
      <h3 class="gl-pm-h">평점 추이 <span class="gl-pm-h-sub">점선 = 평균 · 막대 숫자 = 평점</span></h3>
      ${ratingChartSvg(ms) || '<p class="gl-pm-h-sub">평점이 있는 경기가 2경기 미만입니다.</p>'}
      <div class="gl-sim" id="gl-sim"></div>
      <h3 class="gl-pm-h">경기 목록 <span class="gl-pm-h-sub">최근 경기부터</span></h3>
      <div class="gl-table-wrap gl-pm-tbl-wrap">
        <table class="gl-table gl-pm-tbl">
          <thead><tr>
            <th>R</th><th>날짜</th><th>상대</th><th>결과</th><th class="num-col">분</th><th class="num-col">평점</th>
            <th class="num-col">골</th><th class="num-col">도움</th>
            ${isGk ? '<th class="num-col">선방</th><th class="num-col">실점</th>'
                   : '<th class="num-col">슈팅(유효)</th><th class="num-col">키패스</th><th class="num-col">드리블</th>'}
            <th class="num-col">패스(성공%)</th><th class="num-col">경합 승</th><th class="num-col">태클</th><th class="num-col">인터셉트</th><th>카드</th>
          </tr></thead>
          <tbody>
            ${ms.slice().reverse().map(m => `
              <tr>
                <td class="gl-team-sub">${n(m.round)}</td>
                <td class="gl-team-sub">${fmtDate(m.date)}</td>
                <td>${ttEsc(m.opponent)} <span class="gl-pm-ha">${m.home ? '홈' : '원정'}</span></td>
                <td><span class="gl-pm-res ${m.result || ''}">${RES_LABEL[m.result] || '-'}</span> ${n(m.gf)}-${n(m.ga)}</td>
                <td class="num-col">${n(m.minutes)}</td>
                <td class="num-col"><span class="gl-pm-rt ${m.rating ? ratingBand(m.rating) : ''}">${m.rating ? m.rating.toFixed(1) : '-'}</span></td>
                <td class="num-col">${m.goals ? `<strong>${m.goals}</strong>` : 0}</td>
                <td class="num-col">${m.assists ? `<strong>${m.assists}</strong>` : 0}</td>
                ${isGk ? `<td class="num-col">${n(m.saves)}</td><td class="num-col">${n(m.conceded)}</td>`
                       : `<td class="num-col">${n(m.shots)}(${n(m.shotsOn)})</td><td class="num-col">${n(m.keyPasses)}</td>
                          <td class="num-col">${n(m.dribbles)}/${n(m.dribblesAtt)}</td>`}
                <td class="num-col">${n(m.passes)}${m.passPct != null ? ` (${m.passPct}%)` : ''}</td>
                <td class="num-col">${n(m.duelWon)}/${(m.duelWon || 0) + (m.duelLost || 0)}</td>
                <td class="num-col">${n(m.tackles)}</td>
                <td class="num-col">${n(m.interceptions)}</td>
                <td>${m.red ? '<span class="gl-pm-bk red" title="퇴장">퇴장</span>' : m.yellow ? '<span class="gl-pm-bk yel" title="경고">경고</span>' : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="gl-pm-src">📡 ${ttEsc(d.source || '')}</p>`;
    loadSimilar(code, pid, opener, 'league');
  }

  /* 비슷한 선수 — 같은 리그 / 1부 6개 리그 전환 */
  async function loadSimilar(code, pid, opener, scope) {
    const box = document.getElementById('gl-sim');
    if (!box) return;
    const head = `
      <h3 class="gl-pm-h">비슷한 선수
        <span class="gl-sim-scope" role="group" aria-label="비교 범위">
          ${[['league', '같은 리그'], ['top', '1부 6개 리그']].map(([k, lab]) =>
            `<button type="button" class="gl-chip${k === scope ? ' active' : ''}" aria-pressed="${k === scope}" data-scope="${k}">${lab}</button>`).join('')}
        </span>
      </h3>`;
    box.innerHTML = head + '<div class="gl-loading">찾는 중…</div>';
    const bind = () => box.querySelectorAll('[data-scope]').forEach(b =>
      b.addEventListener('click', () => loadSimilar(code, pid, opener, b.dataset.scope)));
    bind();
    let d;
    try {
      const r = await fetch(`/api/league/${encodeURIComponent(code)}/similar-players?playerId=${encodeURIComponent(pid)}&scope=${scope}`);
      d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
    } catch (e) {
      box.innerHTML = head + `<div class="gl-error">불러오지 못했습니다: ${ttEsc(e.message)}</div>`;
      bind();
      return;
    }
    if (!box.isConnected) return;
    if (!d.similar || !d.similar.length) {
      box.innerHTML = head + `<p class="gl-pm-h-sub">${ttEsc(d.reason || '비슷한 선수를 찾지 못했습니다.')}</p>`;
      bind();
      return;
    }
    const mets = d.metrics || [];
    const keys = mets.map(m => m.key);
    const v = x => (x === null || x === undefined) ? '-' : x;
    box.innerHTML = head + `
      <div class="gl-table-wrap">
        <table class="gl-table gl-sim-tbl">
          <thead><tr><th>선수</th><th>팀</th>${scope === 'top' ? '<th>리그</th>' : ''}<th class="num-col">나이</th><th class="num-col">출전(분)</th>
            ${mets.map(m => `<th class="num-col">${ttEsc(m.label)}</th>`).join('')}</tr></thead>
          <tbody>
            <tr class="gl-sim-self"><td>기준 선수</td><td></td>${scope === 'top' ? '<td></td>' : ''}<td></td><td></td>
              ${keys.map(k => `<td class="num-col">${v(d.target[k])}</td>`).join('')}</tr>
            ${d.similar.map(s => `
              <tr>
                <td><button type="button" class="gl-pname-btn" data-code="${ttEsc(s.code)}" data-pid="${Number(s.id)}">${ttEsc(s.name)}</button></td>
                <td class="gl-team-sub">${ttEsc(s.team)}</td>
                ${scope === 'top' ? `<td class="gl-team-sub">${ttEsc(s.league)}</td>` : ''}
                <td class="num-col">${v(s.age)}</td><td class="num-col">${v(s.mins)}</td>
                ${keys.map(k => `<td class="num-col">${v(s.stats[k])}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="gl-pm-src">${ttEsc(d.note || '')} · 비교군 ${Number(d.poolSize) || 0}명</p>`;
    bind();
    box.querySelectorAll('.gl-pname-btn').forEach(b => b.addEventListener('click', () =>
      openPlayerMatches(b.dataset.code, b.dataset.pid, opener)));
  }

  /* ── 선수 탐색 (2026-11-13) — 전체 선수 검색·필터·정렬 + 최근 폼 추천 ── */
  const _playersCache = {};
  const PX = { q: '', team: '', pos: '', minMins: 0, per90: false, sort: 'goals', dir: -1, shown: 50 };
  const PX_COLS = [
    ['games', '경기', false], ['minutes', '출전(분)', false], ['goals', '골', true], ['assists', '도움', true],
    ['shots', '슈팅', true], ['keyPasses', '키패스', true], ['dribbles', '드리블', true], ['tackles', '태클', true],
    ['interceptions', '인터셉트', true], ['passPct', '패스%', false], ['rating', '평점', false],
  ];
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  async function renderPlayerExplorer(code, qs) {
    const content = document.getElementById('gl-content');
    const cKey = code + qs;
    if (!_playersCache[cKey]) {
      const r = await fetch(`/api/league/${code}/players${qs}`);
      _playersCache[cKey] = await r.json();
    }
    const data = _playersCache[cKey];
    const players = data.players || [];
    if (!players.length) {
      content.innerHTML = noDataHtml('선수', code);
      return;
    }
    players.forEach(p => { p._q = fold(p.name) + ' ' + fold(p.team); });
    const teams = [...new Map(players.map(p => [p.teamId, p.team])).entries()]
      .filter(([id]) => id != null).sort((a, b) => a[1].localeCompare(b[1]));
    if (PX.team && !teams.some(([id]) => String(id) === PX.team)) PX.team = '';   // 리그가 바뀌면 팀 필터 초기화

    content.innerHTML = `
      <div class="gl-px">
        <div class="gl-px-form" id="gl-px-form" hidden></div>
        <div class="gl-px-bar">
          <input type="search" id="gl-px-q" class="gl-px-input" placeholder="선수·팀 이름 검색" aria-label="선수 또는 팀 이름 검색" value="${ttEsc(PX.q)}">
          <select id="gl-px-team" class="gl-select" aria-label="팀">
            <option value="">전체 팀</option>
            ${teams.map(([id, name]) => `<option value="${id}"${String(id) === PX.team ? ' selected' : ''}>${ttEsc(name)}</option>`).join('')}
          </select>
          <span class="gl-px-chips" role="group" aria-label="포지션">
            ${[['', '전체'], ['F', '공격'], ['M', '미드'], ['D', '수비'], ['G', '골키퍼']].map(([k, lab]) =>
              `<button type="button" class="gl-chip${PX.pos === k ? ' active' : ''}" aria-pressed="${PX.pos === k}" data-pos="${k}">${lab}</button>`).join('')}
          </span>
          <select id="gl-px-min" class="gl-select" aria-label="최소 출전 시간">
            ${[[0, '출전 전체'], [270, '270분+'], [450, '450분+'], [900, '900분+']].map(([v, lab]) =>
              `<option value="${v}"${PX.minMins === v ? ' selected' : ''}>${lab}</option>`).join('')}
          </select>
          <label class="gl-px-toggle"><input type="checkbox" id="gl-px-90"${PX.per90 ? ' checked' : ''}> 90분당</label>
        </div>
        <div id="gl-px-table"></div>
      </div>`;

    const redraw = () => { PX.shown = 50; drawPlayerTable(code, players); };
    let t;
    document.getElementById('gl-px-q').addEventListener('input', e => {
      clearTimeout(t); t = setTimeout(() => { PX.q = e.target.value; redraw(); }, 200);
    });
    document.getElementById('gl-px-team').addEventListener('change', e => { PX.team = e.target.value; redraw(); });
    document.getElementById('gl-px-min').addEventListener('change', e => { PX.minMins = Number(e.target.value); redraw(); });
    document.getElementById('gl-px-90').addEventListener('change', e => {
      PX.per90 = e.target.checked;
      if (PX.per90 && PX.minMins < 270) {   // 출전이 짧은 선수의 90분당 수치는 과장되므로 기본 하한
        PX.minMins = 270;
        document.getElementById('gl-px-min').value = '270';
      }
      redraw();
    });
    content.querySelectorAll('[data-pos]').forEach(b => b.addEventListener('click', () => {
      PX.pos = b.dataset.pos;
      content.querySelectorAll('[data-pos]').forEach(x => {
        x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b));
      });
      redraw();
    }));
    drawPlayerTable(code, players);
    if (data.hasMatches) loadFormRisers(code, qs);
  }

  function drawPlayerTable(code, players) {
    const area = document.getElementById('gl-px-table');
    if (!area) return;
    const q = fold(PX.q.trim());
    const val = (p, k, per90) => {
      const raw = p[k];
      if (raw === null || raw === undefined) return null;
      return (per90 && PX_COLS.find(c => c[0] === k)?.[2]) ? (p.minutes ? raw * 90 / p.minutes : 0) : raw;
    };
    const list = players.filter(p =>
      (!q || p._q.includes(q)) && (!PX.team || String(p.teamId) === PX.team) &&
      (!PX.pos || p.position === PX.pos) && p.minutes >= PX.minMins);
    list.sort((a, b) => {
      const va = val(a, PX.sort, PX.per90), vb = val(b, PX.sort, PX.per90);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;      // 값 없는 선수는 정렬 방향과 관계없이 맨 뒤
      if (vb === null) return -1;
      return (va - vb) * PX.dir || (b.minutes - a.minutes);
    });
    const fmt = (p, k) => {
      const v = val(p, k, PX.per90);
      if (v === null) return '-';
      if (k === 'rating') return v.toFixed(2);
      return (PX.per90 && PX_COLS.find(c => c[0] === k)?.[2]) ? v.toFixed(2) : v;
    };
    const shown = list.slice(0, PX.shown);
    area.innerHTML = `
      <div class="gl-table-wrap">
        <div class="gl-src-badge">${list.length}명 · 시즌 누적${PX.per90 ? ' · 득점·슈팅 등은 90분당' : ''} · 이름을 누르면 경기별 기록과 비슷한 선수</div>
        <table class="gl-table gl-sortable gl-px-tbl">
          <thead><tr>
            <th>#</th><th>선수</th><th>팀</th><th>POS</th><th class="num-col">나이</th>
            ${PX_COLS.map(([k, lab]) => {
              const on = k === PX.sort;
              return `<th class="num-col${on ? ' gl-perf-primary' : ''}" aria-sort="${on ? (PX.dir < 0 ? 'descending' : 'ascending') : 'none'}">
                <button type="button" class="gl-sort-btn" data-key="${k}">${lab}${on ? (PX.dir < 0 ? ' ▾' : ' ▴') : ''}</button></th>`;
            }).join('')}
          </tr></thead>
          <tbody>
            ${shown.length ? shown.map((p, i) => `
              <tr>
                <td class="gl-rank">${i + 1}</td>
                <td class="gl-player-name"><button type="button" class="gl-pname-btn" data-pid="${Number(p.id)}"
                    aria-label="${ttEsc(p.name)} 경기별 기록 보기">${ttEsc(p.name)}</button></td>
                <td class="gl-team-sub">${ttEsc(p.team)}</td>
                <td class="gl-pos">${posLabel(p.position)}</td>
                <td class="num-col">${p.age ?? '-'}</td>
                ${PX_COLS.map(([k]) => `<td class="num-col${k === PX.sort ? ' gl-perf-primary' : ''}">${fmt(p, k)}</td>`).join('')}
              </tr>`).join('')
            : `<tr><td colspan="${5 + PX_COLS.length}" class="gl-px-none">조건에 맞는 선수가 없습니다.</td></tr>`}
          </tbody>
        </table>
        ${list.length > PX.shown ? `<button type="button" class="gl-px-more" id="gl-px-more">더 보기 (${list.length - PX.shown}명 남음)</button>` : ''}
      </div>`;
    area.querySelectorAll('.gl-sort-btn').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.key;
      PX.dir = PX.sort === k ? -PX.dir : -1;
      PX.sort = k;
      drawPlayerTable(code, players);
      document.querySelector(`#gl-px-table .gl-sort-btn[data-key="${k}"]`)?.focus();
    }));
    area.querySelectorAll('.gl-pname-btn').forEach(b => b.addEventListener('click', () =>
      openPlayerMatches(code, b.dataset.pid, b)));
    document.getElementById('gl-px-more')?.addEventListener('click', () => {
      PX.shown += 50;
      drawPlayerTable(code, players);
    });
  }

  async function loadFormRisers(code, qs) {
    const box = document.getElementById('gl-px-form');
    if (!box) return;
    let d;
    try {
      d = await (await fetch(`/api/league/${code}/player-form${qs}`)).json();
    } catch (e) { return; }
    if (!box.isConnected || !d.risers || !d.risers.length) return;
    box.hidden = false;
    box.innerHTML = `
      <h3 class="gl-pm-h">🔥 최근 폼 상승 <span class="gl-pm-h-sub">최근 ${d.n}경기 평균 평점 − 그 이전 평균 · 21일 안에 뛴 선수</span></h3>
      <div class="gl-px-cards">
        ${d.risers.map(r => `
          <button type="button" class="gl-px-card" data-pid="${Number(r.id)}" aria-label="${ttEsc(r.name)} 경기별 기록 보기">
            <span class="gl-px-card-name">${ttEsc(r.name)}</span>
            <span class="gl-px-card-sub">${ttEsc(r.team)} · ${posLabel(r.position)}</span>
            <span class="gl-px-card-num"><strong>${r.recentAvg.toFixed(2)}</strong>
              <span class="gl-px-up">▲ ${r.delta.toFixed(2)}</span></span>
            <span class="gl-px-card-sub">이전 ${r.earlierAvg.toFixed(2)} · 최근 ${d.n}경기 ${r.recentGoals}골 ${r.recentAssists}도움</span>
          </button>`).join('')}
      </div>`;
    box.querySelectorAll('.gl-px-card').forEach(b => b.addEventListener('click', () =>
      openPlayerMatches(code, b.dataset.pid, b)));
  }

  /* ── 팀 xG (API-Football 경기별 팀 기록, 2026-11-25) ─────────────────── */
  async function renderTeamXg(code, qs) {
    const content = document.getElementById('gl-content');
    const d = await (await fetch(`/api/league/${encodeURIComponent(code)}/team-xg${qs}`)).json();
    const rows = (d.teams || []).filter(r => r.xg_games);
    if (!rows.length) { content.innerHTML = noDataHtml('팀 xG', code); return; }
    const sgn = v => (v == null ? '-' : (v > 0 ? '+' : '') + v.toFixed(2));
    const cls = (v, goodPositive) => (v == null || Math.abs(v) < 0.05 ? '' : ((v > 0) === goodPositive ? ' gl-xg-pos' : ' gl-xg-neg'));
    const h = d.highlights || {};
    const lead = `<p class="gl-xg-lead">경기 내용(xG 차) 1위 <b>${ttEsc(h.best_xg_diff || '-')}</b>`
      + (h.over ? ` · 기대보다 많이 넣은 팀 <b>${ttEsc(h.over.name)}</b> (경기당 ${sgn(h.over.value)})` : '')
      + (h.under ? ` · 기대보다 못 넣은 팀 <b>${ttEsc(h.under.name)}</b> (경기당 ${sgn(h.under.value)})` : '')
      + ` <span class="gl-muted">— ${d.games || 0}경기 기준</span></p>`;
    const body = rows.map((r, i) => `<tr>
        <td class="gl-xg-rank">${i + 1}</td><td>${ttEsc(r.name)}</td><td class="gl-num">${r.xg_games}</td>
        <td class="gl-num">${r.xg_for.toFixed(2)}</td><td class="gl-num">${r.xg_against.toFixed(2)}</td>
        <td class="gl-num${cls(r.xg_diff, true)}"><b>${sgn(r.xg_diff)}</b></td>
        <td class="gl-num${cls(r.g_minus_xg, true)}">${sgn(r.g_minus_xg)}</td>
        <td class="gl-num${cls(r.ga_minus_xga, false)}">${sgn(r.ga_minus_xga)}</td>
        <td class="gl-num">${r.shots_pg ?? '-'}</td><td class="gl-num">${r.box_share != null ? r.box_share + '%' : '-'}</td>
        <td class="gl-num">${r.possession != null ? r.possession + '%' : '-'}</td></tr>`).join('');
    content.innerHTML = `<div class="gl-xg">${lead}
      <div class="gl-xg-scroll"><table class="gl-table gl-xg-table">
        <caption class="gl-muted">경기당 평균 · xG 차 큰 순 · 초록/빨강은 좋음/나쁨 방향(부호 함께 표시)</caption>
        <thead><tr><th scope="col">#</th><th scope="col">팀</th><th scope="col" title="xG 있는 경기 수">경기</th>
          <th scope="col" title="경기당 기대득점">xG</th><th scope="col" title="경기당 허용 기대득점">xGA</th>
          <th scope="col" title="xG − xGA (경기당)">xG 차</th><th scope="col" title="득점 − xG (경기당): +면 기대보다 많이 넣음">득점−xG</th>
          <th scope="col" title="실점 − xGA (경기당): −면 기대보다 적게 먹음">실점−xGA</th><th scope="col">슈팅/경기</th>
          <th scope="col" title="전체 슈팅 중 박스 안 슈팅">박스 안</th><th scope="col">점유율</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <details class="gl-xg-notes"><summary>기준</summary><ul>${(d.notes || []).map(n => `<li>${ttEsc(n)}</li>`).join('')}</ul></details>
    </div>`;
  }

  /* ── 팀 슈팅·진형 (SofaScore 슈팅맵·평균 위치, 2026-11-24) ──────────────
   * /api/league/<code>/team-shotmap(side=for|against) · team-shape.
   * 좌표: 슈팅 x = 골라인에서의 거리(0~100, 작을수록 골문 가까움), y = 폭(0~100) / 평균 위치 x = 자기 골문→상대 골문, y = 폭. */
  const SHOT_COL = { goal: '#22c55e', save: '#60a5fa', miss: '#94a3b8', post: '#f59e0b', block: '#a78bfa' };
  const SHOT_LBL = { goal: '골', save: '선방', miss: '빗나감', post: '골대', block: '막힘' };
  async function renderTeamTactics(code, qs) {
    const content = document.getElementById('gl-content');
    if (!GL.tacTeams || GL.tacTeamsCode !== code) {
      GL.tacTeams = await (await fetch(`/api/league/${encodeURIComponent(code)}/teams`)).json();
      GL.tacTeamsCode = code;
    }
    const teams = GL.tacTeams || [];
    if (!teams.length) { content.innerHTML = noDataHtml('팀 슈팅·진형', code); return; }
    if (!GL.tacTeam || !teams.some(t => t.id === GL.tacTeam)) GL.tacTeam = teams[0].id;
    GL.tacSide = GL.tacSide || 'for';
    content.innerHTML = `<div class="gl-tac">
      <div class="gl-tac-ctl">
        <label class="gl-label" for="gl-tac-team">팀</label>
        <select id="gl-tac-team" class="gl-select">${teams.map(t => `<option value="${t.id}"${t.id === GL.tacTeam ? ' selected' : ''}>${ttEsc(t.name)}</option>`).join('')}</select>
        <div class="gl-tac-side" role="group" aria-label="슈팅 구분">
          ${[['for', '공격 슈팅'], ['against', '허용 슈팅']].map(([k, l]) => `<button type="button" class="gl-sec-btn${GL.tacSide === k ? ' active' : ''}" data-side="${k}" aria-pressed="${GL.tacSide === k}">${l}</button>`).join('')}
        </div>
      </div>
      <div id="gl-tac-body" aria-live="polite"><div class="gl-loading">로딩 중…</div></div>
      <p class="gl-empty-sub">출처: SofaScore 경기별 슈팅 좌표·xG·평균 위치. 일부 선수는 이름 연결이 안 돼 평균 위치에서 빠질 수 있습니다.</p>
    </div>`;
    content.querySelector('#gl-tac-team').addEventListener('change', e => { GL.tacTeam = parseInt(e.target.value, 10); drawTeamTactics(code, qs); });
    content.querySelector('.gl-tac-side').addEventListener('click', e => {
      const b = e.target.closest('[data-side]'); if (!b) return;
      GL.tacSide = b.dataset.side;
      content.querySelectorAll('.gl-tac-side [data-side]').forEach(x => { const on = x.dataset.side === GL.tacSide; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
      drawTeamTactics(code, qs);
    });
    await drawTeamTactics(code, qs);
  }
  async function drawTeamTactics(code, qs) {
    const body = document.getElementById('gl-tac-body'); if (!body) return;
    const req = (GL.tacReq = (GL.tacReq || 0) + 1);
    body.innerHTML = '<div class="gl-loading">로딩 중…</div>';
    const base = `/api/league/${encodeURIComponent(code)}`;
    let sm, sh;
    try {
      [sm, sh] = await Promise.all([
        fetch(`${base}/team-shotmap${qs}&teamId=${encodeURIComponent(GL.tacTeam)}&side=${GL.tacSide}`).then(r => r.json()),
        fetch(`${base}/team-shape${qs}&teamId=${encodeURIComponent(GL.tacTeam)}`).then(r => r.json()),
      ]);
    } catch (e) {
      if (req === GL.tacReq) body.innerHTML = `<div class="gl-error">데이터 로드 실패</div>`;
      return;
    }
    if (req !== GL.tacReq) return;                       // 늦게 온 응답 무시
    const s = sm.summary || {}, shots = sm.shots || [];
    const ps = sh.players || [];
    if (!shots.length && !ps.length) { body.innerHTML = noDataHtml('팀 슈팅·진형', code); return; }
    const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
    const W = 340, H = 260;
    const X = v => 10 + (Math.min(100, Math.max(0, v)) / 100) * (W - 20);
    const Y = v => 10 + (Math.min(50, Math.max(0, v)) / 50) * (H - 20);   // 골문에서 하프라인까지(0~50)
    const dots = shots.filter(p => num(p.x) != null && num(p.y) != null)
      .sort((a, b) => (a.outcome === 'goal') - (b.outcome === 'goal')).map(p => {
        const r = Math.max(3, Math.min(12, 3 + Math.sqrt(num(p.xg) || 0) * 18));
        const goal = p.outcome === 'goal';
        return `<circle cx="${X(p.y).toFixed(1)}" cy="${Y(p.x).toFixed(1)}" r="${r.toFixed(1)}" fill="${SHOT_COL[p.outcome] || '#94a3b8'}" fill-opacity="${goal ? 1 : 0.7}"${goal ? ' stroke="#fff" stroke-width="1.5"' : ''}><title>${ttEsc(p.name || '')} ${num(p.minute) != null ? p.minute + "'" : ''} · ${ttEsc(SHOT_LBL[p.outcome] || p.outcome || '')} · xG ${num(p.xg) != null ? p.xg.toFixed(2) : '-'}</title></circle>`;
      }).join('');
    const line = 'rgba(255,255,255,.35)';
    const pitchHalf = `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="#163d1c" stroke="${line}"/>
      <rect x="${X(21.1)}" y="10" width="${(X(78.9) - X(21.1)).toFixed(1)}" height="${(Y(16.5) - 10).toFixed(1)}" fill="none" stroke="${line}"/>
      <rect x="${X(36.8)}" y="10" width="${(X(63.2) - X(36.8)).toFixed(1)}" height="${(Y(5.5) - 10).toFixed(1)}" fill="none" stroke="${line}"/>
      <line x1="${X(44.6)}" y1="10" x2="${X(55.4)}" y2="10" stroke="#fff" stroke-width="3"/>`;
    const counts = {}; shots.forEach(p => { counts[p.outcome] = (counts[p.outcome] || 0) + 1; });
    const legend = Object.keys(SHOT_LBL).filter(k => counts[k]).map(k => `<span class="gl-tac-leg"><i style="background:${SHOT_COL[k]}"></i>${SHOT_LBL[k]} ${counts[k]}</span>`).join('');
    const FW = 340, FH = 220;
    const fx = v => 10 + (Math.min(100, Math.max(0, v)) / 100) * (FW - 20), fy = v => 10 + (Math.min(100, Math.max(0, v)) / 100) * (FH - 20);
    const shape = ps.filter(p => num(p.x) != null && num(p.y) != null).map(p => `<g><circle cx="${fx(p.x).toFixed(1)}" cy="${fy(p.y).toFixed(1)}" r="9" fill="#2563eb" stroke="#fff" stroke-width="1"><title>${ttEsc(p.name)} · ${num(p.games) || 0}경기</title></circle>
        <text x="${fx(p.x).toFixed(1)}" y="${(fy(p.y) + 21).toFixed(1)}" text-anchor="middle" font-size="12" fill="#e2e8f0">${ttEsc(String(p.name || '').split(' ').pop())}</text></g>`).join('');
    const sum = sh.summary || {};
    const kp = (l, v) => `<span>${l} <b>${v == null ? '-' : ttEsc(v)}</b></span>`;
    body.innerHTML = `<div class="gl-tac-grid">
      <section class="gl-tac-card" aria-label="${GL.tacSide === 'for' ? '공격' : '허용'} 슈팅맵">
        <h4>${GL.tacSide === 'for' ? '공격 슈팅' : '허용 슈팅'} <span class="gl-muted">${num(s.games) || 0}경기</span></h4>
        <div class="gl-tac-kpis">${kp('슈팅', s.shots)}${kp('골', s.goals)}${kp('xG', s.xg)}${kp('경기당 xG', s.xgPerGame)}${kp('골−xG', s.efficiency)}</div>
        <svg viewBox="0 0 ${W} ${H}" class="gl-tac-svg" role="img" aria-label="슈팅 ${num(s.shots) || 0}개, 골 ${num(s.goals) || 0}, xG ${num(s.xg) ?? '-'}">${pitchHalf}${dots}</svg>
        <div class="gl-tac-legs">${legend}<span class="gl-muted">원 크기 = xG · 점에 마우스를 올리면 선수·시간</span></div>
      </section>
      <section class="gl-tac-card" aria-label="선발 평균 위치">
        <h4>선발 평균 위치 <span class="gl-muted">2경기 이상 · 공격 방향 →</span></h4>
        ${ps.length ? `<svg viewBox="0 0 ${FW} ${FH}" class="gl-tac-svg" role="img" aria-label="선발 ${ps.length}명 평균 위치">
          <rect x="10" y="10" width="${FW - 20}" height="${FH - 20}" fill="#163d1c" stroke="${line}"/>
          <line x1="${FW / 2}" y1="10" x2="${FW / 2}" y2="${FH - 10}" stroke="${line}"/>${shape}</svg>
          <p class="gl-muted">평균 위치 무게중심 ${num(sum.centroidX) ?? '-'} (리그 평균 ${num(sum.leagueCentroidX) ?? '-'}) — 클수록 높은 위치에서 경기</p>` : '<p class="gl-muted">평균 위치 데이터 없음</p>'}
      </section></div>`;
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
