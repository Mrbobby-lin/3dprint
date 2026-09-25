/* 管理端工单详情：对话线程 + 回复 + 结束/重新打开 */

(function () {
  'use strict';

  const {
    Api,
    h,
    clear,
    formatDateTime,
    showMessage,
    setBusy,
    badge,
    requireAdmin,
    logoutAdmin,
    qs,
  } = window.App;

  const ticketId = qs('id');

  const els = {
    message: document.getElementById('message'),
    content: document.getElementById('content'),
    loading: document.getElementById('loading'),
    subject: document.getElementById('subject'),
    statusBadgeSlot: document.getElementById('status-badge-slot'),
    info: document.getElementById('info'),
    closeBtn: document.getElementById('close-btn'),
    reopenBtn: document.getElementById('reopen-btn'),
    orderLink: document.getElementById('order-link'),
    threadHint: document.getElementById('thread-hint'),
    thread: document.getElementById('thread'),
    replyForm: document.getElementById('reply-form'),
    replyBody: document.getElementById('reply-body'),
    replyBtn: document.getElementById('reply-btn'),
  };

  let ticket = null;

  /* ---------------------------------------------------------------------
     渲染
     --------------------------------------------------------------------- */

  function infoItem(label, node) {
    return h(
      'div',
      { class: 'info-item' },
      h('div', { class: 'k', text: label }),
      h('div', { class: 'v' }, node)
    );
  }

  function renderHeader() {
    els.subject.textContent = ticket.subject;
    els.orderLink.href = `/admin/order/detail?id=${ticket.order_id}`;

    clear(els.statusBadgeSlot).append(badge(ticket.status, ticket.status_label));
    clear(els.info).append(
      infoItem(
        '所属订单',
        h('a', { href: `/admin/order/detail?id=${ticket.order_id}` }, ticket.order_no)
      ),
      infoItem('客户', ticket.customer_name),
      infoItem('分类', ticket.category_label),
      infoItem('创建时间', formatDateTime(ticket.created_at)),
      infoItem('最后更新', formatDateTime(ticket.updated_at))
    );
  }

  function renderThread(messages) {
    const wrap = clear(els.thread);

    if (messages.length === 0) {
      wrap.append(h('div', { class: 'empty', text: '还没有消息' }));
      return;
    }

    for (const m of messages) {
      // from-me 是店家自己这边（靠右），from-them 是客户（靠左）
      wrap.append(
        h(
          'div',
          { class: `thread-msg ${m.author === 'admin' ? 'from-me' : 'from-them'}` },
          h('div', { class: 'body', text: m.body }),
          h('div', {
            class: 'meta',
            text: `${m.author === 'admin' ? '我（店家）' : '客户'} · ${formatDateTime(m.created_at)}`,
          })
        )
      );
    }

    els.threadHint.textContent = `共 ${messages.length} 条`;
  }

  function renderActions() {
    const closed = ticket.status === 'closed';
    els.closeBtn.classList.toggle('hidden', closed);
    els.reopenBtn.classList.toggle('hidden', !closed);
  }

  function applyPayload(data) {
    ticket = data.ticket;
    renderHeader();
    renderThread(data.messages);
    renderActions();
  }

  /* ---------------------------------------------------------------------
     加载
     --------------------------------------------------------------------- */

  async function load() {
    const res = await Api.get(`/api/admin/tickets/${encodeURIComponent(ticketId)}`);

    if (!res.ok) {
      els.loading.classList.add('hidden');
      showMessage(els.message, res.error || '工单加载失败');
      return;
    }

    els.loading.classList.add('hidden');
    els.content.classList.remove('hidden');
    applyPayload(res.data);
  }

  /* ---------------------------------------------------------------------
     事件
     --------------------------------------------------------------------- */

  els.replyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = els.replyBody.value.trim();

    if (!body) {
      showMessage(els.message, '请先写回复内容');
      els.replyBody.focus();
      return;
    }

    setBusy(els.replyBtn, true, '发送中…');
    const res = await Api.post(`/api/admin/tickets/${ticketId}/messages`, { body });
    setBusy(els.replyBtn, false);

    if (!res.ok) {
      showMessage(els.message, res.error || '发送失败，请重试');
      return;
    }

    els.replyBody.value = '';
    applyPayload(res.data);
    showMessage(els.message, '回复已发送，客户在查单页能看到', 'ok');
  });

  els.closeBtn.addEventListener('click', async () => {
    const res = await Api.patch(`/api/admin/tickets/${ticketId}`, { status: 'closed' });
    if (!res.ok) {
      showMessage(els.message, res.error || '操作失败');
      return;
    }
    ticket = res.data.ticket;
    renderHeader();
    renderActions();
    showMessage(els.message, '已标记结束。客户如果再来追问，工单会自动回到待处理。', 'ok');
  });

  els.reopenBtn.addEventListener('click', async () => {
    const res = await Api.patch(`/api/admin/tickets/${ticketId}`, { status: 'open' });
    if (!res.ok) {
      showMessage(els.message, res.error || '操作失败');
      return;
    }
    ticket = res.data.ticket;
    renderHeader();
    renderActions();
    showMessage(els.message, '工单已重新打开', 'ok');
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

    if (!ticketId) {
      els.loading.classList.add('hidden');
      showMessage(els.message, '缺少工单 ID，请从工单列表进入');
      return;
    }

    await load();
  })();
})();
