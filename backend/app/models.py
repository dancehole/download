import os
from datetime import datetime
from .db import get_pool


# ---------- 摄影师 ----------
async def get_photographer_by_username(username: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM photographer WHERE username=%s", (username,))
            return await cur.fetchone()


# ---------- 账号（角色 / 启用状态） ----------
async def get_photographer_by_id(pid: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM photographer WHERE id=%s", (pid,))
            return await cur.fetchone()


async def list_photographers():
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT id, username, role, is_active, created_at "
                "FROM photographer ORDER BY (role='super') DESC, id ASC"
            )
            return await cur.fetchall()


async def create_photographer(username: str, password_hash: str, role: str = "album"):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO photographer (username, password_hash, role, is_active) "
                "VALUES (%s, %s, %s, 1)",
                (username, password_hash, role),
            )
            await conn.commit()
            return cur.lastrowid


async def update_photographer_password(pid: int, password_hash: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE photographer SET password_hash=%s WHERE id=%s", (password_hash, pid)
            )
            await conn.commit()


async def set_photographer_role(pid: int, role: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("UPDATE photographer SET role=%s WHERE id=%s", (role, pid))
            await conn.commit()


async def set_photographer_active(pid: int, active: bool):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE photographer SET is_active=%s WHERE id=%s", (1 if active else 0, pid)
            )
            await conn.commit()


async def delete_photographer(pid: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM photographer WHERE id=%s", (pid,))
            await conn.commit()


async def count_active_supers(exclude_pid: int = None) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if exclude_pid is None:
                await cur.execute(
                    "SELECT COUNT(*) AS c FROM photographer WHERE role='super' AND is_active=1"
                )
            else:
                await cur.execute(
                    "SELECT COUNT(*) AS c FROM photographer WHERE role='super' AND is_active=1 "
                    "AND id<>%s",
                    (exclude_pid,),
                )
            return (await cur.fetchone())["c"]


async def count_owned_records(pid: int) -> dict:
    """统计账号名下创建的相册 / 共享文件数量（用于删除前的安全校验）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS c FROM event WHERE created_by=%s", (pid,))
            events = (await cur.fetchone())["c"]
            await cur.execute("SELECT COUNT(*) AS c FROM share_file WHERE created_by=%s", (pid,))
            files = (await cur.fetchone())["c"]
    return {"events": events, "files": files}


# ---------- 相册授权（ACL：账号 ↔ 相册 多对多） ----------
async def list_acl_event_pks(pid: int) -> set:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT event_id FROM album_admin_acl WHERE photographer_id=%s", (pid,)
            )
            rows = await cur.fetchall()
    return {r["event_id"] for r in rows}


async def list_acl_for_photographer(pid: int):
    """某账号被授权的相册列表。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT e.event_id, e.event_name FROM album_admin_acl a "
                "JOIN event e ON e.id = a.event_id "
                "WHERE a.photographer_id=%s ORDER BY e.created_at DESC",
                (pid,),
            )
            return await cur.fetchall()


async def list_acl_for_event(event_pk: int):
    """某相册下的管理员账号列表。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT p.id, p.username, p.is_active, a.created_at FROM album_admin_acl a "
                "JOIN photographer p ON p.id = a.photographer_id "
                "WHERE a.event_id=%s ORDER BY a.created_at ASC",
                (event_pk,),
            )
            return await cur.fetchall()


async def grant_event(photographer_id: int, event_pk: int, granted_by: int = None):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT IGNORE INTO album_admin_acl (photographer_id, event_id, granted_by) "
                "VALUES (%s, %s, %s)",
                (photographer_id, event_pk, granted_by),
            )
            await conn.commit()


async def revoke_event(photographer_id: int, event_pk: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM album_admin_acl WHERE photographer_id=%s AND event_id=%s",
                (photographer_id, event_pk),
            )
            await conn.commit()


async def set_photographer_acl(photographer_id: int, event_pks: list, granted_by: int = None):
    """整体替换某账号的授权相册集合（先删后插，保证与前端勾选一致）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM album_admin_acl WHERE photographer_id=%s", (photographer_id,)
            )
            if event_pks:
                await cur.executemany(
                    "INSERT IGNORE INTO album_admin_acl (photographer_id, event_id, granted_by) "
                    "VALUES (%s, %s, %s)",
                    [(photographer_id, pk, granted_by) for pk in event_pks],
                )
            await conn.commit()


async def is_event_granted(pid: int, event_pk: int) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 AS ok FROM album_admin_acl WHERE photographer_id=%s AND event_id=%s",
                (pid, event_pk),
            )
            return (await cur.fetchone()) is not None


async def can_manage_event(user: dict, ev) -> bool:
    """当前账号能否管理该相册：超级管理员全部可管；相册管理员仅限被授权相册。"""
    if not ev:
        return False
    if (user or {}).get("role") == "super":
        return True
    return await is_event_granted(user.get("pid"), ev["id"])


async def get_manageable_event(event_id: str, user: dict):
    """取出相册并校验权限；无权限一律返回 None（对外表现为「不存在」，避免探测）。"""
    ev = await get_event_by_id(event_id)
    if not ev:
        return None
    if not await can_manage_event(user, ev):
        return None
    return ev


# ---------- 活动 ----------
async def create_event(event_id: str, event_name: str, share_token: str, created_by: int,
                       preview_size: int = 640, use_oss: bool = True, expires_at=None):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO event (event_id, event_name, share_token, preview_size, use_oss, "
                "expires_at, created_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (event_id, event_name, share_token, preview_size, 1 if use_oss else 0,
                 expires_at, created_by),
            )
            await conn.commit()
            return await get_event_by_id(event_id)


async def get_event_by_id(event_id: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT e.*, p.username AS owner_name FROM event e "
                "LEFT JOIN photographer p ON p.id = e.created_by WHERE e.event_id=%s",
                (event_id,),
            )
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


async def list_all_events():
    """超级管理员：全部相册（附创建者用户名）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT e.*, p.username AS owner_name FROM event e "
                "LEFT JOIN photographer p ON p.id = e.created_by "
                "ORDER BY e.created_at DESC"
            )
            return await cur.fetchall()


async def list_events_for_photographer(pid: int):
    """相册管理员：仅被授权的相册。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT e.*, p.username AS owner_name FROM event e "
                "LEFT JOIN photographer p ON p.id = e.created_by "
                "INNER JOIN album_admin_acl a ON a.event_id = e.id AND a.photographer_id = %s "
                "ORDER BY e.created_at DESC",
                (pid,),
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


# ---------- 相册过期 / 清理标记 ----------
async def update_event_expiry(event_pk: int, expires_at):
    """设置（或清除）相册过期时间。expires_at 为 None 表示永不过期。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE event SET expires_at=%s WHERE id=%s", (expires_at, event_pk)
            )
            await conn.commit()


async def clear_event_oss_keys(event_pk: int):
    """清空相册内所有照片的 OSS key（对象已删，避免继续拼签名 URL 指向死链）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE photo SET oss_original_key=NULL, oss_preview_key=NULL, "
                "oss_raf_key=NULL WHERE event_id=%s",
                (event_pk,),
            )
            await conn.commit()


async def count_event_oss_photos(event_pk: int) -> int:
    """相册内仍指向 OSS 的照片数（用于判断「清空 OSS」是否真的有事可做）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) AS c FROM photo WHERE event_id=%s AND "
                "(oss_original_key IS NOT NULL OR oss_preview_key IS NOT NULL "
                " OR oss_raf_key IS NOT NULL)",
                (event_pk,),
            )
            return (await cur.fetchone())["c"]


async def delete_photos_by_event(event_pk: int) -> int:
    """清空相册内所有照片记录（文件本体由清理流程先行删除）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM photo WHERE event_id=%s", (event_pk,))
            n = cur.rowcount
            await conn.commit()
            return n


async def mark_event_oss_cleared(event_pk: int):
    """标记相册的 OSS 远程对象已清空（本地文件保留）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE event SET oss_cleared_at=NOW() WHERE id=%s", (event_pk,)
            )
            await conn.commit()


async def mark_event_local_cleared(event_pk: int):
    """标记相册的本地照片已删除（OSS 可能仍保留），照片数归零留空壳。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE event SET local_cleared_at=NOW(), photo_count=0 WHERE id=%s",
                (event_pk,),
            )
            await conn.commit()


async def increment_event_counter(event_pk: int, field: str, n: int = 1):
    """累加相册计数器。field 仅允许白名单列名，避免 SQL 注入。"""
    if field not in ("view_count", "download_count"):
        raise ValueError(f"invalid counter field: {field}")
    if not n:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"UPDATE event SET {field} = {field} + %s WHERE id=%s", (n, event_pk)
            )
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


async def count_photos_by_tag(event_pk: int, tag: str, tag_en=None) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if tag_en is None:
                await cur.execute(
                    "SELECT COUNT(*) AS c FROM photo WHERE event_id=%s AND tag=%s",
                    (event_pk, tag),
                )
            else:
                await cur.execute(
                    "SELECT COUNT(*) AS c FROM photo WHERE event_id=%s AND tag=%s AND tag_en=%s",
                    (event_pk, tag, tag_en),
                )
            return (await cur.fetchone())["c"]


async def rename_event_tag(event_pk: int, old_tag: str, new_tag: str,
                           new_tag_en=None, old_tag_en=None) -> int:
    """重命名相册内已有标签。

    标签以字符串冗余存储在 photo 行上（无独立 tag 表），因此改名等价于
    UPDATE 该相册下所有引用旧标签的照片行——photo.event_id 与 photo.id 均不变，
    已绑定的照片自动跟随新名称，不会出现解绑/丢图。
    """
    if new_tag_en is None:
        new_tag_en = new_tag
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if old_tag_en is None:
                await cur.execute(
                    "UPDATE photo SET tag=%s, tag_en=%s WHERE event_id=%s AND tag=%s",
                    (new_tag, new_tag_en, event_pk, old_tag),
                )
            else:
                await cur.execute(
                    "UPDATE photo SET tag=%s, tag_en=%s "
                    "WHERE event_id=%s AND tag=%s AND IFNULL(tag_en,'')=%s",
                    (new_tag, new_tag_en, event_pk, old_tag, old_tag_en or ""),
                )
            n = cur.rowcount
            await conn.commit()
            return n


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


async def list_share_files_all():
    """超级管理员：全部共享文件（相册管理员无权访问）。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM share_file ORDER BY created_at DESC")
            return await cur.fetchall()


async def update_share_file_token(pk: int, token: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE share_file SET share_token=%s WHERE id=%s", (token, pk)
            )
            await conn.commit()


async def increment_share_file_counter(pk: int, field: str, n: int = 1):
    """累加共享文件计数器。field 仅允许白名单列名。"""
    if field not in ("download_count", "view_count"):
        raise ValueError(f"invalid counter field: {field}")
    if not n:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"UPDATE share_file SET {field} = {field} + %s WHERE id=%s", (n, pk)
            )
            await conn.commit()


async def delete_share_file(pk: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM share_file WHERE id=%s", (pk,))
            await conn.commit()


# 说明：早期版本带「过期自动清理」逻辑（list_expired_share_files /
# mark_share_file_purged 定时把过期文件的存储位置抹掉）。现在过期只让链接
# 失效、**不删文件**，存储释放一律由管理员手动触发，因此那两个函数已删除。
# 数据库里的 purged_at 列与 files.py 的读取保留，用于兼容历史数据。


async def heal_share_file_paths(files_dir: str) -> list:
    """启动自愈：share_file.storage_path 失效时改回 files_dir/{file_id}。

    成因：记录里存的是上传时的绝对路径，项目目录改名（activity-image-list →
    download）后老记录的路径就失效了，于是「删除只删记录、文件留在磁盘」，
    历史上那 153MB 孤儿就是这么来的。

    规则：
    * storage_path 指向的文件确实存在 → 不动（可能是管理员特意放的路径）；
    * 失效或为空、而 files_dir/{file_id} 存在 → 改写为兜底路径；
    * 两个都不存在（文件真丢了）→ 保持原样，留给管理员处置，不猜。
    """
    pool = await get_pool()
    fixed = []
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT id, file_id, storage_path FROM share_file")
            for row in await cur.fetchall():
                fid = (row.get("file_id") or "").strip()
                if not fid:              # 没有 file_id 算不出兜底路径
                    continue
                sp = (row.get("storage_path") or "").strip()
                fallback = os.path.join(files_dir, fid)
                if sp == fallback:       # 已经是兜底路径
                    continue
                if sp and os.path.exists(sp):     # 原路径有效，别动
                    continue
                if not os.path.exists(fallback):  # 文件真的没了，不猜
                    continue
                await cur.execute(
                    "UPDATE share_file SET storage_path=%s WHERE id=%s",
                    (fallback, row["id"]),
                )
                fixed.append({"id": row["id"], "file_id": fid,
                              "old": sp, "new": fallback})
            if fixed:
                await conn.commit()
    return fixed


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
