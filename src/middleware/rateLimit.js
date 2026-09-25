'use strict';

// 内存限流。单实例部署，不引 Redis。
//
// 用固定窗口而不是精确滑动窗口：固定窗口每个键只占 O(1) 内存，
// 配合下面的容量上限可以把内存占用钉死。代价是窗口边界处可能放过 2 倍流量，
// 但对"防止枚举 60 bit 订单号"这个目标来说完全无关紧要 —— 攻击者需要 10^18 次尝试。

const DEFAULT_MAX_KEYS = 10000;

/**
 * @param {object} opts
 * @param {number} opts.windowMs  窗口长度
 * @param {number} opts.max       窗口内允许的请求数
 * @param {number} [opts.maxKeys] Map 容量上限，超出后按 LRU 淘汰
 * @param {(req) => string|null} opts.keyFn  返回 null 表示不限流
 */
function createRateLimiter({ windowMs, max, maxKeys = DEFAULT_MAX_KEYS, keyFn, message }) {
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    let key;
    try {
      key = keyFn(req);
    } catch {
      key = null;
    }
    if (key == null) return next();

    const now = Date.now();
    let bucket = buckets.get(key);
    if (bucket) buckets.delete(key); // 重新插入到末尾，维持 LRU 顺序

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
    }
    bucket.count += 1;
    buckets.set(key, bucket);

    // 容量上限是必须的：没有它，攻击者不断更换 IP / 订单号就能把 Map 撑爆内存。
    // 这也是压测时要重点确认的一点 —— 进程 RSS 不应随攻击键数量线性增长。
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message || '请求过于频繁，请稍后再试' });
    }

    next();
  };
}

// 取真实客户端 IP。前提是 app.set('trust proxy', 'loopback') 且
// Nginx 用 proxy_set_header X-Forwarded-For $remote_addr 覆盖写入。
// 这两处任一配错，req.ip 就是可伪造的，限流形同虚设。
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

module.exports = { createRateLimiter, clientIp };
