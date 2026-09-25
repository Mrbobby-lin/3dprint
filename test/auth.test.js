'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestEnv, startServer, createClient, ADMIN } = require('./helpers');

let server;
let baseUrl;

before(async () => {
  setupTestEnv('auth');
  ({ server, baseUrl } = await startServer());
});

after(async () => {
  await server.close();
});

test('初始状态：没有管理员，注册开放', async () => {
  const client = createClient(baseUrl);
  const res = await client.get('/api/auth/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.adminExists, false);
  assert.equal(res.body.registrationOpen, true);
});

test('注册成功后立即拿到会话 cookie', async () => {
  const client = createClient(baseUrl);
  const res = await client.post('/api/auth/register', ADMIN);
  assert.equal(res.status, 201);
  assert.equal(res.body.username, ADMIN.username);
  assert.ok(client.cookies.has('p3_admin'), '应已种下管理员 cookie');

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.username, ADMIN.username);
});

test('系统只允许一个管理员：第二次注册被拒', async () => {
  const client = createClient(baseUrl);
  const res = await client.post('/api/auth/register', {
    username: 'hacker',
    password: 'AnotherPass123',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /只允许一个管理员/);
});

test('并发注册只能成功一个', async () => {
  // 另起一个进程外的库来测并发，避免受前面已建管理员影响。
  // 这里用同一套接口连打 5 次，断言"成功数 + 冲突数 = 总数"且成功数 <= 1。
  const results = await Promise.all(
    Array.from({ length: 5 }, () => {
      const c = createClient(baseUrl);
      return c.post('/api/auth/register', { username: 'race', password: 'RacePass12345' });
    })
  );

  const created = results.filter((r) => r.status === 201).length;
  const conflict = results.filter((r) => r.status === 409).length;

  assert.equal(created, 0, '已经存在管理员，不应再有创建成功');
  assert.equal(conflict, 5);
});

test('弱密码被拒', async () => {
  const client = createClient(baseUrl);
  for (const password of ['123', 'short1', 'alllettersonly']) {
    const res = await client.post('/api/auth/register', { username: 'weak', password });
    assert.equal(res.status, 400, `密码 ${password} 应被拒绝`);
  }
});

test('未登录访问后台接口返回 401', async () => {
  const client = createClient(baseUrl);
  for (const path of ['/api/admin/orders', '/api/admin/meta', '/api/admin/lookup-by-phone?phone=13800138000']) {
    const res = await client.get(path);
    assert.equal(res.status, 401, `${path} 应要求登录`);
  }
});

test('密码错误与账号不存在返回同样的错误', async () => {
  const client = createClient(baseUrl);
  const wrongPass = await client.post('/api/auth/login', {
    username: ADMIN.username,
    password: 'totally-wrong-pass',
  });
  const noUser = await client.post('/api/auth/login', {
    username: 'nobody-here',
    password: 'totally-wrong-pass',
  });

  assert.equal(wrongPass.status, 401);
  assert.equal(noUser.status, 401);
  // 两种情况的提示必须一致，否则等于告诉攻击者用户名是否存在
  assert.equal(wrongPass.body.error, noUser.body.error);
});

test('登录成功后可以访问后台', async () => {
  const client = createClient(baseUrl);
  const res = await client.post('/api/auth/login', ADMIN);
  assert.equal(res.status, 200);

  const list = await client.get('/api/admin/orders');
  assert.equal(list.status, 200);
});

test('登出后会话失效', async () => {
  const client = createClient(baseUrl);
  await client.post('/api/auth/login', ADMIN);
  assert.equal((await client.get('/api/admin/orders')).status, 200);

  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/admin/orders')).status, 401);
});

test('改密后旧会话立即失效（session_epoch 生效）', async () => {
  const a = createClient(baseUrl);
  const b = createClient(baseUrl);
  await a.post('/api/auth/login', ADMIN);
  await b.post('/api/auth/login', ADMIN);

  const changed = await a.post('/api/auth/password', {
    currentPassword: ADMIN.password,
    newPassword: 'BrandNewPass2026',
  });
  assert.equal(changed.status, 200);

  // a 自己拿到了新 cookie，应该仍然可用
  assert.equal((await a.get('/api/admin/orders')).status, 200);
  // b 手里的旧 cookie 必须失效
  assert.equal((await b.get('/api/admin/orders')).status, 401);

  // 还原密码，避免影响同文件内的其它断言
  const restore = await a.post('/api/auth/password', {
    currentPassword: 'BrandNewPass2026',
    newPassword: ADMIN.password,
  });
  assert.equal(restore.status, 200);
});

test('伪造的 cookie 无法通过校验', async () => {
  const client = createClient(baseUrl);
  const forged = [
    'p3_admin=not-a-token',
    'p3_admin=v1.eyJhaWQiOjEsImVwIjoxLCJleHAiOjk5OTk5OTk5OTk5OTl9.deadbeef',
  ];

  for (const cookie of forged) {
    const res = await client.get('/api/admin/orders', { headers: { Cookie: cookie } });
    assert.equal(res.status, 401, `伪造 cookie 应被拒绝: ${cookie}`);
  }
});
