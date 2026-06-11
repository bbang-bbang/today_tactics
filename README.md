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
  main.py                        # Flask 서버 (45+ API 엔드포인트)
  update_data.py                 # 증분 업데이트 통합 실행
  players.db                     # SQLite DB
  requirements.txt               # Python 의존성
  templates/
    index.html                   # 메인 SPA
  static/
    css/style.css
    js/
      app.js                     # 전술판 코어 (Canvas, 드래그, 화살표, 애니메이션)
      analytics.js               # 팀 분석 차트
      banner_stats.js            # 배너 스탯
      info.js                    # 정보 패널
      insights.js                # 인사이트 뷰 (대시보드/순위 통합)
      k2heatmap.js               # 히트맵 분석 뷰 (워크스페이스 탭): 통합검색·년도필터·비교 오버레이(포지션평균/타선수/홈vs원정)·인사이트 배너
      workspace.js               # 상단 워크스페이스 탭 컨트롤러 (전술판/경기예측/팀/선수/히트맵)
      player_analytics.js        # 선수 개인 분석 모달
      player_report.js           # 선수 리포트 (레이더 차트, 스탯 바)
      prediction.js              # 경기 예측 + 시즌 시뮬레이션
      team_compare.js            # 팀 비교 모달 (Chart.js 레이더)
    img/emblems/                 # 팀 엠블럼 (K01~K42)
  data/
    kleague_players_2026.json    # 2026 시즌 선수 데이터
    kleague_results_2026.json    # 2026 시즌 경기 결과 (196건)
    kleague_h2h.json             # 상대 전적
    kleague_team_stats.json      # 팀 스탯
    sofascore_teams.json         # SofaScore 팀 ID 매핑
    player_status.json           # 부상/출전정지/출전의문 수동 관리
  crawlers/                      # 데이터 수집 스크립트 (42개)
  analysis/                      # 분석/검증 스크립트 (읽기 전용)
  deploy/                        # 운영 배포 (nginx/systemd/setup.sh)
  saves/                         # 전술판 저장 파일 (gitignored)
  squads/                        # 스쿼드 파일 (default_*.json + {team}_2026.json)
  checklist/                     # 개발 프로세스 문서
  qa_check.py                    # 로컬 API/DB 스모크 테스트
```

---

## 데이터 수집 파이프라인

```
SofaScore API (Playwright)
  crawl_sofascore.py        -> teams, players, player_stats, heatmap_points, events
  crawl_match_stats.py      -> match_player_stats (K1/K2 전 팀, --league 플래그)
  crawl_kleague1_2026.py    -> K1 2026 시즌 경기별 선수 스탯
  crawl_kleague2_all.py     -> K2 전 팀 히트맵 포함 경기별 선수 스탯
  build_k1_xg.py            -> K1 xG 모델 데이터 구축
  fetch_venues.py           -> events (경기장 좌표)
  fetch_weather.py          -> match_player_stats (날씨)
  fetch_referees.py         -> events (심판 정보)
  fetch_injuries.py         -> player_status.json (부상자, K리그는 수동 관리 필요)

K리그 공식 API
  update_results_2026.py    -> kleague_results_2026.json (경기 결과 증분 수집)

backfill 스크립트
  backfill_k1_mps.py        -> K1 match_player_stats 누락분 보완
  backfill_match_stats.py   -> match_player_stats 일반 누락분 보완
  backfill_events.py        -> events 누락분 보완
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

## 수집 현황 (2026-06-09 기준)

| 항목 | 수치 |
|------|------|
| 2026 시즌 경기 결과 (K1+K2) | 210경기 (최신 경기일: 2026-06-07) |
| 히트맵 좌표 | 1,134,337점 |
| 수집 경기 수 | 2,862경기 |
| 경기별 선수 스탯 | 69,622건 |
| 골 이벤트 | 4,959건 |
| 등록 선수 수 | 1,747명 |

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
| `/api/match-prediction` | 경기 예측 |
| `/api/prediction-backtest` | 예측 모델 백테스트 |
| `/api/season-simulation` | 시즌 시뮬레이션 |
| `/api/predicted-lineup` | 예상 라인업 |
| `/api/standings` | K1/K2 순위표 |
| `/api/heatmap` | 선수 히트맵 좌표 (이름 기반) |
| `/api/player-matches` | 선수 경기별 스탯 |
| `/api/player-stat-report` | 선수 스탯 리포트 |
| `/api/player-analytics` | 선수 개인 분석 (활동량 지수) |
| `/api/player-vs-teams` | 선수 상대팀별 성적 |
| `/api/player-status` (CRUD) | 부상/출전정지/출전의문 관리 |
| `/api/league-dashboard` | 리그 대시보드 |
| `/api/k1/schedule`, `/api/k1/rounds` | K1 일정/라운드 |
| `/api/k2/schedule`, `/api/k2/rounds` | K2 일정/라운드 |
| `/api/kleague{1,2}/teams` | 히트맵 그리드 팀 — 현 시즌 소속(K1 12·K2 17, 수원삼성 포함) |
| `/api/kleague{1,2}/players` | 팀 현 시즌 로스터 — 히트맵 보유 선수만, 한글명 우선 |
| `/api/kleague{1,2}/heatmap` | 선수 히트맵 — **리그 무관(career), `year`·`venue=home\|away` 필터**. 응답에 `seasons=[{year,team}]`(시즌별 실소속, event+is_home 유도) |
| `/api/kleague{1,2}/position-heatmap` | 포지션(G/D/M/F) 평균 동선 — 비교 오버레이용 (`year` 필터) |
| `/api/heatmap-player-search` | 히트맵 통합 선수 검색 (K1·2 전 구단, 선수당 1줄, 최근 소속) |
| `/api/insights/top-performers` | 포지션별 TOP 퍼포머 |
| `/api/insights/xg-efficiency` | xG 효율 분석 |
| `/api/insights/forward-goals` | 공격수 득점 패턴 |
| `/api/insights/midfielder-pass` | 미드필더 패스 분석 |
| `/api/insights/defender-score` | 수비수 평점 분석 |
| `/api/insights/player-detail` | 선수 인사이트 상세 |

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
