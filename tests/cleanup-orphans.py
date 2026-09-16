"""孤儿文件清理（默认只看不删）。

用法：
    cd backend && venv/bin/python ../tests/cleanup-orphans.py            # 只列清单（dry-run）
    cd backend && venv/bin/python ../tests/cleanup-orphans.py --apply    # 真删

判定「孤儿」= 该文件在数据库里找不到任何引用：
    * storage/files/*                 → 既不是任何 share_file.file_id，也没有 storage_path / oss_key 指向它
    * storage/{EVENT}/original|preview|raf/* → 不被任何 photo 行的 *_path 引用

安全网（顺序不可颠倒）：
    1. 只列清单，不删；
    2. --apply 时逐个再查一遍全库（信息模式遍历所有文本列 + LIKE 文件名/file_id），
       引用数必须为 0 才 os.remove，任何一个有引用就跳过并打印；
    3. 只删文件，**不动数据库任何记录**；清单先写入 storage/orphan-cleanup-<时间>.log。

这两类孤儿是历史成因的产物：项目目录从 activity-image-list 改名成 download 后，
老记录里的绝对路径失效 → 「记录删了、文件留在磁盘」（详见 docs/需求与方案-2026-09-16-删除与过期.md）。
根因已由 models.heal_share_file_paths() 启动自愈 + files.py 删除路径兜底堵住。
"""
import asyncio
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from app.config import STORAGE_DIR, FILES_DIR
from app.db import get_pool, close_pool

APPLY = "--apply" in sys.argv
PHOTO_SUBDIRS = ("original", "preview", "raf")


async def referenced_names():
    """数据库里所有被引用的文件名 / file_id / 路径集合。"""
    names, paths = set(), set()
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT file_id, storage_path, oss_key FROM share_file")
            for r in await cur.fetchall():
                if r["file_id"]:
                    names.add(str(r["file_id"]).strip())
                if r["storage_path"]:
                    paths.add(str(r["storage_path"]).strip())
                if r["oss_key"]:
                    names.add(os.path.basename(str(r["oss_key"]).strip()))
            await cur.execute(
                "SELECT original_path, preview_path, raf_path, oss_original_key, "
                "oss_preview_key, oss_raf_key FROM photo")
            for r in await cur.fetchall():
                for k, v in r.items():
                    if not v:
                        continue
                    v = str(v).strip()
                    paths.add(v)
                    names.add(os.path.basename(v))
    return names, paths


async def db_ref_count(candidate: str) -> int:
    """兜底：遍历本库所有文本列，统计出现该文件名/file_id 的行数。"""
    needle = os.path.basename(candidate)
    pool = await get_pool()
    total = 0
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # 注意：MySQL 8 的 information_schema 返回大写列名，DictCursor 的 key 是
            # TABLE_NAME/COLUMN_NAME，必须显式 AS 别名，否则 KeyError（2026-09-16 踩过）
            await cur.execute(
                "SELECT TABLE_NAME AS tn, COLUMN_NAME AS cn "
                "FROM information_schema.columns "
                "WHERE table_schema = DATABASE() AND data_type IN "
                "('varchar','text','mediumtext','longtext','char')")
            cols = await cur.fetchall()
            for c in cols:
                await cur.execute(
                    f"SELECT COUNT(*) AS n FROM `{c['tn']}` "
                    f"WHERE `{c['cn']}` LIKE %s", (f"%{needle}%",))
                total += (await cur.fetchone())["n"]
    return total


def scan_orphans(names, paths):
    """返回 [(绝对路径, 大小, 类别说明)]。"""
    out = []

    # 1) storage/files/* ：按 file_id 命中
    if os.path.isdir(FILES_DIR):
        for fn in sorted(os.listdir(FILES_DIR)):
            fp = os.path.join(FILES_DIR, fn)
            if not os.path.isfile(fp):
                continue                      # 顶层只处理文件，子目录另行人工确认
            if fn in names or fp in paths:
                continue
            out.append((fp, os.path.getsize(fp), "storage/files 无记录"))

    # 2) storage/{EVENT}/{original|preview|raf}/* ：按文件名命中
    for entry in sorted(os.listdir(STORAGE_DIR)):
        ev_dir = os.path.join(STORAGE_DIR, entry)
        if not os.path.isdir(ev_dir) or entry == os.path.basename(FILES_DIR):
            continue
        for sub in PHOTO_SUBDIRS:
            d = os.path.join(ev_dir, sub)
            if not os.path.isdir(d):
                continue
            for fn in sorted(os.listdir(d)):
                fp = os.path.join(d, fn)
                if not os.path.isfile(fp):
                    continue
                if fn in names or fp in paths:
                    continue
                out.append((fp, os.path.getsize(fp), f"{entry}/{sub} 无 photo 引用"))
    return out


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.0f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024.0


async def main():
    names, paths = await referenced_names()
    orphans = scan_orphans(names, paths)
    total = sum(s for _, s, _ in orphans)

    print(f"存储根目录: {STORAGE_DIR}")
    print(f"数据库引用: {len(names)} 个文件名 / {len(paths)} 条路径")
    print(f"候选孤儿: {len(orphans)} 个，合计 {human(total)}")
    print("-" * 68)
    for fp, size, why in orphans:
        print(f"  {size:>14,} B  {fp}   [{why}]")
    if not orphans:
        return

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    log = os.path.join(STORAGE_DIR, f"orphan-cleanup-{ts}.log")
    lines = [f"{fp}\t{size}\t{why}" for fp, size, why in orphans]
    with open(log, "w", encoding="utf-8") as f:
        f.write(f"# 孤儿清理清单 {ts}  apply={APPLY}\n")
        f.write("\n".join(lines) + "\n")
    print("-" * 68)
    print(f"清单已写入: {log}")

    if not APPLY:
        print("\n[dry-run] 未删除任何文件。确认无误后加 --apply 执行。")
        await close_pool()
        return

    print("\n开始逐个复核并删除：")
    freed = 0
    for fp, size, why in orphans:
        refs = await db_ref_count(fp)
        if refs:
            print(f"  SKIP  {fp}  数据库仍有 {refs} 处引用，不动")
            continue
        try:
            os.remove(fp)
            freed += size
            print(f"  DEL   {fp}  ({human(size)})")
        except OSError as e:
            print(f"  FAIL  {fp}  {e}")
    print("-" * 68)
    print(f"已释放 {human(freed)}；剩余候选 {sum(1 for fp, _, _ in orphans if os.path.exists(fp))} 个")
    await close_pool()


asyncio.run(main())
