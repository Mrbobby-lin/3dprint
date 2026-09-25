'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { db } = require('../../db');
const config = require('../lib/config');
const logger = require('../lib/logger');
const storage = require('../services/storage');
const statusMachine = require('../services/statusMachine');
const { requireActor } = require('../middleware/session');
const { createRateLimiter, clientIp } = require('../middleware/rateLimit');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

const uploadLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  maxKeys: 10000,
  keyFn: (req) => clientIp(req),
  message: '上传过于频繁，请稍后再试',
});

// 落盘的临时文件名完全不采用用户输入，只有随机串。
// 真正的类型判定在 storage.detectKind 里按文件内容做，不看扩展名。
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.storageTmpDir),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
  }),
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    fields: 10,
    parts: 15,
  },
});

// multipart 里的非 ASCII 文件名，busboy 默认按 latin1 解码，中文会变乱码。
// 转一次 UTF-8；如果转出来有替换字符，说明它本来就是对的，保留原值。
function fixFilenameEncoding(name) {
  const converted = Buffer.from(name, 'latin1').toString('utf8');
  return converted.includes('�') ? name : converted;
}

// 原始文件名只用于展示。去掉目录部分和控制字符，避免响应头注入和路径干扰。
function sanitizeOrigName(name) {
  const fixed = fixFilenameEncoding(String(name || ''));
  const base = path.basename(fixed.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex -- 就是要清掉控制字符
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 120) || '未命名文件';
}

function canAccess(actor, att) {
  if (actor.role === 'admin') return true;
  // 客户只能碰自己订单上、且标记为双方可见的附件
  return att.order_id === actor.orderId && att.visibility === 'both';
}

function loadAttachment(id) {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!att) throw new AppError(404, '附件不存在');
  return att;
}

function orderAttachmentUsage(orderId) {
  const row = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM attachments WHERE order_id = ?')
    .get(orderId);
  return row;
}

router.use(requireActor);

// POST /api/files —— 字段名 file，另有 order_id（管理员用）和 visibility（仅管理员）
router.post('/', uploadLimiter, upload.single('file'), async (req, res, next) => {
  const tmpPath = req.file?.path;
  let committed = null;

  try {
    if (!req.file) throw new AppError(400, '请选择要上传的文件');

    if (storage.isDiskFull()) {
      throw new AppError(507, '服务器存储空间不足，暂时无法上传');
    }

    // 客户的订单 id 只从 cookie 来，请求体里的 order_id 一律忽略 ——
    // 否则客户只要改个数字就能往别人订单里塞文件。
    const orderId =
      req.actor.role === 'admin'
        ? Number.parseInt(req.body?.order_id, 10)
        : req.actor.orderId;

    if (!Number.isInteger(orderId) || orderId <= 0) throw new AppError(400, '缺少订单 ID');

    const order = db.prepare('SELECT id, order_no, status FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new AppError(404, '订单不存在');

    if (req.actor.role === 'customer' && statusMachine.TERMINAL.has(order.status)) {
      throw new AppError(400, '订单已结束，不能再上传文件');
    }

    const usage = orderAttachmentUsage(orderId);
    if (usage.bytes + req.file.size > config.maxOrderAttachmentBytes) {
      throw new AppError(
        413,
        `该订单附件总量已达上限（${Math.round(config.maxOrderAttachmentBytes / 1024 / 1024)}MB）`
      );
    }

    // 内容判定 —— 改名绕过在这里被拦住
    const kind = await storage.detectKind(tmpPath);
    if (!kind) {
      throw new AppError(400, '不支持的文件类型，仅接受 STL / 3MF / OBJ / PNG / JPG / WEBP');
    }

    // 客户不能创建"仅内部可见"的附件，否则他们自己传的东西自己看不到
    const visibility =
      req.actor.role === 'admin' && req.body?.visibility === 'admin' ? 'admin' : 'both';

    committed = await storage.commitFile(tmpPath, kind);

    let info;
    try {
      info = db
        .prepare(
          `INSERT INTO attachments
             (order_id, stored_name, orig_name, mime_type, size_bytes, visibility, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          orderId,
          committed.storedName,
          sanitizeOrigName(req.file.originalname),
          storage.mimeFor(kind, req.file.mimetype),
          req.file.size,
          visibility,
          req.actor.role,
          new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
        );
    } catch (err) {
      // 记录没落库，磁盘文件就是孤儿，必须删掉
      await storage.removeStored(committed.storedName);
      committed = null;
      throw err;
    }

    logger.info('附件已上传', {
      attachmentId: info.lastInsertRowid,
      orderNo: order.order_no,
      kind,
      size: req.file.size,
      by: req.actor.role,
    });

    res.status(201).json({
      attachment: {
        id: Number(info.lastInsertRowid),
        orig_name: sanitizeOrigName(req.file.originalname),
        mime_type: storage.mimeFor(kind, req.file.mimetype),
        size_bytes: req.file.size,
        visibility,
        uploaded_by: req.actor.role,
        previewable: storage.isPreviewable(kind),
      },
    });
  } catch (err) {
    // 清理临时文件。已经 rename 到最终位置的情况走不到这里 ——
    // 那条路径上的失败会在上面单独处理。
    // tmpPath 若已被移走，unlink 得到 ENOENT，discardTmp 会静默忽略。
    if (tmpPath) await storage.discardTmp(tmpPath);
    next(err);
  }
});

// GET /api/files/:id —— 走鉴权的下载。Nginx 那边 storage/ 目录是 404，
// 所以这是拿到文件的唯一途径。
router.get('/:id', (req, res, next) => {
  try {
    const att = loadAttachment(req.params.id);
    if (!canAccess(req.actor, att)) throw new AppError(403, '无权访问该文件');

    let absPath;
    try {
      absPath = storage.absolutePathOf(att.stored_name);
    } catch {
      throw new AppError(500, '文件路径异常');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // 强制下载而不是内联渲染：上传的 HTML/SVG 若被浏览器当页面执行，
    // 就能在同源下读取 cookie。
    res.download(absPath, att.orig_name, (err) => {
      if (!err) return;
      if (err.code === 'ENOENT') {
        logger.warn('附件文件缺失', { attachmentId: att.id });
        if (!res.headersSent) next(new AppError(404, '文件已不存在'));
        return;
      }
      if (!res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/preview —— 图片内联预览，仅限图片类型
router.get('/:id/preview', (req, res, next) => {
  try {
    const att = loadAttachment(req.params.id);
    if (!canAccess(req.actor, att)) throw new AppError(403, '无权访问该文件');
    if (!/^image\/(png|jpeg|webp)$/.test(att.mime_type)) {
      throw new AppError(400, '该类型不支持预览');
    }

    const absPath = storage.absolutePathOf(att.stored_name);
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(absPath, (err) => {
      if (!err) return;
      if (err.code === 'ENOENT') {
        if (!res.headersSent) next(new AppError(404, '文件已不存在'));
        return;
      }
      if (!res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/files/:id —— 改可见性。只有管理员能动：
// 客户若能把自己的文件设成 admin，反而会让自己看不到，没有意义，
// 更没有理由让客户去改别人（店家）上传文件的可见性。
router.patch('/:id', (req, res, next) => {
  try {
    if (req.actor.role !== 'admin') throw new AppError(403, '无权操作');

    const att = loadAttachment(req.params.id);
    const { visibility } = req.body || {};
    if (visibility !== 'both' && visibility !== 'admin') {
      throw new AppError(400, '可见性只能是 both 或 admin');
    }

    db.prepare('UPDATE attachments SET visibility = ? WHERE id = ?').run(visibility, att.id);
    logger.info('附件可见性已调整', { attachmentId: att.id, visibility });
    res.json({ ok: true, visibility });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/files/:id —— 管理员可删任意，客户只能删自己传的
router.delete('/:id', async (req, res, next) => {
  try {
    const att = loadAttachment(req.params.id);
    if (!canAccess(req.actor, att)) throw new AppError(403, '无权访问该文件');
    if (req.actor.role === 'customer' && att.uploaded_by !== 'customer') {
      throw new AppError(403, '只能删除自己上传的文件');
    }

    db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
    await storage.removeStored(att.stored_name);

    logger.info('附件已删除', { attachmentId: att.id, by: req.actor.role });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
