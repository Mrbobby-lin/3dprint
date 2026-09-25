'use strict';

/**
 * 首页看板的统计口径。
 *
 * 最容易悄悄出错的两件事，这里都钉住了：
 *   1. 月份边界 —— 算错的话订单会被归进相邻的月份，数字看着合理但是错的
 *   2. 报价为 NULL 的已交付订单 —— SUM 会跳过它，营业额少算了却没有任何报错
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  setupTestEnv,
  startServer,
  createClient,
  registerAdmin,
  loginAdmin,
  createOrder,
} = require('./helpers');

const ROOT = path.join(__dirname, '..');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let server;
let baseUrl;
let client;
let db;
let stats;

before(async () => {
  setupTestEnv('stats');
  ({ server, baseUrl } = await startServer());
  ({ db } = require('../db'));
  stats = require('../src/services/stats');

  client = createClient(baseUrl);
  await registerAdmin(client);
  await loginAdmin(client);
});

after(async () => {
  await server.close();
});

/* ---------------------------------------------------------------------------
   月份边界：纯函数，用写死的字面量断言
   --------------------------------------------------------------------------- */

test('monthRange 按北京时间切月', () => {
  const cases = [
    // [now, from, to, label]
    ['2026-09-24T13:46:54Z', '2026-08-31T16:00:00Z', '2026-09-30T16:00:00Z', '2026-09'],
    // 北京时间 9 月 1 日 08:00，刚跨进 9 月
    ['2026-09-01T00:00:00Z', '2026-08-31T16:00:00Z', '2026-09-30T16:00:00Z', '2026-09'],
    // 北京时间 8 月 31 日 23:59:59，还是 8 月
    ['2026-08-31T15:59:59Z', '2026-07-31T16:00:00Z', '2026-08-31T16:00:00Z', '2026-08'],
    // 跨年
    ['2026-01-01T00:00:00Z', '2025-12-31T16:00:00Z', '2026-01-31T16:00:00Z', '2026-01'],
  ];

  for (const [now, from, to, label] of cases) {
    const r = stats.monthRange(new Date(now));
    assert.equal(r.from, from, `${now} 的月份起点不对`);
    assert.equal(r.to, to, `${now} 的月份终点不对`);
    assert.equal(r.label, label, `${now} 的月份标签不对`);
  }
});

const CHILD_SCRIPT = `
const stats = require('./src/services/stats');
process.stdout.write(JSON.stringify(stats.monthRange(new Date('2026-09-24T13:46:54Z'))));
`;

function monthRangeInChild(tz) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3tz-'));
  const res = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TZ: tz,
      SESSION_SECRET: 'a'.repeat(64),
      DB_FILE: path.join(dir, 'test.db'),
      STORAGE_DIR: path.join(dir, 'storage'),
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `子进程（TZ=${tz}）失败：${res.stderr}`);
  return res.stdout.trim();
}

test('月份边界与服务器时区无关', () => {
  // 同进程里改 TZ 测不到东西（Node 缓存了时区），必须另起进程。
  // 取 UTC+14 和 UTC-4 两个极端，任何依赖系统时区的实现都会在这里露馅。
  const zones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati'];
  const results = zones.map(monthRangeInChild);

  for (let i = 1; i < results.length; i += 1) {
    assert.equal(results[i], results[0], `${zones[i]} 与 ${zones[0]} 算出的月份不一致`);
  }
  assert.equal(JSON.parse(results[0]).from, '2026-08-31T16:00:00Z');
});

test('stats.js 里没有本地时间构造器', () => {
  // 防止以后有人"顺手"改回 new Date(y, m, 1) —— 那样结果会随服务器时区漂移，
  // 而且在本机（UTC+8）测试完全正常，只有上线后才出错。
  //
  // 先去掉注释再扫：注释里正大光明地写着被禁的写法（就是在解释为什么不那么做），
  // 不剥掉的话这个测试会被自己的说明文字绊倒。
  const src = fs
    .readFileSync(path.join(ROOT, 'src', 'services', 'stats.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const forbidden = [
    /new Date\(\s*y\s*,/,
    /\.getMonth\(/,
    /\.getFullYear\(/,
    /\.getDate\(/,
    /\.getHours\(/,
    /toLocaleString/,
    /toLocaleDateString/,
  ];

  for (const pattern of forbidden) {
    assert.ok(!pattern.test(src), `stats.js 里出现了本地时间 API ${pattern}`);
  }
});

/* ---------------------------------------------------------------------------
   聚合口径
   --------------------------------------------------------------------------- */

function insertOrder(orderNo, status, price, createdAt) {
  db.prepare(
    `INSERT INTO orders (order_no, customer_name, customer_phone, model_name, material,
                         price, status, created_at, updated_at)
     VALUES (?, '测试客户', '13800138000', '测试模型', 'PLA', ?, ?, ?, ?)`
  ).run(orderNo, price, status, createdAt, createdAt);
}

test('空库返回 0 而不是 null', () => {
  // 必须在任何订单写入之前跑 —— 先确认表确实是空的，
  // 否则下面的断言会莫名其妙地失败（改了顺序也能立刻看出来）
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0, '订单表不是空的，本测试需要空库');

  // SUM 在没有匹配行时返回 NULL，前端 formatMoney(null) 会显示成 "—"
  const s = stats.summary({ now: new Date('2026-09-15T00:00:00Z') });
  for (const key of [
    'order_count',
    'revenue_total',
    'revenue_month',
    'delivered_count',
    'delivered_unpriced',
    'undelivered',
    'created_month',
    'printing_count',
  ]) {
    assert.equal(typeof s[key], 'number', `${key} 不是数字`);
    assert.equal(s[key], 0, `${key} 应为 0，实际是 ${s[key]}`);
  }
});

test('summary 按接单时间归属月份，且只有已交付才算营业额', () => {
  // 北京时间 2026 年 9 月 = UTC [2026-08-31T16:00:00Z, 2026-09-30T16:00:00Z)
  insertOrder('3D-TEST-0001-0001', 'delivered', 1, '2026-08-31T15:59:59Z'); // 差一秒，属 8 月
  insertOrder('3D-TEST-0002-0002', 'delivered', 2, '2026-08-31T16:00:00Z'); // 正好卡在月初
  insertOrder('3D-TEST-0003-0003', 'delivered', 4, '2026-09-30T15:59:59Z'); // 月末最后一秒
  insertOrder('3D-TEST-0004-0004', 'delivered', 8, '2026-09-30T16:00:00Z'); // 差一秒，属 10 月
  insertOrder('3D-TEST-0005-0005', 'printing', 1000, '2026-09-10T00:00:00Z');
  insertOrder('3D-TEST-0006-0006', 'cancelled', 500, '2026-07-01T00:00:00Z');
  insertOrder('3D-TEST-0007-0007', 'delivered', null, '2026-09-05T00:00:00Z');

  const s = stats.summary({ now: new Date('2026-09-15T00:00:00Z') });

  assert.equal(s.month.from, '2026-08-31T16:00:00Z');
  assert.equal(s.month.to, '2026-09-30T16:00:00Z');
  assert.equal(s.month.label, '2026-09');

  assert.equal(s.order_count, 7);
  // 只有已交付算钱：1+2+4+8，没填报价那条被 SUM 跳过
  assert.equal(s.revenue_total, 15);
  // 落在本月的只有 2 和 4
  assert.equal(s.revenue_month, 6);
  assert.equal(s.delivered_count, 5);
  // 被 SUM 跳过的那一单必须能被看见，否则钱少算了也没人知道
  assert.equal(s.delivered_unpriced, 1);
  // 「未交付」含打印中；已取消不是"还没交付"，是"不做了"
  assert.equal(s.undelivered, 1);
  assert.equal(s.created_month, 4);
  assert.equal(s.printing_count, 1);
});

test('所有写入路径产生的 created_at 都是 ISO8601 UTC 秒精度', async () => {
  // 整个聚合依赖这些字符串能按字典序比较。插一行 '2026-09-24 12:00:00'
  // （没有 T、没有 Z）会让它排在所有正常值之后，静默算错。
  await createOrder(client, { model_name: '格式检查' });

  const rows = db.prepare('SELECT order_no, created_at, updated_at FROM orders').all();
  assert.ok(rows.length >= 8, '没有取到订单行，检查插入是否成功');

  for (const row of rows) {
    assert.match(row.created_at, ISO_RE, `${row.order_no} 的 created_at：${row.created_at}`);
    assert.match(row.updated_at, ISO_RE, `${row.order_no} 的 updated_at：${row.updated_at}`);
  }
});

/* ---------------------------------------------------------------------------
   接口
   --------------------------------------------------------------------------- */

test('未登录访问 /api/admin/stats 返回 401', async () => {
  const anon = createClient(baseUrl);
  const res = await anon.get('/api/admin/stats');
  assert.equal(res.status, 401);
});

test('GET /api/admin/stats 返回看板数据和月份边界', async () => {
  const res = await client.get('/api/admin/stats');
  assert.equal(res.status, 200);

  const s = res.body.stats;
  for (const key of [
    'order_count',
    'revenue_total',
    'revenue_month',
    'delivered_count',
    'delivered_unpriced',
    'undelivered',
    'created_month',
    'printing_count',
  ]) {
    assert.equal(typeof s[key], 'number', `${key} 缺失或不是数字`);
  }

  // 月份边界要能拿到，前端才能把卡片正确标成"本月"，
  // 数字对不上时也能直接在响应里看到用的是哪段时间
  assert.match(s.month.label, /^\d{4}-\d{2}$/);
  assert.match(s.month.from, ISO_RE);
  assert.match(s.month.to, ISO_RE);
});
