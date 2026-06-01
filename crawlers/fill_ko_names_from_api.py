#!/usr/bin/env python3
"""
SofaScore /api/v1/player/{id} 에서 한국어 이름(fieldTranslations.nameTranslation.ko)을 가져와
players 테이블의 name_ko를 업데이트한다.

대상: name_ko가 없거나 영어(ASCII)로만 돼 있는 선수
"""
import asyncio, sqlite3, sys
from playwright.async_api import async_playwright

DB_PATH = "players.db"
DELAY   = 0.2

def log(msg):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

def is_ascii_only(s):
    if not s:
        return True
    try:
        s.encode("ascii")
        return True
    except UnicodeEncodeError:
        return False

async def api(page, path):
    for attempt in range(3):
        try:
            r = await page.evaluate(f"""() =>
                fetch('{path}').then(r => r.ok ? r.json() : null).catch(() => null)
            """)
            return r
        except:
            if attempt < 2:
                await page.goto("https://www.sofascore.com", wait_until="domcontentloaded", timeout=30000)
                await asyncio.sleep(2)
    return None

async def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 대상: name_ko 없거나 ASCII인 선수 중 match_player_stats에 있는 선수
    cur.execute("""
        SELECT DISTINCT p.id, p.name, p.name_ko
        FROM players p
        JOIN match_player_stats m ON p.id = m.player_id
        WHERE p.name_ko IS NULL OR p.name_ko = '' OR length(p.name_ko) = length(CAST(p.name_ko AS BLOB))
        ORDER BY p.id
    """)
    targets = cur.fetchall()
    log(f"대상 선수: {len(targets)}명")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await ctx.new_page()
        await page.goto("https://www.sofascore.com", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)
        log("세션 준비 완료\n")

        updated = skip = fail = 0
        for i, player in enumerate(targets):
            pid   = player["id"]
            pname = player["name"]

            data = await api(page, f"/api/v1/player/{pid}")
            await asyncio.sleep(DELAY)

            if not data or "player" not in data:
                fail += 1
                continue

            p = data["player"]
            # 한국어 이름 우선순위: fieldTranslations.nameTranslation.ko > name
            name_ko = None
            ft = p.get("fieldTranslations", {})
            nt = ft.get("nameTranslation", {})
            if nt.get("ko"):
                name_ko = nt["ko"]

            if not name_ko:
                skip += 1
                continue

            # 영어와 동일하면 스킵 (의미 없음)
            if name_ko == pname or is_ascii_only(name_ko):
                skip += 1
                continue

            cur.execute("UPDATE players SET name_ko = ? WHERE id = ?", (name_ko, pid))
            updated += 1

            if updated % 20 == 0:
                conn.commit()
                log(f"  [{i+1}/{len(targets)}] 업데이트 {updated}건 / 스킵 {skip} / 실패 {fail}")

        conn.commit()
        await browser.close()

    log(f"\n완료: 업데이트 {updated}건 / 한국어 없어 스킵 {skip}건 / API 실패 {fail}건")
    conn.close()

if __name__ == "__main__":
    asyncio.run(main())
