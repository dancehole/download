import os
import uuid
from io import BytesIO
from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException

from ..auth import current_photographer
from .. import models, image_service, oss_service
from ..config import STORAGE_DIR, MAX_UPLOAD_SIZE_MB
from ..response import ok, fail

router = APIRouter()

JPG_EXT = (".jpg", ".jpeg")
CHUNK = 1024 * 1024  # 1MB 分块流式写盘


async def _stream_to_disk(upload: UploadFile, dest: str):
    """分块流式写入磁盘，避免整文件驻留内存。超过大小限制则删除并抛错。"""
    limit = MAX_UPLOAD_SIZE_MB * 1024 * 1024
    total = 0
    with open(dest, "wb") as out:
        while True:
            chunk = await upload.read(CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                out.close()
                if os.path.exists(dest):
                    os.remove(dest)
                raise HTTPException(status_code=413, detail="文件过大")
            out.write(chunk)


@router.post("/events/{event_id}/upload")
async def upload_photos(
    event_id: str,
    tag: str = Form(default=""),
    tag_en: str = Form(default=""),
    files: list[UploadFile] = File(...),
    user: dict = Depends(current_photographer),
):
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    if not files:
        return fail(400, "未选择文件")

    tag = (tag or "").strip() or None
    tag_en = (tag_en or "").strip() or tag  # 缺省用中文标签
    base = os.path.join(STORAGE_DIR, ev["event_id"])
    orig_dir = os.path.join(base, "original")
    prev_dir = os.path.join(base, "preview")
    raf_dir = os.path.join(base, "raf")
    for d in (orig_dir, prev_dir, raf_dir):
        os.makedirs(d, exist_ok=True)

    results = []
    use_oss = oss_service.is_enabled()
    for f in files:
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in JPG_EXT:
            continue
        safe = f"{uuid.uuid4().hex}{ext}"
        orig_path = os.path.join(orig_dir, safe)
        prev_uuid = uuid.uuid4().hex
        prev_path = os.path.join(prev_dir, f"{prev_uuid}.jpg")
        await _stream_to_disk(f, orig_path)
        taken_at = await image_service.process_image(orig_path, prev_path)

        oss_original_key = None
        oss_preview_key = None
        if use_oss:
            event_folder = ev["event_id"]
            oss_original_key = f"{event_folder}/original/{safe}"
            oss_preview_key = f"{event_folder}/preview/{prev_uuid}.jpg"
            with open(orig_path, "rb") as fp:
                oss_service.upload_fileobj(fp, oss_original_key, "image/jpeg")
            with open(prev_path, "rb") as fp:
                oss_service.upload_fileobj(fp, oss_preview_key, "image/jpeg")

        # 若 raf 目录已存在同名 RAF，则关联
        raf_path = None
        oss_raf_key = None
        base_name = os.path.splitext(f.filename)[0]
        candidate = os.path.join(raf_dir, base_name + ".RAF")
        if os.path.exists(candidate):
            raf_path = candidate
            if use_oss:
                oss_raf_key = f"{ev['event_id']}/raf/{base_name}.RAF"
                with open(candidate, "rb") as fp:
                    oss_service.upload_fileobj(fp, oss_raf_key, "application/octet-stream")

        pid = await models.create_photo(
            ev["id"], tag, tag_en, f.filename, orig_path, prev_path, raf_path, taken_at,
            oss_original_key=oss_original_key, oss_preview_key=oss_preview_key,
            oss_raf_key=oss_raf_key,
        )
        results.append({
            "photo_id": pid,
            "filename": f.filename,
            "taken_at": taken_at.strftime("%Y-%m-%d %H:%M:%S") if taken_at else None,
        })

    await models.increment_photo_count(ev["id"], len(results))
    return ok({"uploaded": len(results), "photos": results})


@router.post("/events/{event_id}/upload-raf")
async def upload_raf(
    event_id: str,
    files: list[UploadFile] = File(...),
    user: dict = Depends(current_photographer),
):
    """单独上传 RAF 数字底片，按文件名匹配已上传的 JPG 照片。"""
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    raf_dir = os.path.join(STORAGE_DIR, ev["event_id"], "raf")
    os.makedirs(raf_dir, exist_ok=True)

    saved = 0
    matched = 0
    use_oss = oss_service.is_enabled()
    for f in files:
        if not f.filename.lower().endswith(".raf"):
            continue
        base_name = os.path.splitext(f.filename)[0]
        dest = os.path.join(raf_dir, base_name + ".RAF")
        await _stream_to_disk(f, dest)
        saved += 1

        oss_raf_key = None
        if use_oss:
            oss_raf_key = f"{ev['event_id']}/raf/{base_name}.RAF"
            with open(dest, "rb") as fp:
                oss_service.upload_fileobj(fp, oss_raf_key, "application/octet-stream")

        n = await models.link_raf_by_filename_base(ev["id"], base_name, dest, oss_raf_key)
        matched += n

    # 回填：对本次上传前已存在的同名 RAF 关联到旧照片
    await models.backfill_raf(ev["id"], raf_dir)

    return ok({"saved_raf": saved, "matched": matched})
