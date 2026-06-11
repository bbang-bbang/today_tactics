# Backlog — Today Tactics

> 작업 끝나면 이 파일을 업데이트해 항목을 옮기거나 삭제. 시간순 기록은 `work-log-YYYY-MM-DD.md`.

---

## 🔴 P1 — 가치 큰 단기 작업

### [ ] Google OAuth 발급 + LOGIN_REQUIRED=1 활성화 — 2026-06-01 진행 중

**상태**: Google Cloud Console에서 OAuth 앱 등록 대기 중

**필요한 것**:
- [Google Cloud Console](https://console.cloud.google.com) → OAuth 2.0 클라이언트 ID 발급
- 콜백 URL 등록: `https://today-tactics.co.kr/auth/callback/google`
- 획득: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

**Gabia 서버 적용 명령** (발급 후 SSH로 실행):
```bash
ssh -i ~/today-project.pem rocky@1.201.126.200
sudo systemctl edit today_tactics
# 아래 3줄 추가:
# Environment="GOOGLE_CLIENT_ID=<발급값>"
# Environment="GOOGLE_CLIENT_SECRET=<발급값>"
# Environment="LOGIN_REQUIRED=1"
sudo systemctl daemon-reload && sudo systemctl restart today_tactics
```

**확인**: `https://today-tactics.co.kr/login` → Google 로그인 버튼 동작 확인

**효과**: saves/squads 쓰기가 로그인 사용자만 가능 (현재는 LOGIN_REQUIRED=0으로 누구나 쓸 수 있음)

---

## 🟡 P2 — 시간 날 때 처리

### [x] ~~5/22 K1 미래 매치 1건 매칭 실패~~ — 5/8 처리 완료
events.id=90333089 (Jeonbuk vs Daejeon, 슈퍼컵 추정)을 DB에서 직접 삭제. 백업: `players_pre_synthetic_delete_20260508_101752.db`. K1 12팀 모두 12경기로 일관성 회복.

---

### [x] ~~shotmap 좌표 백엔드에서 정규화 — 프론트 변환 임시 fix~~ — 2026-06-11 확인: 해결됨
API 레벨 정규화 채택. `/api/match-extras`가 `shots` 응답 생성 시 `x = 100 - x`로 일괄 변환(main.py 7927~7934, "자기 골=x=0" 통일). 프론트 `drawShotmap`은 `mapPos(s.x, ...)` 직접 호출 + 주석 "정규화는 백엔드에서 완료 — 프론트 변환 불필요"(prediction.js:1784)로 100-x 제거됨 → 이중변환 없음.
- 남은 선택(미진행): crawler 저장 시점 변환 + DB 1회 마이그레이션. API 레벨로 외부 일관성 확보됐으므로 ROI 낮아 보류.

---

### [x] ~~events.home_score/away_score 직접 비교 일괄 점검~~ — 5/15 완료
`team_stats()` UNION 서브쿼리 4블록(month_wr, clean_sheet/blank, close_games, big_score)에 `home_score IS NOT NULL AND away_score IS NOT NULL` 가드 추가. commit `33f4a73`. qa_check 31/31 PASS.

---

### [x] ~~deploy 자동화 — push → 운영 pull/restart~~ — 5/15 완료
GitHub Actions 워크플로우 `.github/workflows/deploy.yml` 추가. push to main 시 SSH로 git pull → restart → health check 자동. commit `a6af065`. secrets(SSH_HOST/USER/PRIVATE_KEY) 등록 + 보안그룹 22번 0.0.0.0/0 허용 필요. rocky 사용자(root 거부됨).

---

### [x] ~~mps.player_name NULL 73% — 데이터 수집 단계 결손~~ — 2026-05-27 완료
`crawlers/fetch_player_names.py` (SofaScore `/api/v1/player/{id}`) 가비아 실행으로 백필 완료. NULL 51,064 → 0, 68,982건 이름 채움. 1,575 고유 player_id 처리(SSH reset로 2회 분할 실행, 스크립트가 `WHERE player_name IS NULL`로 self-resume). 영문명 저장 + 한글은 players.name_ko JOIN(고유 1,726 중 1,551 커버, 나머지는 외국인). venv python 필수(`./venv/bin/python`). 근본 원인(crawl 단계 결손)은 미해결이나 fetch_player_names 정기 실행으로 보강 가능.

---

### [x] ~~players row 누락 1,200명+ 백필~~ — 2026-05-22 확인 시점 이미 해결
2026-05-22 재검증 시 `mps.player_id ∉ players.id` 누락 **0건**. mps unique player_id 1,717개 모두 players(1,734개)에 존재. 백로그 예시 pid=1046525도 정상("Byeon Jun-soo", 변준수). 사이 시점에 데이터 수집 흐름 보강 또는 백필이 진행된 것으로 추정. 별도 작업 불필요.

---

### [x] ~~K1 xG 데이터 백필~~ — 5/15 완료
build_k1_xg.py 로컬+운영 양쪽 실행. 945/950 매치 처리, mps 12,976 rows xG 업데이트, ratio 1.07 (Understat급 근접). 백테스트 결과 hit_1x2 변화는 미미(43~45%, 베이스 33% 대비 +10~12%p) — 예측 정확도엔 큰 영향 없었지만 Insights xG 효율 리더보드 가시화 완료. commit ssh로 직접 DB 갱신(코드 변경 0).

---

### [ ] (closed) 매치 상세에 팀 스타일 매치업 카드 — 5/15 완료
mps 미노출 시즌 데이터(long_balls, crosses, duel, aerial, dribbles)를 매치 상세에 시각화. commit `d129aaa`. P1/P3/P5 동시 가치.

### [ ] (closed) Insights에 K1 xG 효율 리더보드 — 5/15 완료
/api/insights/xg-efficiency 백엔드 있는데 프론트 미연결 상태였음. league/모드 탭 추가, TOP 15 노출. commit `af364ea`.

---

### [x] ~~synthetic event `90333089` 정리~~ — 2026-05-22 완료
Jeonbuk vs Daejeon 슈퍼컵 추정 (2026-02-21, 2:0). 다운스트림 8개 테이블(heatmap_points, match_player_stats, goal_events, match_lineups, card_events, match_avg_positions, match_shotmap, sub_events) 참조 0건 확인 후 단일 row DELETE. 로컬·가비아 양쪽 백업(`players_pre_synthetic_90333089_delete_*.db`) + 파라미터 바인딩 SQL(P7 안전).

---

### [x] ~~5/9 K1 2매치 전술 데이터 — Gimcheon vs Incheon, Gwangju vs Gangwon~~ — 2026-06-11 확인: 채워짐
이후 cron 자동 재시도로 수집 완료. Gimcheon vs Incheon(`ev15373001`) avg_pos=32·shotmap=18·heatmap=1410, Gwangju vs Gangwon(`ev15373003`) avg_pos=32·shotmap=26·heatmap=1398. 로컬·운영 양쪽 6/9 전수 감사에서 누락 0 확인.

---

### [x] ~~5/5 K1 R11 3매치 히트맵~~ — 2026-06-11 확인: 채워짐
강원-포항(`ev15372989`) hm=1335, 대전-인천(`ev15372991`) hm=1567, 김천-울산(`ev15372995`) hm=1370. mps 40명/경기 정상. cron STEP 6 자동 재시도로 회복됨.

---

### [ ] 가비아 방화벽 SSH 화이트리스트
**왜**: 봇 트래픽 0으로 만들 수 있음.
**조건**: 본인 공인 IP 고정 여부 확인 필요. 동적이면 안 함 (락아웃 위험).

---

### [x] ~~HTTPS 적용~~ — 5/15 확인: 이미 적용됨
운영 상태 점검 결과 today-tactics.co.kr 메인 도메인이 today_tactics 프로젝트로 이미 매핑·HTTPS 적용·HSTS 활성. today_alarms는 alarms.today-tactics.co.kr 서브도메인 사용. backlog 라인 가정 오류였음.

---

### [x] ~~매치 상세 — 카드 통계 노출~~ — 5/15 완료
prediction.js에 cardsCardHtml() 헬퍼 추가, /api/match-prediction에 home/away.cards (games/yellow/red/y_per_game/r_per_game). 자동 인사이트(거친 운영/퇴장 잦음). commit `0d17857`.

---

### [x] ~~라운드 변경 시 매치 캐시 초기화~~ — 5/15 완료
prediction.js 라운드 버튼 핸들러에 `clearMatchContext()` 추가, prev !== rnd 가드. commit `15c05e5`. 사이드바 메뉴 동기화는 명확한 핸들러 부재 + 사용자 의향 확인 항목이라 별도 미룸.

---

## ⚫ P3 — 의식적으로 안 함

- ❌ Git history rewrite (PM 권고: ROI 음수)
- ❌ history.md 과거 노출 정리 (rewrite 없이 의미 X)
- ❌ 2020 시즌 17매치 avg_positions/shotmap/lineup 미보유 — SofaScore 자체 부재라 회복 불가
- ❌ 패스맵 (선수 간 패스 네트워크) — SofaScore + K리그 포털 둘 다 미공개

---

## 📌 운영 메모

- **서버 배포**: `git push` → 서버 `git pull` → `sudo systemctl restart today_tactics`. DB는 `scp players.db rocky@<HOST>:/opt/today_tactics/`
- **민감 정보**: history.md 자동 로그에 SSH 명령 들어가면 push 전 마스킹 필수
- **서버 path**: `/opt/today_tactics` (deploy.sh 기준)
- **포트 5000 점유 정리**: `Get-NetTCPConnection -LocalPort 5000 | Stop-Process -Id $_.OwningProcess -Force`
- **백업**: `/var/backups/today_tactics/players_YYYYMMDD.db.gz` (30일 보관, backup.sh chmod +x 필수)
- **자동화 cron**: 월 05:00 KST `update_data.py` (15 STEP, ~50분, K리그 공식 + SofaScore + 포털 종합)

---

## 🔧 자동 수집 파이프라인 (update_data.py 15 STEP)

| STEP | 작업 | 출처 |
|------|------|------|
| 0 | K리그 공식 일정·결과 | kleague.com |
| 1 | events 동기화 | DB ↔ JSON |
| 2 | synthetic → 실제 ID | SofaScore |
| 3 | 라인업 | SofaScore |
| 4~5 | mps K1+K2 | SofaScore |
| 6 | 히트맵 | SofaScore |
| 7~8 | incidents K1+K2 | SofaScore |
| 9 | venue 좌표 | SofaScore + Nominatim |
| 10 | weather | Open-Meteo |
| 11 | player master | SofaScore |
| 12 | K리그 포털 JSON | portal.kleague.com |
| 13 | name_ko + 신체정보 | K리그 포털 |
| 14 | avg_positions + shotmap | SofaScore |
| 15 | K리그 포털 formation | portal.kleague.com |
