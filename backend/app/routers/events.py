import os
import shutil
import secrets
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import current_photographer
from .. import models, oss_service
from ..config import STORAGE_DIR
from ..response import ok, fail, event_to_dict

router = APIRouter()


def _gen_event_id() -> str:
    # 8 位大写字母数字，去除易混淆字符
    import string
    alphabet = string.ascii_uppercase + string.digits
    alphabet = alphabet.translate(str.maketrans("", "", "O0IL1"))
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _gen_token() -> str:
    return secrets.token_urlsafe(18)[:24]


class CreateEventIn(BaseModel):
    event_name: str
    preview_size: int = 640
    use_oss: bool = True


@router.post("/events")
async def create_event(body: CreateEventIn, user: dict = Depends(current_photographer)):
    name = body.event_name.strip()
    if not name:
        return fail(400, "活动主题不能为空")
    eid = None
    for _ in range(8):
        cand = _gen_event_id()
        if not await models.get_event_by_id(cand):
            eid = cand
            break
    if eid is None:
        return fail(500, "活动 ID 生成失败，请重试")
    token = _gen_token()
    ev = await models.create_event(eid, name, token, user["pid"],
                                   preview_size=body.preview_size,
                                   use_oss=body.use_oss)
    return ok(event_to_dict(ev))


@router.get("/events")
async def list_events(user: dict = Depends(current_photographer)):
    rows = await models.list_events_by_user(user["pid"])
    return ok([event_to_dict(r) for r in rows])


@router.get("/events/{event_id}")
async def get_event(event_id: str, user: dict = Depends(current_photographer)):
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    tags = await models.get_tags(ev["id"])
    data = event_to_dict(ev)
    data["tags"] = [{"tag": t["tag"], "tag_en": t.get("tag_en") or t["tag"], "count": t["cnt"]} for t in tags]
    return ok(data)


class UpdateEventSettingsIn(BaseModel):
    preview_size: int = None
    use_oss: bool = None


@router.put("/events/{event_id}/settings")
async def update_event_settings(event_id: str, body: UpdateEventSettingsIn, user: dict = Depends(current_photographer)):
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    await models.update_event_settings(ev["id"], body.preview_size, body.use_oss)
    ev = await models.get_event_by_id(event_id)
    return ok(event_to_dict(ev))


@router.post("/events/{event_id}/share")
async def regen_share(event_id: str, user: dict = Depends(current_photographer)):
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    token = _gen_token()
    await models.update_share_token(ev["id"], token)
    return ok({"share_token": token, "share_url": f"/share/{token}"})


@router.delete("/events/{event_id}")
async def delete_event(event_id: str, user: dict = Depends(current_photographer)):
    """彻底删除活动：OSS 远程对象、本地照片文件、数据库记录。"""
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")

    event_pk = ev["id"]
    event_folder = ev["event_id"]

    # 1. 删除 OSS 远程对象（按前缀整目录清理，确保无残留）
    oss_deleted = 0
    if oss_service.is_enabled():
        try:
            oss_deleted = oss_service.delete_prefix(f"{event_folder}/")
        except Exception:
            # OSS 不可用（如 Bucket 不存在/网络异常）时跳过远程清理，不阻塞本地删除
            oss_deleted = -1

    # 2. 删除本地存储目录
    local_dir = os.path.join(STORAGE_DIR, event_folder)
    if os.path.isdir(local_dir):
        shutil.rmtree(local_dir, ignore_errors=True)

    # 3. 删除数据库记录（photo 表 ON DELETE CASCADE 级联删除）
    await models.delete_event(event_pk)

    return ok({"oss_deleted": oss_deleted})
