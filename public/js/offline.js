/* 离线页：只负责重新加载。
   必须是外部文件 —— CSP 是 script-src 'self'，内联脚本会被拦掉。 */

(function () {
  'use strict';

  document.getElementById('retry-btn').addEventListener('click', () => {
    window.location.reload();
  });
})();
