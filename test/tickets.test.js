'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestEnv, startServer, createClient, registerAdmin, createOrder } = require('./helpers');

let server;
let baseUrl;
let admin;
let orderA;
let orderB;
let customerA;
let customerB;

const TICKET = {
  category: 'quality',
  subject: '支撑印得一塌糊涂',
  body: '模型底部的支撑掰不掉，接触面全留了疤。',
};

before(async () => {
  setupTestEnv('tickets');
  const started = await startServer();
  server = started.server;
  baseUrl = started.baseUrl;

  admin = createClient(baseUrl);
  await registerAdmin(admin);

  orderA = await createOrder(admin, { customer_name: '张三', model_name: '订单A的件' });
  orderB = await createOrder(admin, { customer_name: '李四', model_name: '订单B的件' });

  // 查单接口按 IP 限流（15 分钟 10 次），所以整个文件只做必要的几次 lookup，
  // 后面的用例一律复用这两个已经建立的会话。
  customerA = createClient(baseUrl);
  await customerA.post('/api/customer/lookup', { order_no: orderA.order_no });

  customerB = createClient(baseUrl);
  await customerB.post('/api/customer/lookup', { order_no: orderB.order_no });
});

after(async () => {
  await server.close();
});

async function newTicket(client, overrides = {}) {
  const res = await client.post('/api/customer/tickets', { ...TICKET, ...overrides });
  if (res.status !== 201) throw new Error(`建工单失败 (${res.status}): ${res.text}`);
  return res.body.ticket;
}

// ---------------------------------------------------------------------------
// 客户发起
// ---------------------------------------------------------------------------

test('客户提交工单：状态待处理，正文即线程第一条消息', async () => {
  const res = await customerA.post('/api/customer/tickets', TICKET);

  assert.equal(res.status, 201);
  assert.equal(res.body.ticket.category, 'quality');
  assert.equal(res.body.ticket.category_label, '质量问题');
  assert.equal(res.body.ticket.status, 'open');
  assert.equal(res.body.ticket.status_label, '待处理');
  assert.equal(res.body.ticket.subject, TICKET.subject);

  assert.equal(res.body.messages.length, 1);
  assert.equal(res.body.messages[0].author, 'customer');
  assert.equal(res.body.messages[0].body, TICKET.body);
  assert.ok(res.body.messages[0].created_at, '首条消息应带时间戳');
});

test('工单接口不返回订单与客户内部字段', async () => {
  const res = await customerA.get('/api/customer/tickets');
  assert.equal(res.status, 200);
  assert.ok(res.body.tickets.length >= 1);

  // 显式比对键集合：以后给 tickets 加列时，如果忘了过滤会在这里失败
  assert.deepEqual(
    Object.keys(res.body.tickets[0]).sort(),
    ['category', 'category_label', 'created_at', 'id', 'messages', 'status', 'status_label', 'subject', 'updated_at']
  );
  assert.equal(res.body.tickets[0].customer_name, undefined);
  assert.equal(res.body.tickets[0].order_no, undefined);
  assert.equal(res.body.tickets[0].order_id, undefined);
});

test('没有 cookie 时客户工单接口返回 401', async () => {
  const stranger = createClient(baseUrl);
  assert.equal((await stranger.get('/api/customer/tickets')).status, 401);
  assert.equal((await stranger.post('/api/customer/tickets', TICKET)).status, 401);
  assert.equal((await stranger.post('/api/customer/tickets/1/messages', { body: '在吗' })).status, 401);
});

test('工单分类只接受服务端枚举，且必填项缺失会明确指出', async () => {
  const bad = await customerA.post('/api/customer/tickets', { ...TICKET, category: 'refund' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /问题类型/);

  const noSubject = await customerA.post('/api/customer/tickets', { ...TICKET, subject: '   ' });
  assert.equal(noSubject.status, 400);
  assert.match(noSubject.body.error, /问题标题/);

  const noBody = await customerA.post('/api/customer/tickets', { ...TICKET, body: '' });
  assert.equal(noBody.status, 400);
  assert.match(noBody.body.error, /问题描述/);

  const tooLong = await customerA.post('/api/customer/tickets', {
    ...TICKET,
    subject: '长'.repeat(61),
  });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /60 个字符/);

  // 一条都不该建出来
  const list = await customerA.get('/api/customer/tickets');
  assert.equal(list.body.tickets.length, 1);
});

// ---------------------------------------------------------------------------
// 管理员处理
// ---------------------------------------------------------------------------

test('管理员列表能看到订单号、客户名与各状态条数', async () => {
  const res = await admin.get('/api/admin/tickets');
  assert.equal(res.status, 200);
  assert.ok(res.body.total >= 1);

  const row = res.body.tickets.find((t) => t.order_no === orderA.order_no);
  assert.ok(row, '应能按订单号找到刚提交的工单');
  assert.equal(row.customer_name, '张三');
  assert.equal(row.message_count, 1);
  assert.ok(row.last_message_at);

  assert.equal(typeof res.body.counts.open, 'number');
  assert.ok(res.body.counts.total >= res.body.counts.open);
  assert.deepEqual(
    res.body.categories.map((c) => c.value),
    ['quality', 'delay', 'design', 'other']
  );
});

test('管理员可以按订单号筛出某个订单的工单', async () => {
  // 先给 orderB 也建一条，确保筛选真的在过滤而不是恰好只有一个
  await newTicket(customerB, { subject: '订单B的问题' });

  const res = await admin.get(`/api/admin/tickets?order_id=${orderA.id}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.tickets.length >= 1);
  for (const t of res.body.tickets) {
    assert.equal(t.order_id, orderA.id);
  }
});

test('管理员回复后状态变为已回复，客户追问后回到待处理', async () => {
  const ticket = await newTicket(customerA, { subject: '交期能不能提前' });

  const replied = await admin.post(`/api/admin/tickets/${ticket.id}/messages`, {
    body: '我们加急排一下，周五之前一定发出。',
  });
  assert.equal(replied.status, 201);
  assert.equal(replied.body.ticket.status, 'replied');
  assert.equal(replied.body.ticket.status_label, '已回复');
  assert.equal(replied.body.messages.length, 2);
  assert.equal(replied.body.messages[1].author, 'admin');

  const asked = await customerA.post(`/api/customer/tickets/${ticket.id}/messages`, {
    body: '那就麻烦你们了，谢谢。',
  });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.ticket.status, 'open', '客户追问后应回到待处理');
  assert.equal(asked.body.messages.length, 3);
  assert.equal(asked.body.messages[2].author, 'customer');
});

test('管理员结束工单；客户再追加会自动重新打开', async () => {
  const ticket = await newTicket(customerA, { subject: '已经解决的事项' });

  const closed = await admin.patch(`/api/admin/tickets/${ticket.id}`, { status: 'closed' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.ticket.status, 'closed');
  assert.equal(closed.body.ticket.status_label, '已结束');

  const reopened = await customerA.post(`/api/customer/tickets/${ticket.id}/messages`, {
    body: '又发现问题了。',
  });
  assert.equal(reopened.body.ticket.status, 'open');
});

test('管理员可以重新打开已结束的工单', async () => {
  const ticket = await newTicket(customerA, { subject: '需要重新跟进' });
  await admin.patch(`/api/admin/tickets/${ticket.id}`, { status: 'closed' });

  const reopened = await admin.patch(`/api/admin/tickets/${ticket.id}`, { status: 'open' });
  assert.equal(reopened.body.ticket.status, 'open');
});

test('工单接口的非法状态与非法 ID 都被挡住', async () => {
  const badStatus = await admin.patch('/api/admin/tickets/1', { status: 'archived' });
  assert.equal(badStatus.status, 400);

  assert.equal((await admin.patch('/api/admin/tickets/abc', { status: 'closed' })).status, 400);
  assert.equal((await admin.get('/api/admin/tickets/abc')).status, 400);
  assert.equal((await admin.get('/api/admin/tickets/999999')).status, 404);
});

test('未登录访问管理员工单接口返回 401', async () => {
  const stranger = createClient(baseUrl);
  assert.equal((await stranger.get('/api/admin/tickets')).status, 401);
  assert.equal((await stranger.post('/api/admin/tickets/1/messages', { body: 'x' })).status, 401);
});

// ---------------------------------------------------------------------------
// 越权与边界
// ---------------------------------------------------------------------------

test('客户拿别人的工单 ID 追加消息会被当成不存在', async () => {
  const mine = await newTicket(customerA, { subject: '只有我能看的工单' });

  // customerB 的会话指向 orderB，不能碰 orderA 的工单
  const res = await customerB.post(`/api/customer/tickets/${mine.id}/messages`, {
    body: '我来插一嘴',
  });
  assert.equal(res.status, 404, '不属于自己订单的工单应返回 404 而不是 403');

  const after = await admin.get(`/api/admin/tickets/${mine.id}`);
  assert.equal(after.body.messages.length, 1, '越权消息不能被写进去');
});

test('客户查单页只看到自己订单的工单', async () => {
  const mine = await customerA.get('/api/customer/tickets');
  const other = await customerB.get('/api/customer/tickets');

  const mineIds = new Set(mine.body.tickets.map((t) => t.id));
  for (const t of other.body.tickets) {
    assert.ok(!mineIds.has(t.id), '两个订单的工单不该串场');
  }
});

test('一个订单最多同时 5 个未结束工单', async () => {
  const order = await createOrder(admin, { model_name: '工单上限测试件' });
  const client = createClient(baseUrl);
  await client.post('/api/customer/lookup', { order_no: order.order_no });

  for (let i = 1; i <= 5; i += 1) {
    await newTicket(client, { subject: `第 ${i} 个问题` });
  }

  const sixth = await client.post('/api/customer/tickets', {
    ...TICKET,
    subject: '第 6 个问题',
  });
  assert.equal(sixth.status, 400);
  assert.match(sixth.body.error, /未结束的工单/);

  // 把其中一个结束掉，就应该又能新建了
  const list = await admin.get(`/api/admin/tickets?order_id=${order.id}`);
  await admin.patch(`/api/admin/tickets/${list.body.tickets[0].id}`, { status: 'closed' });

  const okAgain = await client.post('/api/customer/tickets', { ...TICKET, subject: '第 6 个问题' });
  assert.equal(okAgain.status, 201);
});

test('订单被删除后，工单和消息一并消失', async () => {
  const order = await createOrder(admin, { model_name: '待删除的订单' });
  const client = createClient(baseUrl);
  await client.post('/api/customer/lookup', { order_no: order.order_no });

  const ticket = await newTicket(client, { subject: '这个订单马上要被删掉' });
  await admin.post(`/api/admin/tickets/${ticket.id}/messages`, { body: '收到' });

  const before = await admin.get(`/api/admin/tickets/${ticket.id}`);
  assert.equal(before.body.messages.length, 2);

  assert.equal((await admin.del(`/api/admin/orders/${order.id}`)).status, 200);

  assert.equal(
    (await admin.get(`/api/admin/tickets/${ticket.id}`)).status,
    404,
    '订单删除后工单应被级联清掉'
  );

  const list = await admin.get(`/api/admin/tickets?order_id=${order.id}`);
  assert.equal(list.body.tickets.length, 0);

  // cookie 还留着的客户不该拿到 500，而是明确的"订单不在了"
  const stale = await client.get('/api/customer/tickets');
  assert.equal(stale.status, 404);
  assert.match(stale.body.error, /订单不存在/);
});
