'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// 用 Node 内置的 .env 加载，避免引入 dotenv 依赖（Node >= 20.6）
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.error(`[config] 无法加载 ${envFile}: ${err.message}`);
  }
}

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// cookie 的 Secure 标志，必须和 NODE_ENV 解耦。
//
// 默认跟随生产环境（HTTPS 部署下的正确行为），但允许显式关闭，用于
// "只有 IP、还没有证书" 的过渡期。这不是可有可无的开关：带 Secure 的 cookie，
// 浏览器拒绝在任何 HTTP 连接上回传，表现为登录接口返回 200 成功、
// 紧接着下一个请求就是 401 —— 看起来像登录坏了，实际跟登录毫无关系。
const cookieSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE.trim().toLowerCase() === 'true'
  : isProd;

function resolveFromRoot(p, fallback) {
  const value = p && p.trim() ? p.trim() : fallback;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  root: ROOT,
  isProd,
  isTest,
  cookieSecure,
  port: intEnv('PORT', 3000),
  // 默认只绑回环。生产环境必须如此：绑 0.0.0.0 的话 Node 会直接暴露在公网，
  // 请求可以绕过 Nginx —— 连带绕过它的限流和 /storage/ 保险丝，
  // 而且这条路径不会有任何报错，只有端口扫描才会发现。
  host: process.env.HOST || '127.0.0.1',
  dbFile: resolveFromRoot(process.env.DB_FILE, 'data/app.db'),
  storageDir: resolveFromRoot(process.env.STORAGE_DIR, 'storage'),
  sessionSecret: process.env.SESSION_SECRET || '',
  allowAdminRegistration: (process.env.ALLOW_ADMIN_REGISTRATION || 'false').toLowerCase() === 'true',
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
  maxOrderAttachmentBytes: intEnv('MAX_ORDER_ATTACHMENT_BYTES', 200 * 1024 * 1024),
  storageWatermarkPercent: intEnv('STORAGE_WATERMARK_PERCENT', 90),
};

config.storageTmpDir = path.join(config.storageDir, 'tmp');
config.backupDir = path.join(path.dirname(config.dbFile), 'backups');

// 会话密钥是整套鉴权体系的根。缺失时直接拒绝启动，而不是退化成一个默认值 ——
// 一个硬编码的默认密钥等于没有签名，任何人都能伪造管理员 cookie。
if (!config.sessionSecret || config.sessionSecret === 'CHANGE_ME_64_HEX_CHARS') {
  if (isProd) {
    console.error(
      '[config] 致命错误：生产环境必须设置 SESSION_SECRET。\n' +
        '  生成方式： node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    process.exit(1);
  }
  // 开发环境用进程级随机密钥：重启即失效，但绝不会在生产环境静默生效
  config.sessionSecret = require('node:crypto').randomBytes(32).toString('hex');
  if (!process.env.SESSION_SECRET) {
    console.warn('[config] 未设置 SESSION_SECRET，开发模式使用临时随机密钥（重启后所有会话失效）');
  }
}

if (config.sessionSecret.length < 32) {
  console.error('[config] 致命错误：SESSION_SECRET 长度不足 32 字符。');
  process.exit(1);
}

// 生产环境明文跑 HTTP 是允许的（过渡期），但绝不能是无声的。
// 这段会进 journalctl，出问题时是第一手线索。
if (isProd && !cookieSecure) {
  console.warn(
    '\n' +
      '='.repeat(72) +
      '\n[config] 警告：COOKIE_SECURE=false —— 正在以明文 HTTP 提供登录服务\n' +
      '  管理员密码、管理员与客户的会话 cookie 会明文经过公网。\n' +
      '  链路上任何一跳（运营商、机房、公共 WiFi）都能读取并冒充管理员。\n' +
      '  仅可用于拿到 HTTPS 之前的临时上线，不要在此时录入真实客户订单。\n' +
      '  拿到证书后：把 .env 的 COOKIE_SECURE 改为 true 并重启服务。\n' +
      '='.repeat(72) +
      '\n'
  );
}

module.exports = config;
