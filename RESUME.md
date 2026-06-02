# RESUME — 다른 PC / 새 세션에서 작업 재개 가이드

> 이 파일 + `checklist/work-log-*.md` + git 커밋 기록만 보고 작업을 이어갈 수 있도록 정리.
> 최종 갱신: 2026-06-02 (HEAD 기준 최신 work-log: `checklist/work-log-2026-06-02.md`)

---

## 1. 현재 상태 (2026-06-02 종료 시점)
- **브랜치/HEAD**: `main` `620759f` (origin 동기화됨, 작업트리 clean). 최신 작업 = **선수 배너 인사이트 전면 개편** + 팀 배너 라이트잔재 다크화 + 심화 인사이트 4종(날씨·승부처·폼·활동량) + 카드 집계 정합성 + 버퍼(성능) 해소 + 승부처 시간대 차트 상세화.
- **정적 자산 최신 버전**: `insights.js?v=19`, `style.css?v=64` (변경 시 `templates/index.html`의 `?v=` 동반 증가 필수).
- **운영**: https://today-tactics.co.kr 라이브. `git push` 후 서버 `git reset --hard origin/main` + `systemctl restart today_tactics` + 라이브 검증으로 반영. (이번 세션은 매 커밋 수동 동기화)
- **데이터**: 서버가 **매주 월 05:00 cron `update_data.py` 자체 수집**. 최신 경기 5/31(R14)까지, 5/31 3경기 히트맵은 본 세션에서 수동 백필 완료.
- **세션 13커밋**: `e7401e9 → … → 4c689ac` (+ docs `4ed9194`). 상세는 work-log-2026-06-02.md.

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
# 로컬 실행 (개발: http, 로그인 우회)
#   PowerShell:  $env:FLASK_DEV="1"; $env:LOGIN_REQUIRED="0"; python main.py
python main.py                      # http://127.0.0.1:5000

# 데이터 증분 수집 (보통 서버 cron이 함, 수동은 필요 시)
python update_data.py --days 14

# 배포: git push → CI 자동배포. main.py 변경 시 운영 재시작 권장:
#   ssh -i ~/.ssh/today-project.pem rocky@<운영IP> "sudo systemctl restart today_tactics"
```
- 운영 접속 계정은 **rocky** (root 아님 — root 시도 시 fail2ban 차단). IP/도메인은 보안상 여기 미기재 → 배포 메모/팀 채널 참조.

## 4. 다음 작업 (백로그)
2026-06-02 종료 시점 후속 후보:
1. **"현재 순위"/예측 standing 소스** — `/api/team-ranking`·예측 standing은 로컬 events 자체계산이라 수집 전 오차(예: 수원삼성 9위→실제 3위, 수집 후 정상화). 근본 해결은 공식 `/api/standings`(K리그 API 실시간) 소스로 전환 — **사용자 요청으로 보류 중**. 변경 시 예측영역=Red.
2. **부팅 워밍업 동시성 완화** — 재시작 직후 ~60~90s 동안 워밍업(season-sim·prediction-backtest·인사이트 6종 ×3워커)이 2vCPU 포화 → 그 구간 응답 지연/일시 502. 워밍업 순차화 또는 activity(히트맵) **사전집계 테이블** 검토. 워밍업 URL은 프런트 기본값(`year=2026&league=all`)과 1:1 일치 유지 필수.
3. **`static/js/analytics.js` 삭제** — 팀 분석 제거로 미사용(스크립트 태그 이미 제거). 파일 삭제 + CLAUDE.md 파일 목록 갱신.
4. **비현재 라운드 round-predictions 첫 조회 ~19s**(`_predict_core`) — 워밍업 확대/스탯코어 최적화(Red) 검토.
5. **팀 배너 라이트 잔재 추가 점검** — team_compare는 원래 라이트 모달. 흰배경·저대비 텍스트 남은 곳 발견 시 `.ws-panel` 스코프 다크 오버라이드.
6. **인사이트 추가 각도** — 듀오 케미, 상대 난이도 보정, MVP 종합지수 등(데이터는 충분).

## 5. 꼭 읽을 것
- `CLAUDE.md` — 페르소나(Ralph 7인 관점) + 자율판단 매트릭스 + 절대 금지 + UI 7원칙.
- `checklist/work-log-2026-06-01.md` (오늘) 및 이전 work-log — 의사결정 맥락.
- `checklist/backlog.md`, `checklist/self-critique.md`, `checklist/review-checklist.md`.
- ⚠️ **Claude 메모리 주의**: work-log/메모의 `[[name]]` 링크는 **그 PC의 Claude 자동 메모리**(`~/.claude/projects/.../memory`)를 가리킴 → 다른 PC의 새 Claude 세션엔 없음. 이 RESUME.md와 work-log 본문은 그 메모리 없이도 이해되도록 작성됨.

## 6. 아키텍처 빠른 참조
- Backend: Flask `main.py` (~6천 줄, 30+ 엔드포인트). API 응답 인메모리 캐시(`cached_response`) + 부팅 워밍업(`_warm_cache`).
- Frontend: Vanilla JS. **`static/js/workspace.js`** = 작업공간 탭 컨트롤러(전술판/경기예측/팀/선수). `app.js`=캔버스 전술판, `prediction.js`=예측, `team_compare.js`=팀비교(다크), `insights.js`/`player_*`=선수/인사이트.
- DB: `players.db` (events, players, player_stats, heatmap_points, match_player_stats, **goal_events**=선수별 득점 분 등).
- 배포: GitHub Actions → `deploy/ci_deploy.sh`(forced-command). 수동은 `deploy/deploy.sh <IP>`(rocky).
