'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./src/lib/config');
const logger = require('./src/lib/logger');
const { securityHeaders, originCheck } = require('./src/middleware/security');
const { AppError, notFound, errorHandler, requestId } = require('./src/middleware/errorHandler');

require('./db'); // 触发连接与迁移

const app = express();

// ---------------------------------------------------------------------------
// 中间件装配顺序很关键，改动前请确认不会让安全措施静默失效
// ---------------------------------------------------------------------------

// 必须是 'loopback' 而不是 true。true 会信任任意来源的 X-Forwarded-For，
// 攻击者伪造这个头就能绕过所有基于 IP 的限流 —— 而且不会有任何报错。
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(requestId);
app.use(securityHeaders);

// 访问日志：订单号在 logger 里统一脱敏
app.use((req, res, next) => {
  if (config.isTest) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('http', {
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      ip: req.ip,
    });
  });
  next();
});

// JSON 体积上限压到 100kb：表单提交远用不到更大，压缩了 body 型 DoS 的面
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());
app.use(originCheck);

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: config.isProd ? '1h' : 0,
    // storage/ 不在 public/ 下，这里再显式声明一次，防止以后有人挪目录
    dotfiles: 'ignore',
  })
);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 路由挂载点（后续阶段逐个接入）
app.use('/api/auth', require('./src/routes/auth'));
// 必须挂在 /api/admin 之前：adminOrders 用了 router.use(requireAdmin)，
// 挂在它后面的话 /api/admin/settings 的请求会先进那个路由并被它吞掉。
app.use('/api/admin/settings', require('./src/routes/adminSettings'));
app.use('/api/admin', require('./src/routes/adminOrders'));
app.use('/api/customer', require('./src/routes/customer'));
app.use('/api/files', require('./src/routes/files'));

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  const server = app.listen(config.port, config.host, () => {
    logger.info('服务已启动', {
      url: `http://${config.host}:${config.port}`,
      env: config.isProd ? 'production' : 'development',
      db: config.dbFile,
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      logger.info('收到退出信号，正在关闭', { signal });
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

module.exports = app;
