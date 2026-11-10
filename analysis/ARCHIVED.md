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
