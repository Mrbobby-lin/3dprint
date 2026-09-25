'use strict';

const { db, tx } = require('../../db');
const { AppError } = require('../middleware/errorHandler');
const { nowIso } = require('./orders');

// 枚举和中文名都收在这里，接口一律返回算好的 label ——
// 前端不用再维护一份映射，加一种分类只需要改这一个文件。
const CATEGORIES = ['quality', 'delay', 'design', 'other'];
const CATEGORY_LABELS = {
  quality: '质量问题',
  delay: '交期问题',
  design: '模型/文件问题',
  other: '其他咨询',
};

const STATUSES = ['open', 'replied', 'closed'];
const STATUS_LABELS = {
  open: '待处理',
  replied: '已回复',
  closed: '已结束',
};

// 上限是防灌水用的。客户拿着 cookie 就能反复提交，没有上限的话
// 一个订单能堆出任意多条工单和消息把库撑大。
const MAX_OPEN_TICKETS = 5; // 单个订单同时未结束的工单数
const MAX_MESSAGES = 50; // 单个工单的消息总数（含客户与管理员）
const MAX_SUBJECT = 60;
const MAX_BODY = 2000;

function categoryLabel(value) {
  return CATEGORY_LABELS[value] || value;
}

function statusLabel(value) {
  return STATUS_LABELS[value] || value;
}

// 前端下拉框的选项来源，和订单状态一样由服务端给
function categoriesForForm() {
  return CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }));
}

function statusesForForm() {
  return STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }));
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function requireText(value, field, max) {
  // 缺失和格式错误要分开报，和 orders.js 同一个理由：
  // 表单没填却提示"格式不正确"会让用户找错方向
  if (value === undefined || value === null) throw new AppError(400, `请填写${field}`);
  if (typeof value !== 'string') throw new AppError(400, `${field}格式不正确`);
  const trimmed = value.trim();
  if (!trimmed) throw new AppError(400, `请填写${field}`);
  if (trimmed.length > max) throw new AppError(400, `${field}不能超过 ${max} 个字符`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function getById(id) {
  return (
    db
      .prepare(
        `SELECT t.*, o.order_no, o.customer_name
           FROM tickets t
           JOIN orders o ON o.id = t.order_id
          WHERE t.id = ?`
      )
      .get(id) || null
  );
}

function getMessages(ticketId) {
  return db
    .prepare(
      `SELECT id, author, body, created_at
         FROM ticket_messages
        WHERE ticket_id = ?
        ORDER BY created_at ASC, id ASC`
    )
    .all(ticketId);
}

// 带上中文名再给前端。status / category 的原始值一并保留，
// 前端要按状态加样式时不用拿中文名去反查。
function decorate(ticket) {
  return {
    ...ticket,
    category_label: categoryLabel(ticket.category),
    status_label: statusLabel(ticket.status),
  };
}

/**
 * 客户视图：这个订单下的全部工单及其消息。
 * 调用方传入的 orderId 必须来自 cookie，接口层不接受任何请求参数。
 */
function listByOrder(orderId) {
  const rows = db
    .prepare(
      `SELECT id, category, subject, status, created_at, updated_at
         FROM tickets
        WHERE order_id = ?
        ORDER BY updated_at DESC, id DESC`
    )
    .all(orderId);

  if (rows.length === 0) return [];

  // 一次性把所有消息取回来再分组。客户页通常只有一两个工单，
  // 比按工单逐个查省事，也避免 N+1。
  const ids = rows.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const messages = db
    .prepare(
      `SELECT id, ticket_id, author, body, created_at
         FROM ticket_messages
        WHERE ticket_id IN (${placeholders})
        ORDER BY created_at ASC, id ASC`
    )
    .all(...ids);

  const grouped = new Map(ids.map((id) => [id, []]));
  for (const m of messages) grouped.get(m.ticket_id).push(m);

  return rows.map((t) =>
    decorate({
      ...t,
      messages: grouped.get(t.id).map(({ ticket_id: _ignored, ...m }) => m),
    })
  );
}

/**
 * 后台列表。默认按最后活动时间倒序 —— 客户刚追问过的工单自动浮到最上面，
 * 管理员不用自己去列表里找"哪条动过"。
 */
function listTickets({ status, orderId, q, page = 1, pageSize = 20 } = {}) {
  const where = [];
  const params = [];

  // 非法状态静默忽略，和 listOrders 的行为一致
  if (status && STATUSES.includes(status)) {
    where.push('t.status = ?');
    params.push(status);
  }

  const oid = Number.parseInt(orderId, 10);
  if (Number.isInteger(oid) && oid > 0) {
    where.push('t.order_id = ?');
    params.push(oid);
  }

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    // 消息正文也搜：客户常记得自己说过什么，却记不住标题
    where.push(
      `(t.subject LIKE ? OR o.order_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?
        OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.body LIKE ?))`
    );
    params.push(term, term, term, term, term);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets t JOIN orders o ON o.id = t.order_id ${clause}`)
    .get(...params).n;

  const safeSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeSize;

  const rows = db
    .prepare(
      `SELECT t.id, t.order_id, t.category, t.subject, t.status, t.created_at, t.updated_at,
              o.order_no, o.customer_name,
              (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
              (SELECT MAX(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at
         FROM tickets t
         JOIN orders o ON o.id = t.order_id
         ${clause}
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, safeSize, offset);

  return { rows: rows.map(decorate), total, page: safePage, pageSize: safeSize };
}

// 各状态条数，给筛选上的角标用。列表筛选不影响它 ——
// 和首页看板同一个道理：角标要回答"总共有多少待处理"，不是"这一页有多少"。
function counts() {
  const out = { open: 0, replied: 0, closed: 0, total: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all()) {
    out[row.status] = row.n;
    out.total += row.n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/**
 * 客户发起工单。首条消息就是工单正文，不需要客户填两遍 ——
 * 列表页给管理员看的是 subject，线程里第一条是 body。
 */
function createTicket(orderId, body) {
  if (!body || typeof body !== 'object') throw new AppError(400, '请求内容为空');

  const { category } = body;
  if (!CATEGORIES.includes(category)) {
    throw new AppError(400, `问题类型需要是：${CATEGORIES.map(categoryLabel).join('、')}`);
  }
  const subject = requireText(body.subject, '问题标题', MAX_SUBJECT);
  const text = requireText(body.body, '问题描述', MAX_BODY);

  const open = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets WHERE order_id = ? AND status != 'closed'`)
    .get(orderId).n;
  if (open >= MAX_OPEN_TICKETS) {
    throw new AppError(
      400,
      `这个订单还有 ${open} 个未结束的工单，请回到原工单里继续追问`
    );
  }

  const now = nowIso();
  const id = tx(() => {
    const info = db
      .prepare(
        `INSERT INTO tickets (order_id, category, subject, status, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?)`
      )
      .run(orderId, category, subject, now, now);

    db.prepare(
      `INSERT INTO ticket_messages (ticket_id, author, body, created_at)
       VALUES (?, 'customer', ?, ?)`
    ).run(info.lastInsertRowid, text, now);

    return info.lastInsertRowid;
  });

  return getById(id);
}

/**
 * 追加消息，并把状态推到"等对方回"的那一侧：
 * 客户说完 = 等管理员（open），管理员说完 = 等客户（replied）。
 * 状态因此不需要人工维护，也不会出现"管理员回复了却还挂在待处理"。
 *
 * orderId 不为 null 时表示调用方是客户，必须校验工单归属 ——
 * ticket id 是自增的，能猜得到。
 */
function addMessage(ticketId, author, body, { orderId = null } = {}) {
  const ticket = getById(ticketId);
  // 不属于自己订单的工单和不存在的工单返回同一个 404：
  // 客户不该从响应差异里推出"这个工单存在但不归我"。
  // （附件接口用的是 403，因为那里"存在但仅内部可见"是客户该知道的区别）
  if (!ticket || (orderId !== null && ticket.order_id !== orderId)) {
    throw new AppError(404, '工单不存在');
  }

  const text = requireText(body, '消息内容', MAX_BODY);

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?')
    .get(ticketId).n;
  if (count >= MAX_MESSAGES) {
    throw new AppError(400, `单个工单最多 ${MAX_MESSAGES} 条消息，请新开一个工单`);
  }

  const status = author === 'admin' ? 'replied' : 'open';
  const now = nowIso();

  tx(() => {
    db.prepare(
      `INSERT INTO ticket_messages (ticket_id, author, body, created_at) VALUES (?, ?, ?, ?)`
    ).run(ticketId, author, text, now);
    db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      now,
      ticketId
    );
  });

  return getById(ticketId);
}

/** 管理员手动收尾（结束）或重新打开。客户侧没有这个入口。 */
function setStatus(ticketId, status) {
  if (!STATUSES.includes(status)) throw new AppError(400, '工单状态无效');

  // 先确认存在，否则改 0 行也会返回成功，前端会以为改掉了
  if (!getById(ticketId)) throw new AppError(404, '工单不存在');

  db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowIso(),
    ticketId
  );
  return getById(ticketId);
}

module.exports = {
  CATEGORIES,
  STATUSES,
  MAX_MESSAGES,
  MAX_OPEN_TICKETS,
  categoryLabel,
  statusLabel,
  decorate,
  categoriesForForm,
  statusesForForm,
  getById,
  getMessages,
  listByOrder,
  listTickets,
  counts,
  createTicket,
  addMessage,
  setStatus,
};
