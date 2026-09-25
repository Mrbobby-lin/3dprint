'use strict';

const express = require('express');

const settings = require('../services/settings');
const { requireAdmin } = require('../middleware/session');

const router = express.Router();

// 路由级兜底，和 adminOrders.js 一致 —— 以后加子路由不用记得单独鉴权
router.use(requireAdmin);

// GET /api/admin/settings
router.get('/', (req, res, next) => {
  try {
    res.json({ settings: settings.all() });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/settings
router.patch('/', (req, res, next) => {
  try {
    res.json({ settings: settings.update(req.body) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
