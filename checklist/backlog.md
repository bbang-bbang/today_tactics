# Backlog — Today Tactics

> 작업 끝나면 이 파일을 업데이트해 항목을 옮기거나 삭제. 시간순 기록은 `work-log-YYYY-MM-DD.md`.

---

## 🔴 P1 — 가치 큰 단기 작업

### [x] ~~K2 PO·승강 PO 경기가 K1(tournament_id=410)으로 저장됨~~ — 2026-11-03 해결 (사용자 위임 → 선택지 ②를 데이터 교정 방식으로)
- **해결**: `crawlers/reclassify_playoffs.py`(update_data **STEP 26**, 멱등)가 시즌별로 '410 경기 수가 리그 최다의 25% 미만인 외부 팀'이 낀 410 경기를 `tournament_id=9410`(합성 'K리그 PO')으로 옮긴다. 시즌 최다 20경기 미만이면 판정 보류(개막 직후 오분류 방지). 삭제가 아니라 이동이라 대회 무관 화면(선수 경기 목록 등)엔 남는다. H2H는 `kleague_h2h.json` 기반이라 영향 없음(PO 포함 유지).
- 로컬 결과: 2022(5)·2024(4)·2025(5) = 14건, 실제 PO 일정과 전부 일치, 정규 경기 오탐 0. K1 2022·2025 랭킹에서 당시 K2 팀 제거, 제주 2025 39→37경기, 2026 응답 불변. `qa_check` 'K1(410)에 PO 경기 잔류 0' 추가.
- **운영 반영**: 배포 후 다음 월 05:00 크론(STEP 26)에서 자동 적용. 즉시 반영하려면 서버에서 `./venv/bin/python crawlers/reclassify_playoffs.py --apply` 후 캐시 세대 갱신(또는 재시작).
- 아래는 발견 당시 기록.
- **사실**: 2025 K2 PO(부천-성남 11/30, `15154634`)와 승강 PO 4경기(`15167982`·`15167983`·`15168024`·`15168025`, 12/3~12/8)가 `events.tournament_id=410`이고, mps가 경기당 36행 들어 있다. K1 2025 집계에 부천(3)·성남(1)·수원삼성(2)이 K1 팀처럼 섞인다. `EXCLUDED_EVENT_IDS`에는 슈퍼컵 1건뿐이다.
- **2026 영향(예상)**: 11월 말~12월 PO가 또 410으로 들어오면 K1 순위·league-rankings·팀 분석·패스 허브·경기 요약 '순위 변동'·예측 standing이 오염되고 K2 팀이 K1 표에 나타날 수 있다.
- **선택지**: ① 2025 5건을 `EXCLUDED_EVENT_IDS`에 추가하고 2026 PO는 발생 후 수동 추가(빠름, 반복 작업) ② 수집 단계(`sync_results_to_events`/공식 API meet 코드)에서 PO를 별도 tournament로 분리(근본 해결, 크롤 로직 = Red) ③ 정규 라운드 종료일 이후 경기를 리그 집계에서 제외. H2H에는 PO를 포함할지도 함께 결정.
- 리스크 등급: 통계 정의·마스터 데이터 = **Red**(사용자 확인 필수).

### [ ] 2027 시즌 연도 전환 준비 (2027 개막 전, 2026-11-03 점검)
- 하드코딩 '2026': `main.py` 41곳(엔드포인트 기본 `year="2026"` 다수, `_warm_cache` URL, 다년도 IN 목록 `('2024','2025','2026')`), JS 18곳(`app.js` 8·`insights.js` 5·`prediction.js` 4·`k2heatmap.js` 1), 파이프라인 `update_results_2026.py`(→ `kleague_results_2026.json`)·STEP 16 `--years 2026`·`fetch_next_round.py`의 `2026-01-01`.
- 승강 결과로 `TEAMS`의 league 필드·스쿼드 파일 변경 필요(마스터 데이터 = Red).
- 비시즌 자체는 안전: `audit_collection_gaps.py`는 공백을 '마지막 종료 경기' 기준으로 재므로 경기가 없어도 오탐하지 않음. 크롤러들도 경기 0건일 때 명시적 실패 코드를 내지 않음(예외 발생 시는 별개 — 첫 비시즌 크론 로그 확인 권장).

### [ ] 🚨 SofaScore 수집 중단 (2026-08-02~) — 조용히 실패 중 (2026-11-01 발견)

**증상**: 경기 요약 카드 타임라인 공백 조사 중 발견. K1·K2 모두 득점/카드/교체 incidents·라인업·슈팅맵·평균 위치·히트맵이 **2026-08-02 경기 이후 0%** (`python analysis/audit_collection_gaps.py`). 예외: K1 선수 스탯(평점)만 10-24까지 94~96% 유지, K2는 mps까지 전부 중단. (6월은 휴식기라 경기 없음.)
**직접 원인(확정)**: SofaScore API가 `403 {"error":{"code":403,"reason":"challenge"}}`(봇 차단 챌린지)를 반환. 2026-11-01 로컬 Playwright(크롤러와 동일 방식)로 incidents/lineups/shotmap 전부 403 — **이전에 수집 성공했던 8월 경기도 동일**하므로 경기 문제가 아니라 접근 차단. (운영 서버의 현재 응답은 SSH 미접속이라 미확인 — 로컬 덤프 기준 판단.)
**왜 몰랐나(구조 결함)**: `collect_goal_incidents.py` 등이 응답 `null`이면 `skip`만 하고 **exit 0** → `update_data.py`가 `STEP OK`로 보고. STEP 3~19는 `fail_ok=True`라 실패해도 계속 진행.
**파급**: 2026 xG 커버리지(K1 72%·K2 60%), 세트피스 프로필의 슈팅 대체, 교체·득점 타임라인, 경기 요약 카드 타임라인 공백, 스카우팅 요약 경고 — 모두 이 중단의 결과이며 **시즌이 진행될수록 악화**. 과거 시즌(≤2025, 2026-07까지) 분석은 영향 없음.

**방침 / 선택지** (사용자 결정 대기):
1. ✅ **가시화 — 2026-11-01 적용 (사용자 승인)**: ①`crawlers/fetch_health.py` — 크롤러 5종(incidents·lineups·avg-positions/shotmap·mps 백필·heatmap)이 본 수집 전에 **같은 엔드포인트로 1건 probe**해 403이면 즉시 `exit 3`, 5건↑ 시도에 성공 0이면 `exit 3`(우회 아님, 감지만). ②`update_data.py` — `run_step`이 fail_ok여도 실패를 `failures`에 집계(기존엔 항상 '모든 STEP 정상'), 종료 코드 0=정상/1=치명(STEP 0~2)/**2=부분 실패**, 부분 실패여도 캐시 무효화 유지, 마지막에 STEP 20 `audit_collection_gaps --summary-only`. ③`main.py` 스케줄러 — 종료 코드 2를 `last_result="partial"`로 기록(캐시 초기화·경기 추가 반영은 정상 수행), ④헤더 신선도 배지에 `⚠ 일부 미수집` 표시. 모의 실패 주입으로 종료 코드·캐시 동작 3개 시나리오 검증, 실제 차단 환경에서 크롤러 4종 exit 3 확인.
   - 알려진 잔여: `fetch_event_heatmap.py`는 대상을 `match_lineups`/mps에서 유도해, 라인업이 비면 "이미 모두 수집됨"(exit 0)이라고 오인 보고 — 라인업 차단의 연쇄 증상(근본 해결은 소스 복구).
2. ✅ **소스 대체 — K리그 공식 API로 득점·카드·교체 복구 구현 완료 (2026-11-01, 사용자 승인)**
   - **발견**: `kleague.com` 경기 페이지가 내부적으로 호출하는 JSON API `POST /api/ddf/match/*.do` (form: year, meetSeq, gameId — 값은 `kleague_event_map`에 이미 있음). 7~10월 K1·K2 **전 경기 100% 매핑**, SofaScore 차단과 무관하게 동작(기존 `getScheduleList.do`와 같은 계열).
   - **`matchInfo.do`** = 전·후반 이벤트 피드: 득점·**도움**·경고·퇴장·교체(IN/OUT, 일반/부상 구분)·자책골·유효슈팅·파울 + 팀 K-ID·선수 K-ID·등번호·이름·시각. **SofaScore 수집분과 8경기 대조 결과**: 득점자 이름 8/8 일치·득점 수/팀 일치, 카드·교체는 종류·팀 일치하고 **공식이 더 완전**(SofaScore에 빠진 교체 2건·경고 1건 보유). 시각은 득점 ±1분, 교체는 SofaScore가 1~3분 늦게 기록하는 체계 차이 → 시기 혼합 시 교체 전후 15분 분석에 ≤3분 오차.
   - **복구 가능**: 득점/카드/교체 incidents(→ 경기 요약 타임라인·교체 효과·카드 분석), 도움, 팀 스탯(`matchRecord.do`: 슈팅·유효슈팅·코너·파울·점유율·오프사이드·카드), 시간대별 점유(`possession.do`).
   - **복구 불가(공식 API로는)**: 슈팅맵 좌표/xG, 평균 위치, 히트맵, 선수 평점·상세 스탯 — `getShootData`·`getHeatmapData`·`getMatchRecordAllDetail`은 빈 응답, `getMatchRecordPlayerDetail`은 500. → xG 기반 분석의 2026 공백은 이 경로로 해결되지 않음.
   - **신규 가능성**: `getPassData.do` = **선수 간 패스 행렬 + 포지션 맵**(패스 네트워크). P3 '패스맵 미공개' 판단 재평가 대상.
   - **구현 결과**: `crawlers/collect_kleague_events.py` (기본 dry-run, `--apply` 저장, `--compare N` 대조) + `update_data.py` STEP 21(STEP 16 매핑 직후, fail_ok). 대상=SofaScore 이벤트 데이터가 전혀 없는 종료 경기만, 경기 단위 트랜잭션·`INSERT OR IGNORE`, **득점 이벤트 스코어가 공식·DB 스코어와 다르면 그 경기는 저장 안 함**, 요청 간격 0.4s. 자책골 저장 규칙은 SofaScore 수집기와 동일(`is_home`=득점 인정 팀, `team_id`=자책한 선수 팀). **대조 80경기: 득점 수 80/80·득점자명 79/80(외국인 표기 차)·선수ID 220/220·카드 75/80·교체 71/80(공식이 더 완전)**. 로컬 적용: **157경기, 득점 +412·카드 +530·교체 +1,495**, 재실행 0건(멱등), 무결성 불일치 0, 응답 실패 0. 감사 결과 K1·K2 득점/카드/교체 공백 0~1일.
   - **한계**: ①시각은 clock 분(득점·카드 ±1분, 교체는 SofaScore보다 1~3분 이르게 기록 — 시기 혼합 시 교체 전후 15분 분석에 ≤3분 오차) ②PK 구분 없음(`is_penalty=0`) ③선수 ID 해석률(8/3 이후): K1 득점 98%·카드 99%·교체 OUT 99%, **교체 IN 63%, K2 43~54%**(K2 최근 mps 없음, `players.name_ko`가 외국인에서 중복 → 모호하면 NULL, 이름은 항상 저장) — supersub 등 선수ID 기반 분석은 일부 과소집계 ④도움은 파싱만 하고 저장 테이블 없음(향후 확장 가능).
   - **⚠ 정정(2026-11-01, 타당성 점검 후)**: 위 "복구 불가/빈 응답" 결론은 **호출 파라미터 오류**였다. 공식 API는 엔드포인트마다 필드명이 다르다(`matchInfo`·`matchRecord`는 `year/meetSeq/gameId`, **`getPassData`는 `year/meetSeq/gameId`+`homeTeam/awayTeam`(K-ID) multipart**, **`getShootData`는 `MEET_YEAR/MEET_SEQ/GAME_ID`+`homeTeam/awayTeam` multipart**, **`getMatchRecordPlayerDetail`은 `MEET_YEAR/MEET_SEQ/GAME_ID/TEAM_ID/PLAYER_ID` multipart**). 응답 키가 비어도 resultCode=200이라 오판하기 쉽다. 올바른 호출 결과:
     - **패스 행렬(`getPassData`)**: 2020~2026 K1·K2 표본 65/65경기 존재. 팀별 선수 간 성공 패스 횟수 행렬(+포지션). 행렬 합계 ↔ SofaScore 성공 패스 상관 1.00(평균 408 vs 378, 시도 452). → **패스 네트워크 분석 가능**.
     - **슈팅(`getShootData`)**: 전 시즌 존재, 좌표·골문 도착지점·시각·선수ID·**공식 xG(`expected_GOAL`, 결측 0~5%)**·`PK/FK` 구분. **단 유효슈팅·블록·골만 수록(빗나간 슛·자책골 제외)**: SofaScore 대비 슈팅 13.6 vs 24.6/경기, xG 합 1.51 vs 2.82. **xG 대체재 아님**(기존 xG 분석에 혼합 금지) — 보완재(골문 도착 분포, PK/FK 보정, 공식 모델 기준 마무리 효율). `PK` 구분으로 `is_penalty` 보정 가능.
     - **선수 상세(`getMatchRecordPlayerDetail`)**: 선수별 경기 스탯(출전분·슈팅·패스 성공·키패스·크로스·듀얼·공중볼·드리블·태클·인터셉트·회수·패스 길이/방향/구역 + `playerPoint` 평점 유사값). `match_player_stats` 대체 후보(경기당 ~22콜). SofaScore 수치와의 정합 검증 미실시.
     - **미확인**: `getHeatmapData`(복잡한 파라미터), `getMatchRecordAllDetail`(응답 비어 있음), 평균 위치.
   - **주의**: kleague.com 데이터 API의 이용약관(상업 이용·재배포) 미확인 — 기존 포털 수집과 동일 리스크 수준이나 서비스 규모가 커지면 리그 측 확인 권장.
   - **🔎 선수 상세 정합 검증 — 2026-11-03 (읽기 전용, 8/2 이전 6경기·선수 176명, 등번호+홈/원정 매칭, 미매칭 10명)**: `getMatchRecordPlayerDetail`을 SofaScore `match_player_stats`와 대조. **결론: 대체재가 아니라 보완재 — `match_player_stats`에 섞으면 안 됨**(90분당·백분위·레이더 왜곡, 분석 지표 변경=Red).
     - 거의 동일(완전 일치 86~100%): 골·도움·파울·피파울·유효슈팅·슈팅.
     - 정의 차이 소폭(±10% 이내 66~100%, 완전 일치 20~68%): 키패스·크로스·공중볼·패스 시도/성공.
     - **정의가 다름(평균부터 상이)**: 태클 1.71 vs 0.74 · 인터셉트 0.95 vs 1.55 · 드리블 시도 0.52 vs 1.16 · 볼 회수 4.91 vs 3.60. 평점 `playerPoint`는 별도 산식(6.60 vs 6.79, SofaScore 평점 아님).
     - **출전분 불일치(원인 미확인)**: 평균 74.8 vs 66.2분, 완전 일치 6% — 정의 차이인지 오류인지 확인 필요(구현 전 선결).
     - 응답은 `playerDetail` 약 112필드(위 외에 패스 방향·구역, 침투패스, 압박 하 볼 컨트롤, `expectedGoal`, `adidasPoint` 등)와 GK용 `playerGKDetail`. 선수당 1콜(경기당 ~22콜).
     - **결정(2026-11-03, 사용자)**: 지금은 구현하지 않음. 이유 — 운영 선수 스탯이 K1 10/24·K2 10/31까지 있어 빈 구간이 작고(큰 공백은 로컬 DB뿐 → 운영 DB 받으면 해결), 정의가 같은 항목은 득점·슈팅 공식 복구로 일부 커버, 시즌 막바지, 표본 6경기로 설계 확정은 이름.
     - **구현 트리거**: SofaScore 차단이 **운영의 선수 스탯(mps)까지** 번질 때(`analysis/audit_collection_gaps.py` STEP 20 감사로 확인). 구현 시 방침: ①별도 테이블(예 `kleague_player_match`)에 공식 값 그대로 저장, 원본 불변 ②화면은 정의가 같은 항목만 '공식 데이터' 표기와 함께 사용 ③정의가 다른 항목은 갱신 중단으로 표시 ④출전분 불일치 원인과 표본(≥30경기) 재검증 선행.
3. **하지 않음**: 안티봇 챌린지 우회(스텔스/프록시 등) — ToS·차단 심화 위험, 정책상 부적절.
**✅ 운영 서버 확인 완료 (2026-11-02, SSH 읽기 전용 + 사용자가 실행한 `update_data.py --days 14` 로그)**:
- **운영의 SofaScore 차단은 부분적**: STEP 20 감사(운영 기준) — 득점·카드·교체·슈팅맵·평균 위치는 정상(공백 0~8일), 선수 스탯은 K1 10/24·K2 10/31까지, **라인업·히트맵만 9/20 이후 막힘(41일)**. 로컬은 8월부터 전부 중단이라 환경별로 차단 범위가 다르다(앞서 '운영도 로컬처럼 전부 막힘'이라 한 것은 부분적으로만 맞았다). 직전 정기 실행(10/26)은 `라인업 없음 {'_status': 403}` 30경기가 전부 `→ OK`로 끝나던 조용한 실패가 확인됨(가시화 적용 후 STEP 3은 `FAIL (exit 3)`로 정직하게 표시).
- **운영 크론**(서버 `crontab`): 월 05:00 `update_data.py --days 14`(로그 `/var/log/today_tactics/update.log`, 일 단위 로테이션 → 로테이션 파일에서 확인), 월 02:00 `fetch_next_round.py`, 매일 03:00 `deploy/backup.sh`, 04:00 certbot. 내장 스케줄러는 꺼져 있음(`next_run: null`). 서비스: gunicorn 3 workers, 사용자 `rocky`, 앱 경로 `/opt/today_tactics`, **정식 도메인 `suwon.today-tactics.co.kr`**(루트 도메인은 A 레코드 없음).
- **첫 동기화 결과**(약 40분): STEP 15(포털 formation)가 17분, STEP 22(패스 1,636경기)가 16분. 득점·카드·교체 복구 +41/+49/+141(15경기), 패스 엣지 376,308행(로컬과 동일), 종료 코드 부분 실패(STEP 3·20). 10/31·11/1 14경기 반영.
- **🔎 라인업·히트맵 복구 조사 (2026-11-02, 읽기 전용 · 운영 DB 스냅샷 기준)**:
  - **히트맵 = 공식 `getHeatmapData.do`로 복구 가능**. multipart `MEET_YEAR/MEET_SEQ/GAME_ID/PLAYER_LIST(K-ID, 콤마)/H_GK_PLAYER`(+선택 `PERIOD_ID`) → `data.coordinates[{START_POINT_X, START_POINT_Y, PERIOD_ID, PASS_YN_CD}]`. 좌표는 **경기장 절대좌표(0~100)** → 팀·피리어드별 공격 방향(그 피리어드 GK 평균 x<50 ⇒ 오른쪽 공격)으로 변환: 오른쪽 공격 `(x, 100−y)`, 왼쪽 공격 `(100−x, y)` = SofaScore 좌표계. 방향은 경기마다 다름(4경기 중 1경기 반대) → 경기별 판별 필수. **SofaScore 대조 45명(K1·K2, 2025~26)**: 점 개수 비율 중앙값 0.96, 평균 위치 차 |x| 1.0·|y| 1.5, 분산 비율 1.03/1.05 → 사실상 동일 원천. 공백 기간(9/20~) 표본 12경기 중 11경기 존재(10/31 1경기 0건 — 다음 날 공개 지연 추정).
  - **라인업 = 포털 `kleague_lineup`(선발, 9/20 이후도 100%) + mps 등번호로 SofaScore ID 복원 가능**. 공백 이전 170경기 검증: 선발 일치 3516/3520(99.9%), ID 해석률 94%(공백 기간 92%). 한계: `kleague_lineup`은 선발만(벤치 없음), mps가 없는 경기는 해석 불가.
  - ✅ **구현 + 운영 반영 완료(2026-11-02, 사용자 승인)** — 운영 결과 라인업 52경기 2,093행 · 히트맵 67경기 선수 1,236명 점 52,814개(실패 0, 11/1 7경기 미공개 → 다음 크론) · detail_pos 갱신. 반영 전 백업 `/home/rocky/players_before_recovery_20261102.db`(정상 확인 후 삭제 가능): `crawlers/recover_lineups_kleague.py`(STEP 23) + `crawlers/collect_kleague_heatmap.py`(STEP 24). 둘 다 기본 dry-run·`--apply`·`--compare N`·`--days N`, **데이터 없는 경기/선수만** 채움(SofaScore 원본 불변), 경기 단위 트랜잭션, 신규 원장 `kleague_recovery_log(event_id, kind, player_id, rows)`로 출처 구분·롤백(각 스크립트 docstring에 DELETE 문).
    - 라인업: 선발=포털, 벤치=같은 경기 mps 나머지(엔트리 전원 수록), slot_order=포털 포메이션 라인 인원수대로 깊이 순 묶고 라인 안 left_pct 내림차순, 한쪽이라도 선발 11명 ID 미확정이면 경기 전체 건너뜀. `--compare 120`: 선발 2482/2486 · 벤치 2036/2049 일치. 로컬 적용 52경기 2,093행(재실행 0행), 건너뜀 16(대부분 K2 mps 없음).
    - 히트맵: 선수 매핑은 경기 페이지 히트맵 선수 목록(K-ID·등번호) ↔ mps 등번호, 방향은 홈 선발 GK 피리어드별 평균 x. `--compare 3`(87명): 점 개수 비율 0.96 · 평균 위치 차 |x| 1.8·|y| 2.5(최대 8.6/11.1, 큰 편차는 출전 짧은 교체 선수 — 방향 오류였다면 20~60).
    - 운영 반영 절차: push → 서버에서 `venv/bin/python crawlers/recover_lineups_kleague.py --apply` → `collect_kleague_heatmap.py --apply`(공백 9/20~ 약 60경기, 15분 내외) → `backfill_detail_positions.py`. 이후는 월 05:00 크론이 STEP 23·24로 자동.
- ✅ **🐞 득점·교체·카드 중복 — 수정 + 운영 반영 완료(2026-11-02)**: 원인은 공식 복구가 아니라 `collect_goal_incidents.py` 일반 모드 — '득점·카드 둘 다 있는 경기'만 완료로 보아 카드 0장 경기를 매 실행 재수집하고, SofaScore가 경기 후 시각을 1분씩 정정(82'→81')하거나 교체 IN/OUT 짝·선수 ID를 바꾸면 UNIQUE 키가 달라져 INSERT OR IGNORE를 통과해 누적. 수정: 재수집 시 경기 단위 삭제 후 최신 응답으로 교체(응답 득점 수≠스코어인데 기존 기록=스코어면 유지). 기존 데이터는 `crawlers/fix_duplicate_incidents.py`(dry-run 기본)로 정리 — 로컬: 교체 45행(같은 IN 선수 3분 내 2회)·카드 2행·득점 3행(득점>스코어 경기 한정), 오래된 행 삭제. qa_check 81/81. 운영: 백업 `/home/rocky/players_before_dedup_20261102.db` 후 같은 50행 정리·캐시 무효화 완료, 공개 사이트 경기 요약 득점 타임라인 9→6 확인.
- **미해결(P2)**: ①~~`invalidate_api_cache()`가 gunicorn 워커 1개의 캐시만 비움~~ → ✅ **2026-11-02 해결 · 운영 배포 완료**(운영에서 `/api/cache-invalidate` 후 공개 URL 6회 요청 모두 새 응답 확인): 공유 마커 파일 `.cache_generation`(gitignored)의 mtime을 캐시 세대로 사용. `invalidate_api_cache()`와 `update_data.py` 종료 시 마커 갱신 → 각 워커가 `before_request`에서 최대 2초 간격으로 확인해 `_API_CACHE`·`_GAMES_CACHE`·`_PRED_CACHE`·`_BACKTEST_CACHE`를 비움. 2프로세스 재현 테스트(HTTP 무효화·직접 touch·자기 재무효화 방지) PASS. 다른 워커는 워밍업 없이 첫 요청 때 다시 계산(2vCPU 동시 워밍업 포화 방지). ②STEP 20 감사는 라인업·히트맵 공백이 남아 있는 동안 계속 `FAIL`(부분 실패) — 의도된 경고지만 영구 노이즈이므로 `--max-gap-days`/제외 소스 설정 검토. ③서버 홈에 업데이트 전 DB 백업 `/home/rocky/players_before_update_20261102.db`(약 226MB) — 정상 확인 후 삭제.

### [ ] 분석 보고서 확장 — 사용자 순서: 감독 → 분석가 → 팬 (2026-10-31 결정)

**1) 감독 — 프리매치 상대 스카우팅 한 장 요약** — ✅ 2026-11-01 구현 완료 (미커밋)
- 구현: `main.py` `/api/pre-match-brief?team=&opp=&home=1|0` (내부 호출 재사용, 30분 캐시) + `prediction.js` `renderScoutBriefCard`(경기예측 탭, 우리 팀 홈/원정 토글, 인쇄/PDF) + `style.css` `.scout-brief`. qa_check 39/39 PASS.
- 설계 대비 변경: team-ranking(K2 전용) 대신 match-prediction 순위 재사용 / 선제골 지표 2개는 강점·약점 순위에서 제외(절대 수치와 순위가 어긋나 보이는 모순 방지, ④에서 표시) / "한 줄 결론"→"핵심 결론".
- 부수 수정: `_api_cache_store`가 `(resp, status)` 튜플을 200으로 오인 캐시 → 이후 히트 500 되던 잠복 버그 수정(match-prediction 404 등 기존 경로 포함).
- 남은 것: 브라우저 크로스 확인(Firefox/Edge 미검증, Chromium만 확인), 감독 피드백 후 임계값(강점·약점 상위 1/3, 시간대 28% 등) 튜닝, 워밍업 미등록(팀 쌍 의존이라 의도적).
- (원 설계안, 참고)
- 새 API `/api/pre-match-brief?team=&opp=` — 기존 계산 재사용(team-ranking·team-analytics·team-shape·league-rankings·team-insights·goal-timing·match-prediction/h2h). 캐시·워밍업은 기존 방식.
- 구성: ①상대 폼·순위 ②전술 정체성(포메이션/라인) ③강점3·약점3(리그 평균 대비 편차 자동 선별) ④득실 시간대·선제골 영향 ⑤핵심 위협 선수 ⑥우리 팀 대비 상성(H2H·예측) ⑦규칙 기반 한 줄 결론 3개(근거 수치 동반).
- 화면: 경기예측 탭 내 "스카우팅 요약" + 인쇄/PDF. 내 팀 선택 → 상대 선택 방식. 표본<4경기·xG 커버리지 낮음 경고 표시.
- 리스크 등급: 새 API 라우트 = Yellow(구두 확인), 스탯 계산 공식 변경 없음.

**2) 분석가** (진행 중 — 4개 중 1개 완료)
- [x] **xG 기반 운 보정 순위** — 2026-11-01 구현 (미커밋). `/api/insights/xg-luck?league=k1|k2&year=` + 인사이트 > 심화 탭 풀폭 카드. 기대승점=경기별 양 팀 xG를 독립 포아송으로 환산(3·1점), **xG 보유 경기만** 실제·기대 모두 같은 집합으로 비교, 팀당 5경기 미만 제외, ±0.25 PPG로 행운/불운 판정. 한계: 2026 xG 커버리지 K1 72%·K2 60%라 팀별 비교 경기 집합이 달라 일정 난이도 섞임(경고·커버리지 표시), K2 2020~23은 xG 없음. qa_check 45/45.
- [x] **휴식일·연전 영향** — 2026-11-01 구현. `/api/insights/rest-effect?league=&year=` + 심화 탭 카드(PPG 막대+95% CI, 규칙 기반 판정). **발견: K1·K2 전 시즌 모두 통계적으로 유의한 효과 없음**(3일↓ vs 4일↑ PPG: K1 −0.06 z=−0.7, K2 +0.16 z=+1.4 / 연전 z=0.2). 한계: 리그 경기만 반영(컵·ACL 제외).
  - ✅ **`_rest_factor`(×0.91) 검토 완료 — 코드 변경 없이 유지 (2026-11-01)**: 근거였던 K2 백테스트(홈승률 27.5%)는 전 시즌 재검증에서 반대 방향(K2 ≤3일 홈승률 41.7% n=60 vs 4일+ 37.2%)이라 지지되지 않음. 그러나 `apply_rest` ON/OFF 백테스트 비교 결과 영향이 사실상 0 — K1 2024/25/26 ΔBrier +0.0005/−0.0007/−0.0003, K2 2025/26 ΔBrier 0.0000 (적중률 동일~±1.5%p, 부호 일관성 없음). 적용 경기가 거의 없어 예측 품질에 무해·무익 → Red 등급 변경 리스크를 감수할 이유 없음. 재검토 조건: 휴식일에 컵·ACL 경기를 반영하게 되어 3일↓ 표본이 크게 늘 때.
- [x] **교체 효과 확장** — 2026-11-01 구현. `/api/insights/substitution-impact?league=&year=` + 심화 탭 카드. ①팀별 첫 전술 교체(부상 교체 제외) 앞뒤 15분 순득실 변화를 리그 평균 대비로(95% CI, z, 다중검정 경고) ②벤치 선수 교체 출전 90분당 G+A(180분·4경기↑). **발견: K1 전 시즌 어느 팀도 리그 평균과 유의하게 다르지 않음**(최대 대전 z=+1.9), 리그 전체는 첫 교체 후 +0.08골±0.04(약한 개선 신호, 경기 상황 교란 가능). K2 2026 안산 ★ 1팀은 17팀 동시 검정의 우연 범위. qa_check 55/55.
- [x] **세트피스 유형 분류 → 공수 프로필로 구현** — 2026-11-01. `/api/insights/setpiece-profile?league=&year=` + 심화 탭 카드. 슈팅맵 `situation`(코너/프리킥/스로인/기타, PK 제외)을 **공격(생산)·수비(허용) 양쪽**으로, 순 xG, 득점·실점 중 세트피스 비중, 헤더 비중, 강점/취약 하이라이트. 기존 `setpiece-efficiency`(경기별 양 팀 공격 효율)와 달리 수비·유형 세분화 제공. xG 보유율 80% 미만(K1 2026 71%)이면 슈팅 수로 자동 대체, K1 xG는 자체 모델 추정이라 경고. 골 8개 미만 비중은 †소표본. qa_check 61/61.
- 분석가 항목 4/4 완료. 다음: 팬 항목(경기 후 요약 카드, 스토리형 인사이트) — 착수 전 `match-retrospective`와 중복 여부 확인.
**3) 팬** (진행 중 — 2개 중 1개 완료)
- [x] **경기 후 요약 카드** — 2026-11-01 구현. `/api/match-recap?event_id=|date+home_slug+away_slug` + 경기예측 탭(종료 경기 선택 시) 최상단 카드. 규칙 기반 헤드라인(역전승·결승골 85'+·극적 동점·대승·무득점), 득점 타임라인(+퇴장), MVP(최고 평점), 핵심 스탯 비교, 순위 변동, 스토리 뱃지(연승·무패·연패·탈출·선두 등극·멀티골/해트트릭·조기 퇴장·xG 열세 승리), **요약 텍스트 복사(공유)**. 기존 `match-retrospective`(모델 예측 적중 분석)와 역할 분리. 2025~26 877경기 전수 점검 이상 0건. 가드: 득점 상세 없음/스코어 불일치 시 타임라인 기반 문구 생략, 한쪽 선수 기록 없으면 스탯 생략, 평점 없으면 MVP 생략. 알려진 한계: **K2 다수·최근 경기는 `goal_events` 미수집이라 타임라인 없음**(수집 파이프라인 이슈, 카드는 안내 문구로 graceful). qa_check 67/67.
- [x] **패스 네트워크(K리그 공식 `getPassData`)** — 2026-11-02 구현. 신규 테이블 3개(`kleague_pass_edge/player/match`, 롤백=DROP) + `crawlers/collect_kleague_passes.py`(기본 dry-run, `--apply`, `--compare N`, 기본 범위 **2023~**: 2020~2022는 사용자 결정으로 제외) + `update_data.py` STEP 22 + `/api/pass-network`·`/api/pass-network/matches` + 팀 분석 모달 '🕸 패스 네트워크' 탭(SVG, 시즌/경기별, 슬라이더, 선수 선택). 로컬 백필 **2023~2026 K1·K2 1,636경기(커버리지 99%+, 엣지 약 37.6만 행, DB 210→235MB)**.
  - 검증: 행=패스한 선수·열=받은 선수(행 합계=선수 상세 성공 패스, 약 75%가 정확히 일치하고 나머지는 ±1~4패스≈2% — 두 공식 필드의 집계 기준 차이, 경기 시점과 무관), 행렬 합계↔SofaScore 성공 패스 상관 1.00, 선발 이름↔라인업 100%(`(c)`·공백 제거 후), 시즌 합계=경기별 합계, qa_check 81/81.
  - 데이터 특성: **패스는 경기 다음 날 공개**(미공개는 저장 안 하고 다음 실행에서 재시도 — 로컬 8경기 대기), 수신 전용 선수·이름 빈 선수는 선수 상세 API로 보충, 대각선(자기 패스) 0.3%는 무시(5% 초과 시 거부).
  - 한계: 좌표는 **선발 라인업 배치**(실제 평균 위치 아님, 교체 투입 선수는 좌표 없음 → 목록으로 표시), 성공 패스만(실패·길이·방향 없음), K리그 선수 ID↔SofaScore ID 매핑 없음(선수 클릭→선수 분석 연결 미구현).
  - ✅ **PK 보정 — 구현 + 운영 반영 완료(2026-11-02)**(운영도 보정 2건 동일, 백업 `/home/rocky/players_before_pk_20261102.db`, 공개 경기 요약 PK 표시 확인): `crawlers/fix_penalty_from_kleague.py`(STEP 25, 기본 dry-run) — 공식 `getShootData`의 득점(`type_DETAIL_CD=GL`)+`type_DETAIL_CD2=PK`를 goal_events와 같은 측·시각 ±2분·등번호/이름으로 매칭. **2026 시즌 검증: SofaScore PK 93/93 일치, 비PK 850/850 일치, 어긋남 0** → 공식 PK 신뢰. 보정 2건(공식 복구 득점). 공식 득점 수≠DB 득점 수 경기(50)는 건너뜀, DB만 PK인 경우는 변경 안 함.
  - 다음(선택): 스카우팅 요약에 '패스 허브' 연동, 선수 링크, 선수 상세 스탯(`getMatchRecordPlayerDetail`) 복구 검토(SofaScore 정합 검증 선행).
- [-] ⏸ **보류(2026-11-02, 사용자 판단: 중요도 낮음)** 팀/선수 스토리형 인사이트(시즌 서사: 상승세/부진 구간, 선수 커리어 하이 등) — 미착수. 착수 전 데이터 원천(경기별 시계열)과 기존 `team-trend`·`player-analytics` 중복 확인
**데이터 한계**: 패스 이벤트·GPS·계약/몸값 없음 → PPDA·패스 네트워크·영입 가치 분석은 불가.


### [x] ~~(보류) Google OAuth 발급 + LOGIN_REQUIRED=1 활성화~~ — 2026-11-03 사용자 결정: **로그인 기능 사용 안 함** (OAuth 콘솔 redirect URI 등록도 불필요, 공개 모드 유지)

**상태**: ⏸ **보류** — 트래픽/개인화 필요 시 재개. PM 판단(6/11):
- 핵심 보안(SECRET_KEY 고정·CSP·cache-invalidate 차단·MAX_CONTENT_LENGTH 등)은 6/1에 이미 완료. 공격면은 막혀 있음.
- OAuth가 막는 건 "익명 사용자의 saves/squads 생성·수정·삭제"(무결성·스팸 수준) 뿐 — 데이터 유출/서버 탈취 급 리스크 아님.
- **재개 조건**: ① 저장본 스팸·장난 흔적이 실제로 관측됨 ② 사용자별 "내 전술판" 개인화 기능이 필요해짐.
- **저비용 대안**(원하면): 쓰기 API에 단순 공유 토큰 게이트만 적용(Google Console 불필요, ~10분).

**필요한 것**:
- [Google Cloud Console](https://console.cloud.google.com) → OAuth 2.0 클라이언트 ID 발급
- 콜백 URL 등록: `https://today-tactics.co.kr/auth/callback/google`
- 획득: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

**Gabia 서버 적용 명령** (발급 후 SSH로 실행):
```bash
ssh -i ~/.ssh/<SSH키> rocky@<운영IP>
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

### [x] ~~선수 상세 스탯·비교 K1(tid=410) 지원~~ — 2026-06-15 완료
`player-stat-report`의 tid=777 하드코딩 8곳을 선수 리그 자동 판정(최근 경기 기준, 검색 배지와 일치)으로 일반화. 피어/백분위/세부포지션/활동량/신체랭크 모두 해당 리그 내 계산. 응답에 `league` 추가. ⚖️ 선수 비교는 K1+K2 검색 허용 + 교차 리그 백분위 주석. 검증: K1 선수(146 K1 피어)·K2 회귀(일류첸코 91경기 동일)·K1↔K2 비교 PASS.

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

### [ ] 세리에A · 리그앙 선수 스탯 수집 — 2026-06-14 백로그 등록

**현황**: SofaScore `top-players/overall` API가 세리에A(tid=23)·리그앙(tid=34)에서 403 완전 차단. EPL·라리가·분데스는 정상 수집 중.  
**증상**: `/leagues` 리그 분석 탭에서 두 리그 선택 시 "수집 불가" 안내 노출.

**PM 판단 (2026-06-14)**: 당장은 ROI 낮음. EPL/라리가/분데스 3리그로 선수 900명 데이터 충분. **유럽 5대 리그 개막(2026-08월) 전 재검토**.

**우회 방안 (우선순위 순):**
1. **Fbref.com 파서** — BeautifulSoup HTML 파싱, 안정적·빠름. 스키마 매핑 작업 필요 (~2~3h).
2. **선수 개별 프로필 방문** — `sofascore.com/player/{id}` 방문 후 stats 호출. 세리에A ~500명 × 1회 = 500 페이지, 봇 탐지 위험 높음.

**재개 조건**: 유럽 시즌 개막 전 OR 세리에A/리그앙 팬 유입 수요 확인 시.

---

## ⚫ P3 — 의식적으로 안 함

- ❌ Git history rewrite (PM 권고: ROI 음수)
- ❌ history.md 과거 노출 정리 (rewrite 없이 의미 X)
- ❌ 2020 시즌 17매치 avg_positions/shotmap/lineup 미보유 — SofaScore 자체 부재라 회복 불가
- ❌ 패스맵 (선수 간 패스 네트워크) — ~~SofaScore + K리그 포털 둘 다 미공개~~ → 2026-11-01 K리그 공식 `getPassData.do` 존재 확인, 재평가 대상(P1 'SofaScore 수집 중단' 항목 참조)

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
