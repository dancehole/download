import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, Response

from .config import FRONTEND_DIR, CORS_ORIGINS, STORAGE_DIR, APP_PREFIX
from .db import init_db, close_pool
from .routers import auth, events, upload, share, settings as settings_router
from .response import ok
from . import oss_service
from .models import get_setting


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(STORAGE_DIR, exist_ok=True)
    await init_db()

    # 从数据库加载 OSS 配置
    oss_cfg = {}
    for key, field in [
        ("oss_enabled", "enabled"),
        ("oss_access_key_id", "access_key_id"),
        ("oss_access_key_secret", "access_key_secret"),
        ("oss_endpoint", "endpoint"),
        ("oss_bucket", "bucket"),
        ("oss_custom_domain", "custom_domain"),
        ("oss_sign_url_ttl", "sign_url_ttl"),
    ]:
        v = await get_setting(key)
        if v is not None:
            oss_cfg[field] = v
    if oss_cfg.get("enabled"):
        oss_cfg["enabled"] = str(oss_cfg["enabled"]).lower() in ("1", "true", "yes")
    oss_service.init_oss(oss_cfg)

    yield
    await close_pool()


app = FastAPI(title="活动照片流系统", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API 路由（带前缀）
p = APP_PREFIX
app.include_router(auth.router, prefix=p + "/api")
app.include_router(events.router, prefix=p + "/api")
app.include_router(upload.router, prefix=p + "/api")
app.include_router(share.router, prefix=p + "/api")
app.include_router(settings_router.router, prefix=p)


@app.get(p + "/api/health")
async def health():
    return ok({"status": "ok"})


# 前端静态资源（css/js/assets）
if os.path.isdir(FRONTEND_DIR):
    app.mount(p + "/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def _html_response(path: str):
    """返回 HTML 文件，禁用缓存确保每次拿到最新版本。"""
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    return Response(
        content=content,
        media_type="text/html",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get(p + "/admin")
async def admin_page():
    return _html_response(os.path.join(FRONTEND_DIR, "admin.html"))


@app.get(p + "/share/{token}")
async def share_page(token: str):
    return _html_response(os.path.join(FRONTEND_DIR, "gallery.html"))


@app.get(p + "/")
async def root():
    return RedirectResponse(url=p + "/admin", status_code=302)


# 无前缀时，根路径也跳转
if APP_PREFIX:
    @app.get("/")
    async def root_redirect():
        return RedirectResponse(url=APP_PREFIX + "/admin", status_code=302)
