'use strict';

const express = require('express');

const logger = require('../lib/logger');
const orders = require('../services/orders');
const statusMachine = require('../services/statusMachine');
const { db } = require('../../db');
const { normalizeOrderNo } = require('../services/orderNo');
const { requireCustomer, setCustomerCookie, CUSTOMER_COOKIE } = require('../middleware/session');
const { createRateLimiter, clientIp } = require('../middleware/rateLimit');
const config = require('../lib/config');

const router = express.Router();

// 第一层：按 IP 限流。挡住单机暴力枚举。
const lookupByIp = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  maxKeys: 10000,
  keyFn: (req) => clientIp(req),
  message: '查询次数过多，请稍后再试',
});

// 第二层：全站总量。分布式（大量源 IP）枚举时按 IP 限流会失效，
// 这一层兜底。代价是攻击期间正常客户也会被限流 —— 对一个订单系统来说，
// 攻击时"暂时谁都不能查"比"攻击者能一直猜"要好。
const lookupGlobal = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  maxKeys: 1,
  keyFn: () => 'global',
  message: '系统繁忙，请稍后再试',
});

// 所有"查不到"的情况返回完全相同的响应：格式错误、订单不存在、被限流后的重试，
// 反馈差异本身就是给枚举者的信号。
const NOT_FOUND = '订单号不存在，请核对后重试';

// POST /api/customer/lookup
router.post('/lookup', lookupGlobal, lookupByIp, (req, res, next) => {
  try {
    const raw = req.body?.order_no;
    const orderNo = normalizeOrderNo(raw);

    if (!orderNo) {
      logger.warn('订单号查询失败', { ip: req.ip, reason: 'format' });
      throw Object.assign(new Error(NOT_FOUND), { status: 404, expose: true });
    }

    const order = orders.getByOrderNo(orderNo);
    if (!order) {
      logger.warn('订单号查询失败', { ip: req.ip, reason: 'not_found' });
      throw Object.assign(new Error(NOT_FOUND), { status: 404, expose: true });
    }

    // cookie 里只放内部 id，订单号从此不再出现在 URL、Referer 或日志里
    setCustomerCookie(res, order.id);
    logger.info('客户查询订单成功', { ip: req.ip, orderId: order.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/customer/logout
router.post('/logout', (req, res) => {
  res.clearCookie(CUSTOMER_COOKIE, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
  res.json({ ok: true });
});

function buildTimeline(order, history) {
  // 首次到达某状态即算达成。订单回退过（例如 打印中 → 排队中）时，
  // 时间线保留最早的达成时间，更符合客户"这个阶段什么时候开始的"的认知。
  const firstReached = new Map();
  for (const h of history) {
    if (h.to_status === 'cancelled') continue;
    if (!firstReached.has(h.to_status)) firstReached.set(h.to_status, h);
  }

  // 越级变更的 note 是内部审计原因（"客户投诉，破例跳过排队"），只给管理员看
  const publicNote = (h) => (h.internal ? null : h.note);

  const steps = statusMachine.TIMELINE.map((status) => {
    const hit = firstReached.get(status);
    return {
      status,
      label: statusMachine.label(status),
      reached: !!hit,
      at: hit ? hit.created_at : null,
      note: hit ? publicNote(hit) : null,
    };
  });

  const cancelled = history.find((h) => h.to_status === 'cancelled');
  return {
    current: order.status,
    current_label: statusMachine.label(order.status),
    steps,
    cancelled: cancelled
      ? { at: cancelled.created_at, note: publicNote(cancelled) }
      : null,
  };
}

// GET /api/customer/order —— 不接受任何参数，只认 cookie 里的订单 id。
// 这样"用 A 的 cookie 去取 B 的订单"在结构上就不可能发生。
router.get('/order', requireCustomer, (req, res, next) => {
  try {
    const order = orders.getCustomerView(req.orderId);
    if (!order) {
      // 订单被管理员删掉了，cookie 还留着
      res.clearCookie(CUSTOMER_COOKIE, { path: '/' });
      throw Object.assign(new Error('订单不存在或已被删除'), { status: 404, expose: true });
    }

    // 状态的中文名由服务端给，前端不用再维护一份枚举映射
    order.status_label = statusMachine.label(order.status);

    // 只列 visibility='both' 的附件，内部文件对客户完全不可见
    const attachments = db
      .prepare(
        `SELECT id, orig_name, mime_type, size_bytes, uploaded_by, created_at
           FROM attachments
          WHERE order_id = ? AND visibility = 'both'
          ORDER BY created_at ASC, id ASC`
      )
      .all(req.orderId)
      .map((a) => ({ ...a, previewable: /^image\/(png|jpeg|webp)$/.test(a.mime_type) }));

    res.json({ order, attachments });
  } catch (err) {
    next(err);
  }
});

// GET /api/customer/order/history
router.get('/order/history', requireCustomer, (req, res, next) => {
  try {
    const order = orders.getCustomerView(req.orderId);
    if (!order) {
      res.clearCookie(CUSTOMER_COOKIE, { path: '/' });
      throw Object.assign(new Error('订单不存在或已被删除'), { status: 404, expose: true });
    }
    const history = orders.getHistory(req.orderId);
    res.json({ timeline: buildTimeline(order, history) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
