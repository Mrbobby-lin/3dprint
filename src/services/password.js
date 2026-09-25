'use strict';

const crypto = require('node:crypto');

// scrypt 是 Node 内置的，省掉 bcrypt 依赖，安全性等价。
// N=2^15 时单次哈希约 100ms —— 对管理员登录完全无感，
// 但让离线爆破的成本提高约 3 万倍。
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

// 必须显式抬高 maxmem：默认上限 32MB，而 N=32768,r=8 需要 128*N*r = 32MB，
// 恰好触顶后抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
const MAXMEM = 128 * 1024 * 1024;

const MIN_PASSWORD_LENGTH = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }

  let derived;
  try {
    derived = crypto.scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// 返回 null 表示通过，否则返回给用户看的中文原因
function validatePasswordStrength(password) {
  if (typeof password !== 'string') return '密码格式不正确';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (password.length > 200) return '密码过长';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return '密码需要同时包含字母和数字';
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, validatePasswordStrength, MIN_PASSWORD_LENGTH };
