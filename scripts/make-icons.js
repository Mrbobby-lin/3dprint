'use strict';

/**
 * 生成 PWA 用的 PNG 图标。
 *
 * 为什么要手写 PNG 编码器：项目没有任何图形依赖，而
 *   - iOS 的 apple-touch-icon 不认 SVG，必须给 PNG；
 *   - manifest 的图标虽然允许 SVG，但各平台支持参差，PNG 最稳。
 * 引入 sharp/canvas 这类原生依赖只为几个静态图标不划算，所以这里用
 * Node 内置的 zlib 拼一个最小 PNG 编码器，把 favicon.svg 里的图形
 * （圆角方块 + 立方体线框）按 4 倍超采样画出来再降采样，充当抗锯齿。
 *
 * 图形改了要同步改 favicon.svg —— 两边的几何常量是手工对齐的。
 *
 * 用法： node scripts/make-icons.js
 * 产物： public/icons/*.png
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

/* ---------------------------------------------------------------------------
   图形常量（设计坐标系 32×32，与 favicon.svg 的 viewBox 一致）
   --------------------------------------------------------------------------- */

const DESIGN = 32;
const BRAND = [0x25, 0x63, 0xeb]; // = --primary
const WHITE = [0xff, 0xff, 0xff];
const CORNER_RADIUS = 7;
const STROKE = 1.8;

// 立方体轮廓，闭合六边形
const SILHOUETTE = [
  [16, 6.5], [25, 11.75], [25, 22.25], [16, 27.5], [7, 22.25], [7, 11.75],
];

// 内部棱：顶部两条 + 中间竖线
const EDGES = [
  [[7, 11.75], [16, 17], [25, 11.75]],
  [[16, 17], [16, 27.5]],
];
const EDGE_ALPHA = 0.75; // 与 favicon.svg 的 opacity=".75" 对齐

const SUPERSAMPLE = 4; // 每个目标像素取 4×4 个样本再平均

/* ---------------------------------------------------------------------------
   PNG 编码：签名 + IHDR + IDAT + IEND，每个块带 CRC32
   --------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);

  return Buffer.concat([length, typeBuf, data, crc]);
}

// pixels 为 RGBA 直通字节，长度 size*size*4
function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深 8
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  // 后面三字节（压缩/滤波/隔行）全 0：deflate、自适应滤波、非隔行

  // PNG 要求每行前面加一个滤波类型字节。这里统一用 0（None）——
  // 图标是大色块，deflate 本身就能压得很小，不值得为滤波再引入复杂度。
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y += 1) {
    const at = y * (1 + stride);
    raw[at] = 0;
    pixels.copy(raw, at + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------------------
   光栅化：先在高分辨率下做"在不在图形内"的二值判断，再降采样平均
   --------------------------------------------------------------------------- */

function insideRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  if (radius <= 0) return true;

  // 只有落进四个角的方块里才需要按圆判定
  const cx = x < radius ? radius : x > size - radius ? size - radius : x;
  const cy = y < radius ? radius : y > size - radius ? size - radius : y;
  if (cx === x && cy === y) return true;

  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  // 退化成点时要防止除零
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function insidePolyline(px, py, lines, closed, halfWidth) {
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const d = distanceToSegment(px, py, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
      if (d <= halfWidth) return true;
    }
  }
  if (closed) {
    const first = lines[0][0];
    const last = lines[lines.length - 1][lines[lines.length - 1].length - 1];
    if (distanceToSegment(px, py, last[0], last[1], first[0], first[1]) <= halfWidth) return true;
  }
  return false;
}

/**
 * @param size    输出边长（像素）
 * @param opts.bleed    true = 背景铺满整个画布（给会被系统裁形的场景用）
 * @param opts.cubeScale 立方体的缩放比例，1 = 与 favicon 一致
 */
function render(size, opts = {}) {
  const { bleed = false, cubeScale = 1 } = opts;
  const k = size / DESIGN;
  const radius = bleed ? 0 : CORNER_RADIUS * k;
  const half = (STROKE * k) / 2;
  // 立方体缩放在设计坐标系里做，再统一乘 k
  const center = DESIGN / 2;
  const fit = ([x, y]) => [(center + (x - center) * cubeScale) * k, (center + (y - center) * cubeScale) * k];

  const silhouette = [SILHOUETTE.map(fit)];
  const edges = EDGES.map((line) => line.map(fit));

  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      // 预乘 alpha 累加：直接平均直通 RGBA 会把透明像素的黑色
      // 混进边缘，形成一圈暗边。
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;

          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;

          if (bleed ? x >= 0 && y >= 0 && x <= size && y <= size
            : insideRoundedRect(x, y, size, radius)) {
            [r, g, b] = BRAND;
            a = 1;
          }

          // 轮廓（不透明白）→ 内部棱（75% 白）。重叠处白压白，仍是白。
          for (const [lines, alpha] of [
            [silhouette, 1],
            [edges, EDGE_ALPHA],
          ]) {
            if (!insidePolyline(x, y, lines, lines === silhouette, half)) continue;
            const keep = a * (1 - alpha);
            r = WHITE[0] * alpha + r * keep;
            g = WHITE[1] * alpha + g * keep;
            b = WHITE[2] * alpha + b * keep;
            a = alpha + keep;
          }

          sr += r * a;
          sg += g * a;
          sb += b * a;
          sa += a;
        }
      }

      const at = (py * size + px) * 4;
      const avgA = sa / samples;
      if (avgA > 0) {
        // 反预乘回直通 alpha，PNG 要的是直通值
        const un = 1 / sa;
        pixels[at] = Math.round(Math.min(255, sr * un * 255));
        pixels[at + 1] = Math.round(Math.min(255, sg * un * 255));
        pixels[at + 2] = Math.round(Math.min(255, sb * un * 255));
      }
      pixels[at + 3] = Math.round(Math.min(1, avgA) * 255);
    }
  }

  return encodePng(size, pixels);
}

/* ---------------------------------------------------------------------------
   产出
   --------------------------------------------------------------------------- */

const TARGETS = [
  // 普通图标：圆角方块 + 正常大小的立方体，和浏览器标签页里的样子一致
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  // maskable：Android 会把图标裁成圆形/圆角方形，背景必须铺满，
  // 立方体缩到 62% 保证落在安全区（直径 80% 的圆）以内
  { file: 'maskable-512.png', size: 512, opts: { bleed: true, cubeScale: 0.62 } },
  // iOS 自己会加圆角遮罩，所以给满幅方形 —— 留透明角会被 iOS 填成黑角
  { file: 'apple-touch-icon.png', size: 180, opts: { bleed: true } },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const target of TARGETS) {
  const png = render(target.size, target.opts);
  const file = path.join(OUT_DIR, target.file);
  fs.writeFileSync(file, png);
  const kb = (png.length / 1024).toFixed(1);
  console.log(`生成 icons/${target.file}  ${target.size}×${target.size}  ${kb} KB`);
}
