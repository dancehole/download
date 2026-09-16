"""只读巡检：对比数据库照片记录与 OSS 实际对象，并打印用量/计费口径。

用法：cd backend && venv/bin/python ../tests/audit-oss.py
"""
import asyncio
import os
import sys

import oss2

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from app import oss_service
from app.db import get_pool, close_pool
from app.models import get_setting


def human(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:,.1f} {unit}"
        n /= 1024.0


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

    # ── 用量与计费口径（与后台「空间与清理」显示的数字同源：oss_service）──
    print("\n=== OSS 用量（相册级 = ListObjects 实时；桶级 = GetBucketStat 计费口径）===")
    total_ev = 0
    for e in events:
        u = oss_service.usage_of_prefix(f"{e['event_id']}/", use_cache=False)
        total_ev += u["bytes"]
        kinds = " · ".join(f"{k} {human(v['bytes'])}/{v['objects']}个"
                           for k, v in sorted(u["by_kind"].items()))
        print(f"  相册 {e['event_id']}: {human(u['bytes'])} / {u['objects']} 个对象"
              + (f"    [{kinds}]" if kinds else ""))
    uf = oss_service.usage_of_prefix("files/", use_cache=False)
    print(f"  共享文件 files/: {human(uf['bytes'])} / {uf['objects']} 个对象")

    st = oss_service.bucket_stat(use_cache=False)
    if not st:
        print("  桶计费口径: 取不到（无 oss:GetBucketStat 权限或网络问题）")
    else:
        print(f"  桶计费口径: {human(st['bytes'])} / {st['objects']} 个对象"
              f"（标准 {human(st['standard_bytes'])} / 低频 {human(st['infrequent_access_bytes'])}"
              f" / 归档 {human(st['archive_bytes'])}）")
        print(f"  统计时间: {st['stat_time']}（OSS 侧数据约 1 小时延迟，与实时值有差属正常）")
        st_time = st["stat_time"]
        if isinstance(st_time, (int, float)):
            from datetime import datetime as _dt
            print(f"  统计时间(本地时间): {_dt.fromtimestamp(st_time):%Y-%m-%d %H:%M}")
        diff = st["bytes"] - total_ev - uf["bytes"]
        print(f"  桶总量 −（各相册 + 共享文件）= {human(diff)}"
              + ("   << 差异偏大，检查桶里是否有其他来源" if abs(diff) > 1024 * 1024 else "   （一致）"))

    await close_pool()


asyncio.run(main())
