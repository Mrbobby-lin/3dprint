'use strict';

const config = require('./config');

const ORDER_NO_RE = /3D-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/g;

// 订单号本身就是客户的密码，不能以明文进日志。
// 保留前 6 位（含 3D- 前缀）便于排查，其余打码。
function redactOrderNo(value) {
  return String(value).replace(ORDER_NO_RE, (m) => `${m.slice(0, 6)}-****-****`);
}

const SECRET_KEYS = /^(password|passwd|secret|token|authorization|cookie|session)$/i;

function redactDeep(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return redactOrderNo(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redactDeep(v, depth + 1);
  }
  return out;
}

// 测试环境下日志会淹没断言输出。设 LOG_VERBOSE=true 可以强制打开。
const VERBOSE = process.env.LOG_VERBOSE === 'true';

function emit(level, msg, meta) {
  if (config.isTest && !VERBOSE && level !== 'error') return;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redactOrderNo(msg),
  };
  if (meta !== undefined) line.meta = redactDeep(meta);
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

module.exports = {
  redactOrderNo,
  redactDeep,
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => {
    if (!config.isProd) emit('debug', msg, meta);
  },
  verboseEnabled: VERBOSE,
};
