"""只读巡检：对比数据库记录与磁盘实际文件，找出孤儿文件 / 幽灵记录。"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from app.config import STORAGE_DIR, FILES_DIR
from app.db import get_pool, close_pool


def dsize(p):
    try:
        return os.path.getsize(p)
    except OSError:
        return -1


async def main():
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT id, event_id, event_name, photo_count, expires_at, "
                              "local_cleared_at, oss_cleared_at, purged_at, created_by FROM event ORDER BY id")
            events = await cur.fetchall()
            await cur.execute("SELECT id, event_id, filename, original_path, preview_path, raf_path, "
                              "oss_preview_key, oss_raf_key, oss_original_key FROM photo ORDER BY event_id")
            photos = await cur.fetchall()
            await cur.execute("SELECT id, file_id, original_filename, file_size, storage_path, oss_key, "
                              "share_token, expires_at, purged_at, created_at FROM share_file ORDER BY id")
            share_files = await cur.fetchall()
            await cur.execute("SELECT * FROM album_admin_acl")
            acl = await cur.fetchall()

    print("=" * 70)
    print(f"事件(event) {len(events)} 条 / 照片(photo) {len(photos)} 条 / 共享文件(share_file) {len(share_files)} 条 / ACL {len(acl)} 条")
    print("=" * 70)
    ev_by_pk = {e["id"]: e for e in events}
    for e in events:
        d = os.path.join(STORAGE_DIR, e["event_id"])
        on_disk = os.path.isdir(d)
        n = sum(len(fs) for _, _, fs in os.walk(d)) if on_disk else 0
        flag = ""
        if not on_disk and (e["local_cleared_at"] is None):
            flag = "  << 目录不存在但未标记已清理"
        if on_disk and e["local_cleared_at"] is not None:
            flag = "  << 已标记本地清理但目录仍在"
        print(f"[event {e['id']:>3} {e['event_id']:<10}] {e['event_name'][:20]:<22} "
              f"photo_count={e['photo_count']:<5} 磁盘文件={n:<5} 目录={'有' if on_disk else '无'}"
              f" expires={e['expires_at']} local_cleared={e['local_cleared_at']} oss_cleared={e['oss_cleared_at']}{flag}")

    # 照片记录 vs 磁盘
    missing_orig = [p for p in photos if not os.path.exists(p["original_path"] or "")]
    missing_prev = [p for p in photos if not os.path.exists(p["preview_path"] or "")]
    missing_raf = [p for p in photos if p["raf_path"] and not os.path.exists(p["raf_path"])]
    print(f"\nphoto 原始图缺失 {len(missing_orig)} / 预览图缺失 {len(missing_prev)} / RAF 缺失 {len(missing_raf)}")
    for p in (missing_orig + missing_prev)[:10]:
        print("   缺失:", p["id"], p["event_id"], p["filename"])

    # 磁盘上未被任何 photo 记录引用的文件
    referenced = set()
    for p in photos:
        for k in ("original_path", "preview_path", "raf_path"):
            if p[k]:
                referenced.add(os.path.abspath(p[k]))
    orphans = []
    for e in events:
        d = os.path.join(STORAGE_DIR, e["event_id"])
        if not os.path.isdir(d):
            continue
        for root, _dirs, fs in os.walk(d):
            for fn in fs:
                fp = os.path.abspath(os.path.join(root, fn))
                if fp not in referenced:
                    orphans.append(fp)
    print(f"\n相册目录内未被 photo 记录引用的孤儿文件 {len(orphans)} 个:")
    for fp in orphans[:15]:
        print(f"   {dsize(fp):>12,} {fp}")

    # 磁盘上不属于任何 event 目录的顶层条目
    known = {e["event_id"] for e in events}
    for name in sorted(os.listdir(STORAGE_DIR)):
        if name not in known and os.path.isdir(os.path.join(STORAGE_DIR, name)):
            print(f"\nstorage 顶层未知目录: {name}")

    # 共享文件
    print("\n" + "=" * 70)
    print("共享文件 (share_file)")
    print("=" * 70)
    disk_files = set(os.listdir(FILES_DIR)) if os.path.isdir(FILES_DIR) else set()
    for f in share_files:
        lp = f["storage_path"] or os.path.join(FILES_DIR, f["file_id"])
        exists = os.path.exists(lp)
        print(f"[sf {f['id']:>3} {f['file_id']:<12}] {f['original_filename'][:28]:<30} "
              f"size={f['file_size']:<12,} 本地={'有' if exists else '无'} oss_key={f['oss_key']!r} "
              f"expires={f['expires_at']} purged={f['purged_at']}")
        disk_files.discard(os.path.basename(lp))
    print(f"\nfiles 目录中无对应记录的孤儿文件: {sorted(disk_files)}")
    for n in sorted(disk_files):
        print(f"   {dsize(os.path.join(FILES_DIR, n)):>12,} {os.path.join(FILES_DIR, n)}")

    await close_pool()


asyncio.run(main())
