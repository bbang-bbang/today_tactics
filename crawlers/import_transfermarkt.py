#!/usr/bin/env python3
"""
Transfermarkt 공개 데이터셋(github.com/dcaribou/transfermarkt-datasets, CC0 배포) → transfermarkt.db + 우리 선수 연결. 2026-11-25.

- Transfermarkt 사이트를 직접 긁지 않는다 — 공개된 데이터 파일(R2 CSV) 4개만 1회 내려받음.
- 데이터 시점: 데이터셋 업데이트가 2026-07 부터 멈춤(시장가치 ~2026-06-12, 2026/27 스쿼드 없음) → 화면엔 '기준일' 함께 표시.
- 연결: 생년월일 일치 + 이름 일치(이니셜+성 / 토큰 포함)인 후보가 정확히 1명일 때만. 생년월일 없으면 연결 안 함.
- 리그 DB·players.db 는 바꾸지 않는다 — 연결표(tm_map)는 transfermarkt.db 에.

사용:
  python crawlers/import_transfermarkt.py            # dry-run: 내려받기 + 리그별 연결 수만 출력(DB 안 만듦)
  python crawlers/import_transfermarkt.py --apply    # transfermarkt.db 생성/교체
  python crawlers/import_transfermarkt.py --apply --src <CSV 폴더>   # 이미 받은 파일 사용
"""
import argparse
import csv
import gzip
import io
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.request
from collections import defaultdict
from difflib import SequenceMatcher
from datetime import datetime, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
BASE_URL = "https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data/"
FILES = ("players", "player_valuations", "clubs", "competitions")
OUT_DB = ROOT / "transfermarkt.db"


# ── 연결 규칙 (순수 함수, analysis/verify_transfermarkt_match.py) ─────────────
def norm_dob(v):
    """유닉스초(정수/숫자 문자열) 또는 'YYYY-MM-DD…' → 'YYYY-MM-DD'. 초는 +12시간 뒤 UTC 날짜(KST 자정 저장분 보정)."""
    if v is None or v == "":
        return None
    s = str(v).strip()
    if re.fullmatch(r"-?\d{6,}", s):
        try:
            return datetime.fromtimestamp(int(s) + 43200, tz=timezone.utc).strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            return None
    m = re.match(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None


_CHAR = str.maketrans({"ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss",
                       "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ı": "i"})


def _tokens(name):
    s = unicodedata.normalize("NFKD", str(name or "").translate(_CHAR)).encode("ascii", "ignore").decode().lower()
    s = s.replace("-", "").replace("'", "")
    return [t for t in re.split(r"[^a-z0-9]+", s) if t]


_KO_RULES = (("eui", "ui"), ("eo", "u"), ("oo", "u"), ("wu", "u"), ("ou", "u"), ("oe", "oi"), ("ahn", "an"),
             ("ch", "j"), ("k", "g"), ("t", "d"), ("p", "b"), ("sh", "s"))


def _ko_canon(s):
    """한국어 이름 로마자 표기 흔들림 정규화(양쪽에 같게 적용). 예: 'seungkyeom'·'seungkyum' → 같은 값."""
    for a, b in _KO_RULES:
        s = s.replace(a, b)
    return s


def name_score(ours, theirs):
    """2 = 확실(이니셜+성 / 토큰 포함 / 처음·끝 일치) · 1 = 느슨(표기 변형) · 0 = 아님."""
    a, b = _tokens(ours), _tokens(theirs)
    if not a or not b:
        return 0
    if len(a) >= 2 and len(a[0]) == 1:                       # 'T. Kaneko'
        return 2 if a[-1] == b[-1] and b[0].startswith(a[0]) else 0
    sa, sb = set(a), set(b)
    if sa <= sb or sb <= sa:
        return 2
    if a[0] == b[0] and a[-1] == b[-1]:
        return 2
    # 로마자 표기 변형·성 이름 순서 바뀜 — 생년월일이 같다는 전제에서만 쓰는 느슨한 규칙(공통 토큰 = 성이 있어야 함):
    #  ① 한국어 로마자 정규화(eo→u, oo→u, eui→ui, oe→oi, k→g, t→d, p→b, ch→j …) 후 나머지 이름이 같음
    #     (kyeom/kyum · myeong/myung · kyu/gyu · choi/choe — 재준/재민처럼 한 음절이 다른 이름은 다른 사람)
    #  ② 외국 이름 철자 변형(Iskandarov/Iskanderov) — 철자 유사도 ≥ 0.85
    common = sa & sb
    if not common:
        return 0
    ra, rb = "".join(t for t in a if t not in common), "".join(t for t in b if t not in common)
    if not ra or not rb:
        return 0
    if _ko_canon(ra) == _ko_canon(rb):
        return 1
    return 1 if SequenceMatcher(None, ra, rb).ratio() >= 0.85 else 0


def name_match(ours, theirs):
    return name_score(ours, theirs) > 0


def pick(name, dob, tm_by_dob):
    """같은 생년월일 TM 선수 중 확실한 일치가 정확히 1명이면 그 id, 확실한 일치가 없으면 느슨한 일치가 정확히 1명일 때만."""
    if not dob:
        return None
    sc = [(pid, name_score(name, nm)) for pid, nm in tm_by_dob.get(dob, [])]
    for level in (2, 1):
        hits = [pid for pid, s_ in sc if s_ == level]
        if hits:
            return hits[0] if len(hits) == 1 else None
    return None


# ── 내려받기·적재 ──────────────────────────────────────────────────────────
def load_csv(name, src):
    if src:
        p = Path(src) / f"{name}.csv.gz"
        raw = p.read_bytes()
    else:
        req = urllib.request.Request(BASE_URL + f"{name}.csv.gz", headers={"User-Agent": "today-tactics-data-import"})
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read()
    return list(csv.DictReader(io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(raw)), encoding="utf-8")))


def _i(v):
    try:
        return int(float(v)) if v not in (None, "") else None
    except ValueError:
        return None


def our_players():
    """(league_code, db_path, [(player_id, name, dob)]) — K리그 players.db + 해외 리그 DB 전부."""
    out = []
    k = ROOT / "players.db"
    if k.exists():
        c = sqlite3.connect(f"file:{k}?mode=ro", uri=True)
        out.append(("kleague", [(r[0], r[1], norm_dob(r[2])) for r in c.execute("SELECT id, name, dob FROM players")]))
        c.close()
    for f in sorted(ROOT.glob("*.db")):
        if f.name in ("players.db", "transfermarkt.db"):
            continue
        try:
            c = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
            rows = [(r[0], r[1], norm_dob(r[2])) for r in c.execute("SELECT id, name, birth_date FROM players")]
            c.close()
        except sqlite3.Error:
            continue
        if rows:
            out.append((f.stem, rows))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--src", help="이미 받은 CSV(.csv.gz) 폴더")
    a = ap.parse_args()
    t0 = time.time()
    data = {n: load_csv(n, a.src) for n in FILES}
    print("내려받음: " + " · ".join(f"{n} {len(v):,}행" for n, v in data.items()) + f" ({time.time() - t0:.0f}s)")
    tm_by_dob = defaultdict(list)
    for r in data["players"]:
        d = norm_dob(r.get("date_of_birth"))
        if d and r.get("player_id"):
            tm_by_dob[d].append((int(r["player_id"]), r.get("name") or ""))
    maps = []
    for code, rows in our_players():
        n = len(rows)
        with_dob = sum(1 for _p, _n, d in rows if d)
        hit = [(code, pid, pick(nm, d, tm_by_dob)) for pid, nm, d in rows]
        hit = [h for h in hit if h[2]]
        maps += hit
        print(f"  {code:14s} 선수 {n:5d} · 생년월일 {with_dob:5d} · 연결 {len(hit):5d} ({len(hit) / n * 100 if n else 0:4.1f}%)")
    print(f"연결 합계 {len(maps):,}")
    if not a.apply:
        print("(dry-run — transfermarkt.db 만들지 않음)")
        return 0
    tmp = OUT_DB.with_suffix(".db.tmp")
    if tmp.exists():
        tmp.unlink()
    c = sqlite3.connect(tmp)
    c.executescript("""
        CREATE TABLE tm_players (player_id INTEGER PRIMARY KEY, name TEXT, dob TEXT, citizenship TEXT, position TEXT,
            sub_position TEXT, foot TEXT, height INTEGER, club_id INTEGER, club_name TEXT, competition_id TEXT,
            market_value INTEGER, highest_value INTEGER, contract_until TEXT, last_season INTEGER, url TEXT);
        CREATE TABLE tm_valuations (player_id INTEGER, date TEXT, value INTEGER, club_name TEXT, competition_id TEXT);
        CREATE INDEX idx_tm_val ON tm_valuations(player_id, date);
        CREATE TABLE tm_clubs (club_id INTEGER PRIMARY KEY, name TEXT, competition_id TEXT, squad_size INTEGER, last_season INTEGER);
        CREATE TABLE tm_competitions (competition_id TEXT PRIMARY KEY, name TEXT, type TEXT, country TEXT);
        CREATE TABLE tm_map (league_code TEXT, player_id INTEGER, tm_player_id INTEGER, PRIMARY KEY (league_code, player_id));
        CREATE TABLE tm_meta (key TEXT PRIMARY KEY, value TEXT);
    """)
    c.executemany("INSERT INTO tm_players VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        (int(r["player_id"]), r.get("name"), norm_dob(r.get("date_of_birth")), r.get("country_of_citizenship"), r.get("position"),
         r.get("sub_position"), r.get("foot"), _i(r.get("height_in_cm")), _i(r.get("current_club_id")), r.get("current_club_name"),
         r.get("current_club_domestic_competition_id"), _i(r.get("market_value_in_eur")), _i(r.get("highest_market_value_in_eur")),
         (r.get("contract_expiration_date") or "")[:10] or None, _i(r.get("last_season")), r.get("url"))
        for r in data["players"] if r.get("player_id")])
    c.executemany("INSERT INTO tm_valuations VALUES (?,?,?,?,?)", [
        (int(r["player_id"]), (r.get("date") or "")[:10], _i(r.get("market_value_in_eur")), r.get("current_club_name"),
         r.get("player_club_domestic_competition_id")) for r in data["player_valuations"] if r.get("player_id")])
    c.executemany("INSERT INTO tm_clubs VALUES (?,?,?,?,?)", [
        (int(r["club_id"]), r.get("name"), r.get("domestic_competition_id"), _i(r.get("squad_size")), _i(r.get("last_season")))
        for r in data["clubs"] if r.get("club_id")])
    c.executemany("INSERT INTO tm_competitions VALUES (?,?,?,?)", [
        (r.get("competition_id"), r.get("name"), r.get("type"), r.get("country_name")) for r in data["competitions"]])
    c.executemany("INSERT OR REPLACE INTO tm_map VALUES (?,?,?)", maps)
    last = c.execute("SELECT MAX(date) FROM tm_valuations").fetchone()[0]
    c.executemany("INSERT INTO tm_meta VALUES (?,?)", [("source", "github.com/dcaribou/transfermarkt-datasets (CC0)"),
                                                       ("imported_at", time.strftime("%Y-%m-%d %H:%M")), ("last_valuation", last or "")])
    c.commit()
    c.close()
    os.replace(tmp, OUT_DB)
    print(f"저장: {OUT_DB} (시장가치 최신 {last})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
