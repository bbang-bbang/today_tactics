# 정리된 1회성 스크립트 (2026-11-03)

이미 실행이 끝난 마이그레이션·백필 스크립트를 작업 트리에서 뺐다. 파일은 git 기록에 그대로 있다.
정기 업데이트(`update_data.py`), 크론(`fetch_next_round.py`), 서버 코드, 다른 스크립트 어디에서도 호출하지 않는 것만 골랐다.

**복원**: `git show <커밋>:crawlers/<파일> > crawlers/<파일>` (아래 표의 커밋 = 그 파일의 마지막 수정 커밋)

> 주의: 일부는 `__file__` 기준 상위 폴더로 `players.db`를 찾으므로 복원할 때 `crawlers/` 바로 아래에 둘 것. 나머지는 실행 위치 기준 `players.db`라 프로젝트 루트에서 실행.

| 파일 | 커밋 | 마지막 수정 | 용도 |
|------|------|-------------|------|
| `backfill_duel_detail.py` | 36834b3 | 2026-06-09 | match_player_stats 수비 세부 지표 백필 — raw_json에서 추출 |
| `backfill_orphan_events.py` | 1a00ed9 | 2026-06-01 | heatmap_points / mps가 참조하지만 events에 없는 경기 메타 보완 |
| `collect_missing_events.py` | 1a00ed9 | 2026-06-01 | K리그2 누락 이벤트 수집 |
| `fill_k1_player_names.py` | fb13380 | 2026-04-13 | K리그1 2026 선수 한국어 이름 최신화 |
| `fill_ko_names_from_api.py` | 1a00ed9 | 2026-06-01 | SofaScore player API의 한국어 이름 번역으로 name_ko 채우기 |
| `fill_ko_names_from_roster.py` | 2569e54 | 2026-04-12 | SofaScore 팀 로스터 API로 name_ko 채우기 |
| `fill_player_names.py` | b86b662 | 2026-04-10 | K2 출전 선수 name_ko 채우기 |
| `fill_player_physical.py` | f470222 | 2026-04-10 | K2 선수 키/몸무게/생년월일 — `fill_player_master.py`(STEP 11)로 대체됨 |
| `fix_duplicate_incidents.py` | 381ee60 | 2026-11-02 | 득점·교체·카드 중복 정리 (운영 반영 완료, 재발 방지는 `collect_goal_incidents.py`에 있음) |
| `fix_k3_mistag.py` | d5bde2e | 2026-06-12 | K3(10268) 라벨 손상 정리 |
| `fix_null_scores.py` | 1a00ed9 | 2026-06-01 | events 스코어 NULL 2건 보정 (2024-04-24 K2) |
| `fix_placeholder_ids.py` | 1a00ed9 | 2026-06-01 | 90xxxxxxx 임시 event_id를 실제 ID로 교체 후 라인업 수집 |
| `rebuild_teams_table.py` | 4db1919 | 2026-04-29 | teams 테이블 재구축 |
| `recollect_target_events.py` | 1a00ed9 | 2026-06-01 | 특정 event_id의 선수 스탯 재수집 |

남겨 둔 1회성 성격 스크립트(README에 도구로 소개됐거나 데이터 파일을 만드는 유일한 스크립트): `fix_swapped_scores.py`, `backfill_events.py`, `backfill_match_stats.py`, `crawl_stats_3yr.py`(→ `data/kleague_team_stats.json`), 초기 수집용 `crawl_*`·`fetch_*`.

## 2026-11-10 정리

| 파일 | 커밋 | 마지막 수정 | 용도 |
|------|------|-------------|------|
| `apply_name_ko_fix.py` | ab970df | 2026-11-04 | name_ko REVIEW 8건 교정 적용 (2026-11-04 운영 반영 완료) |
| `dedupe_events.py` | f63c706 | 2026-11-04 | events 이중 등록 병합 (2026-11-04 용인FC 13+4그룹 운영 반영 완료 · 재생성 ID는 이후 remap_event_ids.py STEP 29) |
| `crawl_stats_3yr.py` | 5b45060 | 2026-04-09 | 3시즌 선수 스탯 일괄 수집 (초기 구축용) |
| `fetch_player_names.py` | 5b45060 | 2026-04-09 | mps.player_name NULL 백필 (가비아 실행 완료, NULL 51,064 → 0) |
