-- 迁移 002：密码注册/登录/找回密码（2026-09）
-- 适用于已按旧版 schema.sql 初始化过的数据库；全新安装直接执行 schema.sql 即可，无需本文件。
-- 注意：SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，本文件只应执行一次。

ALTER TABLE users ADD COLUMN password_hash TEXT;                            -- pbkdf2$iter$salt$hash；NULL = 未设密码
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 1;      -- 改密/重置后 +1，旧会话全部失效
ALTER TABLE email_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';   -- login / register / reset
