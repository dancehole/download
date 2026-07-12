from datetime import datetime


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
    # 路径相对于 API 根（不含 /api 前缀），由前端按可配置的 API 地址拼接
    base = f"/share/{token}/photos/{p['id']}"
    return {
        "photo_id": p["id"],
        "tag": p["tag"],
        "tag_en": p.get("tag_en") or p["tag"],
        "filename": p["filename"],
        "taken_at": _dt(p["taken_at"]),
        "uploaded_at": _dt(p["uploaded_at"]),
        "has_raf": bool(p["raf_path"]),
        "preview_url": f"{base}/preview",
        "original_url": f"{base}/original",
        "raf_url": f"{base}/raf",
    }
