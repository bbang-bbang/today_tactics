# today_tactics

K리그 전술 분석 웹 애플리케이션 — K리그1/2 전 팀 데이터 수집 파이프라인

---

## 스택

| 항목 | 내용 |
|------|------|
| Backend | Python 3 + Flask |
| Database | SQLite (`players.db`) |
| Frontend | Vanilla JS + HTML5 Canvas + CSS |
| Template | Jinja2 (`templates/index.html`) |
| Data Source | SofaScore API (Playwright), Open-Meteo API, Nominatim, K리그 공식 API |
| Data Files | `data/*.json` (팀/선수/전적/스탯/부상) |

---

## 실행 방법

```bash
# 가상환경 활성화
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # macOS/Linux

# 의존성 설치 (최초 1회)
pip install -r requirements.txt
playwright install chromium     # 크롤러 사용 시

# Flask 서버 실행
python main.py
# -> http://127.0.0.1:5000
```

---

## 프로젝트 구조

```
today_tactics/
  main.py                        # Flask 서버 (50+ API 엔드포인트)
  update_data.py                 # 증분 업데이트 통합 실행
  players.db                     # K리그 SQLite DB  ※ gitignored
  epl.db / laliga.db / bundesliga.db / seriea.db / ligue1.db  # 해외리그 DB  ※ gitignored
  requirements.txt               # Python 의존성
  templates/
    index.html                   # 메인 SPA (전술판)
    leagues.html                 # 해외리그 독립 페이지 (/leagues) ※ UI 진입점 일시 비활성화 (2026-06-17, 아직 이른 단계)
  static/
    css/style.css
    js/
      app.js                     # 전술판 코어 (Canvas, 드래그, 화살표, 애니메이션)
      analytics.js               # 팀 분석 차트 (결과·인사이트·🧭팀형태·📍슛맵·🎯스카우팅·📡스킬)
      banner_stats.js            # 배너 스탯
      global_league.js           # 해외리그 워크스페이스 탭 (🌍) — 리그 스위처·순위표·팀지표·TOP퍼포머 ※ index.html에서 일시 로드 해제(복구: 주석 4곳 해제)
      info.js                    # 정보 패널
      insights.js                # 인사이트 뷰 (대시보드/순위 통합)
      k2heatmap.js               # 히트맵 분석 뷰: 통합검색·비교 오버레이(포지션평균/타선수/홈vs원정)
      workspace.js               # 워크스페이스 탭 컨트롤러 (전술판/예측/팀/선수/히트맵/해외리그)
      player_analytics.js        # 선수 개인 분석 모달
      player_report.js           # 선수 리포트 (레이더 차트, 스탯 바, 상대팀별 성적) — 이름 매칭 실패 시 생년+등번호 폴백 조회
      player_compare.js          # ⚖️ 선수 vs 선수 비교 모달 (레이더 오버레이·90분 지표 바·최근폼, K1·K2)
      match_report.js            # 📋 경기 단일 심층 리포트 모달 (xG 흐름·양팀 슛맵·평균위치·골 타임라인)
      prediction.js              # 경기 예측 + 시즌 시뮬레이션
      team_compare.js            # 팀 비교 모달 (Chart.js 레이더)
    img/emblems/                 # 팀 엠블럼 (K01~K42)
  data/
    kleague_players_2026.json    # 2026 시즌 선수 데이터
    kleague_results_2026.json    # 2026 시즌 경기 결과
    kleague_h2h.json             # 상대 전적
    kleague_team_stats.json      # 팀 스탯
    sofascore_teams.json         # SofaScore 팀 ID 매핑
    player_status.json           # 부상/출전정지/출전의문 수동 관리
  crawlers/
    crawl_league.py              # 해외리그 범용 크롤러 (standings/events/players)
    init_league_db.py            # 해외리그 DB 초기화 (5개 DB, 12개 테이블)
    crawl_sofascore.py           # K리그 선수·히트맵·이벤트
    crawl_match_stats.py         # K리그 경기별 선수 세부 스탯
    sync_results_to_events.py    # K리그 공식결과 JSON → events 동기화 (NULL채움 + 공식과 다르면 교정·자가치유)
    fix_swapped_scores.py        # events 스코어 좌우반전 교정 (공식 JSON 기준 멱등, 1회성/재실행 안전)
    normalize_mps_team.py        # mps.team_id 정규화 (이벤트 유도 팀 기준)
    fetch_venues.py / fetch_weather.py / ...  # 메타 보완 스크립트
  analysis/                      # 분석/검증 스크립트 (읽기 전용)
  deploy/                        # 운영 배포 (nginx/systemd/setup.sh)
  saves/                         # 전술판 저장 파일 (gitignored)
  squads/                        # 스쿼드 파일
  checklist/                     # 개발 프로세스 문서
  qa_check.py                    # 로컬 API/DB 스모크 테스트
```

---

## 데이터 수집 파이프라인

```
K리그 (players.db)
  crawl_sofascore.py        -> teams, players, heatmap_points, events
  crawl_match_stats.py      -> match_player_stats (K1/K2, --league 플래그)
  build_k1_xg.py            -> K1 xG 모델 구축
  fetch_venues.py           -> events (경기장 좌표)
  fetch_weather.py          -> match_player_stats (날씨)
  fetch_referees.py         -> events (심판 정보)
  update_results_2026.py    -> kleague_results_2026.json (K리그 공식 API)
  backfill_*.py             -> 누락 데이터 보완 (1회성)

해외리그 (epl/laliga/bundesliga/seriea/ligue1.db)
  init_league_db.py         -> DB 초기화 (--league all로 5개 일괄 생성, 12개 테이블)
  crawl_league.py           -> 범용 크롤러 (--league epl --year 2025 --step standings/events/players)
                               standings: league_standings 테이블
                               events:   팀 프로필 컨텍스트 방식 (tournament API 403 우회)
                               players:  top-players/overall API → player_stats 집계
                               ※ Serie A / Ligue 1은 players step 403 차단 → 수집 불가
```

---

## DB 스키마

| 테이블 | 주요 컬럼 | 현재 레코드 수 |
|--------|----------|--------------|
| `teams` | id, name, league, tournament_id, season_id | K리그1/2/3 전 팀 |
| `players` | id, team_id, name, name_ko, position, height | 1,747명 |
| `player_stats` | player_id, tournament_id, season_id, rating, goals... | 시즌 누적 스탯 |
| `events` | id, home/away_team, date_ts, score, venue_* | 2,862경기 |
| `heatmap_points` | player_id, event_id, x, y | 1,134,337점 |
| `match_player_stats` | event_id, player_id, is_home, result, rating, 35개 스탯 + 날씨 | 69,622건 |
| `goal_events` | player_id, event_id, minute, type | 4,959건 |

### `match_player_stats` 주요 필드
- `is_home`: 1=홈, 0=원정
- `result`: 2=승, 1=무, 0=패
- `match_date`: 경기 시작 일시 (KST)
- `temperature` / `humidity` / `wind_speed` / `weather_desc`: 경기장 기준 날씨
- 스탯 35개: rating, goals, assists, passes, key_passes, crosses, dribbles, tackles, interceptions, clearances, aerials_won, saves 등

---

## 수집 현황 (2026-06-14 기준)

### K리그 (players.db)

| 항목 | 수치 |
|------|------|
| 2026 시즌 경기 결과 (K1+K2) | 210경기 (최신 경기일: 2026-06-07) |
| 히트맵 좌표 | 1,134,337점 |
| 수집 경기 수 | 2,862경기 |
| 경기별 선수 스탯 | 69,622건 |
| 골 이벤트 | 4,959건 |
| 등록 선수 수 | 1,747명 |

### 해외 5대 리그 (2024/25 시즌)

| 리그 | DB | 팀 | 경기 | 선수(player_stats) | 순위표 | 비고 |
|------|----|----|------|--------------------|--------|------|
| EPL | epl.db | 20 | 264 | 310명 | ✓ | |
| La Liga | laliga.db | 20 | 265 | 308명 | ✓ | |
| Bundesliga | bundesliga.db | 19 | 240 | 285명 | ✓ | |
| Serie A | seriea.db | 23 | 268 | 0 (403 차단) | ✓ | player_stats 수집 불가 |
| Ligue 1 | ligue1.db | 21 | 232 | 0 (403 차단) | ✓ | player_stats 수집 불가 |

---

## API 엔드포인트

| 엔드포인트 | 용도 |
|-----------|------|
| `/api/teams` | K리그 전체 팀 목록 |
| `/api/formations` | 포메이션 좌표 계산 |
| `/api/saves` (CRUD) | 전술판 저장/불러오기/수정/삭제 |
| `/api/squads` (CRUD) | 스쿼드 관리 |
| `/api/results` | 2026 시즌 경기 결과 |
| `/api/h2h`, `/api/h2h-matches` | 상대 전적 |
| `/api/team-stats`, `/api/team-stats-by-year` | 팀 스탯 |
| `/api/team-ranking` | 팀 랭킹 |
| `/api/team-analytics` | 팀 심층 분석 |
| `/api/team-top-players` | 팀별 TOP 선수 |
| `/api/team-goal-timing` | 팀 득점 시간대 분석 |
| `/api/team-shape` | 팀 평균 진형(Shape) — avg_positions 기반 평균위치 + 형태지표(수비라인·공격라인·팀길이·팀폭·무게중심) + 리그평균 baseline |
| `/api/team-shotmap` | 팀 슛맵 — match_shotmap 기반 `side=for\|against`, 슛 좌표·xG·outcome + 요약(슛·골·xG·유효슛%·결정력) |
| `/api/team-insights` | 팀 심화 인사이트 — 득점 시간대·선제골·xG 누적·득점기여. `xg_coverage:{with_xg,total}` 동봉 → 프론트(`analytics.js`)가 "⚠ xG N/M경기(%) 기준" 라벨 표시(xG 미집계 경기로 누적 xG 과소평가되는 함정 방지) |
| (프론트) 🎯 스카우팅 탭 | 신규 API 없음 — `team-shape` + `team-shotmap`(for/against)를 클라이언트에서 조합해 경계할 점(상대 강점)·공략 포인트(상대 약점)·게임플랜을 리그 평균 대비 자동 도출 (`analytics.js renderScout`) |
| `/api/match-report?eventId=` | 경기 단일 심층 리포트 — 한 경기 양 팀의 슛맵·평균위치·골 타임라인 + 집계 지표(슛·유효·xG·결정력·패스점유·정확도·키패스·평점). 경기예측 '예측 후기'의 📋 경기 리포트 버튼 → 모달(`match_report.js`: xG 흐름 차트·양팀 슛맵·평균위치·골 타임라인) |
| `/api/match-prediction` | 경기 예측 |
| `/api/prediction-backtest` | 예측 모델 백테스트 |
| `/api/season-simulation` | 시즌 시뮬레이션 |
| `/api/predicted-lineup` | 예상 라인업 |
| `/api/standings` | K1/K2 순위표 |
| `/api/heatmap` | 선수 히트맵 좌표 (이름 기반) |
| `/api/player-matches` | 선수 경기별 스탯 |
| `/api/player-stat-report` | 선수 스탯 리포트 — **K1·K2 자동 판정**(선수 최근 경기 리그 기준, 비교군·백분위·활동량 모두 해당 리그 내 계산). 퍼센타일 비교군이 **세부 포지션**(풀백↔풀백 등, 표본<5는 대분류 폴백). **포지션 대분류는 세부그룹 우선**(`eff_pos` — 윙어=공격수, mps가 M으로 묶는 불일치 해소)로 지표세트·레이더·라벨 결정. 응답에 `league`·`detail_label`·`peer_label` + `all_stats`·`all_pctiles`(선수 비교용 공통 90분 지표 전체) |
| (프론트) ⚖️ 선수 비교 | 신규 API 없음 — `heatmap-player-search`로 두 선수(K1·K2) 검색 → `player-stat-report` 2회 호출을 클라이언트에서 조합(레이더 오버레이·90분 지표 다이버징 바·최근 폼). `player_compare.js`. 선수 탭 헤더 '⚖️ 선수 비교' 버튼. 교차 리그(K1↔K2) 비교 시 백분위는 각자 자기 리그 기준(참고용) 명시 |
| `/api/player-analytics` | 선수 개인 분석 (활동량 지수) |
| `/api/player-vs-teams` | 선수 상대팀별 성적 |
| `/api/player-status` (CRUD) | 부상/출전정지/출전의문 관리 |
| `/api/league-dashboard` | 리그 대시보드 |
| `/api/k1/schedule`, `/api/k1/rounds` | K1 일정/라운드 |
| `/api/k2/schedule`, `/api/k2/rounds` | K2 일정/라운드 |
| `/api/kleague{1,2}/teams` | 히트맵 그리드 팀 — 현 시즌 소속(K1 12·K2 17, 수원삼성 포함) |
| `/api/kleague{1,2}/players` | 팀 현 시즌 로스터 — 히트맵 보유 선수만, 한글명 우선 |
| `/api/kleague{1,2}/heatmap` | 선수 히트맵 — **리그 무관(career), `year`·`venue=home\|away` 필터**. 응답에 `seasons=[{year,team}]`(시즌별 실소속, event+is_home 유도) + `detailPos`(선택 시즌 세부 포지션, 비교 기본값) |
| `/api/kleague{1,2}/position-heatmap` | 포지션 평균 동선 — 비교 오버레이용. `detail=`(세부 8그룹 GK/CB/FB/DM/CM/AM/W/ST) 우선, 없으면 `position=`(G/D/M/F). `year` 필터 |
| `/api/heatmap-player-search` | 히트맵 통합 선수 검색 (K1·2 전 구단, 선수당 1줄, 최근 소속) |
| `/api/insights/top-performers` | 포지션별 TOP 퍼포머 — 행에 `detail`(세부 포지션 최빈) 부착, 프론트 칩이 CB/FB/DM/CM/AM/W/ST로 행 필터 |
| `/api/insights/xg-efficiency` | xG 효율 분석 |
| `/api/insights/forward-goals` | 공격수 득점 패턴 |
| `/api/insights/midfielder-pass` | 미드필더 패스 분석 |
| `/api/insights/defender-score` | 수비수 평점 분석 |
| `/api/insights/player-detail` | 선수 인사이트 상세 |
| **해외리그 (`/leagues` 페이지)** | |
| `/leagues` | 해외리그 독립 페이지 (leagues.html) — 순위표·팀지표·TOP퍼포머·리그분석 4탭 |
| `/api/leagues` | 지원 리그 목록 (kleague 제외 해외 5개 리그) |
| `/api/league/<code>/standings` | 리그 순위표 — `league_standings` 우선, events 집계 fallback. `?year=` |
| `/api/league/<code>/team-rankings` | 팀 지표 — `player_stats` 팀 집계 우선(해외), `match_player_stats` fallback(K리그). `source` 필드로 구분 |
| `/api/league/<code>/top-performers` | 선수 TOP 퍼포머 — `player_stats` 우선, `?metric=goals\|assists\|xg\|key_passes\|tackles\|rating&limit=` |
| `/api/league/<code>/teams` | 리그 팀 목록 |

---

## 크롤러 스크립트 목록

| 스크립트 | 역할 |
|---------|------|
| `crawl_sofascore.py` | 선수 기본정보 + 시즌 스탯 + 히트맵 (Playwright) |
| `crawl_match_stats.py` | 경기별 선수 세부 스탯 (`--league K1/K2/all`) |
| `crawl_kleague1_2026.py` | K1 2026 시즌 전체 수집 |
| `crawl_kleague2_all.py` | K2 전 팀 히트맵 포함 수집 |
| `build_k1_xg.py` | K1 xG 모델 데이터 구축 |
| `fetch_venues.py` | 경기장 좌표 (SofaScore + Nominatim 보완) |
| `fetch_weather.py` | 경기 당시 날씨 (Open-Meteo Archive API) |
| `fetch_referees.py` | 경기별 심판 정보 |
| `fetch_injuries.py` | 부상자 수집 (K리그는 SofaScore 미제공 → 수동 관리) |
| `fetch_events.py` | 누락 이벤트 메타 보완 |
| `update_results_2026.py` | K리그 공식 API → 경기 결과 JSON 증분 수집 |
| `backfill_k1_mps.py` | K1 match_player_stats 누락분 보완 |
| `backfill_match_stats.py` | match_player_stats 일반 누락분 보완 |
| `backfill_events.py` | events 테이블 누락분 보완 |
| `backfill_detail_positions.py` | `match_lineups.detail_pos` 백필 — formation+slot_order → 세부 포지션(GK/CB/FB/WB/DM/CM/AM/W/ST) 결정론적 유도 (재크롤링 불필요) |
| `collect_goal_incidents.py` | 골 이벤트 수집 |

---

## 초기 수집 순서

```bash
# 1. 선수 기본정보 + 히트맵 (전 팀, 시간 오래 걸림)
python crawlers/crawl_sofascore.py

# 2. 경기별 선수 세부 스탯
python crawlers/crawl_match_stats.py --league all

# 3. 경기장 좌표
python crawlers/fetch_venues.py

# 4. 날씨
python crawlers/fetch_weather.py

# 5. 경기 결과 JSON
python crawlers/update_results_2026.py
```

## 증분 업데이트

```bash
# 새 경기 발생 시
python update_data.py
```

---

## 주의사항

- SofaScore 일부 경기장 `venueCoordinates`가 lat/lon 뒤집혀 있음 → `fetch_venues.py`에서 자동 교정
- Nominatim API 초당 1건 제한 → `fetch_venues.py`에서 1.1초 딜레이 적용
- Open-Meteo Archive API는 당일 데이터 없을 수 있음 → 경기 후 1~2일 뒤 실행 권장
- K리그 부상 정보는 SofaScore 미제공 → `data/player_status.json` 수동 관리
- `requirements.txt`는 ASCII 전용 (Windows pip cp949 인코딩 충돌 방지)
- 크롤러 실행 시 Flask 서버와 별도 터미널 사용 권장

## 데이터 정합성 (2026-06-15 점검)

- **events 스코어 좌우반전**: SofaScore 크롤 단계에서 일부 경기 home/away 스코어가 뒤바뀜 → K리그 공식 JSON 기준으로 `fix_swapped_scores.py` 교정 + `sync_results_to_events.py`가 공식과 다르면 자동 갱신(자가치유). 순위표·전적·예측에 직결.
- **mps.team_id**: 이벤트 유도 팀(is_home) 기준 정규화 완료(0 불일치). 스탯 값·리그 태그·중복행·고아 0건.
- **포지션 분류**: `detail_pos`(세부, 윙어=W→F) 우선, 없으면 `mps.position` 폴백으로 통일 — 화면 간 불일치(윙어가 미드필더로 보임) 해소.
- **표본 함정 가드**: 날씨·월별·상대팀별·선수 상대팀별 등 소표본 비율은 일정 경기수 미만이면 흐리게·후순위·경고 표시(1~2경기 승률을 신뢰 지표로 오인 방지). 인사이트(per-90·공중볼 등)는 최소 표본 필터 기존 적용.
