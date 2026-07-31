# 活动照片流展示与下载系统

大型活动照片即时展示与下载平台，支持摄影师批量上传、多活动管理、分享链接分发、OSS/CDN 加速、中英文切换。

## 功能特性

### 摄影师后台
- 📋 **活动管理**：创建活动、生成分享链接、重新生成链接、删除相册（二次确认）
- 📤 **批量上传**：拖拽上传 JPG 照片 + RAF 底片，自动生成压缩预览图
- 🏷️ **标签管理**：每张照片支持中英文标签，可按标签筛选
- ⚙️ **相册设置**：每相册独立配置缩略图尺寸（480px / 640px / 800px）、是否使用 OSS 存储
- ☁️ **OSS 集成**：阿里云 OSS 存储 + CDN 加速，可按相册独立开关
- 🌐 **多语言**：中英文一键切换
- 📄 **共享文件**（下载中心合并）：新建共享文件/共享相册二选一，单文件分享链接，支持过期时间（1小时~30天/永不过期），文件同样支持 OSS 存储与签名 URL 防盗链

### 前端展示页
- 📸 **照片瀑布流**：响应式 Grid 布局，手机 2 列 / 平板 3 列 / PC 4 列
- 🔍 **灯箱预览**：点击放大、双击缩放、左右切换、键盘操作
- 🏷️ **标签筛选**：顶部标签栏快速筛选，支持中英文
- 💾 **多格式下载**：原图下载、缩略图查看、RAF 底片下载
- 📱 **移动端优先**：手势滑动切换、双击缩放、触摸拖拽平移
- 🌐 **中英文切换**：界面语言一键切换
- ⚡ **OSS 降级**：OSS 优先加载，失败自动回退到本地服务器

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.10+ / FastAPI / Uvicorn |
| 数据库 | MySQL 8.0+ (aiomysql 异步驱动) |
| 图片处理 | Pillow (LANCZOS 高质量缩放) |
| 认证 | JWT (PyJWT) + bcrypt 密码哈希 |
| 对象存储 | 阿里云 OSS (oss2) |
| 前端 | 原生 HTML5 + CSS3 + JavaScript (无框架依赖) |

## 快速开始

### 环境要求
- Python 3.10+
- MySQL 5.7+ 或 8.0+
- （可选）阿里云 OSS 账号 + 自定义 CDN 域名

### 一键启动（Windows）

```bat
cd backend
install.bat    :: 安装依赖（首次运行）
start.bat      :: 启动服务
```

### 手动启动

```bash
# 1. 进入后端目录
cd backend

# 2. 创建虚拟环境并安装依赖
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt

# 3. 配置环境变量（可选）
copy .env.example .env
# 编辑 .env 修改数据库配置等

# 4. 启动服务
python -m uvicorn app.main:app --host 0.0.0.0 --port 8765
```

### 访问地址

| 页面 | 地址 |
|------|------|
| 摄影师后台 | http://127.0.0.1:8765/admin |
| 相册分享页 | http://127.0.0.1:8765/share/{token} |
| 文件分享页 | http://127.0.0.1:8765/share/files/{token} |
| 健康检查 | http://127.0.0.1:8765/api/health |

默认账号：`admin` / `admin123`

## 目录结构

```
activity-imageList/
├── backend/
│   ├── app/
│   │   ├── routers/       # API 路由
│   │   │   ├── auth.py    # 登录认证
│   │   │   ├── events.py  # 活动 CRUD
│   │   │   ├── upload.py  # 照片上传
│   │   │   ├── share.py   # 分享页接口
│   │   │   ├── files.py   # 共享文件（下载中心合并）
│   │   │   └── settings.py # OSS 等设置
│   │   ├── auth.py        # JWT 认证中间件
│   │   ├── config.py      # 配置项
│   │   ├── db.py          # 数据库连接 + 建表
│   │   ├── image_service.py # 图片压缩
│   │   ├── oss_service.py # OSS 上传下载
│   │   ├── models.py      # 数据模型
│   │   ├── response.py    # 统一响应格式
│   │   └── main.py        # FastAPI 入口
│   ├── storage/           # 本地照片存储（运行时生成）
│   │   └── files/         # 共享文件存储（运行时生成）
│   ├── migrate_download_center.py  # 下载中心历史数据迁移脚本（一次性）
│   ├── test_assets/       # 测试用照片
│   ├── requirements.txt   # Python 依赖
│   ├── install.bat        # Windows 安装脚本
│   ├── start.bat          # Windows 启动脚本
│   └── .env.example       # 环境变量示例
├── frontend/
│   ├── css/
│   │   ├── admin.css      # 后台样式
│   │   └── gallery.css    # 展示页样式
│   ├── js/
│   │   ├── admin.js       # 后台逻辑
│   │   ├── gallery.js     # 展示页逻辑
│   │   ├── api.js         # API 封装
│   │   └── i18n.js        # 国际化
│   ├── admin.html         # 摄影师后台
│   ├── gallery.html       # 展示页（相册）
│   └── file.html          # 展示页（共享文件下载）
├── .gitignore
└── README.md
```

## OSS 配置说明

1. 登录摄影师后台，进入「设置」
2. 勾选「启用 OSS 存储」，填写：
   - AccessKey ID / Secret
   - Endpoint 地域节点（如 `oss-cn-guangzhou.aliyuncs.com`）
   - Bucket 名称
   - 自定义 CDN 域名（可选）
3. 点击「测试连接」验证配置
4. 点击「保存设置」

> OSS 配置完成后，可在每个相册的设置中独立选择是否启用 OSS。

> **安全提示**：请将 OSS Bucket 权限设为 **private** 并开启阻止公共访问，系统会通过签名 URL（带有效期）提供图片访问，防止流量被盗刷。签名 URL 有效期可在后台「OSS 存储设置」中配置。详见 [OSS 防盗链与签名 URL 说明](docs/OSS防盗链与签名URL说明.md)。

## 缩略图尺寸与流量参考

| 尺寸 | 单张预估值 | 1000张总量 | 100人/次访问 | 备注 |
|------|-----------|-----------|------------|------|
| 480px | ~35KB | ~35MB | ~3.5GB | 省流量，推荐大流量场景 |
| 640px | ~70KB | ~70MB | ~7GB | 默认，质量与流量平衡 |
| 800px | ~120KB | ~120MB | ~12GB | 高清，流量消耗较高 |

> 以上为估算值，实际流量因图片内容而异。OSS 流量限制 20GB/天时，640px 约可支持 280 人次/天的完整浏览。

## 共享文件（下载中心合并）

本系统已合并原「下载中心」（download-center）的文件上传/分享功能，后台可二选一新建 **共享相册** 或 **共享文件**：

1. 后台点击「新建」，选择「新建共享文件」
2. 选择文件、设置过期时间（1 小时 ~ 30 天 / 永不过期），点击上传
3. 上传成功后自动复制分享链接，链接形式：`/share/files/{token}`
4. 文件列表支持：复制链接、打开分享页、重新生成链接（旧链接立即失效）、删除

要点：
- 启用 OSS 后，共享文件自动镜像到 OSS（`files/{file_id}` 前缀），下载时返回带有效期的签名 URL（防盗链 + 自动失效）
- 迁移自旧 download-center 的文件（`oss_key` 为空）走本地直传下载，可后续回填 OSS
- OSS 不可用（如 Bucket 缺失）时自动降级为本地存储，不阻塞上传/下载
- 单文件上限默认 500MB（`FILE_MAX_UPLOAD_SIZE_MB`，需同时调整 nginx `client_max_body_size`）

历史数据迁移：`backend/migrate_download_center.py`（一次性脚本，读取旧 SQLite 数据库并复制文件）。

## 部署

详见 `docs/部署文档.doc` 和 `docs/使用说明文档.doc`。

## TODO / 后续计划

### CDN 加速与回源配置

当前 OSS 直接对外提供签名 URL，可进一步通过 CDN 加速提升访问速度并节省 OSS 外网流量费用。

#### 推荐架构

```
用户请求 → CDN 边缘节点（https://cdn.dancehole.cn）
              ↕ 命中缓存则直接响应
              ↕ 未命中则私有回源
           阿里云 OSS 私有 Bucket
```

#### 配置步骤（阿里云）

1. **开通 CDN 服务**（阿里云 CDN / 全站加速 DCDN）
2. **添加加速域名**，如 `cdn.dancehole.cn`，源站类型选择「OSS 域名」
3. **OSS 私有 Bucket 回源**：开启「私有 Bucket 回源」，CDN 用阿里云内网回源获取文件，不消耗 OSS 外网流量
4. **HTTPS 配置**：在 CDN 上绑定 SSL 证书（Let's Encrypt），启用 HTTPS
5. **CNAME**：将 `cdn.dancehole.cn` CNAME 指向 CDN 加速域名
6. **更新系统设置**：在后台「OSS 存储设置」中将「自定义 CDN 域名」设为 `cdn.dancehole.cn`

#### 成本与收益

| 项目 | 纯 OSS 直连 | OSS + CDN |
|------|------------|-----------|
| 流量费用 | OSS 外网流量 0.5元/GB | CDN 流量 0.2~0.3元/GB |
| 回源流量 | — | 内网回源免费（同地域） |
| 延迟 | 50-200ms | 10-50ms（缓存命中） |
| HTTPS | 需额外配置 | CDN 统一管理 |
| DDoS 防护 | 需额外购买 | CDN 原生防护 |

### 历史照片回填 OSS

系统现有照片若在启用 OSS 前上传，数据库中缺少 `oss_preview_key` / `oss_original_key`，仍需通过后端服务器提供。后续可编写回填脚本，将本地存储的预览图和原图批量上传至 OSS 并更新数据库。

## License

MIT
