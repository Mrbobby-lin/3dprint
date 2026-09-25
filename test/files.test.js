'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  setupTestEnv,
  startServer,
  createClient,
  registerAdmin,
  createOrder,
  binaryStl,
  asciiStl,
  pngBytes,
  fileForm,
} = require('./helpers');

let server;
let baseUrl;
let admin;
let orderA;
let orderB;
let storageDir;

before(async () => {
  const tmp = setupTestEnv('files');
  storageDir = path.join(tmp, 'storage');
  const started = await startServer();
  server = started.server;
  baseUrl = started.baseUrl;

  admin = createClient(baseUrl);
  await registerAdmin(admin);

  orderA = await createOrder(admin, { model_name: '附件测试A' });
  orderB = await createOrder(admin, { model_name: '附件测试B' });
});

after(async () => {
  await server.close();
});

async function uploadAs(client, { buffer, filename, extra = {} }) {
  return client.request('/api/files', {
    method: 'POST',
    form: fileForm(buffer, filename, extra),
  });
}

async function customerFor(order) {
  const client = createClient(baseUrl);
  const res = await client.post('/api/customer/lookup', { order_no: order.order_no });
  assert.equal(res.status, 200, '客户查询订单失败');
  return client;
}

// ---------------------------------------------------------------------------
// 正常上传
// ---------------------------------------------------------------------------

test('管理员上传二进制 STL 成功', async () => {
  const res = await uploadAs(admin, {
    buffer: binaryStl(12),
    filename: 'part.stl',
    extra: { order_id: orderA.id },
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.attachment.uploaded_by, 'admin');
  assert.equal(res.body.attachment.orig_name, 'part.stl');
  assert.equal(res.body.attachment.visibility, 'both');
  assert.ok(res.body.attachment.id);
});

test('管理员上传 ASCII STL 成功', async () => {
  const res = await uploadAs(admin, {
    buffer: asciiStl(),
    filename: 'ascii-part.stl',
    extra: { order_id: orderA.id },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('上传 PNG 成功且标记为可预览', async () => {
  const res = await uploadAs(admin, {
    buffer: pngBytes(),
    filename: 'preview.png',
    extra: { order_id: orderA.id },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.attachment.previewable, true);
});

// ---------------------------------------------------------------------------
// 类型与内容校验 —— 改名绕过是这里的关键
// ---------------------------------------------------------------------------

test('拒绝可执行文件与网页文件', async () => {
  const payload = Buffer.from('#!/bin/sh\nrm -rf /\n');
  for (const name of ['evil.exe', 'evil.sh', 'evil.html', 'evil.js', 'evil.svg', 'evil.php']) {
    const res = await uploadAs(admin, { buffer: payload, filename: name, extra: { order_id: orderA.id } });
    assert.equal(res.status, 400, `${name} 应被拒绝`);
    assert.match(res.body.error, /不支持的文件类型/);
  }
});

test('改名绕过：把可执行文件叫成 .stl 也进不来', async () => {
  // Windows PE 头 MZ
  const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
  const res = await uploadAs(admin, { buffer: pe, filename: 'trojan.stl', extra: { order_id: orderA.id } });
  assert.equal(res.status, 400, '内容校验没拦住改名的可执行文件');
});

test('改名绕过：文本内容叫成 .png 也进不来', async () => {
  const res = await uploadAs(admin, {
    buffer: Buffer.from('<html><script>alert(1)</script></html>'),
    filename: 'fake.png',
    extra: { order_id: orderA.id },
  });
  assert.equal(res.status, 400);
});

test('改名绕过：普通 zip 叫成 .3mf 也进不来', async () => {
  // ZIP 魔数正确，但没有 3MF 规范要求的 [Content_Types].xml
  const zip = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('random zip payload without content types'),
    Buffer.alloc(200, 0),
  ]);
  const res = await uploadAs(admin, { buffer: zip, filename: 'model.3mf', extra: { order_id: orderA.id } });
  assert.equal(res.status, 400);
});

test('空文件被拒绝', async () => {
  const res = await uploadAs(admin, { buffer: Buffer.alloc(0), filename: 'empty.stl', extra: { order_id: orderA.id } });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

test('原文件名带目录穿越时，落盘路径仍是纯 UUID', async () => {
  const res = await uploadAs(admin, {
    buffer: binaryStl(3),
    filename: '../../../etc/passwd.stl',
    extra: { order_id: orderA.id },
  });

  assert.equal(res.status, 201);
  // 展示名只保留最后一段
  assert.equal(res.body.attachment.orig_name, 'passwd.stl');

  const { db } = require('../db');
  const row = db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(res.body.attachment.id);
  assert.match(row.stored_name, /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.stl$/, `落盘名异常：${row.stored_name}`);
  assert.ok(!row.stored_name.includes('..'));
  assert.ok(!row.stored_name.includes('passwd'));

  // storage/ 目录之外不能有任何东西生成
  const outside = path.join(path.dirname(storageDir), 'etc');
  assert.equal(fs.existsSync(outside), false, '目录穿越真的写到了 storage 外面');
});

test('上传失败时不留下临时文件', async () => {
  await uploadAs(admin, {
    buffer: Buffer.from('MZ not a real stl'),
    filename: 'bad.stl',
    extra: { order_id: orderA.id },
  });

  const tmpDir = path.join(storageDir, 'tmp');
  const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  assert.deepEqual(leftovers, [], `storage/tmp 有残留：${leftovers.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 大小限制
// ---------------------------------------------------------------------------

test('超过单文件上限被拒', async () => {
  const tooBig = Buffer.concat([Buffer.from('solid '), Buffer.alloc(21 * 1024 * 1024, 0x20)]);
  const res = await uploadAs(admin, { buffer: tooBig, filename: 'huge.stl', extra: { order_id: orderA.id } });
  assert.equal(res.status, 413);
});

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

test('未登录不能上传也不能下载', async () => {
  const anon = createClient(baseUrl);

  const up = await uploadAs(anon, { buffer: binaryStl(1), filename: 'x.stl', extra: { order_id: orderA.id } });
  assert.equal(up.status, 403);

  const down = await anon.get('/api/files/1');
  assert.equal(down.status, 403);
});

test('客户只能看到自己订单的附件，且看不到内部附件', async () => {
  const orderC = await createOrder(admin, { model_name: '可视性测试' });

  await uploadAs(admin, {
    buffer: binaryStl(2),
    filename: '客户可见.stl',
    extra: { order_id: orderC.id, visibility: 'both' },
  });
  await uploadAs(admin, {
    buffer: binaryStl(4),
    filename: 'internal-cost-notes.stl',
    extra: { order_id: orderC.id, visibility: 'admin' },
  });

  const customer = await customerFor(orderC);
  const res = await customer.get('/api/customer/order');

  assert.equal(res.status, 200);
  assert.equal(res.body.attachments.length, 1, '客户不应看到内部附件');
  assert.equal(res.body.attachments[0].orig_name, '客户可见.stl');
  assert.ok(!res.text.includes('internal-cost-notes'), '响应体泄露了内部附件名');
});

test('客户不能下载别人订单的附件', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(5),
    filename: 'order-b-file.stl',
    extra: { order_id: orderB.id },
  });
  const attachmentId = up.body.attachment.id;

  const customerA = await customerFor(orderA);
  const res = await customerA.get(`/api/files/${attachmentId}`);
  assert.equal(res.status, 403, '订单A的客户下载到了订单B的附件');

  const adminRes = await admin.get(`/api/files/${attachmentId}`);
  assert.equal(adminRes.status, 200, '管理员应该能下载任意附件');
});

test('客户不能下载 visibility=admin 的附件', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(6),
    filename: 'secret.stl',
    extra: { order_id: orderA.id, visibility: 'admin' },
  });
  const attachmentId = up.body.attachment.id;

  const customerA = await customerFor(orderA);
  assert.equal((await customerA.get(`/api/files/${attachmentId}`)).status, 403);
});

test('客户上传到自己订单：不能指定别人订单，也不能设成内部可见', async () => {
  const customerA = await customerFor(orderA);

  const res = await customerA.request('/api/files', {
    method: 'POST',
    form: fileForm(binaryStl(7), 'client-model.stl', {
      order_id: orderB.id, // 试图往别人订单里塞
      visibility: 'admin', // 试图让自己传的东西变得不可见
    }),
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.attachment.uploaded_by, 'customer');
  assert.equal(res.body.attachment.visibility, 'both', '客户上传的附件必须双方可见');

  const { db } = require('../db');
  const row = db
    .prepare('SELECT order_id FROM attachments WHERE id = ?')
    .get(res.body.attachment.id);
  assert.equal(row.order_id, orderA.id, '客户把文件传到了别人订单上');
});

test('订单进入终态后客户不能再上传', async () => {
  const order = await createOrder(admin, { model_name: '终态上传测试' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'confirmed' });
  await admin.post(`/api/admin/orders/${order.id}/status`, { to_status: 'cancelled' });

  const customer = await customerFor(order);
  const res = await uploadAs(customer, { buffer: binaryStl(8), filename: 'late.stl' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /已结束/);
});

// ---------------------------------------------------------------------------
// 下载响应头
// ---------------------------------------------------------------------------

test('下载响应强制附件形式并禁止 MIME 嗅探', async () => {
  const up = await uploadAs(admin, {
    buffer: pngBytes(),
    filename: 'header-check.png',
    extra: { order_id: orderA.id },
  });

  const res = await admin.get(`/api/files/${up.body.attachment.id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('非图片类型不能走预览接口', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(9),
    filename: 'not-an-image.stl',
    extra: { order_id: orderA.id },
  });
  const res = await admin.get(`/api/files/${up.body.attachment.id}/preview`);
  assert.equal(res.status, 400);
});

test('中文文件名不会乱码', async () => {
  const name = '机械臂关节-最终版.stl';
  const res = await uploadAs(admin, {
    buffer: binaryStl(14),
    filename: name,
    extra: { order_id: orderA.id },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.attachment.orig_name, name, 'multipart 文件名编码处理有误');

  // 下载响应头里的文件名也要能正确编码（非 ASCII 需要 RFC 5987 编码）
  const down = await admin.get(`/api/files/${res.body.attachment.id}`);
  assert.equal(down.status, 200);
  const disposition = down.headers.get('content-disposition');
  assert.ok(disposition.includes('attachment'), '应为附件形式');
  // 要么直接是 UTF-8，要么是 filename*=UTF-8''... 的百分号编码
  const encoded = encodeURIComponent(name);
  assert.ok(
    disposition.includes(encoded) || disposition.includes(encoded.replace(/%/g, '%25')),
    `下载响应头里的文件名丢失：${disposition}`
  );
});

test('管理员可以调整附件可见性', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(15),
    filename: 'toggle.stl',
    extra: { order_id: orderA.id, visibility: 'both' },
  });
  const id = up.body.attachment.id;

  const customer = await customerFor(orderA);
  assert.ok(
    (await customer.get('/api/customer/order')).body.attachments.some((a) => a.id === id),
    '初始应客户可见'
  );

  const hidden = await admin.patch(`/api/files/${id}`, { visibility: 'admin' });
  assert.equal(hidden.status, 200);

  const afterHide = await customer.get('/api/customer/order');
  assert.ok(!afterHide.body.attachments.some((a) => a.id === id), '设为内部后客户仍能看到');
  assert.equal((await customer.get(`/api/files/${id}`)).status, 403, '设为内部后客户仍能下载');

  const restored = await admin.patch(`/api/files/${id}`, { visibility: 'both' });
  assert.equal(restored.status, 200);
  assert.ok(
    (await customer.get('/api/customer/order')).body.attachments.some((a) => a.id === id),
    '恢复可见后客户应能重新看到'
  );
});

test('客户不能调整可见性', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(16),
    filename: 'no-touch.stl',
    extra: { order_id: orderA.id },
  });

  const customer = await customerFor(orderA);
  const res = await customer.patch(`/api/files/${up.body.attachment.id}`, { visibility: 'admin' });
  assert.equal(res.status, 403);
});

test('可见性取值必须合法', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(17),
    filename: 'value-check.stl',
    extra: { order_id: orderA.id },
  });

  for (const bad of ['public', '', null, 'ADMIN', 1]) {
    const res = await admin.patch(`/api/files/${up.body.attachment.id}`, { visibility: bad });
    assert.equal(res.status, 400, `visibility=${JSON.stringify(bad)} 应被拒绝`);
  }
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test('删除附件同时清掉磁盘文件', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(10),
    filename: 'to-delete.stl',
    extra: { order_id: orderA.id },
  });
  const id = up.body.attachment.id;

  const { db } = require('../db');
  const row = db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(id);
  const absPath = path.join(storageDir, 'uploads', row.stored_name);
  assert.ok(fs.existsSync(absPath), '上传后磁盘文件应存在');

  assert.equal((await admin.del(`/api/files/${id}`)).status, 200);
  assert.equal(fs.existsSync(absPath), false, '删除记录后磁盘文件应一并清理');
  assert.equal((await admin.get(`/api/files/${id}`)).status, 404);
});

test('客户不能删除管理员上传的附件', async () => {
  const up = await uploadAs(admin, {
    buffer: binaryStl(11),
    filename: 'admin-owned.stl',
    extra: { order_id: orderA.id },
  });

  const customerA = await customerFor(orderA);
  const res = await customerA.del(`/api/files/${up.body.attachment.id}`);
  assert.equal(res.status, 403);
});

test('删除订单会一并清理该订单的附件文件', async () => {
  const order = await createOrder(admin, { model_name: '级联清理测试' });
  const up = await uploadAs(admin, {
    buffer: binaryStl(13),
    filename: 'cascade.stl',
    extra: { order_id: order.id },
  });

  const { db } = require('../db');
  const row = db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(up.body.attachment.id);
  const absPath = path.join(storageDir, 'uploads', row.stored_name);
  assert.ok(fs.existsSync(absPath));

  await admin.del(`/api/admin/orders/${order.id}`);

  assert.equal(fs.existsSync(absPath), false, '删订单时附件文件变成了孤儿');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE order_id = ?').get(order.id).n,
    0
  );
});
