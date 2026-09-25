'use strict';

const { db, tx } = require('../../db');
const { generateOrderNo } = require('./orderNo');
const statusMachine = require('./statusMachine');
const { AppError } = require('../middleware/errorHandler');

// 客户接口只 SELECT 这些列。
// customer_name / customer_phone / admin_note 是内部字段，绝不能出现在响应体里。
// 这里用显式列名而不是 SELECT *，就是为了以后加字段时不会意外泄露。
const CUSTOMER_COLUMNS = [
  'order_no',
  'model_name',
  'material',
  'color',
  'layer_height',
  'infill',
  'need_support',
  'quantity',
  'est_weight_g',
  'price',
  'promised_date',
  'status',
  'customer_note',
  'created_at',
  'updated_at',
];

const CUSTOMER_SELECT = CUSTOMER_COLUMNS.join(', ');

const MATERIALS = ['PLA', 'ABS', 'PETG', 'TPU', '树脂', '尼龙', '其他'];

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function requireText(value, field, { max = 200, min = 1 } = {}) {
  // 缺失和格式错误要分开报：表单没填却提示"格式不正确"会让用户找错方向
  if (value === undefined || value === null) throw new AppError(400, `请填写${field}`);
  if (typeof value !== 'string') throw new AppError(400, `${field}格式不正确`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new AppError(400, `请填写${field}`);
  if (trimmed.length > max) throw new AppError(400, `${field}不能超过 ${max} 个字符`);
  return trimmed;
}

function optionalText(value, field, max = 1000) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError(400, `${field}格式不正确`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AppError(400, `${field}不能超过 ${max} 个字符`);
  return trimmed || null;
}

function optionalNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new AppError(400, `${field}必须是数字`);
  if (n < min || n > max) throw new AppError(400, `${field}需要在 ${min} 到 ${max} 之间`);
  return integer ? Math.round(n) : n;
}

const PHONE_RE = /^[0-9+\-\s()]{6,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseOrderInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') throw new AppError(400, '请求内容为空');
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  const read = (key, fn) => {
    if (partial && !has(key)) return;
    out[key] = fn();
  };

  read('customer_name', () => requireText(body.customer_name, '客户姓名', { max: 50 }));
  read('customer_phone', () => {
    const phone = requireText(body.customer_phone, '联系电话', { max: 20 });
    if (!PHONE_RE.test(phone)) throw new AppError(400, '联系电话格式不正确');
    return phone;
  });
  read('model_name', () => requireText(body.model_name, '模型名称', { max: 100 }));
  read('material', () => {
    const material = requireText(body.material, '材料', { max: 20 });
    if (!MATERIALS.includes(material)) {
      throw new AppError(400, `材料需要是：${MATERIALS.join('、')}`);
    }
    return material;
  });

  read('color', () => optionalText(body.color, '颜色', 30));
  read('layer_height', () => optionalNumber(body.layer_height, '层高', { min: 0.02, max: 2 }));
  read('infill', () => optionalNumber(body.infill, '填充率', { min: 0, max: 100, integer: true }));
  read('need_support', () => (body.need_support ? 1 : 0));
  read('quantity', () =>
    has('quantity') && body.quantity !== '' && body.quantity !== null
      ? optionalNumber(body.quantity, '数量', { min: 1, max: 10000, integer: true })
      : 1
  );
  read('est_weight_g', () => optionalNumber(body.est_weight_g, '预估重量', { min: 0, max: 1000000 }));
  read('price', () => optionalNumber(body.price, '报价', { min: 0, max: 10000000 }));
  read('promised_date', () => {
    const v = optionalText(body.promised_date, '预计交付日期', 10);
    if (v && !DATE_RE.test(v)) throw new AppError(400, '预计交付日期格式应为 YYYY-MM-DD');
    return v;
  });
  read('customer_note', () => optionalText(body.customer_note, '客户备注', 1000));
  read('admin_note', () => optionalText(body.admin_note, '内部备注', 2000));

  return out;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function getByOrderNo(orderNo) {
  return db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo) || null;
}

function getById(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

function getCustomerView(orderId) {
  return db.prepare(`SELECT ${CUSTOMER_SELECT} FROM orders WHERE id = ?`).get(orderId) || null;
}

function getHistory(orderId) {
  return db
    .prepare(
      `SELECT id, from_status, to_status, note, internal, created_at
         FROM order_status_history
        WHERE order_id = ?
        ORDER BY created_at ASC, id ASC`
    )
    .all(orderId);
}

function listOrders({ status, q, page = 1, pageSize = 20 } = {}) {
  const where = [];
  const params = [];

  if (status && statusMachine.isStatus(status)) {
    where.push('status = ?');
    params.push(status);
  }

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    where.push('(order_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR model_name LIKE ?)');
    params.push(term, term, term, term);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders ${clause}`).get(...params).n;

  const safeSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeSize;

  const rows = db
    .prepare(
      `SELECT * FROM orders ${clause}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, safeSize, offset);

  return { rows, total, page: safePage, pageSize: safeSize };
}

function findByPhone(phone) {
  return db
    .prepare(
      `SELECT * FROM orders
        WHERE customer_phone = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 50`
    )
    .all(phone);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

// 订单号碰撞概率极低（60 bit），但 UNIQUE 约束会抛异常，
// 所以还是要重试而不是让请求失败。
function newUniqueOrderNo() {
  const exists = db.prepare('SELECT 1 FROM orders WHERE order_no = ?');
  for (let i = 0; i < 5; i += 1) {
    const candidate = generateOrderNo();
    if (!exists.get(candidate)) return candidate;
  }
  throw new AppError(500, '订单号生成失败，请重试');
}

function createOrder(body) {
  const data = parseOrderInput(body);
  const orderNo = newUniqueOrderNo();

  const id = tx(() => {
    const info = db
      .prepare(
        `INSERT INTO orders (
           order_no, customer_name, customer_phone, model_name, material, color,
           layer_height, infill, need_support, quantity, est_weight_g, price,
           promised_date, status, customer_note, admin_note, created_at, updated_at
         ) VALUES (
           @order_no, @customer_name, @customer_phone, @model_name, @material, @color,
           @layer_height, @infill, @need_support, @quantity, @est_weight_g, @price,
           @promised_date, 'pending_confirm', @customer_note, @admin_note, @now, @now
         )`
      )
      .run({
        order_no: orderNo,
        customer_name: data.customer_name,
        customer_phone: data.customer_phone,
        model_name: data.model_name,
        material: data.material,
        color: data.color ?? null,
        layer_height: data.layer_height ?? null,
        infill: data.infill ?? null,
        need_support: data.need_support ?? 0,
        quantity: data.quantity ?? 1,
        est_weight_g: data.est_weight_g ?? null,
        price: data.price ?? null,
        promised_date: data.promised_date ?? null,
        customer_note: data.customer_note ?? null,
        admin_note: data.admin_note ?? null,
        now: nowIso(),
      });

    db.prepare(
      `INSERT INTO order_status_history (order_id, from_status, to_status, note, created_at)
       VALUES (?, NULL, 'pending_confirm', ?, ?)`
    ).run(info.lastInsertRowid, '订单创建', nowIso());

    return info.lastInsertRowid;
  });

  return getById(id);
}

const UPDATABLE = [
  'customer_name',
  'customer_phone',
  'model_name',
  'material',
  'color',
  'layer_height',
  'infill',
  'need_support',
  'quantity',
  'est_weight_g',
  'price',
  'promised_date',
  'customer_note',
  'admin_note',
];

function updateOrder(id, body) {
  const order = getById(id);
  if (!order) throw new AppError(404, '订单不存在');

  const data = parseOrderInput(body, { partial: true });
  const keys = Object.keys(data).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) throw new AppError(400, '没有需要更新的内容');

  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE orders SET ${sets}, updated_at = @now WHERE id = @id`).run({
    ...data,
    id,
    now: nowIso(),
  });

  return getById(id);
}

function changeStatus(id, { toStatus, note, force }) {
  const order = getById(id);
  if (!order) throw new AppError(404, '订单不存在');

  const verdict = statusMachine.check(order.status, toStatus, { force, note });
  if (!verdict.ok) throw new AppError(400, verdict.message);

  const now = nowIso();
  tx(() => {
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, now, id);
    // 越级变更的 note 是内部审计原因，不是给客户看的进度说明，标记后不进客户时间线
    db.prepare(
      `INSERT INTO order_status_history (order_id, from_status, to_status, note, internal, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, order.status, toStatus, note?.trim() || null, force ? 1 : 0, now);
  });

  return getById(id);
}

// 删除订单：先取出附件文件名，删库（级联清掉历史与附件记录），最后删磁盘文件。
// 顺序不能反 —— 先删文件再删库的话，删库失败就会留下指向空文件的记录。
function deleteOrder(id) {
  const order = getById(id);
  if (!order) throw new AppError(404, '订单不存在');

  const files = db.prepare('SELECT stored_name FROM attachments WHERE order_id = ?').all(id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  return { order, files };
}

module.exports = {
  CUSTOMER_COLUMNS,
  MATERIALS,
  parseOrderInput,
  getByOrderNo,
  getById,
  getCustomerView,
  getHistory,
  listOrders,
  findByPhone,
  createOrder,
  updateOrder,
  changeStatus,
  deleteOrder,
  nowIso,
};
