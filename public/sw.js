'use strict';

/* B&O 订单管理系统 —— Service Worker
 *
 * 缓存策略是刻意保守的，改之前请先读这段。
 *
 * 这个站每个页面背后都是 cookie 鉴权的私有数据（订单、工单、附件），
 * 所以：
 *
 *   - /api/* 一律不碰。缓存接口响应意味着可能把 A 客户的订单喂给 B，
 *     而且 service worker 的缓存是跨会话存活的，用户登出也不会清。
 *   - HTML 一律不缓存。断网时只回落到一张静态离线页。
 *     "离线也能看上次的订单"听着方便，但那是在展示过期的私有数据，
 *     收益和风险完全不成比例。
 *   - 只有静态资源（CSS/JS/图标/manifest）进缓存，它们对所有用户都一样。
 *
 * 静态资源用"网络优先、失败回落到缓存"而不是缓存优先：
 * 这个项目没有构建步骤，文件名不带哈希，缓存优先会让发布后第一次访问
 * 拿到旧的 JS 配新的 HTML —— 页面会以各种奇怪的方式坏掉。网络优先在
 * 联网时永远是新的，断网时才用缓存，代价只是一次正常的网络请求。
 */

const VERSION = 'v1';
const STATIC_CACHE = `bo-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';

// 装的时候先抓好，否则断网时连一张能看的页面都没有
const PRECACHE = [
  OFFLINE_URL,
  '/js/offline.js',
  '/css/app.css',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/manifest.webmanifest',
];

// 白名单而不是黑名单：以后新增了别的路径，默认是"不缓存"，
// 不会因为忘了加规则而悄悄把私有数据存下来。
const CACHEABLE_PREFIXES = ['/css/', '/js/', '/icons/'];
const CACHEABLE_EXACT = [
  '/favicon.svg',
  '/manifest.webmanifest',
  '/admin/manifest.webmanifest',
];

function isCacheable(url) {
  if (CACHEABLE_EXACT.includes(url.pathname)) return true;
  return CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // 逐个抓，单个失败不让整次安装失败（比如某个图标被改名了）
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 版本号一变就清掉旧缓存，避免旧资源永远留着
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 写请求、跨域请求一概不介入，交给浏览器默认行为
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // 页面导航：只走网络。断网时给离线页，而不是缓存下来的旧页面。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(OFFLINE_URL);
        return cached || Response.error();
      })
    );
    return;
  }

  // 其余（含所有 /api/）不缓存
  if (!isCacheable(url)) return;

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        if (res.ok) {
          const cache = await caches.open(STATIC_CACHE);
          cache.put(request, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(request);
        return cached || Response.error();
      }
    })()
  );
});
