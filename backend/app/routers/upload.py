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

    # 批量上限保护：防止单请求塞入过多文件导致长时间占用 worker / 触发 nginx 413
    max_files = int(os.getenv("MAX_FILES_PER_REQUEST", "100"))
    if len(files) > max_files:
        return fail(400, f"单次最多上传 {max_files} 个文件，请分批上传")

    tag = (tag or "").strip() or None
    tag_en = (tag_en or "").strip() or tag
    base = os.path.join(STORAGE_DIR, ev["event_id"])
    orig_dir = os.path.join(base, "original")
    prev_dir = os.path.join(base, "preview")
    raf_dir = os.path.join(base, "raf")
    for d in (orig_dir, prev_dir, raf_dir):
        os.makedirs(d, exist_ok=True)

    preview_size = ev.get("preview_size", 640)
    use_oss = bool(ev.get("use_oss", True)) and oss_service.is_enabled()

    def _cleanup(*paths):
        for p in paths:
            try:
                if p and os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass

    results = []
    # 幂等去重：先查出本活动已存在的文件名，防止「客户端断开→前端重试」导致重复入库
    existing = await models.get_existing_filenames(
        ev["id"], [f.filename for f in files]
    )
    for f in files:
        entry = {"filename": f.filename, "status": "ok", "error": None}
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in JPG_EXT:
            # 非 JPG（如 iPhone HEIC、PNG）直接标记跳过，让前端明确告知用户
            entry["status"] = "skipped"
            entry["error"] = "非 JPG 格式，已跳过"
            results.append(entry)
            continue
        if f.filename in existing:
            # 同活动同名文件已存在 → 重试/重复上传，跳过避免二次入库
            entry["status"] = "skipped"
            entry["error"] = "已存在（可能由断线重试导致），已跳过"
            results.append(entry)
            continue

        orig_path = prev_path = None
        try:
            safe = f"{uuid.uuid4().hex}{ext}"
            orig_path = os.path.join(orig_dir, safe)
            prev_uuid = uuid.uuid4().hex
            prev_path = os.path.join(prev_dir, f"{prev_uuid}.jpg")
            await _stream_to_disk(f, orig_path)
            taken_at = await image_service.process_image(orig_path, prev_path, preview_size)

            oss_original_key = None
            oss_preview_key = None
            if use_oss:
                event_folder = ev["event_id"]
                # 2026-08 优化：原图只存本地，OSS 仅镜像预览图。
                # 原图 8MB 镜像 OSS 是上传慢的主因（3M 带宽下每张多耗 ~20s），
                # 预览图仅 ~50KB，OSS 用于分享页加速即可。
                oss_preview_key = f"{event_folder}/preview/{prev_uuid}.jpg"
                try:
                    with open(prev_path, "rb") as fp:
                        oss_service.upload_fileobj(fp, oss_preview_key, "image/jpeg")
                except Exception:
                    # OSS 不可用（如 Bucket 缺失/网络异常）时降级为本地存储
                    oss_preview_key = None

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
            entry.update({
                "photo_id": pid,
                "taken_at": taken_at.strftime("%Y-%m-%d %H:%M:%S") if taken_at else None,
            })
        except HTTPException as e:
            # 单文件超限（413）等 → 只标记该文件失败，不拖垮整批
            _cleanup(orig_path, prev_path)
            entry["status"] = "failed"
            entry["error"] = str(e.detail)
        except Exception as e:
            # 其余异常（网络中断、PIL 解码失败等）同样只影响单个文件
            _cleanup(orig_path, prev_path)
            entry["status"] = "failed"
            entry["error"] = str(e)[:200]
        results.append(entry)

    ok_count = sum(1 for r in results if r["status"] == "ok")
    await models.increment_photo_count(ev["id"], ok_count)
    return ok({
        "uploaded": ok_count,
        "total": len(results),
        "results": results,
    })


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
    use_oss = bool(ev.get("use_oss", True)) and oss_service.is_enabled()
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
            try:
                with open(dest, "rb") as fp:
                    oss_service.upload_fileobj(fp, oss_raf_key, "application/octet-stream")
            except Exception:
                # OSS 不可用时降级为本地存储
                oss_raf_key = None

        n = await models.link_raf_by_filename_base(ev["id"], base_name, dest, oss_raf_key)
        matched += n

    # 回填：对本次上传前已存在的同名 RAF 关联到旧照片
    await models.backfill_raf(ev["id"], raf_dir)

    return ok({"saved_raf": saved, "matched": matched})
