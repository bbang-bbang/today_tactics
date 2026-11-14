#!/usr/bin/env python3
"""
kleague_results_2026.json 증분 업데이트
K리그 공식 API에서 2026 시즌 경기 결과를 가져와 기존 데이터에 추가/갱신한다.
"""
import json
import time
import urllib.request
import os
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_FILE = os.path.join(BASE_DIR, "data", "kleague_results_2026.json")

TEAM_CODE_MAP = {
    "K01": "ulsan",   "K02": "suwon",    "K03": "pohang",  "K04": "jeju",
    "K05": "jeonbuk", "K06": "busan",    "K07": "jeonnam", "K08": "seongnam",
    "K09": "fcseoul", "K10": "daejeon",  "K17": "daegu",   "K18": "incheon",
    "K20": "gyeongnam","K21": "gangwon", "K22": "gwangju", "K26": "bucheon",
    "K27": "anyang",  "K29": "suwon_fc", "K31": "seouland","K32": "ansan",
    "K34": "asan",    "K35": "gimcheon", "K36": "gimpo",   "K37": "cheongju",
    "K38": "cheonan", "K39": "hwaseong", "K40": "paju",    "K41": "gimhae",
    "K42": "yongin",
}

def fetch_schedule(league_id, year, month):
    url = "https://www.kleague.com/getScheduleList.do"
    payload = json.dumps({
        "leagueId": str(league_id),
        "year": str(year),
        "month": str(month).zfill(2)
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json; charset=UTF-8", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("data", {}).get("scheduleList", [])
    except Exception as e:
        print(f"  Error {league_id}/{year}/{month}: {e}")
        return []

# 기존 데이터 로드
if os.path.exists(OUT_FILE):
    with open(OUT_FILE, encoding="utf-8") as f:
        results = json.load(f)
    print(f"기존 데이터 로드: {sum(len(v) for v in results.values())}건")
else:
    results = {}
    print("새 파일 생성")

# 기존 경기 날짜 인덱스 (중복 방지)
existing_keys = set()
for team_id, matches in results.items():
    for m in matches:
        opp = m.get("opponent", "")
        existing_keys.add(f"{team_id}|{m['date']}|{opp}")

new_count = 0
current_month = datetime.now().month
YEAR = datetime.now().year   # 2027 개막 후 자동 전환 (파일명은 호환을 위해 _2026 유지)
LEAGUES = [("1", "K1"), ("2", "K2")]

for league_id, league_name in LEAGUES:
    for month in range(1, current_month + 1):
        games = fetch_schedule(league_id, YEAR, month)
        for g in games:
            if g.get("endYn") != "Y" and g.get("gameStatus") != "FE":
                continue
            hs = g.get("homeGoal")
            aws = g.get("awayGoal")
            if hs is None or aws is None:
                continue
            try:
                hs, aws = int(hs), int(aws)
            except:
                continue

            game_date = g.get("gameDate", "")[:10].replace(".", "-")  # YYYY-MM-DD
            home_code = g.get("homeTeam", "")
            away_code = g.get("awayTeam", "")
            home_id = TEAM_CODE_MAP.get(home_code)
            away_id = TEAM_CODE_MAP.get(away_code)

            if hs > aws:
                hr, ar = "W", "L"
            elif hs < aws:
                hr, ar = "L", "W"
            else:
                hr, ar = "D", "D"

            for team_id, is_home, result, opp_id in [
                (home_id, True,  hr, away_id),
                (away_id, False, ar, home_id),
            ]:
                if not team_id or not opp_id:
                    continue
                key = f"{team_id}|{game_date}|{opp_id}"
                if key in existing_keys:
                    continue
                if team_id not in results:
                    results[team_id] = []
                score_str = f"{hs}-{aws}"  # 항상 홈-원정 형식
                results[team_id].append({
                    "date": game_date,
                    "home": is_home,
                    "opponent": opp_id,
                    "score": score_str,
                    "result": result,
                })
                existing_keys.add(key)
                new_count += 1

        time.sleep(0.1)
    print(f"  {YEAR} {league_name} done")

# 날짜 내림차순 정렬
for team_id in results:
    results[team_id].sort(key=lambda x: x["date"], reverse=True)

with open(OUT_FILE, "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

print(f"\n완료: {new_count}건 추가, 총 {sum(len(v) for v in results.values())}건")
