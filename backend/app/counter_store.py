"""访问 / 下载计数缓冲。

设计取舍
--------
计数是典型的「写多读少 + 允许极小延迟」场景：一个热门相册每秒可能几十次
访问，如果每次都直接 `UPDATE ... SET view_count = view_count + 1`，MySQL 会
在同一行上产生大量行锁竞争，白白拖垮主业务。

因此这里做一层增量缓冲：

    请求 → 内存（或 Redis）自增 → 每 N 秒批量 flush → MySQL 一次 UPDATE

这样 MySQL 的写入次数从「每次访问 1 次」降为「每个被访问的相册每 N 秒 1 次」，
与访问量解耦。代价是进程崩溃可能丢失最近 N 秒的增量——对访问量统计可接受。

单进程部署（当前形态）用内存即可；多进程 / 多机部署时配置 REDIS_URL，
增量改存 Redis，各进程共享同一份缓冲，flush 时用 GETDEL 原子取出并清零。
未配置 Redis 时不会引入任何额外依赖。
"""

import asyncio
import logging

from . import models
from .config import COUNTER_FLUSH_SECONDS, REDIS_URL

logger = logging.getLogger(__name__)

# 计数维度：缓冲结构 {"ev": {pk: {"view": n, "dl": n}}, "sf": {...}}
_BUF_KINDS = ("ev", "sf")
_FIELD_TO_COLUMN = {
    ("ev", "view"): "view_count",
    ("ev", "dl"): "download_count",
    ("sf", "view"): "view_count",
    ("sf", "dl"): "download_count",
}

_buf = {k: {} for k in _BUF_KINDS}
_buf_lock = None          # 延迟创建，避免模块导入时绑定事件循环
_redis = None
_redis_ready = False
_use_redis = False
_task = None

REDIS_KEY_PREFIX = "counter"


def _get_lock():
    global _buf_lock
    if _buf_lock is None:
        _buf_lock = asyncio.Lock()
    return _buf_lock


async def init():
    """初始化 Redis（若配置）。失败则静默回退到内存缓冲。"""
    global _redis, _use_redis, _redis_ready
    if _redis_ready:
        return
    _redis_ready = True
    if not REDIS_URL:
        logger.info("counter store: in-memory buffer (flush every %ss)", COUNTER_FLUSH_SECONDS)
        return
    try:
        import redis.asyncio as aioredis  # type: ignore

        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
        await _redis.ping()
        _use_redis = True
        logger.info("counter store: Redis buffer at %s (flush every %ss)",
                    REDIS_URL, COUNTER_FLUSH_SECONDS)
    except Exception as e:  # redis 未安装 / 连不上 → 回退内存
        _redis = None
        _use_redis = False
        logger.warning("counter store: Redis unavailable (%s), falling back to memory", e)


async def incr(kind: str, pk: int, field: str, n: int = 1):
    """累加一次计数（异步但极轻量，不触碰数据库）。"""
    if kind not in _BUF_KINDS or not pk or not n:
        return
    if _use_redis and _redis is not None:
        try:
            await _redis.incrby(_redis_key(kind, pk, field), n)
            return
        except Exception as e:
            logger.warning("counter store: redis incr failed, use memory: %s", e)
    async with _get_lock():
        slot = _buf[kind].setdefault(int(pk), {})
        slot[field] = slot.get(field, 0) + n


def _redis_key(kind: str, pk: int, field: str) -> str:
    return f"{REDIS_KEY_PREFIX}:{kind}:{int(pk)}:{field}"


def _merge(dst: dict, kind: str, pk: int, field: str, n: int):
    slot = dst.setdefault(kind, {}).setdefault(int(pk), {})
    slot[field] = slot.get(field, 0) + n


async def _drain_redis() -> dict:
    """从 Redis 原子取出并清空所有增量。"""
    out = {k: {} for k in _BUF_KINDS}
    try:
        async for key in _redis.scan_iter(match=f"{REDIS_KEY_PREFIX}:*", count=500):
            try:
                raw = await _redis.getdel(key)
            except Exception:
                # Redis < 6.2 无 GETDEL，退回 GET + DELETE
                pipe = _redis.pipeline()
                pipe.get(key)
                pipe.delete(key)
                res = await pipe.execute()
                raw = res[0]
            if not raw:
                continue
            try:
                n = int(raw)
            except (TypeError, ValueError):
                continue
            if n <= 0:
                continue
            parts = key.split(":")
            if len(parts) != 4:
                continue
            _, kind, pk_s, field = parts
            if kind not in _BUF_KINDS:
                continue
            try:
                _merge(out, kind, int(pk_s), field, n)
            except ValueError:
                continue
    except Exception as e:
        logger.warning("counter store: redis drain failed: %s", e)
    return out


async def _take() -> dict:
    """取出并清空当前缓冲（调用方需持有锁）。"""
    global _buf
    if _use_redis and _redis is not None:
        return await _drain_redis()
    out, _buf = _buf, {k: {} for k in _BUF_KINDS}
    return out


async def _persist(data: dict) -> dict:
    """把增量写入 MySQL，返回写失败的残余（将回填缓冲等待重试）。"""
    rest = {k: {} for k in _BUF_KINDS}
    for kind, rows in data.items():
        if kind not in _BUF_KINDS:
            continue
        for pk, fields in rows.items():
            for field, n in fields.items():
                if not n:
                    continue
                column = _FIELD_TO_COLUMN.get((kind, field))
                if not column:
                    continue
                try:
                    if kind == "ev":
                        await models.increment_event_counter(pk, column, n)
                    else:
                        await models.increment_share_file_counter(pk, column, n)
                except Exception as e:
                    logger.warning("counter store: flush %s %s=%s failed: %s", kind, pk, column, e)
                    _merge(rest, kind, pk, field, n)
    return rest


def _put_back(rest: dict):
    """flush 失败的增量回填缓冲，下一轮重试。"""
    for kind, rows in rest.items():
        for pk, fields in rows.items():
            for field, n in fields.items():
                if n:
                    _merge(_buf, kind, pk, field, n)


async def flush():
    """把缓冲中的增量落库（由定时任务或进程退出时调用）。"""
    async with _get_lock():
        data = await _take()
        if not any(data.get(k) for k in _BUF_KINDS):
            return
        rest = await _persist(data)
        if any(rest.get(k) for k in _BUF_KINDS):
            _put_back(rest)


async def _loop():
    while True:
        try:
            await asyncio.sleep(COUNTER_FLUSH_SECONDS)
            await flush()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("counter store: flush loop error: %s", e)


async def start():
    global _task
    await init()
    _task = asyncio.create_task(_loop())


async def stop():
    """取消定时任务，并把残留增量强制落库。"""
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):
            pass
        _task = None
    try:
        await flush()
    except Exception as e:
        logger.warning("counter store: final flush failed: %s", e)
