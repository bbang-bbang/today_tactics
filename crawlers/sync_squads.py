"""공식 선수 JSON(data/kleague_players_2026.json) → 내장 스쿼드 파일 동기화.

대상: squads/default_{팀}.json · squads/{팀}_2026.json  (내장 스쿼드 2종)
제외: 사용자가 전술판에서 저장한 스쿼드(8자리 hex 파일명) — 절대 건드리지 않음.

- default_*: 선수 목록을 공식 JSON 기준으로 교체 (id·name·createdAt 유지)
- {팀}_2026: 선수 단위 병합 — 남는 선수는 id·배치(onField/x/y/slotIdx) 보존,
  빠진 선수는 제거(배치 중이었다면 경고), 새 선수는 벤치(onField=false)로 추가
- 공식 JSON 과 달라진 파일만 쓴다(멱등). 기본은 dry-run, --apply 로 저장.

이적(시즌 중·겨울)으로 공식 JSON 이 갱신되면 이 스크립트가 스쿼드를 따라가게 한다
(_init_default_squads 는 '이미 있으면 덮어쓰지 않음'이라 한 번 만든 뒤 갱신되지 않던 문제).
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAYERS_JSON = os.path.join(BASE_DIR, "data", "kleague_players_2026.json")
SQUADS_DIR = os.path.join(BASE_DIR, "squads")
FIELDS = ("number", "name", "position", "height", "weight", "dob")
MIN_PLAYERS = 11          # 이보다 적으면 공식 JSON 수집 이상으로 보고 해당 팀은 건너뜀


def _official(p):
    return {
        "number": p.get("number"),
        "name": p["name"],
        "position": p.get("position", ""),
        "height": p.get("height", 0),
        "weight": p.get("weight", 0),
        "dob": p.get("dob", ""),
    }


def _match(existing, off_list):
    """공식 선수 → 기존 항목 매칭. (이름, 생년월일) 우선, 없으면 이름. 반환: [(off, ex|None)], 남은 ex."""
    pool = list(existing)
    pairs = []
    for off in off_list:
        hit = next((e for e in pool if e.get("name") == off["name"] and e.get("dob") == off["dob"]), None)
        if hit is None:
            hit = next((e for e in pool if e.get("name") == off["name"]), None)
        if hit is not None:
            pool.remove(hit)
        pairs.append((off, hit))
    return pairs, pool


def _write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def sync_default(path, off_list):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    old = data.get("players", [])
    pairs, dropped = _match(old, off_list)
    added = [o["name"] for o, e in pairs if e is None]
    removed = [e["name"] for e in dropped]
    changed = [o["name"] for o, e in pairs
               if e is not None and any(e.get(k) != o[k] for k in FIELDS)]
    if not (added or removed or changed):
        return None
    data["players"] = list(off_list)
    return data, added, removed, changed, 0


def sync_team(path, off_list):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    old = data.get("players", [])
    pairs, dropped = _match(old, off_list)
    new_players, added, changed = [], [], []
    for off, ex in pairs:
        if ex is None:
            new_players.append({"id": uuid.uuid4().hex[:8], **off,
                                "onField": False, "x": 0, "y": 0, "slotIdx": None})
            added.append(off["name"])
            continue
        if any(ex.get(k) != off[k] for k in FIELDS):
            changed.append(off["name"])
        new_players.append({**ex, **off})
    removed = [e["name"] for e in dropped]
    on_field = sum(1 for e in dropped if e.get("onField"))
    if not (added or removed or changed):
        return None
    data["players"] = new_players
    return data, added, removed, changed, on_field


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="저장(기본은 dry-run)")
    ap.add_argument("--team", help="한 팀만 (예: ulsan)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    if not os.path.exists(PLAYERS_JSON):
        print("공식 선수 JSON 없음 — 건너뜀")
        return 0
    with open(PLAYERS_JSON, "r", encoding="utf-8") as f:
        allp = json.load(f)

    now = datetime.now().isoformat()
    tot = {"files": 0, "added": 0, "removed": 0}
    for tid, tdata in allp.items():
        if args.team and tid != args.team:
            continue
        off_list = [_official(p) for p in tdata.get("players", []) if p.get("name")]
        if len(off_list) < MIN_PLAYERS:
            print(f"[{tid}] 공식 선수 {len(off_list)}명 — 수집 이상 의심, 건너뜀")
            continue
        for kind, fname, fn in (("default", f"default_{tid}.json", sync_default),
                                ("team", f"{tid}_2026.json", sync_team)):
            path = os.path.join(SQUADS_DIR, fname)
            if not os.path.exists(path):
                continue
            res = fn(path, off_list)
            if not res:
                continue
            data, added, removed, changed, on_field = res
            tot["files"] += 1
            tot["added"] += len(added)
            tot["removed"] += len(removed)
            warn = f"  ⚠ 배치 중 {on_field}명 제거" if on_field else ""
            print(f"[{fname}] +{len(added)} -{len(removed)} ~{len(changed)}{warn}")
            if kind == "team":              # 기본 스쿼드 한 쌍은 같은 내용이므로 상세는 한 번만
                if added:
                    print("    + " + ", ".join(added))
                if removed:
                    print("    - " + ", ".join(removed))
            if args.apply:
                data["updatedAt"] = now
                _write(path, data)
    mode = "저장 완료" if args.apply else "dry-run (저장 안 함 — --apply 로 저장)"
    print(f"\n변경 파일 {tot['files']}개 · 추가 {tot['added']} · 제거 {tot['removed']} — {mode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
