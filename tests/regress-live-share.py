"""真机回归（只读）：对线上 3 个真实相册，检查分享页/原图/预览是否仍正常。

目的：确认「过期拦截」改动没有误伤未过期的相册链接。
用法：cd backend && venv/bin/python ../tests/regress-live-share.py
"""
import asyncio
import os
import sys

import requests

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

BASE = "http://127.0.0.1:8001/download/api"
from app.db import get_pool, close_pool


async def main():
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT id, event_id, event_name, share_token, expires_at, "
                "local_cleared_at FROM event ORDER BY id")
            events = await cur.fetchall()
            for ev in events:
                await cur.execute(
                    "SELECT id FROM photo WHERE event_id=%s ORDER BY id LIMIT 1",
                    (ev["id"],))
                ph = await cur.fetchone()

                info = requests.get(f"{BASE}/share/{ev['share_token']}", timeout=20)
                try:
                    body = info.json()
                except Exception:
                    body = {}
                line = (f"[{ev['event_id']}] {ev['event_name'][:12]:<14} "
                        f"expires={ev['expires_at']} info=http{info.status_code} "
                        f"code={body.get('code')}")
                if ph:
                    pid = ph["id"]
                    o = requests.get(
                        f"{BASE}/share/{ev['share_token']}/photos/{pid}/original",
                        timeout=30)
                    p = requests.get(
                        f"{BASE}/share/{ev['share_token']}/photos/{pid}/preview",
                        timeout=30)
                    line += (f" | original=http{o.status_code} {o.headers.get('content-type')}"
                             f" {len(o.content)}B | preview=http{p.status_code}"
                             f" {len(p.content)}B")
                print(line)
    await close_pool()


asyncio.run(main())
