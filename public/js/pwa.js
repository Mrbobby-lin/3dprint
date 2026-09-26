/* 注册 Service Worker。
   CSP 是 script-src 'self'，页面里不能有内联脚本，所以这段必须放外部文件。 */

(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // Service Worker 只在安全上下文（HTTPS 或 localhost）可用。
  // 服务器可能还没上 HTTPS（见 deploy/README.md），那种情况下
  // register() 会抛 SecurityError —— 先挡掉，免得每个访客的控制台都多一条报错。
  if (!window.isSecureContext) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // 注册失败只是没有离线能力，页面功能不受影响，不值得打扰用户
    });
  });
})();
