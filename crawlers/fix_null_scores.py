#!/usr/bin/env python3
"""
P1 보완: events.home_score / away_score NULL 2건 (2024-04-24 K2)
SofaScore /api/v1/event/{id} 재조회.
취소·연기 경기일 가능성 있으므로 status 함께 확인 후 결정.
"""

import asyncio
import sqlite3
from playwright.async_api import async_playwright

DB_PATH = "players.db"
TARGETS = [12116762, 12116765]


async def api_fetch(page, path):
    return await page.evaluate(f"""() =>
        fetch('{path}').then(r => r.ok ? r.json() : ({{error: r.status}}))
        .catch(e => ({{error: e.message}}))
    """)


async def main():
    conn = sqlite3.connect(DB_PATH)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            extra_http_headers={"Referer": "https://www.sofascore.com/"},
        )
        page = await ctx.new_page()
        await page.goto(
            "https://www.sofascore.com/tournament/football/south-korea/k-league-2/777",
            wait_until="domcontentloaded", timeout=60000,
        )
        await asyncio.sleep(2)

        for eid in TARGETS:
            data = await api_fetch(page, f"/api/v1/event/{eid}")
            if not isinstance(data, dict) or "error" in data:
                print(f"[{eid}] API 오류: {data}")
                continue
            ev = data.get("event", {})
            home = ev.get("homeTeam", {}).get("name")
            away = ev.get("awayTeam", {}).get("name")
            hs = ev.get("homeScore", {}).get("current")
            as_ = ev.get("awayScore", {}).get("current")
            status = ev.get("status", {})
            print(f"[{eid}] {home} {hs}-{as_} {away} | status={status.get('type')}/{status.get('description')}")

            if hs is not None and as_ is not None and status.get("type") == "finished":
                conn.execute(
                    "UPDATE events SET home_score=?, away_score=? WHERE id=?",
                    (hs, as_, eid),
                )
                conn.commit()
                print(f"  → UPDATE 완료: {hs}-{as_}")
            else:
                print("  → SKIP (점수 없음 또는 미종료)")

            await asyncio.sleep(0.5)

        await browser.close()
    conn.close()


if __name__ == "__main__":
    asyncio.run(main())
