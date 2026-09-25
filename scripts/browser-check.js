'use strict';

/**
 * 端到端浏览器演练。
 *
 * 自动化测试（test/*.test.js）走的是 fetch，验证不了"页面在真浏览器里能不能跑起来"：
 * 脚本报错、CSP 拦截、元素 ID 写错、样式崩掉，这些只有真渲染一次才看得见。
 *
 * 这里用 Edge 的 DevTools Protocol 驱动无头浏览器（Node 22 自带 WebSocket，
 * 不需要装 Playwright/Puppeteer），完整走一遍：
 *   注册管理员 → 新建订单 → 复制订单号 → 推状态 → 客户凭订单号查单 → 看时间线
 * 每一步截图，并收集页面 JS 报错、CSP 违规、非预期的 4xx/5xx。
 *
 * 用法： node scripts/browser-check.js
 * 产物： data/screenshots/*.png
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BROWSER_CHECK_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = Number(process.env.BROWSER_CHECK_DEBUG_PORT || 9333);
const SHOT_DIR = path.join(ROOT, 'data', 'screenshots');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const ADMIN_USER = 'boss';
const ADMIN_PASS = 'Print3dShop2026';
const CUSTOMER_NAME = '张伟';
const CUSTOMER_PHONE = '13800138000';
// 默认单价（元/克）。订单表单里所有自动算价的期望值都按这个数推。
const UNIT_PRICE = '0.55';
// 越级变更的必填原因。这句话是内部审计记录，绝不能出现在客户页面上。
const FORCE_NOTE = '客户投诉，破例跳过排队';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
   CDP 客户端
   --------------------------------------------------------------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`无法连接 ${url}`)), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  once(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待事件 ${method} 超时`)), timeout);
      const fn = (params) => {
        clearTimeout(timer);
        const arr = this.listeners.get(method);
        arr.splice(arr.indexOf(fn), 1);
        resolve(params);
      };
      this.on(method, fn);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/* ---------------------------------------------------------------------------
   浏览器进程
   --------------------------------------------------------------------------- */

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到可用的 Chromium 内核浏览器（Edge/Chrome）');
}

async function waitForDebugPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return null;
}

async function launchBrowser() {
  const exe = findBrowser();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-browser-'));

  // --headless=new 在旧版 Edge 上不认，退回到 --headless
  for (const headless of ['--headless=new', '--headless']) {
    const proc = spawn(
      exe,
      [
        headless,
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--window-size=1280,1000',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    const version = await waitForDebugPort(12000);
    if (version) {
      console.log(`浏览器：${version.Browser}`);
      return { proc, version };
    }
    proc.kill();
    await sleep(500);
  }

  throw new Error('浏览器启动后调试端口未就绪');
}

/* ---------------------------------------------------------------------------
   页面操作
   --------------------------------------------------------------------------- */

let cdp;

const problems = [];
let recordNetwork = true;

async function evaluate(expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`页面内求值抛异常：${d.exception?.description || d.text}`);
  }
  return res.result.value;
}

async function goto(url, { waitFor: condition, label } = {}) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  // defer 脚本在这之后才跑，等第一次渲染落地
  await sleep(400);
  if (condition) await waitFor(condition, { label: label || condition });
}

async function waitFor(condition, { timeout = 15000, label, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(`!!(${condition})`)) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  throw new Error(
    `等待超时（${label || condition}）${lastErr ? `\n  最后错误：${lastErr.message}` : ''}`
  );
}

async function setFields(values) {
  const json = JSON.stringify(values);
  await evaluate(`(() => {
    const values = ${json};
    for (const [id, value] of Object.entries(values)) {
      const node = document.getElementById(id);
      if (!node) throw new Error('页面上找不到 #' + id);
      if (node.type === 'checkbox') node.checked = Boolean(value);
      else node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`);
}

async function submitForm(formId) {
  await evaluate(`document.getElementById(${JSON.stringify(formId)}).requestSubmit(), true`);
}

async function shot(name) {
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  截图 ${path.relative(ROOT, file)} (${kb} KB)`);
  return file;
}

async function setViewport(width, height, mobile = false) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
  });
}

/* ---------------------------------------------------------------------------
   检查
   --------------------------------------------------------------------------- */

// 这些请求返回 401 是设计的一部分：页面加载时主动打一次，用来判断会话是否还在。
// 未登录访客必然收到 401，浏览器会把它们记成 error 级日志，但那不是缺陷。
const PROBE_PATHS = /\/(api\/customer\/order(\/history)?|api\/auth\/me)$/;

function isExpectedNoise(url, status) {
  if (!url) return false;
  if (url.includes('favicon')) return true;
  return status === 401 && PROBE_PATHS.test(new URL(url).pathname);
}

function check(ok, message) {
  if (ok) {
    console.log(`  ✓ ${message}`);
  } else {
    problems.push(message);
    console.log(`  ✗ ${message}`);
  }
}

/* ---------------------------------------------------------------------------
   主流程
   --------------------------------------------------------------------------- */

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // 每次跑都用全新的库和存储目录，保证演练可重复
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-run-'));

  console.log('启动应用…');
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      DB_FILE: path.join(workDir, 'app.db'),
      STORAGE_DIR: path.join(workDir, 'storage'),
      SESSION_SECRET: require('node:crypto').randomBytes(32).toString('hex'),
      ALLOW_ADMIN_REGISTRATION: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let appLog = '';
  app.stdout.on('data', (d) => (appLog += d));
  app.stderr.on('data', (d) => (appLog += d));

  const cleanup = [];
  const shutdown = () => {
    for (const fn of cleanup.splice(0)) {
      try {
        fn();
      } catch {
        /* 忽略 */
      }
    }
  };

  try {
    const deadline = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(300);
    }
    if (!healthy) throw new Error(`应用启动失败：\n${appLog}`);

    // taskkill /T 只杀我们自己的进程树，不碰用户已开的浏览器
    cleanup.push(() => spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }));
    console.log(`应用就绪：${BASE}\n`);

    const browser = await launchBrowser();
    cleanup.push(() =>
      spawn('taskkill', ['/PID', String(browser.proc.pid), '/T', '/F'], { stdio: 'ignore' })
    );

    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('调试端口上没有页面目标');

    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    cleanup.push(() => cdp.close());

    await cdp.send('Page.enable');
    // 越级变更和删除订单都会弹 window.confirm，无人值守时它会一直阻塞，
    // 必须由 CDP 主动应答，否则演练挂死在这里。
    cdp.on('Page.javascriptDialogOpening', () => {
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      problems.push(`未捕获异常：${d.exception?.description || d.text}`);
    });

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'warning') return;
      const text = p.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      // 开发模式下 favicon 之类的噪音不算问题
      if (/favicon/i.test(text)) return;
      if (p.type === 'error') problems.push(`console.error：${text}`);
    });

    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry;
      if (e.level !== 'error') return;
      // 网络失败的日志长这样："Failed to load resource: ... 401 (Unauthorized)"
      // 状态码在 text 里，出错的地址在 url 里，两个都要看
      const status = Number((e.text.match(/status of (\d{3})/) || [])[1]);
      if (isExpectedNoise(e.url, status)) return;
      // CSP 违规会以 Log error 的形式出现，必须当成硬失败
      problems.push(`浏览器日志错误：${e.text}${e.url ? ` (${e.url})` : ''}`);
    });

    cdp.on('Network.responseReceived', (p) => {
      if (!recordNetwork) return;
      const r = p.response;
      if (!r.url.startsWith(BASE)) return;
      if (isExpectedNoise(r.url, r.status)) return;
      if (r.status >= 400) problems.push(`请求失败：${r.status} ${r.url}`);
    });

    /* ---------------- 1. 注册管理员 ---------------- */

    console.log('1) 注册管理员');
    await setViewport(1280, 1000);
    await goto(`${BASE}/admin/register`, {
      waitFor: `document.getElementById('register-form')`,
      label: '注册表单出现',
    });

    await setFields({
      username: ADMIN_USER,
      password: ADMIN_PASS,
      confirm: ADMIN_PASS,
    });
    await submitForm('register-form');

    await waitFor(`location.pathname === '/admin/orders'`, {
      timeout: 20000,
      label: '注册后跳转到订单列表',
    });
    await sleep(600);
    await shot('1-注册成功-订单列表');
    check(true, '注册管理员并跳转到订单列表');

    /* ---------------- 2. 设置默认单价 ---------------- */

    console.log('2) 设置默认单价');
    await goto(`${BASE}/admin/settings`, {
      waitFor: `document.getElementById('default_unit_price')`,
      label: '设置页加载完成',
    });

    await setViewport(1280, 800);
    await setFields({ default_unit_price: UNIT_PRICE });
    await submitForm('settings-form');
    await waitFor(`document.querySelector('#message .alert-ok')`, { label: '保存成功提示' });

    // 刷新一次，确认真的落库了而不是只留在表单里
    await goto(`${BASE}/admin/settings`, {
      waitFor: `document.getElementById('default_unit_price').value !== ''`,
      label: '刷新后读回默认单价',
    });
    const savedUnitPrice = await evaluate(`document.getElementById('default_unit_price').value`);
    check(savedUnitPrice === UNIT_PRICE, `默认单价刷新后仍在：${savedUnitPrice}`);
    await shot('2-设置-默认单价');

    /* ---------------- 3. 新建订单 ---------------- */

    console.log('3) 新建订单');
    await goto(`${BASE}/admin/order/form`, {
      waitFor: `document.getElementById('material') && document.getElementById('material').options.length > 1`,
      label: '材料下拉框加载完成',
    });

    await setViewport(1280, 1200);

    // 逐字符输入重量。真浏览器里 .value 依次读到 '8'、'85'、''（小数点刚落下时
    // 还不构成合法数字）、'85.5' —— 这里按同样的序列驱动。
    // 报价必须跟着"最后一次按键"走：如果实现用的是"框里为空才自动填"，
    // 输 '8' 之后框就非空了，后面几次都不再更新，最终报价会停在 4.40。
    const typeWeight = (value) =>
      evaluate(`(() => {
        const w = document.getElementById('est_weight_g');
        w.value = ${JSON.stringify(value)};
        w.dispatchEvent(new Event('input', { bubbles: true }));
        return w.value;
      })()`);

    await typeWeight('8');
    const priceAfter8 = await evaluate(`document.getElementById('price').value`);
    await typeWeight('85');
    await typeWeight(''); // 小数点刚落下：值不是合法数字，读作空
    const priceMidway = await evaluate(`document.getElementById('price').value`);
    await typeWeight('85.5');
    const priceFinal = await evaluate(`document.getElementById('price').value`);

    check(priceAfter8 === '4.4', `输入 '8' 时报价跟随：${priceAfter8}（8 × 0.55）`);
    check(
      priceMidway === '46.75',
      `输入中途（重量读作空）不清掉已算好的报价：${priceMidway}`
    );
    check(priceFinal === '47.03', `逐字符输完 85.5 后报价 = 85.5 × 0.55 = 47.03，实际 ${priceFinal}`);

    const priceHint = await evaluate(`document.getElementById('price-hint').textContent`);
    check(priceHint.includes('0.55') && priceHint.includes('85.5'), `报价框下方显示算式：${priceHint.trim()}`);

    // 手动改价 → 自动算价让位，改重量不再覆盖
    await setFields({ price: '180' });
    await typeWeight('50');
    check(await evaluate(`document.getElementById('price').value`) === '180', '手动改价后，改重量不再覆盖报价');

    // 清空报价 → 重新武装自动算价
    await setFields({ price: '' });
    await typeWeight('60');
    const rearmed = await evaluate(`document.getElementById('price').value`);
    check(rearmed === '33', `清空报价后改重量重新自动填入：${rearmed}（应为 60 × 0.55 = 33）`);

    await shot('3-新建订单表单');

    await setFields({
      customer_name: CUSTOMER_NAME,
      customer_phone: CUSTOMER_PHONE,
      model_name: '机械臂关节外壳',
      color: '哑光黑',
      quantity: '2',
      layer_height: '0.2',
      infill: '20',
      est_weight_g: '45',
      price: '180',
      promised_date: '2026-10-08',
      customer_note: '表面尽量光滑，不要有层纹',
      admin_note: '老客户，优先排产',
      need_support: true,
    });
    // material 是 select，取第一个真实选项
    await evaluate(`(() => {
      const s = document.getElementById('material');
      s.value = s.options[1].value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value;
    })()`);

    await submitForm('order-form');
    await waitFor(`location.pathname === '/admin/order/detail'`, {
      timeout: 20000,
      label: '创建后跳转到订单详情',
    });
    await waitFor(`document.getElementById('order-no').textContent.trim().length > 0`, {
      label: '订单号渲染出来',
    });

    const orderNo = await evaluate(`document.getElementById('order-no').textContent.trim()`);
    const orderId = await evaluate(`new URLSearchParams(location.search).get('id')`);
    check(/^3D-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(orderNo),
      `订单号格式正确：${orderNo}`);
    check(!/[ILOU]/.test(orderNo.slice(3)), '订单号不含易混字符 I/L/O/U');

    await sleep(500);
    await shot('4-订单详情-新建后');
    check(true, '新建订单成功');

    /* ---------------- 4. 复制订单号 ---------------- */

    console.log('4) 复制订单号');
    await evaluate(`document.getElementById('copy-btn').click(), true`);
    await sleep(700);
    const copyText = await evaluate(`document.getElementById('copy-btn').textContent.trim()`);
    // 无头浏览器里剪贴板可能不可用，此时走 execCommand 兜底
    check(copyText === '已复制' || copyText === '复制失败', `复制按钮有反馈：「${copyText}」`);
    if (copyText !== '已复制') {
      console.log('    （无头浏览器剪贴板受限，属预期；非 HTTPS 环境会走 execCommand 兜底）');
    }

    /* ---------------- 5. 推进状态 ---------------- */

    console.log('5) 推进状态');
    for (const [target, note] of [
      ['confirmed', '已确认报价，客户同意'],
      ['queued', '已排产'],
      ['printing', '已上机打印'],
    ]) {
      // 等 #next-status 而不是 #status-panel：后者是静态 HTML 里的空 div，
      // 一开始就存在，等它等于没等，会在渲染完成前就去点按钮。
      await waitFor(`document.getElementById('next-status')`, { label: '状态推进下拉框出现' });
      await evaluate(`(() => {
        const select = document.getElementById('next-status');
        const notes = document.getElementById('status-note');
        if (!select || !notes) throw new Error('状态面板缺元素');
        select.value = ${JSON.stringify(target)};
        notes.value = ${JSON.stringify(note)};
        const btn = [...document.querySelectorAll('#status-panel button')]
          .find((b) => b.textContent.trim() === '更新状态');
        if (!btn) throw new Error('找不到「更新状态」按钮');
        btn.click();
        return true;
      })()`);

      // 备注渲染在 .step-meta 里，不在 .step-label 里，整条 li 一起匹配
      await waitFor(
        `[...document.querySelectorAll('#history li')]
           .some((n) => n.textContent.includes(${JSON.stringify(note)}))`,
        { label: `历史记录出现「${note}」` }
      );
    }

    // 越级变更：从"打印中"直接跳到"已完成"，跳过"后处理"。
    // 这条路走的是 window.confirm + 必填原因，前端最容易写坏，单独走一遍。
    await evaluate(`(() => {
      const details = document.querySelector('#status-panel details');
      if (!details) throw new Error('找不到越级变更折叠区');
      details.open = true;
      const select = document.getElementById('force-status');
      const note = document.getElementById('force-note');
      if (!select || !note) throw new Error('越级变更区缺元素');
      select.value = 'completed';
      note.value = ${JSON.stringify(FORCE_NOTE)};
      const btn = [...document.querySelectorAll('#status-panel button')]
        .find((b) => b.textContent.trim() === '强制变更');
      if (!btn) throw new Error('找不到「强制变更」按钮');
      btn.click();
      return true;
    })()`);

    await waitFor(
      `[...document.querySelectorAll('#history li')]
         .some((n) => n.textContent.includes(${JSON.stringify(FORCE_NOTE)}))`,
      { label: '越级变更记入历史' }
    );

    // 内部原因在管理端要标出来，否则管理员会以为客户也看得到
    const adminHistory = await evaluate(`document.getElementById('history').textContent`);
    check(
      adminHistory.includes('（内部，客户看不到）'),
      '管理端把越级变更的原因标为内部可见'
    );

    const historyCount = await evaluate(`document.querySelectorAll('#history li').length`);
    check(historyCount === 5, `状态历史共 ${historyCount} 条（1 条新建 + 3 次推进 + 1 次越级）`);

    const timelineText = await evaluate(
      `[...document.querySelectorAll('#history .step-label')].map((n) => n.textContent).join(' | ')`
    );
    check(/待确认 → 已确认/.test(timelineText), `状态链条连续：${timelineText}`);

    await sleep(400);
    await shot('5-管理端-状态时间线');

    /* ---------------- 6. 首页看板 ---------------- */

    console.log('6) 首页看板');

    const readBoard = () =>
      evaluate(`(() => {
        const out = {};
        for (const tile of document.querySelectorAll('#stats .stat')) {
          const sub = tile.querySelector('.stat-sub');
          out[tile.querySelector('.stat-label').textContent.trim()] = {
            value: tile.querySelector('.stat-value').textContent.trim(),
            sub: sub ? sub.textContent.trim() : '',
          };
        }
        return out;
      })()`);

    const openBoard = () =>
      goto(`${BASE}/admin/orders`, {
        waitFor: `document.querySelectorAll('#stats .stat').length === 4`,
        label: '看板四个格子渲染出来',
      });

    await openBoard();
    let board = await readBoard();

    check(board['订单总量']?.value === '1', `看板订单总量 = ${board['订单总量']?.value}`);
    // 「已完成」只是做完了，还没交货，仍然算未交付 —— 这是刻意的口径
    check(board['未交付']?.value === '1', `「已完成」仍计入未交付：${board['未交付']?.value}`);
    check(
      board['累计营业额']?.value === '¥0.00',
      `没有已交付订单时营业额为 0：${board['累计营业额']?.value}`
    );
    check(
      board['累计营业额']?.sub === '已交付 0 单',
      `营业额副标题写明口径：${board['累计营业额']?.sub}`
    );
    check(
      board['未交付']?.sub === '其中打印中 0 单',
      `未交付副标题写明其中打印中几单：${board['未交付']?.sub}`
    );
    // 这单填了报价，不该出现"未填报价"的提示
    check(
      (await evaluate(`!document.querySelector('#stats .stat-note')`)) === true,
      '没有"已交付但未填报价"的订单时不显示提示行'
    );
    await shot('6-首页看板-未交付');

    // 推到「已交付」，营业额应该正好增加这一单的报价
    await goto(`${BASE}/admin/order/detail?id=${orderId}`, {
      waitFor: `document.getElementById('next-status')`,
      label: '详情页状态面板',
    });
    await evaluate(`(() => {
      const select = document.getElementById('next-status');
      const notes = document.getElementById('status-note');
      select.value = 'delivered';
      notes.value = '已交付客户';
      const btn = [...document.querySelectorAll('#status-panel button')]
        .find((b) => b.textContent.trim() === '更新状态');
      if (!btn) throw new Error('找不到「更新状态」按钮');
      btn.click();
      return true;
    })()`);
    await waitFor(
      `[...document.querySelectorAll('#history li')].some((n) => n.textContent.includes('已交付客户'))`,
      { label: '交付记录出现' }
    );

    await openBoard();
    board = await readBoard();

    check(board['累计营业额']?.value === '¥180.00', `交付后累计营业额 = ${board['累计营业额']?.value}`);
    check(board['累计营业额']?.sub === '已交付 1 单', `已交付单数 = ${board['累计营业额']?.sub}`);
    check(board['未交付']?.value === '0', `交付后未交付归零：${board['未交付']?.value}`);
    // 这一单是本月接的，也是本月交付的，所以本月收入应该等于它的报价
    check(board['本月收入']?.value === '¥180.00', `本月收入 = ${board['本月收入']?.value}`);
    await shot('6-首页看板-已交付');

    // 已交付但没填报价的单：SUM 会静默跳过它，界面必须明说，
    // 否则这笔钱就是无声无息地消失的。用接口直接造一单，走 UI 太绕。
    const unpricedStatus = await evaluate(`(async () => {
      const created = await fetch('/api/admin/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: '缺报价的客户',
          customer_phone: '13900139000',
          model_name: '未报价件',
          material: 'PLA',
        }),
      }).then((r) => r.json());
      const res = await fetch('/api/admin/orders/' + created.order.id + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_status: 'delivered',
          force: true,
          note: '历史订单，当初就没报价',
        }),
      });
      return res.status;
    })()`);
    check(unpricedStatus === 200, `造一单「已交付但未填报价」（HTTP ${unpricedStatus}）`);

    await openBoard();
    board = await readBoard();
    const noteText = await evaluate(
      `(document.querySelector('#stats .stat-note') || {}).textContent || ''`
    );
    check(noteText.includes('1 单'), `提示行说明了漏算的单数：「${noteText.trim()}」`);
    check(board['累计营业额']?.value === '¥180.00', `没报价的那单不计入营业额：${board['累计营业额']?.value}`);
    check(board['累计营业额']?.sub === '已交付 2 单', `但仍计入已交付单数：${board['累计营业额']?.sub}`);
    await shot('6-首页看板-未填报价提示');

    // 手机上四个格子要排得下，且不能把页面撑出横向滚动条
    await setViewport(360, 800, true);
    await openBoard();
    const boardOverflow = await evaluate(
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`
    );
    check(boardOverflow <= 0, `手机上看板没有横向溢出（溢出 ${boardOverflow}px）`);

    const boardCols = await evaluate(
      `getComputedStyle(document.getElementById('stats')).gridTemplateColumns.split(' ').length`
    );
    check(boardCols >= 2, `手机上看板排成 ${boardCols} 列（至少 2 列才不至于要滑很久）`);
    await shot('6-首页看板-手机');
    await setViewport(1280, 1000);

    /* ---------------- 7. 客户凭订单号查单 ---------------- */

    console.log('7) 客户凭订单号查单');
    // 清掉管理员 cookie，换成匿名客户视角
    await cdp.send('Network.clearBrowserCookies');
    recordNetwork = false; // 下面的负向检查会故意制造 4xx，不再计入

    await goto(`${BASE}/`, {
      waitFor: `document.getElementById('lookup-form')`,
      label: '查单页表单出现',
    });
    await setViewport(1280, 1000);
    await shot('7-客户查单入口');

    // 输入框的自动格式化：小写 + 无横线 → 应被纠正成标准格式
    const messyTyped = orderNo.toLowerCase().replace(/-/g, '');
    await evaluate(`(() => {
      const input = document.getElementById('order-no');
      input.value = ${JSON.stringify(messyTyped)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    const corrected = await evaluate(`document.getElementById('order-no').value`);
    check(corrected === orderNo, `输入框自动纠正：${messyTyped} → ${corrected}`);

    // 服务端归一化：连易混字符一起换掉（0→O、1→I、V→U），且不触发前端纠正
    const mangled = messyTyped.replace(/0/g, 'O').replace(/1/g, 'I').replace(/v/g, 'u');
    await evaluate(`(() => {
      document.getElementById('order-no').value = ${JSON.stringify(mangled)};
      return true;
    })()`);
    await submitForm('lookup-form');

    await waitFor(`location.pathname === '/order'`, {
      timeout: 20000,
      label: '查单成功跳转到 /order',
    });
    await waitFor(`document.getElementById('timeline').children.length > 0`, {
      label: '时间线渲染出来',
    });

    check(!(await evaluate(`location.search.length > 0`)), 'URL 里没有订单号等任何查询参数');

    const custOrderNo = await evaluate(`document.getElementById('order-no').textContent.trim()`);
    check(custOrderNo === orderNo, `客户页显示的订单号一致：${custOrderNo}`);

    const steps = await evaluate(
      `[...document.querySelectorAll('#timeline .step-label')].map((n) => n.textContent)`
    );
    check(steps.length === 7, `时间线一共 7 个主步骤，实际 ${steps.length} 个`);

    // 越级从"打印中"跳到"已完成"，中间跳过的"后处理"必须仍然是未完成状态，
    // 否则时间线会撒谎，让客户以为后处理做过。
    const reached = await evaluate(
      `[...document.querySelectorAll('#timeline .timeline-item.done .step-label')]
         .map((n) => n.textContent)`
    );
    // 7 步里只有被跳过的「后处理」没到，其余 6 步都该是已完成
    check(reached.length === 6, `已完成步骤 6 个，实际 ${reached.length} 个：${reached.join(' → ')}`);
    check(!reached.includes('后处理'), '被越级跳过的「后处理」没有被误标为已完成');

    const badgeText = await evaluate(`document.getElementById('status-badge').textContent.trim()`);
    check(badgeText.includes('已交付'), `状态徽章显示「${badgeText}」`);

    const infoText = await evaluate(`document.getElementById('info').textContent`);
    check(infoText.includes('机械臂关节外壳'), '订单信息渲染出模型名');
    check(infoText.includes('¥180.00'), '订单信息渲染出报价');

    // 客户视角绝不能看到内部字段
    const bodyText = await evaluate(`document.body.innerText`);
    check(!bodyText.includes(CUSTOMER_PHONE), '客户页面没有泄露联系电话');
    check(!bodyText.includes(CUSTOMER_NAME), '客户页面没有泄露客户姓名');
    check(!bodyText.includes('老客户'), '客户页面没有泄露内部备注');
    check(!bodyText.includes(FORCE_NOTE), '客户页面没有泄露越级变更的内部原因');
    check(
      bodyText.includes('已确认报价，客户同意'),
      '常规状态说明照常展示给客户（不是一律隐藏）'
    );

    // cookie 必须 HttpOnly，JS 读不到
    const jsCookies = await evaluate(`document.cookie`);
    check(jsCookies === '', '会话 cookie 是 HttpOnly，JS 读不到（XSS 拿不走订单凭据）');

    await sleep(500);
    await setViewport(1280, 1400);
    await shot('8-客户订单详情-时间线');

    /* ---------------- 6. 移动端 ---------------- */

    console.log('8) 移动端渲染');
    await setViewport(390, 844, true);
    await sleep(600);
    await shot('9-移动端-客户详情');

    const fontSize = await evaluate(
      `parseFloat(getComputedStyle(document.getElementById('order-no')).fontSize)`
    );
    // iOS Safari 会对小于 16px 的输入框自动放大页面
    const inputFont = await evaluate(`(() => {
      const input = document.createElement('input');
      input.type = 'text';
      document.body.append(input);
      const size = parseFloat(getComputedStyle(input).fontSize);
      input.remove();
      return size;
    })()`);
    check(fontSize >= 16, `订单号字号 ${fontSize}px ≥ 16px`);
    check(inputFont >= 16, `输入框字号 ${inputFont}px ≥ 16px（iOS 不会自动缩放）`);

    const overflow = await evaluate(
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`
    );
    check(overflow <= 2, `移动端没有横向溢出（溢出 ${overflow}px）`);

    await setViewport(1280, 1000);

    /* ---------------- 7. 负向检查 ---------------- */

    console.log('9) 无凭据访问');
    await cdp.send('Network.clearBrowserCookies');
    await goto(`${BASE}/order`);
    await sleep(1200);
    const leaked = await evaluate(`document.body.innerText.includes(${JSON.stringify(orderNo)})`);
    check(!leaked, '无 cookie 访问 /order 拿不到订单数据');

    await goto(`${BASE}/admin/orders`);
    await sleep(1200);
    check(
      await evaluate(`location.pathname === '/admin/login'`),
      '未登录访问后台被重定向到登录页'
    );

    recordNetwork = true;

    /* ---------------- 汇总 ---------------- */

    console.log('');
    if (problems.length === 0) {
      console.log('全部检查通过，没有 JS 报错、CSP 违规或异常请求。');
    } else {
      console.log(`发现 ${problems.length} 个问题：`);
      for (const p of problems) console.log(`  - ${p}`);
    }
    console.log(`\n截图目录：${path.relative(ROOT, SHOT_DIR)}`);
    console.log(`临时数据：${workDir}`);

    process.exitCode = problems.length === 0 ? 0 : 1;
  } finally {
    shutdown();
    await sleep(300);
  }
}

main().catch((err) => {
  console.error(`\n演练失败：${err.message}`);
  process.exitCode = 1;
});
