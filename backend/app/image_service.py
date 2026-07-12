import asyncio
from datetime import datetime
from PIL import Image
from .config import PREVIEW_MAX_SIZE, PREVIEW_QUALITY, IMAGE_PROCESS_CONCURRENCY

_sem = asyncio.Semaphore(IMAGE_PROCESS_CONCURRENCY)

# EXIF DateTimeOriginal 标签号
_EXIF_DATETIME_ORIGINAL = 36867


def _process_image(src: str, dst: str):
    """同步处理：压缩为 480p 预览并提取拍摄时间。返回 taken_at 或 None。"""
    with Image.open(src) as img:
        # 提取 EXIF 拍摄时间
        taken_at = None
        try:
            exif = img.getexif()
            if exif:
                dto = exif.get(_EXIF_DATETIME_ORIGINAL)
                if dto:
                    taken_at = datetime.strptime(dto, "%Y:%m:%d %H:%M:%S")
        except Exception:
            taken_at = None

        # 压缩为预览图
        rgb = img.convert("RGB")
        w, h = rgb.size
        scale = PREVIEW_MAX_SIZE / max(w, h)
        if scale < 1:
            rgb = rgb.resize(
                (max(1, int(w * scale)), max(1, int(h * scale))),
                Image.LANCZOS,
            )
        rgb.save(dst, "JPEG", quality=PREVIEW_QUALITY, optimize=True)
        return taken_at


async def process_image(src: str, dst: str):
    """异步入口：在线程池中串行处理，受信号量限制以控制内存峰值。"""
    async with _sem:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _process_image, src, dst)
