import time
import bcrypt
import jwt
from fastapi import Header, HTTPException
from .config import JWT_SECRET, JWT_ALG, JWT_EXPIRE_HOURS


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(photographer_id: int, username: str) -> str:
    payload = {
        "pid": photographer_id,
        "username": username,
        "exp": int(time.time()) + JWT_EXPIRE_HOURS * 3600,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str):
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except Exception:
        return None


async def current_photographer(authorization: str = Header(default=None)) -> dict:
    """FastAPI 依赖：校验摄影师登录态"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    payload = decode_token(authorization[7:])
    if not payload:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return payload
