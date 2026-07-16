# OSS 防盗链与签名 URL 说明

> 解决阿里云 OSS「存储桶公有读」安全告警，在不影响观众正常浏览的前提下防止流量被盗刷。

---

## 一、问题背景

此前系统将 OSS Bucket 设为 **public-read（公有读）**，前端直接通过公开 URL 访问图片：

```
https://{bucket}.{endpoint}/{key}
https://{custom_domain}/{key}
```

这意味着：

1. **阿里云会持续告警**——存储桶设置了公有读权限且未开启阻止公共访问。
2. **任何人抓到该 URL 即可绕过 share token 无限刷图**，20GB/天的流量额度可能数小时被薅光。
3. 图片地址暴露在浏览器中，可被轻易批量爬取、外链盗用。

---

## 二、解决方案：私有 Bucket + 签名 URL

### 核心思路

| 项 | 改造前 | 改造后 |
|----|--------|--------|
| Bucket 权限 | public-read（公有读） | **private（私有）** |
| 图片访问方式 | 公开直链，永久有效 | **签名 URL，带有效期** |
| 盗链风险 | 任何人可刷 | 过期/伪造链接被 OSS 拒绝（403） |
| 观众体验 | 直接看图 | 直接看图（无感） |
| 是否需要登录 | 否 | **否** |

### 工作流程

```
观众打开分享链接 /share/{token}
        │
        ▼
后端校验 share token 是否有效
        │ 有效
        ▼
后端用 AccessKey 生成签名 URL（有效期 N 秒）
        │
        ▼
前端用签名 URL 加载图片 <img src="...?Signature=...&Expires=...">
        │
        ▼
OSS 校验签名 + 有效期 ──→ 通过：200 返回图片
                     └─→ 失败：403 拒绝（过期/伪造/盗链）
```

**关键点**：签名 URL 的签名由 AccessKey Secret 计算，包含有效期（Expires）。URL 过期后自动失效，盗链者拿到的旧链接变为 403，无法继续刷流量。

---

## 三、OSS 控制台配置步骤

### 步骤 1：将 Bucket 权限改为私有

1. 登录 [OSS 管理控制台](https://oss.console.aliyun.com/)。
2. 进入目标 Bucket → **权限管理** → **Bucket 授权策略**。
3. 将读写权限改为 **私有（private）**。
4. 保存。

### 步骤 2：开启阻止公共访问（推荐）

1. 同一页面，找到 **阻止公共访问** 设置。
2. 开启 **阻止公共访问** 开关。
3. 开启后，即使误配了 Bucket Policy 或 ACL 为公共读，OSS 也会拒绝匿名访问，相当于多一道保险。

### 步骤 3：确认 AccessKey 权限

系统使用的 AccessKey 需具备该 Bucket 的读写权限。推荐通过 **RAM 用户** + **RAM Policy** 精确授权，而非使用主账号 AccessKey。

最小化权限策略示例：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:DeleteObject",
        "oss:ListObjects"
      ],
      "Resource": [
        "acs:oss:*:*:{bucket-name}",
        "acs:oss:*:*:{bucket-name}/*"
      ]
    }
  ]
}
```

> 将 `{bucket-name}` 替换为你的 Bucket 名称。这样即使 AccessKey 泄露，影响范围也仅限此 Bucket。

---

## 四、系统配置

### 后台设置

在摄影师后台 → **设置** → **OSS 存储设置** 中，新增了 **签名 URL 有效期（秒）** 配置项：

| 配置项 | 说明 | 默认值 | 范围 |
|--------|------|--------|------|
| 签名 URL 有效期 | 签名 URL 的有效时长，过期后链接失效 | 3600（1 小时） | 60 - 86400 |

**建议取值**：

- **3600（1 小时）**：适合大多数场景，观众一次浏览会话通常不超过 1 小时。
- **7200（2 小时）**：如果观众浏览时间较长或网络较慢，可适当延长。
- **不建议超过 4 小时**：有效期越长，被盗链的窗口越大。

> 如果观众页面停留超过有效期，图片加载失败时会 **自动降级到本地服务器**（已有降级机制），不会出现白屏。刷新页面会重新获取新的签名 URL。

### 代码实现

签名 URL 功能涉及以下文件：

| 文件 | 改动 |
|------|------|
| `backend/app/oss_service.py` | 新增 `sign_url()` 函数，基于 `oss2.Bucket.sign_url()` 生成带有效期的签名 URL |
| `backend/app/response.py` | `photo_to_dict()` 中 preview / original / raf 的 OSS URL 从 `get_url()` 改为 `sign_url()` |
| `backend/app/routers/settings.py` | 新增 `sign_url_ttl` 配置的读写，保存到数据库 |
| `backend/app/main.py` | 启动时从数据库加载 `sign_url_ttl` |
| `frontend/admin.html` | 新增「签名 URL 有效期」输入框 |
| `frontend/js/admin.js` | 加载 / 保存签名有效期配置 |
| `frontend/js/i18n.js` | 新增中英文翻译 |

### 前端无需改动

签名 URL 是以 `https://` 开头的绝对地址，前端 `API.url()` 会识别绝对地址直接使用，降级逻辑（fallback 到本地服务器 URL）不受影响。

---

## 五、签名 URL 与 CDN 自定义域名

如果配置了自定义域名（CDN），签名 URL 会自动将默认 OSS host 替换为自定义域名：

```
原始签名 URL：
https://{bucket}.{endpoint}/{key}?OSSAccessKeyId=...&Expires=...&Signature=...

替换后：
https://{custom_domain}/{key}?OSSAccessKeyId=...&Expires=...&Signature=...
```

**原理**：OSS V1 签名基于 HTTP 方法、资源路径（`/{bucket}/{key}`）和参数计算，**不包含 host**。因此将 host 替换为 CDN 域名后，CDN 透传回源时 OSS 依然能验证签名通过。

**CDN 缓存说明**：同一张图在同一有效期内生成的签名 URL 是相同的（Expires 时间戳相同 → 签名相同），CDN 可以正常缓存。有效期过后签名 URL 变化，CDN 会回源获取新内容。

---

## 六、补充防御层（可选，按需开启）

签名 URL 已提供强力的防盗链保护。如需进一步加固，可叠加以下措施：

### 1. Referer 防盗链（OSS 控制台）

在 Bucket → **数据安全** → **防盗链** 中配置 Referer 白名单：

- **白名单 Referer**：填入你的域名，如 `https://dancehole.cn`、`https://*.dancehole.cn`
- **允许空 Referer**：建议**关闭**（浏览器直接输入 URL 时 Referer 为空，关闭可阻止此类访问）

> Referer 可被伪造，防盗链强度中等，适合作为签名 URL 之外的第二道防线。

### 2. CDN URL 鉴权（使用 CDN 时）

如果在阿里云 CDN 控制台使用了 CDN 加速，可在 CDN → **域名管理** → **访问控制** → **URL 鉴权** 中开启：

- **鉴权方式**：推荐 Type A（与 OSS 签名 URL 类似）
- **鉴权方式 A 配置**：设置主 KEY、有效期

开启后，CDN 节点会验证 URL 鉴权参数，未通过鉴权的请求直接在 CDN 边缘被拒绝，不会回源到 OSS。

> ⚠️ 如果同时开启了 CDN URL 鉴权和 OSS 签名 URL，需要确保两者参数兼容。通常二选一即可：Bucket 私有 + CDN 鉴权，或 Bucket 私有 + OSS 签名 URL。

### 3. 流量告警与额度限制

- **OSS 流量告警**：在 OSS 控制台 → **Bucket 概览** → 设置流量阈值告警，异常流量时第一时间收到通知。
- **CDN 流量包**：购买 CDN 流量包并设置用量上限，超出自动停用，防止流量超支。
- **带宽限速**：CDN 控制台可设置单域名带宽上限。

---

## 七、常见问题

### Q: 改成 private 后，之前已上传的图片还能访问吗？

能。已上传的图片 Object 仍在 Bucket 中，只是访问方式从公开直链变为签名 URL。系统会在返回图片列表时自动为每个图片生成签名 URL，无需重新上传。

### Q: 签名 URL 过期了怎么办？

观众页面停留超过有效期时，图片加载会失败（403），系统会 **自动降级到本地服务器** 加载。观众刷新页面后，后端会重新生成新的签名 URL。可适当调大有效期（如 7200 秒）减少此情况。

### Q: 签名 URL 会被搜索引擎收录吗？

不会。签名 URL 包含动态参数（Expires、Signature），每次生成的 URL 不同，搜索引擎不会将其作为稳定链接收录。

### Q: 使用 CDN 后签名 URL 还有效吗？

有效。签名不包含 host，CDN 域名替换后回源到 OSS 时签名依然通过验证。详见上文「签名 URL 与 CDN 自定义域名」。

### Q: 为什么不直接给观众加登录系统？

1. 观众通过 share token 访问，体验是「点开链接即看图」，加登录会劝退用户。
2. 登录只控制「谁能进相册」，无法阻止 OSS 直链被盗链。签名 URL 才是从源头解决盗链的方案。
3. share token 本身已是访问凭证，后端校验 token 后才签发 URL，无需额外用户体系。

---

## 八、快速检查清单

部署后请逐项确认：

- [ ] OSS Bucket 读写权限已改为 **私有（private）**
- [ ] 已开启 **阻止公共访问**
- [ ] 后台设置中填写了 **签名 URL 有效期**（默认 3600 秒）
- [ ] AccessKey 使用 RAM 子账号，仅授权目标 Bucket 权限
- [ ] 打开分享链接，图片正常显示（确认签名 URL 生效）
- [ ] 浏览器中图片 URL 包含 `Signature` 和 `Expires` 参数
- [ ] （可选）已配置 Referer 防盗链白名单
- [ ] （可选）已设置 OSS 流量告警阈值
