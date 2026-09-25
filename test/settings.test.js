'use strict';

/**
 * 后台设置的读写与校验。
 *
 * 两条容易踩的坑，各有一个测试钉住：
 *   1. Number(true) === 1、Number([5]) === 5 —— 只判断 Number.isFinite 的话
 *      布尔和数组会被当成合法单价存进库
 *   2. UPSERT 的 DO UPDATE 分支不写 updated_at 的话，列上的 DEFAULT 不会生效，
 *      第二次保存的时间戳不动
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestEnv, startServer, createClient, registerAdmin, loginAdmin } = require('./helpers');

let server;
let baseUrl;
let client;
let db;
let settings;

before(async () => {
  setupTestEnv('settings');
  ({ server, baseUrl } = await startServer());
  ({ db } = require('../db'));
  settings = require('../src/services/settings');

  client = createClient(baseUrl);
  await registerAdmin(client);
  await loginAdmin(client);
});

after(async () => {
  await server.close();
});

test('全新数据库里没有默认值，是 null 而不是 0', async () => {
  const res = await client.get('/api/admin/settings');
  assert.equal(res.status, 200);
  // 0 是一个合法报价。默认成 0 的话，新建订单会被自动填成 ¥0.00，
  // 库里就再也分不出"还没报价"和"报了零元"
  assert.equal(res.body.settings.default_unit_price, null);
});

test('保存后能读回来，字符串数字会被转成数字', async () => {
  const res = await client.patch('/api/admin/settings', { default_unit_price: '0.55' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.default_unit_price, 0.55);
  assert.equal(typeof res.body.settings.default_unit_price, 'number');

  const read = await client.get('/api/admin/settings');
  assert.equal(read.body.settings.default_unit_price, 0.55);
});

test('每一项都单独返回，不认识历史键值不会被透传', () => {
  // 直接往表里塞一个 SCHEMA 之外的键，模拟手工改库或旧版本遗留
  db.prepare("INSERT INTO settings (key, value) VALUES ('legacy_thing', 'x')").run();
  const all = settings.all();
  assert.equal(all.legacy_thing, undefined);
  assert.equal(all.default_unit_price, 0.55);
});

test('存进去的值坏掉时退回 null，而不是抛错或原样透传', () => {
  // 一个坏设置不该让整个后台打不开
  db.prepare("UPDATE settings SET value = 'abc' WHERE key = 'default_unit_price'").run();
  assert.equal(settings.all().default_unit_price, null);

  db.prepare("UPDATE settings SET value = '99999' WHERE key = 'default_unit_price'").run();
  assert.equal(settings.all().default_unit_price, null, '超出范围的值也应视为无效');
});

test('清空（null 或空字符串）等于关掉这项设置', async () => {
  await client.patch('/api/admin/settings', { default_unit_price: 1.2 });

  const cleared = await client.patch('/api/admin/settings', { default_unit_price: null });
  assert.equal(cleared.body.settings.default_unit_price, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'default_unit_price'").get().n, 0);

  await client.patch('/api/admin/settings', { default_unit_price: 1.2 });
  const blank = await client.patch('/api/admin/settings', { default_unit_price: '   ' });
  assert.equal(blank.body.settings.default_unit_price, null);
});

test('updated_at 在第二次保存时确实变了', async () => {
  await client.patch('/api/admin/settings', { default_unit_price: 0.5 });
  // 手动把时间戳改成很旧的值：如果 DO UPDATE 分支漏写了 updated_at，
  // 列上的 DEFAULT 不会生效，这里读回来还是 2000 年
  db.prepare("UPDATE settings SET updated_at = '2000-01-01T00:00:00Z' WHERE key = 'default_unit_price'").run();

  await client.patch('/api/admin/settings', { default_unit_price: 0.6 });

  const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'default_unit_price'").get();
  assert.equal(row.value, '0.6');
  assert.notEqual(row.updated_at, '2000-01-01T00:00:00Z');
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('非法输入一律 400', async () => {
  const cases = [
    [{ default_unit_price: -1 }, '负数'],
    [{ default_unit_price: 10001 }, '超过上限'],
    [{ default_unit_price: 'abc' }, '字符串'],
    // 这两个是重点：Number(true) === 1、Number([5]) === 5
    [{ default_unit_price: true }, '布尔'],
    [{ default_unit_price: [5] }, '数组'],
    [{ default_unit_price: {} }, '对象'],
    [{ unknown_key: 1 }, '未知设置项'],
    [{}, '空对象'],
  ];

  for (const [payload, name] of cases) {
    const res = await client.patch('/api/admin/settings', payload);
    assert.equal(res.status, 400, `${name} 应被拒绝，实际 ${res.status}`);
    assert.ok(res.body.error, `${name} 应返回错误说明`);
  }

  // 上面这些都没生效
  const read = await client.get('/api/admin/settings');
  assert.equal(read.body.settings.default_unit_price, 0.6);
});

test('未登录读写设置都返回 401', async () => {
  const anon = createClient(baseUrl);
  assert.equal((await anon.get('/api/admin/settings')).status, 401);
  assert.equal((await anon.patch('/api/admin/settings', { default_unit_price: 9 })).status, 401);
});

test('单价跟着 /api/admin/meta 一起返回，订单表单不用再发一次请求', async () => {
  await client.patch('/api/admin/settings', { default_unit_price: 0.42 });
  const res = await client.get('/api/admin/meta');
  assert.equal(res.status, 200);
  assert.equal(res.body.unit_price, 0.42);
});
