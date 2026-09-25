'use strict';

const config = require('../lib/config');

// script-src 'self' 意味着页面里不能有任何内联 <script> 和 onclick= 属性。
// 所有事件绑定都必须走 addEventListener。
function buildCsp() {
  // connect-src 单独拼。指令重复时浏览器只取第一次出现的，
  // 所以不能先把基础版放进数组再追加 —— 那样开发模式的放宽会被静默忽略。
  const connectSrc = config.isProd
    ? "connect-src 'self'"
    : "connect-src 'self' ws://localhost:* ws://127.0.0.1:*";

  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    connectSrc,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}

const CSP = buildCsp();

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF 防护：SameSite=Lax 挡掉了跨站表单提交，这一层再对带 Origin 的写请求
// 做一次同源校验。不带 Origin 的请求（curl、服务端调用）放行 —— 它们不受 CSRF 影响，
// 因为攻击者无法让受害者的浏览器"不带 Origin 地"发起请求。
function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('Origin');
  if (!origin || origin === 'null') return next();

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: '请求来源无效' });
  }

  const host = req.get('Host');
  if (originHost !== host) {
    return res.status(403).json({ error: '跨站请求被拒绝' });
  }
  next();
}

module.exports = { securityHeaders, originCheck };
