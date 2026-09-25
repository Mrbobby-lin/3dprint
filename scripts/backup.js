'use strict';

/**
 * 数据库备份。
 *
 * 用 SQLite 的 VACUUM INTO 而不是复制文件：
 * 数据库跑在 WAL 模式下，直接 cp 只能拿到主库文件，
 * 尚未 checkpoint 的事务还在 -wal 里，复制出来的是一份缺数据的快照。
 * VACUUM INTO 由 SQLite 自己保证一致性，且产物是紧凑的单文件。
 *
 * 用法： npm run backup
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const config = require('../src/lib/config');

const KEEP = 14; // 保留最近 14 份

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function main() {
  if (!fs.existsSync(config.dbFile)) {
    console.error(`数据库文件不存在：${config.dbFile}`);
    process.exit(1);
  }

  fs.mkdirSync(config.backupDir, { recursive: true });
  const target = path.join(config.backupDir, `app-${timestamp()}.db`);

  if (fs.existsSync(target)) {
    console.error(`目标文件已存在：${target}`);
    process.exit(1);
  }

  const db = new DatabaseSync(config.dbFile);
  try {
    // 路径里的单引号要转义，否则拼出来的 SQL 会断掉
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  // 备份完立刻验证，而不是等到真需要恢复时才发现文件是坏的
  const check = new DatabaseSync(target, { readOnly: true });
  let result;
  try {
    result = check.prepare('PRAGMA integrity_check').get();
    const counts = {
      orders: check.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
      admin: check.prepare('SELECT COUNT(*) AS n FROM admin').get().n,
    };
    console.log(`完整性检查：${result.integrity_check}`);
    console.log(`订单 ${counts.orders} 条，管理员 ${counts.admin} 个`);
    if (result.integrity_check !== 'ok') {
      console.error('备份文件完整性检查未通过，请勿删除原始数据库');
      process.exit(1);
    }
  } finally {
    check.close();
  }

  const size = fs.statSync(target).size;
  console.log(`备份完成：${target} (${(size / 1024).toFixed(1)} KB)`);

  // 清理旧备份
  const files = fs
    .readdirSync(config.backupDir)
    .filter((f) => /^app-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse();

  for (const stale of files.slice(KEEP)) {
    fs.unlinkSync(path.join(config.backupDir, stale));
    console.log(`已清理旧备份：${stale}`);
  }

  console.log(`当前保留 ${Math.min(files.length, KEEP)} 份备份`);
  console.log('');
  console.log('提示：备份只含数据库。附件文件在 storage/ 目录里，');
  console.log('      恢复时要把两者一起还原，否则订单还在但文件打不开。');
}

main();
