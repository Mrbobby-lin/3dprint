/* 管理员注册页 —— 全系统只能注册一次 */

(function () {
  'use strict';

  const { Api, showMessage, setBusy } = window.App;

  const form = document.getElementById('register-form');
  const button = document.getElementById('submit-btn');
  const message = document.getElementById('message');
  const usernameEl = document.getElementById('username');
  const passwordEl = document.getElementById('password');
  const confirmEl = document.getElementById('confirm');

  // 已经有管理员了就别让用户白填一遍表单
  async function guard() {
    const res = await Api.get('/api/auth/status');
    if (!res.ok) return;

    if (!res.data.registrationOpen) {
      showMessage(message, '系统已存在管理员，注册入口已关闭。');
      button.disabled = true;
      for (const el of [usernameEl, passwordEl, confirmEl]) el.disabled = true;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage(message, '');

    const username = usernameEl.value.trim();
    const password = passwordEl.value;
    const confirm = confirmEl.value;

    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      showMessage(message, '用户名需为 3-32 位字母、数字或下划线');
      usernameEl.focus();
      return;
    }
    if (password.length < 10) {
      showMessage(message, '密码至少需要 10 位');
      passwordEl.focus();
      return;
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      showMessage(message, '密码需要同时包含字母和数字');
      passwordEl.focus();
      return;
    }
    if (password !== confirm) {
      showMessage(message, '两次输入的密码不一致');
      confirmEl.focus();
      return;
    }

    setBusy(button, true, '创建中…');
    const res = await Api.post('/api/auth/register', { username, password });
    setBusy(button, false);

    if (res.ok) {
      window.location.href = '/admin/orders';
      return;
    }

    showMessage(message, res.error || '注册失败');
  });

  guard();
  usernameEl.focus();
})();
