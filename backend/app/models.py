from datetime import datetime
from .db import get_pool


# ---------- 摄影师 ----------
async def get_photographer_by_username(username: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM photographer WHERE username=%s", (username,))
            return await cur.fetchone()


# ---------- 活动 ----------
async def create_event(event_id: str, event_name: str, share_token: str, created_by: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO event (event_id, event_name, share_token, created_by) "
                "VALUES (%s, %s, %s, %s)",
                (event_id, event_name, share_token, created_by),
            )
            await conn.commit()
            return await get_event_by_id(event_id)


async def get_event_by_id(event_id: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM event WHERE event_id=%s", (event_id,))
            return await cur.fetchone()


async def get_event_by_pk(pk: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM event WHERE id=%s", (pk,))
            return await cur.fetchone()


async def get_event_by_share_token(token: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM event WHERE share_token=%s", (token,))
            return await cur.fetchone()


async def list_events_by_user(created_by: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM event WHERE created_by=%s ORDER BY created_at DESC",
                (created_by,),
            )
            return await cur.fetchall()


async def update_share_token(event_pk: int, token: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE event SET share_token=%s WHERE id=%s", (token, event_pk)
            )
            await conn.commit()


async def increment_photo_count(event_pk: int, n: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE event SET photo_count = photo_count + %s WHERE id=%s",
                (n, event_pk),
            )
            await conn.commit()


# ---------- 照片 ----------
async def create_photo(event_pk: int, tag, filename: str, original_path: str,
                       preview_path: str, raf_path, taken_at):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO photo (event_id, tag, filename, original_path, preview_path, "
                "raf_path, taken_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (event_pk, tag, filename, original_path, preview_path, raf_path, taken_at),
            )
            await conn.commit()
            return cur.lastrowid


async def update_photo_raf(photo_id: int, raf_path: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE photo SET raf_path=%s WHERE id=%s", (raf_path, photo_id)
            )
            await conn.commit()


async def get_photo_by_id(photo_id: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM photo WHERE id=%s", (photo_id,))
            return await cur.fetchone()


async def list_photos(event_pk: int, tag=None, page=1, size=30):
    offset = (page - 1) * size
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if tag:
                await cur.execute(
                    "SELECT COUNT(*) AS c FROM photo WHERE event_id=%s AND tag=%s",
                    (event_pk, tag),
                )
                total = (await cur.fetchone())["c"]
                await cur.execute(
                    "SELECT * FROM photo WHERE event_id=%s AND tag=%s "
                    "ORDER BY taken_at IS NULL, taken_at DESC, uploaded_at DESC LIMIT %s OFFSET %s",
                    (event_pk, tag, size, offset),
                )
            else:
                await cur.execute(
                    "SELECT COUNT(*) AS c FROM photo WHERE event_id=%s", (event_pk,)
                )
                total = (await cur.fetchone())["c"]
                await cur.execute(
                    "SELECT * FROM photo WHERE event_id=%s "
                    "ORDER BY taken_at IS NULL, taken_at DESC, uploaded_at DESC LIMIT %s OFFSET %s",
                    (event_pk, size, offset),
                )
            rows = await cur.fetchall()
    return total, rows


async def link_raf_by_filename_base(event_pk: int, base_name: str, raf_path: str) -> int:
    """按文件名主干匹配照片并回填 raf_path（仅回填尚未关联的）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE photo SET raf_path=%s WHERE event_id=%s AND filename LIKE %s "
                "AND (raf_path IS NULL OR raf_path='')",
                (raf_path, event_pk, base_name + ".%"),
            )
            n = cur.rowcount
            await conn.commit()
            return n


async def backfill_raf(event_pk: int, raf_dir: str) -> int:
    """扫描 raf 目录，把尚未关联 RAF 的同名照片补上。"""
    import os
    if not os.path.isdir(raf_dir):
        return 0
    total = 0
    pool = await get_pool()
    for fn in os.listdir(raf_dir):
        if not fn.lower().endswith(".raf"):
            continue
        base_name = os.path.splitext(fn)[0]
        raf_path = os.path.join(raf_dir, fn)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "UPDATE photo SET raf_path=%s WHERE event_id=%s AND filename LIKE %s "
                    "AND (raf_path IS NULL OR raf_path='')",
                    (raf_path, event_pk, base_name + ".%"),
                )
                total += cur.rowcount
                await conn.commit()
    return total


async def get_tags(event_pk: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT tag, COUNT(*) AS cnt FROM photo "
                "WHERE event_id=%s AND tag IS NOT NULL AND tag<>'' "
                "GROUP BY tag ORDER BY MIN(uploaded_at) ASC",
                (event_pk,),
            )
            return await cur.fetchall()
