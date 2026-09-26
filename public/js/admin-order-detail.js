/* 管理端订单详情：推进状态、查看/上传附件、编辑与删除 */

(function () {
  'use strict';

  const {
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
    requireAdmin,
    logoutAdmin,
    qs,
  } = window.App;

  const orderId = qs('id');
  const els = {
    message: document.getElementById('message'),
    content: document.getElementById('content'),
    loading: document.getElementById('loading'),
    orderNo: document.getElementById('order-no'),
    statusBadge: document.getElementById('status-badge'),
    updatedAt: document.getElementById('updated-at'),
    statusPanel: document.getElementById('status-panel'),
    info: document.getElementById('info'),
    attachments: document.getElementById('attachments'),
    uploadArea: document.getElementById('upload-area'),
    tickets: document.getElementById('tickets'),
    ticketsHint: document.getElementById('tickets-hint'),
    history: document.getElementById('history'),
    editLink: document.getElementById('edit-link'),
    copyBtn: document.getElementById('copy-btn'),
    deleteBtn: document.getElementById('delete-btn'),
  };

  let order = null;
  let meta = null;
  // 允许的下一个状态由服务端算好，和 order 平级返回，不在 order 里面
  let allowedNext = [];

  const statusLabel = (s) => (meta && meta.labels[s]) || s;

  /* ---------------------------------------------------------------------
     渲染
     --------------------------------------------------------------------- */

  function infoItem(label, value, formatter, opts = {}) {
    const formatted = formatter ? formatter(value) : value;
    const empty = formatted === null || formatted === undefined || formatted === '' || formatted === '—';
    return h(
      'div',
      { class: 'info-item' },
      h('div', { class: 'k', text: label + (opts.internal ? '（内部）' : '') }),
      h('div', { class: `v${empty ? ' empty' : ''}`, text: empty ? '—' : formatted })
    );
  }

  function renderInfo() {
    const grid = clear(els.info);
    const yesNo = (v) => (v ? '需要' : '不需要');

    grid.append(
      infoItem('客户姓名', order.customer_name, null, { internal: true }),
      infoItem('联系电话', order.customer_phone, null, { internal: true }),
      infoItem('模型名称', order.model_name),
      infoItem('材料', order.material),
      infoItem('颜色', order.color),
      infoItem('数量', order.quantity, (v) => (v ? `${v} 件` : null)),
      infoItem('层高', order.layer_height, (v) => (v ? `${v} mm` : null)),
      infoItem('填充率', order.infill, (v) => (v === null || v === undefined ? null : `${v}%`)),
      infoItem('支撑', order.need_support, yesNo),
      infoItem('预估重量', order.est_weight_g, (v) => (v ? `${v} g` : null)),
      infoItem('报价', order.price, formatMoney),
      infoItem('预计交付', order.promised_date, formatDate),
      infoItem('下单时间', order.created_at, formatDateTime)
    );

    if (order.customer_note) {
      grid.append(
        h('div', { class: 'info-item' },
          h('div', { class: 'k', text: '客户备注' }),
          h('div', { class: 'v', text: order.customer_note }))
      );
    }
    if (order.admin_note) {
      grid.append(
        h('div', { class: 'info-item' },
          h('div', { class: 'k', text: '内部备注' }),
          h('div', { class: 'v', text: order.admin_note }))
      );
    }
  }

  function renderStatusPanel() {
    const panel = clear(els.statusPanel);
    const allowed = allowedNext;

    // 终态：没有什么可推进的了
    if (allowed.length === 0) {
      panel.append(
        h('p', { class: 'muted mb-0', text: '这是终态，订单已结束，不能再变更状态。' })
      );
      return;
    }

    const select = h('select', { id: 'next-status' });
    for (const item of allowed) select.append(h('option', { value: item.value, text: item.label }));

    const note = h('input', { type: 'text', id: 'status-note', maxlength: '200', placeholder: '选填，例如：已上机打印' });
    const btn = h('button', { class: 'btn btn-primary', text: '更新状态' });

    btn.addEventListener('click', async () => {
      setBusy(btn, true, '更新中…');
      const res = await Api.post(`/api/admin/orders/${orderId}/status`, {
        to_status: select.value,
        note: note.value.trim() || undefined,
      });
      setBusy(btn, false);

      if (res.ok) {
        showMessage(els.message, `状态已更新为「${statusLabel(res.data.order.status)}」`, 'ok');
        await load();
      } else {
        showMessage(els.message, res.error || '更新失败');
      }
    });

    panel.append(
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' },
          h('label', { for: 'next-status', text: '变更为' }),
          select),
        h('div', { class: 'field' },
          h('label', { for: 'status-note', text: '说明' }),
          note)),
      h('div', { class: 'row' }, btn)
    );

    panel.append(forceSection());
  }

  // 越级变更收在折叠区里。日常操作是"按部就班推下一步"，
  // 把它放在显眼位置会诱使人跳过状态。
  function forceSection() {
    const allStatuses = meta.statuses.filter((s) => s.value !== order.status);
    const select = h('select', { id: 'force-status' });
    for (const s of allStatuses) select.append(h('option', { value: s.value, text: s.label }));

    const note = h('input', { type: 'text', id: 'force-note', maxlength: '200', placeholder: '必须填写越级原因' });
    const btn = h('button', { class: 'btn btn-danger', text: '强制变更' });

    btn.addEventListener('click', async () => {
      if (!note.value.trim()) {
        showMessage(els.message, '强制变更必须填写原因', 'error');
        note.focus();
        return;
      }
      if (!window.confirm(`确定强制把状态改为「${statusLabel(select.value)}」？此操作会记入历史。`)) return;

      setBusy(btn, true, '变更中…');
      const res = await Api.post(`/api/admin/orders/${orderId}/status`, {
        to_status: select.value,
        note: note.value.trim(),
        force: true,
      });
      setBusy(btn, false);

      if (res.ok) {
        showMessage(els.message, '已强制变更状态', 'ok');
        await load();
      } else {
        showMessage(els.message, res.error || '变更失败');
      }
    });

    const body = h('div', { class: 'mt-md' },
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' },
          h('label', { for: 'force-status', text: '目标状态' }),
          select),
        h('div', { class: 'field' },
          h('label', { for: 'force-note', text: '原因' }),
          note)),
      btn);

    const details = h('details', { class: 'mt-md' },
      h('summary', { class: 'muted small', text: '需要越级变更？（例如直接跳到已完成）' }));
    details.append(body);

    return details;
  }

  function renderHistory(history) {
    const list = clear(els.history);

    for (const entry of [...history].reverse()) {
      const from = entry.from_status ? statusLabel(entry.from_status) : '新建';
      list.append(
        h('li', { class: 'done' },
          h('span', { class: 'dot' }),
          h('div', { class: 'step-label', text: `${from} → ${statusLabel(entry.to_status)}` }),
          h('div', { class: 'step-meta' }, formatDateTime(entry.created_at),
            // 越级的变更原因只在这里可见，标一下免得管理员以为客户也看得到
            entry.note ? ` · ${entry.note}${entry.internal ? '（内部，客户看不到）' : ''}` : ''))
      );
    }
  }

  function renderAttachments(attachments) {
    const list = clear(els.attachments);

    if (attachments.length === 0) {
      list.append(h('li', { class: 'empty', text: '还没有文件' }));
      return;
    }

    for (const att of attachments) {
      const internal = att.visibility === 'admin';

      const toggle = h('button', {
        class: 'btn btn-sm',
        text: internal ? '设为客户可见' : '设为仅内部',
        onclick: async () => {
          const res = await Api.patch(`/api/files/${att.id}`, {
            visibility: internal ? 'both' : 'admin',
          });
          // 附件可见性接口未实现时给出明确提示，而不是静默失败
          if (res.ok) await load();
          else showMessage(els.message, res.error || '切换失败', 'error');
        },
      });

      list.append(
        h('li', { class: 'attach-item' },
          h('div', { class: 'name' },
            h('div', {}, h('span', { text: att.orig_name }),
              internal ? h('span', { class: 'badge badge-cancelled', text: '仅内部' }) : null),
            h('div', { class: 'meta' },
              formatBytes(att.size_bytes), ' · ',
              att.uploaded_by === 'customer' ? '客户上传' : '管理员上传', ' · ',
              formatDateTime(att.created_at))),
          h('a', { class: 'btn btn-sm', href: `/api/files/${att.id}` }, '下载'),
          toggle,
          h('button', {
            class: 'btn btn-sm btn-danger',
            text: '删除',
            onclick: async () => {
              if (!window.confirm(`确定删除「${att.orig_name}」？`)) return;
              const res = await Api.del(`/api/files/${att.id}`);
              if (res.ok) await load();
              else showMessage(els.message, res.error || '删除失败', 'error');
            },
          }))
      );
    }
  }

  function renderUpload() {
    const area = clear(els.uploadArea);

    const input = h('input', { type: 'file', accept: '.stl,.3mf,.obj,.png,.jpg,.jpeg,.webp' });
    const visibility = h('select', {},
      h('option', { value: 'both', text: '客户可见' }),
      h('option', { value: 'admin', text: '仅内部可见' }));
    const button = h('button', { class: 'btn btn-primary', text: '上传' });
    const hint = h('div', { class: 'hint' });

    button.addEventListener('click', async () => {
      const file = input.files && input.files[0];
      if (!file) {
        hint.textContent = '请先选择文件';
        return;
      }

      const form = new FormData();
      form.append('file', file);
      form.append('order_id', orderId);
      form.append('visibility', visibility.value);

      setBusy(button, true, '上传中…');
      hint.textContent = '';
      const res = await Api.upload('/api/files', form);
      setBusy(button, false);

      if (res.ok) {
        input.value = '';
        await load();
      } else {
        hint.textContent = res.error || '上传失败';
      }
    });

    area.append(
      h('div', { class: 'file-input-row' }, input, visibility, button),
      h('div', { class: 'hint mt-sm', text: '单个文件不超过 20MB。设为「仅内部可见」的文件不会出现在客户查单页面。' }),
      hint
    );
  }

  function renderTickets(tickets) {
    const wrap = clear(els.tickets);
    els.ticketsHint.textContent = tickets.length ? `共 ${tickets.length} 条` : '';

    if (tickets.length === 0) {
      wrap.append(h('p', { class: 'muted small mb-0', text: '这单还没有客户提交的工单。' }));
      return;
    }

    for (const ticket of tickets) {
      wrap.append(
        h('div', { class: 'ticket' },
          h('div', { class: 'ticket-head' },
            h('h3', { text: ticket.subject }),
            badge(ticket.status, ticket.status_label),
            h('span', { class: 'muted small' },
              `${ticket.category_label} · ${ticket.message_count} 条消息 · ${formatDateTime(ticket.last_message_at)}`)),
          h('div', { class: 'mt-sm' },
            h('a', { class: 'btn btn-sm', href: `/admin/ticket/detail?id=${ticket.id}` }, '查看并回复')))
      );
    }
  }

  // 工单区单独请求，失败不影响订单主体；没有工单 API 时这块静默留空
  async function loadTickets() {
    const res = await Api.get(`/api/admin/tickets?order_id=${encodeURIComponent(orderId)}`);
    if (!res.ok) return;
    renderTickets(res.data.tickets);
  }

  /* ---------------------------------------------------------------------
     加载
     --------------------------------------------------------------------- */

  async function load() {
    loadTickets();

    const res = await Api.get(`/api/admin/orders/${orderId}`);
    if (!res.ok) {
      els.loading.classList.add('hidden');
      showMessage(els.message, res.error || '订单不存在');
      return;
    }

    order = res.data.order;
    allowedNext = res.data.allowedNext || [];
    els.loading.classList.add('hidden');
    els.content.classList.remove('hidden');

    els.orderNo.textContent = order.order_no;
    clear(els.statusBadge).append(badge(order.status, statusLabel(order.status)));
    els.updatedAt.textContent = `更新于 ${formatDateTime(order.updated_at)}`;
    els.editLink.href = `/admin/order/form?id=${order.id}`;
    document.title = `${order.order_no} · 订单详情 · B&O`;

    renderInfo();
    renderStatusPanel();
    renderAttachments(res.data.attachments);
    renderUpload();
    renderHistory(res.data.history);
  }

  /* ---------------------------------------------------------------------
     事件
     --------------------------------------------------------------------- */

  els.copyBtn.addEventListener('click', async () => {
    const ok = await copyText(order.order_no);
    els.copyBtn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => {
      els.copyBtn.textContent = '复制订单号';
    }, 1600);
  });

  els.deleteBtn.addEventListener('click', async () => {
    const sure = window.confirm(
      `确定删除订单 ${order.order_no}？\n\n订单的状态记录和上传的文件会一并删除，无法恢复。`
    );
    if (!sure) return;

    setBusy(els.deleteBtn, true, '删除中…');
    const res = await Api.del(`/api/admin/orders/${orderId}`);
    setBusy(els.deleteBtn, false);

    if (res.ok) window.location.href = '/admin/orders';
    else showMessage(els.message, res.error || '删除失败');
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
    if (!orderId) {
      window.location.replace('/admin/orders');
      return;
    }

    const metaRes = await Api.get('/api/admin/meta');
    if (metaRes.ok) {
      meta = {
        labels: Object.fromEntries(metaRes.data.statuses.map((s) => [s.value, s.label])),
        statuses: metaRes.data.statuses,
      };
    }

    await load();
    if (qs('created')) showMessage(els.message, '订单已创建，可以复制订单号发给客户了', 'ok');
  })();
})();
