'use strict';

const crypto = require('node:crypto');
const config = require('../lib/config');
const logger = require('../lib/logger');

// 业务错误：message 可以安全地展示给用户
class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function notFound(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: '接口不存在' });
  }
  res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>404</title>' +
      '<p>页面不存在。<a href="/">返回首页</a></p>'
  );
}

// eslint-disable-next-line no-unused-vars -- Express 靠 4 个参数识别错误处理器
function errorHandler(err, req, res, next) {
  const requestId = req.id || crypto.randomUUID();

  // multer 的错误有自己的 code，映射成用户能看懂的中文
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : null;

  if (err.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    message = `文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB 上限`;
  } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    status = 400;
    message = '上传字段不正确';
  }

  if (status >= 500) {
    logger.error('未处理的请求异常', {
      requestId,
      method: req.method,
      path: req.path,
      err: err.message,
      // 堆栈只进日志，永不进响应体
      stack: config.isProd ? undefined : err.stack,
    });
  } else {
    logger.warn('请求被拒绝', { requestId, method: req.method, path: req.path, status });
  }

  if (res.headersSent) return;

  const body = {
    error: message || '服务器内部错误，请稍后重试',
    requestId,
  };
  if (!config.isProd) body.detail = err.message;
  res.status(status).json(body);
}

function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { AppError, notFound, errorHandler, requestId };
