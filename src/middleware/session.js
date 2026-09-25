'use strict';

const crypto = require('node:crypto');

const config = require('../lib/config');
const { db } = require('../../db');
const { AppError } = require('./errorHandler');

// 两个独立的 cookie：管理员和客户互不影响，
// 客户拿订单号进来不会顶掉管理员在后台的登录态。
const ADMIN_COOKIE = 'p3_admin';
const CUSTOMER_COOKIE = 'p3_cust';

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const CUSTOMER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// cookie 里只放内部主键（oid / aid），绝不放订单号。
// 这样即使 cookie 被日志、代理或浏览器扩展记录，泄露的也不是可复用的订单号。
const VERSION = 'v1';

function hmac(body) {
  return crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
}

function sign(payload) {
  const body = `${VERSION}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${hmac(body)}`;
}

function verify(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  const body = `${VERSION}.${parts[1]}`;
  const expected = Buffer.from(hmac(body));
  const provided = Buffer.from(parts[2]);
  // 长度不等时 timingSafeEqual 会抛异常，所以先比长度
  if (expected.length !== provided.length) return null;
  if (!crypto.timingSafeEqual(expected, provided)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true, // 前端 JS 读不到，XSS 也偷不走
    secure: config.cookieSecure, // 默认生产环境只走 HTTPS，见 config.cookieSecure
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}

function setAdminCookie(res, adminId, epoch) {
  res.cookie(
    ADMIN_COOKIE,
    sign({ aid: adminId, ep: epoch, exp: Date.now() + ADMIN_TTL_MS }),
    cookieOptions(ADMIN_TTL_MS)
  );
}

function setCustomerCookie(res, orderId) {
  res.cookie(
    CUSTOMER_COOKIE,
    sign({ oid: orderId, exp: Date.now() + CUSTOMER_TTL_MS }),
    cookieOptions(CUSTOMER_TTL_MS)
  );
}

function clearCookies(res) {
  const base = { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' };
  res.clearCookie(ADMIN_COOKIE, base);
  res.clearCookie(CUSTOMER_COOKIE, base);
}

// 剩余有效期不足一半时续期。每次都续会让 Set-Cookie 出现在每个响应上，
// 白白增大流量，也更容易被中间设备干扰。
function renewIfNeeded(req, res, name, payload, ttl, reissue) {
  const remaining = payload.exp - Date.now();
  if (remaining < ttl / 2) reissue(req, res);
}

function getAdmin(req) {
  const payload = verify(req.cookies?.[ADMIN_COOKIE]);
  if (!payload || !Number.isInteger(payload.aid)) return null;

  const admin = db
    .prepare('SELECT id, username, session_epoch FROM admin WHERE id = ?')
    .get(payload.aid);
  if (!admin) return null;
  // session_epoch 对不上 = 密码改过，所有旧会话立即失效
  if (admin.session_epoch !== payload.ep) return null;

  return { admin, payload };
}

function requireAdmin(req, res, next) {
  const found = getAdmin(req);
  if (!found) return next(new AppError(401, '请先登录'));
  req.admin = found.admin;
  renewIfNeeded(req, res, ADMIN_COOKIE, found.payload, ADMIN_TTL_MS, () =>
    setAdminCookie(res, found.admin.id, found.admin.session_epoch)
  );
  next();
}

function getCustomer(req) {
  const payload = verify(req.cookies?.[CUSTOMER_COOKIE]);
  if (!payload || !Number.isInteger(payload.oid)) return null;
  return payload;
}

function requireCustomer(req, res, next) {
  const payload = getCustomer(req);
  if (!payload) return next(new AppError(401, '请先输入订单号'));
  req.orderId = payload.oid;
  renewIfNeeded(req, res, CUSTOMER_COOKIE, payload, CUSTOMER_TTL_MS, () =>
    setCustomerCookie(res, payload.oid)
  );
  next();
}

// 附件接口对两种角色都开放，需要同时知道"是谁"和"能访问哪个订单"
function resolveActor(req) {
  const adminFound = getAdmin(req);
  if (adminFound) return { role: 'admin', admin: adminFound.admin, orderId: null };

  const customer = getCustomer(req);
  if (customer) return { role: 'customer', admin: null, orderId: customer.oid };

  return null;
}

function requireActor(req, res, next) {
  const actor = resolveActor(req);
  if (!actor) return next(new AppError(403, '无权访问'));
  req.actor = actor;
  if (actor.role === 'admin') {
    renewIfNeeded(req, res, ADMIN_COOKIE, getAdmin(req).payload, ADMIN_TTL_MS, () =>
      setAdminCookie(res, actor.admin.id, actor.admin.session_epoch)
    );
  } else {
    const payload = getCustomer(req);
    renewIfNeeded(req, res, CUSTOMER_COOKIE, payload, CUSTOMER_TTL_MS, () =>
      setCustomerCookie(res, payload.oid)
    );
  }
  next();
}

module.exports = {
  ADMIN_COOKIE,
  CUSTOMER_COOKIE,
  setAdminCookie,
  setCustomerCookie,
  clearCookies,
  requireAdmin,
  requireCustomer,
  requireActor,
  resolveActor,
  sign,
  verify,
};
