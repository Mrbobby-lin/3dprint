'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setupTestEnv, startServer, createClient, registerAdmin, createOrder, sampleOrder } = require('./helpers');

let server;
let admin;

before(async () => {
  setupTestEnv('orders');
  const started = await startServer();
  server = started.server;

  admin = createClient(started.baseUrl);
  await registerAdmin(admin);
});

after(async () => {
  await server.close();
});

test('创建订单返回完整信息，状态为待确认', async () => {
  const order = await createOrder(admin);
  assert.match(order.order_no, /^3D-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  assert.equal(order.status, 'pending_confirm');
  assert.equal(order.customer_name, '张三');
  assert.equal(order.quantity, 2);
  assert.equal(order.need_support, 1);
  assert.equal(order.price, 120);
});

test('订单号格式正确且 100 次生成无重复', async () => {
  const seen = new Set();
  const FORMAT = /^3D-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;

  for (let i = 0; i < 100; i += 1) {
    const order = await createOrder(admin, { model_name: `批量测试件 ${i}` });
    assert.match(order.order_no, FORMAT, `第 ${i} 个订单号格式不符：${order.order_no}`);
    // Crockford 字符集不含 I L O U —— 出现任何一个都说明生成逻辑有问题
    assert.doesNotMatch(order.order_no, /[ILOU]/, `订单号含易混字符：${order.order_no}`);
    seen.add(order.order_no);
  }

  assert.equal(seen.size, 100, '100 次生成出现了重复订单号');
});

test('字段校验', async () => {
  const cases = [
    [{ material: '黄金' }, /材料需要是/],
    [{ customer_phone: 'abc' }, /联系电话/],
    [{ customer_phone: '' }, /联系电话/],
    [{ model_name: '' }, /模型名称/],
    [{ layer_height: 99 }, /层高/],
    [{ infill: 150 }, /填充率/],
    [{ quantity: 0 }, /数量/],
    [{ price: -5 }, /报价/],
    [{ promised_date: '2026/09/30' }, /预计交付日期/],
  ];

  for (const [override, pattern] of cases) {
    const res = await admin.post('/api/admin/orders', sampleOrder(override));
    assert.equal(res.status, 400, `${JSON.stringify(override)} 应被拒绝`);
    assert.match(res.body.error, pattern);
  }
});

test('缺少必填字段时提示"请填写"而不是"格式不正确"', async () => {
  const res = await admin.post('/api/admin/orders', { customer_name: '李四' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /请填写/);
});

test('编辑订单', async () => {
  const order = await createOrder(admin, { model_name: '待修改的件' });

  const res = await admin.patch(`/api/admin/orders/${order.id}`, {
    model_name: '改好名字的件',
    price: 999,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.model_name, '改好名字的件');
  assert.equal(res.body.order.price, 999);
  // 未提交的字段不能被清空
  assert.equal(res.body.order.customer_name, '张三');
  assert.equal(res.body.order.material, 'PETG');
});

test('编辑时同样要走字段校验', async () => {
  const order = await createOrder(admin);
  const res = await admin.patch(`/api/admin/orders/${order.id}`, { material: '黄金' });
  assert.equal(res.status, 400);
});

test('详情接口的 allowedNext 在顶层，前端也必须从顶层读', async () => {
  const order = await createOrder(admin);
  const res = await admin.get(`/api/admin/orders/${order.id}`);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.allowedNext), 'allowedNext 应为顶层数组');

  const values = res.body.allowedNext.map((s) => s.value).sort();
  assert.deepEqual(values, ['cancelled', 'confirmed'], `待确认的下一步不对：${values}`);

  for (const item of res.body.allowedNext) {
    assert.ok(item.value && item.label, `选项缺字段：${JSON.stringify(item)}`);
  }

  // allowedNext 是状态机的产物，不是订单的一列。塞进 order 里迟早和数据库字段混淆。
  assert.equal(res.body.order.allowedNext, undefined, 'allowedNext 不应挂在 order 上');

  // 这条真的写错过：前端读 order.allowedNext 拿到 undefined，
  // 于是「推进状态」面板永远显示"这是终态，订单已结束"。
  // 接口测试发现不了，只有真在浏览器里打开页面才看得见 —— 别再退回去。
  const js = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'admin-order-detail.js'),
    'utf8'
  );
  assert.ok(!/order\.allowedNext/.test(js), 'admin-order-detail.js 又从 order 上读 allowedNext 了');
});

test('状态流转：完整流程走通且历史链条连续', async () => {
  const order = await createOrder(admin);
  const path = ['confirmed', 'queued', 'printing', 'post_processing', 'completed', 'delivered'];

  for (const to of path) {
    const res = await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: to });
    assert.equal(res.status, 200, `迁移到 ${to} 失败：${JSON.stringify(res.body)}`);
    assert.equal(res.body.order.status, to);
  }

  const detail = await admin.get(`/api/admin/orders/${order.id}`);
  const history = detail.body.history;

  // 1 条创建记录 + 6 次流转
  assert.equal(history.length, 7);

  const chain = [
    [null, 'pending_confirm'],
    ['pending_confirm', 'confirmed'],
    ['confirmed', 'queued'],
    ['queued', 'printing'],
    ['printing', 'post_processing'],
    ['post_processing', 'completed'],
    ['completed', 'delivered'],
  ];
  chain.forEach(([from, to], i) => {
    assert.equal(history[i].from_status, from, `第 ${i} 条 from 不连续`);
    assert.equal(history[i].to_status, to, `第 ${i} 条 to 不连续`);
  });
});

test('非法迁移被拒，错误信息里有可选状态', async () => {
  const order = await createOrder(admin);
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });

  const res = await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'delivered' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /不能从/);
  assert.match(res.body.error, /排队中/, '应列出允许的下一个状态');
});

test('允许回退一步（误点状态可恢复）', async () => {
  const order = await createOrder(admin);
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'queued' });

  const back = await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });
  assert.equal(back.status, 200);
  assert.equal(back.body.order.status, 'confirmed');
});

test('强制越级必须填写原因', async () => {
  const order = await createOrder(admin);

  const noNote = await admin.post(`/api/admin/orders/${order.id}/status`, {
    to_status: 'printing',
    force: true,
  });
  assert.equal(noNote.status, 400);
  assert.match(noNote.body.error, /必须填写原因/);

  const withNote = await admin.post(`/api/admin/orders/${order.id}/status`, {
    to_status: 'printing',
    force: true,
    note: '客户现场催单，直接开机',
  });
  assert.equal(withNote.status, 200);
  assert.equal(withNote.body.order.status, 'printing');

  const last = withNote.body.history.at(-1);
  assert.equal(last.note, '客户现场催单，直接开机', '强制原因必须落到历史记录里');
});

test('终态不可再变更，强制也不行', async () => {
  const order = await createOrder(admin);
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'queued' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'printing' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'completed' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'delivered' });

  const plain = await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'printing' });
  assert.equal(plain.status, 400);

  const forced = await admin.post(`/api/admin/orders/${order.id}/status`, {
    to_status: 'printing',
    force: true,
    note: '试试看',
  });
  assert.equal(forced.status, 400, '已交付的订单不应能被强制回退');
});

test('任意非终态都能取消', async () => {
  const order = await createOrder(admin);
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'queued' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'printing' });

  const res = await admin.post(`/api/admin/orders/${order.id}/status`, {
    to_status: 'cancelled',
    note: '客户改主意了',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'cancelled');
});

test('每次状态变更都刷新 updated_at', async () => {
  const order = await createOrder(admin);
  const before = order.updated_at;

  await new Promise((r) => setTimeout(r, 1100)); // 时间戳精度到秒，等一秒才能看出差别
  const res = await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });
  assert.notEqual(res.body.order.updated_at, before);
});

test('后台列表支持状态筛选与搜索', async () => {
  const order = await createOrder(admin, { model_name: '独一无二搜索关键词', customer_phone: '13911112222' });

  const byKeyword = await admin.get('/api/admin/orders?q=独一无二搜索关键词');
  assert.equal(byKeyword.status, 200);
  assert.equal(byKeyword.body.total, 1);
  assert.equal(byKeyword.body.orders[0].id, order.id);

  const byPhone = await admin.get('/api/admin/orders?q=13911112222');
  assert.equal(byPhone.body.total, 1);

  const byNo = await admin.get(`/api/admin/orders?q=${order.order_no}`);
  assert.equal(byNo.body.total, 1);

  const byStatus = await admin.get('/api/admin/orders?status=pending_confirm');
  assert.ok(byStatus.body.total > 0);
  assert.ok(byStatus.body.orders.every((o) => o.status === 'pending_confirm'));
});

test('按电话代查（客户弄丢订单号的补救路径）', async () => {
  const order = await createOrder(admin, { customer_phone: '13755556666' });
  const res = await admin.get('/api/admin/lookup-by-phone?phone=13755556666');
  assert.equal(res.status, 200);
  assert.ok(res.body.orders.some((o) => o.order_no === order.order_no));
});

test('删除订单时历史记录级联清除', async () => {
  const { db } = require('../db');

  const order = await createOrder(admin);
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });

  const before = db
    .prepare('SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ?')
    .get(order.id).n;
  assert.equal(before, 2);

  const res = await admin.del(`/api/admin/orders/${order.id}`);
  assert.equal(res.status, 200);

  const after = db
    .prepare('SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ?')
    .get(order.id).n;
  assert.equal(after, 0, 'ON DELETE CASCADE 未生效 —— 检查 PRAGMA foreign_keys 是否打开');

  assert.equal((await admin.get(`/api/admin/orders/${order.id}`)).status, 404);
});

test('meta 接口提供状态枚举供前端使用', async () => {
  const res = await admin.get('/api/admin/meta');
  assert.equal(res.status, 200);
  assert.equal(res.body.statuses.length, 8);
  assert.deepEqual(
    res.body.statuses.filter((s) => s.terminal).map((s) => s.value).sort(),
    ['cancelled', 'delivered']
  );
  assert.equal(res.body.timeline.length, 7, '时间线不含已取消');
});
