"""
심층 종합 분석
1. 패스정확도 역상관 메커니즘
2. 태클 역전 현상
3. 팀별 플레이스타일 클러스터링
4. 홈/원정 연도별 어드밴티지 변화
5. 날씨 구간별 성과
6. 포지션별 기여도
7. 다변량 예측 모델 (로지스틱 회귀)
8. 공격력 vs 수비력 균형
"""

import sqlite3, warnings
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import cross_val_score
warnings.filterwarnings('ignore')

import platform
if platform.system() == 'Windows':
    plt.rcParams['font.family'] = 'Malgun Gothic'
plt.rcParams['axes.unicode_minus'] = False

conn = sqlite3.connect('players.db')

# ── 기본 데이터 로드 ──────────────────────────────────────
df_raw = pd.read_sql_query("""
    SELECT event_id, team_id, is_home, result, position,
           substr(match_date,1,4) as year,
           temperature, humidity, wind_speed,
           rating, goals, total_shots, shots_on_target,
           big_chances_missed, expected_goals,
           accurate_passes, total_passes, accurate_passes_pct,
           key_passes, accurate_long_balls, total_long_balls,
           accurate_crosses, total_crosses,
           successful_dribbles, attempted_dribbles,
           touches, possession_lost,
           tackles, interceptions, clearances,
           blocked_shots, duel_won, duel_lost,
           aerial_won, aerial_lost,
           was_fouled, fouls, yellow_cards, red_cards,
           saves
    FROM match_player_stats
    WHERE result IS NOT NULL
""", conn)

# 경기-팀 단위 집계
agg = df_raw.groupby(['event_id','team_id','is_home','result','year']).agg(
    temperature       =('temperature','first'),
    humidity          =('humidity','first'),
    wind_speed        =('wind_speed','first'),
    avg_rating        =('rating','mean'),
    goals             =('goals','sum'),
    total_shots       =('total_shots','sum'),
    shots_on_target   =('shots_on_target','sum'),
    big_chances_missed=('big_chances_missed','sum'),
    xg                =('expected_goals','sum'),
    accurate_passes   =('accurate_passes','sum'),
    total_passes      =('total_passes','sum'),
    pass_acc          =('accurate_passes_pct','mean'),
    key_passes        =('key_passes','sum'),
    long_ball_acc     =('accurate_long_balls','sum'),
    total_long_balls  =('total_long_balls','sum'),
    accurate_crosses  =('accurate_crosses','sum'),
    total_crosses     =('total_crosses','sum'),
    successful_dribbles=('successful_dribbles','sum'),
    touches           =('touches','sum'),
    possession_lost   =('possession_lost','sum'),
    tackles           =('tackles','sum'),
    interceptions     =('interceptions','sum'),
    clearances        =('clearances','sum'),
    blocked_shots     =('blocked_shots','sum'),
    duel_won          =('duel_won','sum'),
    duel_lost         =('duel_lost','sum'),
    aerial_won        =('aerial_won','sum'),
    aerial_lost       =('aerial_lost','sum'),
    was_fouled        =('was_fouled','sum'),
    fouls             =('fouls','sum'),
    yellow_cards      =('yellow_cards','sum'),
    saves             =('saves','sum'),
    player_count      =('rating','count'),
).reset_index()

agg['shot_acc']      = agg['shots_on_target'] / agg['total_shots'].replace(0, np.nan)
agg['duel_win_pct']  = agg['duel_won'] / (agg['duel_won'] + agg['duel_lost']).replace(0, np.nan)
agg['long_ball_pct'] = agg['long_ball_acc'] / agg['total_long_balls'].replace(0, np.nan)
agg['cross_acc']     = agg['accurate_crosses'] / agg['total_crosses'].replace(0, np.nan)
agg['pass_vol']      = agg['total_passes'] / agg['player_count'].replace(0, np.nan)  # 1인당 패스 수
agg['points']        = agg['result'].map({0:0, 1:1, 2:3})
agg['win']           = (agg['result'] == 2).astype(int)
YEARS = ['2024','2025','2026']
RES_COLOR = {0:'#F44336', 1:'#FFC107', 2:'#4CAF50'}
RES_NAME  = {0:'패', 1:'무', 2:'승'}

print(f"총 샘플: {len(agg)}  /  팀: {agg['team_id'].nunique()}  /  경기: {agg['event_id'].nunique()}")


# ════════════════════════════════════════════════════
# 1. 패스정확도 역상관 메커니즘
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("1. 패스정확도 역상관 메커니즘")
print("="*55)

# 패스볼륨(1인당 패스) vs 패스정확도 by result
print("\n[결과별 패스 패턴]")
for res in [2,1,0]:
    s = agg[agg['result']==res]
    print(f"  {RES_NAME[res]}  패스정확도={s['pass_acc'].mean():.1f}%  "
          f"1인당패스={s['pass_vol'].mean():.1f}  "
          f"패스볼륨합={s['total_passes'].mean():.0f}  "
          f"possession_lost={s['possession_lost'].mean():.1f}")

# 패스정확도 - 패스볼륨 산점도
fig, axes = plt.subplots(1, 3, figsize=(15, 5))
for ax, yr in zip(axes, YEARS):
    sub = agg[agg['year']==yr]
    for res in [0,1,2]:
        s = sub[sub['result']==res][['pass_acc','pass_vol']].dropna()
        ax.scatter(s['pass_acc'], s['pass_vol'], color=RES_COLOR[res],
                   label=RES_NAME[res], alpha=0.5, s=30)
    # 회귀선
    s2 = sub[['pass_acc','pass_vol','points']].dropna()
    if len(s2) > 10:
        z = np.polyfit(s2['pass_acc'], s2['points'], 1)
        p_fn = np.poly1d(z)
        xs = np.linspace(s2['pass_acc'].min(), s2['pass_acc'].max(), 50)
        ax.twinx().plot(xs, p_fn(xs), 'k--', alpha=0.4, linewidth=1.5)
    r, p = stats.spearmanr(sub['pass_acc'].dropna(), sub[sub['pass_acc'].notna()]['points'])
    ax.set_title(f'{yr}년  pass_acc vs 패스볼륨\n(승점 상관 r={r:.2f})', fontsize=10)
    ax.set_xlabel('패스정확도(%)')
    ax.set_ylabel('1인당 패스 수')
    ax.legend(fontsize=8)

plt.suptitle('1. 패스정확도 역상관: 이기는 팀이 더 많이 패스하고 정확도는 낮은가?',
             fontsize=11, fontweight='bold')
plt.tight_layout()
plt.savefig('deep_1_pass.png', dpi=150)
plt.close()
print("-> deep_1_pass.png")


# ════════════════════════════════════════════════════
# 2. 태클 역전 현상
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("2. 태클 역전 현상 (2024 +상관 → 2026 -상관)")
print("="*55)

print("\n[연도×결과별 태클/인터셉션 평균]")
print(f"{'연도':<6} {'결과':<4} {'태클':>6} {'인터셉션':>8} {'태클+인터':>10}")
for yr in YEARS:
    for res in [2,1,0]:
        s = agg[(agg['year']==yr) & (agg['result']==res)]
        t = s['tackles'].mean()
        i = s['interceptions'].mean()
        print(f"{yr:<6} {RES_NAME[res]:<4} {t:>6.2f} {i:>8.2f} {t+i:>10.2f}")

# 태클 vs 승점 연도별 scatter + 추세선
fig, axes = plt.subplots(1, 3, figsize=(15, 5))
for ax, yr in zip(axes, YEARS):
    sub = agg[agg['year']==yr][['tackles','interceptions','points','result']].dropna()
    sub['def_action'] = sub['tackles'] + sub['interceptions']
    for res in [0,1,2]:
        s = sub[sub['result']==res]
        ax.scatter(s['def_action'], s['points'] + np.random.uniform(-0.1,0.1,len(s)),
                   color=RES_COLOR[res], label=RES_NAME[res], alpha=0.4, s=25)
    if len(sub) > 10:
        r, p = stats.spearmanr(sub['def_action'], sub['points'])
        z = np.polyfit(sub['def_action'], sub['points'], 1)
        xs = np.linspace(sub['def_action'].min(), sub['def_action'].max(), 50)
        ax.plot(xs, np.poly1d(z)(xs), 'k--', linewidth=1.5, alpha=0.6)
        sig = '(유의)' if p < 0.05 else ''
        ax.set_title(f'{yr}년  태클+인터셉션 vs 승점\nr={r:+.3f} {sig}', fontsize=10)
    ax.set_xlabel('태클+인터셉션')
    ax.set_yticks([0,1,3])
    ax.set_yticklabels(['패','무','승'])
    ax.legend(fontsize=8)

plt.suptitle('2. 수비 행동(태클+인터셉션) vs 승점: 연도별 방향 변화',
             fontsize=11, fontweight='bold')
plt.tight_layout()
plt.savefig('deep_2_tackle.png', dpi=150)
plt.close()
print("-> deep_2_tackle.png")


# ════════════════════════════════════════════════════
# 3. 팀별 플레이스타일 클러스터링
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("3. 팀별 플레이스타일 클러스터링")
print("="*55)

from sklearn.cluster import KMeans
from sklearn.decomposition import PCA

# 팀별 평균 스탯 (충분한 경기 수 가진 팀)
style_cols = ['pass_acc','pass_vol','total_shots','tackles','interceptions',
              'long_ball_pct','duel_win_pct','key_passes','avg_rating']
team_style = agg.groupby('team_id')[style_cols + ['points','win']].mean().dropna(subset=style_cols)
min_games = agg.groupby('team_id').size()
team_style = team_style[min_games[team_style.index] >= 20]
print(f"클러스터링 대상 팀 수: {len(team_style)}")

scaler = StandardScaler()
X = scaler.fit_transform(team_style[style_cols])

# KMeans 3클러스터
km = KMeans(n_clusters=3, random_state=42, n_init=10)
team_style['cluster'] = km.fit_predict(X)

pca = PCA(n_components=2)
X_pca = pca.fit_transform(X)
team_style['pc1'] = X_pca[:,0]
team_style['pc2'] = X_pca[:,1]

print("\n[클러스터별 평균 특성]")
cluster_means = team_style.groupby('cluster')[style_cols + ['win']].mean().round(3)
print(cluster_means.to_string())

c_colors = ['#2196F3','#FF9800','#4CAF50']
c_labels = {0:'클러스터 A', 1:'클러스터 B', 2:'클러스터 C'}

fig, axes = plt.subplots(1, 2, figsize=(14, 6))

# PCA scatter
ax = axes[0]
for c in [0,1,2]:
    s = team_style[team_style['cluster']==c]
    ax.scatter(s['pc1'], s['pc2'], color=c_colors[c], s=100,
               label=f"{c_labels[c]} (n={len(s)})", alpha=0.8, zorder=3)
    for tid in s.index:
        ax.annotate(str(tid), (s.loc[tid,'pc1'], s.loc[tid,'pc2']),
                    fontsize=7, xytext=(3,3), textcoords='offset points')
ax.set_xlabel(f'PC1 ({pca.explained_variance_ratio_[0]*100:.0f}%)')
ax.set_ylabel(f'PC2 ({pca.explained_variance_ratio_[1]*100:.0f}%)')
ax.set_title('팀 플레이스타일 PCA (KMeans 3클러스터)', fontsize=11, fontweight='bold')
ax.legend()
ax.grid(alpha=0.3)

# 클러스터별 승률 + 스타일 레이더 (bar로 대체)
ax = axes[1]
cmeans = team_style.groupby('cluster')[['pass_acc','total_shots','tackles','long_ball_pct','win']].mean()
x = np.arange(len(cmeans.columns))
w = 0.25
for i, c in enumerate([0,1,2]):
    vals = cmeans.loc[c].values
    vals_norm = (vals - vals.min()) / (vals.max() - vals.min() + 1e-9)
    ax.bar(x + i*w, vals_norm, w, color=c_colors[i], label=c_labels[c], alpha=0.8)
ax.set_xticks(x + w)
ax.set_xticklabels(['패스정확도','슈팅수','태클','롱볼%','승률'], fontsize=9)
ax.set_ylabel('정규화 값')
ax.set_title('클러스터별 플레이스타일 비교', fontsize=11, fontweight='bold')
ax.legend()

plt.tight_layout()
plt.savefig('deep_3_cluster.png', dpi=150)
plt.close()
print("-> deep_3_cluster.png")


# ════════════════════════════════════════════════════
# 4. 홈/원정 연도별 어드밴티지 변화
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("4. 홈/원정 어드밴티지 연도별 변화")
print("="*55)

print(f"\n{'연도':<6} {'홈승률':>8} {'원정승률':>10} {'홈어드밴티지':>14} {'홈무승부율':>12}")
ha_data = []
for yr in YEARS:
    h = agg[(agg['year']==yr) & (agg['is_home']==1)]
    a = agg[(agg['year']==yr) & (agg['is_home']==0)]
    h_wr = (h['result']==2).mean()
    a_wr = (a['result']==2).mean()
    h_dr = (h['result']==1).mean()
    adv  = h_wr - a_wr
    ha_data.append({'year':yr,'home_wr':h_wr,'away_wr':a_wr,'advantage':adv,'home_dr':h_dr,
                    'home_pts':h['points'].mean(),'away_pts':a['points'].mean()})
    print(f"{yr:<6} {h_wr:>8.3f} {a_wr:>10.3f} {adv:>+14.3f} {h_dr:>12.3f}")

df_ha = pd.DataFrame(ha_data)

fig, axes = plt.subplots(1, 2, figsize=(12, 5))

ax = axes[0]
ax.plot(YEARS, df_ha['home_wr']*100, 'o-', color='#2196F3', linewidth=2, markersize=8, label='홈 승률')
ax.plot(YEARS, df_ha['away_wr']*100, 's-', color='#F44336', linewidth=2, markersize=8, label='원정 승률')
ax.fill_between(YEARS, df_ha['home_wr']*100, df_ha['away_wr']*100, alpha=0.15, color='#2196F3')
ax.set_ylabel('승률 (%)')
ax.set_title('홈 vs 원정 승률 추이', fontsize=11, fontweight='bold')
ax.legend()
ax.grid(alpha=0.3)

ax = axes[1]
bars = ax.bar(YEARS, df_ha['advantage']*100, color=['#4CAF50' if v>0 else '#F44336' for v in df_ha['advantage']],
              alpha=0.8, edgecolor='black', linewidth=0.5)
ax.axhline(0, color='black', linewidth=0.8)
for bar, val in zip(bars, df_ha['advantage']*100):
    ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+0.3,
            f'{val:+.1f}%', ha='center', fontsize=11, fontweight='bold')
ax.set_ylabel('홈어드밴티지 (홈승률 - 원정승률)')
ax.set_title('연도별 홈 어드밴티지 크기', fontsize=11, fontweight='bold')
ax.grid(axis='y', alpha=0.3)

plt.suptitle('4. 홈/원정 어드밴티지 연도별 변화', fontsize=12, fontweight='bold')
plt.tight_layout()
plt.savefig('deep_4_home.png', dpi=150)
plt.close()
print("-> deep_4_home.png")


# ════════════════════════════════════════════════════
# 5. 날씨 구간별 성과 분석
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("5. 날씨 구간별 성과 분석")
print("="*55)

# 기온 구간
def temp_bin(t):
    if pd.isna(t): return None
    if t < 5:   return '5도 미만\n(극한 추위)'
    if t < 15:  return '5-15도\n(선선)'
    if t < 25:  return '15-25도\n(적온)'
    return '25도 이상\n(더위)'

def humid_bin(h):
    if pd.isna(h): return None
    if h < 40:  return '40% 미만\n(건조)'
    if h < 70:  return '40-70%\n(보통)'
    return '70% 이상\n(습함)'

agg['temp_bin']  = agg['temperature'].apply(temp_bin)
agg['humid_bin'] = agg['humidity'].apply(humid_bin)

temp_order  = ['5도 미만\n(극한 추위)', '5-15도\n(선선)', '15-25도\n(적온)', '25도 이상\n(더위)']
humid_order = ['40% 미만\n(건조)', '40-70%\n(보통)', '70% 이상\n(습함)']

fig, axes = plt.subplots(2, 2, figsize=(14, 10))

# 기온 구간별 승/무/패 비율
ax = axes[0,0]
temp_res = agg.dropna(subset=['temp_bin']).groupby(['temp_bin','result']).size().unstack(fill_value=0)
temp_res_pct = temp_res.div(temp_res.sum(axis=1), axis=0) * 100
temp_res_pct = temp_res_pct.reindex([t for t in temp_order if t in temp_res_pct.index])
if not temp_res_pct.empty:
    temp_res_pct.rename(columns={0:'패',1:'무',2:'승'}).plot(
        kind='bar', ax=ax, color=['#F44336','#FFC107','#4CAF50'], rot=0, width=0.7)
ax.set_title('기온 구간별 승/무/패 비율', fontsize=11, fontweight='bold')
ax.set_ylabel('%')
ax.legend(loc='upper right')
ax.grid(axis='y', alpha=0.3)

# 기온 구간별 평균 승점
ax = axes[0,1]
temp_pts = agg.dropna(subset=['temp_bin']).groupby('temp_bin')['points'].agg(['mean','sem'])
temp_pts = temp_pts.reindex([t for t in temp_order if t in temp_pts.index])
bars = ax.bar(temp_pts.index, temp_pts['mean'],
              yerr=temp_pts['sem'], capsize=5,
              color='#1976D2', alpha=0.8, edgecolor='black', linewidth=0.5)
for bar, val in zip(bars, temp_pts['mean']):
    ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+0.05,
            f'{val:.2f}', ha='center', fontsize=9)
ax.set_title('기온 구간별 평균 승점', fontsize=11, fontweight='bold')
ax.set_ylabel('평균 승점')
ax.grid(axis='y', alpha=0.3)

# 습도 구간별 승/무/패 비율
ax = axes[1,0]
hum_res = agg.dropna(subset=['humid_bin']).groupby(['humid_bin','result']).size().unstack(fill_value=0)
hum_res_pct = hum_res.div(hum_res.sum(axis=1), axis=0) * 100
hum_res_pct = hum_res_pct.reindex([h for h in humid_order if h in hum_res_pct.index])
if not hum_res_pct.empty:
    hum_res_pct.rename(columns={0:'패',1:'무',2:'승'}).plot(
        kind='bar', ax=ax, color=['#F44336','#FFC107','#4CAF50'], rot=0, width=0.7)
ax.set_title('습도 구간별 승/무/패 비율', fontsize=11, fontweight='bold')
ax.set_ylabel('%')
ax.legend(loc='upper right')
ax.grid(axis='y', alpha=0.3)

# 기온 × 홈/원정 상호작용
ax = axes[1,1]
for is_h, lbl, col in [(1,'홈','#2196F3'), (0,'원정','#F44336')]:
    sub = agg[(agg['is_home']==is_h)].dropna(subset=['temp_bin'])
    pts = sub.groupby('temp_bin')['points'].mean().reindex(
        [t for t in temp_order if t in sub['temp_bin'].unique()])
    ax.plot(range(len(pts)), pts.values, 'o-', label=lbl, color=col, linewidth=2, markersize=8)
    ax.set_xticks(range(len(pts)))
    ax.set_xticklabels(pts.index, fontsize=8)
ax.set_ylabel('평균 승점')
ax.set_title('기온 구간 × 홈/원정 승점', fontsize=11, fontweight='bold')
ax.legend()
ax.grid(alpha=0.3)

plt.suptitle('5. 날씨 조건별 경기 성과', fontsize=12, fontweight='bold')
plt.tight_layout()
plt.savefig('deep_5_weather.png', dpi=150)
plt.close()
print("-> deep_5_weather.png")

print("\n[기온 구간별 샘플 수 및 평균 승점]")
tw = agg.dropna(subset=['temp_bin','points']).groupby('temp_bin')['points'].agg(['count','mean'])
tw.index = [x.replace('\n',' ') for x in tw.index]
print(tw.rename(columns={'count':'샘플수','mean':'평균승점'}).round(3).to_string())


# ════════════════════════════════════════════════════
# 6. 포지션별 기여도
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("6. 포지션별 기여도")
print("="*55)

pos_cols = ['rating','goals','key_passes','tackles','interceptions',
            'duel_won','aerial_won','fouls','yellow_cards']
pos_map  = {'G':'GK(골키퍼)','D':'DEF(수비)','M':'MID(미드필더)','F':'FWD(공격)'}

df_pos = df_raw[df_raw['position'].notna()].copy()
df_pos['points'] = df_pos['result'].map({0:0,1:1,2:3})
df_pos['pos_label'] = df_pos['position'].map(pos_map)

print("\n[포지션 × 결과별 평균 스탯]")
pos_res = df_pos.groupby(['pos_label','result'])[['rating','goals','tackles','key_passes']].mean().round(3)
print(pos_res.to_string())

fig, axes = plt.subplots(2, 2, figsize=(14, 10))

metrics = [('rating','평균평점'), ('goals','득점'), ('tackles','태클'), ('key_passes','키패스')]
pos_order = ['GK(골키퍼)','DEF(수비)','MID(미드필더)','FWD(공격)']
pos_colors = {'GK(골키퍼)':'#9C27B0','DEF(수비)':'#2196F3','MID(미드필더)':'#4CAF50','FWD(공격)':'#FF5722'}

for ax, (col, label) in zip(axes.flat, metrics):
    corr_by_pos = []
    for pos in pos_order:
        sub = df_pos[df_pos['pos_label']==pos][[col,'points']].dropna()
        if len(sub) < 20:
            corr_by_pos.append(np.nan)
            continue
        r, _ = stats.spearmanr(sub[col], sub['points'])
        corr_by_pos.append(r)
    colors_bar = [pos_colors.get(p,'gray') for p in pos_order]
    bars = ax.bar(pos_order, corr_by_pos, color=colors_bar, alpha=0.8, edgecolor='black', linewidth=0.5)
    ax.axhline(0, color='black', linewidth=0.8)
    for bar, val in zip(bars, corr_by_pos):
        if not np.isnan(val):
            ax.text(bar.get_x()+bar.get_width()/2,
                    bar.get_height() + (0.005 if val>=0 else -0.015),
                    f'{val:+.3f}', ha='center', fontsize=9)
    ax.set_title(f'{label} - 포지션별 승점 상관(r)', fontsize=11, fontweight='bold')
    ax.set_ylabel('Spearman r')
    ax.set_xticklabels([p.split('(')[0] for p in pos_order])
    ax.grid(axis='y', alpha=0.3)

plt.suptitle('6. 포지션별 각 지표의 승점 기여도 (Spearman r)', fontsize=12, fontweight='bold')
plt.tight_layout()
plt.savefig('deep_6_position.png', dpi=150)
plt.close()
print("-> deep_6_position.png")


# ════════════════════════════════════════════════════
# 7. 다변량 예측 모델 (로지스틱 회귀)
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("7. 다변량 예측 모델 (승/패 로지스틱 회귀)")
print("="*55)

model_cols = ['avg_rating','goals','total_shots','shots_on_target','shot_acc',
              'pass_acc','pass_vol','key_passes','long_ball_pct',
              'tackles','interceptions','clearances','duel_win_pct',
              'fouls','yellow_cards','temperature','humidity','wind_speed','is_home']

df_model = agg[agg['result'] != 1][model_cols + ['win']].dropna()
print(f"모델 샘플 (승/패만): {len(df_model)}  승:{df_model['win'].sum()} 패:{(df_model['win']==0).sum()}")

X_m = df_model[model_cols].values
y_m = df_model['win'].values

sc = StandardScaler()
X_sc = sc.fit_transform(X_m)

lr = LogisticRegression(max_iter=1000, random_state=42)
cv_scores = cross_val_score(lr, X_sc, y_m, cv=5, scoring='accuracy')
print(f"\n5-Fold CV 정확도: {cv_scores.mean():.3f} ± {cv_scores.std():.3f}")

lr.fit(X_sc, y_m)
coefs = pd.DataFrame({'feature': model_cols, 'coef': lr.coef_[0]})
coefs['abs'] = coefs['coef'].abs()
coefs = coefs.sort_values('coef', ascending=False)

print("\n[로지스틱 회귀 계수 (승리 영향도)]")
print(coefs[['feature','coef']].to_string(index=False))

feat_kor = {
    'avg_rating':'평균평점','goals':'득점','total_shots':'슈팅수',
    'shots_on_target':'유효슈팅','shot_acc':'슈팅정확도',
    'pass_acc':'패스정확도','pass_vol':'패스볼륨','key_passes':'키패스',
    'long_ball_pct':'롱볼성공률','tackles':'태클','interceptions':'인터셉션',
    'clearances':'클리어런스','duel_win_pct':'듀얼승률',
    'fouls':'파울','yellow_cards':'경고',
    'temperature':'기온','humidity':'습도','wind_speed':'풍속','is_home':'홈여부'
}
coefs['kor'] = coefs['feature'].map(feat_kor)

fig, ax = plt.subplots(figsize=(10, 7))
colors_coef = ['#2196F3' if c > 0 else '#F44336' for c in coefs['coef']]
ax.barh(coefs['kor'], coefs['coef'], color=colors_coef, alpha=0.85, edgecolor='black', linewidth=0.3)
ax.axvline(0, color='black', linewidth=1)
ax.set_xlabel('로지스틱 회귀 계수 (양수=승리에 기여)')
ax.set_title(f'7. 승리 예측 변수 중요도 (5-CV 정확도: {cv_scores.mean():.1%})',
             fontsize=12, fontweight='bold')
ax.grid(axis='x', alpha=0.3)
plt.tight_layout()
plt.savefig('deep_7_model.png', dpi=150)
plt.close()
print("-> deep_7_model.png")


# ════════════════════════════════════════════════════
# 8. 공격력 vs 수비력 균형
# ════════════════════════════════════════════════════
print("\n" + "="*55)
print("8. 공격력 vs 수비력 균형")
print("="*55)

# 공격 지수 = avg_rating×0.3 + 득점×0.4 + 유효슈팅×0.3 (정규화)
# 수비 지수 = 태클×0.35 + 인터셉션×0.35 + 클리어런스×0.3 (정규화)
from sklearn.preprocessing import MinMaxScaler

agg2 = agg.dropna(subset=['avg_rating','goals','shots_on_target','tackles','interceptions','clearances']).copy()
mms = MinMaxScaler()
agg2[['r_atk','r_goals','r_sot','r_tck','r_int','r_clr']] = mms.fit_transform(
    agg2[['avg_rating','goals','shots_on_target','tackles','interceptions','clearances']])

agg2['atk_index'] = agg2['r_atk']*0.3 + agg2['r_goals']*0.4 + agg2['r_sot']*0.3
agg2['def_index'] = agg2['r_tck']*0.35 + agg2['r_int']*0.35 + agg2['r_clr']*0.3

r_atk, _ = stats.spearmanr(agg2['atk_index'], agg2['points'])
r_def, _ = stats.spearmanr(agg2['def_index'], agg2['points'])
print(f"\n공격 지수 vs 승점: r={r_atk:.3f}")
print(f"수비 지수 vs 승점: r={r_def:.3f}")
print(f"=> {'공격력' if abs(r_atk) > abs(r_def) else '수비력'}이 더 강한 상관")

# 연도별로도 확인
print("\n[연도별 공격/수비 지수 상관]")
for yr in YEARS:
    s = agg2[agg2['year']==yr]
    ra, _ = stats.spearmanr(s['atk_index'], s['points'])
    rd, _ = stats.spearmanr(s['def_index'], s['points'])
    print(f"  {yr}: 공격 r={ra:+.3f}  수비 r={rd:+.3f}  → {'공격' if abs(ra)>abs(rd) else '수비'} 우세")

fig, axes = plt.subplots(1, 3, figsize=(15, 5))

# 공격 vs 수비 2D 산점도 (결과별 색상)
ax = axes[0]
for res in [0,1,2]:
    s = agg2[agg2['result']==res]
    ax.scatter(s['atk_index'], s['def_index'],
               color=RES_COLOR[res], label=RES_NAME[res], alpha=0.3, s=20)
ax.set_xlabel('공격 지수')
ax.set_ylabel('수비 지수')
ax.set_title('공격지수 × 수비지수 분포', fontsize=10, fontweight='bold')
ax.legend()

# 4분면 승률
ax = axes[1]
med_atk = agg2['atk_index'].median()
med_def = agg2['def_index'].median()
quad_labels = ['공격↓수비↓\n(최약)', '공격↑수비↓\n(공격형)', '공격↓수비↑\n(수비형)', '공격↑수비↑\n(균형)']
quads = [
    agg2[(agg2['atk_index']<=med_atk) & (agg2['def_index']<=med_def)],
    agg2[(agg2['atk_index']> med_atk) & (agg2['def_index']<=med_def)],
    agg2[(agg2['atk_index']<=med_atk) & (agg2['def_index']> med_def)],
    agg2[(agg2['atk_index']> med_atk) & (agg2['def_index']> med_def)],
]
wr_vals = [(q['result']==2).mean()*100 for q in quads]
bar_colors = ['#F44336','#FF9800','#2196F3','#4CAF50']
bars = ax.bar(quad_labels, wr_vals, color=bar_colors, alpha=0.85, edgecolor='black', linewidth=0.5)
for bar, val, q in zip(bars, wr_vals, quads):
    ax.text(bar.get_x()+bar.get_width()/2, bar.get_height()+0.5,
            f'{val:.1f}%\n(n={len(q)})', ha='center', fontsize=8)
ax.set_ylabel('승률 (%)')
ax.set_title('4분면별 승률', fontsize=10, fontweight='bold')
ax.grid(axis='y', alpha=0.3)

# 연도별 공격/수비 상관 추이
ax = axes[2]
atk_rs, def_rs = [], []
for yr in YEARS:
    s = agg2[agg2['year']==yr]
    ra, _ = stats.spearmanr(s['atk_index'], s['points'])
    rd, _ = stats.spearmanr(s['def_index'], s['points'])
    atk_rs.append(ra)
    def_rs.append(rd)

ax.plot(YEARS, atk_rs, 'o-', color='#FF5722', linewidth=2.5, markersize=9, label='공격 지수')
ax.plot(YEARS, def_rs, 's-', color='#1976D2', linewidth=2.5, markersize=9, label='수비 지수')
ax.axhline(0, color='black', linewidth=0.8, linestyle='--')
ax.set_ylabel('Spearman r (vs 승점)')
ax.set_title('공격력 vs 수비력 중요도 추이', fontsize=10, fontweight='bold')
ax.legend()
ax.grid(alpha=0.3)

plt.suptitle('8. 공격력 vs 수비력: 어느 쪽이 승리를 더 결정하는가', fontsize=12, fontweight='bold')
plt.tight_layout()
plt.savefig('deep_8_atkvdef.png', dpi=150)
plt.close()
print("-> deep_8_atkvdef.png")


conn.close()
print("\n" + "="*55)
print("전체 분석 완료")
print("="*55)
