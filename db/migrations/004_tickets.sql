-- 售后/咨询工单。客户在查单页发起，管理员在后台回复，双方来回追加消息。
--
-- 拆成 tickets + ticket_messages 两张表，而不是单表带 parent_id：
-- 工单是一条对话线程 —— 消息只增不改，工单本身只留归属、分类、状态这些会被更新的字段。
-- 分开之后后台列表可以只扫 tickets 排序，不用为了排序去碰整张消息表。

CREATE TABLE tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category   TEXT    NOT NULL
             CHECK (category IN ('quality','delay','design','other')),
  subject    TEXT    NOT NULL,                -- 客户写的一句话问题标题
  -- open   = 等管理员处理（客户刚发起，或客户追问后）
  -- replied= 管理员已回复，等客户看
  -- closed = 管理员标记结束；客户再追加消息会自动回到 open
  status     TEXT    NOT NULL DEFAULT 'open'
             CHECK (status IN ('open','replied','closed')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 后台默认按状态筛选、按最后活动时间倒序，这个复合索引正好覆盖
CREATE INDEX idx_tickets_status ON tickets(status, updated_at DESC);

-- 订单详情页按订单取工单
CREATE INDEX idx_tickets_order ON tickets(order_id, created_at DESC);

CREATE TABLE ticket_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT    NOT NULL CHECK (author IN ('customer','admin')),
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 线程内按时间正序读；带上 id 兜底，同一秒写入的消息顺序才是稳定的
CREATE INDEX idx_ticket_messages ON ticket_messages(ticket_id, created_at, id);
