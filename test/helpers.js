'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

/**
 * 准备隔离环境。必须在 require('../app') 之前调用 ——
 * config.js 在模块加载时就读环境变量。
 *
 * 注意：Node 的 loadEnvFile 不覆盖已存在的环境变量（实测确认），
 * 所以这里预置的值不会被项目根的 .env 冲掉，测试不会碰到真实数据库。
 */
function setupTestEnv(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p3test-${label}-`));

  process.env.NODE_ENV = 'test';
  process.env.DB_FILE = path.join(dir, 'test.db');
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.ALLOW_ADMIN_REGISTRATION = 'true';
  process.env.PORT = '0';

  return dir;
}

async function startServer() {
  const app = require('../app');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 带 cookie 罐的 HTTP 客户端。Node 的 fetch 不自动管 cookie，所以自己存。
 */
function createClient(baseUrl) {
  const cookies = new Map();

  function cookieHeader() {
    if (cookies.size === 0) return undefined;
    return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function absorb(res) {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      // 过期 cookie 的值为空，等同于清除
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function request(pathname, options = {}) {
    const { method = 'GET', json, form, headers = {} } = options;
    const sendHeaders = { ...headers };

    const cookie = cookieHeader();
    if (cookie) sendHeaders.Cookie = cookie;

    let body;
    if (json !== undefined) {
      sendHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      body = form;
    }

    const res = await fetch(baseUrl + pathname, {
      method,
      headers: sendHeaders,
      body,
      redirect: 'manual',
    });
    absorb(res);

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  return {
    request,
    get: (p, o) => request(p, { ...o, method: 'GET' }),
    post: (p, json, o) => request(p, { ...o, method: 'POST', json }),
    patch: (p, json, o) => request(p, { ...o, method: 'PATCH', json }),
    del: (p, o) => request(p, { ...o, method: 'DELETE' }),
    cookies,
    clearCookies: () => cookies.clear(),
  };
}

const ADMIN = { username: 'boss', password: 'Print3dShop2026' };

async function registerAdmin(client, overrides = {}) {
  return client.post('/api/auth/register', { ...ADMIN, ...overrides });
}

async function loginAdmin(client) {
  return client.post('/api/auth/login', ADMIN);
}

function sampleOrder(overrides = {}) {
  return {
    customer_name: '张三',
    customer_phone: '13800138000',
    model_name: '机械臂关节',
    material: 'PETG',
    color: '黑色',
    layer_height: 0.2,
    infill: 40,
    need_support: true,
    quantity: 2,
    est_weight_g: 85.5,
    price: 120,
    promised_date: '2026-09-30',
    customer_note: '表面尽量打磨光滑',
    admin_note: '老客户，走加急',
    ...overrides,
  };
}

async function createOrder(client, overrides = {}) {
  const res = await client.post('/api/admin/orders', sampleOrder(overrides));
  if (res.status !== 201) {
    throw new Error(`创建订单失败 (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.order;
}

// 构造一个合法的二进制 STL（80 字节头 + 三角形数 + 每个三角形 50 字节）
function binaryStl(triangleCount = 1) {
  const buf = Buffer.alloc(84 + triangleCount * 50);
  buf.write('binary STL made by test suite', 0, 'latin1');
  buf.writeUInt32LE(triangleCount, 80);
  return buf;
}

function asciiStl() {
  return Buffer.from(
    'solid test\n' +
      '  facet normal 0 0 1\n' +
      '    outer loop\n' +
      '      vertex 0 0 0\n' +
      '      vertex 1 0 0\n' +
      '      vertex 0 1 0\n' +
      '    endloop\n' +
      '  endfacet\n' +
      'endsolid test\n',
    'latin1'
  );
}

function pngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0),
  ]);
}

function fileForm(buffer, filename, extra = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  form.append('file', new Blob([buffer]), filename);
  return form;
}

module.exports = {
  setupTestEnv,
  startServer,
  createClient,
  registerAdmin,
  loginAdmin,
  sampleOrder,
  createOrder,
  binaryStl,
  asciiStl,
  pngBytes,
  fileForm,
  ADMIN,
};
