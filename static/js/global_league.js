/**
 * global_league.js — 해외리그 탭 (🌍)
 * /api/league/<code>/... 엔드포인트 사용
 * 의존: workspace.js의 탭 전환 이벤트
 */

(function () {
  'use strict';

  /* ── 상태 ─────────────────────────────────────────── */
  const GL = {
    leagues:       [],   // 전체 리그 목록 (/api/leagues)
    activeLeague:  null, // 현재 선택된 league code
    activeYear:    '2025',
    activeSection: 'standings',
    teams:         [],   // 현재 리그 팀 목록
    initialized:   false,
  };

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
    render();
    await loadSection();
  }

  /* ── 전체 렌더 ────────────────────────────────────── */
  function render() {
    ROOT().innerHTML = `
      <div class="gl-wrap">
        <div class="gl-toolbar">
          <div class="gl-league-btns" id="gl-league-btns"></div>
          <div class="gl-year-wrap">
            <label class="gl-label">시즌</label>
            <select id="gl-year" class="gl-select">
              <option value="2025" ${GL.activeYear==='2025'?'selected':''}>2025/26</option>
              <option value="2024" ${GL.activeYear==='2024'?'selected':''}>2024/25</option>
              <option value="2023" ${GL.activeYear==='2023'?'selected':''}>2023/24</option>
            </select>
          </div>
        </div>
        <div class="gl-section-tabs" id="gl-section-tabs">
          ${['standings','team-rankings','top-performers'].map(s =>
            `<button class="gl-sec-btn${GL.activeSection===s?' active':''}" data-sec="${s}">
              ${sectionLabel(s)}
            </button>`
          ).join('')}
        </div>
        <div id="gl-content" class="gl-content">
          <div class="gl-loading">로딩 중…</div>
        </div>
      </div>
    `;

    // 리그 버튼 렌더
    const btnWrap = document.getElementById('gl-league-btns');
    GL.leagues.forEach(l => {
      const btn = document.createElement('button');
      btn.className = 'gl-league-btn' + (l.code === GL.activeLeague ? ' active' : '');
      btn.dataset.code = l.code;
      btn.textContent = l.label;
      btn.addEventListener('click', () => switchLeague(l.code));
      btnWrap.appendChild(btn);
    });

    document.getElementById('gl-year').addEventListener('change', e => {
      GL.activeYear = e.target.value;
      loadSection();
    });

    document.querySelectorAll('.gl-sec-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        GL.activeSection = btn.dataset.sec;
        document.querySelectorAll('.gl-sec-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadSection();
      });
    });
  }

  function sectionLabel(s) {
    return { standings: '📋 순위표', 'team-rankings': '📊 팀 지표', 'top-performers': '⭐ TOP 퍼포머' }[s] || s;
  }

  /* ── 리그 전환 ────────────────────────────────────── */
  async function switchLeague(code) {
    GL.activeLeague = code;
    GL.teams = [];
    document.querySelectorAll('.gl-league-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.code === code)
    );
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

    try {
      switch (GL.activeSection) {
        case 'standings':      await renderStandings(code, qs);      break;
        case 'team-rankings':  await renderTeamRankings(code, qs);   break;
        case 'top-performers': await renderTopPerformers(code, qs);  break;
      }
    } catch (e) {
      content.innerHTML = `<div class="gl-error">데이터 로드 실패: ${e.message}</div>`;
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
                <td class="gl-team-name">${r.team}</td>
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

    content.innerHTML = `
      <div class="gl-table-wrap">
        <table class="gl-table">
          <thead>
            <tr>
              <th>팀</th><th>경기</th><th>xG</th><th>득점</th>
              <th>슈팅</th><th>유효슈팅</th><th>듀얼승</th><th>태클</th><th>평점</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(r => `
              <tr>
                <td class="gl-team-name">${r.team}</td>
                <td>${r.matches}</td>
                <td class="num-col">${r.xg}</td>
                <td class="num-col">${r.goals}</td>
                <td>${r.shots}</td>
                <td>${r.shotsOn}</td>
                <td>${r.duelWon}</td>
                <td>${r.tackles}</td>
                <td class="rating-col">${r.avgRating}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ── TOP 퍼포머 ───────────────────────────────────── */
  async function renderTopPerformers(code, qs) {
    const [resGoals, resRating, resXg] = await Promise.all([
      fetch(`/api/league/${code}/top-performers${qs}&metric=goals`).then(r => r.json()),
      fetch(`/api/league/${code}/top-performers${qs}&metric=rating`).then(r => r.json()),
      fetch(`/api/league/${code}/top-performers${qs}&metric=xg`).then(r => r.json()),
    ]);
    const content = document.getElementById('gl-content');

    if (!resGoals.length && !resRating.length) {
      content.innerHTML = noDataHtml('TOP 퍼포머', code);
      return;
    }

    function playerRows(list) {
      return list.slice(0, 10).map((p, i) => `
        <tr>
          <td class="gl-rank">${i + 1}</td>
          <td class="gl-player-name">${p.name}</td>
          <td class="gl-team-sub">${p.team}</td>
          <td>${p.position || '-'}</td>
          <td>${p.games}</td>
          <td class="num-col"><strong>${p.goals}</strong></td>
          <td>${p.assists}</td>
          <td>${p.xg}</td>
          <td class="rating-col">${p.avgRating}</td>
        </tr>
      `).join('');
    }

    function tableHtml(title, list) {
      if (!list.length) return '';
      return `
        <div class="gl-perf-block">
          <h3 class="gl-perf-title">${title}</h3>
          <table class="gl-table gl-perf-table">
            <thead>
              <tr><th>#</th><th>선수</th><th>팀</th><th>포지션</th>
                  <th>경기</th><th>득점</th><th>도움</th><th>xG</th><th>평점</th></tr>
            </thead>
            <tbody>${playerRows(list)}</tbody>
          </table>
        </div>
      `;
    }

    content.innerHTML = `
      <div class="gl-perf-wrap">
        ${tableHtml('⚽ 득점 순위', resGoals)}
        ${tableHtml('⭐ 평점 순위', resRating)}
        ${tableHtml('🎯 xG 순위', resXg)}
      </div>
    `;
  }

  /* ── 데이터 없음 안내 ─────────────────────────────── */
  function noDataHtml(section, code) {
    return `
      <div class="gl-empty">
        <p>아직 <strong>${code.toUpperCase()}</strong> 데이터가 수집되지 않았습니다.</p>
        <p class="gl-empty-sub">아래 명령으로 수집을 시작하세요:</p>
        <code class="gl-code">python crawlers/crawl_league.py --league ${code} --year 2025</code>
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
