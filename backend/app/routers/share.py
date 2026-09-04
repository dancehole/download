import os
from datetime import datetime

from fastapi import APIRouter
from fastapi.responses import FileResponse

from .. import models, counter_store
from ..response import ok, fail, event_to_dict, photo_to_dict

router = APIRouter()


async def _resolve_event(token: str):
    return await models.get_event_by_share_token(token)


async def _resolve_photo(token: str, photo_id: int):
    ev = await _resolve_event(token)
    if not ev:
        return None, None
    p = await models.get_photo_by_id(int(photo_id))
    if not p or p["event_id"] != ev["id"]:
        return ev, None
    return ev, p


def _is_cleared(ev: dict) -> bool:
    """相册本地照片已被删除（手动清理），分享页应拦截。"""
    return bool(ev and ev.get("local_cleared_at"))


def _cleared_message(ev: dict) -> str:
    name = ev.get("event_name") or "该"
    return f"{name} 相册已过期，请联系管理员获取"


def _file_response(path: str, filename: str, media: str, download: bool, cache: bool = False):
    headers = {}
    if cache:
        headers["Cache-Control"] = "public, max-age=86400"
    # 不手动拼 Content-Disposition：交给 Starlette 的 RFC 5987 处理，
    # 中文/特殊字符文件名自动转 filename*=utf-8''...，避免 latin-1 编码 500
    return FileResponse(path, media_type=media, filename=filename,
                        content_disposition_type="attachment" if download else "inline",
                        headers=headers)


@router.get("/share/{token}")
async def share_info(token: str):
    """打开分享页时调用，累计一次访问。"""
    ev = await _resolve_event(token)
    if not ev:
        return fail(404, "相册不存在或链接已失效")
    if _is_cleared(ev):
        return fail(410, _cleared_message(ev))
    await counter_store.incr("ev", ev["id"], "view")
    tags = await models.get_tags(ev["id"])
    data = event_to_dict(ev)
    data["tags"] = [{"tag": t["tag"], "tag_en": t.get("tag_en") or t["tag"], "count": t["cnt"]} for t in tags]
    return ok(data)


@router.get("/share/{token}/photos")
async def share_photos(token: str, tag: str = "", page: int = 1, size: int = 30):
    ev = await _resolve_event(token)
    if not ev:
        return fail(404, "相册不存在或链接已失效")
    if _is_cleared(ev):
        return fail(410, _cleared_message(ev))
    size = max(1, min(int(size), 100))
    page = max(1, int(page))
    tag = tag.strip() or None
    total, rows = await models.list_photos(ev["id"], tag, page, size)
    return ok({
        "total": total,
        "page": page,
        "size": size,
        "photos": [photo_to_dict(p, token) for p in rows],
    })


@router.get("/share/{token}/photos/{photo_id}/preview")
async def share_preview(token: str, photo_id: int):
    ev, p = await _resolve_photo(token, photo_id)
    if ev and _is_cleared(ev):
        return fail(410, _cleared_message(ev))
    if not p:
        return fail(404, "照片不存在")
    if not os.path.exists(p["preview_path"]):
        return fail(404, "预览图缺失")
    return _file_response(p["preview_path"], "preview.jpg", "image/jpeg",
                          download=False, cache=True)


@router.get("/share/{token}/photos/{photo_id}/original")
async def share_original(token: str, photo_id: int, download: int = 0):
    ev, p = await _resolve_photo(token, photo_id)
    if ev and _is_cleared(ev):
        return fail(410, _cleared_message(ev))
    if not p:
        return fail(404, "照片不存在")
    if not os.path.exists(p["original_path"]):
        return fail(404, "原图缺失")
    if download:
        # 只有真正的下载计入下载次数，在线查看原图不算
        await counter_store.incr("ev", ev["id"], "dl")
    return _file_response(p["original_path"], os.path.basename(p["filename"]),
                          "image/jpeg", download=bool(download))


@router.get("/share/{token}/photos/{photo_id}/raf")
async def share_raf(token: str, photo_id: int, download: int = 1):
    ev, p = await _resolve_photo(token, photo_id)
    if ev and _is_cleared(ev):
        return fail(410, _cleared_message(ev))
    if not p:
        return fail(404, "照片不存在")
    if not p["raf_path"] or not os.path.exists(p["raf_path"]):
        return fail(404, "该照片暂无 RAF 文件")
    if download:
        await counter_store.incr("ev", ev["id"], "dl")
    name = os.path.splitext(p["filename"])[0] + ".RAF"
    return _file_response(p["raf_path"], name, "application/octet-stream",
                          download=bool(download))
