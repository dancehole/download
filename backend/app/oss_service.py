import oss2
from typing import Optional
from io import BytesIO

_bucket: Optional[oss2.Bucket] = None
_config: dict = {
    "enabled": False,
    "access_key_id": "",
    "access_key_secret": "",
    "endpoint": "",
    "bucket": "",
    "custom_domain": "",
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
