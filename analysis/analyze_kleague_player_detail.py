"""verify_kleague_player_detail.py 결과(JSONL) 분석 — 이름 기준 재매칭 후 항목별 일치율·출전분·xG (읽기 전용).

등번호 매칭은 쓰지 않는다: 공식 선수 상세의 backNo/teamName 은 '경기 당시'가 아니라 선수의 현재 값이고,
SofaScore mps.shirt_number 도 일부 현재 번호라 엉뚱한 선수끼리 짝지어진다(2026-11-03 확인).
→ 같은 경기·같은 홈/원정에서 정규화 이름(공식 playerName ↔ players.name_ko / mps.player_name)이 유일하게 맞을 때만 매칭.

사용: python analysis/analyze_kleague_player_detail.py <파일.jsonl>
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import statistics as st
import sys
from collections import defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (라벨, 공식 키, mps 컬럼)
PAIRS = [
    ("골", "goal", "goals"), ("도움", "assist", "assists"),
    ("슈팅", "shot", "total_shots"), ("유효슈팅", "shotOnTarget", "shots_on_target"),
    ("xG", "expectedGoal", "expected_goals"),
    ("패스 시도", "pass", "total_passes"), ("패스 성공", "passAcc", "accurate_passes"),
    ("키패스", "exAttKeyPass", "key_passes"),
    ("크로스 시도", "cros", "total_crosses"), ("크로스 성공", "crosAcc", "accurate_crosses"),
    ("롱패스 시도", "longPass", "total_long_balls"), ("롱패스 성공", "longPassSuccess", "accurate_long_balls"),
    ("공중볼 승", "airChalgWon", "aerial_won"), ("경합 승", "chalgWon", "duel_won"),
    ("드리블 시도", "dribble", "attempted_dribbles"), ("드리블 성공", "dribbleSuccess", "successful_dribbles"),
    ("태클", "tackle", "tackles"), ("태클 성공", "tackleSuccess", "tackles"),
    ("인터셉트", "intercept", "interceptions"), ("볼 회수", "ballRecoverie", "ball_recovery"),
    ("파울", "foul", "fouls"), ("피파울", "foulSuffered", "was_fouled"),
    ("슈팅 블록", "blockingShoot", "blocked_shots"), ("클리어링(cutOff)", "cutOff", "clearances"),
    ("출전분", "minutePlay", "minutes_played"), ("평점", "playerPoint", "rating"),
]


def norm(s: str) -> str:
    return re.sub(r"\(c\)|[\s·\-.]", "", s or "")


def num(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def corr(xs, ys):
    if len(xs) < 3:
        return None
    mx, my = st.mean(xs), st.mean(ys)
    sx = sum((x - mx) ** 2 for x in xs) ** 0.5
    sy = sum((y - my) ** 2 for y in ys) ** 0.5
    return None if not sx or not sy else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def main(path: str) -> None:
    rows = [json.loads(l) for l in open(path, encoding="utf-8")]
    conn = sqlite3.connect(f"file:{os.path.join(ROOT, 'players.db')}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cache = {}

    def mps_side(eid, is_home):
        k = (eid, is_home)
        if k not in cache:
            cache[k] = [dict(r) for r in conn.execute(
                f"""SELECT COALESCE(p.name_ko, '') AS nko, COALESCE(m.player_name, '') AS nraw, COALESCE(p.name, '') AS nen,
                           {", ".join("m." + c for c in sorted({p[2] for p in PAIRS}))}
                    FROM match_player_stats m LEFT JOIN players p ON p.id = m.player_id
                    WHERE m.event_id = ? AND m.is_home = ?""", (eid, is_home))]
        return cache[k]

    matched, unmatched, ambiguous = [], 0, 0
    years = defaultdict(lambda: [0, 0])
    for r in rows:
        o = r["official"] or {}
        years[r["year"]][0] += 1
        years[r["year"]][1] += bool(o)
        if not o:
            continue
        nm = norm(o.get("playerName") or r["name"])
        cands = [m for m in mps_side(r["event_id"], 1 if r["side"] == "home" else 0)
                 if nm and nm in (norm(m["nko"]), norm(m["nraw"]))]
        if len(cands) == 1:
            matched.append((r, cands[0]))
        elif len(cands) > 1:
            ambiguous += 1
        else:
            unmatched += 1

    print(f"## 표본: 공식 응답 {sum(v[1] for v in years.values())}명 / 호출 {len(rows)}명, 경기 {len({r['event_id'] for r in rows})}")
    print("   시즌별 응답률: " + ", ".join(f"{y} {v[1]}/{v[0]}" for y, v in sorted(years.items())))
    print(f"   이름 매칭 {len(matched)} · 미매칭 {unmatched} · 동명 모호 {ambiguous}")

    print("\n## 항목별 대조 (공식 vs SofaScore, 이름 매칭 선수)")
    print(f"{'항목':<14}{'n':>5}{'공식 평균':>10}{'SS 평균':>10}{'완전일치':>9}{'±10%':>8}{'상관':>7}")
    for label, ok, sk in PAIRS:
        xs, ys = [], []
        for r, m in matched:
            a, b = num(r["official"].get(ok)), num(m.get(sk))
            if a is not None and b is not None:
                xs.append(a); ys.append(b)
        if not xs:
            print(f"{label:<14}{0:>5}   (값 없음)")
            continue
        exact = sum(abs(a - b) < 1e-6 or (sk in ('expected_goals', 'rating') and abs(a - b) < 0.015) for a, b in zip(xs, ys)) / len(xs)
        near = sum(abs(a - b) <= max(1, 0.1 * max(abs(a), abs(b))) for a, b in zip(xs, ys)) / len(xs)
        c = corr(xs, ys)
        print(f"{label:<14}{len(xs):>5}{st.mean(xs):>10.2f}{st.mean(ys):>10.2f}{exact:>8.0%}{near:>8.0%}{(f'{c:.2f}' if c is not None else '-'):>7}")

    # ── 출전분 세부: 공식 = 추가시간 포함 실제 시간인가 ──
    print("\n## 출전분 상세")
    full = [(num(r['official'].get('minutePlay')), num(m['minutes_played'])) for r, m in matched
            if num(m['minutes_played']) == 90 and num(r['official'].get('minutePlay')) is not None]
    if full:
        d = [a - 90 for a, _ in full]
        print(f"  SofaScore 90분(풀타임) 선수 {len(full)}명 → 공식 출전분 평균 {st.mean([a for a,_ in full]):.1f} (90 + {st.mean(d):.1f}, 범위 {min(d):+.0f}~{max(d):+.0f})")
    # 경기별: 풀타임 선수들의 공식 출전분이 한 경기 안에서 같은 값인가(= 경기 총 시간)
    per_ev = defaultdict(set)
    for r, m in matched:
        if num(m['minutes_played']) == 90 and num(r['official'].get('minutePlay')) is not None:
            per_ev[r['event_id']].add(num(r['official'].get('minutePlay')))
    same = sum(len(v) == 1 for v in per_ev.values())
    print(f"  경기 안에서 풀타임 선수들의 공식 출전분이 동일한 경기: {same}/{len(per_ev)}")
    part = [(num(r['official'].get('minutePlay')), num(m['minutes_played'])) for r, m in matched
            if num(m['minutes_played']) is not None and num(m['minutes_played']) < 90 and num(r['official'].get('minutePlay')) is not None]
    if part:
        d = [a - b for a, b in part]
        print(f"  교체 관련 선수 {len(part)}명: 공식 − SofaScore 평균 {st.mean(d):+.1f}분 (중앙값 {st.median(d):+.0f}, |차이|≤5분 {sum(abs(x) <= 5 for x in d) / len(d):.0%})")

    # ── xG: 선수 단위 공식 xG 가 빗나간 슛까지 포함하는가 ──
    print("\n## xG (선수 단위 합계)")
    ox = [num(r['official'].get('expectedGoal')) for r, m in matched]
    sx = [num(m['expected_goals']) for r, m in matched]
    both = [(a, b) for a, b in zip(ox, sx) if a is not None and b is not None]
    o_has = sum(a is not None for a in ox)
    print(f"  공식 xG 값 있음 {o_has}/{len(matched)}명, SofaScore xG 값 있음 {sum(b is not None for b in sx)}/{len(matched)}명")
    if both:
        print(f"  둘 다 있는 {len(both)}명: 합계 공식 {sum(a for a,_ in both):.2f} vs SofaScore {sum(b for _,b in both):.2f}, 상관 {corr([a for a,_ in both],[b for _,b in both]):.2f}")
    shots = [(num(r['official'].get('shot')), num(r['official'].get('shotOnTarget')), num(m['total_shots'])) for r, m in matched]
    shots = [s for s in shots if None not in s]
    if shots:
        print(f"  슈팅 합계: 공식 shot {sum(s[0] for s in shots):.0f} · 공식 유효 {sum(s[1] for s in shots):.0f} · SofaScore 슈팅 {sum(s[2] for s in shots):.0f}")
    by_year = defaultdict(lambda: [0, 0, 0])
    for r, m in matched:
        a, b = num(r['official'].get('expectedGoal')), num(m['expected_goals'])
        by_year[r['year']][0] += 1
        by_year[r['year']][1] += a is not None
        by_year[r['year']][2] += b is not None
    print("  시즌별 xG 보유(공식/SofaScore): " + ", ".join(f"{y} {v[1]}/{v[2]} of {v[0]}" for y, v in sorted(by_year.items())))
    conn.close()


if __name__ == "__main__":
    main(sys.argv[1])
