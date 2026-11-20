// 最小 PNG 解码器（只认 8 位、非隔行的 RGB / RGBA，Chrome 截图就是这两种），用来查 alpha 和描边有没有被画面边缘切掉。
import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let width; let height; let depth; let ctype; let interlace;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) {
    throw new Error(`不支持的 PNG：位深 ${depth}，颜色类型 ${ctype}，隔行 ${interlace}`);
  }
  const ch = ctype === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { width, height, channels: ch, data: out };
}

/** alpha 统计：最小、最大、中间值像素数、不透明区域外框、贴边像素数 */
export function alphaStats(img, { edge = 2, threshold = 8 } = {}) {
  const { width: w, height: h, channels, data } = img;
  if (channels !== 4) return { hasAlpha: false };
  let min = 255; let max = 0; let partial = 0; let edgeHits = 0;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a < min) min = a;
      if (a > max) max = a;
      if (a > 0 && a < 255) partial++;
      if (a > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x < edge || y < edge || x >= w - edge || y >= h - edge) edgeHits++;
      }
    }
  }
  return { hasAlpha: true, min, max, partial, edgeHits, bbox: x1 >= 0 ? [x0, y0, x1, y1] : null };
}

export function pixel(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  return Array.from(img.data.subarray(i, i + img.channels));
}
