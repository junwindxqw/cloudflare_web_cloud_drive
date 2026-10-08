# JunDrive · Cloudflare 免费网盘

一个部署在 Cloudflare 上的个人网盘，**不花一分钱**：Workers 跑接口、R2 存文件、D1 存元数据，前端直接托管在 Workers 上。坐拥一个可公网访问的私有云盘：传文件、建目录、生成分享链接，附带一个图床。

## 有什么用

- **网盘**：上传文件/整个文件夹、拖拽上传、Ctrl+V 粘贴（截图也行）；文件夹嵌套、重命名、移动、删除；支持断点续传下载；图片/视频/音频/PDF/文本在线预览
- **搜索与视图**：全局搜索文件名，支持列表/网格两种视图，按名称/大小/时间排序
- **分享**：文件或整个文件夹生成公开链接，可设提取码（自动附在链接上，访客免输入）和有效期（1/7/30 天/永久）
- **图床**：上传图片得到公开直链 `/i/<id>.<ext>`，一键复制 URL / Markdown / HTML / BBCode；网盘里的图片可一键转存
- **账号**：邮箱验证码登录，可设置/修改密码；PC 与手机自适应，自动深色模式
- **安全底线**：密码 PBKDF2 加盐哈希；HTML/SVG 一律强制下载（防存储型 XSS）；分享访问严格限制在分享目录子树内

免费额度：Workers 10 万次请求/天，R2 10 GB 存储，D1 5 GB，Resend 100 封邮件/天——个人使用足够。

## 怎么部署

### 方式一：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/junwindxqw/cloudflare_web_cloud_drive)

点击按钮，按 Cloudflare 的引导页面操作即可，全程约 2 分钟：

1. 登录并授权 Cloudflare（需要 GitHub 账号公开仓库）；
2. 给仓库和 Worker 起个名字；
3. 创建 D1 数据库和 R2 存储桶（引导页会列出，用默认名即可）；
4. 填写两个密钥（按钮引导页会逐项给出说明）：
   - `SESSION_SECRET`：会话签名密钥，任意长随机串（如 `openssl rand -hex 32` 的输出）
   - `RESEND_API_KEY`：Resend 的 API Key，在 [resend.com](https://resend.com) 免费申请，用于发登录验证码邮件
5. 把 `ALLOWED_EMAIL` 改成**你自己的邮箱**——这是唯一允许登录本站的账号，不填会无法登录。

部署完成后打开分配的 `*.workers.dev` 域名，用这个邮箱收验证码登录即可。

### 方式二：命令行手动部署

前提：一个 Cloudflare 账号，本地装好 Node.js ≥ 18。

```bash
npm install
npx wrangler login          # 浏览器授权
```

**1. 创建存储资源**

```bash
npx wrangler r2 bucket create jun-drive-files
npx wrangler d1 create jun-drive-db
#    → 把输出的 database_id 填到 wrangler.jsonc 的 d1_databases[0].database_id
```

**2. 设置密钥**（都会提示输入，勿提交到代码库）

```bash
npx wrangler secret put SESSION_SECRET      # 任意长随机串
npx wrangler secret put RESEND_API_KEY      # Resend 的 API Key
```

**3. 配置允许登录的邮箱**

在 `wrangler.jsonc` 的 `vars` 中把 `ALLOWED_EMAIL` 改成你的邮箱（默认仅仓库内置邮箱可登录）；按需再填 `MAIL_FROM`（发件人，须为 Resend 已验证域名下的邮箱）、`OPEN_REGISTRATION`（设为 `1` 则任何人可注册）。

**4. 部署**（自动初始化数据库表结构）

```bash
npm run deploy
```

打开分配的 `*.workers.dev` 域名，用第 3 步允许的邮箱收验证码登录即可。

### 邮件说明

登录靠邮箱验证码驱动，所以需要 Resend（免费档 100 封/天）：在 Resend 注册后，把你的域名添加为已验证域名（按提示在 Cloudflare DNS 加好 SPF/DKIM 记录），`MAIL_FROM` 必须使用该域名下的邮箱。

### 绑定自己的域名（可选）

在 `wrangler.jsonc` 里加回 routes（域名需已托管在该 Cloudflare 账号下），`npm run deploy` 会自动创建 DNS 记录与证书：

```jsonc
"routes": [{ "pattern": "drive.example.com", "custom_domain": true }]
```

> 本仓库维护者自己部署：专属配置（账号/域名/数据库 ID）已收在 `env.personal`，用 `npx wrangler deploy -e personal` 即可。

## 本地开发

```bash
npm run db:init:local                                   # 首次：初始化本地 D1
npm run dev                                             # http://127.0.0.1:8787
npm test                                                # 图片格式单测 + API 集成测试（需 dev 运行中）
```

本地默认不发真邮件：验证码直接出现在 `/api/auth/send-code` 响应的 `devCode` 字段里。生产环境切勿设置该变量（见 `.dev.vars.example`）。

## 注意事项

- 图床直链 `/i/<id>.<ext>` **任何人可直接访问**（供外站 `<img>` 嵌入），删除图片后立即失效——请勿上传敏感图片
- R2 免费额度 10 GB/月，超量计费，建议在 Cloudflare 控制台设预算告警
- 已有旧部署升级（全新安装无需执行；两个迁移按顺序各执行一次）：
  ```bash
  npx wrangler d1 execute jun-drive-db --remote --file=migrations/002-password-auth.sql
  npx wrangler d1 execute jun-drive-db --remote --file=migrations/003-imagebed.sql
  ```

## 目录结构

```
├── wrangler.jsonc        # Cloudflare 配置（顶层可移植；env.personal 为维护者专属）
├── schema.sql            # D1 表结构
├── .dev.vars.example     # 密钥模板（复制为 .dev.vars 使用，已被 gitignore）
├── package.json          # 脚本 + 部署引导页的密钥说明（cloudflare.bindings）
├── migrations/           # 旧库升级迁移（新装直接执行 schema.sql）
├── src/                  # 后端（Workers）
│   ├── worker.js         # 入口
│   ├── api.js            # 全部 API 路由
│   ├── auth.js           # 会话/口令/限流
│   └── mail.js           # Resend 发信
├── public/               # 前端（无构建，直接托管）
│   ├── app.js            # 网盘主应用（含图床）
│   ├── share.js          # 公开分享页 /s/<token>
│   ├── common.js         # 公共工具
│   └── style.css
└── tests/                # 单测 + API 集成测试
```
