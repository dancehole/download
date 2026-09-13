from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import create_token, verify_password, current_photographer, SUPER
from .. import models
from ..response import ok, fail

router = APIRouter()


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
async def login(body: LoginIn):
    user = await models.get_photographer_by_username(body.username)
    if not user or not verify_password(body.password, user["password_hash"]):
        return fail(401, "用户名或密码错误")
    if not int(user.get("is_active", 1)):
        return fail(403, "账号已被停用，请联系管理员")
    role = user.get("role") or "album"
    token = create_token(user["id"], user["username"], role)
    return ok({
        "token": token,
        "photographer_id": user["id"],
        "username": user["username"],
        "role": role,
        "is_super": role == SUPER,
    })


@router.get("/auth/me")
async def me(user: dict = Depends(current_photographer)):
    """返回当前账号信息（角色以数据库实时状态为准，前端据此控制入口显隐）。"""
    return ok({
        "photographer_id": user["pid"],
        "username": user["username"],
        "role": user["role"],
        "is_super": user["role"] == SUPER,
    })
