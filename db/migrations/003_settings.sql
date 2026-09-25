-- 后台设置。用键值对而不是为每个设置项加一列 ——
-- 以后加"店名""通知 webhook"这类东西不用再写迁移。
-- 键的合法性由 src/services/settings.js 的 SCHEMA 收口，
-- 表本身不限制，脏数据即使写进来也不会流到前端。
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
