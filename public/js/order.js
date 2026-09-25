/* 客户订单详情页：进度时间线 + 订单信息 + 附件上传下载 */

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
  } = window.App;

  const els = {
    message: document.getElementById('message'),
    content: document.getElementById('content'),
    loading: document.getElementById('loading'),
    orderNo: document.getElementById('order-no'),
    statusBadge: document.getElementById('status-badge'),
    updatedAt: document.getElementById('updated-at'),
    timeline: document.getElementById('timeline'),
    info: document.getElementById('info'),
    attachments: document.getElementById('attachments'),
    uploadArea: document.getElementById('upload-area'),
  };

  let current = null; // 当前订单，上传/删除后用来刷新

  /* ---------------------------------------------------------------------
     渲染
     --------------------------------------------------------------------- */

  function renderTimeline(timeline) {
    const list = clear(els.timeline);

    for (const step of timeline.steps) {
      const isCurrent = step.status === timeline.current;
      const classes = ['timeline-item'];
      if (step.reached) classes.push('done');
      if (isCurrent) classes.push('current');

      list.append(
        h(
          'li',
          { class: classes.join(' ') },
          h('span', { class: 'dot' }),
          h('div', { class: 'step-label', text: step.label }),
          step.at
            ? h(
                'div',
                { class: 'step-meta' },
                formatDateTime(step.at),
                step.note ? ` · ${step.note}` : ''
              )
            : null
        )
      );
    }

    // 已取消的订单，在时间线末尾补一个红色节点，
    // 否则客户看到的会是"走到一半就没下文了"
    if (timeline.cancelled) {
      list.append(
        h(
          'li',
          { class: 'cancelled' },
          h('span', { class: 'dot' }),
          h('div', { class: 'step-label', text: '已取消' }),
          h(
            'div',
            { class: 'step-meta' },
            formatDateTime(timeline.cancelled.at),
            timeline.cancelled.note ? ` · ${timeline.cancelled.note}` : ''
          )
        )
      );
    }
  }

  function infoItem(label, value, formatter) {
    const formatted = formatter ? formatter(value) : value;
    const isEmpty = formatted === null || formatted === undefined || formatted === '' || formatted === '—';
    return h(
      'div',
      { class: 'info-item' },
      h('div', { class: 'k', text: label }),
      h('div', { class: `v${isEmpty ? ' empty' : ''}`, text: isEmpty ? '—' : formatted })
    );
  }

  function renderInfo(order) {
    const grid = clear(els.info);
    const yesNo = (v) => (v ? '需要' : '不需要');

    grid.append(
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
        h(
          'div',
          { class: 'info-item' },
          h('div', { class: 'k', text: '我的备注' }),
          h('div', { class: 'v', text: order.customer_note })
        )
      );
    }
  }

  function attachmentItem(att) {
    const item = h(
      'li',
      { class: 'attach-item' },
      h('div', { class: 'name' }, h('div', { text: att.orig_name }),
        h('div', { class: 'meta' },
          formatBytes(att.size_bytes), ' · ',
          att.uploaded_by === 'customer' ? '我上传的' : '店家提供', ' · ',
          formatDateTime(att.created_at))),
      h('a', { class: 'btn btn-sm', href: `/api/files/${att.id}` }, '下载')
    );

    if (att.uploaded_by === 'customer') {
      item.append(
        h('button', {
          class: 'btn btn-sm btn-danger',
          text: '删除',
          onclick: () => removeAttachment(att),
        })
      );
    }

    return item;
  }

  function renderAttachments(attachments) {
    const list = clear(els.attachments);

    if (!attachments || attachments.length === 0) {
      list.append(h('li', { class: 'empty', text: '还没有文件' }));
      return;
    }

    for (const att of attachments) list.append(attachmentItem(att));
  }

  async function removeAttachment(att) {
    if (!window.confirm(`确定删除「${att.orig_name}」？此操作不可撤销。`)) return;
    const res = await Api.del(`/api/files/${att.id}`);
    if (res.ok) {
      showMessage(els.message, '已删除', 'ok');
      await load();
    } else {
      showMessage(els.message, res.error || '删除失败');
    }
  }

  /* ---------------------------------------------------------------------
     上传
     --------------------------------------------------------------------- */

  function renderUpload(order) {
    const area = clear(els.uploadArea);
    const terminal = order.status === 'cancelled' || order.status === 'delivered';

    if (terminal) {
      area.append(
        h('p', {
          class: 'muted small mb-0',
          text: '订单已结束，如需补充文件请联系我们。',
        })
      );
      return;
    }

    const input = h('input', {
      type: 'file',
      id: 'file-input',
      accept: '.stl,.3mf,.obj,.png,.jpg,.jpeg,.webp',
    });
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
      // 注意：这里不传 order_id —— 服务端只认 cookie 里的订单，
      // 前端传什么都不会改变文件归属

      setBusy(button, true, '上传中…');
      hint.textContent = '';

      const res = await Api.upload('/api/files', form);
      setBusy(button, false);

      if (res.ok) {
        input.value = '';
        showMessage(els.message, `「${res.data.attachment.orig_name}」上传成功`, 'ok');
        await load();
      } else {
        hint.textContent = res.error || '上传失败';
      }
    });

    area.append(
      h('div', { class: 'file-input-row' }, input, button),
      h('div', { class: 'hint mt-sm', text: '单个文件不超过 20MB。可以直接上传模型文件，也可以传照片说明问题。' }),
      hint
    );
  }

  /* ---------------------------------------------------------------------
     加载
     --------------------------------------------------------------------- */

  async function load() {
    const [orderRes, historyRes] = await Promise.all([
      Api.get('/api/customer/order'),
      Api.get('/api/customer/order/history'),
    ]);

    if (orderRes.status === 401) {
      window.location.replace('/');
      return;
    }

    // 订单被删掉了（404）也回首页重新查
    if (!orderRes.ok) {
      if (orderRes.status === 404) {
        window.location.replace('/');
        return;
      }
      els.loading.classList.add('hidden');
      showMessage(els.message, orderRes.error || '加载失败，请刷新重试');
      return;
    }

    const order = orderRes.data.order;
    const attachments = orderRes.data.attachments || [];
    current = order;

    els.loading.classList.add('hidden');
    els.content.classList.remove('hidden');

    els.orderNo.textContent = order.order_no;
    clear(els.statusBadge).append(badge(order.status, order.status_label));
    els.updatedAt.textContent = order.updated_at ? `更新于 ${formatDateTime(order.updated_at)}` : '';

    renderTimeline(historyRes.data.timeline);
    renderInfo(order);
    renderAttachments(attachments);
    renderUpload(order);
  }

  /* ---------------------------------------------------------------------
     事件绑定
     --------------------------------------------------------------------- */

  document.getElementById('copy-btn').addEventListener('click', async (event) => {
    if (!current) return;
    const ok = await copyText(current.order_no);
    const btn = event.currentTarget;
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => {
      btn.textContent = '复制订单号';
    }, 1600);
  });

  document.getElementById('print-btn').addEventListener('click', () => window.print());

  document.getElementById('logout-link').addEventListener('click', async (event) => {
    event.preventDefault();
    await Api.post('/api/customer/logout', {});
    window.location.href = '/';
  });

  load();
})();
