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
    // worker-src 和 manifest-src 目前都能从 default-src 'self' 兜住，
    // 写出来是为了显式：以后谁把 default-src 放开，这两处不会跟着一起被放开。
    "worker-src 'self'",
    "manifest-src 'self'",
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
    // 刻意不用一年的 max-age。这台机器上的是 6 天有效期的 IP 证书
    // （Let's Encrypt 的 shortlived profile），一旦续期失败，
    // 一年的 HSTS 会让浏览器在证书修好之前都拒绝访问、连"继续前往"都不给。
    // 7 天 ≈ 一个续期周期，续期真的坏掉时锁死的时间有上限。
    // 将来换上正式域名和 90 天证书之后，这里可以调回 31536000。
    res.setHeader('Strict-Transport-Security', 'max-age=604800');
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
