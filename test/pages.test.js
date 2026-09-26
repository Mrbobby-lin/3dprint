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
  '/offline',
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
    // favicon、图标和 manifest 一并纳入：页面引了但文件不存在的话，
    // 每个访客的浏览器都会记一条 404（manifest 拿不到还会导致装不了 PWA）
    const RE = /(?:src|href)="(\/(?:js|css|icons)\/[^"]+|\/favicon\.svg|\/(?:admin\/)?manifest\.webmanifest)"/g;
    for (const match of res.text.matchAll(RE)) {
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

/* ---------------------------------------------------------------------------
   PWA
   --------------------------------------------------------------------------- */

test('每个页面都引了 manifest，后台用后台那一份', async () => {
  for (const page of PAGES) {
    const res = await client.get(page);
    // 后台和客户的 start_url 不同，装到主屏幕后打开的位置也不一样，
    // 引错了不会报错，只会"装出来的图标点了没反应"，所以在这里拦住。
    const expected = page.startsWith('/admin')
      ? '/admin/manifest.webmanifest'
      : '/manifest.webmanifest';

    assert.ok(
      res.text.includes(`rel="manifest" href="${expected}"`),
      `${page} 没有引用 ${expected}`
    );
    assert.ok(res.text.includes('rel="apple-touch-icon"'), `${page} 缺少 apple-touch-icon`);
    assert.ok(res.text.includes('name="theme-color"'), `${page} 缺少 theme-color`);
  }
});

test('manifest 内容合法，且引用的图标都存在', async () => {
  for (const file of ['/manifest.webmanifest', '/admin/manifest.webmanifest']) {
    const res = await client.get(file);
    assert.equal(res.status, 200, `${file} 返回 ${res.status}`);
    // MIME 不对的话浏览器直接拒绝解析，而且不会有显眼的报错
    assert.match(
      res.headers.get('content-type'),
      /application\/manifest\+json/,
      `${file} 的 Content-Type 不是 manifest`
    );

    const manifest = JSON.parse(res.text);
    assert.ok(manifest.name, `${file} 缺少 name`);
    assert.ok(manifest.short_name, `${file} 缺少 short_name（主屏幕上的名字）`);
    assert.equal(manifest.display, 'standalone', `${file} 的 display 必须是 standalone`);
    assert.ok(manifest.start_url, `${file} 缺少 start_url`);

    // start_url 不在 scope 内的话浏览器会判定不可安装
    const scope = manifest.scope || '/';
    assert.ok(
      manifest.start_url.startsWith(scope),
      `${file} 的 start_url ${manifest.start_url} 不在 scope ${scope} 内`
    );

    const icons = manifest.icons || [];
    assert.ok(
      icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'),
      `${file} 缺少 maskable 图标，安卓会把图标边缘裁掉`
    );
    assert.ok(
      icons.some((icon) => icon.sizes === '192x192'),
      `${file} 缺少 192×192 图标`
    );

    for (const icon of icons) {
      const iconRes = await client.get(icon.src);
      assert.equal(iconRes.status, 200, `${file} 引用了不存在的图标 ${icon.src}`);
      assert.equal(iconRes.headers.get('content-type'), 'image/png', `${icon.src} 不是 PNG`);
    }
  }
});

test('SVG 图标是合法的 XML', () => {
  // SVG 是 XML，不是 HTML：裸的 & 在 XML 里是致命错误。
  // 品牌名里正好有个 &（B&O），改名时踩过一次 —— HTTP 层面完全正常
  // （200、Content-Type: image/svg+xml），但浏览器解析不了，
  // 图标静静地裂掉，而所有接口测试都是绿的。
  const svgs = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.svg')) svgs.push(full);
    }
  })(PUBLIC_DIR);

  assert.ok(svgs.length > 0, '没找到任何 SVG，这个测试已经失效了');

  for (const file of svgs) {
    const rel = path.relative(PUBLIC_DIR, file);
    const xml = fs.readFileSync(file, 'utf8');

    // 裸 & = 不在实体引用里的 &。&amp; / &#38; / &#x26; 都是合法的。
    const raw = xml.match(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);)/);
    assert.equal(raw, null, `${rel} 里有没转义的 &，XML 解析会失败（图标裂掉）`);

    assert.match(xml, /<svg[\s>]/, `${rel} 不是 SVG`);
  }
});

test('Service Worker 可被注册', async () => {
  const res = await client.get('/sw.js');
  assert.equal(res.status, 200);
  // MIME 不对时浏览器会静默拒绝注册，排查起来非常费劲
  assert.match(res.headers.get('content-type'), /javascript/, '/sw.js 的 MIME 不对');

  // Service Worker 的作用域不能超出脚本所在目录，
  // 所以它必须在根路径上，否则管不到 /admin/ 下面的页面。
  assert.match(res.text, /addEventListener\('fetch'/, '/sw.js 里没有 fetch 处理');
});

test('Service Worker 预缓存的文件都存在', async () => {
  // 预缓存列表里写了不存在的文件，cache.add 会失败。
  // 而安装阶段的失败是静默的（代码里刻意吞掉了单个失败），
  // 结果就是"断网时本该能看的离线页打不开"，没人会发现。
  const sw = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const list = sw.match(/const PRECACHE = \[([\s\S]*?)\]/);
  assert.ok(list, '在 sw.js 里找不到 PRECACHE，这个测试已经失效了');

  // 列表里既有字符串字面量，也有 OFFLINE_URL 这样的常量名，两种都要认。
  // 认不出就报错，不能静默跳过 —— 否则改了写法之后这个测试会变成空转。
  const constants = Object.fromEntries(
    [...sw.matchAll(/const (\w+) = '([^']+)'/g)].map((m) => [m[1], m[2]])
  );

  const urls = [];
  for (const match of list[1].matchAll(/'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const raw = match[1] || match[2];
    const resolved = match[1] ? raw : constants[raw];
    assert.ok(resolved, `PRECACHE 里的 ${raw} 解析不出路径，这个测试需要同步更新`);
    urls.push(resolved);
  }

  assert.ok(urls.length > 0, 'PRECACHE 是空的');
  assert.ok(urls.includes('/offline.html'), 'PRECACHE 里没有离线页');

  for (const url of urls) {
    const res = await client.get(url);
    assert.equal(res.status, 200, `Service Worker 预缓存了不存在的文件：${url}`);
  }
});

test('Service Worker 不缓存接口响应', async () => {
  // 缓存接口 = 可能把 A 客户的订单喂给 B，而且缓存跨会话存活，
  // 用户登出也不会清。这是这个站最不能出错的一条规则。
  const sw = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const cacheable = sw.match(/const CACHEABLE_PREFIXES = \[([\s\S]*?)\]/);
  assert.ok(cacheable, '在 sw.js 里找不到 CACHEABLE_PREFIXES，这个测试已经失效了');

  assert.ok(
    !cacheable[1].includes('/api'),
    'CACHEABLE_PREFIXES 里出现了 /api，接口响应会被缓存'
  );
  assert.match(sw, /if \(request\.mode === 'navigate'\)/, '导航请求没有单独处理');
});
