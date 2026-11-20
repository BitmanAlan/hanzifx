// 003 书法标题（styles/003-brush-title）
//
// 风格契约：create(root, ctx) → { timeline, layout, seek(t), destroy() }；seek 只看 t，所有动画都从头算。
// 画面：一两个大字撑起画面，毛笔字形本身的力量感，大块留白，最后一方小小的朱红印章。动效要慢，像墨在纸上化开。
//   入场两种：墨迹晕开（几团边缘不规则的墨从字里长出来，字从墨到的地方露出来，外圈一道墨晕先胖后收）、
//            笔刷扫出（一道带毛边和飞白的笔刷遮罩沿书写方向扫过）；R3 整行一道扫过。
//   印章：最后一个字写完 0.2 秒后从 130% 盖到 100%，落下那一刻画面轻轻一震（2 帧）。
//   V3 招牌：背后一道大笔刷（飞白），墨点飞溅，印章盖得更重，停留时慢慢推近。
// 排版按每个字墨迹的实际包围盒（canvas measureText 的 actualBoundingBox），不按字框：
//   字与字之间的空隙统一成 tracking × 字号；字号按墨迹面积上下微调（「一」很扁会显小）；印章按墨迹放，不许压字。
// 不用模糊滤镜做晕开（只有 C5 透明白墨的柔和投影用了一个，且不旋转），遮罩全是带种子的路径。

import { hash01, rng, noise1 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, easeOutCubic, easeInCubic, easeInOutCubic } from '../../engine/src/lib/ease.js';
import { graphemes, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { inkSpread, shake, f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent = null) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
};
const isPunct = (ch) => FULLWIDTH_PUNCT.has(ch) || /^[\p{P}\p{S}]$/u.test(ch);
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

/** 量墨迹：返回字在原点 (0, 基线) 时墨迹的包围盒 { l, r, t, b }（相对原点，像素）。family 是整条字体链 */
function makeInkMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return function ink(ch, px) {
    const key = ch + '|' + px;
    if (cache.has(key)) return cache.get(key);
    g.font = `${px}px ${family}`;
    const m = g.measureText(ch);
    const box = { l: -m.actualBoundingBoxLeft, r: m.actualBoundingBoxRight, t: -m.actualBoundingBoxAscent, b: m.actualBoundingBoxDescent, adv: m.width };
    if (!(box.r > box.l)) { box.l = 0; box.r = m.width || px * 0.5; }
    if (!(box.b > box.t)) { box.t = -px * 0.5; box.b = 0; }
    cache.set(key, box);
    return box;
  };
}

/**
 * 宣纸纹理：一块能无缝平铺的方图（逐像素算，不靠画布抗锯齿，所以每次一样）。
 * 低频云絮 + 中频斑驳 + 细颗粒 + 若干纤维。rgb 是纹理颜色（浅纸用深色，深底用浅色），透明度里装纹理。
 */
function paperTile(seed, size, rgb) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const A = new Float32Array(size * size);
  const lattice = (cells, key) => {
    const r = rng(seed, 'paper', key);
    const v = new Float32Array(cells * cells);
    for (let i = 0; i < v.length; i++) v[i] = r();
    return (x, y) => { // x, y 以格为单位，按 cells 取模，保证平铺无缝
      const xi = Math.floor(x); const yi = Math.floor(y);
      const fx = x - xi; const fy = y - yi;
      const ux = fx * fx * (3 - 2 * fx); const uy = fy * fy * (3 - 2 * fy);
      const at = (i, j) => v[((j % cells) + cells) % cells * cells + (((i % cells) + cells) % cells)];
      const a = at(xi, yi); const b = at(xi + 1, yi); const cc = at(xi, yi + 1); const d = at(xi + 1, yi + 1);
      return a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy;
    };
  };
  const cloud = lattice(5, 'cloud'); const mottle = lattice(24, 'mottle');
  const grain = rng(seed, 'paper', 'grain');
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size; const v = y / size;
      const cl = cloud(u * 5, v * 5); const mo = mottle(u * 24, v * 24);
      A[y * size + x] = 0.28 * Math.max(0, cl - 0.35) + 0.22 * Math.max(0, mo - 0.45) + 0.22 * grain();
    }
  }
  // 纤维：短而弯的细线，坐标取模，跨边也无缝
  const fr = rng(seed, 'paper', 'fiber');
  const nFiber = Math.round(size * size / 2600);
  for (let k = 0; k < nFiber; k++) {
    let x = fr() * size; let y = fr() * size;
    let ang = fr() * Math.PI * 2; const len = 18 + fr() * 70; const bend = (fr() - 0.5) * 0.06;
    const strength = 0.25 + fr() * 0.45;
    for (let s = 0; s < len; s += 0.6) {
      ang += bend;
      x += Math.cos(ang) * 0.6; y += Math.sin(ang) * 0.6;
      const xi = ((Math.round(x) % size) + size) % size; const yi = ((Math.round(y) % size) + size) % size;
      const fade = Math.sin(Math.PI * (s / len));
      const i = yi * size + xi;
      A[i] = Math.max(A[i], strength * fade);
    }
  }
  for (let i = 0; i < A.length; i++) {
    img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = Math.round(255 * clamp(A[i]));
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** 笔刷扫出的遮罩形状：沿 axis（'x' 横排 / 'y' 竖排）从 box 起点扫到 edge，前沿带毛边；返回 [主体路径, 飞白带路径] */
function sweepPaths(box, edge, axis, fs, seed, key) {
  const K = 14;
  const jag = 0.06 * fs; const dryW = 0.1 * fs;
  const pts = (offset, amp, k2) => {
    const out = [];
    for (let k = 0; k <= K; k++) {
      const s = k / K;
      const n = noise1(seed, k * 0.9 + 3.1, `${key}${k2}`) - 0.5;
      out.push([edge + offset + n * 2 * amp, s]);
    }
    return out;
  };
  const toXY = (along, s) => (axis === 'x' ? [along, lerp(box.y0, box.y1, s)] : [lerp(box.x0, box.x1, s), along]);
  const start = axis === 'x' ? box.x0 : box.y0;
  const poly = (front, back) => {
    let d = '';
    front.forEach(([a, s], k) => { const [x, y] = toXY(a, s); d += `${k ? 'L' : 'M'}${f3(x)},${f3(y)}`; });
    for (let k = back.length - 1; k >= 0; k--) { const [x, y] = toXY(back[k][0], back[k][1]); d += `L${f3(x)},${f3(y)}`; }
    return d + 'Z';
  };
  const main = pts(0, jag, 'm');
  const dry = pts(dryW, jag * 1.6, 'd');
  const base = main.map(([, s]) => [start, s]);
  return [poly(main, base), poly(dry, main)];
}

/**
 * 背后大笔刷（V3）：一笔干刷的轮廓——起笔圆头、中段实、越往后越干（飞白）、收笔散成一根根笔毛，整体往右上斜一点。
 * 由 n 根互相重叠的「笔毛」细条拼成，每根的起止和断开处带种子随机。axis='x' 横刷，'y' 竖刷。
 */
function swashStrips(box, axis, fs, seed) {
  const r = rng(seed, 'swash');
  const n = 26;
  const strips = [];
  const along0 = axis === 'x' ? box.x0 : box.y0; const along1 = axis === 'x' ? box.x1 : box.y1;
  const across0 = axis === 'x' ? box.y0 : box.x0; const across1 = axis === 'x' ? box.y1 : box.x1;
  const span = along1 - along0; const thick = across1 - across0; const mid = (across0 + across1) / 2;
  const tilt = axis === 'x' ? -0.07 : 0.05; // 横刷往右上走，竖刷往左下偏一点
  const P = (a, c) => { const cc = c + (a - along0) * tilt; return axis === 'x' ? `${f3(a)},${f3(cc)}` : `${f3(cc)},${f3(a)}`; };
  for (let j = 0; j < n; j++) {
    const u = ((j + 0.5) / n) * 2 - 1; // -1（上沿）到 1（下沿）
    const au = Math.abs(u);
    const c = mid + (u * thick) / 2;
    const w = (thick / n) * (1.7 + r() * 0.5);
    // 起笔圆头：越靠边起得越晚；收笔：中间的笔毛走得远，边上的先断
    const head = span * (0.05 * (1 - Math.sqrt(Math.max(0, 1 - au * au))) + r() * 0.015);
    const tail = span * (0.7 + 0.3 * (1 - au) * (0.55 + r() * 0.45));
    const a0 = along0 + head; const a1 = along0 + tail;
    // 飞白：后半段墨不够，有的笔毛断开一两截
    const segs = [[a0, a1]];
    const dryN = r() < 0.55 ? (r() < 0.35 ? 2 : 1) : 0;
    for (let k = 0; k < dryN; k++) {
      const last = segs.pop();
      const cut = lerp(last[0], last[1], 0.45 + r() * 0.45);
      const gap = span * (0.015 + r() * 0.07);
      segs.push([last[0], cut]);
      if (cut + gap < last[1]) segs.push([cut + gap, last[1]]);
    }
    for (const [s0, s1] of segs) {
      if (s1 - s0 < span * 0.025) continue;
      const K = 14;
      const wob = (k, key) => (noise1(seed, j * 2.3 + k * 0.7, key) - 0.5) * w * 0.5;
      let d = '';
      // 每一段两头收尖：起笔那段头上圆一点，断开处和收笔那段尾巴尖一点（不然一根根平头叠起来像台阶）
      const isTail = s1 >= a1 - 1;
      const taper = (q) => {
        const inQ = Math.min(1, q / 0.12); const outQ = Math.min(1, (1 - q) / (isTail ? 0.45 : 0.15));
        return Math.sqrt(Math.max(0, inQ * (2 - inQ))) * (isTail ? 0.25 + 0.75 * outQ : Math.sqrt(Math.max(0, outQ * (2 - outQ))));
      };
      for (let k = 0; k <= K; k++) {
        const q = k / K; const a = lerp(s0, s1, q);
        d += `${k ? 'L' : 'M'}${P(a, c - (w / 2) * taper(q) + wob(k, 'sa'))}`;
      }
      for (let k = K; k >= 0; k--) {
        const q = k / K; const a = lerp(s0, s1, q);
        d += `L${P(a, c + (w / 2) * taper(q) + wob(k, 'sb'))}`;
      }
      strips.push({ d: d + 'Z', opacity: 0.82 + r() * 0.18 });
    }
  }
  return strips;
}

/** 按词边界把一段字切成几行（尽量平均、前一行不短于后一行） */
function splitLines(chars, nLines, segment, paragraph) {
  if (nLines <= 1) return [chars];
  const bounds = new Set([0, chars.length]);
  let acc = 0;
  for (const w of segment(paragraph)) { acc += graphemes(w.text).filter((c) => !/\s/.test(c)).length; bounds.add(acc); }
  const out = []; let start = 0;
  for (let k = 1; k < nLines; k++) {
    const ideal = start + Math.ceil((chars.length - start) / (nLines - k + 1));
    let best = ideal; let bestCost = Infinity;
    for (const b of bounds) {
      if (b <= start || b >= chars.length) continue;
      const cost = Math.abs(b - ideal) + (b < ideal ? 0.3 : 0); // 宁可前一行长一点
      if (cost < bestCost) { bestCost = cost; best = b; }
    }
    if (bestCost > 1.5) best = ideal; // 词边界离中间太远，就按字数切（会记进 forced）
    out.push(chars.slice(start, best)); start = best;
  }
  out.push(chars.slice(start));
  return out;
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const C = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const portrait = H > W * 1.05;
  const ground = P._palette.ground === 'none' || ctx.transparent ? 'none' : 'paper';
  const softShadow = !!P._palette.softShadow;
  const uid = ctx.uid;
  const vertical = !!P.vertical;
  const axis = vertical ? 'y' : 'x';
  const family = ctx.fontFamily(P.font);
  const sealFamily = ctx.fontFamily('notoserif-black');
  const ink = makeInkMeasurer(family);
  const sealInk = makeInkMeasurer(sealFamily);
  const forced = [];

  // ---------- 1) 拆字、分行 ----------
  const paragraphs = ctx.text.split('\n').map((s) => s.trim()).filter(Boolean);
  const dropped = [];
  let lines = [];
  const auto = paragraphs.length === 1;
  for (const para of paragraphs) {
    let chars = graphemes(para).filter((c) => !/\s/.test(c));
    if (vertical) { const keep = chars.filter((c) => !isPunct(c)); dropped.push(...chars.filter((c) => isPunct(c))); chars = keep; }
    if (!chars.length) continue;
    const perLine = vertical ? 6 : 4;
    const n = auto ? Math.ceil(chars.length / perLine) : 1;
    const parts = splitLines(chars, Math.min(n, 3), ctx.segment, para);
    if (parts.length > 1) {
      // 记下按字数硬切、没落在词边界上的地方
      let acc = 0; const bset = new Set([0]);
      for (const w of ctx.segment(para)) { acc += graphemes(w.text).filter((c) => !/\s/.test(c)).length; bset.add(acc); }
      let pos = 0;
      for (const part of parts.slice(0, -1)) { pos += part.length; if (!bset.has(pos)) forced.push(chars.slice(Math.max(0, pos - 2), pos + 2).join('')); }
    }
    lines.push(...parts);
  }
  // 分隔符（「·」、顿号、空格这类）落在行首行尾时已经多余：换行本身就分开了，去掉
  const SEP = /^[·・•、，,\/｜|—-]$/u;
  const trimmed = [];
  lines = lines.map((l) => { const out = [...l]; while (out.length > 1 && SEP.test(out[out.length - 1])) trimmed.push(out.pop()); while (out.length > 1 && SEP.test(out[0])) trimmed.push(out.shift()); return out; });
  if (!lines.length) lines = [['　']];
  const nChars = lines.reduce((s, l) => s + l.length, 0);


  // ---------- 2) 字号：先按上限排一遍，再按量出来的墨迹外框缩到「一行最多占画面宽 80%」（竖排：一列最多占画面高 62%/74%） ----------
  const maxLen = Math.max(...lines.map((l) => l.length));
  // 字号上限：没填就自动——竖屏和方形 0.26（4 个字正好约占宽 80%），横屏 0.34（实测国庆片头：4 个字占宽 79%–80%、字高约占短边 30%）
  const sizeCap = P.size ?? (W > H * 1.2 ? 0.34 : 0.26);
  let fs = sizeCap * short;

  // ---------- 3) 按墨迹排：每个字的墨迹包围盒、字号微调、字距 ----------
  const BASE = 200;
  const allChars = lines.flat();
  const visual = allChars.map((ch) => { const b = ink(ch, BASE); return Math.sqrt(Math.max(1, (b.r - b.l) * (b.b - b.t))); });
  const sorted = [...visual].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || BASE;
  function layoutAt(fsz) {
    const glyphs = []; let gi = 0;
    const lineBoxes = [];
    const lineStep = fsz * (vertical ? 1.12 : 1.18);
    lines.forEach((line, li) => {
      let cursor = 0;
      const row = [];
      line.forEach((ch, ci) => {
        const k = clamp(Math.sqrt(median / visual[gi]), 1 - P.even, 1 + P.even);
        const px = fsz * k;
        const b = ink(ch, px);
        const jitter = (hash01(seed, 'wob', gi) - 0.5) * 2 * 0.02 * fsz * P.wobble;
        const g = { ch, i: gi, li, ci, px, box: b };
        if (vertical) {
          // 竖排：墨迹顶接着上一个字的墨迹底，水平方向墨迹居中，左右错落
          g.oy = cursor - b.t; g.ox = -(b.l + b.r) / 2 + jitter;
          cursor = g.oy + b.b + P.tracking * fsz;
        } else {
          g.ox = cursor - b.l; g.oy = -(b.t + b.b) / 2 + jitter;
          cursor = g.ox + b.r + P.tracking * fsz;
        }
        row.push(g); glyphs.push(g); gi++;
      });
      // 这一行（列）的墨迹外框（相对行原点）
      const ext = row.reduce((e, g) => ({ x0: Math.min(e.x0, g.ox + g.box.l), x1: Math.max(e.x1, g.ox + g.box.r), y0: Math.min(e.y0, g.oy + g.box.t), y1: Math.max(e.y1, g.oy + g.box.b) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
      // 行原点：横排第 li 行往下 lineStep、往右错开半个字；竖排第 li 列往左（从右往左读）、往下错开半个字
      const shift = li > 0 && lines.length > 1 ? 0.5 * fsz : 0;
      const org = vertical ? { x: -li * lineStep, y: shift } : { x: shift - ext.x0, y: li * lineStep };
      lineBoxes.push({ org, ext });
      for (const g of row) { g.ox += org.x; g.oy += org.y; }
    });
    for (const g of glyphs) g.ink = { x0: g.ox + g.box.l, x1: g.ox + g.box.r, y0: g.oy + g.box.t, y1: g.oy + g.box.b };
    const block = glyphs.reduce((e, g) => ({ x0: Math.min(e.x0, g.ink.x0), x1: Math.max(e.x1, g.ink.x1), y0: Math.min(e.y0, g.ink.y0), y1: Math.max(e.y1, g.ink.y1) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
    return { glyphs, block, lineStep };
  }
  let lay = layoutAt(fs);
  const limitW = W * 0.8; const limitH = H * (vertical ? (portrait ? 0.62 : 0.74) : 0.62);
  const over = Math.max((lay.block.x1 - lay.block.x0) / limitW, (lay.block.y1 - lay.block.y0) / limitH);
  if (over > 1) { fs /= over; lay = layoutAt(fs); }
  const { glyphs } = lay;

  // ---------- 4) 摆到画面上：横排居中、偏上；竖排横屏放右侧三分之一，竖屏居中 ----------
  const bw = lay.block.x1 - lay.block.x0; const bh = lay.block.y1 - lay.block.y0;
  const yC = (P.y ?? (portrait ? 0.4 : 0.45)) * H;
  const xC = vertical && !portrait ? W * 0.7 : W * 0.5;
  let dx = xC - (lay.block.x0 + bw / 2); let dy = yC - (lay.block.y0 + bh / 2);

  // 印章：方形，边长 sealSize × 字号；横排放最后一个字右下（右边留 6% 字号，底边跟墨迹底对齐），竖排放最后一个字下面偏左
  const sealChars = graphemes(String(P.seal || '')).filter((c) => !/\s/.test(c)).slice(0, 4);
  const side = sealChars.length ? P.sealSize * fs : 0;
  const gap = 0.06 * fs;
  let seal = null;
  if (side) {
    const last = glyphs[glyphs.length - 1].ink;
    seal = vertical
      ? { x: (last.x0 + last.x1) / 2 - side * 0.75, y: last.y1 + gap * 1.4 }
      : { x: last.x1 + gap, y: last.y1 - side };
    // 跟所有字的墨迹比，压到了就往外挪（横排往右、竖排往下），挪 20 次还压着就记成问题
    const pad = 0.02 * fs;
    const hit = () => glyphs.some((g) => seal.x < g.ink.x1 + pad && seal.x + side > g.ink.x0 - pad && seal.y < g.ink.y1 + pad && seal.y + side > g.ink.y0 - pad);
    for (let k = 0; k < 20 && hit(); k++) { if (vertical) seal.y += 0.03 * fs; else seal.x += 0.03 * fs; }
    seal.overlap = hit();
    // 整体（字＋印章）别出画面：往回推
    const x1 = Math.max(lay.block.x1, seal.x + side) + dx; const y1 = Math.max(lay.block.y1, seal.y + side) + dy;
    const m = 0.04 * short;
    if (x1 > W - m) dx -= x1 - (W - m);
    if (y1 > H - m) dy -= y1 - (H - m);
  }
  for (const g of glyphs) {
    g.ox += dx; g.oy += dy;
    g.ink = { x0: g.ink.x0 + dx, x1: g.ink.x1 + dx, y0: g.ink.y0 + dy, y1: g.ink.y1 + dy };
  }
  const block = { x0: lay.block.x0 + dx, x1: lay.block.x1 + dx, y0: lay.block.y0 + dy, y1: lay.block.y1 + dy };
  if (seal) { seal.x += dx; seal.y += dy; }

  // ---------- 5) 时间 ----------
  const sweepLine = R.sweepLine; // R3：整行一道扫过
  const entrance = sweepLine ? 'sweep' : P.entrance;
  const lineCount = lines.length;
  for (const g of glyphs) {
    if (sweepLine) { g.t0 = g.li * sweepLine * 0.8; g.t1 = g.t0 + sweepLine; } else { g.t0 = g.i * R.stagger; g.t1 = g.t0 + R.charDur; }
  }
  const swashOn = P.swash === 'on';
  const swashLead = swashOn ? 0.35 : 0; // 大笔刷先刷 0.4 秒，字跟着出
  for (const g of glyphs) { g.t0 += swashLead; g.t1 += swashLead; }
  const writeEnd = Math.max(...glyphs.map((g) => g.t1));
  const sealT0 = writeEnd + R.sealDelay; const sealT1 = sealT0 + R.sealDur;
  const fps = 30;
  const introEnd = seal ? sealT1 + 2 / fps : writeEnd;
  const hold = P.hold ?? R.hold;
  const outroStart = introEnd + hold; const outDur = R.outDur;
  const duration = outroStart + outDur;

  // ---------- 6) 搭 SVG ----------
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: 'position:absolute;left:0;top:0;overflow:hidden' });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  if (ground === 'paper') {
    el('rect', { x: 0, y: 0, width: W, height: H, fill: C.bg }, svg);
    if (P.paper > 0) {
      const dark = lum(C.bg) < 0.45;
      const tile = 640;
      const pat = el('pattern', { id: `${uid}-paper`, width: tile, height: tile, patternUnits: 'userSpaceOnUse' }, defs);
      el('image', { href: paperTile(seed, tile, dark ? [255, 244, 222] : [92, 70, 44]), x: 0, y: 0, width: tile, height: tile }, pat);
      el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${uid}-paper)`, opacity: f3(clamp(P.paper * (dark ? 0.6 : 1.4))) }, svg);
    }
    const vg = el('radialGradient', { id: `${uid}-vig`, cx: '50%', cy: '46%', r: '75%' }, defs);
    el('stop', { offset: '55%', 'stop-color': '#000', 'stop-opacity': 0 }, vg);
    el('stop', { offset: '100%', 'stop-color': '#000', 'stop-opacity': lum(C.bg) < 0.45 ? 0.45 : 0.16 }, vg);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${uid}-vig)` }, svg);
  }
  const scene = el('g', {}, svg);

  // 墨色：配色给了两种颜色就用上下渐变（鎏金、红金），没给或用户改过墨色就用纯色
  const flat = !!P.fill || C.fill.toLowerCase() === C.fill2.toLowerCase();
  let inkPaint = C.fill;
  if (!flat) {
    const lg = el('linearGradient', { id: `${uid}-gold`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0%', 'stop-color': C.fill }, lg);
    el('stop', { offset: '55%', 'stop-color': mixHex(C.fill, C.fill2, 0.55) }, lg);
    el('stop', { offset: '100%', 'stop-color': C.fill2 }, lg);
    inkPaint = `url(#${uid}-gold)`;
  }
  if (softShadow) {
    const ft = el('filter', { id: `${uid}-soft`, x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs);
    el('feGaussianBlur', { stdDeviation: f3(fs * 0.035) }, ft);
  }

  // V3：背后大笔刷
  let swash = null;
  if (swashOn) {
    const padA = 0.3 * fs; const thick = 0.78 * fs;
    const c = vertical ? (block.x0 + block.x1) / 2 : (block.y0 + block.y1) / 2;
    const box = vertical
      ? { x0: c - thick / 2, x1: c + thick / 2, y0: block.y0 - padA, y1: block.y1 + padA * 0.6 }
      : { x0: block.x0 - padA, x1: block.x1 + padA * 0.6, y0: c - thick / 2 + 0.06 * fs, y1: c + thick / 2 + 0.06 * fs };
    const m = el('mask', { id: `${uid}-swm`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
    const mMain = el('path', { fill: '#fff' }, m); const mDry = el('path', { fill: '#7a7a7a' }, m);
    const g = el('g', { mask: `url(#${uid}-swm)` }, scene);
    const color = swashColor(C);
    const strips = swashStrips(box, axis, fs, seed).map((s) => el('path', { d: s.d, fill: color, 'fill-opacity': f3(s.opacity) }, g));
    swash = { box, mMain, mDry, g, strips, t0: 0, t1: 0.42 };
  }

  // 墨点飞溅（V3）：一圈小墨点，跟着字晕开
  const splashes = [];
  if (P.splash > 0) {
    const r = rng(seed, 'splash');
    const n = Math.round(4 + 10 * P.splash);
    for (let k = 0; k < n; k++) {
      const g = glyphs[Math.floor(r() * glyphs.length)];
      const cx0 = (g.ink.x0 + g.ink.x1) / 2; const cy0 = (g.ink.y0 + g.ink.y1) / 2;
      const ang = r() * Math.PI * 2; const dist = (0.55 + r() * 0.45) * fs;
      const x = cx0 + Math.cos(ang) * dist; const y = cy0 + Math.sin(ang) * dist * 0.8;
      if (x < 0.03 * W || x > 0.97 * W || y < 0.03 * H || y > 0.97 * H) continue;
      if (seal && x > seal.x - 0.05 * fs && x < seal.x + side + 0.05 * fs && y > seal.y - 0.05 * fs && y < seal.y + side + 0.05 * fs) continue;
      const rad = (0.01 + r() * r() * 0.045) * fs * (0.6 + P.splash * 0.6);
      splashes.push({ x, y, rad, t0: g.t0 + 0.05 + r() * 0.12, path: el('path', { fill: inkPaint === C.fill ? C.fill : C.fill2, 'fill-opacity': f3(P.ink) }, scene) });
    }
  }

  // 每个字：一个遮罩（墨团或笔刷）＋ 墨池（晕开时一团淡墨）＋ 墨晕（描边先胖后收）＋ 柔和投影（C5）＋ 字本身
  const textAttrs = (g) => ({ x: f3(g.ox), y: f3(g.oy), 'font-family': family, 'font-size': f3(g.px) });
  for (const g of glyphs) {
    const pad = 0.12 * fs;
    g.mbox = { x0: g.ink.x0 - pad, x1: g.ink.x1 + pad, y0: g.ink.y0 - pad, y1: g.ink.y1 + pad };
    const m = el('mask', { id: `${uid}-m${g.i}`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
    g.mask = m;
    g.wrap = el('g', { mask: `url(#${uid}-m${g.i})` }, scene);
    if (entrance === 'bleed') {
      // 晕开起点：墨迹框里取 3 个点，第一个靠左上（起笔处）
      const r = rng(seed, 'ink', g.i);
      g.points = [0, 1, 2].map((k) => ({ x: lerp(g.ink.x0, g.ink.x1, k === 0 ? 0.25 + r() * 0.2 : 0.2 + r() * 0.6), y: lerp(g.ink.y0, g.ink.y1, k === 0 ? 0.25 + r() * 0.2 : 0.2 + r() * 0.6) }));
      // 每团墨单独长到能盖住整个框（随机半径最小 0.85、毛边最多往里缩 roughness）
      const rough = 0.2;
      const far = Math.max(...g.points.map((p) => Math.max(...[[g.mbox.x0, g.mbox.y0], [g.mbox.x1, g.mbox.y0], [g.mbox.x0, g.mbox.y1], [g.mbox.x1, g.mbox.y1]].map(([x, y]) => Math.hypot(x - p.x, y - p.y)))));
      g.maxR = far / (0.85 * (1 - rough)) + 2;
      g.rough = rough;
      g.blobs = g.points.map(() => el('path', { fill: '#fff' }, m));
      g.pools = g.points.map(() => el('path', { fill: C.outer }, g.wrap));
    } else {
      g.mMain = el('path', { fill: '#fff' }, m);
      g.mDry = el('path', { fill: '#7a7a7a' }, m);
    }
    if (softShadow) g.shadow = el('text', { ...textAttrs(g), fill: C.shadow, filter: `url(#${uid}-soft)`, transform: `translate(${f3(0.02 * fs)},${f3(0.035 * fs)})` }, g.wrap);
    g.halo = el('text', { ...textAttrs(g), fill: 'none', stroke: C.outer, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g.wrap);
    g.node = el('text', { ...textAttrs(g), fill: inkPaint }, g.wrap);
    for (const n of [g.shadow, g.halo, g.node]) if (n) n.textContent = g.ch;
  }

  // 印章：粗糙边的红方块，磨损的斑点在遮罩里挖掉（字也一起磨损）；字按传统从右列往左列读
  let sealObj = null;
  if (seal) {
    const r = rng(seed, 'seal');
    // 印章放在 scene 外面：整体推近时印章只跟着挪位置、自己不缩放。小字（印章字只有三四十像素）跟着整组每帧换一个缩放比例，
    // 浏览器的画法会跟渲染顺序有关（2026-11-20 实测横屏 V3：印章字一块 36×36 像素差到 49 个色阶）；只挪位置就没事
    const gS = el('g', {}, svg);
    // 方块：每条边 7 段，往里外抖一点
    const jag = side * 0.022;
    const corner = (x, y) => [x + (r() - 0.5) * jag * 2, y + (r() - 0.5) * jag * 2];
    const ptsS = [];
    const edge = (x0, y0, x1, y1) => { for (let k = 0; k < 7; k++) { const s = k / 7; ptsS.push(corner(lerp(x0, x1, s), lerp(y0, y1, s))); } };
    edge(0, 0, side, 0); edge(side, 0, side, side); edge(side, side, 0, side); edge(0, side, 0, 0);
    let dRect = ptsS.map(([x, y], k) => `${k ? 'L' : 'M'}${f3(x)},${f3(y)}`).join('') + 'Z';
    // 磨损：靠边多、中间少的小坑，直接在红块的路径里挖洞（evenodd）。不用遮罩：遮罩里的东西每帧跟着整体推近做亚像素位移，
    // 关掉局部重画以后仍然偶发 1–3 个色阶的差（2026-11-20 实测，V3 推近时印章字边缘）。坑整个落在方块里，不往外鼓。
    const nSpot = 16;
    for (let k = 0; k < nSpot; k++) {
      const onEdge = r() < 0.75;
      const rad = side * (onEdge ? 0.012 + r() * 0.03 : 0.006 + r() * 0.012);
      const m = rad * 1.1 + jag;
      let x; let y;
      if (onEdge) { const e = Math.floor(r() * 4); const s = m + r() * (side - 2 * m); const inset = m + r() * side * 0.04; [x, y] = [[s, inset], [side - inset, s], [s, side - inset], [inset, s]][e]; } else { x = side * (0.15 + r() * 0.7); y = side * (0.15 + r() * 0.7); }
      dRect += `M${f3(x + rad)},${f3(y)}A${f3(rad)},${f3(rad)} 0 1 0 ${f3(x - rad)},${f3(y)}A${f3(rad)},${f3(rad)} 0 1 0 ${f3(x + rad)},${f3(y)}Z`;
    }
    const body = el('g', {}, gS);
    const rect = el('path', { d: dRect, fill: C.accent, 'fill-rule': 'evenodd' }, body);
    // 字：1 个字居中；2 个字上下叠；3 个字右列两个、左列一个；4 个字 2×2（右列先读）
    const n = sealChars.length;
    const padIn = side * 0.13; const inner = side - padIn * 2;
    const cells = n === 1 ? [[0, 0, 1, 1]] : n === 2 ? [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]
      : n === 3 ? [[0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.5, 1]] : [[0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5]];
    const texts = sealChars.map((ch, k) => {
      const [cx, cy, cw, chh] = cells[k];
      const cellW = cw * inner; const cellH = chh * inner;
      const b0 = sealInk(ch, 100);
      const sx = Math.min(cellW * 0.94 / (b0.r - b0.l), cellH * 0.94 / (b0.b - b0.t));
      // 不做非等比缩放（横向拉宽、竖向拉长）：文字带 scale(x≠y) 时 Chrome 的画法跟这个页面之前画过什么有关，
      // 乱序渲染偶发 1–3 个色阶的差（2026-11-20 实测：拉宽印章字时 V3、C5 都对不上，改成等比以后 6 次全一致）
      const stretch = 1; const vstretch = 1;
      const px = 100 * sx;
      const ox = padIn + cx * inner + cellW / 2 - ((b0.l + b0.r) / 2) * sx * stretch;
      const oy = padIn + cy * inner + cellH / 2 - ((b0.t + b0.b) / 2) * sx * vstretch;
      const t = el('text', { 'font-family': sealFamily, 'font-size': f3(px), fill: C.inner, x: f3(ox), y: f3(oy) }, body);
      t.textContent = ch;
      return t;
    });
    sealObj = { g: gS, rect, texts, x: seal.x, y: seal.y };
  }

  // ---------- 7) seek ----------
  const inkA = P.ink;
  function seek(t) {
    // 整体：盖章那一下震 2 帧；V3 停留时慢慢推近（10 秒 3%）
    let m = { dx: 0, dy: 0 };
    if (seal && P.stamp > 0) m = shake(t, { start: sealT1, amplitude: 0.003 * short * P.stamp, duration: 2 / fps + 1e-6, freq: fps, seed, rotate: 0 });
    const push = 1 + 0.003 * P.push * Math.max(0, t);
    const cx = W / 2; const cy = (block.y0 + block.y1) / 2;
    scene.setAttribute('transform', `translate(${f3(m.dx + cx * (1 - push))},${f3(m.dy + cy * (1 - push))}) scale(${f3(push)})`);
    // 印章的位置跟着推近往外挪（按它的中心点算），震屏也一起震
    const sealShift = sealObj ? { x: m.dx + (sealObj.x + side / 2 - cx) * (push - 1), y: m.dy + (sealObj.y + side / 2 - cy) * (push - 1) } : null;

    const outK = (k0) => clamp((t - outroStart - k0) / (outDur * 0.6));
    // 大笔刷
    if (swash) {
      const p = easeOutCubic(clamp((t - swash.t0) / (swash.t1 - swash.t0)));
      const b = swash.box;
      const len = axis === 'x' ? b.x1 - b.x0 : b.y1 - b.y0;
      const e = (axis === 'x' ? b.x0 : b.y0) - 0.15 * fs + p * (len + 0.4 * fs);
      const [dm, dd] = sweepPaths(b0pad(b, 0.3 * fs), e, axis, fs, seed, 'swash');
      swash.mMain.setAttribute('d', p > 0 ? dm : 'M0,0Z'); swash.mDry.setAttribute('d', p > 0 ? dd : 'M0,0Z');
      if (p >= 1) swash.g.removeAttribute('mask'); else swash.g.setAttribute('mask', `url(#${uid}-swm)`);
      const fade = 1 - easeInCubic(outK(0));
      swash.g.setAttribute('visibility', p > 0 && fade > 0 ? 'visible' : 'hidden');
      for (const s of swash.strips) s.setAttribute('opacity', f3(fade));
    }
    // 墨点
    for (const s of splashes) {
      const p = easeOutCubic(clamp((t - s.t0) / 0.25));
      const fade = 1 - easeInCubic(outK(0.05));
      if (p <= 0 || fade <= 0) { s.path.setAttribute('visibility', 'hidden'); continue; }
      const [blob] = inkSpread(t, { seed: seed + 7, points: [{ x: s.x, y: s.y }], start: s.t0, duration: 0.25, maxR: s.rad, roughness: 0.25, segments: 14 });
      s.path.setAttribute('visibility', 'visible');
      s.path.setAttribute('d', blob.d || 'M0,0Z');
      s.path.setAttribute('opacity', f3(fade));
    }
    // 字
    for (const g of glyphs) {
      const local = (t - g.t0) / (g.t1 - g.t0);
      // 出场：按字序错开淡出，先出的先走
      const fadeOut = 1 - easeInCubic(outK((g.i / Math.max(1, glyphs.length - 1)) * outDur * 0.3));
      if (local <= 0 || fadeOut <= 0) { g.wrap.setAttribute('visibility', 'hidden'); continue; }
      g.wrap.setAttribute('visibility', 'visible');
      const done = local >= 1;
      if (entrance === 'bleed' && done) { for (const pl of g.pools) pl.setAttribute('visibility', 'hidden'); } else if (entrance === 'bleed') {
        const blobs = inkSpread(t, { seed: seed + g.i * 31, points: g.points, start: g.t0, duration: (g.t1 - g.t0) * 0.85, stagger: (g.t1 - g.t0) * 0.05, maxR: g.maxR, roughness: g.rough, segments: 40 });
        blobs.forEach((b, k) => {
          g.blobs[k].setAttribute('d', b.d || 'M0,0Z');
          // 墨池：刚晕开时一团淡墨，越长越淡
          const pk = clamp(local / 0.85);
          const poolOp = 0.13 * Math.pow(1 - pk, 3) * inkA;
          g.pools[k].setAttribute('d', b.d || 'M0,0Z');
          g.pools[k].setAttribute('fill-opacity', f3(poolOp));
          g.pools[k].setAttribute('visibility', poolOp > 0.002 ? 'inherit' : 'hidden'); // 子元素写 visible 会盖过父层的 hidden，只能写 inherit
        });
      } else if (!done) {
        // 笔刷扫出：R3 整行一道（前沿按这一行的范围算），R1/R2 每个字自己一道
        let e;
        if (sweepLine) {
          const row = glyphs.filter((x) => x.li === g.li);
          const a0 = Math.min(...row.map((x) => (axis === 'x' ? x.mbox.x0 : x.mbox.y0)));
          const a1 = Math.max(...row.map((x) => (axis === 'x' ? x.mbox.x1 : x.mbox.y1)));
          e = lerp(a0 - 0.12 * fs, a1 + 0.25 * fs, easeInOutCubic(clamp(local)));
        } else {
          const a0 = axis === 'x' ? g.mbox.x0 : g.mbox.y0; const a1 = axis === 'x' ? g.mbox.x1 : g.mbox.y1;
          e = lerp(a0 - 0.12 * fs, a1 + 0.25 * fs, easeOutCubic(clamp(local)));
        }
        const [dm, dd] = sweepPaths(g.mbox, e, axis, fs, seed + g.i, `c${g.li}`);
        g.mMain.setAttribute('d', dm); g.mDry.setAttribute('d', dd);
      }
      if (done) g.wrap.removeAttribute('mask'); else g.wrap.setAttribute('mask', `url(#${uid}-m${g.i})`);
      // 墨晕：描边从字号 12% 收到 0，越收越淡（只在晕开时有；扫出时很淡的一圈）
      const hk = clamp(local);
      const haloW = (entrance === 'bleed' ? 0.12 : 0.04) * fs * Math.pow(1 - hk, 1.5);
      g.halo.setAttribute('stroke-width', f3(haloW));
      g.halo.setAttribute('stroke-opacity', f3((entrance === 'bleed' ? 0.5 : 0.3) * (1 - hk) * inkA * fadeOut));
      g.halo.setAttribute('visibility', haloW > 0.05 ? 'inherit' : 'hidden');
      g.node.setAttribute('fill-opacity', f3(inkA * fadeOut));
      if (g.shadow) g.shadow.setAttribute('fill-opacity', f3(0.55 * fadeOut * clamp(local * 1.5)));
    }
    // 印章：从 130% 盖到 100%（越落越快），落下前就显出来；出场最后走
    if (sealObj) {
      const p = clamp((t - sealT0) / (sealT1 - sealT0));
      const fade = 1 - easeInCubic(clamp((t - outroStart - outDur * 0.45) / (outDur * 0.55)));
      if (p <= 0 || fade <= 0) sealObj.g.setAttribute('visibility', 'hidden');
      else {
        const s = lerp(1.3, 1, easeInCubic(p));
        const op = clamp(p / 0.35) * fade;
        sealObj.g.setAttribute('visibility', 'visible');
        sealObj.g.setAttribute('transform', `translate(${f3(sealObj.x + sealShift.x + (side * (1 - s)) / 2)},${f3(sealObj.y + sealShift.y + (side * (1 - s)) / 2)}) scale(${f3(s)})`);
        sealObj.rect.setAttribute('fill-opacity', f3(op));
        for (const tx of sealObj.texts) tx.setAttribute('fill-opacity', f3(op));
      }
    }
  }

  // ---------- 8) 时间轴和排版结果 ----------
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场（含盖章）', start: 0, end: introEnd },
      { name: 'hold', label: '停留', start: introEnd, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: duration },
    ],
    beats: seal ? [{ t: sealT1, name: 'stamp', label: '盖章' }] : [],
    units: [
      ...glyphs.map((g) => ({ text: g.ch, start: g.t0, end: g.t1, line: g.li })),
      ...(seal ? [{ text: `印章「${sealChars.join('')}」`, start: sealT0, end: sealT1 }] : []),
    ],
  };
  // 本风格自己的检查（导出清单 checks.style；没过的在导出时打 ⚠，不卡导出）
  const styleChecks = [
    { id: 'seal-overlap', level: 'warn', pass: !(seal && seal.overlap), message: !seal ? '没有印章' : seal.overlap ? '印章挪了 20 次还压着字：换短一点的标题，或者把印章调小' : '印章没有压到字' },
    { id: 'vertical-punct', level: 'warn', pass: !dropped.length, message: dropped.length ? `竖排题字不放标点（书法字体没有竖排标点），已去掉「${dropped.join('')}」` : '没有要去掉的标点' },
    { id: 'line-edge-separator', level: 'warn', pass: !trimmed.length, message: trimmed.length ? `分隔符「${trimmed.join('')}」正好落在行首或行尾，换行已经把两边分开了，去掉了` : '行首行尾没有多余的分隔符' },
    { id: 'length', level: 'warn', pass: nChars <= 6, message: nChars > 6 ? `${nChars} 个字，超过 6 个字就不太像大标题了，可以考虑 005 竖排诗句或 002 大字报` : `${nChars} 个字` },
  ];
  return {
    timeline,
    layout: {
      fontSize: fs,
      lines: lines.map((l) => l.join('')),
      linesDetail: lines.map((l, li) => ({ text: l.join(''), chars: glyphs.filter((g) => g.li === li).map((g) => ({ ch: g.ch, px: +g.px.toFixed(2), ink: [g.ink.x0, g.ink.y0, g.ink.x1, g.ink.y1].map((v) => +v.toFixed(1)) })) })),
      forced,
      issues: [],
      warnings: [],
      styleChecks,
      seal: seal ? { chars: sealChars.join(''), box: [seal.x, seal.y, seal.x + side, seal.y + side].map((v) => +v.toFixed(1)) } : null,
      block: [block.x0, block.y0, block.x1, block.y1].map((v) => +v.toFixed(1)),
      entrance,
      segmentation: ctx.segmentation && ctx.segmentation.sources,
    },
    seek,
    destroy() { svg.remove(); },
  };
}

function b0pad(b, p) { return { x0: b.x0 - p, x1: b.x1 + p, y0: b.y0 - p, y1: b.y1 + p }; }

function mixHex(a, b, k) {
  const pa = parseInt(a.slice(1), 16); const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** 大笔刷用的颜色：浅纸用配色的 sub（淡墨），深底用 sub（比底色深一档） */
function swashColor(C) { return C.sub; }
