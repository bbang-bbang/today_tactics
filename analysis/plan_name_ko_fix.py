#!/usr/bin/env python3
"""players.name_ko 오기 교정 '계획' 생성 (읽기 전용 — DB를 절대 바꾸지 않는다).

문제: players.name_ko 가 다른 사람 이름으로 잘못 들어 있거나(예: Seung-wook Park 의 name_ko='이창우', 공식=박승욱)
      비어 있다. 공식 K리그 선수 매핑(kleague_player_map)과 포털 명단(data/kleague_players_2026.json)으로 교정안을 만든다.

근거 3종(독립):
  E1 매핑 표: 같은 경기 출전 대조에서 이 SofaScore 선수 ↔ 공식 선수가 몇 번 일치했나 (votes/total)
  E2 로마자: 공식 한글 이름을 로마자로 바꿔 SofaScore 영문 이름과 자음 골격 유사도 비교 (외국인 표기는 낮게 나옴)
  E3 포털 명단: 포털 2026 명단에 (제안 이름, 같은 생년월일 ±1일) 이 있는가 — 가장 강한 근거

등급:
  AUTO   = E3 일치  또는  (E2 ≥ 0.75 이고 E1 전표 일치·표 2개 이상)  또는  (E1 전표 일치·표 5개 이상)
           또는 포털 기반 채움(영문과 로마자 0.85 이상)                → 적용 후보
  REVIEW = 그 외(표본 적음·로마자 낮음 등)                              → 사람이 확인
  출력: CSV(제안 목록). 적용은 별도 스크립트에서 AUTO 만, 백업 후, 사용자 확인을 받고 수행한다.

사용: python analysis/plan_name_ko_fix.py --db players.db --out analysis/output/name_ko_fix_plan.csv
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import difflib
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent

# ── 한글 → 로마자(개정 로마자 표기, 단순화) ────────────────────────────────
_INI = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
_MED = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
_FIN = ["", "k", "k", "k", "n", "n", "n", "t", "l", "l", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]


def romanize(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        if 0xAC00 <= o <= 0xD7A3:
            i = o - 0xAC00
            out.append(_INI[i // 588] + _MED[(i % 588) // 28] + _FIN[i % 28])
        elif ch.isalpha():
            out.append(ch.lower())
    return "".join(out)


def skeleton(s: str) -> str:
    """로마자 철자 변이(k/g, t/d, p/b, ch/j, r/l, wook/uk …)를 흡수하는 자음 골격."""
    s = re.sub(r"[^a-z]", "", s.lower())
    s = s.replace("ch", "j").replace("sh", "s")      # 'ng' 는 따로 합치지 않는다(음절 경계의 n+g 와 구분 불가 — 양쪽 모두 n,k 로 환원)
    s = re.sub(r"[aeiouwyh]", "", s)
    return s.translate(str.maketrans({"g": "k", "d": "t", "b": "p", "r": "l", "c": "k", "q": "k", "z": "j", "f": "p", "v": "p", "x": "k"}))


def roman_ratio(korean: str, english: str) -> float:
    r = skeleton(romanize(korean))
    toks = [t for t in re.split(r"\s+", (english or "").strip()) if t]
    cands = {"".join(toks)}
    if len(toks) == 2:
        cands.add(toks[1] + toks[0])      # 'Lee Tae-seok' / 'Tae-seok Lee' 어순 차이
    best = 0.0
    for e in cands:
        es = skeleton(e)
        if r and es:
            best = max(best, difflib.SequenceMatcher(None, r, es).ratio())
    return round(best, 2)


def norm(s: str | None) -> str:
    return re.sub(r"\(c\)|[\s·.\-]", "", s or "")


def is_hangul_name(s: str) -> bool:
    return bool(s) and all(0xAC00 <= ord(c) <= 0xD7A3 or c in " ·" for c in s)


def ts_to_date(v) -> dt.date | None:
    try:
        return dt.datetime.fromtimestamp(int(float(v)), dt.timezone.utc).date()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def load_portal():
    """(이름, 생년월일) → [팀키] — 포털 2026 명단."""
    f = ROOT / "data" / "kleague_players_2026.json"
    idx: dict[tuple[str, dt.date], list[str]] = {}
    by_dob: dict[dt.date, list[tuple[str, str]]] = {}
    for team, t in json.loads(f.read_text(encoding="utf-8")).items():
        for p in t.get("players", []):
            try:
                d = dt.datetime.strptime(p.get("dob", ""), "%Y/%m/%d").date()
            except ValueError:
                continue
            idx.setdefault((norm(p["name"]), d), []).append(team)
            by_dob.setdefault(d, []).append((norm(p["name"]), team))
    return idx, by_dob


def portal_hit(idx, name_n: str, dob: dt.date | None) -> str | None:
    if not dob:
        return None
    for delta in (0, -1, 1):                          # 타임존 보정 ±1일
        teams = idx.get((name_n, dob + dt.timedelta(days=delta)))
        if teams:
            return ",".join(sorted(set(teams)))
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "players.db"))
    ap.add_argument("--out", default=str(ROOT / "analysis" / "output" / "name_ko_fix_plan.csv"))
    args = ap.parse_args()
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)      # 읽기 전용 연결
    conn.row_factory = sqlite3.Row
    idx, by_dob = load_portal()
    games = {r[0]: r[1] for r in conn.execute("SELECT player_id, COUNT(*) FROM match_player_stats GROUP BY player_id")}

    rows = []
    # ① 공식 매핑 기반: 공식 이름 != name_ko (오기) 또는 name_ko 비어 있음/영문 그대로(미입력)
    for r in conn.execute("""SELECT m.player_kid, m.sofa_player_id sid, m.player_name off, m.votes, m.total, m.method,
                                    p.name_ko, p.name, p.dob, p.team_id
                             FROM kleague_player_map m JOIN players p ON p.id = m.sofa_player_id"""):
        cur_ko, off = r["name_ko"] or "", r["off"]
        if norm(cur_ko) == norm(off):
            continue
        kind = "빈값" if not cur_ko else ("영문그대로" if cur_ko == r["name"] else "오기")
        rows.append({"source": "map", "kind": kind, "sofa_id": r["sid"], "kid": r["player_kid"], "current": cur_ko,
                     "proposed": off, "english": r["name"], "games": games.get(r["sid"], 0), "team_id": r["team_id"],
                     "votes": f"{r['votes']}/{r['total']}", "full_votes": r["votes"] == r["total"] and r["total"] >= 2,
                     "dob": ts_to_date(r["dob"])})
    seen = {x["sofa_id"] for x in rows}
    # ② 포털 명단 기반: 매핑이 없는 선수 중 name_ko 가 비었거나 영문 그대로인 선수 — 생년월일이 포털과 '유일하게' 맞을 때만
    for r in conn.execute("""SELECT id, name, name_ko, dob, team_id FROM players
                             WHERE (name_ko IS NULL OR name_ko = '' OR name_ko = name) AND dob IS NOT NULL AND dob <> ''"""):
        if r["id"] in seen:
            continue
        d = ts_to_date(r["dob"])
        if not d:
            continue
        cands = set()
        for delta in (0, -1, 1):
            cands |= {n for n, _ in by_dob.get(d + dt.timedelta(days=delta), [])}
        if len(cands) != 1:
            continue                                   # 유일하지 않으면 제안하지 않음
        prop = next(iter(cands))
        # 영문 이름과 로마자가 거의 맞을 때만(생일이 같은 다른 사람 오탐 방지 — 0.6 은 오탐 실측: Kyu-pyo Kim ↔ 김승건)
        if roman_ratio(prop, r["name"]) < 0.85:
            continue
        rows.append({"source": "portal", "kind": "빈값" if not r["name_ko"] else "영문그대로", "sofa_id": r["id"], "kid": "",
                     "current": r["name_ko"] or "", "proposed": prop, "english": r["name"], "games": games.get(r["id"], 0),
                     "team_id": r["team_id"], "votes": "", "full_votes": False, "dob": d})

    for x in rows:
        x["roman"] = roman_ratio(x["proposed"], x["english"]) if is_hangul_name(x["proposed"]) else 0.0
        x["portal"] = portal_hit(idx, norm(x["proposed"]), x["dob"]) or ""
        votes_n = int(x["votes"].split("/")[1]) if x["votes"] else 0
        # 표가 5개 이상 전부 일치하면 우연일 수 없다(외국인 표기는 로마자 점수가 낮게 나오므로 별도 인정)
        strong = (bool(x["portal"]) or (x["roman"] >= 0.75 and x["full_votes"])
                  or (x["full_votes"] and votes_n >= 5) or x["source"] == "portal")
        x["grade"] = "AUTO" if strong else "REVIEW"
        # 교정 후에도 같은 이름 레코드가 또 있는지(중복 이름 생성 여부) — 참고용
        x["same_name_other_records"] = conn.execute(
            "SELECT COUNT(*) FROM players WHERE name_ko = ? AND id <> ?", (x["proposed"], x["sofa_id"])).fetchone()[0]

    rows.sort(key=lambda x: (x["grade"] != "AUTO", -x["games"]))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cols = ["grade", "source", "kind", "sofa_id", "kid", "current", "proposed", "english", "games", "team_id", "votes",
            "roman", "portal", "same_name_other_records", "dob"]
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    g = Counter((x["grade"], x["kind"]) for x in rows)
    print(f"교정 제안 {len(rows)}건 → {out}")
    for (grade, kind), n in sorted(g.items()):
        print(f"  {grade:6} {kind:6} {n}건 (경기 합 {sum(x['games'] for x in rows if x['grade']==grade and x['kind']==kind)})")
    print(f"  출처: " + ", ".join(f"{k} {v}" for k, v in Counter(x['source'] for x in rows).items()))
    print(f"  AUTO 중 포털 생년월일 일치: {sum(1 for x in rows if x['grade']=='AUTO' and x['portal'])}건 / 로마자+전표 일치: "
          f"{sum(1 for x in rows if x['grade']=='AUTO' and not x['portal'])}건")
    print(f"  교정 후 같은 이름 레코드가 또 있는 건(중복 이름 유지): {sum(1 for x in rows if x['same_name_other_records'])}건")
    conn.close()


if __name__ == "__main__":
    main()
