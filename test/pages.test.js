'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setupTestEnv, startServer, createClient } = require('./helpers');

let server;
let baseUrl;
let client;

before(async () => {
  setupTestEnv('pages');
  ({ server, baseUrl } = await startServer());
  client = createClient(baseUrl);
});

after(async () => {
  await server.close();
});

const PAGES = [
  '/',
  '/order',
  '/admin/login',
  '/admin/register',
  '/admin/orders',
  '/admin/order/form',
  '/admin/order/detail',
  '/admin/password',
  '/admin/settings',
];

// 已登录页面共用的顶部导航。加页面时如果忘了同步，
// 用户会看到一个"少了某一项"的后台 —— 这个测试就是拦这个的。
const SIGNED_IN_PAGES = [
  '/admin/orders',
  '/admin/order/form',
  '/admin/order/detail',
  '/admin/password',
  '/admin/settings',
];
const NAV_HREFS = ['/admin/orders', '/admin/order/form', '/admin/settings', '/admin/password'];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

test('所有页面都能正常访问', async () => {
  for (const page of PAGES) {
    const res = await client.get(page);
    assert.equal(res.status, 200, `${page} 返回 ${res.status}`);
    assert.match(res.headers.get('content-type'), /text\/html/, `${page} 不是 HTML`);
  }
});

test('每个页面引用的脚本和样式都真实存在', async () => {
  const referenced = new Set();

  for (const page of PAGES) {
    const res = await client.get(page);
    // favicon 一并纳入：页面引了但文件不存在的话，每个访客的浏览器都会记一条 404
    for (const match of res.text.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+|\/favicon\.svg)"/g)) {
      referenced.add(match[1]);
    }
  }

  assert.ok(referenced.size > 0, '没有解析到任何资源引用，检查页面结构');

  for (const asset of referenced) {
    const res = await client.get(asset);
    assert.equal(res.status, 200, `页面引用了不存在的资源：${asset}`);
  }
});

test('已登录页面的顶部导航完全一致', async () => {
  for (const page of SIGNED_IN_PAGES) {
    const res = await client.get(page);
    const nav = res.text.match(/<nav>([\s\S]*?)<\/nav>/);
    assert.ok(nav, `${page} 里没有 <nav>`);

    for (const href of NAV_HREFS) {
      assert.ok(nav[1].includes(`href="${href}"`), `${page} 的导航里缺少 ${href}`);
    }
    assert.ok(nav[1].includes('id="logout-link"'), `${page} 的导航里缺少退出`);
  }
});

test('页面里没有内联脚本或内联事件处理器', () => {
  // CSP 是 script-src 'self'，任何内联脚本都会被浏览器拒绝执行。
  // 这个约束必须在写页面时就遵守，事后发现要改所有页面。
  const htmlFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) htmlFiles.push(full);
    }
  })(PUBLIC_DIR);

  assert.ok(htmlFiles.length > 0, '没找到任何 HTML 文件');

  for (const file of htmlFiles) {
    const rel = path.relative(PUBLIC_DIR, file);
    const html = fs.readFileSync(file, 'utf8');

    // <script> 必须有 src
    for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
      assert.match(match[0], /\ssrc=/, `${rel} 里有内联 <script>，会被 CSP 拦掉`);
    }

    // 不能有 onclick= / onload= 之类的行内事件
    const inlineHandler = html.match(/\son(click|change|input|submit|load|error|focus|blur)\s*=/i);
    assert.equal(inlineHandler, null, `${rel} 里有行内事件处理器 ${inlineHandler?.[0]}`);

    // style="..." 属性在 style-src 'self' 下同样会被拦掉
    const inlineStyle = html.match(/\sstyle\s*=\s*"/i);
    assert.equal(inlineStyle, null, `${rel} 里有行内 style 属性，会被 CSP 拦掉`);
  }
});

test('前端代码不使用 innerHTML 渲染数据', () => {
  // 客户填的模型名、备注、上传的文件名都是用户输入，
  // innerHTML 拼接就是存储型 XSS。统一走 createElement。
  const jsFiles = fs
    .readdirSync(path.join(PUBLIC_DIR, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(PUBLIC_DIR, 'js', f));

  for (const file of jsFiles) {
    const js = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC_DIR, file);
    assert.ok(!/\.innerHTML\s*=/.test(js), `${rel} 里用了 innerHTML 赋值`);
    assert.ok(!/insertAdjacentHTML/.test(js), `${rel} 里用了 insertAdjacentHTML`);
    assert.ok(!/\bdocument\.write\b/.test(js), `${rel} 里用了 document.write`);
  }
});

test('页面脚本引用的元素 ID 都存在于对应页面', () => {
  // 页面 JS 里 getElementById('x') 拿到的可能是 null，
  // 这类错误只有在真打开页面时才会暴露成 "Cannot read properties of null"。
  // 静态交叉检查能在测试阶段拦住它。
  const pages = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) pages.push(full);
    }
  })(PUBLIC_DIR);

  let checked = 0;

  for (const page of pages) {
    const rel = path.relative(PUBLIC_DIR, page);
    const html = fs.readFileSync(page, 'utf8');
    const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

    const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="(\/js\/[^"]+)"/g)].map((m) => m[1]);

    for (const src of scripts) {
      // api.js 是通用工具，不绑定任何页面元素
      if (src.endsWith('/api.js')) continue;

      const file = path.join(PUBLIC_DIR, src.replace(/^\//, ''));
      if (!fs.existsSync(file)) continue;
      const js = fs.readFileSync(file, 'utf8');

      const referenced = new Set([
        ...[...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
        ...[...js.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
      ]);

      // 表单页的字段名存在数组里，循环调用 el(name)，静态扫描看不到，单独提取
      for (const arr of js.matchAll(/const \w*FIELDS = \[([^\]]+)\]/g)) {
        for (const name of arr[1].matchAll(/'([^']+)'/g)) referenced.add(name[1]);
      }

      for (const id of referenced) {
        checked += 1;
        assert.ok(
          htmlIds.has(id),
          `${rel} 引入了 ${src}，但页面里没有 id="${id}" 的元素`
        );
      }
    }
  }

  // 防止这个测试变成空转：正则一旦失配就会一个引用都扫不到，
  // 那样测试永远通过，却什么也没检查。
  assert.ok(checked >= 30, `只扫描到 ${checked} 个元素引用，正则可能已失效`);
});

test('静态目录不包含 storage 或数据库文件', async () => {
  for (const forbidden of ['/storage/', '/data/', '/.env', '/app.js', '/db/index.js']) {
    const res = await client.get(forbidden);
    assert.equal(res.status, 404, `${forbidden} 可被直接下载`);
  }
});

test('客户详情页没有查询参数（订单号不能出现在 URL 里）', async () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'order.html'), 'utf8');
  assert.ok(!/location\.search/.test(html), 'order.html 不应读取 URL 参数');

  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'order.js'), 'utf8');
  assert.ok(!/qs\(/.test(js), 'order.js 不应从 URL 取参数');
  assert.ok(!/localStorage|sessionStorage/.test(js), 'order.js 不应把订单相关数据存到浏览器存储');
});

test('404 页面与接口返回合适的响应', async () => {
  const page = await client.get('/no-such-page');
  assert.equal(page.status, 404);
  assert.match(page.headers.get('content-type'), /text\/html/);

  const api = await client.get('/api/no-such-endpoint');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /application\/json/);
});
