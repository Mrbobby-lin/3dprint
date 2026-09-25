'use strict';

const { db, tx } = require('../../db');
const logger = require('../lib/logger');
const { AppError } = require('../middleware/errorHandler');

// 只有登记在这里的键才允许读写。表是通用的键值对，
// 入口必须收窄，否则任何来源的脏数据都会原样送到前端。
const SCHEMA = {
  default_unit_price: { label: '默认单价（元/克）', min: 0, max: 10000 },
};

// 没有默认值 —— 未设置时是 null，不是 0。
// 0 是一个合法报价，如果默认成 0，新建订单的报价框会被自动填成 ¥0.00，
// 库里就再也分不出"还没报价"和"报了零元"这两种情况。
const UNSET = null;

function parseStored(key, raw) {
  if (raw === null || raw === undefined || raw === '') return UNSET;
  const n = Number(raw);
  if (!Number.isFinite(n)) return UNSET;
  const spec = SCHEMA[key];
  if (n < spec.min || n > spec.max) return UNSET;
  return n;
}

/**
 * 读取全部设置。认识但不存在的键返回 null。
 * 存储值损坏（手改过库、写入时被截断）时退回 null 而不是抛错 ——
 * 一个坏设置不该让整个后台打不开。
 */
function all() {
  const stored = new Map(
    db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])
  );

  const out = {};
  for (const key of Object.keys(SCHEMA)) {
    out[key] = parseStored(key, stored.has(key) ? stored.get(key) : null);
  }
  return out;
}

function get(key) {
  return all()[key];
}

/**
 * 更新设置。null 或空字符串表示"清除该项"，会把行删掉而不是存一个空值 ——
 * 存空串的话 get 时还要再判一次，而且库里会出现两种"没设置"的表示。
 */
function update(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AppError(400, '请求内容为空');
  }

  const keys = Object.keys(patch);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
      throw new AppError(400, `未知的设置项：${key}`);
    }
  }
  if (keys.length === 0) throw new AppError(400, '没有需要更新的内容');

  const values = {};
  for (const key of keys) {
    const spec = SCHEMA[key];
    const raw = patch[key];

    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      values[key] = UNSET;
      continue;
    }

    // 必须先卡类型再转数字。Number(true) === 1、Number([5]) === 5，
    // 只判断 Number.isFinite(Number(v)) 的话这两个都会被当成合法单价存进去。
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      throw new AppError(400, `${spec.label}必须是数字`);
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) throw new AppError(400, `${spec.label}必须是数字`);
    if (n < spec.min || n > spec.max) {
      throw new AppError(400, `${spec.label}需要在 ${spec.min} 到 ${spec.max} 之间`);
    }
    values[key] = n;
  }

  tx(() => {
    for (const [key, value] of Object.entries(values)) {
      if (value === UNSET) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        continue;
      }
      db.prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (@key, @value, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET
           value      = excluded.value,
           -- 列的 DEFAULT 只在 INSERT 时生效，这里必须显式再写一次，
           -- 否则第二次保存的时间戳不会变。
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
      ).run({ key, value: String(value) });
    }
  });

  // 单价会影响之后所有报价，留一条改动记录便于回溯
  logger.info('设置已更新', { changes: values });

  return all();
}

module.exports = { SCHEMA, all, get, update };
