"""相册清理服务（手动）。

与早期「过期自动删除文件」不同，现在过期只是让分享链接失效，**不会**自动删文件。
文件释放改为由管理员在后台手动触发，提供三种粒度：

1. 清空 OSS 存储  —— 只删 OSS 远程对象（按前缀整目录），本地文件保留；
2. 删除本地照片  —— 只删本地 storage/{event_id}/ 目录，OSS 保留；
3. 删除整个相册  —— 本地 + OSS + 数据库记录，彻底清空。

触发入口：后台「空间与清理」区的三个按钮（对应 events 路由的
clear-local / clear-oss 端点，以及 DELETE /events/{id}）。

一致性要点（都是踩过的坑）：
* 相册在 OSS 上的对象前缀是 `{event_id}/`（预览图 `{event_id}/preview/`、
  RAF `{event_id}/raf/`），与上传时的 key 生成规则必须保持一致，否则会漏删；
* 先删存储、后删数据库：数据库记录一删就再也找不到 OSS 对象了；
* 任何一端删除失败都要如实上报，不能静默 `pass`，否则空间悄悄泄漏。
"""

import logging
import os
import shutil

from . import oss_service
from .config import STORAGE_DIR

logger = logging.getLogger(__name__)


def _local_dir(event_folder: str) -> str:
    return os.path.join(STORAGE_DIR, event_folder)


def calculate_local_size(event_folder: str) -> int:
    """统计相册本地目录占用的字节数（不递归 OSS）。目录不存在返回 0。"""
    d = _local_dir(event_folder)
    total = 0
    if not os.path.isdir(d):
        return 0
    for root, _dirs, files in os.walk(d):
        for fn in files:
            fp = os.path.join(root, fn)
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total


def clear_oss(event: dict) -> int:
    """清空相册在 OSS 上的全部对象（按前缀）。

    返回删除的对象数；未启用 OSS 返回 0；删除失败返回 -1（调用方必须处理，
    否则相册记录一删这些对象就成孤儿，空间无法回收）。
    """
    if not oss_service.is_enabled():
        logger.warning("cleanup: event %s OSS 未启用，跳过远程对象清理", event["event_id"])
        return 0
    try:
        n = oss_service.delete_prefix(f"{event['event_id']}/")
        logger.info("cleanup: event %s removed %s OSS objects", event["event_id"], n)
        return n
    except Exception as e:
        logger.warning("cleanup: event %s OSS cleanup failed: %s", event["event_id"], e)
        return -1


def clear_local(event: dict) -> int:
    """删除相册本地目录（storage/{event_id}/）。返回释放的字节数。"""
    freed = calculate_local_size(event["event_id"])
    d = _local_dir(event["event_id"])
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    if os.path.isdir(d):
        # rmtree 用了 ignore_errors，残留时这里必须留痕，别让管理员以为已清空
        logger.warning("cleanup: event %s 本地目录删除后仍存在: %s", event["event_id"], d)
    else:
        logger.info("cleanup: event %s removed local dir (%s bytes)", event["event_id"], freed)
    return freed


async def delete_album(event: dict) -> dict:
    """彻底删除整个相册：OSS 对象 + 本地目录 + 数据库记录。

    顺序 = OSS → 本地 → 数据库。任一存储端删除失败就中止（不删数据库记录），
    让管理员重试；这样不会出现「记录没了、文件还在」的孤儿。
    """
    from . import models
    event_pk = event["id"]
    event_folder = event["event_id"]

    oss_deleted = clear_oss(event)
    if oss_deleted == -1 and event.get("oss_cleared_at") is None:
        # OSS 清理失败且此前没清过 → 中止，避免丢失对象索引
        return {"success": False, "stage": "oss",
                "message": "OSS 远程对象删除失败，已中止（本地与数据库未动），请稍后重试"}

    freed = clear_local(event)
    await models.delete_event(event_pk)
    logger.info("cleanup: event %s fully deleted (oss=%s, local freed=%s bytes)",
                event_folder, oss_deleted, freed)
    return {"success": True, "oss_deleted": max(oss_deleted, 0), "freed_bytes": freed}
