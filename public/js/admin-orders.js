/* 管理端订单列表：筛选、搜索、分页 */

(function () {
  'use strict';

  const {
    Api,
    h,
    clear,
    formatDateTime,
    formatDate,
    formatMoney,
    showMessage,
    badge,
    requireAdmin,
    logoutAdmin,
  } = window.App;

  const els = {
    message: document.getElementById('message'),
    statsMessage: document.getElementById('stats-message'),
    stats: document.getElementById('stats'),
    listMessage: document.getElementById('list-message'),
    statusFilter: document.getElementById('status-filter'),
    search: document.getElementById('search'),
    rows: document.getElementById('rows'),
    empty: document.getElementById('empty'),
    pageInfo: document.getElementById('page-info'),
    prev: document.getElementById('prev-btn'),
    next: document.getElementById('next-btn'),
  };

  const state = { page: 1, pageSize: 20, status: '', q: '', total: 0, labels: {} };

  /* ---------------------------------------------------------------------
     渲染
     --------------------------------------------------------------------- */

  function statusLabel(status) {
    return state.labels[status] || status;
  }

  function renderRows(orders) {
    const tbody = clear(els.rows);

    for (const order of orders) {
      tbody.append(
        h(
          'tr',
          {},
          h('td', { class: 'nowrap mono' }, h('a', { href: `/admin/order/detail?id=${order.id}` }, order.order_no)),
          h('td', { class: 'nowrap' },
            h('div', { text: order.customer_name }),
            h('div', { class: 'muted small', text: order.customer_phone })),
          h('td', { text: order.model_name }),
          h('td', { class: 'nowrap', text: order.material }),
          h('td', { text: order.quantity }),
          h('td', { class: 'nowrap', text: formatMoney(order.price) }),
          h('td', { class: 'nowrap', text: formatDate(order.promised_date) }),
          h('td', {}, badge(order.status, statusLabel(order.status))),
          h('td', { class: 'nowrap muted small', text: formatDateTime(order.created_at) }),
          h('td', { class: 'nowrap' },
            h('a', { class: 'btn btn-sm', href: `/admin/order/detail?id=${order.id}` }, '查看'))
        )
      );
    }

    els.empty.classList.toggle('hidden', orders.length > 0);
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.pageInfo.textContent = `共 ${state.total} 条 · 第 ${state.page} / ${pages} 页`;
    els.prev.disabled = state.page <= 1;
    els.next.disabled = state.page >= pages;
  }

  /* ---------------------------------------------------------------------
     数据
     --------------------------------------------------------------------- */

  async function loadMeta() {
    const res = await Api.get('/api/admin/meta');
    if (!res.ok) return;

    for (const s of res.data.statuses) {
      state.labels[s.value] = s.label;
      els.statusFilter.append(h('option', { value: s.value, text: s.label }));
    }
  }

  function statTile(label, value, sub) {
    return h(
      'div',
      { class: 'stat' },
      h('div', { class: 'stat-label', text: label }),
      h('div', { class: 'stat-value', text: value }),
      sub ? h('div', { class: 'stat-sub', text: sub }) : null
    );
  }

  async function loadStats() {
    // 静态资源缓存 1 小时，部署后短时间内可能是「新 HTML + 旧 JS」，
    // 旧 JS 不会去取这两个元素。拿不到就安静退出，别让整页崩掉。
    if (!els.stats) return;

    const res = await Api.get('/api/admin/stats');
    if (!res.ok) {
      showMessage(els.statsMessage, res.error || '统计数据加载失败');
      return;
    }

    const s = res.data.stats;
    showMessage(els.statsMessage, '');
    clear(els.stats);

    els.stats.append(
      // 只统计已交付的订单，且按接单时间归属到月份 —— 所以这个数字会随后续交付变化
      statTile('本月收入', formatMoney(s.revenue_month), `${s.month.label} 接单 ${s.created_month} 单`),
      statTile('累计营业额', formatMoney(s.revenue_total), `已交付 ${s.delivered_count} 单`),
      statTile('订单总量', String(s.order_count), `本月新增 ${s.created_month} 单`),
      statTile('未交付', String(s.undelivered), `其中打印中 ${s.printing_count} 单`)
    );

    // 报价为 NULL 的已交付订单会被 SUM 跳过。这笔钱是真漏掉的，不能装作没有。
    if (s.delivered_unpriced > 0) {
      els.stats.append(
        h('div', {
          class: 'stat-note',
          text: `另有 ${s.delivered_unpriced} 单已交付但未填报价，未计入营业额`,
        })
      );
    }
  }

  async function load() {
    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    if (state.status) params.set('status', state.status);
    if (state.q) params.set('q', state.q);

    const res = await Api.get(`/api/admin/orders?${params}`);
    if (!res.ok) {
      showMessage(els.listMessage, res.error || '加载失败');
      return;
    }

    showMessage(els.listMessage, '');
    state.total = res.data.total;
    renderRows(res.data.orders);
    renderPager();
  }

  /* ---------------------------------------------------------------------
     事件
     --------------------------------------------------------------------- */

  function applyFilters() {
    state.page = 1;
    load();
  }

  els.statusFilter.addEventListener('change', () => {
    state.status = els.statusFilter.value;
    applyFilters();
  });

  document.getElementById('search-btn').addEventListener('click', () => {
    state.q = els.search.value.trim();
    applyFilters();
  });

  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      state.q = els.search.value.trim();
      applyFilters();
    }
  });

  document.getElementById('reset-btn').addEventListener('click', () => {
    els.search.value = '';
    els.statusFilter.value = '';
    state.q = '';
    state.status = '';
    applyFilters();
  });

  els.prev.addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });

  els.next.addEventListener('click', () => {
    state.page += 1;
    load();
  });

  document.getElementById('logout-link').addEventListener('click', (event) => {
    event.preventDefault();
    logoutAdmin();
  });

  /* ---------------------------------------------------------------------
     启动
     --------------------------------------------------------------------- */

  (async () => {
    if (!(await requireAdmin())) return;
    await loadMeta();

    // 支持从别处跳过来时带上筛选条件，例如 ?status=printing
    const status = new URLSearchParams(window.location.search).get('status');
    if (status) {
      state.status = status;
      els.statusFilter.value = status;
    }

    // 看板和列表互不依赖，并行发起
    await Promise.all([loadStats(), load()]);
  })();
})();
