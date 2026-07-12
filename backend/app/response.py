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
    return {
        "event_id": ev["event_id"],
        "event_name": ev["event_name"],
        "photo_count": ev["photo_count"],
        "share_token": ev["share_token"],
        "share_url": f"/share/{ev['share_token']}",
        "created_at": _dt(ev["created_at"]),
    }


def photo_to_dict(p: dict, token: str) -> dict:
    base = f"/share/{token}/photos/{p['id']}"
    use_oss = oss_service.is_enabled()

    local_preview = f"{base}/preview"
    local_original = f"{base}/original"
    local_raf = f"{base}/raf"

    oss_preview = oss_service.get_url(p["oss_preview_key"]) if use_oss and p.get("oss_preview_key") else None
    oss_original = oss_service.get_url(p["oss_original_key"]) if use_oss and p.get("oss_original_key") else None
    oss_raf = oss_service.get_url(p["oss_raf_key"]) if use_oss and p.get("oss_raf_key") else None

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
