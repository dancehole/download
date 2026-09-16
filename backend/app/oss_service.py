import logging
import time

import oss2
from typing import Optional
from io import BytesIO
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)

_bucket: Optional[oss2.Bucket] = None
_config: dict = {
    "enabled": False,
    "access_key_id": "",
    "access_key_secret": "",
    "endpoint": "",
    "bucket": "",
    "custom_domain": "",
    "sign_url_ttl": 3600,
}


def init_oss(config: dict):
    global _bucket, _config
    _config.update(config)
    if not _config.get("enabled"):
        _bucket = None
        return
    if not all([
        _config.get("access_key_id"),
        _config.get("access_key_secret"),
        _config.get("endpoint"),
        _config.get("bucket"),
    ]):
        _bucket = None
        return
    auth = oss2.Auth(_config["access_key_id"], _config["access_key_secret"])
    _bucket = oss2.Bucket(auth, _config["endpoint"], _config["bucket"])


def is_enabled() -> bool:
    return _bucket is not None


def get_config() -> dict:
    return {
        "enabled": _config.get("enabled", False),
        "access_key_id": _config.get("access_key_id", ""),
        "access_key_secret_masked": "****" if _config.get("access_key_secret") else "",
        "endpoint": _config.get("endpoint", ""),
        "bucket": _config.get("bucket", ""),
        "custom_domain": _config.get("custom_domain", ""),
        "sign_url_ttl": int(_config.get("sign_url_ttl", 3600)),
    }


def upload_bytes(data: bytes, key: str, content_type: str = "image/jpeg"):
    if not _bucket:
        raise RuntimeError("OSS not initialized")
    _bucket.put_object(key, data, headers={"Content-Type": content_type})


def upload_fileobj(fileobj, key: str, content_type: str = "application/octet-stream"):
    if not _bucket:
        raise RuntimeError("OSS not initialized")
    _bucket.put_object(key, fileobj, headers={"Content-Type": content_type})


def get_url(key: str) -> str:
    if not key:
        return ""
    if _config.get("custom_domain"):
        return f"https://{_config['custom_domain']}/{key}"
    if _config.get("endpoint") and _config.get("bucket"):
        return f"https://{_config['bucket']}.{_config['endpoint']}/{key}"
    return key


def sign_url(key: str, expires: int = None) -> str:
    """生成带有效期的 OSS 签名 URL（要求 Bucket 权限为 private）。

    签名 URL 在 expires 秒后自动失效，过期 / 伪造 / 被盗链的链接
    会被 OSS 拒绝（403）。若配置了自定义域名（CDN），会将签名 URL
    的默认 host 替换为自定义域名——OSS V1 签名不包含 host，因此
    CDN 透传回源时签名依然有效。
    """
    if not _bucket or not key:
        return ""
    if expires is None:
        expires = int(_config.get("sign_url_ttl", 3600))
    url = _bucket.sign_url("GET", key, expires)
    custom_domain = (_config.get("custom_domain") or "").strip()
    if custom_domain:
        custom_domain = custom_domain.replace("https://", "").replace("http://", "").rstrip("/")
        parsed = urlparse(url)
        url = urlunparse(parsed._replace(netloc=custom_domain, scheme="https"))
    else:
        # 默认域名强制 https，避免 https 页面混合内容被浏览器拦截
        parsed = urlparse(url)
        if parsed.scheme != "https":
            url = urlunparse(parsed._replace(scheme="https"))
    return url


def sign_download_url(key: str, filename: str, expires: int = None) -> str:
    """生成带附件下载语义的签名 URL（response-content-disposition）。

    用于共享文件下载：OSS 返回签名 URL 时附带 attachment 头，
    浏览器保存时使用原始文件名（含中文，通过 filename* 传递）。
    """
    if not _bucket or not key:
        return ""
    from urllib.parse import quote
    if expires is None:
        expires = int(_config.get("sign_url_ttl", 3600))
    filename = quote(filename)
    params = {
        "response-content-disposition": f"attachment; filename*=UTF-8''{filename}"
    }
    url = _bucket.sign_url("GET", key, expires, params=params)
    custom_domain = (_config.get("custom_domain") or "").strip()
    if custom_domain:
        custom_domain = custom_domain.replace("https://", "").replace("http://", "").rstrip("/")
        parsed = urlparse(url)
        url = urlunparse(parsed._replace(netloc=custom_domain, scheme="https"))
    else:
        # 默认域名强制 https，避免 https 页面混合内容被浏览器拦截
        parsed = urlparse(url)
        if parsed.scheme != "https":
            url = urlunparse(parsed._replace(scheme="https"))
    return url


def delete_object(key: str):
    if not _bucket:
        return
    _bucket.delete_object(key)


def delete_prefix(prefix: str) -> int:
    """删除指定前缀下的所有 OSS 对象，返回删除数量。"""
    if not _bucket or not prefix:
        return 0
    count = 0
    for obj in oss2.ObjectIterator(_bucket, prefix=prefix):
        _bucket.delete_object(obj.key)
        count += 1
    return count


# ---------- 用量统计（只读，供后台「空间与清理」显示，涉及计费） ----------
#
# 两次统计的口径不同，界面上必须分开说明，别让管理员把两者混为一谈：
#   * usage_of_prefix()：按前缀 ListObjects 累加，**实时准确**，
#     正是该相册「清空 OSS」会释放掉的量（相册级用这个）；
#   * bucket_stat()：OSS 的 GetBucketStat，**计费口径**（阿里云按桶计费），
#     但官方说明数据有约 1 小时延迟（桶级用这个）。
# ListObjects / GetBucketStat 都有请求费用，所以做了进程内 TTL 缓存。

_usage_cache: dict = {}
USAGE_TTL = 60        # 相册级：60 秒内重复打开相册不再打 OSS
BUCKET_STAT_TTL = 300  # 桶级：本身约 1 小时延迟，缓存 5 分钟足够


def _cache_get(key: str):
    item = _usage_cache.get(key)
    if item and item[0] > time.time():
        return item[1]
    if item:
        _usage_cache.pop(key, None)
    return None


def _cache_set(key: str, value: dict, ttl: int):
    _usage_cache[key] = (time.time() + ttl, value)
    return value


def usage_of_prefix(prefix: str, use_cache: bool = True) -> dict:
    """统计某前缀下的对象数与字节数，并按第二层目录拆分（original/preview/raf）。

    返回 {"objects": int, "bytes": int, "by_kind": {kind: {"objects", "bytes"}}}
    失败时抛异常——**不能**静默返回 0，否则管理员会以为「OSS 是空的」。
    """
    if not _bucket:
        raise RuntimeError("OSS not initialized")
    key = f"usage:{prefix}"
    if use_cache:
        hit = _cache_get(key)
        if hit is not None:
            return dict(hit, cached=True)

    objects = 0
    size = 0
    by_kind: dict = {}
    for obj in oss2.ObjectIterator(_bucket, prefix=prefix):
        objects += 1
        size += obj.size
        rel = obj.key[len(prefix):] if prefix and obj.key.startswith(prefix) else obj.key
        kind = rel.split("/", 1)[0] if "/" in rel else "other"
        bucket_kind = by_kind.setdefault(kind, {"objects": 0, "bytes": 0})
        bucket_kind["objects"] += 1
        bucket_kind["bytes"] += obj.size

    value = {"objects": objects, "bytes": size, "by_kind": by_kind}
    return _cache_set(key, value, USAGE_TTL)


def bucket_stat(use_cache: bool = True):
    """桶级统计（含全部前缀，阿里云计费以此为准）。取不到就返回 None。

    注意：GetBucketStat 的数据有约 1 小时延迟；权限不足（无 oss:GetBucketStat）
    或网络异常时不能拖垮管理页，所以这里吞掉异常只记日志。
    """
    if not _bucket:
        return None
    key = "bucket_stat"
    if use_cache:
        hit = _cache_get(key)
        if hit is not None:
            return dict(hit, cached=True)
    try:
        st = _bucket.get_bucket_stat()
    except Exception as e:
        logger.warning("bucket_stat failed: %s: %s", type(e).__name__, e)
        return None

    # 计费存储量优先用存储类型口径（低频/归档有 64KB 最小计费单位，与标准不同）
    standard = getattr(st, "standard_storage", None) or 0
    ia = getattr(st, "infrequent_access_storage", None) or 0
    archive = getattr(st, "archive_storage", None) or 0
    cold = getattr(st, "cold_archive_storage", None) or 0
    billed = standard + ia + archive + cold
    value = {
        "bytes": billed or (getattr(st, "storage_size_in_bytes", None) or 0),
        "objects": getattr(st, "object_count", None) or 0,
        "standard_bytes": standard,
        "infrequent_access_bytes": ia,
        "archive_bytes": archive + cold,
        # OSS 返回的是「统计时间点」，不是本次查询时间
        "stat_time": getattr(st, "last_modified_time", None),
    }
    return _cache_set(key, value, BUCKET_STAT_TTL)
