/* 后台设置：目前只有默认单价一项 */

(function () {
  'use strict';

  const { Api, showMessage, setBusy, requireAdmin, logoutAdmin } = window.App;

  const form = document.getElementById('settings-form');
  const message = document.getElementById('message');
  const submitBtn = document.getElementById('submit-btn');
  const priceInput = document.getElementById('default_unit_price');

  async function load() {
    const res = await Api.get('/api/admin/settings');
    if (!res.ok) {
      showMessage(message, res.error || '读取设置失败');
      return;
    }
    const value = res.data.settings.default_unit_price;
    // null 是"没设置"，要显示成空框而不是 0
    priceInput.value = value === null || value === undefined ? '' : value;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage(message, '');

    const raw = priceInput.value.trim();
    // 空字符串在服务端等于"清除该项"，正是这里想要的意思
    const payload = { default_unit_price: raw === '' ? null : Number(raw) };

    if (raw !== '' && !Number.isFinite(payload.default_unit_price)) {
      showMessage(message, '默认单价必须是数字');
      priceInput.focus();
      return;
    }

    setBusy(submitBtn, true, '保存中…');
    const res = await Api.patch('/api/admin/settings', payload);
    setBusy(submitBtn, false);

    if (!res.ok) {
      showMessage(message, res.error || '保存失败');
      return;
    }

    const saved = res.data.settings.default_unit_price;
    priceInput.value = saved === null || saved === undefined ? '' : saved;
    showMessage(message, raw === '' ? '已保存，自动算价已关闭' : '已保存', 'ok');
  });

  document.getElementById('logout-link').addEventListener('click', (event) => {
    event.preventDefault();
    logoutAdmin();
  });

  (async () => {
    if (!(await requireAdmin())) return;
    await load();
  })();
})();
