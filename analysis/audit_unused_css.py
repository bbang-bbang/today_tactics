#!/usr/bin/env python3
"""style.css 읽기 전용 감사 (2026-11-24 CSS 정리에 사용): 규칙 파싱(@media 1단계 중첩), 정확 중복, 미사용 클래스.
'dead' = 저장소 JS·HTML·PY·JSON 어디에도 이름이 없고, 이름의 어떤 -/_ 접두어도 문자열 조합으로 쓰이지 않는 클래스.
사용: python analysis/audit_unused_css.py [repo] [out.json]
지울 때는 화면별 계산된 스타일 전후 비교로 검증할 것(2026-11-24 기록 참고)."""
import io, re, sys, subprocess, os, json
from collections import defaultdict
sys.stdout.reconfigure(encoding="utf-8")
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JSON = sys.argv[2] if len(sys.argv) > 2 else os.devnull
css = io.open(os.path.join(ROOT, "static/css/style.css"), encoding="utf-8").read()
css_nc = re.sub(r"/\*.*?\*/", lambda m: " " * len(m.group(0)), css, flags=re.S)


import bisect
NL = [i for i, ch in enumerate(css) if ch == chr(10)]
class _L:
    def __getitem__(self, pos): return bisect.bisect_left(NL, pos) + 1
LN = _L()


def parse(text, base=0, ctx=""):
    i, n, out = 0, len(text), []
    while i < n:
        j = text.find("{", i)
        if j < 0:
            break
        head = text[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if text[k] == "{": depth += 1
            elif text[k] == "}": depth -= 1
            k += 1
        body = text[j + 1:k - 1]
        line = css.count("\n", 0, base + j) + 1
        if head.startswith("@media") or head.startswith("@supports"):
            out += parse(body, base + j + 1, head)
        elif head.startswith("@"):
            out.append((ctx, head, "", line))
        else:
            decl = ";".join(sorted(d.strip() for d in body.split(";") if d.strip()))
            out.append((ctx, re.sub(r"\s+", " ", head), decl, line))
        i = k
    return out


rules = parse(css_nc)
print("rules", len(rules), "lines", css.count("\n"), "bytes", len(css.encode()))

# 1) 정확 중복(같은 문맥·선택자·선언)
seen = defaultdict(list)
for ctx, sel, decl, line in rules:
    if decl:
        seen[(ctx, sel, decl)].append(line)
dups = {k: v for k, v in seen.items() if len(v) > 1}
print("\n[exact duplicate blocks]", len(dups))
for (ctx, sel, decl), lines in list(dups.items())[:60]:
    print("  ", lines, ctx[:30], sel[:70])

# 2) 같은 선택자가 같은 문맥에서 여러 번(선언 다름) — 뒤 규칙이 앞을 덮음
sel_lines = defaultdict(list)
for ctx, sel, decl, line in rules:
    if decl:
        sel_lines[(ctx, sel)].append(line)
multi = {k: v for k, v in sel_lines.items() if len(v) > 1}
print("\n[same selector repeated, same context]", len(multi))

# 3) 미사용 클래스
files = [f for f in subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True).stdout.decode("utf-8").split("\0")
         if f.endswith((".js", ".html", ".py", ".json"))]
src = "".join(io.open(os.path.join(ROOT, f), encoding="utf-8", errors="ignore").read() for f in files)
TOK = set(re.findall(r"[\w-]+", src))
classes = defaultdict(list)
for ctx, sel, decl, line in rules:
    for c in set(re.findall(r"\.(-?[_a-zA-Z][\w-]*)", sel)):
        classes[c].append(line)
unused = {}
for c, lines in classes.items():
    if c not in TOK:
        # 접두어 조합(예: 'rc-lg-' + league) 가능성 — 접두어가 문자열로 등장하면 '동적 가능'으로 분리
        unused[c] = lines
dyn, dead = {}, {}
for c, lines in unused.items():
    # 모든 '-'·'_' 경계의 접두어 중 하나라도 문자열 끝(따옴표·${·+)으로 코드에 나오면 동적 생성 가능으로 본다(보수적)
    cuts = [m.end() for m in re.finditer(r"[-_]", c)]
    if any(re.search(re.escape(c[:k]) + r"[\"'`$]", src) for k in cuts):
        dyn[c] = lines
    else:
        dead[c] = lines
print("\n[classes]", len(classes), "unused(no literal)", len(unused), "possibly dynamic", len(dyn), "dead", len(dead))
json.dump({"dead": dead, "dyn": dyn, "dups": [[list(k), v] for k, v in dups.items()], "multi": len(multi)},
          io.open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
for c, l in sorted(dead.items(), key=lambda kv: kv[1][0])[:400]:
    print("  dead", c, l[:4])
