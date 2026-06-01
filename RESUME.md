# RESUME — 다른 PC / 새 세션에서 작업 재개 가이드

> 이 파일 + `checklist/work-log-*.md` + git 커밋 기록만 보고 작업을 이어갈 수 있도록 정리.
> 최종 갱신: 2026-06-01 (HEAD 기준 최신 work-log: `checklist/work-log-2026-06-01.md`)

---

## 1. 현재 상태 (2026-06-01 종료 시점)
- **브랜치/HEAD**: `main` (origin 동기화됨). 최신 작업 = 작업공간 탭 IA 개편 + 팀차트 다크화 + H2H 득점시간 + 라운드예측 성능.
- **운영**: https://today-tactics.co.kr 라이브. `git push` 시 **CI 자동배포**(가비아 HEAD 자동 반영). main.py 변경분은 서비스 재시작 필요할 수 있음.
- **데이터**: 서버가 **매주 월 05:00 cron으로 `update_data.py` 자체 수집** → 데이터 수동 배포 대개 불필요. 최신 경기 5/31(R14)까지.

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
work-log-2026-06-01.md 10장 발췌:
1. **xG 결정력·수비효율 인사이트** — team-compare에 xG-against 없음(백엔드 추가 필요) + 기존 xG 계산(선수단위 AVG) **정합성 검증 먼저**. 스탯 왜곡은 P4/도박맨 Red.
2. **경기예측 탭 실브라우저 확인** — 헤드리스에선 스케줄 캐시 콜드 타이밍으로 "분석 중" 멈춤 관측됨. 성능 픽스(스케줄 메모이즈)로 완화됐을 것이나 실제 브라우저 최종 확인 필요.
3. **`static/js/analytics.js` 삭제** — 팀 분석 제거로 미사용(스크립트 태그 이미 제거). 파일 삭제 + CLAUDE.md 파일 목록 갱신.
4. 비현재 라운드 round-predictions 첫 조회 ~19s(`_predict_core`) — 워밍업 범위 확대 또는 스탯코어 최적화(Red) 검토.
5. 5/31 3경기 포지셔널(히트맵/avg_pos) — SofaScore 발행 후 다음 cron 자동 보강(자가복구).

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
