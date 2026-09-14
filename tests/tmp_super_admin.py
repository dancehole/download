"""临时超管账号管理（仅用于 E2E 测试）：
用法:
  venv/bin/python tests/tmp_super_admin.py create <username> <password>
  venv/bin/python tests/tmp_super_admin.py delete <username>
直接读写 photographer 表，复用项目自身的 DB 配置（不打印任何凭据）。
"""
import asyncio
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(BACKEND / ".env")

from app.db import get_pool, close_pool  # noqa: E402
from app.auth import hash_password  # noqa: E402


async def main(action: str, username: str, password: str = "") -> int:
    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                if action == "create":
                    await cur.execute("DELETE FROM photographer WHERE username=%s", (username,))
                    await cur.execute(
                        "INSERT INTO photographer (username, password_hash, role, is_active) "
                        "VALUES (%s, %s, 'super', 1)",
                        (username, hash_password(password)),
                    )
                    print(f"created super admin: {username}")
                elif action == "delete":
                    await cur.execute("DELETE FROM photographer WHERE username=%s", (username,))
                    print(f"deleted: {username} (rows={cur.rowcount})")
                else:
                    print("usage: tmp_super_admin.py create|delete <username> [password]")
                    return 2
    finally:
        await close_pool()
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")))
