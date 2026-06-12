# -*- coding: utf-8 -*-
"""
match_lineups.detail_pos 백필 — 세부 포지션 라벨 결정론적 유도.

근거: SofaScore lineup API가 선발을 포메이션 슬롯 순서(slot_order 0~10)로 정렬해
      준다. 슬롯은 [GK -> 수비라인 -> ... -> 공격라인] 순이며, 라인 내부는
      좌우(lateral) 순서다(평균좌표 대조 결과 80% 단조 일치 — 추정이 아닌 실제
      배치 인코딩). formation + slot_order -> 세부 포지션을 매핑표로 변환한다.

라벨(8종): GK / CB / FB(풀백) / WB(윙백) / DM / CM / AM / W(윙어) / ST
      ※ FB/WB는 비교 풀링 시 동일 그룹(측면 수비)으로 합칠 수 있음.

멱등: 전 선발 행을 매번 UPDATE. 컬럼 없으면 ALTER TABLE로 추가(무손실).
"""
import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "players.db")

# 포메이션별 슬롯(0..10) -> 세부 포지션. 라인 내부는 좌->우(=y 오름차순) 슬롯 순서.
FORMATION_MAP = {
    # --- 주요 15개 (선발행 99.4%) ---
    "4-4-2":   ["GK", "FB", "CB", "CB", "FB", "W", "CM", "CM", "W", "ST", "ST"],
    "3-4-3":   ["GK", "CB", "CB", "CB", "W", "CM", "CM", "W", "W", "ST", "W"],
    "4-2-3-1": ["GK", "FB", "CB", "CB", "FB", "DM", "DM", "W", "AM", "W", "ST"],
    "4-3-3":   ["GK", "FB", "CB", "CB", "FB", "CM", "CM", "CM", "W", "ST", "W"],
    "5-4-1":   ["GK", "WB", "CB", "CB", "CB", "WB", "W", "CM", "CM", "W", "ST"],
    "4-1-4-1": ["GK", "FB", "CB", "CB", "FB", "DM", "W", "CM", "CM", "W", "ST"],
    "3-5-2":   ["GK", "CB", "CB", "CB", "WB", "CM", "CM", "CM", "WB", "ST", "ST"],
    "5-3-2":   ["GK", "WB", "CB", "CB", "CB", "WB", "CM", "CM", "CM", "ST", "ST"],
    "4-5-1":   ["GK", "FB", "CB", "CB", "FB", "W", "CM", "CM", "CM", "W", "ST"],
    "3-4-2-1": ["GK", "CB", "CB", "CB", "WB", "CM", "CM", "WB", "AM", "AM", "ST"],
    "3-4-1-2": ["GK", "CB", "CB", "CB", "WB", "CM", "CM", "WB", "AM", "ST", "ST"],
    "4-4-1-1": ["GK", "FB", "CB", "CB", "FB", "W", "CM", "CM", "W", "AM", "ST"],
    "3-1-4-2": ["GK", "CB", "CB", "CB", "DM", "WB", "CM", "CM", "WB", "ST", "ST"],
    "4-1-3-2": ["GK", "FB", "CB", "CB", "FB", "DM", "AM", "AM", "AM", "ST", "ST"],
    "3-2-4-1": ["GK", "CB", "CB", "CB", "DM", "DM", "W", "AM", "AM", "W", "ST"],
    # --- 희소 9개 (나머지 0.6%) ---
    "3-3-3-1": ["GK", "CB", "CB", "CB", "CM", "CM", "CM", "AM", "AM", "AM", "ST"],
    "3-5-1-1": ["GK", "CB", "CB", "CB", "WB", "CM", "CM", "CM", "WB", "AM", "ST"],
    "3-6-1":   ["GK", "CB", "CB", "CB", "WB", "CM", "CM", "CM", "CM", "WB", "ST"],
    "4-2-1-3": ["GK", "FB", "CB", "CB", "FB", "DM", "DM", "AM", "W", "ST", "W"],
    "4-2-2-2": ["GK", "FB", "CB", "CB", "FB", "DM", "DM", "AM", "AM", "ST", "ST"],
    "4-2-4":   ["GK", "FB", "CB", "CB", "FB", "CM", "CM", "W", "ST", "ST", "W"],
    "4-3-1-2": ["GK", "FB", "CB", "CB", "FB", "CM", "CM", "CM", "AM", "ST", "ST"],
    "4-3-2-1": ["GK", "FB", "CB", "CB", "FB", "CM", "CM", "CM", "AM", "AM", "ST"],
    "5-2-3":   ["GK", "WB", "CB", "CB", "CB", "WB", "CM", "CM", "W", "ST", "W"],
}


def _defense_labels(size):
    if size <= 3:
        return ["CB"] * size
    # 4백 -> 바깥 FB, 5백 이상 -> 바깥 WB
    wide = "FB" if size == 4 else "WB"
    return [wide] + ["CB"] * (size - 2) + [wide]


def _attack_labels(size):
    if size == 1:
        return ["ST"]
    if size == 2:
        return ["ST", "ST"]
    # 3 이상 -> 바깥 윙어, 안쪽 ST
    return ["W"] + ["ST"] * (size - 2) + ["W"]


def _mid_labels(size, vrole):
    # vrole: 'DM' | 'CM' | 'AM' (해당 미드 밴드의 수직 역할)
    if size >= 4:
        # 큰 미드 밴드는 바깥을 측면(공격 밴드=윙어, 그 외=윙백), 안쪽은 수직 역할
        wide = "W" if vrole == "AM" else "WB"
        inner = "CM" if vrole == "DM" else vrole
        return [wide] + [inner] * (size - 2) + [wide]
    return [vrole] * size


def detail_positions(formation):
    """formation 문자열 -> 슬롯 순서 세부 포지션 리스트. 알려진 표 우선, 없으면 제네릭."""
    if not formation:
        return None
    f = formation.strip()
    if f in FORMATION_MAP:
        return FORMATION_MAP[f]
    # 제네릭 폴백
    try:
        lines = [int(x) for x in f.split("-")]
    except ValueError:
        return None
    if sum(lines) != 10:  # +GK = 11
        return None
    labels = ["GK"]
    labels += _defense_labels(lines[0])
    mids = lines[1:-1]
    for i, m in enumerate(mids):
        if len(mids) == 1:
            vrole = "CM"
        elif i == 0:
            vrole = "DM"
        elif i == len(mids) - 1:
            vrole = "AM"
        else:
            vrole = "CM"
        labels += _mid_labels(m, vrole)
    labels += _attack_labels(lines[-1])
    return labels if len(labels) == 11 else None


def ensure_column(conn):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(match_lineups)").fetchall()]
    if "detail_pos" not in cols:
        conn.execute("ALTER TABLE match_lineups ADD COLUMN detail_pos TEXT")
        print("[migrate] added match_lineups.detail_pos")
    else:
        print("[migrate] detail_pos already exists")


def backfill(conn):
    rows = conn.execute(
        "SELECT event_id, is_home, formation, slot_order "
        "FROM match_lineups "
        "WHERE is_starter=1 AND slot_order IS NOT NULL "
        "AND formation IS NOT NULL AND formation != ''"
    ).fetchall()
    cache = {}
    updated = 0
    skipped = 0
    unknown = {}
    for event_id, is_home, formation, slot in rows:
        if formation not in cache:
            cache[formation] = detail_positions(formation)
        labels = cache[formation]
        if not labels or slot < 0 or slot >= len(labels):
            skipped += 1
            unknown[formation] = unknown.get(formation, 0) + 1
            continue
        conn.execute(
            "UPDATE match_lineups SET detail_pos=? "
            "WHERE event_id=? AND is_home=? AND slot_order=? AND is_starter=1",
            (labels[slot], event_id, is_home, slot),
        )
        updated += 1
    conn.commit()
    print(f"[backfill] updated={updated} skipped={skipped}")
    if unknown:
        print("[backfill] unmapped formations:", unknown)


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        ensure_column(conn)
        backfill(conn)
        # 요약
        dist = conn.execute(
            "SELECT detail_pos, COUNT(*) FROM match_lineups "
            "WHERE detail_pos IS NOT NULL GROUP BY detail_pos ORDER BY 2 DESC"
        ).fetchall()
        print("[summary] detail_pos distribution:")
        for pos, n in dist:
            print(f"   {pos:>3}  {n}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
