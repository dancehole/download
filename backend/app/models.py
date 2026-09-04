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
async def create_event(event_id: str, event_name: str, share_token: str, created_by: int,
                       preview_size: int = 640, use_oss: bool = True):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO event (event_id, event_name, share_token, preview_size, use_oss, created_by) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (event_id, event_name, share_token, preview_size, 1 if use_oss else 0, created_by),
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


async def update_event_settings(event_pk: int, preview_size: int = None, use_oss: bool = None):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            parts = []
            params = []
            if preview_size is not None:
                parts.append("preview_size=%s")
                params.append(preview_size)
            if use_oss is not None:
                parts.append("use_oss=%s")
                params.append(1 if use_oss else 0)
            if not parts:
                return
            params.append(event_pk)
            await cur.execute(
                "UPDATE event SET " + ", ".join(parts) + " WHERE id=%s",
                tuple(params),
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


async def delete_event(event_pk: int):
    """删除活动记录（photo 表通过 ON DELETE CASCADE 级联删除）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM event WHERE id=%s", (event_pk,))
            await conn.commit()


# ---------- 照片 ----------
async def create_photo(event_pk: int, tag, tag_en, filename: str, original_path: str,
                       preview_path: str, raf_path, taken_at,
                       oss_original_key=None, oss_preview_key=None, oss_raf_key=None):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO photo (event_id, tag, tag_en, filename, original_path, preview_path, "
                "raf_path, taken_at, oss_original_key, oss_preview_key, oss_raf_key) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (event_pk, tag, tag_en, filename, original_path, preview_path, raf_path, taken_at,
                 oss_original_key, oss_preview_key, oss_raf_key),
            )
            await conn.commit()
            return cur.lastrowid


async def update_photo_raf(photo_id: int, raf_path: str, oss_raf_key=None):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if oss_raf_key is not None:
                await cur.execute(
                    "UPDATE photo SET raf_path=%s, oss_raf_key=%s WHERE id=%s",
                    (raf_path, oss_raf_key, photo_id),
                )
            else:
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


async def get_existing_filenames(event_pk: int, filenames: list) -> set:
    """查询该活动下已存在的原始文件名集合，用于上传幂等去重。"""
    if not filenames:
        return set()
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT filename FROM photo WHERE event_id=%s AND filename IN (%s)"
                % ("%s", ",".join(["%s"] * len(filenames))),
                (event_pk, *filenames),
            )
            rows = await cur.fetchall()
            return {r["filename"] for r in rows}


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


async def link_raf_by_filename_base(event_pk: int, base_name: str, raf_path: str,
                                     oss_raf_key=None) -> int:
    """按文件名主干匹配照片并回填 raf_path（仅回填尚未关联的）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if oss_raf_key is not None:
                await cur.execute(
                    "UPDATE photo SET raf_path=%s, oss_raf_key=%s WHERE event_id=%s AND filename LIKE %s "
                    "AND (raf_path IS NULL OR raf_path='')",
                    (raf_path, oss_raf_key, event_pk, base_name + ".%"),
                )
            else:
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
                "SELECT tag, tag_en, COUNT(*) AS cnt FROM photo "
                "WHERE event_id=%s AND tag IS NOT NULL AND tag<>'' "
                "GROUP BY tag, tag_en ORDER BY MIN(uploaded_at) ASC",
                (event_pk,),
            )
            return await cur.fetchall()


# ---------- 共享文件（下载中心合并） ----------
async def create_share_file(file_id: str, original_filename: str, file_size: int,
                            mime_type: str, storage_path: str, oss_key,
                            share_token: str, created_by: int, expires_at):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO share_file (file_id, original_filename, file_size, mime_type, "
                "storage_path, oss_key, share_token, created_by, expires_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (file_id, original_filename, file_size, mime_type,
                 storage_path, oss_key, share_token, created_by, expires_at),
            )
            await conn.commit()
            return file_id


async def get_share_file_by_id(file_id: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM share_file WHERE file_id=%s", (file_id,))
            return await cur.fetchone()


async def get_share_file_by_pk(pk: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM share_file WHERE id=%s", (pk,))
            return await cur.fetchone()


async def get_share_file_by_token(token: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM share_file WHERE share_token=%s", (token,))
            return await cur.fetchone()


async def list_share_files_by_user(created_by: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM share_file WHERE created_by=%s ORDER BY created_at DESC",
                (created_by,),
            )
            return await cur.fetchall()


async def update_share_file_token(pk: int, token: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE share_file SET share_token=%s WHERE id=%s", (token, pk)
            )
            await conn.commit()


async def increment_share_file_download(pk: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE share_file SET download_count = download_count + 1 WHERE id=%s", (pk,)
            )
            await conn.commit()


async def delete_share_file(pk: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM share_file WHERE id=%s", (pk,))
            await conn.commit()


# ---------- 设置 ----------
async def get_setting(key: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT setting_value FROM setting WHERE setting_key=%s", (key,))
            row = await cur.fetchone()
            return row["setting_value"] if row else None


async def set_setting(key: str, value):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO setting (setting_key, setting_value) VALUES (%s, %s) "
                "ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
                (key, str(value) if value is not None else None),
            )
            await conn.commit()
