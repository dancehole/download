import os
from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

load_dotenv(os.path.join(BASE_DIR, ".env"))

PROJECT_DIR = os.path.dirname(BASE_DIR)
FRONTEND_DIR = os.path.join(PROJECT_DIR, "frontend")
STORAGE_DIR = os.path.join(BASE_DIR, "storage")
FILES_DIR = os.path.join(STORAGE_DIR, "files")

# 数据库配置（可通过环境变量覆盖，或直接修改此处默认值）
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "photo_gallery")

# JWT 配置
JWT_SECRET = os.getenv("JWT_SECRET", "photo-gallery-secret-change-me-to-a-long-random-string")
JWT_ALG = "HS256"
JWT_EXPIRE_HOURS = 72

# 图片处理（内存控制）
PREVIEW_MAX_SIZE = 640          # 480p 预览图最长边像素
PREVIEW_QUALITY = 85            # JPEG 压缩质量
IMAGE_PROCESS_CONCURRENCY = 2   # 并发压缩数限制，避免内存峰值

# 上传限制
MAX_UPLOAD_SIZE_MB = 50         # 单文件上限（照片）
FILE_MAX_UPLOAD_SIZE_MB = int(os.getenv("FILE_MAX_UPLOAD_SIZE_MB", "500"))  # 共享文件上限

# 默认摄影师账号（启动时若不存在则自动创建）
DEFAULT_ADMIN_USER = os.getenv("DEFAULT_ADMIN_USER", "admin")
DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "admin123")

# CORS
CORS_ORIGINS = ["*"]

# 应用路径前缀（用于子目录部署，如 /download）
# 可通过环境变量 APP_PREFIX 设置，默认空字符串（根路径部署）
def _normalize_prefix(p):
    if not p:
        return ""
    p = p.strip()
    if not p or p == "/":
        return ""
    if not p.startswith("/"):
        p = "/" + p
    if p.endswith("/"):
        p = p[:-1]
    return p

APP_PREFIX = _normalize_prefix(os.getenv("APP_PREFIX", ""))
