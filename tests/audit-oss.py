"""只读巡检：对比数据库照片记录与 OSS 实际对象。"""
import asyncio
import os
import sys

import oss2

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from app import oss_service
from app.db import get_pool, close_pool
from app.models import get_setting


async def main():
    cfg = {}
    for key, field in [
        ("oss_enabled", "enabled"), ("oss_access_key_id", "access_key_id"),
        ("oss_access_key_secret", "access_key_secret"), ("oss_endpoint", "endpoint"),
        ("oss_bucket", "bucket"), ("oss_custom_domain", "custom_domain"),
        ("oss_sign_url_ttl", "sign_url_ttl"),
    ]:
        v = await get_setting(key)
        if v is not None:
            cfg[field] = v
    if cfg.get("enabled"):
        cfg["enabled"] = str(cfg["enabled"]).lower() in ("1", "true", "yes")
    print("OSS 配置: enabled=%s endpoint=%s bucket=%s custom_domain=%r ttl=%s"
          % (cfg.get("enabled"), cfg.get("endpoint"), cfg.get("bucket"),
             cfg.get("custom_domain"), cfg.get("sign_url_ttl")))
    oss_service.init_oss(cfg)
    if not oss_service.is_enabled():
        print("!! OSS 未启用，无法巡检 OSS 对象")
        await close_pool()
        return

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT event_id, id FROM event ORDER BY id")
            events = await cur.fetchall()
            await cur.execute("SELECT event_id, oss_preview_key, oss_original_key, oss_raf_key FROM photo")
            photos = await cur.fetchall()
            await cur.execute("SELECT file_id, oss_key FROM share_file")
            sfs = await cur.fetchall()

    referenced = set()
    for p in photos:
        for k in ("oss_preview_key", "oss_original_key", "oss_raf_key"):
            if p[k]:
                referenced.add(p[k])
    for f in sfs:
        if f["oss_key"]:
            referenced.add(f["oss_key"])

    bucket = oss_service._bucket
    print("\n=== OSS 根目录实际对象 ===")
    all_keys = []
    for obj in oss2.ObjectIterator(bucket):
        all_keys.append(obj.key)

    # 按顶层前缀分组统计
    from collections import defaultdict
    grouped = defaultdict(int)
    for k in all_keys:
        top = k.split("/")[0] if "/" in k else "(root)"
        grouped[top] += 1
    for top, cnt in sorted(grouped.items()):
        print(f"  前缀 {top:<16} {cnt} 个对象")

    known_events = {e["event_id"] for e in events}
    print("\n=== 与数据库对照 ===")
    for top in sorted(grouped):
        if top == "files":
            continue
        if top in known_events:
            # 统计孤儿（对象存在但 photo 表无引用）
            orph = [k for k in all_keys if k.startswith(top + "/") and k not in referenced]
            print(f"  相册 {top}: 对象 {grouped[top]} 个，其中未被 photo 引用 {len(orph)} 个"
                  + ("   << 有孤儿！" if orph else ""))
            for k in orph[:8]:
                print("      ", k)
        else:
            print(f"  !! 前缀 {top} 不属于任何现存相册（相册可能已删除但 OSS 未清空）")

    print("\n=== photo.oss_* 引用的对象是否真实存在 ===")
    existing = set(all_keys)
    miss = [k for k in referenced if k not in existing]
    print(f"  引用总数 {len(referenced)}，OSS 上不存在的 {len(miss)}")
    for k in miss[:10]:
        print("      缺失:", k)

    print("\n=== 共享文件 OSS 对象 ===")
    for f in sfs:
        k = f["oss_key"]
        print(f"  {f['file_id']}: oss_key={k!r} 存在={k in existing if k else '无key'}")

    await close_pool()


asyncio.run(main())
