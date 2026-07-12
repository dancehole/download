import os
from fastapi import APIRouter
from fastapi.responses import FileResponse

from .. import models
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


def _file_response(path: str, filename: str, media: str, download: bool, cache: bool = False):
    disposition = "attachment" if download else "inline"
    headers = {"Content-Disposition": f'{disposition}; filename="{filename}"'}
    if cache:
        headers["Cache-Control"] = "public, max-age=86400"
    return FileResponse(path, media_type=media, filename=filename, headers=headers)


@router.get("/share/{token}")
async def share_info(token: str):
    ev = await _resolve_event(token)
    if not ev:
        return fail(404, "相册不存在或链接已失效")
    tags = await models.get_tags(ev["id"])
    data = event_to_dict(ev)
    data["tags"] = [{"tag": t["tag"], "count": t["cnt"]} for t in tags]
    return ok(data)


@router.get("/share/{token}/photos")
async def share_photos(token: str, tag: str = "", page: int = 1, size: int = 30):
    ev = await _resolve_event(token)
    if not ev:
        return fail(404, "相册不存在或链接已失效")
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
    _, p = await _resolve_photo(token, photo_id)
    if not p:
        return fail(404, "照片不存在")
    if not os.path.exists(p["preview_path"]):
        return fail(404, "预览图缺失")
    return _file_response(p["preview_path"], "preview.jpg", "image/jpeg",
                          download=False, cache=True)


@router.get("/share/{token}/photos/{photo_id}/original")
async def share_original(token: str, photo_id: int, download: int = 0):
    _, p = await _resolve_photo(token, photo_id)
    if not p:
        return fail(404, "照片不存在")
    if not os.path.exists(p["original_path"]):
        return fail(404, "原图缺失")
    return _file_response(p["original_path"], os.path.basename(p["filename"]),
                          "image/jpeg", download=bool(download))


@router.get("/share/{token}/photos/{photo_id}/raf")
async def share_raf(token: str, photo_id: int, download: int = 1):
    _, p = await _resolve_photo(token, photo_id)
    if not p:
        return fail(404, "照片不存在")
    if not p["raf_path"] or not os.path.exists(p["raf_path"]):
        return fail(404, "该照片暂无 RAF 文件")
    name = os.path.splitext(p["filename"])[0] + ".RAF"
    return _file_response(p["raf_path"], name, "application/octet-stream",
                          download=bool(download))
