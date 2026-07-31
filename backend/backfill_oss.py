#!/usr/bin/env python3
"""OSS 回填脚本：将本地存储的照片（preview/original/raf）与共享文件上传到 OSS，
并补齐/修正 share_file / photo 表中的 oss_*_key。

场景：OSS bucket 更换（旧 bucket 已删除）后，历史数据只存在本地；
运行本脚本后照片与共享文件重新走 OSS 签名 URL 分发。

用法：
    cd backend && venv/bin/python backfill_oss.py [--dry-run]
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

import aiomysql
import oss2

from app.config import FILES_DIR
from app import oss_service


async def main(dry_run: bool):
    # 从 DB 加载 OSS 配置并初始化
    pool = await aiomysql.create_pool(
        host=os.getenv("DB_HOST"), port=int(os.getenv("DB_PORT")),
        user=os.getenv("DB_USER"), password=os.getenv("DB_PASSWORD"),
        db=os.getenv("DB_NAME"), autocommit=True, charset="utf8mb4",
        cursorclass=aiomysql.DictCursor,
    )
    cfg = {}
    keys = ["oss_enabled", "oss_access_key_id", "oss_access_key_secret",
            "oss_endpoint", "oss_bucket", "oss_custom_domain", "oss_sign_url_ttl"]
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            for k in keys:
                await cur.execute("SELECT setting_value FROM setting WHERE setting_key=%s", (k,))
                row = await cur.fetchone()
                cfg[k.replace("oss_", "")] = row["setting_value"] if row else None
    cfg["enabled"] = str(cfg.get("enabled") or "").lower() in ("1", "true", "yes")
    oss_service.init_oss({
        "enabled": cfg.get("enabled"),
        "access_key_id": cfg.get("access_key_id"),
        "access_key_secret": cfg.get("access_key_secret"),
        "endpoint": cfg.get("endpoint"),
        "bucket": cfg.get("bucket"),
        "custom_domain": cfg.get("custom_domain"),
        "sign_url_ttl": int(cfg.get("sign_url_ttl") or 3600),
    })
    if not oss_service.is_enabled():
        print("[错误] OSS 未启用或配置不完整，无法回填")
        return
    print(f"[OSS] bucket={cfg.get('bucket')} endpoint={cfg.get('endpoint')} dry_run={dry_run}")

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # ── 1. 照片 ──
            await cur.execute("""
                SELECT p.id, p.original_path, p.preview_path, p.raf_path,
                       p.oss_original_key, p.oss_preview_key, p.oss_raf_key,
                       e.event_id
                FROM photo p JOIN event e ON e.id = p.event_id
            """)
            photos = await cur.fetchall()
            print(f"[照片] 共 {len(photos)} 条记录")

            upd_photo = 0
            for p in photos:
                folder = p["event_id"]
                new_orig = f"{folder}/original/{os.path.basename(p['original_path'])}"
                new_prev = f"{folder}/preview/{os.path.basename(p['preview_path'])}"
                new_raf = f"{folder}/raf/{os.path.basename(p['raf_path'])}" if p["raf_path"] else None

                tasks = []
                if p["original_path"] and os.path.exists(p["original_path"]):
                    tasks.append((new_orig, p["original_path"], p["oss_original_key"]))
                if p["preview_path"] and os.path.exists(p["preview_path"]):
                    tasks.append((new_prev, p["preview_path"], p["oss_preview_key"]))
                if new_raf and p["raf_path"] and os.path.exists(p["raf_path"]):
                    tasks.append((new_raf, p["raf_path"], p["oss_raf_key"]))

                for key, local, old_key in tasks:
                    if not dry_run:
                        with open(local, "rb") as fp:
                            oss_service.upload_fileobj(fp, key)

                # 旧 key 为空时补齐（旧 key 非空则对象已按同 key 覆盖上传，无需改 DB）
                if not dry_run and p["oss_preview_key"] is None and tasks:
                    await cur.execute(
                        "UPDATE photo SET oss_original_key=%s, oss_preview_key=%s, oss_raf_key=%s WHERE id=%s",
                        (new_orig, new_prev, new_raf, p["id"]),
                    )
                    upd_photo += 1
            print(f"[照片] 回填/覆盖完成，补齐 DB key {upd_photo} 条")

            # ── 2. 共享文件 ──
            await cur.execute("""
                SELECT file_id, original_filename, storage_path, oss_key FROM share_file
            """)
            files = await cur.fetchall()
            print(f"[文件] 共 {len(files)} 条记录")
            upd_file = 0
            for f in files:
                key = f"files/{f['file_id']}"
                local = f["storage_path"] or os.path.join(FILES_DIR, f["file_id"])
                if not local or not os.path.exists(local):
                    print(f"[文件] 跳过（本地缺失）: {f['file_id']}")
                    continue
                if not dry_run:
                    with open(local, "rb") as fp:
                        oss_service.upload_fileobj(fp, key)
                    if not f["oss_key"]:
                        await cur.execute(
                            "UPDATE share_file SET oss_key=%s WHERE file_id=%s",
                            (key, f["file_id"]),
                        )
                        upd_file += 1
            print(f"[文件] 回填完成，补齐 DB key {upd_file} 条")

            await conn.commit()

    pool.close()
    await pool.wait_closed()
    print("完成。若为 dry-run 则未执行实际上传。")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不执行上传")
    args = ap.parse_args()
    asyncio.run(main(args.dry_run))
