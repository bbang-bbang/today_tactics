# RESUME — 다른 PC / 새 세션에서 작업 재개 가이드

> 이 파일 + `checklist/work-log-*.md` + git 커밋 기록만 보고 작업을 이어갈 수 있도록 정리.
> 최종 갱신: 2026-11-02 (이후 상세: `checklist/backlog.md` P1 'SofaScore 수집 중단' · `checklist/history.md` 2026-11-01)

---

## 0-A. 🌙 2026-11-04 새벽 중단 지점 (가장 먼저 읽을 것)
**상세·명령·함정은 `checklist/work-log-2026-11-04.md`.** 요약:
- ✅ **11/4 낮 갱신**: `--fill-missing` 완료(212명 추가·문제 경기 0, 캐시 갱신 완료) · 03:00 백업 크론 성공 · 득점 불일치 27/871경기(공식 원본 한계, 리포트가 보정) · QA 식 보정 커밋 `1ac40ef`. **name_ko REVIEW 8건 운영 적용 완료(22:10, 롤백 JSON `name_ko_fix_rollback_20261104_221005.json`)**. 상세 `checklist/work-log-2026-11-04.md` §0-A.
- 오늘 배포 완료: 공식 선수 리포트 API+화면(SofaScore/공식 전환), 이름 중복 해소, **players.name_ko 교정 145건(운영 DB 변경, 롤백 JSON·백업 있음)**, 공식 리포트 득점 보정, 수집기 출전 ID 보강. 마지막 코드 커밋 `003a38f`.
- ✅ PO 14건 재분류 운영 적용(22:31) · 공식 탭 기본값 전환(자동 SofaScore 폴백)·비교 모달 출처 전환 구현. 이상민 875787 name_ko 교정 적용(22:50). 데이터 정합성 작업은 근거 확실한 건 완료 — 잔여(이름 없는 93명·중복 321그룹·득점 27경기)는 의도적 보류. 다음: 11/9 크론 확인(STEP 23~28, PO 재분류). QA 120/121 — 실패 1건은 11/9 크론 PO 재분류 대기.
- 📝 **11/5 새벽 마감 기록(분석·인사이트 개편 후 잔여 작업)** — 배포·동기화 완료 상태. 상세 `checklist/work-log-2026-11-04.md` §0-A.
  - ✅ 오늘 끝낸 것: 데이터 정합성(name_ko 154건·PO 14건·events 중복 17건 병합) · 선수 리포트 개선(공식 탭 기본+폴백·퍼센타일 라벨·필터 한 줄·'전체' 연도=`year=all`·한 줄 해석) · 경기 후 요약(이야기 후보 점수제, `insights`) · 프리매치 브리핑(우리×상대 매치업 결론) · 인사이트>심화 '리그 화제 포인트'(`/api/insights/storylines`) · 팀 분석 모달 '한 줄 진단' · 패스 네트워크 경기 드롭다운 가독성.
  - ⏳ **잔여(우선순위순)**: ~~① 심화 탭 기존 카드 한 줄 해석 일괄 적용~~ ✅ 11/5 배포(`7f8024d`, insights.js?v=46·style v113 — 9개 카드, 유의하지 않으면 단정 안 함) ② 상대 맞춤 인사이트 — ✅ 상대 수준별 성적 11/5 배포(`66a5aac`, `/api/insights/opponent-strength`, 심화 탭 카드 · 리그 후반엔 일정 보정 효과≈0이라 등급별 성적 중심) · ✅ 실점 약점 지도 11/5 배포(`d7026b3`, `/api/insights/defensive-weakness` — 허용 슈팅 분포 vs 리그, 좌우 측면 미구분) · ⏳ 남음: 포메이션 상성 ③ **직접 확인 필요**: 패스 네트워크 '경기' 드롭다운 실제 열린 목록 가독성 · 경기 후 요약 카드의 핵심 포인트 줄·화제 포인트 카드를 운영 브라우저에서 눈으로 · Edge/Firefox 확인(분석 개편분) ④ **11/9(월) 크론 점검**(아래 절차 — 세션 예약은 세션이 닫히면 사라짐, 새 세션에서 "11/9 크론 점검"이라 요청) ⑤ 보류: 이름 없는 선수 93명·중복 레코드 321그룹·김포 김도혁 오기 2건·2024 NULL 점수 2경기·득점 불일치 27경기(공식 원본 한계).
  - ⚠ 주의: ① 운영 Python 3.11 — f-string 안 따옴표 중첩 금지(조사 헬퍼 `_j(word, 0|1|2)`는 숫자 코드로 받음) ② lazy 로드 JS(`analytics`·`insights` 등) 캐시 버전은 `templates/index.html`의 `TT_LAZY` JSON에서 올린다(정규식 일괄 치환 금지 — `player_analytics.js`와 섞임) ③ 이 PC의 Windows Python에서 한글 출력은 `PYTHONIOENCODING=utf-8`.
- 🗓 **11/9(월) 05:00 크론 점검 절차**(읽기 전용, 서버 `/opt/today_tactics`): ① `/var/log/today_tactics/update.log` 마지막 실행의 STEP 23~28 성공(STEP 26 PO는 처리할 게 없는 게 정상) ② 월 02:00 `fetch_next_round.py`(`next_round.log`)가 `INSERT OR REPLACE events`를 하므로 **중복 이벤트 재발 여부** — `./venv/bin/python crawlers/dedupe_events.py --db players.db`(dry-run, 대상 그룹 0이어야 함; 있으면 `--apply --backup-dir /var/backups/today_tactics`는 사용자가 직접) ③ `./venv/bin/python qa_check.py` 121/121 ④ `analysis/audit_collection_gaps.py` '모든 소스 정상 범위'.
- ⚠ 공식 사이트 부하에 민감: `--dry-run`도 실제 호출함 → 시험은 `--limit`·`--delay 2~3`.

## 0. ⏭ 재개 지점 (NEXT)
**열린 작업: SofaScore 수집 중단 대응 (2026-11-01 발견, `checklist/backlog.md` P1).** 운영 = https://suwon.today-tactics.co.kr (루트 도메인 `today-tactics.co.kr`에는 A 레코드 없음 — canonical은 `suwon.` 서브도메인).
- **2026-11-01 완료**: 감독 `프리매치 스카우팅 요약`(`/api/pre-match-brief`) · 분석가 4종(xG 운 보정 순위·휴식일/연전·교체 효과·세트피스 공수 — `인사이트 > 심화` 탭) · 팬 `경기 후 요약 카드`(`/api/match-recap`) · **수집 가시화**(`crawlers/fetch_health.py` probe, `update_data.py` 종료 코드 0/1/2, 헤더 배지 `⚠ 일부 미수집`, `analysis/audit_collection_gaps.py`) · **K리그 공식 API 복구 크롤러**(`crawlers/collect_kleague_events.py` → 득점·카드·교체, `update_data.py` STEP 21) · 10/31~11/1 결과 갱신.
- **2026-11-02 완료**: **패스 네트워크**(`collect_kleague_passes.py` + `/api/pass-network` + 팀 분석 '🕸 패스 네트워크' 탭, 2023~2026 백필 완료, update_data STEP 22). 공식 API는 엔드포인트마다 필드명이 달라(`getPassData`=year/meetSeq/gameId+homeTeam/awayTeam, `getShootData`=MEET_YEAR/MEET_SEQ/GAME_ID+homeTeam/awayTeam, 모두 multipart) 잘못 호출하면 '성공+빈 데이터'가 나오므로 페이지 JS의 formData를 먼저 확인할 것.
- **남은 결정/작업**:
  1. ✅ **운영 DB 동기화 완료(2026-11-02)**: 서버에서 `update_data.py --days 14` 실행 → 10/31~11/1 결과·득점/카드/교체 복구(STEP 21)·패스 네트워크 2023~2026(STEP 22, 1,636경기) 반영. 이후는 **월 05:00 크론**이 자동 처리(첫 동기화는 SSH로 직접 실행 — `/api/trigger-update`는 30분 제한이라 부적합). 접속: `ssh -i ~/.ssh/<SSH키> rocky@<운영IP>`(키는 `~/.ssh/`), 앱 `/opt/today_tactics`, 파이썬 `./venv/bin/python`. 주의: 업데이트 직후 gunicorn 워커별 메모리 캐시 때문에 일부 API가 옛 응답을 최대 1시간 서빙(백로그 P1 '미해결' 참조).
  2. ✅ **라인업·히트맵 복구 — 구현 + 운영 반영 완료(2026-11-02)**: `recover_lineups_kleague.py`(STEP 23, 포털 라인업+mps 등번호) · `collect_kleague_heatmap.py`(STEP 24, 공식 `getHeatmapData` + GK 기준 방향 변환). 원장 `kleague_recovery_log`. 운영에서 1회 실행 완료(라인업 52경기·히트맵 67경기), 이후 월 05:00 크론이 STEP 23·24로 자동. 워커 간 캐시 무효화도 같은 날 수정(`.cache_generation` 마커).
     - 이 PC는 Git Bash ssh가 한글 사용자 경로를 못 읽음 → **PowerShell의 Windows OpenSSH**로 접속. DB 받기는 서버에서 `sqlite3 .backup /tmp/x.db` 후 scp(운영 DB 직접 복사 금지).
     - ✅ 별건 버그 '득점 중복'은 해결됨(2026-11-02, `fix_duplicate_incidents.py` + 재수집 시 경기 단위 교체. 스크립트는 2026-11-03 정리 — 복원은 `crawlers/ARCHIVED.md`).
  3. ⏸ (보류 — 사용자 판단 중요도 낮음) 팬 항목 ②: 팀/선수 스토리형 인사이트(착수 전 `team-trend`·`player-analytics` 중복 확인).
  4. 선택: 스카우팅 요약에 '패스 허브' 연동 · 슈팅 PK/FK로 `is_penalty` 보정 · 선수 상세 스탯 복구 검토.
- **2026-11-03 완료**: ①헤더 `📖 분석 읽는 법` 도움말 모달(`templates/index.html` `#guide-overlay`, style.css v100 — 지표 정의·해석 주의점·데이터 한계, 문구는 각 화면 '근거' 줄과 일치 유지) ②공식 선수 상세 API(`getMatchRecordPlayerDetail`) 정합 검증 → **보완재, `match_player_stats`에 혼합 금지**, 구현 보류(트리거: 운영 선수 스탯까지 차단 확산 — 상세·수치는 `checklist/backlog.md` P1) ③이 PC 새 수집 단계(STEP 23~25)를 DB 복사본에서 dry-run→apply 검증(원본 미변경). 상세: `checklist/work-log-2026-11-03.md`. 이 PC의 `players.db`는 11/2 00:19 기준(운영보다 오래됨) — 서버/QA 필요 시 운영 DB를 `sqlite3 .backup` 후 scp.
- **2026-11-03 추가 완료**: 분석 포인트 정비 — 죽은 API 4종 제거 + 신규 인사이트 4종(득점 의존도·선발 로테이션·득점 직후 실점·패스 허브, 인사이트>심화 탭, `insights.js?v=40`·`style.css?v=101`, qa 99/99). 상세·검증 중 잡은 버그·데이터 주의점(`players.name_ko` 중복)은 `checklist/work-log-2026-11-03.md`. 새 인사이트를 추가할 땐 `_rest_stat`/`_rest_compare` 재사용 + 도움말 모달(`#guide-overlay`) 항목 동기화.
- **📋 다음 작업 (2026-11-03 기준, 우선순위순 — 상세·근거는 `checklist/backlog.md`)**:
  1. ✅ **운영 수집 상태 점검(2026-11-03)**: 11/2 크론은 STEP 23~25 배포 전이라 STEP 3(SofaScore 403)·20(라인업·히트맵 41일 공백) 실패로 기록됐으나, 같은 날 수동 복구 후 현재 감사는 16개 소스 모두 정상 범위. **다음 월(11/9) 크론 로그에서** STEP 23~26 정상 + 11/1 히트맵 공개분 채움 + STEP 26 PO 14건 이동 확인. 운영 접속은 PowerShell OpenSSH — `.claude/settings.local.json`에 ssh 허용 규칙 있음(이 PC).
  2. ✅ **운영 백업 정리 + 🔴 일일 백업 장애 복구(2026-11-03)**: `deploy/backup.sh`가 git에 실행 권한 없이(100644) 저장돼 배포의 `git reset`마다 권한이 빠져 **5/15부터 매일 03:00 백업이 Permission denied로 실패**(마지막 정상 백업 5/14)하던 것을 발견 → git 모드 100755로 수정·배포, 수동 실행으로 `/var/backups/today_tactics/players_20261103.db.gz` 생성(quick_check ok, 행 수 운영과 일치). 11/2 수동 백업 4개 중 변경 전 원본(`before_update`)만 `players_20261102_preupdate.db.gz`로 보관(30일 규칙으로 12월 초 자동 삭제), 중간 3개 삭제. **11/4 03:00 크론이 스스로 성공하는지 `/var/log/today_tactics/backup.log` 확인 필요.**
  - 🔄 **공식 데이터 전환 2단계 진행 중(2026-11-03~)**: `kleague_player_match`(공식 선수 경기 기록, mps와 분리) + `kleague_player_map`(공식 kid↔SofaScore id). update_data STEP 27·28로 매주 최근 30일 자동. **운영 백필 실행 중** — 11/3 11:11 `--delay 0.8`로 시작했다가 '봇처럼 보이는 과도한 부하' 우려(사용자 지적)로 11:37 중단(52경기 저장) → **2026·2025만, `--delay 3`로 이어받기 재시작**(11:40, 사용자 요청으로 휴식 시간대 없이 연속 · 남은 약 837경기, 예상 11/4 저녁 전후 완료, 끝나면 매핑 자동 생성). 2023·2024는 필요할 때. 이 데이터 원천은 K리그 홈페이지 내부 API(공식 공개 API 아님, 약관 미확인) — 개인·비상업 용도, 저부하 원칙 — 로그 `/var/log/today_tactics/kpm_backfill.log`, 끝 줄 `=== done`. 중단돼도 재실행하면 원장(`kleague_player_match_log`) 기준으로 이어서 받음. **운영 백필 완료(2026-11-03 23:40)**: 2026·2025 871/891경기 저장(실패 20 = 공식 쪽 선수 상세 미기록 추정, 주간 STEP 27이 재시도), `kleague_player_map` 1,047명. **3단계 구현(2026-11-04, 로컬 커밋·미배포)**: `/api/player-stat-report-official`(공식 값끼리만 계산, 기존 API 불변) + 선수 리포트 `[SofaScore | 공식 K리그 베타]` 전환(`player_report.js?v=10`·`style.css?v=106`, 도움말 모달 동기화, qa 115/116 — 1건은 PO 재분류 미적용). 한계: ①SofaScore id→공식 kid는 map 우선, 없으면 '같은 이름+같은 경기·출전분 80%' 유일 후보만(모호하면 연결 안 함) ②**이름 중복 보정(2026-11-04)**: `players.name_ko` 중복 421개 이름에서 `_find_player`가 첫 행(경기 1~2개짜리 중복 레코드: 제르소·디자우마 등)을 잡던 것을 **경기 기록이 가장 많은 레코드 우선**으로 수정(235개 이름의 선택이 바뀜, 공식 탭 연결 가능 선수 175→346, `/api/player-matches`·`player-stat-report`·`player-stat-report-official` 공통 적용). 같은 이름의 서로 다른 사람(동명이인)은 여전히 경기 수 많은 쪽 하나로 귀결 — 팀·생년 등 문맥으로 가르는 건 미구현. ③**`players.name_ko` 오기 교정 적용(2026-11-04 00:52, 운영)**: 공식 매핑·로마자·포털 생년월일 3중 근거로 AUTO 145건(오기 107·영문그대로 32·빈값 6) 교정 — 이전엔 `박승욱`·`권완규`·`최철순` 등이 검색 0건이었음. 계획 `analysis/plan_name_ko_fix.py`(읽기 전용) → 적용 `crawlers/apply_name_ko_fix.py`(기본 dry-run, 단일 트랜잭션, name_ko 외 불변 해시 검증). **롤백**: 서버 `/var/backups/today_tactics/name_ko_fix_rollback_20261104_005231.json` 으로 `apply_name_ko_fix.py --rollback-file <json> --apply`, 또는 적용 전 DB `players_before_namefix_20261104_005205.db.gz`(30일 후 자동 삭제). 남은 것: REVIEW 8건(표 2~4개 외국인 — 아론/티아고 등), 이름 없는데 경기기록 있는 선수 93명(근거 없어 미채움), 같은 이름·같은 팀 중복 레코드 359그룹, 공식 선수 기록 득점 합≠스코어 35경기(26경기는 득점자 누락 의심 — qa_check가 실패로 표시), 이상민 875787(`name_ko`=김도혁)은 이번 교정 대상 아님(매핑 없음). 기본값 전환·선수 비교 모달 지원은 미결정.
  - 🧹 **crawlers 정리(2026-11-03)**: 호출처 없는 1회성 스크립트 14개를 작업 트리에서 제거(git 기록 보존) — 목록·복원 방법 `crawlers/ARCHIVED.md`.
  3. **선수 상세 스탯 대비 (보류 중 — 트리거 대기)**: SofaScore 차단이 운영의 선수 스탯(mps)까지 번지면 착수. 공식 `getMatchRecordPlayerDetail`은 SofaScore 대체가 아닌 보완재(정의 다른 항목 혼합 금지). 착수 전 선결: 출전분 불일치(공식 74.8분 vs 66.2분) 원인 조사 + 표본 30경기↑ 재검증. 방침은 backlog P1 '선수 상세 정합 검증 2026-11-03'.
  4. **도움말('📖 분석 읽는 법') 보강**: ✅ 2026-11-03 선수 리포트(레이더·퍼센타일·활동량)·경기 후 요약 카드 섹션 추가 + Chromium/Firefox/Edge 헤드리스 확인 완료(열기·펼침·스크롤·ESC·포커스 복귀). FW '파울 유도' 지표가 범한 파울을 보여주던 버그도 `was_fouled`로 수정. 지표 문구는 각 화면 '근거' 줄(`insights.js`·`pass_network.js`)과 항상 동기화. 기존 헤더 '도움말' 링크는 로그인 상태에서만 보이는 선재 이슈(공개 모드 미노출) — 필요 시 `#user-menu` 밖으로 이동.
  5. **선택 과제**: ✅ 스카우팅 요약 '빌드업 허브' 연동 완료(2026-11-03, `prediction.js?v=62`) · 팀/선수 스토리형 인사이트(사용자 판단으로 보류 — 재개 시 `team-trend`·`player-analytics` 중복 확인부터).
  6. **시즌 종료 대비**: ✅ 점검 완료(2026-11-03) — 비시즌 배지 오탐 없음. ① K2 PO·승강 PO가 K1(410)로 저장되던 문제 ✅ 해결(`reclassify_playoffs.py`, update_data STEP 26 → tournament_id 9410, 운영은 다음 크론에서 자동 적용) ② 2027 연도 전환 하드코딩 목록은 backlog P1(2027 개막 전 작업).
  - 로컬 환경 메모: 로컬 `players.db`는 11/2 00:19 기준(운영보다 오래됨) — 서버/QA가 필요하면 운영 DB를 `sqlite3 .backup` 후 scp로 받을 것(운영 DB 직접 복사 금지).
- **2026-11-04 보안 후속**: CSP 인라인 스크립트 금지 대응(템플릿 인라인 `<script>` → `static/js/boot.js`·`onboarding.js`·`leagues.js`, `TT_LAZY` → `#tt-lazy` JSON, `onerror=` → `data-hide-err`) + 쓰기 남용 제한(파일 상한·기본 스쿼드 삭제 금지·nginx 쓰기 빈도 제한). 운영 nginx 반영 완료(11/3 15:20, root 필요 — rocky sudo는 앱 재시작만). 이제 템플릿에 인라인 스크립트·`on*=` 속성 금지.
- **정적 자산 수정 시 필수**: nginx가 `/static/`을 `expires 7d` + `immutable`로 내보내므로 JS/CSS를 바꾸면 `templates/index.html`의 `?v=`를 반드시 올릴 것(안 올리면 기존 방문자는 최대 7일간 옛 파일 사용).

## 1. 현재 상태 (2026-06-11 종료 시점)
- **브랜치/HEAD**: `main` (2026-06-15 심화 ③스카우팅·⑤경기리포트·④선수비교 완료). **origin push + 운영 git 동기화 완료**(로컬=origin=prod 일치 · 서비스 active · 헬스 200). 로컬 트리는 `checklist/history.md` 자동로그(마스킹 훅)로 수시 dirty(감사 로그 — 배포 무관).
- **이번 세션(6/11) = 히트맵 대규모 개편**. 상세는 `checklist/history.md` 2026-06-11 섹션. 핵심:
  1. **히트맵 비교 오버레이**(포지션평균/다른선수/홈vs원정, 듀얼 컬러 빨강/파랑/보라) + **인사이트 배너**(전진·측면·활동폭 자동해석) + **통합 선수검색**(`/api/heatmap-player-search`, K1·2 전구단·선수당 1줄).
  2. **🔴 flip 선재 버그 수정**: SofaScore 원본이 이미 팀상대 정규화인데 `_flip_points`가 원정 경기를 또 반전 → 누적 히트맵 절반 좌우뒤집힘. pass-through화(GK x>80 44%→0%).
  3. **히트맵을 5번째 워크스페이스 탭으로**(팝업 제거, `workspace.js` 인라인). 전술판 툴바 `btn-k2-heatmap` 제거.
  4. **년도(시즌) 필터** + **시즌별 소속팀 표시**(이적 선수). **이적 선수 데이터 정규화**: mps.team_id가 현 소속 고정이라 부정확 → 시즌팀을 event home/away+is_home로 유도, 리그 무관(player 중심) 통합(광주 K1→수원 K2 과거시즌도 조회). 다중시즌은 기본 최신시즌(전체누적 과포화 방지).
  5. **팀 그리드 현 시즌 정리**(K1 12·K2 17, 수원삼성 복원), **선수목록 히트맵 보유·현시즌만·한글명**, **리그탭 race 수정**(`_teamLoadSeq` 가드 — K2탭에 K1팀 뜨던 버그), 경기별보기 5:5 우측배치, 경기장 크기 축소(560), 히트맵 점 경기장 안쪽 매핑.
- **정적 자산 최신 버전** (`templates/index.html` 기준, 2026-11-01): `style.css?v=97` · `app.js?v=17` · `info.js?v=7` · `global_league.js?v=1` · `banner_stats.js?v=3` · `prediction.js?v=61` · `player_analytics.js?v=6` · `player_report.js?v=7` · `k2heatmap.js?v=16` · `team_compare.js?v=12` · `analytics.js?v=16` · `match_report.js?v=1` · `player_compare.js?v=2` · `insights.js?v=39` · `workspace.js?v=8`. 변경 시 `?v=` 동반 증가 필수.
- **선수 상세 스탯은 K1·K2 모두 지원**(`player-stat-report` 리그 자동 판정 = 선수 최근 경기 대회). 비교군·백분위·활동량은 해당 리그 내 계산.
- **포지션 분류는 세부그룹(detail_pos) 우선**(`eff_pos = DETAIL_TO_BROAD[detail_grp] or mps최빈`). mps.position이 윙어를 M으로 묶는 불일치(133명) 해소 — 라벨·지표세트·레이더 모두 eff_pos 기준. 비교군 풀 쿼리만 pos_raw(mps) 유지.
- **2026-06-15 통합 QA 완료**: 오늘 출시 4종(스카우팅·경기리포트·선수비교·K1지원) 실브라우저·모바일·엣지·회귀 점검 14/14 + `qa_check.py` 31/31 PASS. 모바일 경기리포트 스코어 줄바꿈만 수정(style.css v94).
- **🔴 events 스코어 12경기 좌우반전 교정**: QA 중 발견(SofaScore 크롤 유입, 공식 JSON 대조 210중 12 반전). `crawlers/fix_swapped_scores.py`로 교정 + `sync_results_to_events.py` 자가치유 패치(JSON과 다르면 갱신). **운영 DB도 동일 버그 → SSH로 `fix_swapped_scores.py --apply` 실행 필요**(코드 배포만으론 기존 DB 안 고쳐짐, 다음 update_data 또는 수동 실행).
- **신규 엔드포인트**(README §API 반영됨): `/api/kleague{1,2}/position-heatmap`(year), `/api/heatmap-player-search`, `/api/kleague{1,2}/heatmap`에 `year`·`venue` 파라미터.
- **운영**: https://suwon.today-tactics.co.kr 라이브. 배포는 **`git push origin main` → GitHub Actions가 forced-command `ci_deploy.sh`(fetch+reset+restart+health) 자동 실행**. prod에서 직접 크롤러/백필 실행 시 `venv/bin/python3` 사용(시스템 python3엔 playwright 없음).
- **데이터**: 서버가 주기 cron `update_data.py` 자체 수집. **K2 6/7까지 완비**, K1 5/17까지. **다음 라운드 2026-07-04 재개**(월드컵 휴식기) → 그 사이 경기 없음(미수집 아님). 수비 세부 3컬럼은 로컬+prod DB 모두 백필 완료.
- **⚠️ 남은 미완 1건**: 새 도메인 **OAuth 콘솔 redirect URI 등록 안 됨 → 로그인만 깨진 상태**(사이트 본체·데이터는 정상). §7 참조.

## 2. 새 PC 환경 세팅 (git에 없는 것 = gitignore)
git clone/pull 후 아래를 별도로 확보해야 **로컬 실행/배포** 가능:

| 항목 | 비고 | 확보 방법 |
|------|------|-----------|
| `players.db` (~200MB) | SQLite DB (gitignored). **prod DB가 최신** — K2 6/7까지 + 수비 세부 3컬럼(won_tackle/ball_recovery/challenge_lost) 백필 포함 | `scp -i ~/.ssh/<SSH키> rocky@<운영IP>:/opt/today_tactics/players.db .` (권장) / 또는 `python update_data.py` 재수집(오래 걸림) |
| `<SSH키>` (+ `.pub` 사이드카) | 가비아 SSH 키 (gitignored). Windows ssh는 `.pub` 없으면 키 제시 실패 | 안전 보관처에서 복사 → `~/.ssh/`에 두고 `icacls`로 권한 제한. 없으면 `ssh-keygen -y -f <key> > <key>.pub` |
| Python venv + 의존성 | (gitignored) | `python -m venv venv && pip install -r requirements.txt` |
| Playwright chromium | 크롤러/`update_data.py` 실행 시 필수 | `playwright install chromium` (이 PC도 이번 세션에 설치함) |
| `.update_secret_local.txt` | update 트리거 시크릿 (gitignored) | 필요 시 재생성 |
| `saves/`, `squads/{team}_2026.json` 일부 | 사용자 저장물 (gitignored) | 없어도 앱 기동 가능 |

> **6/11 세션 검증 환경(참고)**: 이 PC엔 venv 없이 `pip install flask==3.1.3 authlib requests`로 직접 설치 후 `DISABLE_SCHEDULER=1 python main.py`로 로컬 기동. **UI 변경은 Playwright(`pip install playwright && playwright install chromium`)로 헤드리스 검증**(히트맵 탭 클릭→선수→비교까지 + 콘솔 에러 캡처). 온보딩 오버레이가 클릭 가로막으면 `document.getElementById('onboarding-overlay').remove()` 후 진행. 한글 검색 입력은 Playwright `type`이 불안정 → `el.value=...; dispatchEvent(new Event('input',{bubbles:true}))` 또는 팀→선수 클릭 경로 사용.

## 3. 로컬 실행 / 배포
```bash
# 로컬 실행 (개발: http, 로그인 우회) — debug=True 라 템플릿/정적 즉시 반영
python main.py                      # http://127.0.0.1:5000

# 데이터 증분 수집 (보통 서버 cron이 함)
python update_data.py --days 14

# 배포(이번 세션 방식: 변경 파일만 scp + 재시작) — rocky 계정
KEY=~/.ssh/<SSH키>; R=rocky@<운영IP>; APP=/opt/today_tactics
scp -i $KEY static/js/analytics.js static/js/workspace.js $R:$APP/static/js/
scp -i $KEY static/css/style.css   $R:$APP/static/css/
scp -i $KEY templates/index.html   $R:$APP/templates/
ssh -i $KEY $R "sudo systemctl restart today_tactics"   # 템플릿 변경 시 재시작 필요
```
- 운영 접속 계정은 **rocky** (root 아님 — root 시도 시 fail2ban 차단). 운영 IP는 보안상 여기 미기재(배포 메모/Claude 메모리 `deployment_target` 참조).
- `deploy/deploy.sh <IP>` 는 DB까지 포함한 풀배포(느림). 정적/템플릿만이면 위 부분 scp가 빠름.

## 4. 다음 작업 (백로그)
2026-06-05 종료 시점 후속 후보:
1. ~~**(우선) 새 도메인 OAuth 콘솔 등록**~~ — 2026-11-03 사용자 결정: 로그인 기능 사용 안 함 → 불필요. — Google/Kakao/Naver 각 콘솔에 `https://suwon.today-tactics.co.kr/auth/callback/{provider}` redirect URI 추가. 미등록 시 로그인 불가. 등록 후 로그인 플로우 검증. (코드 변경 불필요 — `url_for(_external=True)`로 Host 동적.)
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
- 단일 팀 분석 모달(`#team-analysis-modal`) = **6탭**: 📋 결과 분석 / 🎯 스카우팅 / 📈 심화 인사이트 / 🧭 팀 형태 / 📍 슛맵 / 📡 스킬 프로필. `analytics.js`가 7개 엔드포인트(team-analytics/trend/league-rankings/team-insights/team-shape/team-shotmap×for·against) Promise.all 오케스트레이션. **🎯 스카우팅은 신규 API 없이** shape+shotmap을 `renderScout`로 조합(경계할 점·공략 포인트·게임플랜).
- DB: `players.db` (events, players, player_stats, heatmap_points, match_player_stats, **goal_events**=선수별 득점 분 등).
- 배포: GitHub Actions → `deploy/ci_deploy.sh`(forced-command). 수동은 `deploy/deploy.sh <IP>`(rocky) 또는 변경 파일 scp(§3).

## 7. 운영 도메인 전환 (2026-06-04 완료)
- **[2026-10-31 변경] canonical = `suwon.today-tactics.co.kr`**. 기존 `www.today-football-tactics.xyz`는 등록 소멸(NXDOMAIN, RDAP 404)로 접속 불가가 되어 전환. HTTP·IP 직접 접근은 301 → canonical. 인증서: `/etc/letsencrypt/live/suwon.today-tactics.co.kr/` (webroot 방식, 자동 갱신). 아래 항목은 6/4 당시 기록(.xyz 기준, 현재 무효).
- (이전) canonical = `www.today-football-tactics.xyz`. apex·구 도메인·IP 접근은 301 → canonical 통합.
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
