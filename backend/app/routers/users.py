"""账号与相册授权管理（全部接口仅超级管理员可用）。

权限模型：
    账号(photographer.role) = super | album
    授权(album_admin_acl)    = 账号 ↔ 相册 多对多
      · 一个相册管理员可以管理多个相册（勾选即可）
      · 一个相册可以有多个管理员账号
      · 取消授权只删授权行，账号本身保留（历史 created_by 不受影响）

超级管理员：全部相册 + 共享文件 + OSS 设置 + 用户管理
相册管理员：仅被授权相册的增删改查/上传；看不到其他相册；无共享文件与系统设置权限
"""
import re
import secrets

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import current_super, hash_password, SUPER, ALBUM
from .. import models
from ..response import ok, fail

router = APIRouter()

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{3,32}$")
PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PW_SYMBOL = "!@#$%^&*"
ROLES = (SUPER, ALBUM)


def _gen_password(length: int = 12) -> str:
    """生成易读的一次性强密码（去掉 0/O/1/l/I 等易混字符）。"""
    body = "".join(secrets.choice(PW_ALPHABET) for _ in range(max(6, length - 1)))
    return body + secrets.choice(PW_SYMBOL)


async def _resolve_event_pks(event_ids) -> tuple:
    """event_id（字符串）→ 主键列表。返回 (pks, 不存在的 event_id 列表)。"""
    pks, missing = [], []
    for eid in event_ids or []:
        ev = await models.get_event_by_id(str(eid).strip())
        if not ev:
            missing.append(str(eid))
            continue
        if ev["id"] not in pks:
            pks.append(ev["id"])
    return pks, missing


async def _user_dict(row: dict) -> dict:
    albums = await models.list_acl_for_photographer(row["id"])
    created = row.get("created_at")
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row.get("role") or ALBUM,
        "is_active": bool(row.get("is_active", 1)),
        "created_at": created.strftime("%Y-%m-%d %H:%M") if hasattr(created, "strftime") else (created or None),
        "albums": [{"event_id": a["event_id"], "event_name": a["event_name"]} for a in albums],
    }


class UserIn(BaseModel):
    username: str
    password: str = None          # 不传则自动生成
    role: str = ALBUM             # album | super
    event_ids: list = []          # 授权相册（event_id 字符串列表）


class PasswordIn(BaseModel):
    password: str = None          # 不传则自动生成


class AlbumsIn(BaseModel):
    event_ids: list = []


class ActiveIn(BaseModel):
    active: bool = True


@router.get("/users")
async def list_users(user: dict = Depends(current_super)):
    """账号列表（含各自被授权的相册）。"""
    rows = await models.list_photographers()
    return ok([await _user_dict(r) for r in rows])


@router.post("/users")
async def create_user(body: UserIn, user: dict = Depends(current_super)):
    """新建账号。role=album 时可通过 event_ids 一并授权相册。

    返回体里的 password 是**本次设置/生成的明文**，只在这里返回一次，用于复制给使用者。
    """
    username = (body.username or "").strip()
    role = (body.role or ALBUM).strip()
    if not USERNAME_RE.match(username):
        return fail(400, "用户名需为 3-32 位字母、数字、下划线、点或短横线")
    if role not in ROLES:
        return fail(400, "角色无效")
    if await models.get_photographer_by_username(username):
        return fail(409, "用户名已存在")

    raw_password = (body.password or "").strip() or _gen_password()
    if len(raw_password) < 6:
        return fail(400, "密码至少 6 位")

    pks, missing = await _resolve_event_pks(body.event_ids)
    if missing:
        return fail(400, "相册不存在：" + "、".join(missing))

    pid = await models.create_photographer(username, hash_password(raw_password), role)
    if role == ALBUM and pks:
        await models.set_photographer_acl(pid, pks, user["pid"])

    row = await models.get_photographer_by_id(pid)
    data = await _user_dict(row)
    data["password"] = raw_password
    data["granted"] = len(pks)
    return ok(data)


@router.put("/users/{pid}/password")
async def reset_password(pid: int, body: PasswordIn, user: dict = Depends(current_super)):
    """重置密码（不传新密码则自动生成）。明文只在本次返回。"""
    target = await models.get_photographer_by_id(pid)
    if not target:
        return fail(404, "账号不存在")
    raw_password = (body.password or "").strip() or _gen_password()
    if len(raw_password) < 6:
        return fail(400, "密码至少 6 位")
    await models.update_photographer_password(pid, hash_password(raw_password))
    return ok({"id": pid, "username": target["username"], "password": raw_password})


@router.put("/users/{pid}/albums")
async def set_user_albums(pid: int, body: AlbumsIn, user: dict = Depends(current_super)):
    """整体重设某账号的授权相册集合（前端勾选后保存）。"""
    target = await models.get_photographer_by_id(pid)
    if not target:
        return fail(404, "账号不存在")
    if (target.get("role") or ALBUM) == SUPER:
        return fail(400, "超级管理员默认拥有全部相册，无需单独授权")
    pks, missing = await _resolve_event_pks(body.event_ids)
    if missing:
        return fail(400, "相册不存在：" + "、".join(missing))
    await models.set_photographer_acl(pid, pks, user["pid"])
    row = await models.get_photographer_by_id(pid)
    return ok(await _user_dict(row))


@router.post("/users/{pid}/albums/{event_id}")
async def grant_album(pid: int, event_id: str, user: dict = Depends(current_super)):
    """单独授予某相册（相册详情页「指定管理员」用）。"""
    target = await models.get_photographer_by_id(pid)
    if not target:
        return fail(404, "账号不存在")
    if (target.get("role") or ALBUM) == SUPER:
        return fail(400, "超级管理员默认拥有全部相册")
    ev = await models.get_event_by_id(event_id)
    if not ev:
        return fail(404, "相册不存在")
    await models.grant_event(pid, ev["id"], user["pid"])
    return ok({"granted": True, "event_id": ev["event_id"], "username": target["username"]})


@router.delete("/users/{pid}/albums/{event_id}")
async def revoke_album(pid: int, event_id: str, user: dict = Depends(current_super)):
    """取消某账号对某相册的授权（账号保留）。"""
    target = await models.get_photographer_by_id(pid)
    if not target:
        return fail(404, "账号不存在")
    ev = await models.get_event_by_id(event_id)
    if not ev:
        return fail(404, "相册不存在")
    await models.revoke_event(pid, ev["id"])
    return ok({"revoked": True, "event_id": ev["event_id"], "username": target["username"]})


@router.put("/users/{pid}/active")
async def set_user_active(pid: int, body: ActiveIn, user: dict = Depends(current_super)):
    """启用 / 停用账号（停用后该账号的已签发 token 立即失效）。"""
    target = await models.get_photographer_by_id(pid)
    if not target:
        return fail(404, "账号不存在")
    if pid == user["pid"] and not body.active:
        return fail(400, "不能停用当前登录的账号")
    if not body.active and (target.get("role") or ALBUM) == SUPER:
        if await models.count_active_supers(exclude_pid=pid) == 0:
            return fail(400, "必须保留至少一个可用的超级管理员")
    await models.set_photographer_active(pid, body.active)
    return ok({"id": pid, "username": target["username"], "is_active": bool(body.active)})


@router.put("/users/{pid}/role")
async def set_user_role(pid: int, body: UserIn, user: dict = Depends(current_super)):
    """调整角色（super ↔ album）。降级超级管理员时保证仍有可用超管。"""
    role = (body.role or "").strip()
    if role not in ROLES:
        return fail(400, "角色无效")
    target = await models.get_photographer_by_id(pid)
    if not target:
        return fail(404, "账号不存在")
    if pid == user["pid"] and role != SUPER:
        return fail(400, "不能修改当前登录账号的角色")
    if (target.get("role") or ALBUM) == SUPER and role != SUPER:
        if await models.count_active_supers(exclude_pid=pid) == 0:
            return fail(400, "必须保留至少一个可用的超级管理员")
    await models.set_photographer_role(pid, role)
    row = await models.get_photographer_by_id(pid)
    return ok(await _user_dict(row))


@router.delete("/users/{pid}")
async def delete_user(pid: int, user: dict = Depends(current_super)):
    """删除账号。名下仍有相册/共享文件时拒绝（改为停用，保留数据归属）。"""
    target = await models.get_photographer_by_id(pid)
    if not target:
        return fail(404, "账号不存在")
    if pid == user["pid"]:
        return fail(400, "不能删除当前登录的账号")
    if (target.get("role") or ALBUM) == SUPER:
        if await models.count_active_supers(exclude_pid=pid) == 0:
            return fail(400, "必须保留至少一个可用的超级管理员")
    owned = await models.count_owned_records(pid)
    if owned["events"] or owned["files"]:
        return fail(400, f"该账号名下还有 {owned['events']} 个相册、{owned['files']} 个共享文件，"
                         f"请先删除或转移，或改为「停用」")
    await models.delete_photographer(pid)
    return ok({"deleted": True, "id": pid, "username": target["username"]})
