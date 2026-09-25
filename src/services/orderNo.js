'use strict';

const crypto = require('node:crypto');

// Crockford Base32：剔除了 I、L、O、U 四个易混字符。
// 密文里不会出现它们，所以客户把 0 打成 O、把 1 打成 I 是可以被纠正回来的。
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAYLOAD_LEN = 12; // 12 * 5 bit = 60 bit 熵，约 1.15e18 种组合
const PREFIX = '3D';

const ALLOWED = new Set(ALPHABET);

// 12 字符全部由 randomBytes 逐字节 & 31 得到。
// 256 / 32 = 8 整除，所以取模没有偏置 —— 每个字符严格 1/32 概率，
// 60 bit 熵是实打实的。（如果字符集不是 2 的幂，就必须改用拒绝采样。）
function generateOrderNo() {
  const bytes = crypto.randomBytes(PAYLOAD_LEN);
  let payload = '';
  for (let i = 0; i < PAYLOAD_LEN; i += 1) payload += ALPHABET[bytes[i] & 31];
  return formatOrderNo(payload);
}

function formatOrderNo(payload) {
  return `${PREFIX}-${payload.slice(0, 4)}-${payload.slice(4, 8)}-${payload.slice(8, 12)}`;
}

// 让客户输错也能查到：大小写、分隔符、易混字符、漏掉 3D- 前缀，统统接受。
// 归一化失败返回 null（调用方一律返回"订单号不存在"，不区分格式错误与查无此单，
// 避免给枚举者任何反馈信号）。
function normalizeOrderNo(input) {
  if (typeof input !== 'string') return null;

  let s = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '') // 去掉空格、连字符、全角符号等一切非字母数字
    // Crockford 纠正映射。四个字符互不重叠，所以三条规则先后无所谓
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');

  let payload;
  if (s.length === PAYLOAD_LEN + PREFIX.length && s.startsWith(PREFIX)) {
    payload = s.slice(PREFIX.length);
  } else if (s.length === PAYLOAD_LEN) {
    // 客户漏了前缀。注意不能盲目补前缀：一段 12 位原文可能本身就以 "3D" 开头，
    // 靠长度区分可以避免这种歧义。
    payload = s;
  } else {
    return null;
  }

  for (const ch of payload) {
    if (!ALLOWED.has(ch)) return null;
  }

  return formatOrderNo(payload);
}

// 用于按前缀限流之类的场景，不做也不该做完整还原
function isCanonical(orderNo) {
  return typeof orderNo === 'string' && /^3D-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(orderNo);
}

module.exports = {
  ALPHABET,
  PAYLOAD_LEN,
  generateOrderNo,
  normalizeOrderNo,
  formatOrderNo,
  isCanonical,
};
