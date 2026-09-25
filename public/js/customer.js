/* 客户查单页：输入订单号换取会话，然后跳到订单详情页 */

(function () {
  'use strict';

  const { Api, showMessage, setBusy } = window.App;

  const form = document.getElementById('lookup-form');
  const input = document.getElementById('order-no');
  const button = document.getElementById('submit-btn');
  const message = document.getElementById('message');

  document.getElementById('forgot').textContent =
    '忘记订单号了？请联系我们，用下单时留的电话帮你找回。';

  // 已经查过的客户直接进详情页，不用再输一次。
  // 失败就正常显示表单 —— 已经过期或被删的订单会在这里被静默清掉。
  async function skipIfAlreadyIn() {
    const res = await Api.get('/api/customer/order');
    if (res.ok) {
      window.location.replace('/order');
      return true;
    }
    return false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage(message, '');

    const value = input.value.trim();
    if (!value) {
      showMessage(message, '请输入订单号');
      input.focus();
      return;
    }

    setBusy(button, true, '查询中…');
    const res = await Api.post('/api/customer/lookup', { order_no: value });
    setBusy(button, false);

    if (res.ok) {
      // 订单号不放进 URL，只用 cookie 传递，避免出现在浏览历史和 Referer 里
      window.location.href = '/order';
      return;
    }

    if (res.status === 429) {
      showMessage(message, '查询太频繁了，请稍等一会儿再试。');
    } else {
      showMessage(message, res.error || '查询失败，请稍后重试');
    }

    input.select();
  });

  // 输入时自动清理：只保留字母数字，转大写，再按 4 位分组插横线
  input.addEventListener('input', () => {
    const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    const body = raw.startsWith('3D') ? raw.slice(2) : raw;
    const groups = body.slice(0, 12).match(/.{1,4}/g) || [];
    input.value = groups.length ? `3D-${groups.join('-')}` : '';
  });

  input.focus();
  skipIfAlreadyIn();
})();
