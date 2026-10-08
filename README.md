# JunDrive · Cloudflare 免费网盘

基于 Cloudflare Workers + R2 + D1 的个人网盘，零服务器成本，自带图床。

## 功能

- 上传文件/文件夹、拖拽、Ctrl+V 粘贴（截图也行），嵌套目录、重命名、移动、删除
- 断点续传下载，图片/视频/音频/PDF/文本在线预览，全局搜索
- 公开分享链接（可设提取码和有效期），支持分享整个文件夹
- 图床：上传图片得公开直链，一键复制 URL / Markdown / HTML / BBCode
- 邮箱验证码登录，PC/手机自适应，自动深色模式

## 部署

### 一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/junwindxqw/cloudflare_web_cloud_drive)

点上面的按钮，按 Cloudflare 引导页操作即可：

1. 创建 D1 数据库和 R2 存储桶（用默认名）；
2. 填 `SESSION_SECRET`（任意长随机串）和 `RESEND_API_KEY`（[resend.com](https://resend.com) 免费申请，用于发登录验证码邮件）；
3. 把 `ALLOWED_EMAIL` 改成你的邮箱（唯一允许登录本站的账号）。

完成后打开分配的 `*.workers.dev` 域名，用该邮箱收验证码登录。

### 命令行部署

```bash
npm install && npx wrangler login
npx wrangler r2 bucket create jun-drive-files
npx wrangler d1 create jun-drive-db     # 把输出的 database_id 填入 wrangler.jsonc
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY
npm run deploy                          # 自动建表并部署
```

然后把 `wrangler.jsonc` 里 `vars.ALLOWED_EMAIL` 改成你的邮箱。

## 说明

- 发件需在 Resend 验证域名，并把 `MAIL_FROM` 改为该域名下的邮箱
- 图床直链 `/i/<id>.<ext>` 公开可访问，删除即失效，勿传敏感图
- 绑自己的域名：在 `wrangler.jsonc` 加 `"routes": [{ "pattern": "drive.example.com", "custom_domain": true }]`
- 本仓库维护者部署：`npx wrangler deploy -e personal`
- 本地开发：`npm run db:init:local && npm run dev`，验证码在 `/api/auth/send-code` 响应的 `devCode` 字段返回
