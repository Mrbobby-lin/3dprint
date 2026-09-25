'use strict';

/**
 * 部署形态相关的回归测试。
 *
 * 这一组测试都在子进程里跑：config.js 在模块加载时就解析环境变量并缓存，
 * 同进程内改 process.env 根本测不到生产配置，只有另起进程才是真的在验。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const ROOT = path.join(__dirname, '..');

// 子进程里加载 config 并吐出关键决策，用来验证环境变量到布尔值的映射
function resolveConfig(env) {
  const res = spawnSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./src/lib/config').cookieSecure))"],
    {
      cwd: ROOT,
      env: { ...process.env, SESSION_SECRET: 'a'.repeat(64), ...env },
      encoding: 'utf8',
    }
  );
  assert.equal(res.status, 0, `子进程加载 config 失败：${res.stderr}`);
  return res.stdout.trim();
}

const CHILD_BOOT = `
const app = require('./app');
const server = app.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\\n');
});
`;

// 以真实生产配置启动服务，返回端口和子进程 stderr（用来断言警告确实打出来了）
async function bootProdServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3deploy-'));
  const child = spawn(process.execPath, ['-e', CHILD_BOOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SESSION_SECRET: 'b'.repeat(64),
      DB_FILE: path.join(dir, 'app.db'),
      STORAGE_DIR: path.join(dir, 'storage'),
      ALLOW_ADMIN_REGISTRATION: 'true',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`启动超时\nstdout:${stdout}\nstderr:${stderr}`)),
      20000
    );
    const check = () => {
      const m = stdout.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程提前退出 (${code})\nstderr:${stderr}`));
    });
  });

  return {
    port,
    stderr: () => stderr,
    async stop() {
      child.kill();
      await once(child, 'exit').catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function registerOnce(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'Print3dShop2026' }),
  });
  const text = await res.text();
  return { status: res.status, setCookie: res.headers.getSetCookie().join('\n'), text };
}

test('cookieSecure 默认跟随 NODE_ENV', () => {
  assert.equal(resolveConfig({ NODE_ENV: 'production', COOKIE_SECURE: '' }), 'true');
  assert.equal(resolveConfig({ NODE_ENV: 'development', COOKIE_SECURE: '' }), 'false');
  assert.equal(resolveConfig({ NODE_ENV: 'test', COOKIE_SECURE: '' }), 'false');
});

test('COOKIE_SECURE 可以显式覆盖 NODE_ENV 的默认', () => {
  // 这就是"只有 IP、还没证书"的过渡形态：生产环境，但必须让浏览器回传 cookie
  assert.equal(resolveConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }), 'false');
  assert.equal(resolveConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'FALSE' }), 'false');
  assert.equal(resolveConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'true' }), 'true');
});

// 这条是真出过问题的场景：生产环境 + 明文 HTTP + cookie 带 Secure，
// 浏览器拒绝在 HTTP 上回传 cookie，表现为"注册/登录接口 200 成功，
// 下一个请求就是 401"，看起来像登录坏了，实际跟登录毫无关系。
test('明文 HTTP 部署：关掉 COOKIE_SECURE 后 cookie 才能被浏览器回传', async () => {
  const srv = await bootProdServer({ COOKIE_SECURE: 'false' });
  try {
    const { status, setCookie, text } = await registerOnce(srv.port);
    assert.equal(status, 201, `注册应成功：${text}`);
    assert.ok(setCookie.includes('p3_admin='), `没有下发管理员 cookie：${setCookie}`);
    assert.ok(
      !/\bSecure\b/i.test(setCookie),
      `COOKIE_SECURE=false 时不该带 Secure，否则 HTTP 下浏览器不回传：${setCookie}`
    );
    // 关掉 Secure 等于把凭据摊在公网上，这件事不能是无声的
    assert.ok(
      srv.stderr().includes('COOKIE_SECURE=false'),
      '关闭 Secure 时启动必须打警告，否则没人会记得这是临时状态'
    );
  } finally {
    await srv.stop();
  }
});

test('生产环境默认下发带 Secure 的 cookie', async () => {
  const srv = await bootProdServer({ COOKIE_SECURE: '' });
  try {
    const { status, setCookie, text } = await registerOnce(srv.port);
    assert.equal(status, 201, `注册应成功：${text}`);
    assert.ok(/\bSecure\b/i.test(setCookie), `生产默认必须带 Secure：${setCookie}`);
    assert.ok(
      !srv.stderr().includes('COOKIE_SECURE=false'),
      '默认形态不该打明文警告'
    );
  } finally {
    await srv.stop();
  }
});

// 守卫：将来新增下发 cookie 的地方，如果又顺手写成 config.isProd，
// 上面那些测试都发现不了（它们只覆盖已有的三个出口）。
test('所有下发 cookie 的地方都走 config.cookieSecure，不再直接看 NODE_ENV', () => {
  const offenders = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;

      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bsecure\s*:/.test(line) && !line.includes('config.cookieSecure')) {
            offenders.push(`${path.relative(ROOT, full)}:${i + 1}  ${line.trim()}`);
          }
        });
    }
  })(path.join(ROOT, 'src'));

  assert.deepEqual(
    offenders,
    [],
    `以下位置没走 config.cookieSecure，纯 HTTP 部署下会静默失效：\n${offenders.join('\n')}`
  );
});
