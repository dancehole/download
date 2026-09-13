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
                    role VARCHAR(16) NOT NULL DEFAULT 'album',
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 兼容已存在的数据库：photographer 增加角色与启用状态
            # role: super = 超级管理员（全部相册 + 共享文件 + 用户管理）；album = 相册管理员（仅被授权相册）
            for col_def in [
                "ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'album' AFTER password_hash",
                "ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER role",
            ]:
                try:
                    await cur.execute(f"ALTER TABLE photographer {col_def}")
                except Exception:
                    pass
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS event (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    event_id VARCHAR(16) NOT NULL UNIQUE,
                    event_name VARCHAR(128) NOT NULL,
                    photo_count INT NOT NULL DEFAULT 0,
                    share_token VARCHAR(32) NOT NULL UNIQUE,
                    preview_size INT NOT NULL DEFAULT 640,
                    use_oss TINYINT(1) NOT NULL DEFAULT 1,
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
            # 兼容已存在的数据库：若 event 缺 preview_size 和 use_oss 列则自动追加
            for col_def in [
                "ADD COLUMN preview_size INT NOT NULL DEFAULT 640 AFTER share_token",
                "ADD COLUMN use_oss TINYINT(1) NOT NULL DEFAULT 1 AFTER preview_size",
            ]:
                try:
                    await cur.execute(f"ALTER TABLE event {col_def}")
                except Exception:
                    pass

            # 兼容已存在的数据库：若缺 tag_en 列则自动追加
            try:
                await cur.execute(
                    "ALTER TABLE photo ADD COLUMN tag_en VARCHAR(64) DEFAULT NULL AFTER tag"
                )
            except Exception:
                pass  # 列已存在

            await cur.execute("""
                CREATE TABLE IF NOT EXISTS setting (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    setting_key VARCHAR(64) NOT NULL UNIQUE,
                    setting_value TEXT,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            # 兼容已存在的数据库：若 photo 缺 oss_ 列则自动追加
            for col_def in [
                "ADD COLUMN oss_original_key VARCHAR(512) DEFAULT NULL AFTER preview_path",
                "ADD COLUMN oss_preview_key VARCHAR(512) DEFAULT NULL AFTER oss_original_key",
                "ADD COLUMN oss_raf_key VARCHAR(512) DEFAULT NULL AFTER oss_preview_key",
            ]:
                try:
                    await cur.execute(f"ALTER TABLE photo {col_def}")
                except Exception:
                    pass

            # 共享文件（下载中心合并而来）
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS share_file (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    file_id VARCHAR(20) NOT NULL UNIQUE,
                    original_filename VARCHAR(255) NOT NULL,
                    file_size BIGINT NOT NULL,
                    mime_type VARCHAR(128) DEFAULT '',
                    storage_path VARCHAR(512) DEFAULT '',
                    oss_key VARCHAR(512) DEFAULT NULL,
                    share_token VARCHAR(32) NOT NULL UNIQUE,
                    created_by INT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    expires_at DATETIME DEFAULT NULL,
                    download_count INT NOT NULL DEFAULT 0,
                    view_count INT NOT NULL DEFAULT 0,
                    purged_at DATETIME DEFAULT NULL,
                    INDEX idx_created_by (created_by),
                    CONSTRAINT fk_sharefile_photographer
                        FOREIGN KEY (created_by) REFERENCES photographer(id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            # 兼容已存在的数据库：event 的过期清理与计数字段
            for col_def in [
                "ADD COLUMN expires_at DATETIME DEFAULT NULL AFTER use_oss",
                "ADD COLUMN purged_at DATETIME DEFAULT NULL AFTER expires_at",
                "ADD COLUMN local_cleared_at DATETIME DEFAULT NULL AFTER purged_at",
                "ADD COLUMN oss_cleared_at DATETIME DEFAULT NULL AFTER local_cleared_at",
                "ADD COLUMN view_count INT NOT NULL DEFAULT 0 AFTER oss_cleared_at",
                "ADD COLUMN download_count INT NOT NULL DEFAULT 0 AFTER view_count",
            ]:
                try:
                    await cur.execute(f"ALTER TABLE event {col_def}")
                except Exception:
                    pass

            # 兼容已存在的数据库：share_file 的访问次数与清理标记
            for col_def in [
                "ADD COLUMN view_count INT NOT NULL DEFAULT 0 AFTER download_count",
                "ADD COLUMN purged_at DATETIME DEFAULT NULL AFTER view_count",
            ]:
                try:
                    await cur.execute(f"ALTER TABLE share_file {col_def}")
                except Exception:
                    pass

            # 相册管理员授权表（账号 ↔ 相册 多对多）
            # 一个账号可被授权多个相册；一个相册也可有多个管理员账号。
            # 相册被删除时授权行自动级联清理。
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS album_admin_acl (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    photographer_id INT NOT NULL,
                    event_id INT NOT NULL,
                    granted_by INT DEFAULT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_acl_admin_event (photographer_id, event_id),
                    INDEX idx_acl_event (event_id),
                    CONSTRAINT fk_acl_photographer
                        FOREIGN KEY (photographer_id) REFERENCES photographer(id) ON DELETE CASCADE,
                    CONSTRAINT fk_acl_event
                        FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            # 加速过期扫描
            for idx_sql, idx_name in [
                ("ALTER TABLE event ADD INDEX idx_event_expiry (expires_at, purged_at)",
                 "idx_event_expiry"),
                ("ALTER TABLE share_file ADD INDEX idx_sharefile_expiry (expires_at, purged_at)",
                 "idx_sharefile_expiry"),
            ]:
                try:
                    await cur.execute(idx_sql)
                except Exception:
                    pass  # 索引已存在
        await conn.commit()

    # 确保默认摄影师存在
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT id FROM photographer WHERE username=%s", (DEFAULT_ADMIN_USER,))
            row = await cur.fetchone()
            if not row:
                await cur.execute(
                    "INSERT IGNORE INTO photographer (username, password_hash, role, is_active) "
                    "VALUES (%s, %s, 'super', 1)",
                    (DEFAULT_ADMIN_USER, hash_password(DEFAULT_ADMIN_PASSWORD)),
                )
            # 默认超管账号固定为超级管理员
            await cur.execute(
                "UPDATE photographer SET role='super', is_active=1 WHERE username=%s",
                (DEFAULT_ADMIN_USER,),
            )
            # 兜底：库里必须至少有一个可用的超级管理员
            await cur.execute(
                "SELECT COUNT(*) AS c FROM photographer WHERE role='super' AND is_active=1"
            )
            if (await cur.fetchone())["c"] == 0:
                await cur.execute(
                    "UPDATE photographer SET role='super', is_active=1 ORDER BY id ASC LIMIT 1"
                )
            await conn.commit()
