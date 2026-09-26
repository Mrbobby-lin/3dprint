/* 新建 / 编辑订单表单。带 ?id=N 时进入编辑模式。 */

(function () {
  'use strict';

  const {
    Api,
    h,
    clear,
    formatMoney,
    showMessage,
    setBusy,
    requireAdmin,
    logoutAdmin,
    qs,
  } = window.App;

  const orderId = qs('id');
  const isEdit = Boolean(orderId);

  const form = document.getElementById('order-form');
  const message = document.getElementById('message');
  const submitBtn = document.getElementById('submit-btn');
  const hintEl = document.getElementById('price-hint');

  // 和服务端 orders.js 里 price 的上限保持一致
  const PRICE_MAX = 10000000;

  // 元/克。null 表示还没设置过默认单价，此时不做任何自动算价。
  let unitPrice = null;

  // 报价框当前的值是不是系统算出来的。
  //
  // 不能用"框里是否为空"来判断：逐字符输入重量时，输 "8" 会自动填上报价，
  // 再输 "5"（重量变成 85）时框里已经非空，于是不再更新 ——
  // 最终报价是按第一个字符算出来的，而且看起来完全正常。
  // 初始值：新建订单可以自动填，编辑模式绝不自动改价。
  let priceAuto = !isEdit;

  // 字段名 → 取值/赋值方式。用一份映射驱动读取，避免手写十几遍重复代码。
  const TEXT_FIELDS = [
    'customer_name',
    'customer_phone',
    'model_name',
    'color',
    'customer_note',
    'admin_note',
  ];
  const NUMBER_FIELDS = ['quantity', 'layer_height', 'infill', 'est_weight_g', 'price'];
  const OTHER_FIELDS = ['material', 'promised_date'];

  const el = (name) => document.getElementById(name);

  function collect() {
    const body = {};

    for (const name of TEXT_FIELDS) {
      const value = el(name).value.trim();
      // 编辑模式下空字符串表示"清空该字段"，所以要提交；新建时留空则不提交
      if (value || isEdit) body[name] = value;
    }

    for (const name of NUMBER_FIELDS) {
      const raw = el(name).value.trim();
      if (raw === '') {
        if (isEdit) body[name] = '';
      } else {
        body[name] = Number(raw);
      }
    }

    for (const name of OTHER_FIELDS) {
      const value = el(name).value.trim();
      if (value || isEdit) body[name] = value;
    }

    body.need_support = el('need_support').checked;
    return body;
  }

  function fill(order) {
    for (const name of [...TEXT_FIELDS, ...NUMBER_FIELDS, ...OTHER_FIELDS]) {
      const node = el(name);
      if (!node) continue;
      const value = order[name];
      node.value = value === null || value === undefined ? '' : value;
    }
    el('need_support').checked = !!order.need_support;

    // 载入已有订单后禁止自动改价。否则编辑一个当初没报价的订单时，
    // 顺手改个颜色保存，就会把系统算出来的价格悄悄写进库。
    priceAuto = false;
    syncPrice();
  }

  /* ---------------------------------------------------------------------
     自动算价：报价 = 预估重量 × 默认单价
     --------------------------------------------------------------------- */

  // 预估重量按整单总重算，quantity 不参与乘法。
  // 返回 null 表示还算不出来（输入不完整或没设单价）。
  function computePrice() {
    if (typeof unitPrice !== 'number' || !(unitPrice > 0)) return null;
    const weight = Number(el('est_weight_g').value.trim());
    if (!Number.isFinite(weight) || !(weight > 0)) return null;
    return Math.round(weight * unitPrice * 100) / 100;
  }

  function appendHint(text) {
    if (hintEl) hintEl.append(document.createTextNode(text));
  }

  function renderHint() {
    if (!hintEl) return;
    clear(hintEl);

    if (typeof unitPrice !== 'number' || !(unitPrice > 0)) {
      appendHint('还没设置默认单价，去「设置」里填一个，之后新建订单就能自动算价。');
      return;
    }

    const weight = Number(el('est_weight_g').value.trim());
    if (!Number.isFinite(weight) || !(weight > 0)) {
      appendHint(`填入预估重量后自动算价（当前单价 ¥${unitPrice}/g）。`);
      return;
    }

    const computed = computePrice();
    const formula = `¥${unitPrice}/g × ${weight}g = ${formatMoney(computed)}`;

    if (computed > PRICE_MAX) {
      appendHint(`按单价算是 ${formatMoney(computed)}，超过了报价上限，没有自动填入。`);
      return;
    }

    const current = el('price').value.trim();
    if (current !== '' && Number(current) === computed) {
      appendHint(formula);
      return;
    }

    appendHint(`${formula}。`);
    hintEl.append(
      h(
        'button',
        {
          // h() 只设属性，而 <button> 默认是 type=submit，
          // 放在 <form> 里点一下会直接提交表单
          type: 'button',
          class: 'btn btn-link btn-sm',
          onclick: () => {
            el('price').value = String(computed);
            priceAuto = false;
            renderHint();
          },
        },
        `按单价填入 ${formatMoney(computed)}`
      )
    );
  }

  // 重算并把结果写进报价框（只有 priceAuto 为真时才允许写）
  function syncPrice() {
    const computed = computePrice();

    if (priceAuto) {
      if (computed === null) {
        // 输入还不完整（比如重量刚输到 "85."），保持原值别动
      } else if (computed > PRICE_MAX) {
        // 这次算出来的值超限了，框里那个必然是上一个重量留下的，清掉
        el('price').value = '';
      } else {
        el('price').value = String(computed);
      }
    }

    renderHint();
  }

  el('est_weight_g').addEventListener('input', syncPrice);

  el('price').addEventListener('input', () => {
    // 手动打字即解除自动填充，清空则重新武装
    priceAuto = el('price').value.trim() === '';
    renderHint();
  });

  async function loadMeta() {
    const res = await Api.get('/api/admin/meta');
    if (!res.ok) return;
    const select = el('material');
    clear(select);
    for (const m of res.data.materials) select.append(h('option', { value: m, text: m }));

    // 单价跟着 meta 一起回来，省一次请求，也避免它和 loadOrder() 抢时序
    unitPrice = typeof res.data.unit_price === 'number' ? res.data.unit_price : null;
    syncPrice();
  }

  async function loadOrder() {
    const res = await Api.get(`/api/admin/orders/${orderId}`);
    if (!res.ok) {
      showMessage(message, res.error || '订单不存在');
      form.classList.add('hidden');
      return;
    }

    const order = res.data.order;
    fill(order);

    document.getElementById('page-title').textContent = `编辑订单 ${order.order_no}`;
    document.getElementById('order-no-hint').textContent = `当前状态：${order.status}`;
    submitBtn.textContent = '保存修改';
    document.title = `编辑订单 ${order.order_no} · B&O`;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage(message, '');

    const body = collect();
    if (!body.model_name) {
      showMessage(message, '请填写模型名称');
      el('model_name').focus();
      return;
    }
    if (!body.customer_name) {
      showMessage(message, '请填写客户姓名');
      el('customer_name').focus();
      return;
    }
    if (!body.customer_phone) {
      showMessage(message, '请填写联系电话');
      el('customer_phone').focus();
      return;
    }

    setBusy(submitBtn, true, isEdit ? '保存中…' : '创建中…');
    const res = isEdit
      ? await Api.patch(`/api/admin/orders/${orderId}`, body)
      : await Api.post('/api/admin/orders', body);
    setBusy(submitBtn, false);

    if (!res.ok) {
      showMessage(message, res.error || '保存失败');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const order = res.data.order;
    // 新建成功后直接进详情页，方便接着传文件、推状态
    window.location.href = `/admin/order/detail?id=${order.id}&created=1`;
  });

  document.getElementById('logout-link').addEventListener('click', (event) => {
    event.preventDefault();
    logoutAdmin();
  });

  (async () => {
    if (!(await requireAdmin())) return;
    await loadMeta();
    if (isEdit) await loadOrder();
    else el('customer_name').focus();
  })();
})();
