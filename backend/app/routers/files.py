import logging
import os
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, UploadFile, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

from ..auth import current_photographer, current_super
from .. import models, oss_service, counter_store
from ..config import FILES_DIR, FILE_MAX_UPLOAD_SIZE_MB
from ..response import ok, fail, share_file_to_dict

router = APIRouter()

logger = logging.getLogger(__name__)

CHUNK = 1024 * 1024  # 1MB 分块流式写盘


def _gen_file_id() -> str:
    """10 位短 ID（字母 + 数字，不含易混淆字符）"""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(10))


def _gen_token() -> str:
    return secrets.token_urlsafe(18)[:24]


def _local_candidates(f: dict) -> list:
    """本地文件的候选路径。

    记录里的 storage_path 是上传时的绝对路径；项目目录改名 / 搬迁后它会失效，
    所以同时把 FILES_DIR/{file_id} 作为兜底候选——删除与下载都必须按同样的
    顺序尝试，否则会出现「记录删了、文件还在」的孤儿（历史上真有 153MB 的）。
    """
    cands = []
    sp = (f.get("storage_path") or "").strip()
    if sp:
        cands.append(sp)
    fid = (f.get("file_id") or "").strip()
    if fid:   # 空 file_id 会算出 FILES_DIR 目录本身，必须挡住
        fallback = os.path.join(FILES_DIR, fid)
        if fallback not in cands:
            cands.append(fallback)
    return cands


def _is_expired(f: dict) -> bool:
    exp = f.get("expires_at")
    return bool(exp and exp < datetime.now())


async def _stream_to_disk(upload: UploadFile, dest: str) -> int:
    """分块流式写入磁盘，避免整文件驻留内存。超过大小限制则删除并抛错。"""
    limit = FILE_MAX_UPLOAD_SIZE_MB * 1024 * 1024
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
    return total


# ── 管理端 ──────────────────────────────────────────────────

@router.post("/files/upload")
async def upload_share_file(
    file: UploadFile = File(...),
    expire: int = Form(default=0),
    user: dict = Depends(current_super),
):
    """上传共享文件。expire=0 表示永不过期（小时）。"""
    if not file or not file.filename:
        return fail(400, "未选择文件")

    file_id = None
    for _ in range(8):
        cand = _gen_file_id()
        if not await models.get_share_file_by_id(cand):
            file_id = cand
            break
    if file_id is None:
        return fail(500, "文件 ID 生成失败，请重试")

    os.makedirs(FILES_DIR, exist_ok=True)
    dest = os.path.join(FILES_DIR, file_id)
    size = await _stream_to_disk(file, dest)

    now = datetime.now()
    expires_at = now + timedelta(hours=expire) if expire and expire > 0 else None

    # OSS 镜像（全局 OSS 开启时上传；失败则降级为仅本地存储）
    oss_key = None
    if oss_service.is_enabled():
        oss_key = f"files/{file_id}"
        try:
            with open(dest, "rb") as fp:
                oss_service.upload_fileobj(fp, oss_key,
                                           file.content_type or "application/octet-stream")
        except Exception:
            oss_key = None

    token = _gen_token()
    await models.create_share_file(
        file_id, file.filename, size, file.content_type or "",
        dest, oss_key, token, user["pid"], expires_at,
    )
    f = await models.get_share_file_by_id(file_id)
    return ok(share_file_to_dict(f))


@router.get("/files")
async def list_share_files(user: dict = Depends(current_super)):
    """共享文件列表：仅超级管理员（相册管理员无权查看/编辑共享文件）。"""
    # 计数落库，保证后台看到的是最新数字
    await counter_store.flush()
    rows = await models.list_share_files_all()
    return ok([share_file_to_dict(r) for r in rows])


@router.post("/files/{file_id}/share")
async def regen_file_share(file_id: str, user: dict = Depends(current_super)):
    """重新生成分享链接（旧链接立即失效）。"""
    f = await models.get_share_file_by_id(file_id)
    if not f:
        return fail(404, "文件不存在")
    token = _gen_token()
    await models.update_share_file_token(f["id"], token)
    return ok({"share_token": token, "share_url": f"/share/files/{token}"})


@router.delete("/files/{file_id}")
async def delete_share_file(file_id: str, user: dict = Depends(current_super)):
    """删除共享文件：OSS 对象 + 本地文件 + 数据库记录。"""
    if "/" in file_id or ".." in file_id:
        return fail(400, "无效 ID")
    f = await models.get_share_file_by_id(file_id)
    if not f:
        return fail(404, "文件不存在")

    # OSS 对象：key 存在就必须尝试删除，失败即视为未删干净（不静默忽略）
    oss_error = None
    if f.get("oss_key"):
        if oss_service.is_enabled():
            try:
                oss_service.delete_object(f["oss_key"])
            except Exception as e:
                oss_error = str(e)[:200]
        else:
            oss_error = "OSS 当前未启用，远程对象可能残留"

    # 本地文件：storage_path（含失效兜底）+ FILES_DIR/file_id 全部尝试
    removed_local = []
    local_error = None
    for path in _local_candidates(f):
        if not path or not os.path.exists(path):
            continue
        try:
            os.remove(path)
            removed_local.append(path)
        except OSError as e:
            local_error = f"{path}: {e}"
            logger.warning("delete share file %s: remove local failed: %s", file_id, e)

    await models.delete_share_file(f["id"])
    if oss_error or local_error:
        # 数据库记录已删；把未删干净的存储位置明确告知管理员，便于人工复核
        return ok({
            "success": False,
            "oss_error": oss_error,
            "local_error": local_error,
            "removed_local": removed_local,
        })
    return ok({"success": True, "removed_local": removed_local})


# ── 公共分享 ────────────────────────────────────────────────

@router.get("/share/files/{token}")
async def share_file_info(token: str):
    """打开共享文件页时调用，累计一次访问。"""
    f = await models.get_share_file_by_token(token)
    if not f:
        return fail(404, "文件不存在或链接已失效")
    # 过期 / 已清理：只失效链接，本地文件与 OSS 对象都保留（由管理员手动释放）
    if f.get("purged_at"):
        return fail(410, "文件已过期并被清理，请联系管理员获取")
    if _is_expired(f):
        return fail(410, "文件分享链接已过期，请联系管理员获取")
    await counter_store.incr("sf", f["id"], "view")
    return ok(share_file_to_dict(f))


@router.get("/share/files/{token}/download")
async def share_file_download(token: str):
    """实际下载端点：OSS 开启则 302 到签名 URL（防盗链 + 自动失效），否则本地直传。"""
    f = await models.get_share_file_by_token(token)
    if not f:
        return fail(404, "文件不存在或链接已失效")
    if f.get("purged_at"):
        return fail(410, "文件已过期并被清理，请联系管理员获取")
    if _is_expired(f):
        return fail(410, "文件分享链接已过期，请联系管理员获取")

    await counter_store.incr("sf", f["id"], "dl")

    if oss_service.is_enabled() and f.get("oss_key"):
        url = oss_service.sign_download_url(f["oss_key"], f["original_filename"])
        if url:
            return RedirectResponse(url, status_code=302)

    # 与删除保持同一套路径解析：storage_path 失效时兜底 FILES_DIR/{file_id}
    local = next((p for p in _local_candidates(f) if p and os.path.exists(p)), None)
    if not local:
        return fail(404, "文件已丢失，请联系管理员")
    return FileResponse(
        local,
        filename=f["original_filename"],
        media_type=f["mime_type"] or "application/octet-stream",
    )
