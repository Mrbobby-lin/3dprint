/* 管理员修改密码 */

(function () {
  'use strict';

  const { Api, showMessage, setBusy, requireAdmin, logoutAdmin } = window.App;

  const form = document.getElementById('password-form');
  const button = document.getElementById('submit-btn');
  const message = document.getElementById('message');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage(message, '');

    const currentPassword = document.getElementById('current').value;
    const newPassword = document.getElementById('next').value;
    const confirm = document.getElementById('confirm').value;

    if (!currentPassword) {
      showMessage(message, '请输入当前密码');
      return;
    }
    if (newPassword.length < 10) {
      showMessage(message, '新密码至少需要 10 位');
      return;
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      showMessage(message, '新密码需要同时包含字母和数字');
      return;
    }
    if (newPassword !== confirm) {
      showMessage(message, '两次输入的新密码不一致');
      return;
    }
    if (newPassword === currentPassword) {
      showMessage(message, '新密码不能与当前密码相同');
      return;
    }

    setBusy(button, true, '保存中…');
    const res = await Api.post('/api/auth/password', { currentPassword, newPassword });
    setBusy(button, false);

    if (res.ok) {
      form.reset();
      showMessage(message, '密码已修改，其它设备需要重新登录', 'ok');
      return;
    }

    showMessage(message, res.error || '修改失败');
  });

  document.getElementById('logout-link').addEventListener('click', (event) => {
    event.preventDefault();
    logoutAdmin();
  });

  (async () => {
    if (!(await requireAdmin())) return;
    document.getElementById('current').focus();
  })();
})();
