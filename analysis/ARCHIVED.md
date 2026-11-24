# 정리한 분석 스크립트 (2026-11-10)

코드·문서 어디에서도 참조되지 않는 1회성 탐색/진단 스크립트. 파일은 git 기록에 그대로 있다.

**복원**: `git show <커밋>:analysis/<파일> > analysis/<파일>` (아래 표의 커밋 = 그 파일의 마지막 수정 커밋)

| 파일 | 커밋 | 마지막 수정 | 용도 |
|------|------|-------------|------|
| `analysis_by_year.py` | 5b45060 | 2026-04-09 | 연도별 기초 분석 (초기 탐색) |
| `analysis_deep.py` | 1a00ed9 | 2026-06-01 | 심화 분석 PNG 생성 (초기 탐색, 현 화면 인사이트로 대체) |
| `analysis_winrate.py` | 1a00ed9 | 2026-06-01 | 승률 분석 (초기 탐색) |
| `measure_slot_avg_mismatch.py` | 1a00ed9 | 2026-06-01 | 라인업 슬롯 vs 평균 위치 불일치 측정 (1회 진단) |
| `verify_lineup_integrity.py` | 1a00ed9 | 2026-06-01 | 라인업 무결성 1회 검증 (이후 recover_lineups_kleague --compare 로 대체) |

## 2026-11-24 정리

| 파일 | 커밋 | 마지막 수정 | 용도 |
|------|------|-------------|------|
| `predict_split_experiment.py` | 5b2c73e | 2026-05-27 | 홈/원정 분리 레이팅 실험 (결론: K1 롤링 홈 이점으로 대체) |
| `verify_avg_override_all.py` | 1a00ed9 | 2026-06-01 | 평균 위치 기반 슬롯 변환 1회 검증 (6월 포메이션 로직 전환) |
| `verify_b_method_all.py` | 1a00ed9 | 2026-06-01 | 포메이션 재도출·슬롯 swap 비율 1회 검증 (위와 같음) |
| `verify_cluster_formation.py` | 1a00ed9 | 2026-06-01 | 평균 위치 클러스터링 포메이션 1회 검증 (위와 같음) |
| `deep_audit_samples.py` | 1a00ed9 | 2026-06-01 | 드문 포메이션 표본 감사 (위와 같음) |
| `compute_rest_days.py` | c2a484d | 2026-04-15 | events 휴식일 컬럼 계산 — 현재는 main.py `_team_rest_days` 가 매번 계산(컬럼 미사용) |

`output/` 의 초기 탐색 PNG 14개(`analysis_*`·`deep_*`, 위 `analysis_by_year.py`·`analysis_deep.py` 산출물)도 함께 정리 — 복원은 `git show 5b45060:analysis/output/<파일>`.
남김: `predict_tuning_sweep.py` — 예측 K1 2024 기준선 미달(보류) 재검토 때 첫 도구.
