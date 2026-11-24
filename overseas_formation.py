"""해외 리그 선발 grid → 팀 포메이션 복원 (2026-11-24).

API-Football /fixtures/lineups 의 grid("줄:열", 1줄 = GK)를 collect_apifootball_lineups.py 가
match_lineups.formation_slot 에 저장한다. 포메이션 문자열 자체는 저장하지 않으므로, 경기·팀(event_id, is_home)별
선발 11명의 줄별 인원을 세어 복원한다(예: 2줄 4 · 3줄 3 · 4줄 3 → '4-3-3'). 수집기·스키마 변경 없음.
영입 추천에서 '사실 표시'로만 쓴다 — 점수·순위에 반영하지 않는다.
"""
from collections import Counter, defaultdict


def formation_from_grids(grids):
    """선발 11명의 grid 목록 → '4-3-3' 형식. 11명이 아니거나 GK 줄이 1명이 아니거나 파싱 불가면 None."""
    if not grids or len(grids) != 11:
        return None
    per_row = Counter()
    for g in grids:
        if not isinstance(g, str) or ":" not in g:
            return None
        row = g.split(":", 1)[0]
        if not row.isdigit():
            return None
        per_row[int(row)] += 1
    if per_row.get(1) != 1:
        return None
    rows = sorted(r for r in per_row if r != 1)
    if not rows or rows != list(range(2, 2 + len(rows))):     # 줄 번호가 끊기면 신뢰 불가
        return None
    return "-".join(str(per_row[r]) for r in rows)


def formation_family(f):
    """포메이션 첫 숫자(수비 줄 인원) → '3백'(3·5) / '4백'(4) / None."""
    if not isinstance(f, str) or not f[:1].isdigit():
        return None
    return {"3": "3백", "5": "3백", "4": "4백"}.get(f[0])


def player_formations(rows):
    """(event_id, is_home, player_id, grid) 행들 → {player_id: {"main", "fam": {계열: 선발 수}, "n"}}.
    포메이션을 복원하지 못한 경기는 집계에서 뺀다."""
    teams = defaultdict(list)
    for ev, home, pid, grid in rows:
        teams[(ev, home)].append((pid, grid))
    per_player = defaultdict(Counter)
    for members in teams.values():
        f = formation_from_grids([g for _p, g in members])
        if not f:
            continue
        for pid, _g in members:
            per_player[pid][f] += 1
    out = {}
    for pid, cnt in per_player.items():
        fam = Counter()
        for f, n in cnt.items():
            k = formation_family(f)
            if k:
                fam[k] += n
        out[pid] = {"main": cnt.most_common(1)[0][0], "fam": dict(fam), "n": sum(cnt.values())}
    return out
