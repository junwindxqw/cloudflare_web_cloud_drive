-- 网盘元数据表结构（D1 / SQLite）

-- 文件与文件夹
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,                -- UUID，同时是 R2 对象 key 的最后一段（files/<id>）
  type        TEXT NOT NULL CHECK (type IN ('file','folder')),
  name        TEXT NOT NULL,                   -- 展示名（不含路径分隔符）
  parent_id   TEXT,                            -- NULL 表示根目录
  size        INTEGER NOT NULL DEFAULT 0,      -- 文件字节数，文件夹恒为 0
  mime        TEXT,
  r2_key      TEXT,                            -- 文件夹为 NULL
  created_at  INTEGER NOT NULL,                -- 毫秒时间戳
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);

-- 分享链接
CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,          -- URL 中的随机标识
  file_id       TEXT NOT NULL,                 -- 被分享的文件/文件夹（文件夹则整个子树可见）
  password_hash TEXT,                          -- 可选，格式 salt$hex(sha256(salt:password))
  expires_at    INTEGER,                       -- 可选，毫秒时间戳
  created_at    INTEGER NOT NULL,
  downloads     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shares_file ON shares(file_id);

-- 进行中的分片上传
CREATE TABLE IF NOT EXISTS uploads (
  upload_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  parent_id    TEXT,
  size         INTEGER NOT NULL,
  mime         TEXT,
  r2_key       TEXT NOT NULL,
  r2_upload_id TEXT,                           -- NULL 表示 0 字节文件（直接 put）
  created_at   INTEGER NOT NULL
);

-- 登录/分享密码失败次数（简单限流）
CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures_ip ON login_failures(ip, ts);

-- 注册用户（邮箱 + 密码；session_epoch 用于改密后使旧会话全部失效）
CREATE TABLE IF NOT EXISTS users (
  email         TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,              -- 毫秒时间戳
  last_login_at INTEGER,
  is_admin      INTEGER NOT NULL DEFAULT 0,    -- 1 = 管理员
  password_hash TEXT,                          -- pbkdf2$iter$salt$hash；NULL 表示尚未设置密码（可走验证码登录）
  session_epoch INTEGER NOT NULL DEFAULT 1
);

-- 邮箱验证码（同一邮箱仅保留最新一条；purpose 区分用途，防止跨用途使用）
CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,                  -- 格式 salt$hex(sha256(salt:code))
  purpose    TEXT NOT NULL DEFAULT 'login',  -- login / register / reset
  expires_at INTEGER NOT NULL,               -- 毫秒时间戳
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
