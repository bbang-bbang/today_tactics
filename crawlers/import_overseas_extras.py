#!/usr/bin/env python3
"""
로컬에서 수집한 해외 리그 슈팅맵·평균 위치(collect_sofascore_overseas.py)를 운영 리그 DB 에 반영. 2026-11-24.

src DB 에 들어 있는 경기(event_id)만 dst 에서 지우고 다시 넣는다(멱등) — 다른 테이블·다른 경기는 건드리지 않음.
--apply 전에 dst 를 sqlite backup 으로 스냅샷(--backup-dir).

사용(서버):
  python crawlers/import_overseas_extras.py --src /home/rocky/jleague1_extras.db --dst /opt/today_tactics/jleague1.db
  python crawlers/import_overseas_extras.py --src ... --dst ... --apply --backup-dir /home/rocky
"""
import argparse
import sqlite3
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

TABLES = {
    "match_shotmap": ["event_id", "player_id", "player_name", "team_id", "is_home", "x", "y", "xg", "outcome",
                      "situation", "body_part", "minute", "added_time"],
    "match_avg_positions": ["event_id", "player_id", "team_id", "is_home", "is_substitute", "avg_x", "avg_y"],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir")
    a = ap.parse_args()
    src = sqlite3.connect(f"file:{a.src}?mode=ro", uri=True)
    events = sorted({r[0] for t in TABLES for r in src.execute(f"SELECT DISTINCT event_id FROM {t}")})   # 테이블명은 상수
    dst = sqlite3.connect(a.dst, timeout=60)
    known = {r[0] for r in dst.execute("SELECT id FROM events")}
    unknown = [e for e in events if e not in known]
    print(f"src 경기 {len(events)} · dst 에 없는 경기 {len(unknown)}"
          + (f" (예: {unknown[:3]}) — 건너뜀" if unknown else ""))
    events = [e for e in events if e in known]
    rows = {t: [r for r in src.execute(f"SELECT {', '.join(c)} FROM {t}") if r[0] in set(events)] for t, c in TABLES.items()}
    for t in TABLES:
        before = dst.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"  {t}: dst {before}행 → 반영 대상 {len(rows[t])}행")
    if not a.apply:
        print("(dry-run — 바꾸지 않음)")
        return 0
    if a.backup_dir:
        bk = Path(a.backup_dir) / f"{Path(a.dst).stem}_pre_extras_{time.strftime('%Y%m%d_%H%M%S')}.db"
        with sqlite3.connect(bk) as b:
            dst.backup(b)
        print(f"  백업: {bk}")
    ph = ",".join("?" * len(events)) or "NULL"
    with dst:
        for t, cols in TABLES.items():
            dst.execute(f"DELETE FROM {t} WHERE event_id IN ({ph})", events)      # ph 는 '?' 자리표시자만
            dst.executemany(f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", rows[t])
    for t in TABLES:
        print(f"  {t}: 반영 후 {dst.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}행")
    return 0


if __name__ == "__main__":
    sys.exit(main())
