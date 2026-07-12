import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse

from .config import FRONTEND_DIR, CORS_ORIGINS, STORAGE_DIR
from .db import init_db, close_pool
from .routers import auth, events, upload, share
from .response import ok


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(STORAGE_DIR, exist_ok=True)
    await init_db()
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

# API 路由
app.include_router(auth.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(upload.router, prefix="/api")
app.include_router(share.router, prefix="/api")


@app.get("/api/health")
async def health():
    return ok({"status": "ok"})


# 前端静态资源（css/js/assets）
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def _html_response(path: str):
    """返回 HTML 文件，禁用缓存确保每次拿到最新版本。"""
    return FileResponse(
        path,
        media_type="text/html",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/admin")
async def admin_page():
    return _html_response(os.path.join(FRONTEND_DIR, "admin.html"))


@app.get("/share/{token}")
async def share_page(token: str):
    return _html_response(os.path.join(FRONTEND_DIR, "gallery.html"))


@app.get("/")
async def root():
    return RedirectResponse(url="/admin", status_code=302)
