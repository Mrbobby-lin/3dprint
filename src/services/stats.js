'use strict';

const { db } = require('../../db');
const statusMachine = require('./statusMachine');

// 中国自 1991 年起不再使用夏令时，+08:00 是一个常量，所以这里直接算偏移。
//
// 为什么不用 new Date(y, m, 1) 配 systemd 的 TZ=Asia/Shanghai：那样正确性
// 依赖服务器装了 tzdata，缺了会静默退回 UTC —— 月初 00:00–08:00 接的单会被
// 算进上个月，而且没有任何报错。更麻烦的是备份 cron 跑在 systemd 之外，拿的是
// 主机时区，同一台机器会出现两套"今天"。固定偏移把这些依赖全消掉。
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

function toIsoSecond(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 北京时间下 now 所在自然月的半开区间 [from, to)。
 * 返回值是 ISO8601 UTC 字符串，格式和 orders.created_at 一致，
 * 这样 SQL 里的字符串比较才等价于时间比较。
 */
function monthRange(now = new Date()) {
  const cn = new Date(now.getTime() + CN_OFFSET_MS);
  const y = cn.getUTCFullYear();
  const m = cn.getUTCMonth();
  return {
    from: toIsoSecond(new Date(Date.UTC(y, m, 1) - CN_OFFSET_MS)),
    to: toIsoSecond(new Date(Date.UTC(y, m + 1, 1) - CN_OFFSET_MS)),
    label: `${y}-${String(m + 1).padStart(2, '0')}`,
  };
}

// 终态占位符按 TERMINAL 动态生成，不写死两个 ——
// 以后多一个终态，这里的"未交付"口径会自动跟上。
const TERMINAL = [...statusMachine.TERMINAL];
const TERMINAL_PLACEHOLDERS = TERMINAL.map((_, i) => `@terminal${i}`).join(', ');

const BINDINGS = {
  revenue: statusMachine.REVENUE_STATUS,
  // 和 statusMachine.STATUSES 里的取值一致。写成绑定参数而不是 SQL 字面量，
  // 是为了让所有状态名都在一眼能看到的同一个对象里。
  printing: 'printing',
  ...Object.fromEntries(TERMINAL.map((s, i) => [`terminal${i}`, s])),
};

// 所有 SUM 都要 COALESCE：空表时 SUM 返回 NULL，前端拿到 null 会显示成 "—"。
//
// delivered_unpriced 是刻意加的：SUM(CASE WHEN ... THEN price END) 会静默跳过
// 报价为 NULL 的已交付订单，营业额少算了却不报错。有这个计数，界面才能明说
// "另有 N 单没填报价，没算进来"。
const SQL = `
  SELECT
    COUNT(*) AS order_count,
    COALESCE(SUM(CASE WHEN status = @revenue THEN price END), 0)                       AS revenue_total,
    COALESCE(SUM(CASE WHEN status = @revenue AND created_at >= @m0 AND created_at < @m1
                      THEN price END), 0)                                                AS revenue_month,
    COALESCE(SUM(CASE WHEN status = @revenue AND price IS NULL THEN 1 ELSE 0 END), 0)   AS delivered_unpriced,
    COALESCE(SUM(CASE WHEN status = @revenue THEN 1 ELSE 0 END), 0)                     AS delivered_count,
    COALESCE(SUM(CASE WHEN status NOT IN (${TERMINAL_PLACEHOLDERS}) THEN 1 ELSE 0 END), 0) AS undelivered,
    COALESCE(SUM(CASE WHEN created_at >= @m0 AND created_at < @m1 THEN 1 ELSE 0 END), 0) AS created_month,
    COALESCE(SUM(CASE WHEN status = @printing THEN 1 ELSE 0 END), 0)                    AS printing_count
  FROM orders
`;

/**
 * 首页看板数据。
 *
 * 口径：「本月」按接单时间（created_at）归属，且只有已交付的订单算营业额。
 * 两条合起来的正常结果是：本月接了但还没交付的单不计入本月收入，
 * 而本月交付的旧单会计入它接单的那个月 —— 所以历史月份的数字会随后续交付变化。
 */
function summary({ now = new Date() } = {}) {
  const month = monthRange(now);
  const row = db.prepare(SQL).get({ ...BINDINGS, m0: month.from, m1: month.to });

  // 把月份边界一并返回：前端要据此把卡片标成"本月"，
  // 数字对不上时也能直接在响应里看到用的是哪段时间。
  return { ...row, month };
}

module.exports = { monthRange, summary };
