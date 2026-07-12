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

    if use_oss and p.get("oss_preview_key"):
        preview_url = oss_service.get_url(p["oss_preview_key"])
    else:
        preview_url = f"{base}/preview"

    if use_oss and p.get("oss_original_key"):
        original_url = oss_service.get_url(p["oss_original_key"])
    else:
        original_url = f"{base}/original"

    if use_oss and p.get("oss_raf_key"):
        raf_url = oss_service.get_url(p["oss_raf_key"])
    else:
        raf_url = f"{base}/raf"

    return {
        "photo_id": p["id"],
        "tag": p["tag"],
        "tag_en": p.get("tag_en") or p["tag"],
        "filename": p["filename"],
        "taken_at": _dt(p["taken_at"]),
        "uploaded_at": _dt(p["uploaded_at"]),
        "has_raf": bool(p["raf_path"]),
        "preview_url": preview_url,
        "original_url": original_url,
        "raf_url": raf_url,
    }
