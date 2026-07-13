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
| 分享页 | http://127.0.0.1:8765/share/{token} |
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
│   └── gallery.html       # 展示页
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

## 缩略图尺寸与流量参考

| 尺寸 | 单张预估值 | 1000张总量 | 100人/次访问 | 备注 |
|------|-----------|-----------|------------|------|
| 480px | ~35KB | ~35MB | ~3.5GB | 省流量，推荐大流量场景 |
| 640px | ~70KB | ~70MB | ~7GB | 默认，质量与流量平衡 |
| 800px | ~120KB | ~120MB | ~12GB | 高清，流量消耗较高 |

> 以上为估算值，实际流量因图片内容而异。OSS 流量限制 20GB/天时，640px 约可支持 280 人次/天的完整浏览。

## 部署

详见 `docs/部署文档.doc` 和 `docs/使用说明文档.doc`。

## License

MIT
