import secrets
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import current_photographer
from .. import models
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


@router.post("/events")
async def create_event(body: CreateEventIn, user: dict = Depends(current_photographer)):
    name = body.event_name.strip()
    if not name:
        return fail(400, "活动主题不能为空")
    # 生成唯一 event_id
    eid = None
    for _ in range(8):
        cand = _gen_event_id()
        if not await models.get_event_by_id(cand):
            eid = cand
            break
    if eid is None:
        return fail(500, "活动 ID 生成失败，请重试")
    token = _gen_token()
    ev = await models.create_event(eid, name, token, user["pid"])
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
    data["tags"] = [{"tag": t["tag"], "count": t["cnt"]} for t in tags]
    return ok(data)


@router.post("/events/{event_id}/share")
async def regen_share(event_id: str, user: dict = Depends(current_photographer)):
    ev = await models.get_event_by_id(event_id)
    if not ev or ev["created_by"] != user["pid"]:
        return fail(404, "活动不存在")
    token = _gen_token()
    await models.update_share_token(ev["id"], token)
    return ok({"share_token": token, "share_url": f"/share/{token}"})
