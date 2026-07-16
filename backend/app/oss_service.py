import oss2
from typing import Optional
from io import BytesIO
from urllib.parse import urlparse, urlunparse

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
