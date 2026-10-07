-- 迁移 003：图床（images 表 + R2 images/ 前缀）（2026-10）
-- 适用于已按旧版 schema.sql 初始化过的数据库；全新安装直接执行 schema.sql 即可，无需本文件。
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,                -- UUID
  name       TEXT NOT NULL,                   -- 原始文件名（仅展示用，不参与路径）
  ext        TEXT NOT NULL,                   -- 归一化扩展名（按文件内容魔数判定）
  size        INTEGER NOT NULL,               -- 字节数
  width      INTEGER,                         -- 像素宽（无法解析时为 NULL）
  height     INTEGER,                         -- 像素高
  created_at INTEGER NOT NULL                 -- 毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at, id);
