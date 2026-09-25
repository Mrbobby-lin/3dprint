/* 管理端工单列表：按状态筛选、搜索、分页 */

(function () {
  'use strict';

  const { Api, h, clear, formatDateTime, showMessage, badge, requireAdmin, logoutAdmin } =
    window.App;

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

  const state = { page: 1, pageSize: 20, status: '', q: '', total: 0 };

  /* ---------------------------------------------------------------------
     渲染
     --------------------------------------------------------------------- */

  function renderRows(tickets) {
    const tbody = clear(els.rows);

    for (const ticket of tickets) {
      tbody.append(
        h(
          'tr',
          {},
          h(
            'td',
            { class: 'nowrap mono' },
            h('a', { href: `/admin/order/detail?id=${ticket.order_id}` }, ticket.order_no)
          ),
          h('td', { class: 'nowrap', text: ticket.customer_name }),
          h('td', { class: 'nowrap', text: ticket.category_label }),
          h('td', { text: ticket.subject }),
          h('td', { class: 'nowrap muted', text: `${ticket.message_count} 条` }),
          h('td', {}, badge(ticket.status, ticket.status_label)),
          h('td', { class: 'nowrap muted small', text: formatDateTime(ticket.last_message_at) }),
          h(
            'td',
            { class: 'nowrap' },
            h('a', { class: 'btn btn-sm', href: `/admin/ticket/detail?id=${ticket.id}` }, '查看')
          )
        )
      );
    }

    els.empty.classList.toggle('hidden', tickets.length > 0);
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.pageInfo.textContent = `共 ${state.total} 条 · 第 ${state.page} / ${pages} 页`;
    els.prev.disabled = state.page <= 1;
    els.next.disabled = state.page >= pages;
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

  // 待处理排第一个：它是唯一需要你动手的那一档
  function renderCounts(counts) {
    clear(els.stats).append(
      statTile('待处理', String(counts.open), counts.open > 0 ? '需要你回复' : '都回完了'),
      statTile('已回复', String(counts.replied), '等客户回话'),
      statTile('已结束', String(counts.closed), '已归档'),
      statTile('工单总量', String(counts.total), '全部')
    );
  }

  /* ---------------------------------------------------------------------
     数据
     --------------------------------------------------------------------- */

  function fillStatusFilter(statuses) {
    // 只在第一次填充，避免每次刷新都往后追加一批重复项
    if (els.statusFilter.dataset.filled === '1') return;

    for (const s of statuses) {
      els.statusFilter.append(h('option', { value: s.value, text: s.label }));
    }
    els.statusFilter.dataset.filled = '1';
  }

  async function load() {
    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    if (state.status) params.set('status', state.status);
    if (state.q) params.set('q', state.q);

    const res = await Api.get(`/api/admin/tickets?${params}`);
    if (!res.ok) {
      showMessage(els.listMessage, res.error || '加载失败');
      return;
    }

    showMessage(els.listMessage, '');
    state.total = res.data.total;

    fillStatusFilter(res.data.statuses);
    renderCounts(res.data.counts);
    renderRows(res.data.tickets);
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

    // 支持从别处跳过来时带上筛选条件，例如订单详情页的「只看这单的工单」
    const status = new URLSearchParams(window.location.search).get('status');
    if (status) {
      state.status = status;
      els.statusFilter.value = status;
    }

    await load();
  })();
})();
