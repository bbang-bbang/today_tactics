#!/usr/bin/env python3
"""Transfermarkt 데이터셋 ↔ 우리 선수 연결 규칙 검증 (읽기 전용, 합성 데이터).
실행: python analysis/verify_transfermarkt_match.py"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "crawlers"))
from import_transfermarkt import norm_dob, name_match, pick  # noqa: E402

fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("PASS" if ok else "FAIL", label, "" if ok else f"got={got!r} want={want!r}")


check("DOB 유닉스초 → 날짜", norm_dob(425606400), "1983-06-28")
check("DOB 슬래시 형식(K리그 DB 일부)", norm_dob("2002/01/23"), "2002-01-23")
check("DOB 문자열", norm_dob("1987-03-18 00:00:00"), "1987-03-18")
check("DOB 이상값", (norm_dob(None), norm_dob("abc"), norm_dob("")), (None, None, None))

check("이니셜+성 (API-Football)", name_match("T. Kaneko", "Takuro Kaneko"), True)
check("이니셜 다르면 아님", name_match("S. Kaneko", "Takuro Kaneko"), False)
check("한국식 로마자 그대로", name_match("Young-kwang Kim", "Young-kwang Kim"), True)
check("하이픈·악센트 무시", name_match("Matheus Savio", "Matheus Sávio"), True)
check("외자 이름(브라질)", name_match("Hulk", "Hulk"), True)
check("외자 vs 풀네임 일부 일치", name_match("Rafael Elias", "Rafael Elias da Silva"), True)
check("성 다르면 아님", name_match("Ki-hyeok Lee", "Ki-hyeok Park"), False)
check("로마자 변형(kyeom/kyum)", name_match("Seung-kyeom Im", "Seung-kyum Im"), True)
check("로마자 변형(un/woon)", name_match("Je-un Yeon", "Je-woon Yeon"), True)
check("성·이름 순서 바뀜", name_match("Lee Tae Hui", "Tae-heui Lee"), True)
check("아이슬란드 문자 ð", name_match("Hólmbert Aron Friðjónsson", "Hólmbert Aron Fridjónsson"), True)
check("전혀 다른 이름", name_match("Tae-jun Park", "Sven Sonnenberg"), False)
check("같은 성·다른 이름", name_match("Min-jae Kim", "Seung-gyu Kim"), False)
check("한 음절만 다른 한국 이름(재준/재민) — 다른 사람", name_match("Jae-jun Ahn", "Jae-min Ahn"), False)
check("한 음절만 다른 한국 이름(태준/태훈)", name_match("Tae-jun Kim", "Tae-hun Kim"), False)
check("로마자 변형(myeong/myung)", name_match("Myeong-jae Lee", "Myung-jae Lee"), True)
check("로마자 변형(kyu/gyu)", name_match("Kyu-hyeong Kim", "Gyu-hyeong Kim"), True)
check("로마자 변형(choi/choe)", name_match("Byeong-chan Choi", "Byeong-chan Choe"), True)
check("로마자 변형(deok/duk)", name_match("Min-deok Kim", "Min-duk Kim"), True)
check("외국 이름 철자 변형(Iskandarov)", name_match("Jamshid Iskandarov", "Jamshid Iskanderov"), True)

tm = {"1987-03-18": [(1, "Kwang-hoon Shin"), (2, "Min-jae Kim")],
      "1990-01-01": [(3, "Takuro Kaneko"), (4, "Takuya Kaneko")]}
check("같은 생일·이름 일치 1명", pick("Kwang-hoon Shin", "1987-03-18", tm), 1)
check("생일 다르면 없음", pick("Kwang-hoon Shin", "1987-03-19", tm), None)
check("같은 생일에 이니셜 같은 둘 → 모호 None", pick("T. Kaneko", "1990-01-01", tm), None)
check("풀네임이면 구분", pick("Takuya Kaneko", "1990-01-01", tm), 4)
check("생일 없으면 연결 안 함", pick("Kwang-hoon Shin", None, tm), None)
print(f"\n{'OK' if not fails else 'FAIL'} — 실패 {fails}건")
sys.exit(1 if fails else 0)
