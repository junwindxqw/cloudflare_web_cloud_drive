# JunDrive · Cloudflare 免费网盘

一个部署在 Cloudflare 上的个人网盘，**全部使用 Cloudflare 免费服务**，无需服务器：

| 组件 | 服务 | 免费额度（个人使用足够） |
| --- | --- | --- |
| 计算与 API | Cloudflare **Workers** | 10 万次请求/天 |
| 文件存储 | Cloudflare **R2** | 10 GB 存储/月，流量免费 |
| 元数据（文件树/分享/上传任务） | Cloudflare **D1** (SQLite) | 5 GB 存储，500 万行读/天 |
| 前端托管 | Workers **静态资源** | 免费、不限请求 |
| 登录验证码邮件 | **Resend** | 100 封/天，域名 `junwind.site` |

## 功能

- 🔐 完整账号体系：**注册 / 登录 / 找回密码** 三个页面（标签页切换），密码使用 PBKDF2 加盐哈希存储，支持邮箱验证码登录、忘记密码自助重置、站内修改密码（改密后其他设备全部下线）；Resend 发信
- 👤 唯一管理员：默认仅授权邮箱可注册/登录（首次登录自动注册）；设置 `OPEN_REGISTRATION=1` 后对所有人开放注册（注意：当前网盘为单用户共享模型，开放前请先评估）
- 📤 上传：单文件 / 整个文件夹（保留目录结构）/ 桌面拖拽 / **Ctrl+V 直接粘贴文件或截图**；R2 分片上传，单文件最大 8 GB，实时进度、停滞自动重试、可取消；上传完成提示 10 秒后自动消失
- 📥 下载：支持断点续传（HTTP Range），视频/音频可拖动进度条
- 📁 文件夹：新建、重命名、移动、递归删除；同名自动加 `(1)` 后缀
- 🔗 分享：公开链接，提取码自动生成并直接附带在链接上（`?pwd=xxxx`，访客打开即自动验证，免输入，同百度网盘）；可选有效期（1/7/30 天/永久），支持文件与整个文件夹；分享管理页可复制/撤销
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

# 3. 设置密钥（均会提示输入，勿提交到代码库）
npx wrangler secret put SESSION_SECRET      # 会话签名密钥（任意长随机串）
npx wrangler secret put RESEND_API_KEY      # Resend API 密钥

# 4. 部署（含前端静态资源）
npx wrangler deploy
```

### 邮件登录配置（Resend）

1. 在 [Resend](https://resend.com) 注册并把域名 `junwind.site`（或其他域名）添加为已验证域名，按提示在 Cloudflare DNS 中加好 SPF/DKIM 记录；
2. 创建 API Key 并 `npx wrangler secret put RESEND_API_KEY`；
3. 可选变量（在 `wrangler.jsonc` 的 `vars` 中配置）：
   - `MAIL_FROM`：发件人，默认 `JunDrive <noreply@junwind.site>`，需为已验证域名下的邮箱；
   - `ALLOWED_EMAIL`：允许注册/登录的邮箱，默认 `junwind.xqw@gmail.com`（唯一管理员）；
   - `OPEN_REGISTRATION`：设为 `1` 时对所有人开放邮箱注册/登录（默认关闭；当前网盘为单用户共享模型，开放前请先评估）。

### 绑定自定义域名

`wrangler.jsonc` 中已配置：

```jsonc
"routes": [{ "pattern": "drive.junwind.site", "custom_domain": true }]
```

把域名换成你自己的（域名需已托管在该 Cloudflare 账号下），`wrangler deploy` 会自动创建 DNS 记录与证书，无需手动操作。

## 本地开发

```bash
npm run db:init:local        # 初始化本地 D1（首次）
npm run dev                  # http://127.0.0.1:8787 ，本地变量见 .dev.vars
npm test                     # API 集成测试（需 dev 服务运行中）
```

本地开发默认 `DEV_MAIL_LOG=1`：不真正发邮件，验证码直接在 `/api/auth/send-code` 响应的 `devCode` 字段返回（也会打印到 dev 控制台）。生产环境切勿设置该变量。

## 目录结构

```
├── wrangler.jsonc      # Cloudflare 配置（R2/D1/静态资源/自定义域名）
├── schema.sql          # D1 表结构
├── src/
│   ├── worker.js       # Worker 入口
│   ├── api.js          # 全部 API 路由
│   ├── auth.js         # 会话/口令/限流
│   └── mail.js         # Resend 邮件发送（含出站 URL 校验）
├── public/             # 前端 SPA（无构建，直接托管）
│   ├── index.html
│   ├── app.js          # 网盘主应用
│   ├── share.js        # 公开分享页 /s/<token>
│   ├── common.js       # 公共工具
│   └── style.css
└── tests/api-test.sh   # API 集成测试
```

## 安全设计

- 完整账号体系：注册（邮箱验证码验证归属 + 设置密码）、密码登录、忘记密码（验证码 + 新密码）、站内修改密码；密码以 PBKDF2-SHA256（25k 次迭代 + 随机盐）哈希存储
- 会话为 HMAC-SHA256 签名的无状态 Cookie（HttpOnly / Secure / SameSite=Lax），密钥由 `SESSION_SECRET`（或回退 `ADMIN_PASSWORD`）派生；会话绑定用户 epoch，重置/修改密码后其他设备全部下线
- 默认仅白名单邮箱可注册/登录（`ALLOWED_EMAIL`，默认 `junwind.xqw@gmail.com` 唯一管理员）；`OPEN_REGISTRATION=1` 时开放
- 验证码按用途（登录/注册/重置）隔离，10 分钟有效、至多 5 次尝试；发码 5 次/15 分钟/邮箱、20 次/15 分钟/IP；密码登录错误 10 次/15 分钟/邮箱
- 登录失败提示统一为“邮箱或密码错误”，不泄露账号是否存在；找回密码对未注册邮箱静默忽略
- 分享访问范围用递归 CTE 严格限制在分享根的子树内，目录穿越/越权访问返回 403
- 出站邮件请求固定为 `https://api.resend.com`，发起前校验协议与 host（拒绝 localhost/私有/保留地址）
- 上传的 HTML/SVG 等可执行类型不提供内联预览；所有文件响应带 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: sandbox`
- 文件名规范化（拒绝路径分隔符/控制字符），R2 对象 key 为 UUID，与用户输入完全隔离

## 免责与限额

R2 免费额度为 10 GB 存储/月（Class A 操作 100 万次/月、Class B 1000 万次/月），超量会产生费用，可在 Cloudflare 控制台设置预算告警。
