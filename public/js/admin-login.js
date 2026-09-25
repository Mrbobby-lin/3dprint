/* 管理员登录页 */

(function () {
  'use strict';

  const { Api, showMessage, setBusy } = window.App;

  const form = document.getElementById('login-form');
  const button = document.getElementById('submit-btn');
  const message = document.getElementById('message');
  const hint = document.getElementById('register-hint');

  // 系统里还没有管理员时才显示注册入口。
  // 注册接口本身在已有管理员时也会拒绝，这里只是不给用户指错路。
  async function checkSetupState() {
    const res = await Api.get('/api/auth/status');
    if (!res.ok) return;

    if (res.data.adminExists) {
      // 已登录的话直接进后台，省一步
      const me = await Api.get('/api/auth/me');
      if (me.ok) window.location.replace('/admin/orders');
      return;
    }

    if (res.data.registrationOpen) hint.classList.remove('hidden');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage(message, '');

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
      showMessage(message, '请输入用户名和密码');
      return;
    }

    setBusy(button, true, '登录中…');
    const res = await Api.post('/api/auth/login', { username, password });
    setBusy(button, false);

    if (res.ok) {
      window.location.href = '/admin/orders';
      return;
    }

    showMessage(
      message,
      res.status === 429 ? '尝试次数过多，请稍后再试' : res.error || '登录失败'
    );
    document.getElementById('password').select();
  });

  checkSetupState();
  document.getElementById('username').focus();
})();
