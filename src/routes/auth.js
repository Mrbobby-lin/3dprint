'use strict';

const express = require('express');

const { db } = require('../../db');
const config = require('../lib/config');
const logger = require('../lib/logger');
const { hashPassword, verifyPassword, validatePasswordStrength } = require('../services/password');
const { setAdminCookie, clearCookies, requireAdmin } = require('../middleware/session');
const { createRateLimiter, clientIp } = require('../middleware/rateLimit');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

// 登录限流：比客户查单宽松些（自己人会输错），但足以挡住在线撞库
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  maxKeys: 5000,
  keyFn: (req) => clientIp(req),
  message: '登录尝试过于频繁，请 15 分钟后再试',
});

// 用于在账号不存在时消耗等量时间，避免通过响应快慢判断用户名是否存在。
// 模块加载时算一次，之后复用。
const DUMMY_HASH = hashPassword('timing-equalizer-not-a-real-password');

function adminExists() {
  return !!db.prepare('SELECT 1 FROM admin WHERE id = 1').get();
}

// POST /api/auth/register —— 只允许注册一次
router.post('/register', (req, res, next) => {
  try {
    // 开关关闭后直接 404，不暴露"这里曾经有注册接口"
    if (!config.allowAdminRegistration) throw new AppError(404, '接口不存在');

    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new AppError(400, '用户名需为 3-32 位字母、数字或下划线');
    }
    const weak = validatePasswordStrength(password);
    if (weak) throw new AppError(400, weak);

    const passwordHash = hashPassword(password);

    try {
      // id 固定为 1，配合表上的 CHECK (id = 1)：
      // 并发注册时第二个请求会撞主键，数据库层面挡住，不依赖应用层判断。
      db.prepare('INSERT INTO admin (id, username, password_hash) VALUES (1, ?, ?)').run(
        username,
        passwordHash
      );
    } catch (err) {
      // node:sqlite 把 SQLite 错误统一报成 code='ERR_SQLITE_ERROR'，
      // 具体原因在 errcode 里。SQLITE_CONSTRAINT 的基础码是 19，
      // 扩展码按 19 | (n << 8) 组合（CHECK=275、PRIMARYKEY=1555、UNIQUE=2067），
      // 所以取低 8 位比较。
      if ((err.errcode & 0xff) === 19) {
        throw new AppError(409, '管理员已存在，系统只允许一个管理员账号');
      }
      throw err;
    }

    setAdminCookie(res, 1, 1);
    logger.info('管理员账号已创建', { username });
    res.status(201).json({ ok: true, username });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/status —— 前端用来判断该显示登录页还是注册页
router.get('/status', (req, res) => {
  res.json({
    adminExists: adminExists(),
    registrationOpen: config.allowAdminRegistration && !adminExists(),
  });
});

// POST /api/auth/login
router.post('/login', loginLimiter, (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new AppError(400, '请输入用户名和密码');
    }

    const admin = db.prepare('SELECT * FROM admin WHERE username = ?').get(username);

    // 账号不存在时也跑一次同代价的校验，让两种情况耗时一致
    const ok = admin
      ? verifyPassword(password, admin.password_hash)
      : (verifyPassword(password, DUMMY_HASH), false);

    if (!ok) throw new AppError(401, '用户名或密码错误');

    setAdminCookie(res, admin.id, admin.session_epoch);
    logger.info('管理员登录', { username: admin.username });
    res.json({ ok: true, username: admin.username });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearCookies(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username });
});

// POST /api/auth/password —— 改密后递增 session_epoch，所有旧会话立即失效
router.post('/password', requireAdmin, (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(req.admin.id);
    if (!verifyPassword(currentPassword, admin.password_hash)) {
      throw new AppError(401, '当前密码不正确');
    }

    const weak = validatePasswordStrength(newPassword);
    if (weak) throw new AppError(400, weak);
    if (currentPassword === newPassword) throw new AppError(400, '新密码不能与当前密码相同');

    const epoch = admin.session_epoch + 1;
    db.prepare('UPDATE admin SET password_hash = ?, session_epoch = ? WHERE id = ?').run(
      hashPassword(newPassword),
      epoch,
      admin.id
    );

    setAdminCookie(res, admin.id, epoch);
    logger.info('管理员密码已修改，所有旧会话已失效', { username: admin.username });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
