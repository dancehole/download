import time
import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException
from .config import JWT_SECRET, JWT_ALG, JWT_EXPIRE_HOURS

SUPER = "super"
ALBUM = "album"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(photographer_id: int, username: str, role: str = ALBUM) -> str:
    payload = {
        "pid": photographer_id,
        "username": username,
        "role": role or ALBUM,
        "exp": int(time.time()) + JWT_EXPIRE_HOURS * 3600,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str):
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except Exception:
        return None


async def current_photographer(authorization: str = Header(default=None)) -> dict:
    """FastAPI 依赖：校验登录态。

    权限以**数据库当前状态**为准（token 里只做粗略标记），因此：
      - 停用账号 / 取消相册授权 / 改角色，下一次请求立刻生效，无需等 token 过期；
      - 老 token（无 role 字段）不会失效。
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    payload = decode_token(authorization[7:])
    if not payload:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

    from . import models   # 延迟导入：避免 models -> db -> auth 循环依赖
    row = await models.get_photographer_by_id(payload.get("pid"))
    if not row:
        raise HTTPException(status_code=401, detail="账号不存在或已被删除")
    if not int(row.get("is_active", 1)):
        raise HTTPException(status_code=401, detail="账号已被停用，请联系管理员")

    return {
        "pid": row["id"],
        "id": row["id"],
        "username": row["username"],
        "role": row.get("role") or ALBUM,
        "is_active": int(row.get("is_active", 1)),
    }


async def current_super(user: dict = Depends(current_photographer)) -> dict:
    """仅超级管理员可访问的接口依赖（共享文件、OSS 设置、用户管理等）。"""
    if not is_super(user):
        raise HTTPException(status_code=403, detail="需要超级管理员权限")
    return user


def is_super(user: dict) -> bool:
    return bool(user) and user.get("role") == SUPER
