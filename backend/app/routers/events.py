import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import current_photographer
from .. import models, oss_service, counter_store, cleanup_service
from ..response import ok, fail, event_to_dict, format_size

router = APIRouter()

TAG_MAX_LEN = 64


def _gen_event_id() -> str:
    # 8 位大写字母数字，去除易混淆字符
    import string
    alphabet = string.ascii_uppercase + string.digits
    alphabet = alphabet.translate(str.maketrans("", "", "O0IL1"))
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _gen_token() -> str:
    return secrets.token_urlsafe(18)[:24]


def _expiry_from_hours(hours) -> "datetime | None":
    """小时数 → 过期时间点。0 / None / 负数表示永不过期；超过上限按上限处理（由路由层校验）。"""
    try:
        hours = int(hours)
    except (TypeError, ValueError):
        return None
    if hours <= 0:
        return None
    return datetime.now() + timedelta(hours=hours)


# 过期时间上限：30 天（见需求：新建相册最长 30 天后自动过期）
MAX_EXPIRY_HOURS = 720


class CreateEventIn(BaseModel):
    event_name: str
    preview_size: int = 640
    use_oss: bool = True
    expires_in_hours: int = 0      # 0 = 永不过期


@router.post("/events")
async def create_event(body: CreateEventIn, user: dict = Depends(current_photographer)):
    name = body.event_name.strip()
    if not name:
        return fail(400, "活动主题不能为空")
    if body.expires_in_hours and body.expires_in_hours > MAX_EXPIRY_HOURS:
        return fail(400, "过期时间最长 30 天")
    eid = None
    for _ in range(8):
        cand = _gen_event_id()
        if not await models.get_event_by_id(cand):
            eid = cand
            break
    if eid is None:
        return fail(500, "活动 ID 生成失败，请重试")
    token = _gen_token()
    expires_at = _expiry_from_hours(body.expires_in_hours)
    ev = await models.create_event(eid, name, token, user["pid"],
                                   preview_size=body.preview_size,
                                   use_oss=body.use_oss,
                                   expires_at=expires_at)
    return ok(event_to_dict(ev))


@router.get("/events")
async def list_events(user: dict = Depends(current_photographer)):
    # 先把计数缓冲落库，保证后台看到的是最新数字
    await counter_store.flush()
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
    # 本地存储占用（用于后台「文件占用 xx 空间」提示）
    size = cleanup_service.calculate_local_size(ev["event_id"])
    data["storage_size"] = size
    data["storage_size_text"] = format_size(size)
    return ok(data)


class UpdateEventSettingsIn(BaseModel):
    preview_size: int = None
    use_oss: bool = None
    expires_in_hours: int = None    # 0 = 永不过期；不传则不修改


@router.put("/events/{event_id}/settings")
async def update_event_settings(event_id: str, body: UpdateEventSettingsIn, user: dict = Depends(current_photographer)):
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")

    if body.expires_in_hours is not None:
        if body.expires_in_hours > MAX_EXPIRY_HOURS:
            return fail(400, "过期时间最长 30 天")
        await models.update_event_expiry(ev["id"], _expiry_from_hours(body.expires_in_hours))

    await models.update_event_settings(ev["id"], body.preview_size, body.use_oss)
    ev = await models.get_event_by_id(event_id)
    return ok(event_to_dict(ev))


class RenameTagIn(BaseModel):
    old_tag: str
    old_tag_en: str = None
    new_tag: str
    new_tag_en: str = None


@router.put("/events/{event_id}/tags")
async def rename_tag(event_id: str, body: RenameTagIn, user: dict = Depends(current_photographer)):
    """重命名相册内已有标签。

    标签以字符串形式冗余存储在 photo 行上，改名等价于批量 UPDATE 引用旧标签的
    照片行：photo.id / photo.event_id 全程不变，已绑定的照片自动跟随新名称，
    不会解绑也不会丢图。若新名称在本相册已存在，两张标签的照片会合并为一类。
    """
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")

    old_tag = (body.old_tag or "").strip()
    new_tag = (body.new_tag or "").strip()
    new_tag_en = (body.new_tag_en or "").strip() or new_tag
    old_tag_en = (body.old_tag_en or "").strip() or None

    if not old_tag:
        return fail(400, "原标签不能为空")
    if not new_tag:
        return fail(400, "新标签不能为空")
    if len(new_tag) > TAG_MAX_LEN or len(new_tag_en) > TAG_MAX_LEN:
        return fail(400, f"标签长度不能超过 {TAG_MAX_LEN} 个字符")
    if new_tag == old_tag and (old_tag_en is None or new_tag_en == old_tag_en):
        return fail(400, "新标签与原标签相同")

    before = await models.count_photos_by_tag(ev["id"], old_tag, old_tag_en)
    if before == 0:
        return fail(404, "该标签下没有照片，可能已被改名")

    # 目标名称已存在 → 合并，提前告知前端确认
    exists = await models.count_photos_by_tag(ev["id"], new_tag)
    merged = exists > 0 and new_tag != old_tag

    affected = await models.rename_event_tag(ev["id"], old_tag, new_tag,
                                             new_tag_en, old_tag_en)

    tags = await models.get_tags(ev["id"])
    return ok({
        "affected": affected,
        "merged": merged,
        "merged_into": exists if merged else 0,
        "tag": {"tag": new_tag, "tag_en": new_tag_en, "count": affected + (exists if merged else 0)},
        "tags": [{"tag": t["tag"], "tag_en": t.get("tag_en") or t["tag"], "count": t["cnt"]} for t in tags],
    })


@router.post("/events/{event_id}/share")
async def regen_share(event_id: str, user: dict = Depends(current_photographer)):
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    token = _gen_token()
    await models.update_share_token(ev["id"], token)
    return ok({"share_token": token, "share_url": f"/share/{token}"})


@router.post("/events/{event_id}/clear-oss")
async def clear_event_oss(event_id: str, user: dict = Depends(current_photographer)):
    """仅清空相册在 OSS 上的远程对象（本地文件保留）。"""
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    n = cleanup_service.clear_oss(ev)
    if n == -1:
        return fail(502, "OSS 清理失败，请稍后重试")
    # 同步清空照片行上的 OSS key，避免签名 URL 指向已删除对象
    await models.clear_event_oss_keys(ev["id"])
    await models.mark_event_oss_cleared(ev["id"])
    return ok({"oss_deleted": n})


@router.post("/events/{event_id}/clear-local")
async def clear_event_local(event_id: str, user: dict = Depends(current_photographer)):
    """仅删除相册的本地照片文件（OSS 保留）。删除后照片记录一并清空、分享页拦截。"""
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    freed = cleanup_service.clear_local(ev)
    # 照片行随文件一起删除，条目保留为空壳（photo_count 归零）
    await models.delete_photos_by_event(ev["id"])
    await models.mark_event_local_cleared(ev["id"])
    return ok({"freed_bytes": freed, "freed_text": format_size(freed)})


@router.delete("/events/{event_id}")
async def delete_event(event_id: str, user: dict = Depends(current_photographer)):
    """彻底删除整个相册：OSS 远程对象、本地照片文件、数据库记录（空间与记录都清空）。"""
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")

    result = await cleanup_service.delete_album(ev)
    return ok(result)
