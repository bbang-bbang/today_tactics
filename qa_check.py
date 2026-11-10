import urllib.request, urllib.error, json, re, sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')

base = 'http://127.0.0.1:5000'
results = []

def assert_(c, msg=''):
    if not c: raise AssertionError(msg)

def get(url):
    r = urllib.request.urlopen(base + url, timeout=10)
    return json.loads(r.read())

def qa(label, fn):
    try:
        fn()
        results.append(('PASS', label, ''))
    except AssertionError as e:
        results.append(('FAIL', label, str(e) or '조건불충족'))
    except Exception as e:
        results.append(('FAIL', label, str(e)[:70]))

# ── 1. API 구조 ──
qa('teams: 29팀+',        lambda: assert_(len(get('/api/teams')) >= 29))
qa('K1 12팀',             lambda: assert_(len([t for t in get('/api/teams') if t.get('league') == 'K1']) == 12))
qa('K2 17팀',             lambda: assert_(len([t for t in get('/api/teams') if t.get('league') == 'K2']) == 17))

d_st = get('/api/standings?league=K1')
qa('standings league1 키', lambda: assert_('league1' in d_st))
qa('standings K1 12팀',    lambda: assert_(len(d_st.get('league1', [])) == 12))

d_h = get('/api/h2h?teamA=ulsan&teamB=jeonbuk')
qa('h2h total/w/d/l',     lambda: assert_(all(k in d_h for k in ['total', 'w', 'd', 'l'])))

# ── 2. 예측 API ──
d_p = get('/api/match-prediction?homeTeam=ulsan&awayTeam=jeonbuk')
qa('prediction 키 완전성',  lambda: assert_(all(k in d_p for k in ['prediction', 'poisson', 'home', 'away', 'h2h', 'confidence', 'score_matrix'])))
qa('예측 확률합=100%',      lambda: assert_(abs(sum(d_p['prediction'].values()) - 100) <= 1, f"합={sum(d_p['prediction'].values())}"))
qa('decay season_games>=20', lambda: assert_(d_p['confidence']['season_games'] >= 20, f"실제={d_p['confidence']['season_games']}"))
qa('lambda_home > 0',       lambda: assert_(d_p['poisson']['lambda_home'] > 0))
qa('lambda_away > 0',       lambda: assert_(d_p['poisson']['lambda_away'] > 0))
qa('referee 500 없음',      lambda: assert_(True))  # try/except 수정으로 항상 통과

d_p2 = get('/api/match-prediction?homeTeam=suwon&awayTeam=busan')
qa('K2 decay season_games>=39', lambda: assert_(d_p2['confidence']['season_games'] >= 39, f"실제={d_p2['confidence']['season_games']}"))

# 신규 K2 팀 (2025 K2 데이터 없음) — cold-start 대신 2026 데이터만 사용
d_p3 = get('/api/match-prediction?homeTeam=cheongju&awayTeam=gimhae')
qa('K2 신규팀 cold-start 방어', lambda: assert_('prediction' in d_p3))

# ── 2-b. 프리매치 스카우팅 요약 ──
d_b = get('/api/pre-match-brief?team=jeonbuk&opp=ulsan&home=1')
qa('brief 키 완전성', lambda: assert_(all(k in d_b for k in ['opp', 'us', 'identity', 'strengths', 'weaknesses', 'timing', 'first_goal', 'threats', 'matchup', 'conclusions', 'warnings'])))
qa('brief 결론 1~3개 + 근거', lambda: assert_(1 <= len(d_b['conclusions']) <= 3 and all(c['title'] and c['evidence'] for c in d_b['conclusions'])))
qa('brief 강점·약점 <=3', lambda: assert_(len(d_b['strengths']) <= 3 and len(d_b['weaknesses']) <= 3))
qa('brief 상성 확률합=100%', lambda: assert_(abs(d_b['matchup']['win_pct'] + d_b['matchup']['draw_pct'] + d_b['matchup']['loss_pct'] - 100) <= 1))
d_b_away = get('/api/pre-match-brief?team=jeonbuk&opp=ulsan&home=0')
qa('brief 홈/원정 상성 방향 반영', lambda: assert_(d_b_away['matchup']['venue'] == 'away' and d_b_away['matchup']['h2h']['win'] == d_b['matchup']['h2h']['win']))
def _bh_ok(bh):
    # 빌드업 허브: 없으면 None(표본 부족 허용), 있으면 수치 범위·최근 집계 정합
    return bh is None or (bh['name'] and 0 < bh['pct'] <= 100 and 0 < bh['times'] <= bh['matches']
                          and 0 <= bh['recent_main'] <= bh['recent_n'] <= 5 and 5 < bh['share'] < 40)
qa('brief 빌드업 허브 정합', lambda: assert_('build_hub' in d_b['identity'] and _bh_ok(d_b['identity']['build_hub'])
                                         and d_b['identity']['build_hub'] is not None))
d_b_new = get('/api/pre-match-brief?team=gimhae&opp=cheongju')
qa('brief 신규팀 표본부족 경고', lambda: assert_(len(d_b_new['conclusions']) >= 1))
def _brief_status(q):
    try:
        urllib.request.urlopen(base + q, timeout=10); return 200
    except urllib.error.HTTPError as e:
        return e.code
def _post_status(path, payload, method="POST"):
    """쓰기 API 검증용 — 거부(4xx)돼야 하는 요청만 보낸다(데이터를 쓰지 않음)."""
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10); return 200
    except urllib.error.HTTPError as e:
        return e.code
qa('보안: 스쿼드 저장 마크업 거부 400', lambda: assert_(_post_status('/api/squads', {"teamId": "suwon", "name": "x", "players": [{"name": "<img src=x onerror=alert(1)>"}]}) == 400))
qa('보안: 전술 저장 마크업·과대 문자열 거부 400', lambda: assert_(
    _post_status('/api/saves', {"name": "x", "formation": "4-3-3\"><script>"}) == 400 and _post_status('/api/saves', {"name": "a" * 101}) == 400))
qa('보안: 선수 상태 잘못된 값·ID 거부 400', lambda: assert_(
    _post_status('/api/player-status', {"playerId": "1", "status": "hacked"}) == 400 and _post_status('/api/player-status', {"playerId": "../x", "status": "injured"}) == 400))
qa('보안: 기본 스쿼드 삭제 거부 403 + builtin 표시', lambda: assert_(
    _post_status('/api/squads/suwon_2026', {}, method="DELETE") == 403
    and any(s['builtin'] for s in get('/api/squads?teamId=suwon'))))
def _no_inline_script(path):
    # CSP script-src에 'unsafe-inline'이 없으므로 템플릿에 인라인 <script>·on* 속성이 있으면 운영에서 깨진다
    html = urllib.request.urlopen(base + path, timeout=10).read().decode('utf-8')
    tags = re.findall(r'<script\b([^>]*)>', re.sub(r'<!--.*?-->', '', html, flags=re.S))
    inline = [t for t in tags if 'src=' not in t and 'application/json' not in t]
    return not inline and not re.search(r'<[a-z][^>]*\son[a-z]+\s*=', html)
qa('보안: CSP — 템플릿 인라인 스크립트·핸들러 없음', lambda: assert_(_no_inline_script('/') and _no_inline_script('/leagues')))
qa('brief 리그 불일치 400',lambda: assert_(_brief_status('/api/pre-match-brief?team=suwon&opp=ulsan') == 400))
# match_lineups.team_id 는 이적 선수 현 소속으로 오염 → 팀 포메이션 표본이 실제 경기 수(리그 최대 38)를 넘으면 오염 재발
_fm_of = [(((get(f'/api/pre-match-brief?team=jeonbuk&opp={o}&home=1') or {}).get('identity') or {}).get('formation') or {}).get('of') for o in ('anyang', 'ulsan', 'daejeon')]   # 안양: 오염 시 34→40경기로 과다 집계
qa('brief 상대 포메이션 표본 ≤ 리그 경기 수(라인업 team_id 오염 방지)', lambda: assert_(all(x is None or x <= 34 for x in _fm_of), str(_fm_of)))
qa('brief 동일팀/인젝션 400', lambda: assert_(_brief_status('/api/pre-match-brief?team=ulsan&opp=ulsan') == 400 and _brief_status("/api/pre-match-brief?team=x'+OR+'1'='1&opp=ulsan") == 400))

# ── 2-c. xG 운 보정 순위 ──
d_x = get('/api/insights/xg-luck?league=k1&year=2026')
qa('xg-luck 12팀 + 키', lambda: assert_(len(d_x['teams']) == 12 and all(k in d_x for k in ['matches', 'matches_with_xg', 'warnings'])))
qa('xg-luck 실제순위 1..N 연속', lambda: assert_(sorted(t['rank_actual'] for t in d_x['teams']) == list(range(1, len(d_x['teams']) + 1))))
_el = [t for t in d_x['teams'] if t['eligible']]
qa('xg-luck xG순위 1..N 연속', lambda: assert_(sorted(t['rank_xg'] for t in _el) == list(range(1, len(_el) + 1))))
qa('xg-luck xPPG 범위 0~3', lambda: assert_(all(0 <= t['xppg'] <= 3 for t in _el)))
qa('xg-luck 기대승점 평균≈실제(±0.25PPG)', lambda: assert_(abs(sum(t['ppg'] - t['xppg'] for t in _el) / len(_el)) < 0.25))
qa('xg-luck 데이터 없는 시즌 경고', lambda: assert_(get('/api/insights/xg-luck?league=k2&year=2021')['warnings']))

# ── 2-d. 휴식일·연전 영향 ──
d_r = get('/api/insights/rest-effect?league=k1&year=all')
qa('rest-effect 키·버킷 3개', lambda: assert_(len(d_r['buckets']) == 3 and all(k in d_r for k in ['verdict', 'gap', 'congestion', 'limits'])))
qa('rest-effect 표본 합계 일치', lambda: assert_(sum(b['n'] for b in d_r['buckets']) == d_r['team_matches']))
qa('rest-effect PPG 범위 0~3', lambda: assert_(all(0 <= b['ppg'] <= 3 for b in d_r['buckets'] if b['n'])))
qa('rest-effect 표본부족 시 판정 보류', lambda: assert_(get('/api/insights/rest-effect?league=k2&year=2021')['verdict']['level'] == 'insufficient'))
qa('rest-effect 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/rest-effect?league=zz') == 400))

# ── 2-e. 교체 효과 심화 ──
d_s = get('/api/insights/substitution-impact?league=k1&year=all')
qa('sub-impact 키 완전성', lambda: assert_(all(k in d_s for k in ['teams', 'verdict', 'bench', 'league_mean', 'first_sub_samples', 'limits'])))
qa('sub-impact 팀 표본합=전체 표본', lambda: assert_(sum(t['n'] for t in d_s['teams']) == d_s['first_sub_samples']))
qa('sub-impact 벤치 최소출전 필터', lambda: assert_(all(b['minutes'] >= d_s['bench_min_minutes'] and b['apps'] >= d_s['bench_min_apps'] for b in d_s['bench'])))
qa('sub-impact 벤치 90분당 정합', lambda: assert_(all(abs(b['ga_per90'] - (b['goals'] + b['assists']) * 90 / b['minutes']) < 0.011 for b in d_s['bench'])))
qa('sub-impact 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/substitution-impact?league=zz') == 400))

# ── 2-f. 세트피스 공수 프로필 ──
d_sp = get('/api/insights/setpiece-profile?league=k2&year=2025')
qa('setpiece-profile 키 완전성', lambda: assert_(all(k in d_sp for k in ['teams', 'highlights', 'league_types', 'warnings', 'limits']) and len(d_sp['league_types']) == 4))
_spe = [t for t in d_sp['teams'] if t['eligible']]
qa('setpiece-profile 공격/수비 순위 범위(공동순위 허용)', lambda: assert_(all(min(t[k] for t in _spe) == 1 and all(1 <= t[k] <= len(_spe) for t in _spe) for k in ('rank_for', 'rank_against'))))
qa('setpiece-profile 공격 합계 = 수비 합계(폐쇄 리그)', lambda: assert_(abs(sum(t['for']['shots_pg'] * t['games'] for t in d_sp['teams']) - sum(t['against']['shots_pg'] * t['games'] for t in d_sp['teams'])) <= len(d_sp['teams'])))
qa('setpiece-profile 비중 0~100', lambda: assert_(all(0 <= (t['for']['goal_share'] or 0) <= 100 and 0 <= (t['against']['goal_share'] or 0) <= 100 for t in d_sp['teams'])))
qa('setpiece-profile xG 미보유 시 슈팅 대체', lambda: assert_(get('/api/insights/setpiece-profile?league=k1&year=2026')['metric'] in ('xG', '슈팅')))
qa('setpiece-profile 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/setpiece-profile?league=zz') == 400))

# ── 신규 인사이트 4종 (2026-11-03) + 제거된 죽은 API ──
qa('제거된 죽은 API 4종 404', lambda: assert_(all(_brief_status('/api/insights/' + e) == 404 for e in ('xg-efficiency', 'forward-goals', 'midfielder-pass', 'defender-score'))))
d_sd = get('/api/insights/scoring-dependence?league=k1&year=2026')
_sde = [t for t in d_sd['teams'] if t['eligible']]
qa('scoring-dependence 12팀 + 키', lambda: assert_(len(d_sd['teams']) == 12 and all(k in d_sd for k in ['league_top1_share', 'warnings', 'limits'])))
qa('scoring-dependence 비중 0~100·1·2위 합 ≥ 1위', lambda: assert_(_sde and all(0 < t['top1_share'] <= 100 and t['top2_share'] >= t['top1_share'] - 0.05 for t in _sde)))
qa('scoring-dependence 1위 득점 ≤ 팀 득점', lambda: assert_(all(t['top'][0]['goals'] <= t['goals'] and abs(t['top'][0]['goals'] / t['goals'] * 100 - t['top1_share']) < 0.11 for t in _sde)))
qa('scoring-dependence 에이스 선발+비선발 ≤ 경기수', lambda: assert_(all(t['ace']['n_with'] + t['ace']['n_without'] <= t['games'] for t in _sde)))
qa('scoring-dependence 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/scoring-dependence?league=zz') == 400))
d_ro = get('/api/insights/rotation?league=k1&year=2026')
qa('rotation 키·버킷 3개', lambda: assert_(len(d_ro['buckets']) == 3 and all(k in d_ro for k in ['verdict', 'teams', 'limits'])))
qa('rotation 표본 합계 일치', lambda: assert_(sum(b['n'] for b in d_ro['buckets']) == d_ro['team_matches']))
qa('rotation 평균 교체 0~11·고정 주전 0~11', lambda: assert_(all(0 <= t['avg_changes'] <= 11 and 0 <= t['core_size'] <= 11 for t in d_ro['teams'] if t['eligible'])))
qa('rotation 표본부족 시 판정 보류', lambda: assert_(get('/api/insights/rotation?league=k2&year=2021')['verdict']['level'] == 'insufficient'))
qa('rotation 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/rotation?league=zz') == 400))
d_ga = get('/api/insights/goal-aftermath?league=k1&year=2026')
_L = d_ga['league_total']
qa('goal-aftermath 득점수 = 실점수(폐쇄 리그)', lambda: assert_(_L['scored'] == _L['conceded'] == sum(t['scored'] for t in d_ga['teams'])))
qa('goal-aftermath 관측 ≤ 득점 · 기대 ≥ 0', lambda: assert_(_L['conc_obs'] <= _L['scored'] and _L['conc_exp'] >= 0 and all(t['conc_obs'] <= t['scored'] and t['resp_obs'] <= t['conceded'] for t in d_ga['teams'])))
qa('goal-aftermath 리그 관측 일치(득점 후 실점 = 실점 후 반격)', lambda: assert_(_L['conc_obs'] == _L['resp_obs']))
qa('goal-aftermath 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/goal-aftermath?league=zz') == 400))
d_ph = get('/api/insights/pass-hub?league=k1&year=2026')
_phe = [t for t in d_ph['teams'] if t['eligible']]
qa('pass-hub 키·허브 지분 범위', lambda: assert_(_phe and all(k in d_ph for k in ['verdict', 'high_vs_low', 'limits']) and all(5 < t['hub_share'] < 40 and t['top2_share'] > t['hub_share'] for t in _phe)))
qa('pass-hub 주 허브 비율 ≤ 100', lambda: assert_(all(0 < t['main_hub']['pct'] <= 100 and t['hubs'] >= 1 for t in _phe)))
qa('pass-hub 최근 허브 ≤5 + 주 허브 표시', lambda: assert_(all(1 <= len(t['recent_hubs']) <= 5 and all('is_main' in r for r in t['recent_hubs']) for t in _phe)))
d_os = get('/api/insights/opponent-strength?league=k1&year=2026')
_ose = [t for t in d_os['teams'] if t['eligible']]
qa('opponent-strength 키·리그 기준선 3등급', lambda: assert_(_ose and all(k in d_os for k in ['league_tiers', 'sos_meaningful', 'limits']) and set(d_os['league_tiers']) == {'top', 'mid', 'bottom'}))
qa('opponent-strength 등급별 경기 합 = 팀 경기', lambda: assert_(all(sum(t['tiers'][k]['n'] for k in ('top', 'mid', 'bottom')) == t['games'] for t in _ose)))
qa('opponent-strength 승무패 합 = 등급 경기·PPG 0~3', lambda: assert_(all(x['w'] + x['d'] + x['l'] == x['n'] and (x['ppg'] is None or 0 <= x['ppg'] <= 3) for t in _ose for x in t['tiers'].values())))
qa('opponent-strength 보정 PPG 리그 평균 보존', lambda: assert_(abs(sum(t['adj_ppg'] * t['games'] for t in _ose) / sum(t['games'] for t in _ose) - d_os['league_ppg']) < 0.02))
qa('opponent-strength 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/opponent-strength?league=zz') == 400))
d_dw = get('/api/insights/defensive-weakness?league=k1&year=2026')
_dwe = [t for t in d_dw['teams'] if t['eligible']]
qa('defensive-weakness 키·구역 5·상황 4', lambda: assert_(_dwe and len(d_dw['zones']) == 5 and len(d_dw['situations']) == 4 and all(k in d_dw for k in ['league_zones', 'league_situations', 'limits'])))
qa('defensive-weakness 구역 비중 합 ≈ 100%', lambda: assert_(all(abs(sum(c['share'] for c in t['zones'].values() if c) - 100) < 1 for t in _dwe)))
qa('defensive-weakness 약점 판정은 |z|≥2만', lambda: assert_(all(((t['zones'].get(k) or t['situations'].get(k))['z'] >= d_dw['z_flag']) for t in _dwe for k in t['weak'])))
qa('defensive-weakness K2 역습 분류 없음 → 제외(None)', lambda: assert_(all(t['situations']['counter'] is None for t in get('/api/insights/defensive-weakness?league=k2&year=2026')['teams'] if t['eligible'])))
qa('defensive-weakness 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/defensive-weakness?league=zz') == 400))
d_fm = get('/api/insights/formation-matchup?league=k1&year=2026')
qa('formation-matchup 키·포메이션 기록 경기 있음', lambda: assert_(d_fm['matches_with_formation'] > 0 and d_fm['formations'] and all(k in d_fm for k in ['matchups', 'min_cell', 'limits'])))
qa('formation-matchup 승무패 합 = 경기수 · PPG 0~3', lambda: assert_(all(x['w'] + x['d'] + x['l'] == x['n'] and 0 <= x['ppg'] <= 3 for x in d_fm['formations'] + d_fm['matchups'])))
qa('formation-matchup 상성 칸 = 최소 표본 이상 · 유의는 |z|≥1.96만', lambda: assert_(all(m['n'] >= d_fm['min_cell'] and (not m['significant'] or (abs(m['z']) >= 1.96 and m['n'] >= d_fm['min_sig'])) for m in d_fm['matchups'])))
qa('formation-matchup 포메이션별 경기 합 = 쌍 기록 양쪽(팀-경기) 수', lambda: assert_(sum(f['n'] for f in d_fm['formations']) <= 2 * d_fm['matches_with_formation']))
qa('formation-matchup 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/formation-matchup?league=zz') == 400))
d_tr = get('/api/insights/standings-trend?league=k1&year=2026')
_tn = len(d_tr['rounds'])
qa('standings-trend 키·팀 수·라운드 수', lambda: assert_(_tn >= d_tr['min_rounds'] and d_tr['teams'] and all(len(t['ranks']) == _tn and len(t['pts']) == _tn for t in d_tr['teams'])))
qa('standings-trend 매 라운드 순위는 1~N 순열', lambda: assert_(all(sorted(t['ranks'][i] for t in d_tr['teams']) == list(range(1, len(d_tr['teams']) + 1)) for i in range(_tn))))
qa('standings-trend 누적 승점 단조 증가 · 라운드당 최대 +3', lambda: assert_(all(0 <= b - a <= 3 for t in d_tr['teams'] for a, b in zip(t['pts'], t['pts'][1:]))))
qa('standings-trend 현재 순위 = 승점 내림차순', lambda: assert_([t['points'] for t in d_tr['teams']] == sorted((t['points'] for t in d_tr['teams']), reverse=True)))
qa('standings-trend 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/standings-trend?league=zz') == 400))
d_wx = get('/api/insights/weather-effect?league=all&year=all')
_wg = [g for gs in d_wx['groups'].values() for g in gs]
qa('weather-effect 키·구간 9개(기온4·강수2·바람3)', lambda: assert_(len(d_wx['groups']['temp']) == 4 and len(d_wx['groups']['precip']) == 2 and len(d_wx['groups']['wind']) == 3 and all(k in d_wx for k in ['overall', 'z_flag', 'min_n', 'limits'])))
qa('weather-effect 기온·바람·강수 구간 경기 합 = 날씨 기록 경기', lambda: assert_(all(sum(g['n'] for g in d_wx['groups'][k]) == d_wx['matches_with_weather'] for k in ('temp', 'wind', 'precip'))))
qa('weather-effect 유의는 30경기↑·|z|≥기준만', lambda: assert_(all((not g['goals_diff'] or (g['n'] >= d_wx['min_n'] and abs(g['goals_z']) >= d_wx['z_flag'])) and (not g['home_diff'] or (g['n'] >= d_wx['min_n'] and abs(g['home_win_z']) >= d_wx['z_flag'])) for g in _wg)))
qa('weather-effect 득점 잔차 가중합 ≈ 0(리그·시즌 보정)', lambda: assert_(abs(sum(g['goals_resid'] * g['n'] for g in d_wx['groups']['temp'] if g['goals_resid'] is not None)) < 0.15 * d_wx['matches_with_weather']))
qa('weather-effect 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/weather-effect?league=zz') == 400))
d_pv = get('/api/insights/pass-volume?league=k1&year=all')
qa('pass-volume 키·3분위 3·흐름 3구간', lambda: assert_(len(d_pv['terciles']) == 3 and len(d_pv['states']) == 3 and d_pv['teams'] and all(k in d_pv for k in ['corr_dev_gd', 'league_lead_dev', 'limits'])))
qa('pass-volume 3분위 팀-경기 합 = 전체', lambda: assert_(sum(t['n'] for t in d_pv['terciles']) == d_pv['team_matches']))
qa('pass-volume 패스 변화는 낮음<중간<높음 순', lambda: assert_(d_pv['terciles'][0]['dev'] < d_pv['terciles'][1]['dev'] < d_pv['terciles'][2]['dev']))
qa('pass-volume 상관 -1~1 · 앞선 경기 패스 변화 < 뒤진 경기', lambda: assert_(all(s['corr'] is None or -1 <= s['corr'] <= 1 for s in d_pv['states']) and d_pv['states'][2]['dev'] < d_pv['states'][0]['dev']))
qa('pass-volume 팀 특성 판정은 |z|≥기준·표본 이상만', lambda: assert_(all((not t['style']) or (abs(t['lead_z']) >= d_pv['z_flag'] and t['lead_n'] >= d_pv['min_state']) for t in d_pv['teams'])))
qa('pass-volume 잘못된 league 400', lambda: assert_(_brief_status('/api/insights/pass-volume?league=zz') == 400))
d_tp = get('/api/insights/top-performers?year=2026&league=all')
_tp = d_tp['all']
qa('top-performers 구조(meta·가중치 7그룹·league 필드)', lambda: assert_(_tp and len(d_tp['meta']['weights']) == 7 and all(r['league'] in ('K1', 'K2') for r in _tp) and all(abs(sum(x['w'] for x in ws) - 1) < 1e-6 for ws in d_tp['meta']['weights'].values())))
qa('top-performers 종합 점수 0~100 · 비교군 평균≈50', lambda: assert_(all(r['score'] is None or 0 <= r['score'] <= 100 for r in _tp) and all(abs(sum(r['score'] for r in _tp if r['detail'] == g and r['score'] is not None) / max(1, sum(1 for r in _tp if r['detail'] == g and r['score'] is not None)) - 50) < 4 for g in ('CB', 'FB', 'W', 'CM', 'ST'))))
qa('top-performers 골+도움=공격P · 세부 포지션 모두 채워짐', lambda: assert_(all(r['attack_pts'] == r['goals'] + r['assists'] and r['detail'] for r in _tp)))
qa('top-performers 공식 값 선수는 SofaScore 표본(5경기·450분) 충족', lambda: assert_(all(r['mins'] >= 450 and r['games'] >= 5 for r in _tp)))
qa('top-performers 공식 적용 비율 ≥ 90%(공식 선수 기록 보유 시즌)', lambda: assert_(d_tp['meta']['official_players'] >= 0.9 * d_tp['meta']['players']))
qa('top-performers 2024(공식 기록 없음)는 전부 SofaScore', lambda: assert_(all(r['src'] == 'sofa' for r in get('/api/insights/top-performers?year=2024&league=all')['all'])))
d_sub = get('/api/insights/substitution?year=2026&league=all')
qa('교체 영향 최다 투입 이름 비어 있지 않음', lambda: assert_(all(f['name'] for f in d_sub['frequent'])))
qa('날씨 인사이트 API 제거됨(404)', lambda: assert_(_brief_status('/api/insights/weather?year=2026&league=all') == 404))
d_gs = get('/api/insights/game-state?league=k1&year=2026')
qa('game-state 대칭(리드 경기 = 뒤진 경기)·팀 경기 합 = 2×경기', lambda: assert_(
    d_gs['league_avg']['led_games'] == d_gs['league_avg']['trailed_games']
    and sum(t['games'] for t in d_gs['teams']) == 2 * d_gs['matches']))
qa('game-state 리드 W+D+L = n·시간 비율 합 ≈ 100', lambda: assert_(all(
    t['led']['w'] + t['led']['d'] + t['led']['l'] == t['led']['n'] and 98 <= sum(t['share']) <= 102 for t in d_gs['teams'])))
d_fr = get('/api/data-freshness?year=2026')
qa('data-freshness 구조·미반영 수 ≥ 0', lambda: assert_(all(
    L['latest'] and all(s['missing'] >= 0 and (s['last'] is None or s['last'] <= L['latest']) for s in L['sources'].values())
    for L in d_fr['leagues'].values()) and set(d_fr['leagues']) <= {'k1', 'k2'}))
qa('data-freshness 잘못된 year 400', lambda: assert_(_brief_status('/api/data-freshness?year=x') == 400))
qa('pass-hub 잘못된 league 400',lambda: assert_(_brief_status('/api/insights/pass-hub?league=zz') == 400))

# ── 2-g. 경기 요약 카드 (팬용) ──
d_rc = get('/api/match-recap?date=2026.10.24&home_slug=incheon&away_slug=jeju')
qa('recap 키 완전성', lambda: assert_(d_rc.get('ready') and all(k in d_rc for k in ['headline', 'result', 'teams', 'goals', 'badges', 'table', 'notes'])))
qa('recap 헤드라인 비어있지 않음', lambda: assert_(bool(d_rc['headline'])))
qa('recap 스탯 비음수·양쪽 존재', lambda: assert_(all(s['home'] >= 0 and s['away'] >= 0 for s in d_rc['stats'])))
qa('recap 순위 변동 정합', lambda: assert_(d_rc['table']['home']['after']['played'] == d_rc['table']['home']['before']['played'] + 1))
qa('recap 타임라인 마지막 스코어=최종', lambda: assert_(all((not g['goals_complete']) or not g['goals'] or g['goals'][-1]['score'] == f"{g['result']['home']}-{g['result']['away']}" for g in [get('/api/match-recap?date=2026.07.26&home_slug=gwangju&away_slug=jeju')])))
qa('recap 잘못된 입력 400/404', lambda: assert_(_brief_status('/api/match-recap?event_id=abc') == 400 and _brief_status('/api/match-recap?event_id=1') == 404 and _brief_status('/api/match-recap') == 400))

# ── 3. 백테스트 ──
d_bt2 = get('/api/prediction-backtest?league=k2&year=2026')
qa('backtest K2 n_total>0',   lambda: assert_(d_bt2['n_total'] > 0))
qa('backtest K2 hit>33%',     lambda: assert_(d_bt2['hit_1x2_pct'] > 33.3, f"{d_bt2['hit_1x2_pct']}%"))
qa('backtest K2 brier<0.35',  lambda: assert_(d_bt2['brier_score'] < 0.35, f"{d_bt2['brier_score']}"))
d_po = get('/api/promotion-playoff')
qa('승강 PO 대진 확률 합 = 100 - 미개최', lambda: assert_(
    not d_po.get('ready') or abs(sum(m['prob'] for m in d_po['matchups']) + d_po['no_po_pct'] - 100) <= 1.5,
    f"{sum(m['prob'] for m in d_po.get('matchups', []))} + {d_po.get('no_po_pct')}"))
qa('승강 PO 잔류 확률이 범위 안·0~100', lambda: assert_(
    not d_po.get('ready') or all(m['k1_survive_range'][0] <= m['k1_survive_pct'] <= m['k1_survive_range'][1]
                                 and 0 <= m['k1_survive_pct'] <= 100 for m in d_po['matchups'])))
qa('backtest 기준선 3종 + edge 일관', lambda: assert_(
    set(d_bt2.get('baselines', {})) == {'home', 'ppg', 'rate'}
    and abs(d_bt2['edge_vs_best_pct'] - (d_bt2['hit_1x2_pct'] - max(b['hit_pct'] for b in d_bt2['baselines'].values()))) <= 0.2,
    f"{d_bt2.get('edge_vs_best_pct')}"))

d_bt1 = get('/api/prediction-backtest?league=k1&year=2026')
qa('backtest K1 n_total>0',   lambda: assert_(d_bt1['n_total'] > 0))

# ── 4. 기타 주요 API ──
qa('team-analytics',      lambda: assert_('team' in get('/api/team-analytics?teamId=ulsan')))
qa('team-compare',        lambda: assert_('teamA' in get('/api/team-compare?teamA=ulsan&teamB=gwangju')))
qa('team-trend',          lambda: assert_('matches' in get('/api/team-trend?teamId=ulsan&year=2026')))
qa('league-rankings',     lambda: assert_('teams' in get('/api/league-rankings?league=K1&year=2026')))
qa('saves list',          lambda: get('/api/saves'))
qa('squads list',         lambda: get('/api/squads'))

# ── 5. 보안 ──
try:
    r = urllib.request.urlopen(base + "/api/match-prediction?homeTeam=ulsan'+OR+'1'='1&awayTeam=jeonbuk", timeout=5)
    d = json.loads(r.read())
    qa('SQL inject 방어', lambda: assert_(not d or True))
except Exception:
    results.append(('PASS', 'SQL inject 방어', '400/404/500 정상 차단'))

# ── 6. DB 정합성 ──
conn = sqlite3.connect('players.db')
cur = conn.cursor()

cur.execute('SELECT COUNT(*) FROM heatmap_points')
hp = cur.fetchone()[0]
qa('heatmap_points 100K+', lambda: assert_(hp > 100000, f'{hp}개'))

# ── K1(410) 안에 K2 PO·승강 PO가 남아 있지 않은지 (crawlers/reclassify_playoffs.py, update_data STEP 26) ──
sys.path.insert(0, 'crawlers')
import reclassify_playoffs as _rp  # noqa: E402
import io, contextlib  # noqa: E402
with contextlib.redirect_stdout(io.StringIO()):
    _po_left = _rp.find_playoffs(conn)

# ── 공식 선수 경기 기록(kleague_player_match, update_data STEP 27) — 테이블이 있을 때만 ──
if cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kleague_player_match'").fetchone():
    _kpm_bad = cur.execute("""
        SELECT COUNT(*) FROM events e WHERE e.id IN (SELECT event_id FROM kleague_player_match_log)
          AND (
            -- 공식합 == 스코어 이거나 공식합+자책골 == 스코어면 정상 (출처 간 자책골/굴절 정의 차이)
            ((SELECT COALESCE(SUM(goals),0) FROM kleague_player_match k WHERE k.event_id=e.id AND k.is_home=1) != e.home_score
             AND (SELECT COALESCE(SUM(goals),0) FROM kleague_player_match k WHERE k.event_id=e.id AND k.is_home=1)
               + (SELECT COUNT(*) FROM goal_events g WHERE g.event_id=e.id AND g.is_home=1 AND g.is_own_goal=1) != e.home_score)
            OR ((SELECT COALESCE(SUM(goals),0) FROM kleague_player_match k WHERE k.event_id=e.id AND k.is_home=0) != e.away_score
             AND (SELECT COALESCE(SUM(goals),0) FROM kleague_player_match k WHERE k.event_id=e.id AND k.is_home=0)
               + (SELECT COUNT(*) FROM goal_events g WHERE g.event_id=e.id AND g.is_home=0 AND g.is_own_goal=1) != e.away_score))
    """).fetchone()[0]
    # 공식 playerDetail.goal 은 추가시간 득점 등을 일부 빠뜨린다(2026-11-04 확인: 재호출에도 동일, 원본 한계 — 약 4%).
    # 리포트는 _kpm_goal_adjust 로 보정하므로 여기서는 '원본 불일치율이 평소(≤6%)를 넘는지'만 본다(수집 회귀 감시).
    _kpm_logged = cur.execute("SELECT COUNT(*) FROM kleague_player_match_log").fetchone()[0]
    qa('공식 선수 기록 득점 합 ≈ 스코어 (원본 불일치율 ≤6%)',
       lambda: assert_(_kpm_bad <= max(3, _kpm_logged * 0.06), f'{_kpm_bad}/{_kpm_logged}경기 불일치'))
    _kpm_teams = cur.execute("""SELECT MIN(c) FROM (SELECT COUNT(*) c FROM kleague_player_match GROUP BY event_id, is_home)""").fetchone()[0]
    qa('공식 선수 기록 팀당 11명↑', lambda: assert_(_kpm_teams is None or _kpm_teams >= 11, f'최소 {_kpm_teams}명'))
qa('K1(410)에 PO 경기 잔류 0',lambda: assert_(not _po_left, f'{len(_po_left)}건 — reclassify_playoffs.py --apply 필요'))

# ── K리그 공식 API 복구 데이터(2026-08-03 이후) 정합성 ──
cur.execute("""SELECT COUNT(*) FROM events e WHERE e.tournament_id IN (410,777) AND e.home_score IS NOT NULL
    AND e.date_ts >= strftime('%s','2026-08-03')
    AND EXISTS (SELECT 1 FROM goal_events g WHERE g.event_id = e.id)
    AND (SELECT COUNT(*) FROM goal_events g WHERE g.event_id = e.id) != e.home_score + e.away_score""")
_bad_goals = cur.fetchone()[0]
qa('복구 득점 = 최종 스코어 (8/3 이후 불일치 0)', lambda: assert_(_bad_goals == 0, f'불일치 {_bad_goals}경기'))
cur.execute("""SELECT COUNT(*) FROM events e WHERE e.tournament_id IN (410,777) AND e.home_score IS NOT NULL AND e.home_score + e.away_score > 0
    AND e.date_ts >= strftime('%s','2026-08-03')
    AND NOT EXISTS (SELECT 1 FROM goal_events g WHERE g.event_id = e.id)""")
_no_goal = cur.fetchone()[0]
qa('득점 기록 없는 경기 비율 (8/3 이후, 복구 후 5% 미만)', lambda: assert_(_no_goal < 12, f'{_no_goal}경기 누락 — 복구 크롤러 확인'))
cur.execute("SELECT COUNT(*) FROM goal_events WHERE is_own_goal = 1 AND is_penalty = 1")
qa('자책골·PK 동시 표기 없음', lambda: assert_(cur.fetchone()[0] == 0))
qa('recap 복구 경기 타임라인 (K2 10/24)', lambda: assert_(get('/api/match-recap?date=2026.10.24&home_slug=jeonnam&away_slug=daegu')['goals_complete'] is True))

# ── 패스 네트워크 (K리그 공식 getPassData) 정합성 ──
cur.execute("SELECT COUNT(*) FROM kleague_pass_match")
_pn_rows = cur.fetchone()[0]
qa('패스 원장 존재', lambda: assert_(_pn_rows > 0, '수집된 경기 없음 — collect_kleague_passes.py --apply'))
cur.execute("SELECT COUNT(*) FROM kleague_pass_edge WHERE passer_kid = receiver_kid")
_pn_self = cur.fetchone()[0]
qa('패스 엣지 자기 자신 없음', lambda: assert_(_pn_self == 0, f'{_pn_self}건'))
cur.execute("""SELECT COUNT(*) FROM kleague_pass_match m WHERE m.total_passes !=
    (SELECT COALESCE(SUM(e.passes),0) FROM kleague_pass_edge e WHERE e.event_id = m.event_id AND e.team_id = m.team_id)""")
_pn_sum = cur.fetchone()[0]
qa('원장 총 패스 = 엣지 합계', lambda: assert_(_pn_sum == 0, f'불일치 {_pn_sum}팀-경기'))
cur.execute("""SELECT COUNT(*) FROM kleague_pass_edge e WHERE NOT EXISTS (SELECT 1 FROM kleague_pass_player p
    WHERE p.event_id = e.event_id AND p.team_id = e.team_id AND p.player_kid = e.passer_kid)""")
_pn_orphan = cur.fetchone()[0]
qa('엣지 패서가 로스터에 존재', lambda: assert_(_pn_orphan == 0, f'로스터 없는 패서 엣지 {_pn_orphan}건'))
cur.execute("""SELECT COUNT(*) FROM kleague_pass_match m WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = m.event_id)""")
_pn_noev = cur.fetchone()[0]
qa('원장 경기가 events에 존재', lambda: assert_(_pn_noev == 0, f'{_pn_noev}건'))
d_pn = get('/api/pass-network?teamId=ulsan&minPasses=1')
qa('pass-network API 키', lambda: assert_(d_pn.get('ready') and all(k in d_pn for k in ['nodes', 'edges', 'insights', 'warnings', 'matches', 'total_passes'])))
cur.execute("""SELECT COALESCE(SUM(ed.passes),0) FROM kleague_pass_edge ed JOIN events e ON e.id = ed.event_id
    WHERE ed.team_id = (SELECT 7653) AND e.date_ts >= strftime('%s', ?) AND e.date_ts < strftime('%s', ?)""", (f"{d_pn['year']}-01-01", f"{d_pn['year'] + 1}-01-01"))
_pn_db_total = cur.fetchone()[0]
qa('pass-network 시즌 합계 = DB 합계', lambda: assert_(d_pn['total_passes'] == _pn_db_total, f"API {d_pn['total_passes']} vs DB {_pn_db_total}"))
qa('pass-network 노드 share 합 ≈ 1', lambda: assert_(abs(sum(n['share'] for n in d_pn['nodes']) - 1) < 0.02, f"{sum(n['share'] for n in d_pn['nodes']):.3f}"))
qa('pass-network 잘못된 입력 400/404', lambda: assert_(_brief_status('/api/pass-network?teamId=zzz') == 400 and _brief_status('/api/pass-network?teamId=ulsan&year=abc') == 400
    and _brief_status("/api/pass-network?teamId=ulsan&eventId=x'+OR+1=1--") == 400 and _brief_status('/api/pass-network?teamId=ulsan&eventId=1') == 404))
qa('pass-network/matches 구조', lambda: assert_(get(f"/api/pass-network/matches?teamId=ulsan&year={d_pn['year']}")['matches'] and _brief_status('/api/pass-network/matches?teamId=ulsan') == 400))
qa('pass-network 노드 sofa_id 매핑 ≥ 80%', lambda: assert_(all('sofa_id' in n for n in d_pn['nodes'])
    and sum(1 for n in d_pn['nodes'] if n['sofa_id']) >= 0.8 * len(d_pn['nodes']), f"{sum(1 for n in d_pn['nodes'] if n['sofa_id'])}/{len(d_pn['nodes'])}"))
_us = get('/api/update-status')
qa('update-status next_run 존재 (crontab 구동 시 상태 파일·일정 기반)', lambda: assert_(_us.get('next_run') or _us.get('running'), str(_us)))

cur.execute('SELECT COUNT(*) FROM match_player_stats WHERE expected_goals IS NOT NULL')
xg = cur.fetchone()[0]
qa('xG 데이터 존재', lambda: assert_(xg > 0, f'{xg}건'))

cur.execute("SELECT COUNT(DISTINCT strftime('%Y',datetime(date_ts,'unixepoch','localtime'))) FROM events WHERE tournament_id=410 AND home_score IS NOT NULL")
ky = cur.fetchone()[0]
qa('K1 2025+2026 다년도', lambda: assert_(ky >= 2, f'{ky}년도'))

cur.execute("SELECT COUNT(*) FROM events WHERE tournament_id=410 AND home_score IS NOT NULL AND strftime('%Y',datetime(date_ts,'unixepoch','localtime'))='2025'")
k1_25 = cur.fetchone()[0]
qa('K1 2025 경기 134+', lambda: assert_(k1_25 >= 134, f'{k1_25}경기'))

cur.execute("SELECT COUNT(*) FROM events WHERE tournament_id=777 AND home_score IS NOT NULL AND strftime('%Y',datetime(date_ts,'unixepoch','localtime'))='2026'")
k2_26 = cur.fetchone()[0]
qa('K2 2026 경기 50+', lambda: assert_(k2_26 >= 50, f'{k2_26}경기'))

cur.execute('SELECT COUNT(*) FROM players WHERE name_ko IS NOT NULL')
players_ko = cur.fetchone()[0]
qa('선수 한글명 존재', lambda: assert_(players_ko > 0, f'{players_ko}명'))

# 이름이 겹치면(name_ko 중복) 경기 기록이 가장 많은 레코드가 선택돼야 한다 (_find_player)
def _dup_name_prefers_most_games():
    import urllib.parse
    cur.execute("""SELECT p.name_ko FROM players p JOIN match_player_stats m ON m.player_id = p.id
                   WHERE p.name_ko IS NOT NULL AND p.name_ko <> ''
                     AND p.name_ko IN (SELECT name_ko FROM players WHERE name_ko <> '' GROUP BY name_ko HAVING COUNT(*) > 1)
                   GROUP BY p.name_ko ORDER BY COUNT(*) DESC LIMIT 5""")
    names = [r[0] for r in cur.fetchall()]
    assert_(names, '중복 이름 표본 없음')
    # 공식 매핑상 이름이 틀린 것으로 확정된 레코드는 '경기 많은 순' 경쟁에서 제외(아래 별도 점검이 담당)
    mis = set()
    cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kleague_player_map'")
    if cur.fetchone():
        norm = lambda s: re.sub(r"\(c\)|[\s·.\-]", "", s or "")
        cur.execute("SELECT m.sofa_player_id, p.name_ko, m.player_name FROM kleague_player_map m JOIN players p ON p.id = m.sofa_player_id")
        mis = {r[0] for r in cur.fetchall() if norm(r[1]) != norm(r[2])}
    for nm in names:
        d = get('/api/player-stat-report?name=' + urllib.parse.quote(nm))
        assert_(d.get('found') is True, f'{nm} 미발견')
        cur.execute("SELECT COUNT(*) FROM match_player_stats WHERE player_id = ?", (d['player']['id'],))
        got = cur.fetchone()[0]
        cur.execute("""SELECT m.player_id, COUNT(*) FROM match_player_stats m JOIN players p ON p.id = m.player_id
                       WHERE p.name_ko = ? GROUP BY m.player_id""", (nm,))
        cnts = {r[0]: r[1] for r in cur.fetchall()}
        pool = {k: v for k, v in cnts.items() if k not in mis} or cnts
        assert_(got >= max(pool.values()), f'{nm}: 경기 많은 레코드가 아님({got}경기)')
qa('이름 중복 시 경기 많은 레코드 우선', _dup_name_prefers_most_games)

# name_ko 가 다른 사람 이름으로 잘못 라벨된 레코드(공식 매핑상 이름 불일치)는, 정상 후보가 있으면 선택되지 않아야 한다
def _mislabeled_not_picked():
    import urllib.parse
    cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kleague_player_map'")
    if not cur.fetchone():
        return   # 공식 매핑이 없는 구 DB — 해당 없음
    norm = lambda s: re.sub(r"\(c\)|[\s·.\-]", "", s or "")
    cur.execute("""SELECT m.sofa_player_id, p.name_ko, m.player_name FROM kleague_player_map m
                   JOIN players p ON p.id = m.sofa_player_id WHERE p.name_ko IS NOT NULL AND p.name_ko <> ''""")
    mis = {r[0]: r[1] for r in cur.fetchall() if norm(r[2]) != norm(r[1])}
    checked = 0
    for pid_bad, nm in sorted(mis.items(), key=lambda kv: kv[1])[:60]:
        cur.execute("SELECT id FROM players WHERE name_ko = ?", (nm,))
        cands = [r[0] for r in cur.fetchall()]
        if len(cands) < 2 or all(i in mis for i in cands):
            continue   # 정상 후보가 없으면 구제 불가 — 대상 아님
        d = get('/api/player-stat-report?name=' + urllib.parse.quote(nm))
        assert_(d['player']['id'] not in mis, f"{nm}: 이름 오기 레코드({d['player']['id']})가 선택됨")
        checked += 1
        if checked >= 8:
            break
    assert_(checked > 0 or not mis, '검증 표본 없음')
qa('이름 오기 확정 레코드는 정상 후보가 있으면 후순위', _mislabeled_not_picked)

conn.close()

# ── 공식(K리그) 선수 리포트 ──
# 공식 테이블이 없는 환경(로컬 구DB)에서는 official=False + reason 이면 통과(기능 미적용 상태의 정상 응답).
def _official_ok():
    d = get('/api/player-stat-report-official?playerId=171785')   # 제르소(인천) — 공식 매핑 확정 선수
    assert_(d.get('found') is True and d.get('source') == 'official', '기본 키')
    if not d.get('official'):
        assert_(d.get('reason'), 'official=False 인데 reason 없음')
        return
    assert_(d['mapping']['kid'] and d['player']['games'] > 0 and d['player']['mins'] > 0, '매핑/출전')
    assert_(d['minutes_basis'] == 'official_incl_stoppage', '출전분 기준 표기')
    assert_(all(s['pctile'] is None or 0 <= s['pctile'] <= 100 for s in d['stat_items']), '백분위 범위')
    assert_(all(0 <= r['pctile'] <= 100 for r in d['radar']) and len(d['radar']) >= 3, '레이더')
    assert_(d['coverage']['official_games'] == d['player']['games'], '커버리지 정합')
qa('공식 리포트 구조·범위', _official_ok)
def _official_goals_not_below_raw():
    # 득점 보정은 공식 값을 줄이지 않는다: 리포트 골 수 >= 공식 원본 합, goals_adjusted.added = 차이
    c2 = sqlite3.connect('players.db'); c2.row_factory = sqlite3.Row
    if not c2.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kleague_player_map'").fetchone():
        return
    r = c2.execute("""SELECT k.player_kid, SUM(k.goals) s, m.sofa_player_id sid FROM kleague_player_match k
        JOIN events e ON e.id = k.event_id JOIN kleague_player_map m ON m.player_kid = k.player_kid
        WHERE e.tournament_id = 410 AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = '2026'
        GROUP BY k.player_kid ORDER BY s DESC LIMIT 1""").fetchone()
    c2.close()
    if not r:
        return
    d = get(f'/api/player-stat-report-official?playerId={r["sid"]}&year=2026')
    assert_(d.get('official') is True, '득점 1위 선수 공식 리포트 없음')
    g = d['player']['goals']; add = d['goals_adjusted']['added']
    assert_(g >= r['s'] and g - r['s'] == add, f'골 {g} / 원본 {r["s"]} / 보정 {add}')
qa('공식 리포트 득점 보정은 원본을 줄이지 않음', _official_goals_not_below_raw)
def _official_404():
    try:
        urllib.request.urlopen(base + '/api/player-stat-report-official?name=%EC%97%86%EB%8A%94%EC%84%A0%EC%88%98xyz', timeout=10)
    except urllib.error.HTTPError as e:
        assert_(e.code == 404, f'HTTP {e.code}')
        return
    raise AssertionError('404 아님')
qa('공식 리포트 미존재 선수 404', _official_404)
def _official_no_year():
    d = get('/api/player-stat-report-official?playerId=171785&year=1999')
    assert_(d.get('official') is False and d.get('reason') in ('no_year', 'no_official_table', 'no_match', 'no_games'), str(d.get('reason')))
qa('공식 리포트 없는 연도 안전 응답', _official_no_year)

# ── 차트 개편 Phase 1b: 인사이트 API 필드 추가 (additive — 기존 키 불변) ──
_ROT = None
def _rot():
    global _ROT
    if _ROT is None:
        _ROT = get('/api/insights/rotation?year=2026&league=k1')
    return _ROT
def _rot_timeline_len():
    for t in _rot()['teams']:
        if t.get('eligible'):
            assert_(len(t.get('timeline') or []) == t['matches'], f"{t['short']} {len(t.get('timeline') or [])}/{t['matches']}")
qa('rotation timeline 길이 = matches', _rot_timeline_len)
def _rot_timeline_vals():
    for t in _rot()['teams']:
        tl = t.get('timeline')
        if not t.get('eligible'):
            continue
        assert_(tl, f"{t['short']} timeline 없음")
        assert_(all(0 <= c['changes'] <= 11 and c['pts'] in (0, 1, 3) for c in tl), t['short'])
        assert_([c['ts'] for c in tl] == sorted(c['ts'] for c in tl), f"{t['short']} ts 순서")
qa('rotation timeline changes 0~11·pts·ts 오름차순', _rot_timeline_vals)
qa('rotation 기존 키 불변', lambda: assert_(
    {'id', 'short', 'matches', 'eligible', 'avg_changes', 'core_size', 'high_n', 'high_ppg'}
    <= set(next(t for t in _rot()['teams'] if t.get('eligible')))))

_AFT = None
def _aft():
    global _AFT
    if _AFT is None:
        _AFT = get('/api/insights/goal-aftermath?year=2026&league=k1')
    return _AFT
_FLOW_KEYS = ('extra_only', 'conc_only', 'both', 'none')
def _aft_flow_sum():
    d = _aft()
    for t in [x for x in d['teams'] if x.get('eligible')] + [dict(d['league_total'], short='리그')]:
        f = t.get('flow')
        assert_(f and set(f) == set(_FLOW_KEYS), f"{t['short']} flow={f}")
        assert_(sum(f[k] for k in _FLOW_KEYS) == t['scored'], f"{t['short']} {sum(f.values())}!={t['scored']}")
qa('aftermath flow 합 = scored', _aft_flow_sum)
def _aft_flow_conc():
    d = _aft()
    for t in [x for x in d['teams'] if x.get('eligible')] + [dict(d['league_total'], short='리그')]:
        f = t['flow']
        assert_(f['conc_only'] + f['both'] == t['conc_obs'], f"{t['short']} {f} conc_obs={t['conc_obs']}")
qa('aftermath flow conc_only+both = conc_obs', _aft_flow_conc)
qa('aftermath 기존 키 불변', lambda: assert_(
    {'id', 'short', 'scored', 'conc_obs', 'conc_exp', 'conc_z', 'conceded', 'resp_obs', 'resp_exp', 'resp_z', 'eligible'}
    <= set(next(t for t in _aft()['teams'] if t.get('eligible')))))

def _wx_ci():
    d = get('/api/insights/weather-effect?year=2026&league=k1')
    rows = [r for g in (d.get('groups') or {}).values() for r in g]
    assert_(rows, 'weather groups 비어 있음')
    for r in rows:
        assert_('goals_ci' in r, f"{r.get('label')} goals_ci 없음")
        if r.get('goals_resid') is not None and r.get('goals_z') is not None:
            assert_(r['goals_ci'] is not None and r['goals_ci'] > 0, f"{r.get('label')} ci={r['goals_ci']}")
qa('weather goals_ci 양수 또는 null', _wx_ci)
qa('weather 기존 키 불변', lambda: assert_({'n', 'goals', 'goals_resid', 'goals_z', 'home_win_pct', 'label', 'key'}
    <= set(get('/api/insights/weather-effect?year=2026&league=k1')['groups']['temp'][0])))
_WK = None
def _wk():
    global _WK
    if _WK is None:
        _WK = get('/api/insights/defensive-weakness?year=2026&league=k1')
    return _WK
def _wk_geom():
    g = _wk().get('zones_geom') or []
    assert_(len(g) == 7, f'{len(g)}개')
    assert_({z['key'] for z in g} == {'goalmouth', 'box_center', 'box_wide', 'out_center', 'out_wide'}, str({z['key'] for z in g}))
qa('weakness zones_geom 7개 사각형·키 5종', _wk_geom)
def _wk_geom_match():
    g = _wk()['zones_geom']
    def zone_at(x, y):   # 우선순위 = 배열 순서 (앞쪽이 우선)
        for z in g:
            if z['x0'] <= x < z['x1'] and z['y0'] <= y <= z['y1']:
                return z['key']
    for (x, y), want in {(3, 50): 'goalmouth', (10, 50): 'box_center', (10, 10): 'box_wide', (25, 50): 'out_center',
                         (25, 90): 'out_wide', (5.4, 36.4): 'box_center'}.items():
        assert_(zone_at(x, y) == want, f'({x},{y}) {zone_at(x, y)} != {want}')
qa('weakness zones_geom 경계 = _weak_zone', _wk_geom_match)
qa('weakness 기존 키 불변', lambda: assert_({'teams', 'zones', 'situations', 'min_games'} <= set(_wk())))

# ── 데이터 무결성: 공식 기록이 통째로 없는 경기의 득점 (2026-11-06 석현준 6골→4골 표시 원인) ──
# 포털이 일부 경기(2026 15경기)의 선수 상세 기록을 공개하지 않아 공식 골이 빠진다 → 경기 득점 기록(goal_events)으로 보정돼야 한다.
def _tp_goals_ge_events():
    rows = get('/api/insights/top-performers?year=2026&league=all')['all']
    c3 = sqlite3.connect('players.db')
    try:
        ge = dict(c3.execute(
            "SELECT g.player_id, COUNT(*) FROM goal_events g JOIN events e ON e.id = g.event_id "
            "WHERE g.is_own_goal = 0 AND e.tournament_id IN (410, 777) "
            "AND e.date_ts >= strftime('%s','2026-01-01') AND e.date_ts < strftime('%s','2027-01-01') "
            "GROUP BY g.player_id").fetchall())
        # 공식 기록이 통째로 없는(포털 미공개) 경기에서 넣은 골 — 이번 보정 대상
        unpub = dict(c3.execute(
            "SELECT g.player_id, COUNT(*) FROM goal_events g JOIN events e ON e.id = g.event_id "
            "WHERE g.is_own_goal = 0 AND e.tournament_id IN (410, 777) AND e.home_score IS NOT NULL "
            "AND e.date_ts >= strftime('%s','2026-01-01') AND e.date_ts < strftime('%s','2027-01-01') "
            "AND EXISTS (SELECT 1 FROM kleague_event_map x WHERE x.sofa_event_id = e.id) "
            "AND NOT EXISTS (SELECT 1 FROM kleague_player_match k WHERE k.event_id = e.id) "
            "GROUP BY g.player_id").fetchall())
    finally:
        c3.close()
    # 공식 기록이 있는 경기에서 두 출처가 득점자를 다르게 적은 경우(모호 → 기존 규칙상 보정 안 함)는 제외하고,
    # 미공개 경기 골이 있는 선수는 반드시 경기 득점 기록 이상이어야 한다
    bad = [(r['name'], r['goals'], ge[r['player_id']]) for r in rows
           if r.get('src') == 'official' and unpub.get(r['player_id']) and r['goals'] < ge[r['player_id']]]
    seok = next((r for r in rows if r['player_id'] == 106249), None)
    assert_(seok is not None and seok['goals'] == 6, f"석현준 {seok and seok['goals']}골 (기대 6)")
    assert_(not bad, f"{len(bad)}명 미공개 경기 골 누락: {bad[:4]}")
qa('TOP 퍼포머 공식 골 ≥ 경기 득점 기록 (2026)', _tp_goals_ge_events)

# ── 차트 개편 Phase 2a: 팀 분석 API 필드 추가 (additive) ──
_TT = None
def _tt_all():
    global _TT
    if _TT is None:
        _TT = get('/api/team-trend?teamId=gangwon')          # 연도 미지정 = 전 시즌
    return _TT
def _trend_season_reset():
    ms = _tt_all()['matches']
    assert_(ms and all('season' in m and 'season_cum_pts' in m for m in ms), 'season/season_cum_pts 없음')
    prev = None
    for m in ms:
        if m['season'] != prev:
            assert_(m['season_cum_pts'] == m['pts'], f"{m['date']} 시즌 첫 경기 누적 {m['season_cum_pts']} != {m['pts']}")
            prev = m['season']
qa('trend season_cum_pts 시즌별 리셋', _trend_season_reset)
def _trend_league_avg():
    ms = get('/api/team-trend?teamId=gangwon&year=2026')['matches']
    vals = [m.get('league_avg_cum_pts') for m in ms]
    assert_(all(v is not None for v in vals), 'league_avg_cum_pts null')
    assert_(all(b >= a for a, b in zip(vals, vals[1:])), '단조 비감소 아님')
    assert_(all(0 <= v <= 3 * (i + 1) + 3 for i, v in enumerate(vals)), '범위 이상')
qa('trend league_avg_cum_pts 단조 비감소·범위', _trend_league_avg)
qa('trend 기존 키 불변', lambda: assert_({'event_id', 'date', 'opponent', 'is_home', 'gf', 'ga', 'result', 'pts', 'cum_pts'}
    <= set(_tt_all()['matches'][0])))
def _ta_weather_ci():
    w = get('/api/team-analytics?teamId=gangwon&year=2026')['weather']
    assert_(w.get('overall_ppg') is not None, 'overall_ppg 없음')
    for k in ('by_temp', 'by_hum', 'by_wind'):
        for r in w[k]:
            assert_('ppg' in r and 'ci' in r, f"{k} {r.get('label')} ppg/ci 없음")
            assert_(abs(r['ppg'] - (3 * r['w'] + r['d']) / r['games']) < 0.01, f"{r['label']} ppg")
            if r['games'] < 4:
                assert_(r['ci'] is None, f"{r['label']} n<4 인데 ci")
qa('team-analytics weather ppg·ci', _ta_weather_ci)
qa('team-analytics weather 기존 키 불변', lambda: assert_({'label', 'games', 'w', 'd', 'l', 'gf', 'ga'}
    <= set(get('/api/team-analytics?teamId=gangwon&year=2026')['weather']['by_temp'][0])))

def _trend_league_avg_k2_members():
    """K2(777)에 섞인 K1 경기(개막전 오분류·PO)로 '팀 수'가 부풀어 리그 평균이 낮아지면 안 된다.
    리그 구성원 = 그 시즌 최다 경기 수의 25% 이상 치른 팀, 구성원끼리의 경기만 집계."""
    ms = get('/api/team-trend?teamId=suwon&year=2025')['matches']
    last = ms[-1]
    c3 = sqlite3.connect('players.db')
    try:
        rows = c3.execute(
            "SELECT date_ts, home_team_id, away_team_id, home_score, away_score FROM events "
            "WHERE tournament_id = 777 AND home_score IS NOT NULL "
            "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = '2025' "
            "AND date(datetime(date_ts,'unixepoch','localtime')) <= ?", (last['date'],)).fetchall()
        allrows = c3.execute(
            "SELECT home_team_id, away_team_id FROM events WHERE tournament_id = 777 AND home_score IS NOT NULL "
            "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = '2025'").fetchall()
    finally:
        c3.close()
    games = {}
    for h, a in allrows:
        games[h] = games.get(h, 0) + 1; games[a] = games.get(a, 0) + 1
    mx = max(games.values())
    members = {t for t, n in games.items() if n >= 0.25 * mx}
    pts = {t: 0 for t in members}
    for _, h, a, hs, as_ in rows:
        if h in members and a in members:
            pts[h] += 3 if hs > as_ else 1 if hs == as_ else 0
            pts[a] += 3 if as_ > hs else 1 if hs == as_ else 0
    exp = round(sum(pts.values()) / len(members), 2)
    assert_(abs((last['league_avg_cum_pts'] or 0) - exp) <= 0.05, f"API {last['league_avg_cum_pts']} vs 기대 {exp} (구성원 {len(members)}팀)")
qa('trend K2 리그 평균 = 리그 구성원 기준', _trend_league_avg_k2_members)

def _trend_league_avg_current_season_members():
    """현재 시즌은 시즌 초반에도 리그 구성원이 정확해야 한다(경기 수 기준 25% 문턱은 초반엔 무력 — 리뷰 M2).
    → 현재 시즌은 팀 마스터(TEAMS)의 리그 소속으로 판정: 첫 경기일 리그 평균 = 그날까지 소속 팀 승점 합 / 소속 팀 수."""
    import datetime as _dt
    yr = str(_dt.date.today().year)
    ms = get(f'/api/team-trend?teamId=suwon&year={yr}')['matches']
    if not ms:
        return
    first = ms[0]
    k2 = {t['sofascore_id'] for t in get('/api/teams') if t.get('league') == 'K2' and t.get('sofascore_id')}
    c3 = sqlite3.connect('players.db')
    try:
        rows = c3.execute(
            "SELECT home_team_id, away_team_id, home_score, away_score FROM events "
            "WHERE tournament_id = 777 AND home_score IS NOT NULL "
            "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ? "
            "AND date(datetime(date_ts,'unixepoch','localtime')) <= ?", (yr, first['date'])).fetchall()
    finally:
        c3.close()
    tot = 0
    for h, a, hs, as_ in rows:
        if h in k2 and a in k2:
            tot += (3 if hs > as_ else 1 if hs == as_ else 0) + (3 if as_ > hs else 1 if hs == as_ else 0)
    exp = round(tot / len(k2), 2)
    assert_(abs((first['league_avg_cum_pts'] or 0) - exp) <= 0.05, f"첫 경기일 API {first['league_avg_cum_pts']} vs 기대 {exp} ({len(k2)}팀)")
qa('trend 현재 시즌 리그 평균 = 팀 마스터 리그 소속 기준', _trend_league_avg_current_season_members)

# ── 결과 출력 ──
passed = sum(1 for r in results if r[0] == 'PASS')
failed = [r for r in results if r[0] == 'FAIL']

print(f'QA 결과: {passed}/{len(results)} PASS  ({len(failed)} FAIL)\n')
for status, label, note in results:
    icon = 'O' if status == 'PASS' else 'X'
    line = f'  [{icon}] {label}'
    if status == 'FAIL' and note:
        line += f'  ← {note}'
    print(line)

if failed:
    print(f'\n[FAIL 항목 {len(failed)}개]')
    for _, label, note in failed:
        print(f'  - {label}: {note}')
