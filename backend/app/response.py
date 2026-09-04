from datetime import datetime
from . import oss_service


def ok(data=None, msg="ok"):
    return {"code": 0, "msg": msg, "data": data}


def fail(code: int, msg: str):
    return {"code": code, "msg": msg, "data": None}


def _dt(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    return str(v)


def event_to_dict(ev: dict) -> dict:
    expires_at = ev.get("expires_at")
    purged_at = ev.get("purged_at")
    local_cleared_at = ev.get("local_cleared_at")
    oss_cleared_at = ev.get("oss_cleared_at")
    now = datetime.now()
    # 「已清理」综合标记：本地或 OSS 任意一端被清空，即视为已做过清理
    cleared_at = local_cleared_at or oss_cleared_at or purged_at
    return {
        "event_id": ev["event_id"],
        "event_name": ev["event_name"],
        "photo_count": ev["photo_count"],
        "share_token": ev["share_token"],
        "share_url": f"/share/{ev['share_token']}",
        "preview_size": ev.get("preview_size", 640),
        "use_oss": bool(ev.get("use_oss", True)),
        "created_at": _dt(ev["created_at"]),
        # 过期时间：None = 永不过期
        "expires_at": _dt(expires_at),
        "expires_at_text": expires_at.strftime("%Y-%m-%d %H:%M") if expires_at else None,
        "expired": bool(expires_at and expires_at <= now),
        # 清理标记：本地照片已删 / OSS 已清空
        "local_cleared_at": _dt(local_cleared_at),
        "local_cleared": bool(local_cleared_at),
        "oss_cleared_at": _dt(oss_cleared_at),
        "oss_cleared": bool(oss_cleared_at),
        # 综合「已清理」标记（用于卡片/详情展示空壳状态）
        "purged_at": _dt(cleared_at),
        "purged": bool(cleared_at),
        "view_count": int(ev.get("view_count") or 0),
        "download_count": int(ev.get("download_count") or 0),
    }


def photo_to_dict(p: dict, token: str) -> dict:
    base = f"/share/{token}/photos/{p['id']}"
    use_oss = oss_service.is_enabled()

    local_preview = f"{base}/preview"
    local_original = f"{base}/original"
    local_raf = f"{base}/raf"

    oss_preview = oss_service.sign_url(p["oss_preview_key"]) if use_oss and p.get("oss_preview_key") else None
    oss_original = oss_service.sign_url(p["oss_original_key"]) if use_oss and p.get("oss_original_key") else None
    oss_raf = oss_service.sign_url(p["oss_raf_key"]) if use_oss and p.get("oss_raf_key") else None

    return {
        "photo_id": p["id"],
        "tag": p["tag"],
        "tag_en": p.get("tag_en") or p["tag"],
        "filename": p["filename"],
        "taken_at": _dt(p["taken_at"]),
        "uploaded_at": _dt(p["uploaded_at"]),
        "has_raf": bool(p["raf_path"]),
        "preview_url": oss_preview or local_preview,
        "original_url": oss_original or local_original,
        "raf_url": oss_raf or local_raf,
        "fallback_preview_url": local_preview,
        "fallback_original_url": local_original,
        "fallback_raf_url": local_raf,
    }


def format_size(size_bytes) -> str:
    if size_bytes is None:
        return ""
    size_bytes = int(size_bytes)
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def share_file_to_dict(f: dict) -> dict:
    """共享文件序列化（管理端与公共端共用）。"""
    expires_at = f.get("expires_at")
    purged_at = f.get("purged_at")
    return {
        "file_id": f["file_id"],
        "filename": f["original_filename"],
        "file_size": f["file_size"],
        "file_size_text": format_size(f["file_size"]),
        "mime_type": f["mime_type"] or "application/octet-stream",
        "share_token": f["share_token"],
        "share_url": f"/share/files/{f['share_token']}",
        "download_url": f"/share/files/{f['share_token']}/download",
        "created_at": _dt(f["created_at"]),
        "expires_at": _dt(expires_at),
        "expires_at_text": expires_at.strftime("%Y-%m-%d %H:%M") if expires_at else None,
        "expired": bool(expires_at and expires_at < datetime.now()),
        "purged_at": _dt(purged_at),
        "purged": bool(purged_at),
        "download_count": int(f.get("download_count") or 0),
        "view_count": int(f.get("view_count") or 0),
    }
