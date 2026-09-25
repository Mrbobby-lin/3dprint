'use strict';

const express = require('express');

const { db } = require('../../db');
const logger = require('../lib/logger');
const orders = require('../services/orders');
const settings = require('../services/settings');
const stats = require('../services/stats');
const storage = require('../services/storage');
const statusMachine = require('../services/statusMachine');
const { requireAdmin } = require('../middleware/session');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

router.use(requireAdmin);

// GET /api/admin/meta —— 前端下拉框的选项来源，避免前后端各写一份枚举
router.get('/meta', (req, res) => {
  res.json({
    statuses: statusMachine.STATUSES.map((s) => ({
      value: s,
      label: statusMachine.label(s),
      terminal: statusMachine.TERMINAL.has(s),
    })),
    timeline: statusMachine.TIMELINE,
    materials: orders.MATERIALS,
    // 订单表单启动时本来就拉这个接口，顺带把单价带回去，
    // 省一次请求也省一条会失败的路径
    unit_price: settings.all().default_unit_price,
  });
});

// GET /api/admin/stats —— 首页看板。统计的是全部订单，不受列表筛选影响。
router.get('/stats', (req, res, next) => {
  try {
    res.json({ stats: stats.summary() });
  } catch (err) {
    next(err);
  }
});

function parseIntParam(value, field) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `${field}无效`);
  return n;
}

// GET /api/admin/orders
router.get('/orders', (req, res, next) => {
  try {
    const { status, q, page, pageSize } = req.query;
    const result = orders.listOrders({ status, q, page, pageSize });
    res.json({
      orders: result.rows,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/orders
router.post('/orders', (req, res, next) => {
  try {
    const order = orders.createOrder(req.body);
    logger.info('订单已创建', { orderNo: order.order_no, id: order.id });
    res.status(201).json({ order });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/orders/:id —— 详情 + 全部历史 + 全部附件（含仅内部可见的）
router.get('/orders/:id', (req, res, next) => {
  try {
    const id = parseIntParam(req.params.id, '订单 ID');
    const order = orders.getById(id);
    if (!order) throw new AppError(404, '订单不存在');

    const attachments = db
      .prepare(
        `SELECT id, orig_name, mime_type, size_bytes, visibility, uploaded_by, created_at
           FROM attachments WHERE order_id = ? ORDER BY created_at ASC, id ASC`
      )
      .all(id);

    // 服务端算好允许的下一个状态，前端不用再维护一份状态机
    const allowedNext = statusMachine.allowedNext(order.status).map((s) => ({
      value: s,
      label: statusMachine.label(s),
    }));

    res.json({ order, history: orders.getHistory(id), attachments, allowedNext });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/orders/:id
router.patch('/orders/:id', (req, res, next) => {
  try {
    const id = parseIntParam(req.params.id, '订单 ID');
    const order = orders.updateOrder(id, req.body);
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/orders/:id/status
router.post('/orders/:id/status', (req, res, next) => {
  try {
    const id = parseIntParam(req.params.id, '订单 ID');
    const { to_status: toStatus, note, force } = req.body || {};

    const order = orders.changeStatus(id, { toStatus, note, force: !!force });
    logger.info('订单状态已变更', {
      orderNo: order.order_no,
      status: order.status,
      forced: !!force,
    });
    res.json({ order, history: orders.getHistory(id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/orders/:id
router.delete('/orders/:id', async (req, res, next) => {
  try {
    const id = parseIntParam(req.params.id, '订单 ID');
    const { order, files } = orders.deleteOrder(id);

    // 数据库记录已经删掉了，磁盘文件删失败也不该让请求报错 ——
    // 那会让管理员以为没删掉而重复操作。失败只记日志，靠孤儿清理兜底。
    await Promise.all(files.map((f) => storage.removeStored(f.stored_name)));

    logger.info('订单已删除', { orderNo: order.order_no, id, files: files.length });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/lookup-by-phone —— 客户弄丢订单号时的补救路径
router.get('/lookup-by-phone', (req, res, next) => {
  try {
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    if (phone.length < 6 || phone.length > 20) throw new AppError(400, '请提供完整的电话号码');

    const rows = orders.findByPhone(phone).map((o) => ({
      id: o.id,
      order_no: o.order_no,
      customer_name: o.customer_name,
      model_name: o.model_name,
      status: o.status,
      status_label: statusMachine.label(o.status),
      created_at: o.created_at,
    }));

    res.json({ orders: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
