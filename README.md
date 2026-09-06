# JunDrive · Cloudflare 免费网盘

一个部署在 Cloudflare 上的个人网盘，**全部使用 Cloudflare 免费服务**，无需服务器：

| 组件 | 服务 | 免费额度（个人使用足够） |
| --- | --- | --- |
| 计算与 API | Cloudflare **Workers** | 10 万次请求/天 |
| 文件存储 | Cloudflare **R2** | 10 GB 存储/月，流量免费 |
| 元数据（文件树/分享/上传任务） | Cloudflare **D1** (SQLite) | 5 GB 存储，500 万行读/天 |
| 前端托管 | Workers **静态资源** | 免费、不限请求 |

## 功能

- 🔐 密码登录（单管理员，HMAC 签名会话 Cookie，失败限流）
- 📤 上传：单文件 / 整个文件夹（保留目录结构）/ 桌面拖拽；R2 分片上传，单文件最大 8 GB，失败自动重试、可取消
- 📥 下载：支持断点续传（HTTP Range），视频/音频可拖动进度条
- 📁 文件夹：新建、重命名、移动、递归删除；同名自动加 `(1)` 后缀
- 🔗 分享：公开链接，可选访问密码与有效期（1/7/30 天/永久），支持文件与整个文件夹；分享管理页可复制/撤销
- 👁 预览：图片、视频、音频、PDF、常见文本/代码（上传的 HTML/SVG 一律强制下载，杜绝存储型 XSS）
- 📱 UI：PC 与手机自适应（手机端底部 FAB 操作），自动深色模式，中文界面
- 🔍 全局搜索、列表/网格视图、按名称/大小/时间排序

## 一键部署

前提：一个 Cloudflare 账号，并已安装 Node.js ≥ 18。

```bash
npm install
npx wrangler login          # 浏览器授权

# 1. 创建免费资源（名称可自行修改，需与 wrangler.jsonc 保持一致）
npx wrangler r2 bucket create jun-drive-files
npx wrangler d1 create jun-drive-db
#    → 把输出的 database_id 填入 wrangler.jsonc 的 d1_databases[0].database_id

# 2. 初始化数据库表
npx wrangler d1 execute jun-drive-db --remote --file=schema.sql

# 3. 设置登录密码（会提示输入，勿提交到代码库）
npx wrangler secret put ADMIN_PASSWORD

# 4. 部署（含前端静态资源）
npx wrangler deploy
```

### 绑定自定义域名

`wrangler.jsonc` 中已配置：

```jsonc
"routes": [{ "pattern": "drive.junwind.site", "custom_domain": true }]
```

把域名换成你自己的（域名需已托管在该 Cloudflare 账号下），`wrangler deploy` 会自动创建 DNS 记录与证书，无需手动操作。

## 本地开发

```bash
npm run db:init:local        # 初始化本地 D1（首次）
npm run dev                  # http://127.0.0.1:8787 ，本地密码见 .dev.vars
npm test                     # API 集成测试（49 项，需 dev 服务运行中）
```

## 目录结构

```
├── wrangler.jsonc      # Cloudflare 配置（R2/D1/静态资源/自定义域名）
├── schema.sql          # D1 表结构
├── src/
│   ├── worker.js       # Worker 入口
│   ├── api.js          # 全部 API 路由
│   └── auth.js         # 会话/口令/限流
├── public/             # 前端 SPA（无构建，直接托管）
│   ├── index.html
│   ├── app.js          # 网盘主应用
│   ├── share.js        # 公开分享页 /s/<token>
│   ├── common.js       # 公共工具
│   └── style.css
└── tests/api-test.sh   # API 集成测试
```

## 安全设计

- 会话为 HMAC-SHA256 签名的无状态 Cookie（HttpOnly / Secure / SameSite=Lax），密钥由 `ADMIN_PASSWORD` 派生，改密码即全端下线
- 登录与分享口令验证均按 IP 限流（15 分钟 10 次）
- 分享访问范围用递归 CTE 严格限制在分享根的子树内，目录穿越/越权访问返回 403
- 上传的 HTML/SVG 等可执行类型不提供内联预览；所有文件响应带 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: sandbox`
- 文件名规范化（拒绝路径分隔符/控制字符），R2 对象 key 为 UUID，与用户输入完全隔离

## 免责与限额

R2 免费额度为 10 GB 存储/月（Class A 操作 100 万次/月、Class B 1000 万次/月），超量会产生费用，可在 Cloudflare 控制台设置预算告警。
