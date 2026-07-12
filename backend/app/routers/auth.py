from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import create_token, verify_password, current_photographer
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
    token = create_token(user["id"], user["username"])
    return ok({"token": token, "photographer_id": user["id"], "username": user["username"]})


@router.get("/auth/me")
async def me(user: dict = Depends(current_photographer)):
    return ok({"photographer_id": user["pid"], "username": user["username"]})
