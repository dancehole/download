import aiomysql
from .config import (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
                     DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASSWORD)
from .auth import hash_password

_pool = None


async def get_pool():
    global _pool
    if _pool is None:
        _pool = await aiomysql.create_pool(
            host=DB_HOST, port=DB_PORT, user=DB_USER,
            password=DB_PASSWORD, db=DB_NAME,
            minsize=2, maxsize=8, autocommit=True,
            charset="utf8mb4", cursorclass=aiomysql.DictCursor,
        )
    return _pool


async def close_pool():
    global _pool
    if _pool is not None:
        _pool.close()
        await _pool.wait_closed()
        _pool = None


async def init_db():
    # 先连接服务器创建数据库（若不存在）
    conn = await aiomysql.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD
    )
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                f"CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
    finally:
        conn.close()

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS photographer (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(64) NOT NULL UNIQUE,
                    password_hash VARCHAR(128) NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS event (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    event_id VARCHAR(16) NOT NULL UNIQUE,
                    event_name VARCHAR(128) NOT NULL,
                    photo_count INT NOT NULL DEFAULT 0,
                    share_token VARCHAR(32) NOT NULL UNIQUE,
                    created_by INT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_created_by (created_by),
                    CONSTRAINT fk_event_photographer
                        FOREIGN KEY (created_by) REFERENCES photographer(id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS photo (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    event_id INT NOT NULL,
                    tag VARCHAR(64) DEFAULT NULL,
                    tag_en VARCHAR(64) DEFAULT NULL,
                    filename VARCHAR(255) NOT NULL,
                    original_path VARCHAR(512) NOT NULL,
                    preview_path VARCHAR(512) NOT NULL,
                    raf_path VARCHAR(512) DEFAULT NULL,
                    taken_at DATETIME DEFAULT NULL,
                    uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_event_tag (event_id, tag),
                    INDEX idx_event_taken (event_id, taken_at),
                    CONSTRAINT fk_photo_event
                        FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 兼容已存在的数据库：若缺 tag_en 列则自动追加
            try:
                await cur.execute(
                    "ALTER TABLE photo ADD COLUMN tag_en VARCHAR(64) DEFAULT NULL AFTER tag"
                )
            except Exception:
                pass  # 列已存在
        await conn.commit()

    # 确保默认摄影师存在
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT id FROM photographer WHERE username=%s", (DEFAULT_ADMIN_USER,))
            row = await cur.fetchone()
            if not row:
                await cur.execute(
                    "INSERT INTO photographer (username, password_hash) VALUES (%s, %s)",
                    (DEFAULT_ADMIN_USER, hash_password(DEFAULT_ADMIN_PASSWORD)),
                )
            await conn.commit()
