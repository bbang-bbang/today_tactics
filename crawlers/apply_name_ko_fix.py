#!/usr/bin/env python3
"""players.name_ko 오기 교정 적용 (analysis/plan_name_ko_fix.py 가 만든 CSV 의 AUTO 행만).

안전장치:
  - 기본은 dry-run(DB 변경 없음). --apply 를 줘야 쓴다.
  - 각 행은 '현재 name_ko 가 계획 작성 시점 값과 같을 때만' 바꾼다(그 사이 바뀐 행은 건너뛰고 보고).
  - 제안 이름은 한글(+공백·가운뎃점) 1~30자만 허용 — 이상한 값은 건너뛴다.
  - players.name_ko 한 컬럼만 UPDATE. 적용 전후로 name_ko 를 제외한 나머지 컬럼의 해시가 같음을 검증한다.
  - 적용 전 롤백 JSON(id, old, new)을 먼저 파일로 쓴다. 스키마 변경 없음.
  - 쓰기는 한 트랜잭션 — 중간 오류 시 전체 롤백.
  - 적용 후 .cache_generation 마커를 갱신해 모든 gunicorn 워커의 API 캐시를 비운다(재시작 불필요).

사용:
  python crawlers/apply_name_ko_fix.py --plan name_ko_fix_plan.csv                 # dry-run
  python crawlers/apply_name_ko_fix.py --plan name_ko_fix_plan.csv --apply --rollback-dir /var/backups/today_tactics
롤백:
  python crawlers/apply_name_ko_fix.py --rollback-file <롤백 JSON> --apply
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
HANGUL_NAME = re.compile(r"^[가-힣][가-힣 ·]{0,29}$")


def other_columns_hash(conn) -> str:
    """name_ko 를 제외한 players 전체 내용의 해시 — 적용 전후 비교용."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(players)") if r[1] != "name_ko"]
    h = hashlib.sha256()
    for row in conn.execute("SELECT " + ", ".join(cols) + " FROM players ORDER BY id"):   # 컬럼명은 PRAGMA 결과(고정)
        h.update(repr(tuple(row)).encode("utf-8"))
    return h.hexdigest()


def bump_cache_generation() -> None:
    gen = ROOT / ".cache_generation"
    gen.write_text(str(time.time_ns()), encoding="ascii")
    os.utime(gen, None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", help="plan_name_ko_fix.py 가 만든 CSV")
    ap.add_argument("--rollback-file", help="롤백 JSON 으로 되돌리기")
    ap.add_argument("--db", default=str(ROOT / "players.db"))
    ap.add_argument("--grade", default="AUTO", choices=["AUTO"], help="AUTO 행만 허용(REVIEW 는 사람이 확인 후 별도 처리)")
    ap.add_argument("--rollback-dir", default=str(ROOT))
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    todo: list[tuple[int, str, str]] = []      # (id, expect_old, new)
    skipped: list[str] = []

    if args.rollback_file:
        for e in json.loads(Path(args.rollback_file).read_text(encoding="utf-8")):
            todo.append((e["id"], e["new"], e["old"]))          # 되돌리기: 현재(new) 일 때만 old 로
        mode = "롤백"
    else:
        if not args.plan:
            ap.error("--plan 또는 --rollback-file 필요")
        mode = "적용"
        for r in csv.DictReader(open(args.plan, encoding="utf-8-sig")):
            if r["grade"] != args.grade:
                continue
            sid, cur_plan, prop = int(r["sofa_id"]), r["current"], r["proposed"].strip()
            if not HANGUL_NAME.match(prop):
                skipped.append(f"{sid}: 제안 이름 형식 이상 {prop!r}")
                continue
            row = conn.execute("SELECT name_ko FROM players WHERE id = ?", (sid,)).fetchone()
            if row is None:
                skipped.append(f"{sid}: players 에 없음")
            elif (row[0] or "") != cur_plan:
                skipped.append(f"{sid}: 계획 이후 값이 바뀜(현재 {row[0]!r}, 계획 {cur_plan!r})")
            elif cur_plan == prop:
                skipped.append(f"{sid}: 이미 같은 값")
            else:
                todo.append((sid, cur_plan, prop))

    print(f"[{mode}] 대상 {len(todo)}건 · 건너뜀 {len(skipped)}건 · {'APPLY' if args.apply else 'DRY-RUN(저장 안 함)'}")
    for s in skipped[:15]:
        print("  건너뜀:", s)
    for sid, old, new in todo[:6]:
        print(f"  예) id={sid} {old!r} → {new!r}")
    if not args.apply or not todo:
        conn.close()
        return 0

    before_n = conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    before_hash = other_columns_hash(conn)
    rb_path = None
    if mode == "적용":
        rb_dir = Path(args.rollback_dir)
        rb_dir.mkdir(parents=True, exist_ok=True)
        rb_path = rb_dir / f"name_ko_fix_rollback_{time.strftime('%Y%m%d_%H%M%S')}.json"
        rb_path.write_text(json.dumps([{"id": i, "old": o, "new": n} for i, o, n in todo], ensure_ascii=False, indent=1),
                           encoding="utf-8")
        print(f"  롤백 파일 기록: {rb_path}")

    changed = 0
    try:
        with conn:                                              # 한 트랜잭션 — 예외 시 전체 롤백
            for sid, old, new in todo:
                cur = conn.execute("UPDATE players SET name_ko = ? WHERE id = ? AND COALESCE(name_ko, '') = ?", (new, sid, old))
                changed += cur.rowcount
            if changed != len(todo):
                raise RuntimeError(f"UPDATE 건수 불일치: 기대 {len(todo)} 실제 {changed}")
            if conn.execute("SELECT COUNT(*) FROM players").fetchone()[0] != before_n or other_columns_hash(conn) != before_hash:
                raise RuntimeError("name_ko 외 컬럼 또는 행 수가 변경됨 — 롤백")
    except Exception as e:
        print(f"[실패] 전체 롤백됨: {e}")
        conn.close()
        return 1
    conn.close()
    bump_cache_generation()
    print(f"[완료] {changed}건 변경 · name_ko 외 컬럼/행 수 불변 확인 · 캐시 세대 갱신")
    return 0


if __name__ == "__main__":
    sys.exit(main())
