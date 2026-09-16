"""端到端验证：相册 / 共享文件的删除是否真的清掉「本地 + OSS + 数据库」，
以及「过期」是否只屏蔽链接、不动文件。

真实调用 127.0.0.1:8001 上的线上服务，用临时测试数据，跑完自动清理。
用法：cd backend && venv/bin/python ../tests/e2e-delete-expire.py
（需要服务已启动；会创建临时相册/文件并在结束时清掉）
"""
import asyncio
import io
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

BASE = "http://127.0.0.1:8001/download"
API = BASE + "/api"

from app.config import STORAGE_DIR, FILES_DIR, DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASSWORD
from app.db import get_pool, close_pool
from app.models import get_setting
from app import oss_service

RESULTS = []


def rec(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))


async def db(sql, args=(), fetch=True):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, args)
            rows = await cur.fetchall() if fetch else None
            return rows


async def init_oss():
    cfg = {}
    for key, field in [
        ("oss_enabled", "enabled"), ("oss_access_key_id", "access_key_id"),
        ("oss_access_key_secret", "access_key_secret"), ("oss_endpoint", "endpoint"),
        ("oss_bucket", "bucket"), ("oss_custom_domain", "custom_domain"),
        ("oss_sign_url_ttl", "sign_url_ttl"),
    ]:
        v = await get_setting(key)
        if v is not None:
            cfg[field] = v
    cfg["enabled"] = str(cfg.get("enabled", "")).lower() in ("1", "true", "yes")
    oss_service.init_oss(cfg)


def oss_keys(prefix):
    b = oss_service._bucket
    if not b:
        return []
    import oss2
    return [o.key for o in oss2.ObjectIterator(b, prefix=prefix)]


def make_jpeg(path, size=(64, 48)):
    from PIL import Image
    Image.new("RGB", size, (120, 90, 200)).save(path, "JPEG")


def login():
    r = requests.post(API + "/auth/login",
                      json={"username": DEFAULT_ADMIN_USER, "password": DEFAULT_ADMIN_PASSWORD},
                      timeout=20).json()
    assert r.get("code") == 0, f"登录失败: {r}"
    return r["data"]["token"]


def hdr(tok):
    return {"Authorization": "Bearer " + tok}


def api(method, path, tok, **kw):
    kw.setdefault("timeout", 60)
    kw.setdefault("headers", hdr(tok))
    return requests.request(method, API + path, **kw)


async def main():
    await init_oss()
    print("OSS enabled:", oss_service.is_enabled())
    tok = login()
    ts = str(int(time.time()))[-6:]

    # ─────────────────────── 1. 相册：上传 → 删除 ───────────────────────
    print("\n=== 1. 相册完整删除（本地 + OSS + 数据库）===")
    ev = api("POST", "/events", tok, json={"event_name": f"DELTEST-{ts}",
                                           "expires_in_hours": 1, "use_oss": True}).json()
    assert ev.get("code") == 0, ev
    eid = ev["data"]["event_id"]
    print("  测试相册:", eid)

    tmp_jpg = f"/tmp/deltest_{ts}.jpg"
    make_jpeg(tmp_jpg)
    with open(tmp_jpg, "rb") as fp:
        up = api("POST", f"/events/{eid}/upload", tok,
                 files=[("files", (f"deltest_{ts}.jpg", fp, "image/jpeg"))],
                 data={"tag": "测试"}).json()
    print("  上传结果:", json.dumps(up.get("data"), ensure_ascii=False)[:160])

    local_dir = os.path.join(STORAGE_DIR, eid)
    local_files = []
    for root, _d, fs in os.walk(local_dir):
        local_files += [os.path.join(root, f) for f in fs]
    rec("上传后本地文件存在", len(local_files) > 0, f"{len(local_files)} 个文件")

    ev_row = (await db("SELECT id FROM event WHERE event_id=%s", (eid,)))[0]
    pk = ev_row["id"]
    photos = await db("SELECT oss_preview_key FROM photo WHERE event_id=%s", (pk,))
    okeys = oss_keys(eid + "/")
    rec("上传后 OSS 镜像存在（预览图）", len(okeys) == len(photos) and len(okeys) > 0,
        f"OSS {len(okeys)} 个 / photo 行 {len(photos)} 条")

    # 造一条 ACL，验证删相册时授权行是否级联清理
    await db("INSERT IGNORE INTO album_admin_acl (photographer_id, event_id) VALUES (1, %s)",
             (pk,), fetch=False)

    d = api("DELETE", f"/events/{eid}", tok).json()
    print("  删除返回:", json.dumps(d, ensure_ascii=False))

    rec("相册删除后本地目录消失", not os.path.exists(local_dir),
        "" if not os.path.exists(local_dir) else f"仍在: {local_dir}")
    rec("相册删除后 OSS 对象清空", len(oss_keys(eid + "/")) == 0,
        f"残留 {len(oss_keys(eid + '/'))} 个")
    rec("相册删除后 event 行消失", len(await db("SELECT id FROM event WHERE id=%s", (pk,))) == 0)
    rec("相册删除后 photo 行级联清空", len(await db("SELECT id FROM photo WHERE event_id=%s", (pk,))) == 0)
    rec("相册删除后 ACL 授权行级联清空",
        len(await db("SELECT id FROM album_admin_acl WHERE event_id=%s", (pk,))) == 0)

    # ─────────────────────── 2. 共享文件：上传 → 删除 ───────────────────────
    print("\n=== 2. 共享文件完整删除（本地 + OSS + 数据库）===")
    payload = f"hello del test {ts}".encode()
    up2 = api("POST", "/files/upload", tok,
              files=[("file", (f"deltest_{ts}.txt", io.BytesIO(payload), "text/plain"))],
              data={"expire": 1}).json()
    assert up2.get("code") == 0, up2
    fid = up2["data"]["file_id"]
    print("  测试文件:", fid, up2["data"].get("file_name"))
    local_fp = os.path.join(FILES_DIR, fid)
    rec("共享文件本地落盘", os.path.exists(local_fp))
    rec("共享文件 OSS 镜像存在", len(oss_keys(f"files/{fid}")) == 1,
        f"keys={oss_keys('files/' + fid)}")

    d2 = api("DELETE", f"/files/{fid}", tok).json()
    print("  删除返回:", json.dumps(d2, ensure_ascii=False))
    rec("共享文件删除后本地文件消失", not os.path.exists(local_fp),
        "" if not os.path.exists(local_fp) else f"仍在: {local_fp}")
    rec("共享文件删除后 OSS 对象清空", len(oss_keys(f"files/{fid}")) == 0)
    rec("共享文件删除后数据库行消失",
        len(await db("SELECT id FROM share_file WHERE file_id=%s", (fid,))) == 0)

    # ─────────────────────── 3. 过期：是否只屏蔽链接 ───────────────────────
    print("\n=== 3. 过期相册：应当只屏蔽链接、不动本地文件 ===")
    ev3 = api("POST", "/events", tok, json={"event_name": f"EXPTEST-{ts}",
                                            "expires_in_hours": 1, "use_oss": False}).json()
    eid3 = ev3["data"]["event_id"]
    with open(tmp_jpg, "rb") as fp:
        api("POST", f"/events/{eid3}/upload", tok,
            files=[("files", (f"exptest_{ts}.jpg", fp, "image/jpeg"))])
    row3 = (await db("SELECT id, share_token FROM event WHERE event_id=%s", (eid3,)))[0]
    await db("UPDATE event SET expires_at=NOW() - INTERVAL 1 HOUR WHERE id=%s", (row3["id"],), fetch=False)
    token3 = row3["share_token"]
    dir3 = os.path.join(STORAGE_DIR, eid3)

    info = requests.get(f"{API}/share/{token3}", timeout=20).json()
    det = api("GET", f"/events/{eid3}", tok).json()  # 后台详情（管理端不受过期影响）
    photos3 = await db("SELECT id, original_path FROM photo WHERE event_id=%s", (row3["id"],))
    pid = photos3[0]["id"]
    orig = requests.get(f"{API}/share/{token3}/photos/{pid}/original?download=1", timeout=30)
    rec("过期相册：分享页 info 被拦截",
        info.get("code") not in (0, None), f"code={info.get('code')} msg={info.get('msg') or info.get('message')}")
    rec("过期相册：原图下载被拦截",
        orig.status_code != 200, f"HTTP {orig.status_code}")
    rec("过期相册：本地文件未被删除", os.path.isdir(dir3) and len(os.listdir(os.path.join(dir3, "original"))) > 0)

    # 清掉测试相册
    api("DELETE", f"/events/{eid3}", tok)
    rec("测试用过期相册已清理", not os.path.exists(dir3))

    # ─────────────────────── 4. 共享文件过期 ───────────────────────
    print("\n=== 4. 过期共享文件：应当只屏蔽链接、不动本地文件 ===")
    up4 = api("POST", "/files/upload", tok,
              files=[("file", (f"exp_{ts}.txt", io.BytesIO(b"expire test"), "text/plain"))],
              data={"expire": 1}).json()
    fid4 = up4["data"]["file_id"]
    st4 = up4["data"]["share_token"]
    await db("UPDATE share_file SET expires_at=NOW() - INTERVAL 1 HOUR WHERE file_id=%s", (fid4,), fetch=False)
    info4 = requests.get(f"{API}/share/files/{st4}", timeout=20).json()
    dl4 = requests.get(f"{API}/share/files/{st4}/download", timeout=30)
    rec("过期共享文件：落地文件仍在", os.path.exists(os.path.join(FILES_DIR, fid4)))
    rec("过期共享文件：下载被拦截", dl4.status_code != 200 or '"code":0' not in dl4.text,
        f"HTTP {dl4.status_code}")
    rec("过期共享文件：分享页 info 被拦截", info4.get("code") not in (0, None),
        f"code={info4.get('code')}")
    api("DELETE", f"/files/{fid4}", tok)

    # ─────────────────────── 5. storage_path 失效时能否删干净 ───────────────────────
    print("\n=== 5. 记录里的本地路径失效（项目改名/搬迁）时，删除是否仍清干净 ===")
    up5 = api("POST", "/files/upload", tok,
              files=[("file", (f"stale_{ts}.txt", io.BytesIO(b"stale path"), "text/plain"))],
              data={"expire": 0}).json()
    fid5 = up5["data"]["file_id"]
    await db("UPDATE share_file SET storage_path=%s WHERE file_id=%s",
             (f"/home/dancehole/project/activity-image-list/backend/storage/files/{fid5}", fid5),
             fetch=False)
    api("DELETE", f"/files/{fid5}", tok)
    left = os.path.exists(os.path.join(FILES_DIR, fid5))
    rec("storage_path 失效时本地文件仍被删除", not left,
        "" if not left else f"孤儿未删: {os.path.join(FILES_DIR, fid5)}")

    await close_pool()

    print("\n" + "=" * 64)
    bad = [r for r in RESULTS if not r[1]]
    print(f"结果: {len(RESULTS) - len(bad)}/{len(RESULTS)} 通过")
    for n, _ok, d in bad:
        print("  FAIL:", n, "—", d)
    print("=" * 64)


asyncio.run(main())
