'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/lib/config');
const logger = require('../src/lib/logger');

// 用 Node 内置的 SQLite，不引 better-sqlite3。
// 好处是彻底没有原生依赖 —— Windows 开发机不需要装 VS Build Tools，
// Linux 服务器也不需要装编译链，npm install 永远不会有 gyp 报错。
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(
    '致命错误：当前 Node 不支持 node:sqlite。\n' +
      '  需要 Node 22.5 或更高版本。当前版本：' +
      process.version
  );
  process.exit(1);
}

// SQLite 不会自动创建父目录，目录不存在时报 "unable to open database file"
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

// node:sqlite 默认把 INTEGER 映射为 number（超出 2^53 才退化），
// 我们的 id 和时间戳都远小于这个数。
const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON'); // SQLite 默认关闭，不开的话 ON DELETE CASCADE 静默失效
db.exec('PRAGMA busy_timeout = 5000');

const mode = db.prepare('PRAGMA journal_mode').get();
logger.debug('数据库已连接', { file: config.dbFile, journalMode: mode?.journal_mode });

/**
 * 事务包装。node:sqlite 没有 better-sqlite3 那样的 db.transaction()，
 * 所以自己包一层，保证异常时一定回滚。
 * 用 BEGIN IMMEDIATE 而不是 BEGIN：直接以写事务开始，避免读→写升级时的锁竞争。
 */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn();
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务可能已经因为错误自动回滚了，这里失败无所谓
    }
    throw err;
  }
  db.exec('COMMIT');
  return result;
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // 每个迁移文件单独一个事务：要么整个文件生效，要么完全回滚，
    // 不会留下半张表让下次启动卡在中间状态。
    tx(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
    });
    logger.info('已应用数据库迁移', { file });
  }
}

migrate();

module.exports = { db, tx };
