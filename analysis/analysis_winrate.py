"""
구단별 승률 상관분석
A) 전체 경기 기반 상관분석
B) 수원삼성 단일팀 심층 분석
C) 2026 시즌 전체 팀 (team_stats + results 결합)
"""

import json
import sqlite3
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import stats
import warnings
warnings.filterwarnings('ignore')

# 한글 폰트 설정
import platform
if platform.system() == 'Windows':
    plt.rcParams['font.family'] = 'Malgun Gothic'
plt.rcParams['axes.unicode_minus'] = False

DB_PATH  = 'players.db'
BASE_DIR = '.'

# ─────────────────────────────────────────
# 공통: DB 연결 및 데이터 로드
# ─────────────────────────────────────────
conn = sqlite3.connect(DB_PATH)

df_raw = pd.read_sql_query("""
    SELECT
        mps.event_id,
        mps.team_id,
        mps.is_home,
        mps.result,
        mps.match_date,
        mps.temperature,
        mps.humidity,
        mps.wind_speed,
        mps.rating,
        mps.goals,
        mps.assists,
        mps.total_shots,
        mps.shots_on_target,
        mps.big_chances_missed,
        mps.expected_goals,
        mps.total_passes,
        mps.accurate_passes,
        mps.accurate_passes_pct,
        mps.key_passes,
        mps.accurate_long_balls,
        mps.total_long_balls,
        mps.accurate_crosses,
        mps.total_crosses,
        mps.successful_dribbles,
        mps.attempted_dribbles,
        mps.touches,
        mps.possession_lost,
        mps.tackles,
        mps.interceptions,
        mps.clearances,
        mps.blocked_shots,
        mps.duel_won,
        mps.duel_lost,
        mps.aerial_won,
        mps.aerial_lost,
        mps.was_fouled,
        mps.fouls,
        mps.yellow_cards,
        mps.red_cards
    FROM match_player_stats mps
    WHERE mps.result IS NOT NULL
""", conn)

# 경기-팀 단위로 집계
agg = df_raw.groupby(['event_id', 'team_id', 'is_home', 'result', 'match_date']).agg(
    temperature     = ('temperature', 'first'),
    humidity        = ('humidity', 'first'),
    wind_speed      = ('wind_speed', 'first'),
    avg_rating      = ('rating', 'mean'),
    goals           = ('goals', 'sum'),
    total_shots     = ('total_shots', 'sum'),
    shots_on_target = ('shots_on_target', 'sum'),
    big_chances_missed = ('big_chances_missed', 'sum'),
    xg              = ('expected_goals', 'sum'),
    pass_acc        = ('accurate_passes_pct', 'mean'),
    key_passes      = ('key_passes', 'sum'),
    long_ball_acc   = ('accurate_long_balls', 'sum'),
    total_long_balls= ('total_long_balls', 'sum'),
    accurate_crosses= ('accurate_crosses', 'sum'),
    successful_dribbles = ('successful_dribbles', 'sum'),
    touches         = ('touches', 'sum'),
    possession_lost = ('possession_lost', 'sum'),
    tackles         = ('tackles', 'sum'),
    interceptions   = ('interceptions', 'sum'),
    clearances      = ('clearances', 'sum'),
    duel_won        = ('duel_won', 'sum'),
    duel_lost       = ('duel_lost', 'sum'),
    aerial_won      = ('aerial_won', 'sum'),
    was_fouled      = ('was_fouled', 'sum'),
    fouls           = ('fouls', 'sum'),
    yellow_cards    = ('yellow_cards', 'sum'),
    red_cards       = ('red_cards', 'sum'),
    player_count    = ('rating', 'count'),
).reset_index()

# 파생 변수
agg['shot_acc']      = agg['shots_on_target'] / agg['total_shots'].replace(0, np.nan)
agg['duel_win_pct']  = agg['duel_won'] / (agg['duel_won'] + agg['duel_lost']).replace(0, np.nan)
agg['long_ball_pct'] = agg['long_ball_acc'] / agg['total_long_balls'].replace(0, np.nan)
agg['cross_ratio']   = agg['accurate_crosses'] / agg['touches'].replace(0, np.nan)

# 승점 (3=승, 1=무, 0=패) / result: 0=패, 1=무, 2=승
result_map = {0: 0, 1: 1, 2: 3}
win_map    = {0: 0, 1: 0, 2: 1}  # 이진 승/패
agg['points'] = agg['result'].map(result_map)
agg['win']    = agg['result'].map(win_map)

print(f"총 경기-팀 샘플: {len(agg)}행")
print(f"팀 수: {agg['team_id'].nunique()}")
print(f"result 분포: {agg['result'].value_counts().to_dict()}")


# ─────────────────────────────────────────
# A) 전체 경기 상관분석
# ─────────────────────────────────────────
print("\n" + "="*60)
print("A) 전체 경기 기반 상관분석")
print("="*60)

feature_cols = [
    'avg_rating', 'goals', 'total_shots', 'shots_on_target', 'shot_acc',
    'big_chances_missed', 'xg',
    'pass_acc', 'key_passes', 'long_ball_pct',
    'tackles', 'interceptions', 'clearances',
    'duel_win_pct', 'aerial_won',
    'fouls', 'yellow_cards',
    'temperature', 'humidity', 'wind_speed',
    'is_home',
]

feature_labels = {
    'avg_rating': '평균평점', 'goals': '득점', 'total_shots': '슈팅수',
    'shots_on_target': '유효슈팅', 'shot_acc': '슈팅정확도',
    'big_chances_missed': '빅찬스실패', 'xg': '기대골',
    'pass_acc': '패스정확도', 'key_passes': '키패스',
    'long_ball_pct': '롱볼성공률', 'tackles': '태클',
    'interceptions': '인터셉션', 'clearances': '클리어런스',
    'duel_win_pct': '듀얼승률', 'aerial_won': '공중볼승리',
    'fouls': '파울', 'yellow_cards': '경고',
    'temperature': '기온', 'humidity': '습도', 'wind_speed': '풍속',
    'is_home': '홈여부',
}

df_a = agg[feature_cols + ['points', 'win']].dropna(subset=['points'])

corr_results = []
for col in feature_cols:
    sub = df_a[[col, 'points']].dropna()
    if len(sub) < 10:
        continue
    r, p = stats.spearmanr(sub[col], sub['points'])
    corr_results.append({
        'feature': col,
        'label': feature_labels.get(col, col),
        'r': round(r, 3),
        'p': round(p, 4),
        'significant': 'O' if p < 0.05 else 'X',
        'n': len(sub),
    })

df_corr = pd.DataFrame(corr_results).sort_values('r', ascending=False)
print("\n[승점과의 Spearman 상관계수 순위]")
print(df_corr[['label', 'r', 'p', 'significant', 'n']].to_string(index=False))

# 시각화 A
fig, ax = plt.subplots(figsize=(10, 7))
colors = ['#2196F3' if r > 0 else '#F44336' for r in df_corr['r']]
bars = ax.barh(df_corr['label'], df_corr['r'], color=colors, alpha=0.8)
ax.axvline(0, color='black', linewidth=0.8)
for bar, sig in zip(bars, df_corr['significant']):
    x = bar.get_width()
    ax.text(x + (0.005 if x >= 0 else -0.005), bar.get_y() + bar.get_height()/2,
            sig, va='center', ha='left' if x >= 0 else 'right', fontsize=9)
ax.set_xlabel('Spearman r (승점과의 상관)')
ax.set_title('A) 전체 경기 - 각 지표와 승점의 상관계수', fontsize=13, fontweight='bold')
ax.set_xlim(-0.8, 0.8)
plt.tight_layout()
plt.savefig('analysis_A_correlation.png', dpi=150)
plt.close()
print("\n→ analysis_A_correlation.png 저장")


# ─────────────────────────────────────────
# B) 수원삼성 단일팀 심층 분석 (team_id=7652)
# ─────────────────────────────────────────
print("\n" + "="*60)
print("B) 수원삼성 단일팀 심층 분석")
print("="*60)

df_b = agg[agg['team_id'] == 7652].copy()
print(f"수원삼성 경기 수: {len(df_b)}")
print(f"홈: {df_b['is_home'].sum()} / 원정: {(~df_b['is_home'].astype(bool)).sum()}")
print(f"승: {(df_b['result']==2).sum()} 무: {(df_b['result']==1).sum()} 패: {(df_b['result']==0).sum()}")

# 홈/원정 분리 상관
for label, subset in [('전체', df_b), ('홈', df_b[df_b['is_home']==1]), ('원정', df_b[df_b['is_home']==0])]:
    corr_b = []
    for col in feature_cols:
        if col == 'is_home':
            continue
        sub = subset[[col, 'points']].dropna()
        if len(sub) < 5:
            continue
        r, p = stats.spearmanr(sub[col], sub['points'])
        corr_b.append({'feature': feature_labels.get(col, col), 'r': round(r, 3), 'p': round(p, 4)})
    df_cb = pd.DataFrame(corr_b).sort_values('r', ascending=False)
    print(f"\n[수원삼성 {label} - 상위 5개 / 하위 3개]")
    print(pd.concat([df_cb.head(5), df_cb.tail(3)]).to_string(index=False))

# 홈/원정 날씨 영향 시각화
fig, axes = plt.subplots(1, 3, figsize=(14, 5))
weather_vars = [('temperature', '기온(°C)'), ('humidity', '습도(%)'), ('wind_speed', '풍속(m/s)')]
result_colors = {0: '#F44336', 1: '#FFC107', 2: '#4CAF50'}
result_names  = {0: '패', 1: '무', 2: '승'}

for ax, (wvar, wlabel) in zip(axes, weather_vars):
    for res, color in result_colors.items():
        sub = df_b[df_b['result'] == res][wvar].dropna()
        if len(sub) == 0:
            continue
        ax.scatter(sub, [res + np.random.uniform(-0.1, 0.1) for _ in sub],
                   color=color, alpha=0.6, label=result_names[res], s=40)
    ax.set_xlabel(wlabel)
    ax.set_yticks([0, 1, 2])
    ax.set_yticklabels(['패', '무', '승'])
    ax.set_title(f'수원삼성: {wlabel} vs 결과')
    ax.legend(loc='upper right', fontsize=8)

plt.suptitle('B) 수원삼성 날씨 조건별 경기 결과', fontsize=13, fontweight='bold')
plt.tight_layout()
plt.savefig('analysis_B_suwon_weather.png', dpi=150)
plt.close()

# 평균 스탯 비교 (승 vs 패)
stat_compare = []
compare_cols = ['avg_rating', 'goals', 'total_shots', 'pass_acc', 'key_passes',
                'tackles', 'interceptions', 'duel_win_pct']
for col in compare_cols:
    win_mean = df_b[df_b['result']==2][col].mean()
    loss_mean = df_b[df_b['result']==0][col].mean()
    stat_compare.append({
        '지표': feature_labels.get(col, col),
        '승리 평균': round(win_mean, 2),
        '패배 평균': round(loss_mean, 2),
        '차이': round(win_mean - loss_mean, 2),
    })
df_compare = pd.DataFrame(stat_compare)
print("\n[수원삼성 승리 vs 패배 평균 스탯 비교]")
print(df_compare.to_string(index=False))

print("\n→ analysis_B_suwon_weather.png 저장")


# ─────────────────────────────────────────
# C) 2026 시즌 전체 팀 - team_stats + results
# ─────────────────────────────────────────
print("\n" + "="*60)
print("C) 2026 시즌 전체 팀 분석")
print("="*60)

with open('kleague_results_2026.json', encoding='utf-8') as f:
    results_2026 = json.load(f)
with open('kleague_team_stats.json', encoding='utf-8') as f:
    team_stats = json.load(f)

rows_c = []
for team, matches in results_2026.items():
    if not matches:
        continue
    n = len(matches)
    wins   = sum(1 for m in matches if m['result'] == 'W')
    draws  = sum(1 for m in matches if m['result'] == 'D')
    losses = sum(1 for m in matches if m['result'] == 'L')
    win_rate   = wins / n
    point_rate = (wins*3 + draws) / (n*3)
    home_matches = [m for m in matches if m['home']]
    away_matches = [m for m in matches if not m['home']]
    home_wr = sum(1 for m in home_matches if m['result']=='W') / len(home_matches) if home_matches else None
    away_wr = sum(1 for m in away_matches if m['result']=='W') / len(away_matches) if away_matches else None

    ts = team_stats.get(team, {})
    h = ts.get('home', {})
    a = ts.get('away', {})
    hist_home_wr = h.get('w', 0) / h.get('games', 1) if h.get('games') else None
    hist_away_wr = a.get('w', 0) / a.get('games', 1) if a.get('games') else None
    hist_home_games = h.get('games', 0)
    hist_away_games = a.get('games', 0)
    hist_draw_rate  = (h.get('d',0) + a.get('d',0)) / (hist_home_games + hist_away_games) if (hist_home_games+hist_away_games) > 0 else None

    rows_c.append({
        'team': team,
        'games_2026': n,
        'win_rate_2026': round(win_rate, 3),
        'point_rate_2026': round(point_rate, 3),
        'home_wr_2026': round(home_wr, 3) if home_wr is not None else None,
        'away_wr_2026': round(away_wr, 3) if away_wr is not None else None,
        'hist_home_wr': round(hist_home_wr, 3) if hist_home_wr is not None else None,
        'hist_away_wr': round(hist_away_wr, 3) if hist_away_wr is not None else None,
        'hist_home_games': hist_home_games,
        'hist_away_games': hist_away_games,
        'hist_draw_rate': round(hist_draw_rate, 3) if hist_draw_rate is not None else None,
        'hist_home_advantage': round(hist_home_wr - hist_away_wr, 3) if (hist_home_wr and hist_away_wr) else None,
    })

df_c = pd.DataFrame(rows_c).dropna(subset=['hist_home_wr', 'hist_away_wr'])
print(f"\n분석 팀 수: {len(df_c)}")
print(df_c[['team', 'games_2026', 'win_rate_2026', 'hist_home_wr', 'hist_away_wr', 'hist_home_advantage']].to_string(index=False))

# 통산 홈/원정 승률 vs 2026 현재 성적 상관
corr_c_vars = ['hist_home_wr', 'hist_away_wr', 'hist_draw_rate', 'hist_home_advantage', 'hist_home_games']
print("\n[통산 지표 vs 2026 승점률 상관]")
for col in corr_c_vars:
    sub = df_c[[col, 'point_rate_2026']].dropna()
    if len(sub) < 5:
        continue
    r, p = stats.spearmanr(sub[col], sub['point_rate_2026'])
    sig = 'O' if p < 0.05 else 'X'
    print(f"  {col:<25} r={r:+.3f}  p={p:.3f}  {sig}  (n={len(sub)})")

# 시각화 C - 통산 승률 vs 2026 성적
fig, axes = plt.subplots(1, 2, figsize=(12, 5))

for ax, (xcol, xlabel) in zip(axes, [('hist_home_wr', '통산 홈 승률'), ('hist_away_wr', '통산 원정 승률')]):
    sub = df_c[[xcol, 'point_rate_2026', 'team']].dropna()
    ax.scatter(sub[xcol], sub['point_rate_2026'], alpha=0.7, s=60, color='#1976D2')
    for _, row in sub.iterrows():
        ax.annotate(row['team'], (row[xcol], row['point_rate_2026']),
                    fontsize=7, xytext=(3, 3), textcoords='offset points')
    r, p = stats.spearmanr(sub[xcol], sub['point_rate_2026'])
    ax.set_xlabel(xlabel)
    ax.set_ylabel('2026 승점률')
    ax.set_title(f'{xlabel} vs 2026 성적\nr={r:.3f}, p={p:.3f}')

plt.suptitle('C) 통산 승률과 2026 시즌 성적의 상관', fontsize=13, fontweight='bold')
plt.tight_layout()
plt.savefig('analysis_C_2026_vs_hist.png', dpi=150)
plt.close()
print("\n→ analysis_C_2026_vs_hist.png 저장")

print("\n" + "="*60)
print("분석 완료")
print("="*60)
conn.close()
