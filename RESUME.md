# RESUME — 다른 PC / 새 세션에서 작업 재개 가이드

> 이 파일 + `checklist/work-log-*.md` + git 커밋 기록만 보고 작업을 이어갈 수 있도록 정리.
> 최종 갱신: 2026-06-04 (work-log: `checklist/work-log-2026-06-04.md`)

---

## 1. 현재 상태 (2026-06-04 종료 시점)
- **브랜치/HEAD**: `main` — 이번 세션 3커밋 `d4f7399`(도메인) → `b434f35`(팀분석 대시보드) → `6c07945`(팀 탭 통합) + 본 문서 커밋. **origin push 완료**, 작업트리 clean.
- **이번 세션 핵심 2가지**:
  1. **운영 도메인 전환** — `today-tactics.co.kr` → **`www.today-football-tactics.xyz`** (canonical). 상세 §7.
  2. **단일 팀 종합 분석 대시보드 신규** — 죽어있던 `analytics.js` 부활 + '🛡 팀' 탭 통합. 상세 §8.
- **정적 자산 최신 버전**: `style.css?v=72`, `analytics.js?v=2`, `workspace.js?v=5` (이번 세션 변경분). 그 외 `insights.js?v=27`, `prediction.js?v=59`, `team_compare.js?v=12` 유지. 변경 시 `templates/index.html`의 `?v=` 동반 증가 필수.
- **운영**: https://www.today-football-tactics.xyz 라이브. 이번 세션 배포는 **변경된 static/templates만 scp + `systemctl restart today_tactics`** (서버 git pull 아님 — 서버 코드와 git이 어긋날 수 있으니 다음 세션은 서버에서 `git pull` 정합성 한번 확인 권장).
- **데이터**: 서버가 **매주 월 05:00 cron `update_data.py --days 14` 자체 수집**. 최신 진행 경기 **2026-05-31(R14)**. 5/31 이후 오늘(6/4)까지 경기 없음(리그 휴식기) → 5/31까지가 정상 최신. **다음 라운드 6/5~6/7 → 6/8(월) 새벽 자동 반영**.
- **⚠️ 남은 미완 1건**: 새 도메인 **OAuth 콘솔 redirect URI 등록 안 됨 → 로그인만 깨진 상태**(사이트 본체·데이터는 정상). §7 참조.

## 2. 새 PC 환경 세팅 (git에 없는 것 = gitignore)
git clone/pull 후 아래를 별도로 확보해야 **로컬 실행/배포** 가능:

| 항목 | 비고 | 확보 방법 |
|------|------|-----------|
| `players.db` (~190MB) | SQLite DB (gitignored) | 서버 `/opt/today_tactics/players.db` 또는 일일 백업(03시)에서 scp / 또는 `python update_data.py` 재수집 |
| `today-project.pem` | 가비아 SSH 키 (gitignored) | 안전 보관처에서 복사 → `~/.ssh/`에 두고 권한 제한 |
| Python venv | (gitignored) | `python -m venv venv && pip install -r requirements.txt` |
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
2026-06-04 종료 시점 후속 후보:
1. **(우선) 새 도메인 OAuth 콘솔 등록** — Google/Kakao/Naver 각 콘솔에 `https://www.today-football-tactics.xyz/auth/callback/{provider}` redirect URI 추가. 미등록 시 로그인 불가. 등록 후 로그인 플로우 검증. (코드 변경 불필요 — `url_for(_external=True)`로 Host 동적.)
2. **서버 git 정합성 확인** — 이번 세션 배포가 scp 직접 덮어쓰기라 서버 작업트리가 origin과 다를 수 있음. 서버에서 `git fetch && git status` 확인, 어긋나면 `git reset --hard origin/main` 후 재시작.
3. **단일 팀 분석 후속** — K2 팀/연도 필터 조합 추가 점검(선제득점 지표는 goal_events 커버리지 의존, 표본<3이면 '표본부족' 처리됨). 레이더 축 라벨 가독성, 모바일 폭 추가 튜닝 여지.
4. **부팅 워밍업 동시성 완화** — 재시작 직후 ~60~90s 워밍업이 2vCPU 포화 → 일시 지연/502. 워밍업 순차화/사전집계 검토.
5. **"현재 순위"/예측 standing 소스** — 로컬 events 자체계산이라 수집 전 오차. 공식 `/api/standings` 전환은 **사용자 보류 중**. 변경 시 예측영역=Red.
6. **인사이트 추가 각도** — 듀오 케미, 상대 난이도 보정, MVP 종합지수 등.

## 5. 꼭 읽을 것
- `CLAUDE.md` — 페르소나(Ralph 7인 관점) + 자율판단 매트릭스 + 절대 금지 + UI 7원칙 + 런타임 아키텍처(캐시/워밍업/인증/스케줄러).
- `checklist/work-log-2026-06-04.md` (이번 세션) 및 이전 work-log — 의사결정 맥락.
- `checklist/backlog.md`, `checklist/self-critique.md`, `checklist/review-checklist.md`.
- ⚠️ **Claude 메모리 주의**: work-log/메모의 `[[name]]` 링크는 **그 PC의 Claude 자동 메모리**를 가리킴 → 다른 PC의 새 Claude 세션엔 없음. 이 RESUME.md와 work-log 본문은 그 메모리 없이도 이해되도록 작성됨.

## 6. 아키텍처 빠른 참조
- Backend: Flask `main.py` (~7,600줄, 45+ 엔드포인트). API 인메모리 캐시(`@cached_response`) + 부팅 워밍업(`_warm_cache`) + 인증게이트 + 내장 스케줄러.
- Frontend: Vanilla JS. **`static/js/workspace.js`** = 작업공간 탭 컨트롤러(전술판/경기예측/**팀**/선수). **'🛡 팀' 탭은 모드 토글**: `[📊 단일 팀 분석]`(=`analytics.js`/`#team-analysis-modal`) ↔ `[⚖️ 팀 비교]`(=`team_compare.js`/`#team-compare-modal`). 두 모달을 패널에 `appendChild` 인라인 + 모드별 show/hide.
- 팀 분석 백엔드(전부 기존 존재): `/api/team-analytics`(상대팀별·월별·홈원정·날씨), `/api/team-trend`(경기별 시계열), `/api/league-rankings`(고급 11지표+리그순위).
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
