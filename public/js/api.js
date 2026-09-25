/* 共用的请求封装与 DOM 工具。
   CSP 是 script-src 'self'，页面里不能有内联脚本，
   所以所有页面都通过 <script src="/js/xxx.js" defer> 引外部文件。 */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     请求
     --------------------------------------------------------------------- */

  async function request(path, options) {
    const { method = 'GET', json, form } = options || {};
    const init = { method, headers: {}, credentials: 'same-origin' };

    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      // FormData 交给浏览器自己设 Content-Type（含 boundary），手动设会坏掉
      init.body = form;
    }

    let res;
    try {
      res = await fetch(path, init);
    } catch {
      return { ok: false, status: 0, data: null, error: '网络连接失败，请检查网络后重试' };
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      data,
      error: data && data.error ? data.error : null,
    };
  }

  const Api = {
    get: (path) => request(path),
    post: (path, json) => request(path, { method: 'POST', json }),
    patch: (path, json) => request(path, { method: 'PATCH', json }),
    del: (path) => request(path, { method: 'DELETE' }),
    upload: (path, formData) => request(path, { method: 'POST', form: formData }),
  };

  /* ---------------------------------------------------------------------
     DOM —— 只用 createElement 构建，绝不用 innerHTML
     客户填的模型名、备注、上传的文件名都是用户输入，
     一旦用 innerHTML 拼接就是一个存储型 XSS。
     --------------------------------------------------------------------- */

  function h(tag, props, ...children) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }

    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ---------------------------------------------------------------------
     格式化
     --------------------------------------------------------------------- */

  // 服务端统一存 ISO8601 UTC（带 Z），这里转成用户本地时间显示
  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  function formatDate(value) {
    if (!value) return '—';
    // 纯日期字段（YYYY-MM-DD）直接显示，不经过 Date 以免时区把它挪一天
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatMoney(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `¥${n.toFixed(2)}`;
  }

  /* ---------------------------------------------------------------------
     提示条
     --------------------------------------------------------------------- */

  function showMessage(container, text, kind) {
    if (!container) return;
    clear(container);
    if (!text) return;
    container.append(h('div', { class: `alert alert-${kind || 'error'}`, text }));
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.prevText = button.textContent;
      button.disabled = true;
      clear(button);
      button.append(h('span', { class: 'spinner' }), document.createTextNode(busyText || '处理中…'));
    } else {
      button.disabled = false;
      button.textContent = button.dataset.prevText || button.textContent;
    }
  }

  /* ---------------------------------------------------------------------
     其他
     --------------------------------------------------------------------- */

  function badge(status, label) {
    return h('span', { class: `badge badge-${status}`, text: label || status });
  }

  // 复制到剪贴板。非 HTTPS 环境下 navigator.clipboard 不可用，退回 execCommand。
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 落到下面的兜底方案 */
    }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  /* ---------------------------------------------------------------------
     管理端会话
     --------------------------------------------------------------------- */

  // 需要登录的页面在加载时调用。返回用户名，未登录则跳转到登录页并返回 null。
  async function requireAdmin() {
    const res = await Api.get('/api/auth/me');
    if (!res.ok) {
      window.location.replace('/admin/login');
      return null;
    }
    return res.data.username;
  }

  async function logoutAdmin() {
    await Api.post('/api/auth/logout', {});
    window.location.replace('/admin/login');
  }

  window.App = {
    Api,
    h,
    clear,
    formatDateTime,
    formatDate,
    formatBytes,
    formatMoney,
    showMessage,
    setBusy,
    badge,
    copyText,
    qs,
    requireAdmin,
    logoutAdmin,
  };
})();
