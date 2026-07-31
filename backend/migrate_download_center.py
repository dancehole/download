#!/usr/bin/env python3
"""一次性迁移脚本：将旧 download-center（Flask + SQLite）的文件迁移到
activity-image-list（FastAPI + MySQL）的 share_file 表。

用法：
    cd backend && venv/bin/python migrate_download_center.py
"""
import asyncio
import os
import secrets
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

import aiomysql
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

DC_DIR = Path("/home/dancehole/project/download-center")
SRC_DB = DC_DIR / "data" / "files.db"
SRC_UPLOADS = DC_DIR / "uploads"
DEST_FILES_DIR = BASE_DIR / "storage" / "files"

DB_CFG = dict(
    host=os.getenv("DB_HOST", "127.0.0.1"),
    port=int(os.getenv("DB_PORT", "3306")),
    user=os.getenv("DB_USER", "root"),
    password=os.getenv("DB_PASSWORD", ""),
    db=os.getenv("DB_NAME", "photo_gallery"),
)


def read_old_records():
    if not SRC_DB.exists():
        print(f"[跳过] 旧数据库不存在: {SRC_DB}")
        return []
    conn = sqlite3.connect(str(SRC_DB))
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM files")]
    conn.close()
    return rows


async def main():
    rows = read_old_records()
    if not rows:
        print("没有需要迁移的记录")
        return

    pool = await aiomysql.create_pool(
        **DB_CFG, minsize=1, maxsize=4, autocommit=True,
        charset="utf8mb4", cursorclass=aiomysql.DictCursor,
    )
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id FROM photographer WHERE username=%s",
                    (os.getenv("DEFAULT_ADMIN_USER", "admin"),),
                )
                admin = await cur.fetchone()
                if not admin:
                    print("[错误] 默认摄影师账号不存在，请先启动一次后端服务")
                    return
                admin_id = admin["id"]

                await cur.execute("SELECT file_id FROM share_file")
                existing = {r["file_id"] for r in await cur.fetchall()}

                DEST_FILES_DIR.mkdir(parents=True, exist_ok=True)
                migrated = 0
                for r in rows:
                    fid = r["id"]
                    if fid in existing:
                        print(f"[跳过] {fid} 已存在")
                        continue
                    src = SRC_UPLOADS / fid
                    if not src.exists():
                        print(f"[警告] 本地文件缺失: {src}")
                        continue
                    dest = DEST_FILES_DIR / fid
                    shutil.copy2(str(src), str(dest))

                    token = secrets.token_urlsafe(18)[:24]
                    created = datetime.fromtimestamp(r["created_at"])
                    expires = datetime.fromtimestamp(r["expires_at"]) if r.get("expires_at") else None

                    await cur.execute(
                        "INSERT INTO share_file (file_id, original_filename, file_size, mime_type, "
                        "storage_path, oss_key, share_token, created_by, created_at, expires_at, download_count) "
                        "VALUES (%s, %s, %s, %s, %s, NULL, %s, %s, %s, %s, %s)",
                        (fid, r["original_filename"], r["file_size"], r["mime_type"] or "",
                         str(dest), token, admin_id, created, expires, r["download_count"]),
                    )
                    print(f"[迁移] {fid}  {r['original_filename']}  ({r['file_size']}B)  "
                          f"token={token}")
                    migrated += 1
                await conn.commit()
                print(f"完成，共迁移 {migrated} 个文件")
    finally:
        pool.close()
        await pool.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
