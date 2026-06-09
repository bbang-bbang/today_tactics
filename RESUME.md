# RESUME — 다른 PC / 새 세션에서 작업 재개 가이드

> 이 파일 + `checklist/work-log-*.md` + git 커밋 기록만 보고 작업을 이어갈 수 있도록 정리.
> 최종 갱신: 2026-06-09 (history: `checklist/history.md` 2026-06-09 섹션)

---

## 1. 현재 상태 (2026-06-09 종료 시점)
- **브랜치/HEAD**: `main` `03d209c`. **origin push + 운영 git 동기화 완료**(로컬=origin=prod 일치, prod dirty 0 · 서비스 active · 헬스 200). 로컬 작업트리는 `checklist/history.md`에 자동로그(마스킹 훅) 한두 줄이 수시로 쌓여 dirty할 수 있음(감사 로그 — 배포 무관).
- **이번 세션 핵심 (커밋 9개, history.md 2026-06-09 요약표 참조)**:
  1. **K2 미수집 8경기 수집** (6/5~6/7): 로컬 DB가 5/31 정체 → `playwright`+chromium 설치 후 `update_data.py` STEP 0~16 완주. prod는 자체수집으로 대부분 보유, 천안–수원FC 히트맵만 보강. 2026 전수감사 누락 0.
  2. **수비P 지표 재설계**: 구 공식이 공중볼·듀얼 포함+이중계상으로 공격수가 수비 상위 점령 → **수비P(순수 수비행동) / 몸싸움P(듀얼)** 2지표로 분리.
  3. **수비 세부 3컬럼 백필**(`won_tackle`·`ball_recovery`·`challenge_lost`, raw_json 추출) + **수비P 정밀화**(볼회수×0.5−피드리블). won_tackle은 커버리지 17% NULL로 미사용(totalTackle 유지).
  4. **인사이트 리더보드 표본 강화**: per-90 자격을 `mins≥90→450`(5경기)로 상향 — 소표본 왜곡(몸싸움P 1위가 284분 선수 등) 제거.
- **정적 자산 최신 버전**: `insights.js?v=37` (이번 세션 변경분). 그 외 변경 시 `templates/index.html`의 `?v=` 동반 증가 필수.
- **운영**: https://www.today-football-tactics.xyz 라이브. 배포는 **`git push origin main` → GitHub Actions가 forced-command `ci_deploy.sh`(fetch+reset+restart+health) 자동 실행**. prod에서 직접 크롤러/백필 실행 시 `venv/bin/python3` 사용(시스템 python3엔 playwright 없음).
- **데이터**: 서버가 주기 cron `update_data.py` 자체 수집. **K2 6/7까지 완비**, K1 5/17까지. **다음 라운드 2026-07-04 재개**(월드컵 휴식기) → 그 사이 경기 없음(미수집 아님). 수비 세부 3컬럼은 로컬+prod DB 모두 백필 완료.
- **⚠️ 남은 미완 1건**: 새 도메인 **OAuth 콘솔 redirect URI 등록 안 됨 → 로그인만 깨진 상태**(사이트 본체·데이터는 정상). §7 참조.

## 2. 새 PC 환경 세팅 (git에 없는 것 = gitignore)
git clone/pull 후 아래를 별도로 확보해야 **로컬 실행/배포** 가능:

| 항목 | 비고 | 확보 방법 |
|------|------|-----------|
| `players.db` (~200MB) | SQLite DB (gitignored). **prod DB가 최신** — K2 6/7까지 + 수비 세부 3컬럼(won_tackle/ball_recovery/challenge_lost) 백필 포함 | `scp -i ~/.ssh/today-project.pem rocky@1.201.126.200:/opt/today_tactics/players.db .` (권장) / 또는 `python update_data.py` 재수집(오래 걸림) |
| `today-project.pem` (+ `.pub` 사이드카) | 가비아 SSH 키 (gitignored). Windows ssh는 `.pub` 없으면 키 제시 실패 | 안전 보관처에서 복사 → `~/.ssh/`에 두고 `icacls`로 권한 제한. 없으면 `ssh-keygen -y -f <key> > <key>.pub` |
| Python venv + 의존성 | (gitignored) | `python -m venv venv && pip install -r requirements.txt` |
| Playwright chromium | 크롤러/`update_data.py` 실행 시 필수 | `playwright install chromium` (이 PC도 이번 세션에 설치함) |
| `.update_secret_local.txt` | update 트리거 시크릿 (gitignored) | 필요 시 재생성 |
| `saves/`, `squads/{team}_2026.json` 일부 | 사용자 저장물 (gitignored) | 없어도 앱 기동 가능 |

## 3. 로컬 실행 / 배포
```bash
# 로컬 실행 (개발: http, 로그인 우회) — debug=True 라 템플릿/정적 즉시 반영
python main.py                      # http://127.0.0.1:5000

# 데이터 증분 수집 (보통 서버 cron이 함)
python update_data.py --days 14

# 배포(이번 세션 방식: 변경 파일만 scp + 재시작) — rocky 계정
KEY=~/.ssh/today-project.pem; R=rocky@<운영IP>; APP=/opt/today_tactics
scp -i $KEY static/js/analytics.js static/js/workspace.js $R:$APP/static/js/
scp -i $KEY static/css/style.css   $R:$APP/static/css/
scp -i $KEY templates/index.html   $R:$APP/templates/
ssh -i $KEY $R "sudo systemctl restart today_tactics"   # 템플릿 변경 시 재시작 필요
```
- 운영 접속 계정은 **rocky** (root 아님 — root 시도 시 fail2ban 차단). 운영 IP는 보안상 여기 미기재(배포 메모/Claude 메모리 `deployment_target` 참조).
- `deploy/deploy.sh <IP>` 는 DB까지 포함한 풀배포(느림). 정적/템플릿만이면 위 부분 scp가 빠름.

## 4. 다음 작업 (백로그)
2026-06-05 종료 시점 후속 후보:
1. **(우선) 새 도메인 OAuth 콘솔 등록** — Google/Kakao/Naver 각 콘솔에 `https://www.today-football-tactics.xyz/auth/callback/{provider}` redirect URI 추가. 미등록 시 로그인 불가. 등록 후 로그인 플로우 검증. (코드 변경 불필요 — `url_for(_external=True)`로 Host 동적.)
2. **mps team_id 오태깅 영향 점검** — `match_player_stats.team_id`에 팀 비참가 경기 오태깅 행 존재(ulsan 382건, §10). team-insights는 참가 필터로 처리했으나 **league-rankings의 xG/태클 등 mps 집계도 같은 패턴이라 잠재 오염**(미점검). 점검 후 필요 시 동일 필터 적용. → Claude 메모리 `reference_mps_team_id_contamination`.
3. **R16 재개(07-04) 후 데이터 검증** — 월드컵 휴식 후 첫 수집. 06/08·06/15 등 월요일 cron이 빈 수집으로 무해한지, 07-04 이후 정상 증분되는지 확인.
4. **부팅 워밍업 동시성 완화** — 재시작 직후 ~60~90s 워밍업이 2vCPU 포화 → 일시 지연/502. 워밍업 순차화/사전집계 검토. (team-insights는 워밍업 URL 미포함 — 팀 선택 후 호출이라 무관.)
5. **"현재 순위"/예측 standing 소스** — 로컬 events 자체계산이라 수집 전 오차. 공식 `/api/standings` 전환은 **사용자 보류 중**. 변경 시 예측영역=Red.
6. **인사이트 추가 각도** — 라운드별 리그 순위 추이, 리드 관리력(역전/리드상실), 듀오 케미, 상대 난이도 보정 등. (이번 세션 4종 외 후보.)

## 5. 꼭 읽을 것
- `CLAUDE.md` — 페르소나(Ralph 7인 관점) + 자율판단 매트릭스 + 절대 금지 + UI 7원칙 + 런타임 아키텍처(캐시/워밍업/인증/스케줄러).
- `checklist/work-log-2026-06-04.md` (이번 세션) 및 이전 work-log — 의사결정 맥락.
- `checklist/backlog.md`, `checklist/self-critique.md`, `checklist/review-checklist.md`.
- ⚠️ **Claude 메모리 주의**: work-log/메모의 `[[name]]` 링크는 **그 PC의 Claude 자동 메모리**를 가리킴 → 다른 PC의 새 Claude 세션엔 없음. 이 RESUME.md와 work-log 본문은 그 메모리 없이도 이해되도록 작성됨.

## 6. 아키텍처 빠른 참조
- Backend: Flask `main.py` (~7,600줄, 45+ 엔드포인트). API 인메모리 캐시(`@cached_response`) + 부팅 워밍업(`_warm_cache`) + 인증게이트 + 내장 스케줄러.
- Frontend: Vanilla JS. **`static/js/workspace.js`** = 작업공간 탭 컨트롤러(전술판/경기예측/**팀**/선수). **'🛡 팀' 탭은 모드 토글**: `[📊 단일 팀 분석]`(=`analytics.js`/`#team-analysis-modal`) ↔ `[⚖️ 팀 비교]`(=`team_compare.js`/`#team-compare-modal`). 두 모달을 패널에 `appendChild` 인라인 + 모드별 show/hide.
- 팀 분석 백엔드: `/api/team-analytics`(상대팀별·월별·홈원정·날씨), `/api/team-trend`(경기별 시계열), `/api/league-rankings`(고급 11지표+리그순위), **`/api/team-insights`**(시간대 득실·선제골·xG누적·득점기여 — 2026-06-05 신규, §10).
- 단일 팀 분석 모달(`#team-analysis-modal`) = **3탭**: 📋 결과 분석 / 📈 심화 인사이트 / 📡 스킬 프로필. `analytics.js`가 4개 엔드포인트(team-analytics/trend/league-rankings/team-insights) Promise.all 오케스트레이션.
- DB: `players.db` (events, players, player_stats, heatmap_points, match_player_stats, **goal_events**=선수별 득점 분 등).
- 배포: GitHub Actions → `deploy/ci_deploy.sh`(forced-command). 수동은 `deploy/deploy.sh <IP>`(rocky) 또는 변경 파일 scp(§3).

## 7. 운영 도메인 전환 (2026-06-04 완료)
- canonical = **`www.today-football-tactics.xyz`**. apex(`today-football-tactics.xyz`)·구 도메인(`today-tactics.co.kr`)·IP 직접 접근은 전부 **301 → canonical** 통합.
- 가비아 DNS A레코드(apex/www) → 운영 IP. 가비아 네임서버(ns/ns1/ns2.gabia.co.kr).
- Let's Encrypt 인증서: `/etc/letsencrypt/live/today-football-tactics.xyz/` (apex 첫 `-d` → live 디렉터리명), SAN apex+www, `certbot certonly --webroot -w /var/www/certbot`, **자동 갱신 등록**, 만료 2026-09-02.
- nginx: `deploy/today_tactics.nginx` 재작성(canonical www 본서버 + apex/구도메인/HTTP 301 블록). 서버 `/etc/nginx/conf.d/today_tactics.conf`. 구 nginx는 서버 `/tmp/today_tactics.conf.bak.*` 백업.
- 구 도메인 `today-tactics.co.kr`은 공개 DNS에서 이미 NXDOMAIN(만료/소멸) — 301 블록은 무해한 잔재.
- 코드: `main.py:103` 쿠키 secure 주석만 도메인 참조(동작 무관). OAuth redirect는 `url_for(_external=True)`로 요청 Host 동적 → 코드 수정 불필요, 단 **각 OAuth 콘솔에 새 callback 등록 필요**(§4-1, 미완).

## 8. 단일 팀 종합 분석 대시보드 (2026-06-04 신규)
- **배경**: `analytics.js`(옛 팀분석=상대팀별 1차트)가 리디자인 때 "비교와 중복"으로 제거되며 스크립트 미로드 + 진입 버튼은 `#analytics-widget-area{display:none}`에 갇힌 고아 상태였음. 백엔드 3종은 멀쩡히 데이터 제공 중이었음.
- **신규 구현**(프론트 중심, 백엔드 0줄): `analytics.js` 전면 재작성 → `#team-analysis-modal`(다크 테마) 2탭:
  - **📋 결과 분석**: 시즌 득/실 트렌드(누적승점 막대) · 월별 승률 · 홈/원정 · 상대팀별 전적(바+표) · 날씨별 승률(기온/습도/풍속).
  - **📡 스킬 프로필**: 고급 11지표 **레이더(리그 백분위, 평균 50% 기준선)** + 지표별 값·**리그 순위 뱃지**·평균 대비 막대.
- **진입점**: '🛡 팀' 탭 모드 토글(§6). 기본=단일 팀 분석. `workspace.js`가 두 모달 인라인 + `setTeamMode()` 로 전환, 최초 노출 시 기존 트리거(`#btn-analytics`/`#btn-team-compare`) 1회 click 으로 초기화.
- 검증: 헤드리스(Playwright) 실제 탭 플로우 + 토글 전환 콘솔 에러 0 / 4xx 0. 운영 라이브 확인 완료.

## 9. 🐛 team-analytics K1 tournament_id 버그 수정 (2026-06-05)
- **증상**: 단일 팀 분석 '결과 분석' 탭이 K1 팀에게 2026 데이터를 거의 안 보여줌(사용자 체감 "K1 데이터 이상").
- **원인**: `get_team_analytics`가 모든 쿼리에서 `tournament_id=777`(K2) 하드코딩. 형제 `team-trend`는 `tid = 410 if K1 else 777`로 올바름 → K1 팀은 리그(410)가 아닌 777 대회 조회.
- **수정**: ① `tid = 410 if league=="K1" else 777` 분기 + 6개 서브쿼리 파라미터 바인딩 ② `home_score IS NOT NULL` 필터 추가(team-analytics엔 누락 → 미진행 미래 경기가 승률 분모에 섞이던 것 제거). K2 회귀 없음.
- ⚠️ tournament_id 410/777은 깔끔한 리그 구분 아님(ulsan tid=777에 K1 상대 경기 섞임). 단일 팀 "리그 경기" 집계는 `tid = 410 if K1 else 777` + 참가/점수 필터 조합이 현재 기준.

## 10. 심화 인사이트 탭 + /api/team-insights (2026-06-05 신규)
- **백엔드 `get_team_insights`** (goal_events + match_player_stats, 치른 경기만): `goal_timing`(15분6버킷 득/실), `first_goal`(선제득점 vs 선제실점→W/D/L), `xg_cumulative`(누적 xG vs 실득점), `scorers`(선수별 득점+도움 top8). 캐시 `@cached_response(3600)`.
- **프론트 '📈 심화 인사이트' 탭 4종**: ⏱ 시간대 · ⚡ 선제골 영향 · 🎯 xG vs 실제 득점 누적 · 🥇 득점 기여 분포. fetch는 fail-soft(`.catch(()=>({}))`).
- **프루닝됨**: 🥊 파울 성향(discipline) — 카드 미수집+과거 파울 희소로 제거(`fe63b9d`).
- **⚠️ 데이터 정합성**: `match_player_stats.team_id`에 **팀 비참가 경기 오태깅 행**(ulsan team_id=7653인데 비참가 382건). mps 집계 시 `(e.home_team_id=? OR e.away_team_id=?)` 참가 필터 필수. **2026 단일시즌은 오염 없어 연도필터 시 안 드러남 — 전체 집계에서만 터짐.** league-rankings xG 등 동일 패턴 잠재 영향(백로그 §4-2). 또 mps의 yellow/red_cards 전부 NULL, player_name NULL(→players.name_ko 조인).
