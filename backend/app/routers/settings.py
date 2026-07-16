from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from ..auth import current_photographer
from ..models import get_setting, set_setting
from .. import oss_service

router = APIRouter(prefix="/api/admin/settings", tags=["settings"])


class OssConfig(BaseModel):
    enabled: bool = False
    access_key_id: str = ""
    access_key_secret: str = ""
    endpoint: str = ""
    bucket: str = ""
    custom_domain: str = ""
    sign_url_ttl: int = 3600


@router.get("/oss")
async def get_oss_settings(user=Depends(current_photographer)):
    keys = ["oss_enabled", "oss_access_key_id", "oss_access_key_secret",
            "oss_endpoint", "oss_bucket", "oss_custom_domain", "oss_sign_url_ttl"]
    vals = {}
    for k in keys:
        v = await get_setting(k)
        vals[k] = v if v is not None else ""
    return {
        "code": 0,
        "data": {
            "enabled": str(vals["oss_enabled"]).lower() in ("1", "true", "yes"),
            "access_key_id": vals["oss_access_key_id"],
            "access_key_secret_masked": "****" if vals["oss_access_key_secret"] else "",
            "endpoint": vals["oss_endpoint"],
            "bucket": vals["oss_bucket"],
            "custom_domain": vals["oss_custom_domain"],
            "sign_url_ttl": int(vals["oss_sign_url_ttl"]) if vals["oss_sign_url_ttl"] else 3600,
        }
    }


@router.put("/oss")
async def update_oss_settings(cfg: OssConfig, user=Depends(current_photographer)):
    current_secret = await get_setting("oss_access_key_secret") or ""
    new_secret = current_secret if cfg.access_key_secret == "" or cfg.access_key_secret == "****" else cfg.access_key_secret

    sign_ttl = max(60, min(int(cfg.sign_url_ttl or 3600), 86400))

    await set_setting("oss_enabled", "1" if cfg.enabled else "0")
    await set_setting("oss_access_key_id", cfg.access_key_id)
    await set_setting("oss_access_key_secret", new_secret)
    await set_setting("oss_endpoint", cfg.endpoint)
    await set_setting("oss_bucket", cfg.bucket)
    await set_setting("oss_custom_domain", cfg.custom_domain)
    await set_setting("oss_sign_url_ttl", str(sign_ttl))

    config = {
        "enabled": cfg.enabled,
        "access_key_id": cfg.access_key_id,
        "access_key_secret": new_secret,
        "endpoint": cfg.endpoint,
        "bucket": cfg.bucket,
        "custom_domain": cfg.custom_domain,
        "sign_url_ttl": sign_ttl,
    }
    oss_service.init_oss(config)

    return {
        "code": 0,
        "data": {
            "enabled": cfg.enabled,
            "access_key_id": cfg.access_key_id,
            "access_key_secret_masked": "****" if new_secret else "",
            "endpoint": cfg.endpoint,
            "bucket": cfg.bucket,
            "custom_domain": cfg.custom_domain,
            "sign_url_ttl": sign_ttl,
        }
    }


@router.post("/oss/test")
async def test_oss_connection(user=Depends(current_photographer)):
    if not oss_service.is_enabled():
        raise HTTPException(status_code=400, detail="OSS not enabled or not configured")
    try:
        from oss2.exceptions import OssError
        oss_service._bucket.get_bucket_info()
        return {"code": 0, "data": {"ok": True, "message": "连接成功"}}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"连接失败: {str(e)}")
