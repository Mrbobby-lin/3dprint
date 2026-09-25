'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('../lib/config');
const logger = require('../lib/logger');

const UPLOAD_DIR = path.join(config.storageDir, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(config.storageTmpDir, { recursive: true });

// 允许的类型 → 落盘用的扩展名。扩展名由服务端按检测结果决定，
// 完全不采信用户提供的文件名。
const KIND_EXT = {
  stl: '.stl',
  '3mf': '.3mf',
  obj: '.obj',
  png: '.png',
  jpeg: '.jpg',
  webp: '.webp',
};

const KIND_MIME = {
  stl: 'model/stl',
  '3mf': 'model/3mf',
  obj: 'model/obj',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const PREVIEWABLE = new Set(['png', 'jpeg', 'webp']);

function isPreviewable(kind) {
  return PREVIEWABLE.has(kind);
}

function mimeFor(kind, fallback) {
  return KIND_MIME[kind] || fallback || 'application/octet-stream';
}

function extFor(kind) {
  return KIND_EXT[kind] || '.bin';
}

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/**
 * 按文件内容判断真实类型，而不是看扩展名。
 * 这是"把 .exe 改名成 .stl"这类绕过的唯一有效防线。
 * @returns {Promise<string|null>} 类型标识，null 表示不认识
 */
async function detectKind(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size === 0) return null;

    const head = Buffer.alloc(Math.min(512, size));
    await fh.read(head, 0, head.length, 0);

    if (startsWith(head, PNG_MAGIC)) return 'png';
    if (startsWith(head, JPEG_MAGIC)) return 'jpeg';
    if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
      return 'webp';
    }

    // 3MF 本质是 ZIP，光看 PK\x03\x04 不够 —— 任何 zip 都符合。
    // 必须确认包内确实有 3MF 规范的 [Content_Types].xml。
    if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
      const body = await readWhole(fh, size);
      if (body.includes(Buffer.from('[Content_Types].xml'))) return '3mf';
      return null;
    }

    // 二进制 STL：80 字节头 + 4 字节小端三角形数量，
    // 且文件总长必须恰好等于 84 + 50 * 三角形数。
    // 这个等式对任何非 STL 文件几乎不可能成立，是很强的判据。
    if (size >= 84) {
      const header = Buffer.alloc(84);
      await fh.read(header, 0, 84, 0);
      const triangles = header.readUInt32LE(80);
      if (84 + triangles * 50 === size) return 'stl';
    }

    // ASCII STL：以 solid 开头且含 facet normal。
    // 注意有些二进制 STL 的文件头恰好以 "solid" 开头，所以两个判据都要查。
    const text = head.toString('latin1');
    if (/^\s*solid/i.test(text)) {
      const body = await readWhole(fh, size);
      if (body.includes(Buffer.from('facet'))) return 'stl';
    }

    const objText = head.toString('latin1');
    if (/^\s*(#|mtllib|o |v |vn |vt |f )/m.test(objText)) {
      const body = await readWhole(fh, size);
      if (/^v\s+[-0-9.]+\s+[-0-9.]+\s+[-0-9.]+/m.test(body.toString('latin1')) &&
          /^f\s+/m.test(body.toString('latin1'))) {
        return 'obj';
      }
    }

    return null;
  } finally {
    await fh.close();
  }
}

// 只对文本类/需全量扫描的格式读整个文件，且设上限防止大文件把内存吃掉。
// multer 已经用 diskStorage 落盘，这里读的只是再做一次内容确认。
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

async function readWhole(fh, size) {
  if (size > MAX_SCAN_BYTES) return Buffer.alloc(0);
  const buf = Buffer.alloc(size);
  await fh.read(buf, 0, size, 0);
  return buf;
}

/**
 * 确保 target 落在 baseDir 内。原文件名一律不参与路径拼接，
 * 这层检查是为了防止以后有人改动代码时引入目录穿越。
 */
function resolveWithin(baseDir, ...parts) {
  const target = path.resolve(baseDir, ...parts);
  const base = path.resolve(baseDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('路径越界');
  }
  return target;
}

// 固定用正斜杠拼相对路径。数据库里存的路径必须与平台无关 ——
// 开发在 Windows、部署在 Linux，若存了 path.join 的结果就会带上反斜杠，
// 到了 Linux 上 \ 是普通文件名字符，附件会全部找不到。
function datedSubdir(now = new Date()) {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}/${mm}`;
}

function splitRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    throw new Error('路径无效');
  }
  const parts = relPath.split('/');
  // 任何形式的上级引用、空段、当前目录段都拒绝
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error('路径越界');
  return parts;
}

/**
 * 把校验通过的临时文件搬到最终位置。
 * 落盘名是 UUID + 服务端判定的扩展名，磁盘上不留任何用户提供的字符串。
 */
async function commitFile(tmpPath, kind) {
  const sub = datedSubdir();
  const dir = resolveWithin(UPLOAD_DIR, ...sub.split('/'));
  await fsp.mkdir(dir, { recursive: true });

  const fileName = `${crypto.randomUUID()}${extFor(kind)}`;
  const dest = resolveWithin(dir, fileName);

  // 同分区内 rename 是原子的，不会出现半截文件
  await fsp.rename(tmpPath, dest);

  return { storedName: `${sub}/${fileName}`, absPath: dest };
}

function absolutePathOf(storedName) {
  return resolveWithin(UPLOAD_DIR, ...splitRelPath(storedName));
}

async function removeStored(storedName) {
  if (!storedName) return;
  try {
    await fsp.unlink(absolutePathOf(storedName));
  } catch (err) {
    // 文件可能已经被清理过，不算错误；但要留痕以便排查磁盘异常
    if (err.code !== 'ENOENT') {
      logger.warn('删除附件文件失败', { storedName, err: err.message });
    }
  }
}

async function discardTmp(tmpPath) {
  if (!tmpPath) return;
  try {
    await fsp.unlink(tmpPath);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('清理临时文件失败', { err: err.message });
  }
}

/**
 * 磁盘水位检查。写满磁盘会让整个服务（包括数据库写入）一起挂掉，
 * 所以在还有余量时就拒绝上传，而不是等到 ENOSPC。
 */
function diskUsagePercent() {
  try {
    const st = fs.statfsSync(config.storageDir);
    const total = st.blocks;
    const free = st.bavail;
    if (!total) return 0;
    return ((total - free) / total) * 100;
  } catch {
    return 0; // 拿不到就不拦，避免因平台差异误伤正常上传
  }
}

function isDiskFull() {
  return diskUsagePercent() >= config.storageWatermarkPercent;
}

module.exports = {
  UPLOAD_DIR,
  detectKind,
  resolveWithin,
  splitRelPath,
  commitFile,
  absolutePathOf,
  removeStored,
  discardTmp,
  diskUsagePercent,
  isDiskFull,
  isPreviewable,
  mimeFor,
  extFor,
};
