#!/usr/bin/env python3
"""
K리그 데이터 포털에서 2026 시즌 팀별 선수 명단 수집
"""

import os
import re
import json
import time
import subprocess

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 팀 ID 매핑 (K리그 포털 ID -> 우리 시스템 ID)
K1_TEAMS = {
    'K01': 'ulsan',
    'K03': 'pohang',
    'K04': 'jeju',
    'K05': 'jeonbuk',
    'K09': 'fcseoul',
    'K10': 'daejeon',
    'K18': 'incheon',
    'K21': 'gangwon',
    'K22': 'gwangju',
    'K26': 'bucheon',
    'K27': 'anyang',
    'K35': 'gimcheon',
}

K2_TEAMS = {
    'K02': 'suwon',
    'K06': 'busan',
    'K07': 'jeonnam',
    'K08': 'seongnam',
    'K17': 'daegu',
    'K20': 'gyeongnam',
    'K29': 'suwon_fc',
    'K31': 'seouland',
    'K32': 'ansan',
    'K34': 'asan',
    'K36': 'gimpo',
    'K37': 'cheongju',
    'K38': 'cheonan',
    'K39': 'hwaseong',
    'K40': 'paju',
    'K41': 'gimhae',
    'K42': 'yongin',
}

TEAM_NAMES = {
    'K01': '울산', 'K03': '포항', 'K04': '제주', 'K05': '전북',
    'K09': 'FC서울', 'K10': '대전', 'K18': '인천', 'K21': '강원',
    'K22': '광주', 'K26': '부천', 'K27': '안양', 'K35': '김천',
    'K02': '수원삼성', 'K06': '부산', 'K07': '전남', 'K08': '성남',
    'K17': '대구', 'K20': '경남', 'K29': '수원FC', 'K31': '서울이랜드',
    'K32': '안산', 'K34': '충남아산', 'K36': '김포', 'K37': '충북청주',
    'K38': '천안', 'K39': '화성', 'K40': '파주', 'K41': '김해', 'K42': '용인',
}

def get_session_id():
    """포털에서 새 세션 ID 획득"""
    cmd = [
        'curl', '-s', '-I', '-L',
        'https://portal.kleague.com/user/loginById.do?portalGuest=rstNE9zxjdkUC9kbUA08XQ==',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '--max-time', '30'
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
    match = re.search(r'JSESSIONID=([A-F0-9]+)', result.stdout)
    if match:
        return match.group(1)
    return None

def fetch_team_players(portal_team_id, session_id):
    """특정 팀의 선수 목록 HTML 가져오기"""
    cmd = [
        'curl', '-s',
        'https://portal.kleague.com/mainFrame.do',
        '-X', 'POST',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-H', 'Content-Type: application/x-www-form-urlencoded',
        '-H', f'Cookie: JSESSIONID={session_id}',
        '-H', 'Referer: https://portal.kleague.com/mainFrame.do',
        '-d', f'selectedMenuCd=0415&meetSeq=1&playerId=&teamId={portal_team_id}',
        '--max-time', '30'
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
    return result.stdout

def parse_players(html, portal_team_id):
    """HTML에서 선수 데이터 파싱"""
    players = []

    pos_pattern = re.compile(
        r'<h1 class="club-playerPosition-title">(\w+)</h1>(.*?)(?=<h1 class="club-playerPosition-title">|\Z)',
        re.DOTALL
    )
    player_name_pattern = re.compile(r'<li class="club-playerlist-nm-k">(\d+)\.\s*([^<]+)</li>')
    player_info_pattern = re.compile(r'<li class="club-playerlist-nm-e">([^<]+)</li>')

    for pos_match in pos_pattern.finditer(html):
        pos = pos_match.group(1)
        section = pos_match.group(2)

        player_blocks = re.split(r'<div[^>]+class="club-playerlist-box"[^>]*>', section)

        for block in player_blocks[1:]:
            name_match = player_name_pattern.search(block)
            info_match = player_info_pattern.search(block)

            if name_match and info_match:
                number = name_match.group(1)
                name = name_match.group(2).strip()
                info = info_match.group(1).strip()

                # 포맷: "189Cm / 75Kg / 1991/09/25"
                height_match = re.search(r'(\d+)\s*[Cc]m', info)
                weight_match = re.search(r'(\d+)\s*[Kk]g', info)
                date_match = re.search(r'(\d{4}/\d{2}/\d{2})', info)

                players.append({
                    'number': int(number),
                    'name': name,
                    'position': pos,
                    'height': int(height_match.group(1)) if height_match else None,
                    'weight': int(weight_match.group(1)) if weight_match else None,
                    'dob': date_match.group(1) if date_match else '',
                })

    return players

def main():
    print("K리그 선수 데이터 수집 시작", flush=True)
    print("세션 ID 획득 중...", flush=True)

    session_id = get_session_id()
    if not session_id:
        print("세션 ID 획득 실패!")
        return None

    print(f"세션 ID: {session_id[:8]}...", flush=True)

    all_teams_data = {}
    all_team_map = {**K1_TEAMS, **K2_TEAMS}

    for portal_id, system_id in all_team_map.items():
        team_name = TEAM_NAMES.get(portal_id, portal_id)
        print(f"수집 중: {team_name} ({portal_id} -> {system_id})", flush=True)

        html = fetch_team_players(portal_id, session_id)
        players = parse_players(html, portal_id)

        if players:
            all_teams_data[system_id] = {
                'portal_id': portal_id,
                'team_name': team_name,
                'players': players
            }
            print(f"  -> {len(players)}명 수집 완료", flush=True)
        else:
            print(f"  -> 데이터 없음 (HTML 크기: {len(html)} bytes)", flush=True)
            # 세션 갱신 시도
            session_id = get_session_id()
            time.sleep(1)
            html = fetch_team_players(portal_id, session_id)
            players = parse_players(html, portal_id)
            if players:
                all_teams_data[system_id] = {
                    'portal_id': portal_id,
                    'team_name': team_name,
                    'players': players
                }
                print(f"  -> 재시도 성공: {len(players)}명", flush=True)

        time.sleep(0.3)

    output_file = os.path.join(BASE_DIR, 'data', 'kleague_players_2026.json')
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(all_teams_data, f, ensure_ascii=False, indent=2)

    print(f"\n저장 완료: {output_file}", flush=True)
    print(f"총 {len(all_teams_data)}개 팀 수집", flush=True)
    total_players = sum(len(t['players']) for t in all_teams_data.values())
    print(f"총 선수 수: {total_players}명", flush=True)

    return all_teams_data

if __name__ == '__main__':
    result = main()
