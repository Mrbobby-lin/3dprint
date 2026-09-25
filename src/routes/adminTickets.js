'use strict';

const express = require('express');

const logger = require('../lib/logger');
const tickets = require('../services/tickets');
const { requireAdmin } = require('../middleware/session');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

// 和 adminOrders 一样一刀切。注意本路由必须挂在 /api/admin 之前 ——
// 挂后面的话请求会先进 adminOrders 那个 router，被它自己的规则处理掉，
// 详见 app.js 里那两行挂载顺序的注释。
router.use(requireAdmin);

function parseIntParam(value, field) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `${field}无效`);
  return n;
}

function loadTicket(id) {
  const ticket = tickets.getById(id);
  if (!ticket) throw new AppError(404, '工单不存在');
  return ticket;
}

// GET /api/admin/tickets
// counts 统计的是全部工单，不受下面的筛选影响 ——
// 和首页看板同一个道理：角标要回答"总共有多少待处理"，不是"这一页有多少"。
router.get('/', (req, res, next) => {
  try {
    const { status, order_id: orderId, q, page, pageSize } = req.query;
    const result = tickets.listTickets({ status, orderId, q, page, pageSize });
    res.json({
      tickets: result.rows,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      counts: tickets.counts(),
      categories: tickets.categoriesForForm(),
      statuses: tickets.statusesForForm(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/tickets/:id —— 工单详情 + 完整线程
router.get('/:id', (req, res, next) => {
  try {
    const id = parseIntParam(req.params.id, '工单 ID');
    const ticket = loadTicket(id);
    res.json({ ticket: tickets.decorate(ticket), messages: tickets.getMessages(id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/tickets/:id/messages —— 管理员回复
router.post('/:id/messages', (req, res, next) => {
  try {
    const id = parseIntParam(req.params.id, '工单 ID');
    const ticket = tickets.addMessage(id, 'admin', req.body?.body);

    logger.info('工单已回复', { ticketId: id, orderNo: ticket.order_no });
    res.status(201).json({
      ticket: tickets.decorate(ticket),
      messages: tickets.getMessages(id),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/tickets/:id —— 结束工单或重新打开
router.patch('/:id', (req, res, next) => {
  try {
    const id = parseIntParam(req.params.id, '工单 ID');
    const ticket = tickets.setStatus(id, req.body?.status);

    logger.info('工单状态已变更', { ticketId: id, status: ticket.status });
    res.json({ ticket: tickets.decorate(ticket) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
