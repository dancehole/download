"""相册清理服务（手动）。

与早期「过期自动删除文件」不同，现在过期只是给相册打上过期标记，**不会**自动删文件。
文件释放改为由管理员在后台手动触发，提供三种粒度：

1. 清空 OSS 存储  —— 只删 OSS 远程对象（按前缀整目录），本地文件保留；
2. 删除本地照片  —— 只删本地 storage/{event_id}/ 目录，OSS 保留；
3. 删除整个相册  —— 本地 + OSS + 数据库记录，彻底清空。

触发入口：后台「空间与清理」区的三个按钮（对应 events 路由的
clear-local / clear-oss 端点，以及 DELETE /events/{id}）。
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
    """清空相册在 OSS 上的全部对象（按前缀）。返回删除的对象数；未启用 OSS 返回 0。"""
    if not oss_service.is_enabled():
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
    logger.info("cleanup: event %s removed local dir (%s bytes)", event["event_id"], freed)
    return freed


async def delete_album(event: dict) -> dict:
    """彻底删除整个相册：OSS 对象 + 本地目录 + 数据库记录。"""
    from . import models
    event_pk = event["id"]
    event_folder = event["event_id"]
    oss_deleted = clear_oss(event)
    clear_local(event)
    await models.delete_event(event_pk)
    return {"oss_deleted": oss_deleted}
