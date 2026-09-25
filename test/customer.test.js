'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestEnv, startServer, createClient, registerAdmin, createOrder } = require('./helpers');
const { normalizeOrderNo, generateOrderNo, isCanonical } = require('../src/services/orderNo');

let server;
let baseUrl;
let admin;
let orderA;
let orderB;

before(async () => {
  setupTestEnv('customer');
  const started = await startServer();
  server = started.server;
  baseUrl = started.baseUrl;

  admin = createClient(baseUrl);
  await registerAdmin(admin);

  orderA = await createOrder(admin, {
    customer_name: '张三',
    customer_phone: '13800138000',
    model_name: '订单A的件',
    admin_note: '内部备注：这个客户砍价很凶',
  });
  orderB = await createOrder(admin, {
    customer_name: '李四',
    customer_phone: '13900139000',
    model_name: '订单B的件',
  });
});

after(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// 归一化（纯函数，不消耗限流额度）
// ---------------------------------------------------------------------------

test('订单号归一化：容忍客户的常见输入错误', () => {
  const canonical = '3D-K7M2-9QX4-TZ3F';
  const variants = [
    canonical,
    canonical.toLowerCase(),
    'k7m2-9qx4-tz3f', // 漏了 3D- 前缀
    'k7m29qx4tz3f',
    ' 3D K7M2 9QX4 TZ3F ', // 用空格代替连字符
    '3d-k7m2-9qx4-tz3f',
    '3D-k7m2-9qx4-tz3f'.toUpperCase(),
  ];

  for (const v of variants) {
    assert.equal(normalizeOrderNo(v), canonical, `未能归一化：${JSON.stringify(v)}`);
  }
});

test('订单号归一化：纠正 Crockford 易混字符', () => {
  // O→0, I/L→1, U→V —— Crockford 字符集里根本没有这几个字母，
  // 所以客户打出来的一定是看错了字形
  assert.equal(normalizeOrderNo('3D-O123-4567-89AB'), '3D-0123-4567-89AB');
  assert.equal(normalizeOrderNo('3D-I123-4567-89AB'), '3D-1123-4567-89AB');
  assert.equal(normalizeOrderNo('3D-L123-4567-89AB'), '3D-1123-4567-89AB');
  assert.equal(normalizeOrderNo('3D-U123-4567-89AB'), '3D-V123-4567-89AB');
});

test('订单号归一化：拒绝无效输入', () => {
  for (const bad of ['', '   ', 'abc', '3D-123', 'x'.repeat(50), null, undefined, 12345, {}]) {
    assert.equal(normalizeOrderNo(bad), null, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('生成的订单号全部是规范格式且不含易混字符', () => {
  for (let i = 0; i < 200; i += 1) {
    const no = generateOrderNo();
    assert.ok(isCanonical(no), `格式不符：${no}`);
    assert.doesNotMatch(no, /[ILOU]/);
  }
});

// ---------------------------------------------------------------------------
// 查询与鉴权
// ---------------------------------------------------------------------------

test('凭订单号查询成功并建立会话', async () => {
  const client = createClient(baseUrl);
  const res = await client.post('/api/customer/lookup', { order_no: orderA.order_no });

  assert.equal(res.status, 200);
  assert.ok(client.cookies.has('p3_cust'));

  // cookie 里只能有内部 id，不能有订单号本身
  const cookieValue = client.cookies.get('p3_cust');
  assert.ok(!cookieValue.includes(orderA.order_no), 'cookie 里不能出现订单号');
  assert.ok(!cookieValue.includes('3D-'), 'cookie 里不能出现订单号片段');
});

test('客户端拿到的订单信息不含内部字段', async () => {
  const client = createClient(baseUrl);
  await client.post('/api/customer/lookup', { order_no: orderA.order_no });

  const res = await client.get('/api/customer/order');
  assert.equal(res.status, 200);

  const raw = res.text;
  // 这是数据泄露的红线，逐字段核对原始响应文本
  assert.ok(!raw.includes(orderA.customer_name), '响应体泄露了客户姓名');
  assert.ok(!raw.includes(orderA.customer_phone), '响应体泄露了客户电话');
  assert.ok(!raw.includes('内部备注'), '响应体泄露了内部备注');
  assert.ok(!('admin_note' in res.body.order), '响应体字段里不应有 admin_note');
  assert.ok(!('customer_name' in res.body.order));
  assert.ok(!('customer_phone' in res.body.order));

  // 该有的信息要有
  assert.equal(res.body.order.order_no, orderA.order_no);
  assert.equal(res.body.order.model_name, '订单A的件');
  assert.equal(res.body.order.price, 120);
});

test('没有 cookie 时客户端接口返回 401', async () => {
  const client = createClient(baseUrl);
  assert.equal((await client.get('/api/customer/order')).status, 401);
  assert.equal((await client.get('/api/customer/order/history')).status, 401);
});

test('接口不接受任何订单参数，只认 cookie', async () => {
  const clientA = createClient(baseUrl);
  await clientA.post('/api/customer/lookup', { order_no: orderA.order_no });

  // 无论怎么塞参数，取到的都必须是自己 cookie 对应的那单
  const attempts = [
    `/api/customer/order?order_id=${orderB.id}`,
    `/api/customer/order?order_no=${orderB.order_no}`,
    `/api/customer/order?id=${orderB.id}`,
  ];

  for (const path of attempts) {
    const res = await clientA.get(path);
    assert.equal(res.status, 200);
    assert.equal(
      res.body.order.order_no,
      orderA.order_no,
      `参数 ${path} 影响了返回结果 —— 存在越权风险`
    );
  }
});

test('用请求体传订单号也不生效', async () => {
  const clientA = createClient(baseUrl);
  await clientA.post('/api/customer/lookup', { order_no: orderA.order_no });

  const res = await clientA.post('/api/customer/order', { order_no: orderB.order_no });
  // POST 没定义，落到 404；关键是它不会返回订单 B
  assert.notEqual(res.body?.order?.order_no, orderB.order_no);
});

test('进度时间线结构完整', async () => {
  const order = await createOrder(admin, { model_name: '时间线测试件' });
  for (const to of ['confirmed', 'queued', 'printing']) {
    await admin.post(`/api/admin/orders/${order.id}/status`, {
      to_status: to,
      note: to === 'printing' ? '已上机' : undefined,
    });
  }

  const client = createClient(baseUrl);
  await client.post('/api/customer/lookup', { order_no: order.order_no });

  const res = await client.get('/api/customer/order/history');
  assert.equal(res.status, 200);

  const { timeline } = res.body;
  assert.equal(timeline.steps.length, 7, '时间线应包含 7 个主流程步骤');
  assert.equal(timeline.current, 'printing');
  assert.equal(timeline.current_label, '打印中');
  assert.equal(timeline.cancelled, null);

  const reached = timeline.steps.filter((s) => s.reached).map((s) => s.status);
  assert.deepEqual(reached, ['pending_confirm', 'confirmed', 'queued', 'printing']);

  const printingStep = timeline.steps.find((s) => s.status === 'printing');
  assert.equal(printingStep.note, '已上机');
  assert.ok(printingStep.at, '已达成步骤必须带时间');
  // 未来的步骤不能有时间
  for (const s of timeline.steps.filter((x) => !x.reached)) {
    assert.equal(s.at, null);
  }
});

test('取消的订单时间线给出取消节点', async () => {
  const order = await createOrder(admin, { model_name: '取消测试件' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });
  await admin.post(`/api/admin/orders/${order.id}/status`, {
    to_status: 'cancelled',
    note: '客户不要了',
  });

  const client = createClient(baseUrl);
  await client.post('/api/customer/lookup', { order_no: order.order_no });

  const res = await client.get('/api/customer/order/history');
  assert.equal(res.body.timeline.current, 'cancelled');
  assert.equal(res.body.timeline.current_label, '已取消');
  assert.ok(res.body.timeline.cancelled, '应携带取消节点');
  assert.equal(res.body.timeline.cancelled.note, '客户不要了');
  // 已取消的订单不应把后续步骤标成已达成
  const reached = res.body.timeline.steps.filter((s) => s.reached).map((s) => s.status);
  assert.deepEqual(reached, ['pending_confirm', 'confirmed']);
});

test('越级变更的原因不进入客户时间线，但管理员查得到', async () => {
  // 常规推进的说明是给客户看的进度描述；越级变更的原因（"客户投诉，破例跳过排队"）
  // 是内部审计记录。两者都存在同一列 note 里，靠 internal 标记区分。
  const order = await createOrder(admin, { model_name: '越级备注测试' });
  await admin.post(`/api/admin/orders/${order.id}/status`, {
    to_status: 'confirmed',
    note: '已确认报价',
  });
  await admin.post(`/api/admin/orders/${order.id}/status`, {
    to_status: 'completed',
    note: '客户投诉，破例跳过排队',
    force: true,
  });

  const client = createClient(baseUrl);
  await client.post('/api/customer/lookup', { order_no: order.order_no });

  const res = await client.get('/api/customer/order/history');
  assert.equal(res.status, 200);

  // 常规说明照常显示
  const confirmed = res.body.timeline.steps.find((s) => s.status === 'confirmed');
  assert.equal(confirmed.note, '已确认报价', '常规进度说明应保留');

  // 越级原因一个字都不能漏给客户
  assert.ok(
    !res.text.includes('客户投诉'),
    '越级变更的内部原因泄露给了客户'
  );
  const completed = res.body.timeline.steps.find((s) => s.status === 'completed');
  assert.equal(completed.note, null, '越级变更的 note 应为空');

  // 管理员那边必须还看得到，否则审计记录就丢了
  const detail = await admin.get(`/api/admin/orders/${order.id}`);
  const forced = detail.body.history.find((h) => h.to_status === 'completed');
  assert.equal(forced.note, '客户投诉，破例跳过排队', '内部审计原因应保留给管理员');
  assert.equal(forced.internal, 1);
});

test('订单被删除后，残留 cookie 查不到东西', async () => {
  const order = await createOrder(admin, { model_name: '待删除件' });
  const client = createClient(baseUrl);
  await client.post('/api/customer/lookup', { order_no: order.order_no });
  assert.equal((await client.get('/api/customer/order')).status, 200);

  await admin.del(`/api/admin/orders/${order.id}`);

  const res = await client.get('/api/customer/order');
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// 限流（放在最后，因为它会把该 IP 的额度耗尽）
// ---------------------------------------------------------------------------

test('订单号查询有频率限制，暴力枚举会被挡住', async () => {
  const client = createClient(baseUrl);
  let sawRateLimit = false;
  let attempts = 0;

  for (let i = 0; i < 40; i += 1) {
    attempts += 1;
    const res = await client.post('/api/customer/lookup', { order_no: orderA.order_no });
    if (res.status === 429) {
      sawRateLimit = true;
      assert.ok(res.headers.get('retry-after'), '429 响应必须带 Retry-After');
      break;
    }
  }

  assert.ok(sawRateLimit, `连打 ${attempts} 次都没触发限流，枚举防护失效`);
  assert.ok(attempts <= 15, `限流触发得太晚（第 ${attempts} 次才触发）`);

  // 额度用尽后，即使拿正确的订单号也进不去
  const denied = await client.post('/api/customer/lookup', { order_no: orderA.order_no });
  assert.equal(denied.status, 429);
});
