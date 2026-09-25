-- 3D 打印订单管理系统 — 初始表结构
--
-- 时间戳统一存 ISO8601 UTC（带 Z 后缀），例如 2026-09-24T12:00:00Z。
-- 不用 datetime('now')：它返回的 "2026-09-24 12:00:00" 没有时区标记，
-- JS 的 new Date() 会按本地时间解析，导致时间线整体偏移。

-- ============================================================
-- 管理员：全系统只允许一个账号
-- CHECK (id = 1) 是硬约束 —— 第二个注册请求会撞主键，而不是靠应用层判断。
-- ============================================================
CREATE TABLE admin (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  session_epoch INTEGER NOT NULL DEFAULT 1,   -- 改密时递增，用于吊销所有旧会话
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================
-- 订单
-- customer_name / customer_phone / admin_note 为内部字段，客户接口不得返回
-- ============================================================
CREATE TABLE orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no       TEXT    NOT NULL UNIQUE,     -- 3D-XXXX-XXXX-XXXX，客户的唯一凭据
  customer_name  TEXT    NOT NULL,
  customer_phone TEXT    NOT NULL,
  model_name     TEXT    NOT NULL,
  material       TEXT    NOT NULL,            -- PLA / ABS / PETG / 树脂 / 尼龙
  color          TEXT,
  layer_height   REAL,                        -- mm，如 0.2
  infill         INTEGER,                     -- 填充率 %
  need_support   INTEGER NOT NULL DEFAULT 0,
  quantity       INTEGER NOT NULL DEFAULT 1,
  est_weight_g   REAL,
  price          REAL,                        -- 报价
  promised_date  TEXT,                        -- 预计交付日期 YYYY-MM-DD
  status         TEXT    NOT NULL DEFAULT 'pending_confirm'
                 CHECK (status IN ('pending_confirm','confirmed','queued',
                                   'printing','post_processing','completed',
                                   'delivered','cancelled')),
  customer_note  TEXT,                        -- 客户备注，客户可见
  admin_note     TEXT,                        -- 内部备注，仅管理员
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_orders_status  ON orders(status);
CREATE INDEX idx_orders_phone   ON orders(customer_phone);
CREATE INDEX idx_orders_created ON orders(created_at DESC);

-- ============================================================
-- 状态变更历史 —— 客户端进度时间线的数据源
-- ============================================================
CREATE TABLE order_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,                           -- 首条为 NULL
  to_status   TEXT    NOT NULL,
  note        TEXT,                           -- 变更说明 / 强制迁移的原因
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_history_order ON order_status_history(order_id, created_at);

-- ============================================================
-- 附件
-- stored_name 由服务端生成（UUID + 白名单扩展名），orig_name 仅供展示，
-- 绝不参与路径拼接。
-- ============================================================
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stored_name TEXT    NOT NULL,
  orig_name   TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  visibility  TEXT    NOT NULL DEFAULT 'both'
              CHECK (visibility IN ('both','admin')),   -- admin = 仅内部可见
  uploaded_by TEXT    NOT NULL CHECK (uploaded_by IN ('admin','customer')),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_attachments_order ON attachments(order_id);
