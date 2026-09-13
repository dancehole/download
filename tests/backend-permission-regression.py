#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""相册权限体系后端回归（超管 / 相册管理员 两种角色的接口边界）。

用法: DEFAULT_ADMIN_PASSWORD=xxx python3 /tmp/permission-regression.py
前提: 服务已重启且完成 init_db 迁移。
"""
import json
import os
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8001/download/api"
ROOT = "http://127.0.0.1:8001/download"        # 非 /api 前缀的接口（OSS 设置）
ADMIN_PW = os.environ.get("DEFAULT_ADMIN_PASSWORD") or "admin123"

results = []


def req_url(method, url, token=None, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def req(method, path, token=None, body=None):
    return req_url(method, BASE + path, token, body)


def upload_photo(event_id, token, filename="e2e_1x1.jpg"):
    """真 multipart 上传一张 1x1 JPEG，返回 (http_status, 业务码)。"""
    import base64
    import subprocess
    import tempfile
    jpg = base64.b64decode(
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
        "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
        "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
    )
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(jpg)
        path = f.name
    out = subprocess.run(
        ["curl", "-s", "-o", "/dev/stdout", "-w", "\n%{http_code}",
         "-X", "POST", f"{BASE}/events/{event_id}/upload",
         "-H", f"Authorization: Bearer {token}",
         "-F", f"files=@{path};type=image/jpeg",
         "-F", "tag=e2e权限测试"],
        capture_output=True, text=True, timeout=120,
    )
    lines = out.stdout.rsplit("\n", 1)
    try:
        payload = json.loads(lines[0])
    except Exception:
        payload = {"raw": out.stdout[:200]}
    status = int(lines[1]) if len(lines) > 1 and lines[1].strip().isdigit() else 0
    return status, payload


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (("  | " + str(detail)) if detail != "" else ""))


def code_of(resp):
    """业务返回码：HTTPException 用 HTTP status，自有 fail() 用 body.code。"""
    status, body = resp
    if isinstance(body, dict) and "code" in body:
        return body["code"]
    return status


# ───────────────── 1. 超管登录 ─────────────────
st, r = req("POST", "/auth/login", body={"username": "admin", "password": ADMIN_PW})
check("超管登录成功", st == 200 and r.get("code") == 0, r)
admin_token = (r.get("data") or {}).get("token")
admin_role = (r.get("data") or {}).get("role")
check("超管 role=super / is_super", admin_role == "super" and r["data"].get("is_super") is True, r.get("data"))

st, r = req("GET", "/auth/me", admin_token)
check("/auth/me 返回 role=super", r.get("data", {}).get("role") == "super", r.get("data"))

# ───────────────── 2. 超管能力 ─────────────────
st, r = req("GET", "/events", admin_token)
events = r.get("data") or []
# 清掉上一次跑挂留下的临时相册，保证可重复执行
for e in list(events):
    if e["event_name"].startswith("e2e临时相册"):
        req("DELETE", f"/events/{e['event_id']}", admin_token)
        print(f"      （已清理残留临时相册 {e['event_name']}）")
st, r = req("GET", "/events", admin_token)
events = r.get("data") or []
check("超管能看到全部相册", len(events) >= 3, f"{len(events)} 个")
check("相册带归属账号 owner", all(e.get("owner") for e in events), [e.get("owner") for e in events][:3])
by_name = {e["event_name"]: e for e in events}
pick = [e for e in events if e["event_name"] != "test"][:2]
A, B = pick[0], pick[1]
print(f"      用例相册: A={A['event_name']}({A['event_id']}) B={B['event_name']}({B['event_id']})")

st, r = req("GET", "/files", admin_token)
check("超管能看共享文件", code_of((st, r)) == 0, code_of((st, r)))

st, r = req_url("GET", BASE + "/admin/settings/oss", admin_token)
check("超管能读 OSS 配置", st == 200 and r.get("code") == 0, str(r)[:120])

st, r = req("GET", "/users", admin_token)
check("超管能看账号列表", code_of((st, r)) == 0 and isinstance(r.get("data"), list), r.get("data"))

# 超管建一个临时相册，后面用来测「相册管理员上传/删除自己被授权的相册」
st, r = req("POST", "/events", admin_token, {"event_name": "e2e临时相册-权限测试"})
check("超管可新建相册", r.get("code") == 0, r.get("msg"))
TEMP = (r.get("data") or {}).get("event_id")
TEMP_NAME = (r.get("data") or {}).get("event_name")

# ───────────────── 3. 超管创建相册管理员（只授权相册 A） ─────────────────
TEST_USER = "e2e_album_admin"
# 先清掉历史残留
st, r = req("GET", "/users", admin_token)
for u in (r.get("data") or []):
    if u.get("username") == TEST_USER:
        req("DELETE", f"/users/{u['id']}", admin_token)

st, r = req("POST", "/users", admin_token,
            {"username": TEST_USER, "role": "album", "event_ids": [A["event_id"]]})
check("超管创建相册管理员（自动生成密码）", r.get("code") == 0, r.get("msg"))
new_pw = r.get("data", {}).get("password")
uid = r.get("data", {}).get("id")
check("创建接口返回一次性明文密码", bool(new_pw) and len(new_pw) >= 8, f"len={len(new_pw or '')}")
check("授权相册已写入 ACL", [a["event_id"] for a in r["data"].get("albums", [])] == [A["event_id"]], r["data"].get("albums"))

st, r = req("POST", "/users", admin_token, {"username": TEST_USER, "role": "album"})
check("重名创建被拒(409)", r.get("code") == 409, r)

# ───────────────── 4. 相册管理员登录 ─────────────────
st, r = req("POST", "/auth/login", body={"username": TEST_USER, "password": new_pw})
check("相册管理员可登录", st == 200 and r.get("code") == 0, r)
alb_token = (r.get("data") or {}).get("token")
check("登录返回 role=album / is_super=false",
      r["data"].get("role") == "album" and r["data"].get("is_super") is False, r.get("data"))

# ───────────────── 5. 相册管理员权限边界 ─────────────────
st, r = req("GET", "/events", alb_token)
names = [e["event_name"] for e in (r.get("data") or [])]
check("相册管理员只看到被授权相册", names == [A["event_name"]], names)

st, r = req("GET", f"/events/{A['event_id']}", alb_token)
check("能打开被授权相册详情", r.get("code") == 0, r.get("msg"))
check("详情返回该相册管理员列表", isinstance(r.get("data", {}).get("admins"), list) and
      any(a["username"] == TEST_USER for a in r["data"]["admins"]), r.get("data", {}).get("admins"))
check("详情返回 my_role=album", r["data"].get("my_role") == "album", r["data"].get("my_role"))

st, r = req("GET", f"/events/{B['event_id']}", alb_token)
check("未授权相册详情 → 404（不泄露存在性）", r.get("code") == 404, r)

st, r = req("PUT", f"/events/{B['event_id']}/settings", alb_token, {"preview_size": 640})
check("未授权相册改设置 → 404", r.get("code") == 404, r)

st, r = req("PUT", f"/events/{A['event_id']}/settings", alb_token, {"preview_size": 640})
check("被授权相册改设置 → 允许", r.get("code") == 0, r.get("msg"))

st, r = req("POST", "/events", alb_token, {"event_name": "e2e_不该建出来"})
check("相册管理员新建相册 → 403", code_of((st, r)) == 403, f"{st} {r}")

st, r = req("GET", "/files", alb_token)
check("相册管理员看共享文件 → 403", code_of((st, r)) == 403, f"{st} {r}")

st, r = req_url("GET", BASE + "/admin/settings/oss", alb_token)
check("相册管理员读 OSS 配置 → 403", code_of((st, r)) == 403, f"{st} {r}")

st, r = req("GET", "/users", alb_token)
check("相册管理员看账号管理 → 403", code_of((st, r)) == 403, f"{st} {r}")

st, r = upload_photo(TEMP, alb_token)
check("未授权相册上传照片 → 404（拦截在权限层）", r.get("code") == 404, f"{st} {r}")

st, r = req("POST", f"/users/{uid}/albums/{TEMP}", admin_token)
check("超管把临时相册授权给该相册管理员", r.get("code") == 0, r.get("msg"))
st, r = upload_photo(TEMP, alb_token)
check("被授权后上传照片 → 成功", r.get("code") == 0 and ((r.get("data") or {}).get("results") or [{}])[0].get("status") == "ok", f"{st} {str(r)[:160]}")
st, r = req("GET", f"/events/{TEMP}", alb_token)
check("相册管理员能看到新上传的照片", r.get("code") == 0 and (r.get("data") or {}).get("photo_count") == 1, (r.get("data") or {}).get("photo_count"))

st, r = req("POST", f"/events/{A['event_id']}/share", alb_token)
check("被授权相册可重发分享链接", r.get("code") == 0, r.get("msg"))
if r.get("code") == 0:
    A["share_token"] = r["data"].get("share_token")

st, r = req("DELETE", f"/events/{B['event_id']}", alb_token)
check("未授权相册删除 → 404（没被真删）", r.get("code") == 404, r)
st, r = req("GET", f"/events/{B['event_id']}", admin_token)
check("该相册仍然存在（确认未被误删）", r.get("code") == 0, r.get("msg"))

# ───────────────── 6. 停用 / 恢复 / 取消授权 立即生效 ─────────────────
st, r = req("PUT", f"/users/{uid}/active", admin_token, {"active": False})
check("超管停用账号", r.get("code") == 0, r.get("msg"))
st, r = req("GET", "/events", alb_token)
check("停用后旧 token 立即失效(401)", code_of((st, r)) == 401, f"{st} {r}")
st, r = req("POST", "/auth/login", body={"username": TEST_USER, "password": new_pw})
check("停用后登录被拒(403)", r.get("code") == 403, r)

st, r = req("PUT", f"/users/{uid}/active", admin_token, {"active": True})
check("超管恢复账号", r.get("code") == 0, r.get("msg"))
st, r = req("POST", "/auth/login", body={"username": TEST_USER, "password": new_pw})
alb_token = (r.get("data") or {}).get("token")
check("恢复后可再次登录", bool(alb_token), r.get("msg"))

st, r = req("DELETE", f"/users/{uid}/albums/{A['event_id']}", admin_token)
check("超管取消相册授权", r.get("code") == 0, r.get("msg"))
st, r = req("GET", f"/events/{A['event_id']}", alb_token)
check("取消授权后立刻看不到该相册(404)", r.get("code") == 404, r)
st, r = req("GET", "/events", alb_token)
_names = [e["event_name"] for e in (r.get("data") or [])]
check("取消授权后该相册立刻从列表消失", A["event_name"] not in _names, _names)

st, r = req("POST", f"/users/{uid}/albums/{A['event_id']}", admin_token)
check("再次授予该相册（相册详情页用）", r.get("code") == 0, r.get("msg"))
st, r = req("GET", f"/events/{A['event_id']}", alb_token)
check("重新授权后立刻恢复访问", r.get("code") == 0, r.get("msg"))

# ───────────────── 7. 密码重置 ─────────────────
st, r = req("PUT", f"/users/{uid}/password", admin_token, {})
new_pw2 = r.get("data", {}).get("password")
check("超管重置密码返回新明文", r.get("code") == 0 and new_pw2 != new_pw, f"len={len(new_pw2 or '')}")
st, r = req("POST", "/auth/login", body={"username": TEST_USER, "password": new_pw2})
check("新密码可登录", r.get("code") == 0, r.get("msg"))

# ───────────────── 8. 保护规则 ─────────────────
st, r = req("PUT", "/users/1/active", admin_token, {"active": False})
check("不允许停用最后一个超管（含自己）", r.get("code") == 400, r)
st, r = req("DELETE", "/users/1", admin_token)
check("不允许删除当前登录账号", r.get("code") == 400, r)
st, r = req("PUT", f"/users/{uid}/role", admin_token, {"role": "super"})
check("可提升为超管", r.get("code") == 0 and r["data"].get("role") == "super", r.get("data"))
st, r = req("PUT", f"/users/{uid}/active", admin_token, {"active": False})
check("有两个超管时可停用其中之一", r.get("code") == 0, r.get("msg"))
st, r = req("PUT", f"/users/{uid}/active", admin_token, {"active": True})
req("PUT", f"/users/{uid}/role", admin_token, {"role": "album"})   # 降回相册管理员

# ───────────────── 8.5 相册管理员可以删除被授权的相册（默认决策） ─────────────────
st, r = req("DELETE", f"/events/{TEMP}", alb_token)
check("相册管理员可删除被授权相册", r.get("code") == 0, r.get("msg"))
st, r = req("GET", f"/events/{TEMP}", admin_token)
check("临时相册确已删除（含其照片记录）", r.get("code") == 404, r)
st, r = req("GET", "/events", admin_token)
check("超管相册列表恢复原有数量（测试数据已清理）", len(r.get("data") or []) == len(events), f"{len(r.get('data') or [])} vs {len(events)}")

# ───────────────── 9. 清理 ─────────────────
st, r = req("DELETE", f"/users/{uid}", admin_token)
check("删除测试账号", r.get("code") == 0, r.get("msg"))
st, r = req("GET", "/users", admin_token)
left = [u["username"] for u in (r.get("data") or [])]
check("账号列表已恢复只剩 admin", left == ["admin"], left)

# 分享页仍正常（公开接口不受权限改动影响）
st, r = req("GET", f"/share/{A['share_token']}")
check("分享页公开接口正常", st == 200 and r.get("code") == 0, r.get("msg"))

fails = [x for x in results if not x]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
raise SystemExit(1 if fails else 0)
