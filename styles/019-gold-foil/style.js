// 019 烫金字（styles/019-gold-foil）
//
// 契约见 engine/docs/写一个新风格.md：create 只按 (参数, 画面尺寸) 搭一次 SVG；seek(t) 是纯函数，
// 每次把所有会动的属性从头算一遍，结果只看 t。随机数一律来自 hash01 / rng（带种子）。
//
// 画面：一两行金字，金属感靠「多层」而不是一层黄色。每个字从下到上：
//   投影（不模糊，往右下错开）→ 厚度（几层往右下错开的深金色，像金属片的侧面）→ 外侧暗边（粗描边）
//   → 金边（细描边，渐变方向跟字面相反，看起来像倒角）→ 字面（多段竖向渐变：亮—金—暗带—金—亮）
//   → 金箔纹理（逐像素算出的皱褶小块，叠一层半透明）→ 内侧高光／内侧暗边（错开一点的描边，剪在字形里面）
//   → 高光（一道斜光带，用渐变位移扫过）。
//   书法字体的笔画细，暗边、金边、倒角都按字体缩窄，细笔画不糊成一团（见 PROFILE）。
// 动效：一道斜光带从左上扫到右下，光带走过的地方金字被「烫」出来（遮罩用同一条渐变，前沿羽化），
//   每个字被扫到时从 110% 压回原大；V3 最后盖一方印章。停留时高光按间隔扫过，闪光星在光带经过时亮一下，
//   字面的暗带随时间轻轻上下浮动（像光在变）。出场是光带反着把字收走。
// 硬规矩：不给整组做透明度动画（透明度只设在单个图形上）；不用模糊滤镜；文字只做等比缩放；
//   闪光星缩放小于 0.2 时隐藏；背景的祥云和暗纹完全静止。
// 关键词（*…*）：关键词占多数的那一行是主标题，其余行按 sub 比例缩小当副标题；关键词的字用更亮的金，
//   闪光星优先落在关键词上。

import { hash01, rng } from '../../engine/src/lib/rand.js';
import { clamp, lerp, easeOutCubic, easeInCubic, easeInOutCubic, smoothstep } from '../../engine/src/lib/ease.js';
import { atomize, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { mix } from '../../engine/src/lib/color.js';
import { f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const BRUSH = new Set(['zhimangxing', 'mashanzheng', 'liujianmaocao']);
const STRONG = new Set([...'。！？!?…；;']);
const WEAK = new Set([...'，、,：:']);

const el = (tag, attrs = {}, parent = null) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
};
const isHan = (ch) => /\p{Script=Han}/u.test(ch);
const isPunct = (ch) => FULLWIDTH_PUNCT.has(ch) || /^[\p{P}\p{S}]$/u.test(ch);
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
const cvOf = (a) => { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; const v = a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length; return m ? Math.sqrt(v) / m : 0; };

// 各层宽度（占这一行的字号）。书法字体笔画细，一律收窄，不然暗边会把细笔画包成一团
const PROFILE = {
  block: { edge: 0.046, rim: 0.019, shX: 0.03, shY: 0.052, depth: 0.042, steps: 4, bev: 0.008, bevW: 0.0075, track: 0.02 },
  brush: { edge: 0.022, rim: 0.009, shX: 0.02, shY: 0.036, depth: 0.022, steps: 3, bev: 0.0055, bevW: 0.006, track: -0.025 },
};

/** 量字：在 100px 下量字身宽度和墨迹包围盒（相对原点，基线在 y=0），用的时候乘字号/100 */
function makeMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  g.font = `100px ${family}`;
  const cache = new Map();
  return (ch) => {
    if (cache.has(ch)) return cache.get(ch);
    const m = g.measureText(ch);
    const b = { adv: m.width / 100, l: -m.actualBoundingBoxLeft / 100, r: m.actualBoundingBoxRight / 100, t: -m.actualBoundingBoxAscent / 100, b: m.actualBoundingBoxDescent / 100 };
    if (!(b.r > b.l)) { b.l = 0; b.r = b.adv || 0.5; }
    if (!(b.b > b.t)) { b.t = -0.5; b.b = 0; }
    cache.set(ch, b);
    return b;
  };
}

/**
 * 金箔纹理：一块能无缝平铺的方图，逐像素算（不靠画布抗锯齿，每次一样）。
 * 7×7 个抖动格点做 Voronoi：每一小块金箔有自己的明暗和朝向（块内有一点渐变），块和块之间是细细的皱褶线，再加细颗粒。
 * 亮的地方是暖白、暗的地方是深褐，透明度里装强度，叠在字面上。
 */
function foilTile(seed, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const r = rng(seed, 'foil');
  const n = 7; const cell = size / n;
  const sites = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      sites.push({ x: (i + 0.15 + 0.7 * r()) * cell, y: (j + 0.15 + 0.7 * r()) * cell, v: r() * 2 - 1, dx: Math.cos(a), dy: Math.sin(a), c: r() < 0.5 ? 1 : -1 });
    }
  }
  const grain = rng(seed, 'foil-grain');
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ci = Math.floor(x / cell); const cj = Math.floor(y / cell);
      let d1 = Infinity; let d2 = Infinity; let s1 = null; let ox1 = 0; let oy1 = 0;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const ii = ci + di; const jj = cj + dj;
          const wi = ((ii % n) + n) % n; const wj = ((jj % n) + n) % n;
          const s = sites[wj * n + wi];
          const sx = s.x + (ii - wi) * cell; const sy = s.y + (jj - wj) * cell;
          const d = Math.hypot(x - sx, y - sy);
          if (d < d1) { d2 = d1; d1 = d; s1 = s; ox1 = x - sx; oy1 = y - sy; } else if (d < d2) d2 = d;
        }
      }
      // 每小块的明暗 + 块内一点朝向渐变；块边只留很淡的皱褶（太明显像裂纹）；细颗粒
      const facet = 0.34 * s1.v + 0.32 * ((ox1 * s1.dx + oy1 * s1.dy) / cell);
      const e = (d2 - d1) / cell;
      const crease = (1 - smoothstep(0, 0.05, e)) * s1.c * 0.22;
      const v = clamp(facet + crease + (grain() - 0.5) * 0.5, -1, 1);
      const k = (y * size + x) * 4;
      const a = Math.pow(Math.abs(v), 1.15);
      if (v >= 0) { img.data[k] = 255; img.data[k + 1] = 250; img.data[k + 2] = 228; } else { img.data[k] = 74; img.data[k + 1] = 36; img.data[k + 2] = 4; }
      img.data[k + 3] = Math.round((v >= 0 ? 120 : 200) * a);
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** 一条或几条光带的渐变色标：bands=[{u, w, peak}]，u 是光带中心（0–1），w 是半宽。返回 n 个 [offset, opacity]（不够的补在 1 上） */
function bandStops(bands, n) {
  const pts = [];
  for (const b of bands) for (const k of [-1, -0.66, -0.33, 0, 0.33, 0.66, 1]) pts.push(b.u + k * b.w);
  const xs = [...new Set(pts.map((x) => clamp(x)))].sort((a, b) => a - b);
  const op = (x) => Math.max(0, ...bands.map((b) => { const d = Math.abs(x - b.u) / b.w; return d >= 1 ? 0 : b.peak * (Math.cos(Math.PI * d) + 1) / 2; }));
  const out = [[0, op(0)], ...xs.map((x) => [x, op(x)]), [1, op(1)]];
  const uniq = out.filter((s, i) => i === 0 || s[0] > out[i - 1][0] + 1e-6 || i === out.length - 1);
  while (uniq.length < n) uniq.push([1, uniq[uniq.length - 1][1]]);
  return uniq.slice(0, n);
}

/** 回纹（一个方形回旋）：返回 tile 里的折线点，tile 边长 s，从中心往外转 */
function huiwenPoints(s, x0, y0, dir) {
  const k = s / 10;
  // 方形回旋：中心一小格往外绕两圈半，最后一笔伸到格子边，跟相邻那一格接上
  const base = [[5, 5], [5, 4], [6, 4], [6, 6], [4, 6], [4, 3], [7, 3], [7, 7], [3, 7], [3, 2], [8, 2], [8, 8], [2, 8], [2, 1.2]];
  return base.map(([x, y]) => {
    let px = x; let py = y;
    if (dir & 1) px = 10 - px;
    if (dir & 2) py = 10 - py;
    return [x0 + px * k, y0 + py * k];
  });
}

/** 祥云：几团圆头（每团里一个回旋）＋一条圆角底带＋左边一个小卷尾。cx, cy 是底带左端，U 是整朵宽度，flip 左右翻 */
function cloudParts(cx, cy, U, flip) {
  const X = (x) => cx + (flip ? -x : x) * U;
  const Y = (y) => cy + y * U;
  // 圆头从左往右一个比一个小、排成一道弧；底下一条细长的圆角底带，最左边一个小卷
  const discs = [[0.22, -0.11, 0.165], [0.45, -0.19, 0.145], [0.655, -0.1, 0.105], [0.81, -0.035, 0.065], [0.035, -0.015, 0.06]]
    .map(([x, y, r]) => ({ x: X(x), y: Y(y), r: r * U }));
  const bx0 = Math.min(X(0.03), X(0.93)); const bx1 = Math.max(X(0.03), X(0.93));
  const band = { x: bx0, y: Y(-0.055), w: bx1 - bx0, h: 0.09 * U, r: 0.045 * U };
  // 回旋：从圆头的左下方往里卷 1.3 圈
  const spirals = discs.slice(0, 4).concat(discs.slice(4)).map((d, i) => {
    const turns = 1.35; const a0 = (flip ? -1 : 1) * (i === 4 ? 0.2 : 2.4);
    const dirS = flip ? -1 : 1;
    let s = '';
    const N = 40;
    for (let k = 0; k <= N; k++) {
      const q = k / N;
      const a = a0 + dirS * q * turns * Math.PI * 2;
      const rr = d.r * 0.74 * (1 - 0.82 * q);
      s += `${k ? 'L' : 'M'}${f3(d.x + Math.cos(a) * rr)},${f3(d.y + Math.sin(a) * rr)}`;
    }
    return s;
  });
  return { discs, band, spirals };
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const C = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed | 0;
  const fps = 30;
  const short = Math.min(W, H);
  const portrait = H > W * 1.05;
  const landscape = W > H * 1.05;
  const transparent = !!P.transparent || ctx.transparent === true;
  const uid = ctx.uid ? `${ctx.uid}-gf` : `gf${Math.floor(hash01(seed, W, H) * 1e9).toString(36)}`;
  const family = ctx.fontFamily(P.font);
  const brush = BRUSH.has(P.font);
  const PR = brush ? PROFILE.brush : PROFILE.block;
  const measure = makeMeasurer(family);
  const track = PR.track + P.tracking;

  // ---------- 1) 文字 → 不可再拆的块（按词，标点粘在前后的词上） ----------
  const paragraphs = String(ctx.text).replace(/\r/g, '').split('\n').map((p) => p.trim());
  const atoms = [];
  paragraphs.forEach((p, pi) => {
    if (!p) return;
    const as = atomize(p, { segment: ctx.segment });
    as.forEach((a, ai) => {
      let off = a.index; let real = 0; let kwReal = 0; const chars = [];
      for (const ch of a.graphemes) {
        const b = measure(ch);
        const blank = /\s/.test(ch);
        const punct = !blank && isPunct(ch);
        let cell;
        if (blank) cell = { w: 0.3, x0: 0 };
        else if (brush || punct || !isHan(ch)) { const pad = brush ? 0 : punct ? 0.05 : 0.03; cell = { w: b.r - b.l + 2 * pad, x0: b.l - pad }; } else cell = { w: b.adv, x0: 0 };
        const kw = !blank && !punct && ctx.isEmphasis && ctx.isEmphasis(pi, off);
        chars.push({ ch, off, b, cell, blank, punct, kw });
        if (!blank && !punct) { real++; if (kw) kwReal++; }
        off += ch.length;
      }
      const last = a.graphemes[a.graphemes.length - 1];
      atoms.push({ text: a.text, index: a.index, paragraph: pi, chars, real, kwReal, kw: real > 0 && kwReal * 2 >= real, endPara: ai === as.length - 1, breakBonus: STRONG.has(last) ? 0.5 : WEAK.has(last) ? 0.3 : 0 });
    });
  });
  const hasKw = atoms.some((a) => a.kwReal > 0);
  const totalReal = atoms.reduce((s, a) => s + a.real, 0);

  // 一行的自然宽度（单位：字号），去掉行首行尾的空格
  function lineChars(a, b) {
    const cs = [];
    for (let i = a; i < b; i++) cs.push(...atoms[i].chars);
    while (cs.length && cs[0].blank) cs.shift();
    while (cs.length && cs[cs.length - 1].blank) cs.pop();
    return cs;
  }
  function natWidth(cs) {
    let w = 0;
    cs.forEach((c, k) => { w += c.cell.w; if (k && !c.blank && !cs[k - 1].blank) w += track; });
    return w;
  }

  // ---------- 2) 排版区域和字号上限 ----------
  const side = landscape ? 0.1 : 0.075;
  const availW = W * (1 - 2 * side);
  const yTop = 0.1 * H; const yBot = portrait ? 0.76 * H : 0.88 * H; // 竖屏避开底部 20% 的遮挡区
  const availH = (yBot - yTop) * 0.92;
  // 主标题只有一两个字时（「福」「大吉」）上限放大，不然一个字缩在画面中间显得空：按主标题的字数算，跟断法无关
  const nMain = hasKw ? atoms.reduce((s, a) => s + a.kwReal, 0) : totalReal;
  const boost = P.size != null ? 1 : nMain <= 1 ? 1.8 : nMain === 2 ? 1.45 : nMain === 3 ? 1.15 : 1;
  const cap = (P.size ?? (landscape ? 0.28 : 0.22)) * short * boost;
  const extra = PR.edge * P.edge + PR.depth * P.depth + PR.shX + 0.04; // 暗边、厚度、投影、按压的余量（占字号）
  const subK = hasKw ? P.sub : 1;
  const maxLines = clamp(P.maxLines | 0, 1, 3);

  // ---------- 3) 枚举断法，打分 ----------
  let best = null; let evaluated = 0;
  function score(lines) {
    const info = lines.map(([a, b]) => {
      const cs = lineChars(a, b);
      let real = 0; let kwReal = 0;
      for (const c of cs) if (!c.blank && !c.punct) { real++; if (c.kw) kwReal++; }
      const isKw = kwReal > 0 && kwReal * 2 >= real;
      return { a, b, cs, nat: natWidth(cs), real, kwReal, isKw, rel: hasKw && !isKw ? subK : 1 };
    });
    const k = info.length;
    let fsBig = cap;
    for (const l of info) fsBig = Math.min(fsBig, availW / (l.rel * (l.nat + 2 * extra)));
    const hUnits = info.reduce((s, l) => s + l.rel * 1.02, 0) + (k - 1) * 0.24 * Math.min(...info.map((l) => l.rel));
    fsBig = Math.min(fsBig, availH / hUnits);
    let cost = 3 * Math.log(cap / fsBig) + 0.45 * (k - 1);
    for (const l of info) {
      if (l.real <= 1 && totalReal > 1) cost += 6; // 孤字
      if (l.real <= 2 && totalReal > 4 && !l.isKw) cost += 1.2; // 一行只剩一两个字，读起来断在意思中间
      if (hasKw && l.kwReal > 0 && !l.isKw) cost += 2.5; // 关键词跟普通字挤在一行，而且不占多数
      if (hasKw && l.isKw) cost += 0.6 * (l.real - l.kwReal); // 关键词行里混了普通字
    }
    if (hasKw && !info.some((l) => l.isKw)) cost += 3;
    const plain = info.filter((l) => !l.isKw);
    cost += 1.2 * cvOf(plain.map((l) => l.real));
    if (!hasKw) cost += 1.2 * cvOf(info.map((l) => l.real));
    for (let j = 1; j < k; j++) {
      const prev = atoms[info[j].a - 1]; const next = atoms[info[j].a];
      cost -= prev.breakBonus;
      if (prev.real === 1 && next.real === 1 && !prev.breakBonus) cost += 1.5;
      if (prev.kwReal && next.kwReal && prev.paragraph === next.paragraph) cost += 5; // 关键词被拆到两行
    }
    return { cost, info, fsBig };
  }
  function walk(i, lines) {
    if (evaluated > 40000) return;
    if (i >= atoms.length) { evaluated++; const r = score(lines); if (!best || r.cost < best.cost - 1e-9) best = r; return; }
    if (lines.length >= maxLines) return;
    let real = 0;
    for (let j = i; j < atoms.length; j++) {
      real += atoms[j].real;
      if (real > P.maxChars && j > i) break;
      lines.push([i, j + 1]);
      walk(j + 1, lines);
      lines.pop();
      if (atoms[j].endPara) break;
    }
  }
  if (atoms.length) walk(0, []);
  const forced = [];
  if (!best && atoms.length) {
    // 行数上限内排不下：每行塞满 maxChars 个字硬排（段落结尾照样换行），交给检查报出来
    const lines = []; let a = 0; let real = 0;
    atoms.forEach((at, i) => {
      if (i > a && (real + at.real > P.maxChars || atoms[i - 1].endPara)) { lines.push([a, i]); a = i; real = 0; }
      real += at.real;
    });
    lines.push([a, atoms.length]);
    best = score(lines);
    forced.push(`超过 ${maxLines} 行（一行最多 ${P.maxChars} 个字）`);
  }

  // ---------- 4) 落位：每行字号、每个字的位置 ----------
  const fsBig = best ? best.fsBig : cap;
  const lineObjs = best ? best.info.map((l) => ({ ...l, fs: fsBig * l.rel })) : [];
  // 行高：按墨迹算（非书法字体每行一条基线；书法字体每个字按自己的墨迹上下居中）
  for (const l of lineObjs) {
    const ink = l.cs.filter((c) => !c.blank);
    if (brush) { const hh = Math.max(0.3, ...ink.map((c) => (c.b.b - c.b.t) / 2)); l.top = -hh; l.bot = hh; } else { l.top = Math.min(-0.3, ...ink.map((c) => c.b.t)); l.bot = Math.max(0, ...ink.map((c) => c.b.b)); }
    l.h = (l.bot - l.top) * l.fs;
  }
  const gapOf = (a, b) => 0.22 * Math.min(a.fs, b.fs) + 0.05 * fsBig;
  const blockH = lineObjs.reduce((s, l, i) => s + l.h + (i ? gapOf(lineObjs[i - 1], l) : 0), 0);
  const yC0 = (P.y ?? (portrait ? 0.42 : 0.47)) * H;
  const yC = clamp(yC0, yTop + blockH / 2, Math.max(yTop + blockH / 2, yBot - blockH / 2));
  let yCur = yC - blockH / 2;
  const glyphs = [];
  lineObjs.forEach((l, li) => {
    if (li) yCur += gapOf(lineObjs[li - 1], l);
    const cy = yCur + l.h / 2; // 这一行墨迹的中线
    l.cy = cy;
    const wPx = natWidth(l.cs) * l.fs;
    let x = W / 2 - wPx / 2;
    l.x0 = x; l.x1 = x + wPx;
    l.cs.forEach((c, k) => {
      if (k && !c.blank && !l.cs[k - 1].blank) x += track * l.fs;
      if (!c.blank) {
        const ox = x - c.cell.x0 * l.fs;
        const base = brush ? cy - ((c.b.t + c.b.b) / 2) * l.fs : cy - ((l.top + l.bot) / 2) * l.fs;
        const ink = { x0: ox + c.b.l * l.fs, x1: ox + c.b.r * l.fs, y0: base + c.b.t * l.fs, y1: base + c.b.b * l.fs };
        glyphs.push({ ch: c.ch, kw: c.kw, punct: c.punct, li, fs: l.fs, x: ox, y: base, ink, cx: (ink.x0 + ink.x1) / 2, cy: (ink.y0 + ink.y1) / 2 });
      }
      x += c.cell.w * l.fs;
    });
    yCur += l.h;
  });
  glyphs.forEach((g, i) => { g.i = i; });
  const block = glyphs.length
    ? glyphs.reduce((e, g) => ({ x0: Math.min(e.x0, g.ink.x0), x1: Math.max(e.x1, g.ink.x1), y0: Math.min(e.y0, g.ink.y0), y1: Math.max(e.y1, g.ink.y1) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity })
    : { x0: W * 0.4, x1: W * 0.6, y0: H * 0.45, y1: H * 0.55 };
  const bcx = (block.x0 + block.x1) / 2; const bcy = (block.y0 + block.y1) / 2;

  // ---------- 5) 印章：放在最后一行右边，底边跟墨迹底对齐；右边放不下就放到字块右下方 ----------
  const sealChars = [...String(P.seal || '')].filter((c) => !/\s/.test(c)).slice(0, 4);
  const side_ = sealChars.length && glyphs.length ? P.sealSize * fsBig : 0;
  let seal = null;
  if (side_) {
    const lastLine = lineObjs[lineObjs.length - 1];
    const lg = glyphs.filter((g) => g.li === lineObjs.length - 1);
    const inkR = Math.max(...lg.map((g) => g.ink.x1)); const inkB = Math.max(...lg.map((g) => g.ink.y1));
    const gap = 0.12 * lastLine.fs;
    const m = (P.frame && !transparent ? 0.1 : 0.05) * short;
    seal = { x: inkR + gap, y: inkB - side_ + 0.04 * lastLine.fs };
    if (seal.x + side_ > W - m) seal = { x: Math.min(block.x1 - 0.06 * fsBig, W - m) - side_, y: block.y1 + 0.12 * fsBig };
    const pad = 0.02 * fsBig;
    const hit = () => glyphs.some((g) => seal.x < g.ink.x1 + pad && seal.x + side_ > g.ink.x0 - pad && seal.y < g.ink.y1 + pad && seal.y + side_ > g.ink.y0 - pad);
    for (let k = 0; k < 20 && hit(); k++) seal.y += 0.04 * fsBig;
    seal.overlap = hit();
    seal.side = side_;
  }

  // ---------- 6) 时间 ----------
  const nG = glyphs.length;
  const frameOn = !!P.frame && !transparent;
  const sweepStart = frameOn ? 0.2 : 0.1;
  const sweepDur = R.sweep * clamp(0.72 + 0.055 * nG, 0.85, 1.5);
  const pressDur = R.press;
  // 光带的方向：从左上往右下，跟水平方向夹 22°（光带本身是「/」形，上面先到）
  const PHI = (22 * Math.PI) / 180; const nx = Math.cos(PHI); const ny = Math.sin(PHI);
  const marg = 0.05 * fsBig;
  const corners = [[block.x0 - marg, block.y0 - marg], [block.x1 + marg, block.y0 - marg], [block.x0 - marg, block.y1 + marg], [block.x1 + marg, block.y1 + marg]];
  if (seal) corners.push([seal.x - marg, seal.y - marg], [seal.x + seal.side + marg, seal.y + seal.side + marg]);
  const projs = corners.map(([x, y]) => x * nx + y * ny);
  const sMin = Math.min(...projs); const sMax = Math.max(...projs);
  const uOf = (x, y) => (x * nx + y * ny - sMin) / (sMax - sMin);
  const FEATHER = 0.0; // 前沿是硬边（剪切路径），亮光紧跟在后面盖住它
  const frontU = (p) => lerp(-0.02, 1.02, p);
  const sweepEase = (p) => easeInOutCubic(p) * 0.3 + p * 0.7; // 基本匀速，两头稍缓
  // 光带前沿扫到某一点（u）的时刻：反解缓动
  function tWhenFront(u, t0, dur) {
    let lo = 0; let hi = 1;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (frontU(sweepEase(m)) - 0.05 < u) lo = m; else hi = m; }
    return t0 + dur * lo;
  }
  for (const g of glyphs) { g.u = uOf(g.cx, g.cy); g.tHit = tWhenFront(g.u, sweepStart, sweepDur); }
  const textEnd = sweepStart + sweepDur + pressDur * 0.5;
  const sealT0 = textEnd + 0.08; const sealT1 = sealT0 + R.sealDur;
  const introEnd = (seal ? sealT1 + 2 / fps : textEnd) + 0.1;
  const hold = P.hold ?? R.hold;
  const outroStart = introEnd + hold;
  const outDur = R.out;
  const outroEnd = outroStart + outDur;
  const duration = outroEnd + 0.1;
  // 停留时的高光：间隔至少 sheen+0.15 秒，放不下就少扫几次
  const sheenDur = R.sheen;
  const sheens = [];
  if (P.sweeps > 0) {
    const first = introEnd + 0.3; const last = outroStart - 0.12 - sheenDur;
    const n = P.sweeps;
    const gapS = n > 1 ? (last - first) / (n - 1) : 0;
    if (last >= first) {
      if (n === 1 || gapS >= sheenDur + 0.15) for (let k = 0; k < n; k++) sheens.push(first + k * gapS);
      else { const m = Math.max(1, Math.floor((last - first) / (sheenDur + 0.15)) + 1); const g2 = m > 1 ? (last - first) / (m - 1) : 0; for (let k = 0; k < m; k++) sheens.push(first + k * g2); }
    }
  }
  const SHEEN_W = 0.09;
  const sheenU = (t, t0) => { const p = clamp((t - t0) / sheenDur); return lerp(-0.3, 1.3, smoothstep(0, 1, p) * 0.5 + p * 0.5); };

  // ---------- 7) 搭 SVG ----------
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: 'position:absolute;left:0;top:0;overflow:hidden', 'data-hanzifx-style': 'gold-foil' });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  const darkBg = lum(C.bg) < 0.45;

  // 底色（透明底时不画）：径向渐变，标题附近亮一点、四角压暗
  const gBg = el('g', { 'data-layer': 'ground' }, svg);
  let glowEl = null; // 光晕跟着字亮起来、收走（只改这一个椭圆自己的透明度，不动整组）
  if (!transparent) {
    const rg = el('radialGradient', { id: `${uid}-bg`, gradientUnits: 'userSpaceOnUse', cx: f3(bcx), cy: f3(bcy), r: f3(Math.hypot(W, H) * 0.62) }, defs);
    el('stop', { offset: '0%', 'stop-color': mix(C.bg, darkBg ? C.fill : '#FFFFFF', darkBg ? 0.07 : 0.4) }, rg);
    el('stop', { offset: '45%', 'stop-color': C.bg }, rg);
    el('stop', { offset: '100%', 'stop-color': mix(C.bg, '#000000', darkBg ? 0.45 : 0.1) }, rg);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${uid}-bg)` }, gBg);

    const pat = P.pattern;
    if (pat === 'huiwen' || pat === 'both') {
      // 回纹暗纹：2×2 个回旋一组，方向各不相同，同色系，静止
      const s = Math.round(0.07 * short);
      const pt = el('pattern', { id: `${uid}-hw`, patternUnits: 'userSpaceOnUse', width: 2 * s, height: 2 * s, x: f3(bcx % (2 * s)), y: f3(bcy % (2 * s)) }, defs);
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const pts = huiwenPoints(s, i * s, j * s, (i + 2 * j) % 4);
          el('polyline', { points: pts.map(([x, y]) => `${f3(x)},${f3(y)}`).join(' '), fill: 'none', stroke: C.sub, 'stroke-width': f3(s * 0.045), 'stroke-linejoin': 'miter', 'stroke-linecap': 'square' }, pt);
        }
      }
      el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${uid}-hw)`, opacity: darkBg ? 0.24 : 0.16 }, gBg);
      // 标题后面的暗纹淡一点，免得跟字抢
      const fade = el('radialGradient', { id: `${uid}-hwf`, gradientUnits: 'userSpaceOnUse', cx: f3(bcx), cy: f3(bcy), r: f3(Math.max(block.x1 - block.x0, block.y1 - block.y0) * 0.9) }, defs);
      el('stop', { offset: '0%', 'stop-color': C.bg, 'stop-opacity': 0.75 }, fade);
      el('stop', { offset: '100%', 'stop-color': C.bg, 'stop-opacity': 0 }, fade);
      el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${uid}-hwf)` }, gBg);
    }
    if (pat === 'cloud' || pat === 'both') {
      // 祥云：上下（横屏是左右）各放两朵，避开标题；先画一遍粗描边再画一遍填色，得到整朵的外轮廓
      // 一大一小一组，放在对角，往画面外伸出去一截（裁掉的那一截看起来是有意排的）
      const U = (portrait ? 0.62 : landscape ? 0.34 : 0.5) * W;
      const spots = portrait
        ? [[-0.14, 0.235, 1, false], [1.04, 0.3, 0.52, true], [1.12, 0.8, 1, true], [-0.04, 0.88, 0.48, false]]
        : landscape
          ? [[-0.1, 0.33, 1, false], [1.09, 0.78, 1, true], [1.0, 0.27, 0.48, true]]
          : [[-0.12, 0.26, 1, false], [1.12, 0.84, 1, true]];
      const line = mix(C.bg, C.fill, darkBg ? 0.5 : 0.6);
      const body = mix(C.bg, C.sub, 0.45);
      // 有边框时祥云剪在外框里面，不伸到边框外那一圈
      let clipAttr = null;
      if (P.frame) {
        const m = 0.042 * short;
        const cp = el('clipPath', { id: `${uid}-cc`, clipPathUnits: 'userSpaceOnUse' }, defs);
        el('rect', { x: f3(m), y: f3(m), width: f3(W - 2 * m), height: f3(H - 2 * m) }, cp);
        clipAttr = `url(#${uid}-cc)`;
      }
      const gC = el('g', { 'data-layer': 'clouds', 'clip-path': clipAttr }, gBg);
      for (const [px, py, sc, flip] of spots) {
        const u = U * sc;
        const parts = cloudParts(px * W + (flip ? 0 : 0), py * H, u, flip);
        const ow = Math.max(1.5, u * 0.0075);
        const shapes = (fill, stroke, sw) => {
          for (const d of parts.discs) el('circle', { cx: f3(d.x), cy: f3(d.y), r: f3(d.r), fill, stroke, 'stroke-width': sw }, gC);
          el('rect', { x: f3(parts.band.x), y: f3(parts.band.y), width: f3(parts.band.w), height: f3(parts.band.h), rx: f3(parts.band.r), fill, stroke, 'stroke-width': sw }, gC);
        };
        shapes(line, line, f3(ow * 2));
        shapes(body, 'none', 0);
        for (const d of parts.spirals) el('path', { d, fill: 'none', stroke: line, 'stroke-width': f3(ow), 'stroke-linecap': 'round' }, gC);
      }
    }
    // 字后面的光晕：径向渐变的椭圆，不用模糊滤镜
    if (P.glow > 0) {
      const gl = el('radialGradient', { id: `${uid}-glow`, cx: '50%', cy: '50%', r: '50%' }, defs);
      // 光晕用金色（不用最浅的 fill2：浅奶油色叠在红底上发粉）
      el('stop', { offset: '0%', 'stop-color': mix(C.fill, C.fill2, 0.25), 'stop-opacity': f3(0.34 * P.glow * (darkBg ? 1 : 0.8)) }, gl);
      el('stop', { offset: '55%', 'stop-color': C.fill, 'stop-opacity': f3(0.1 * P.glow) }, gl);
      el('stop', { offset: '100%', 'stop-color': C.fill, 'stop-opacity': 0 }, gl);
      const rx = Math.min(W * 0.62, (block.x1 - block.x0) * 0.85 + fsBig * 0.6); const ry = Math.min(H * 0.4, (block.y1 - block.y0) * 0.9 + fsBig * 0.6);
      glowEl = el('ellipse', { cx: f3(bcx), cy: f3(bcy), rx: f3(rx), ry: f3(ry), fill: `url(#${uid}-glow)` }, gBg);
    }
  }

  // 金线边框（V3）：外粗内细两道，四角回纹，开场时从左上角画出来
  let frame = null;
  if (frameOn) {
    const m = 0.042 * short; const m2 = m + 0.014 * short;
    const fg = el('linearGradient', { id: `${uid}-fr`, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: f3(W), y2: f3(H) }, defs);
    [[0, C.fill2], [0.18, C.fill], [0.35, C.inner], [0.5, C.fill], [0.62, C.fill2], [0.8, C.fill], [1, C.inner]].forEach(([o, c]) => el('stop', { offset: o, 'stop-color': c }, fg));
    const gF = el('g', { 'data-layer': 'frame' }, svg);
    const rect = (inset, sw) => {
      const w = W - 2 * inset; const h = H - 2 * inset; const L = 2 * (w + h);
      const r = el('rect', { x: f3(inset), y: f3(inset), width: f3(w), height: f3(h), fill: 'none', stroke: `url(#${uid}-fr)`, 'stroke-width': f3(sw), 'stroke-dasharray': f3(L), 'stroke-dashoffset': f3(L) }, gF);
      return { r, L };
    };
    const outer = rect(m, 0.0042 * short); const inner = rect(m2, 0.0016 * short);
    // 四角回纹：在内框的四个角往里折两道，再卷一个小回旋
    const c = 0.05 * short;
    const cornerPts = [[0, 1.9], [0, 0], [1.9, 0], null, [0.42, 1.45], [0.42, 0.42], [1.45, 0.42], null, [0.84, 1.02], [0.84, 0.84], [1.02, 0.84]];
    const corners2 = [];
    [[m2, m2, 1, 1], [W - m2, m2, -1, 1], [m2, H - m2, 1, -1], [W - m2, H - m2, -1, -1]].forEach(([ox, oy, sx, sy]) => {
      let d = ''; let pen = false;
      for (const p of cornerPts) { if (!p) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${f3(ox + sx * (p[0] * c + 0.012 * short))},${f3(oy + sy * (p[1] * c + 0.012 * short))}`; pen = true; }
      const sq = 0.16 * c;
      const qx = ox + sx * (0.012 * short + 1.32 * c); const qy = oy + sy * (0.012 * short + 1.32 * c);
      const g = el('g', {}, gF);
      el('path', { d, fill: 'none', stroke: `url(#${uid}-fr)`, 'stroke-width': f3(0.0034 * short), 'stroke-linecap': 'square', 'stroke-linejoin': 'miter' }, g);
      el('rect', { x: f3(qx - sq / 2), y: f3(qy - sq / 2), width: f3(sq), height: f3(sq), fill: `url(#${uid}-fr)`, transform: `rotate(45 ${f3(qx)} ${f3(qy)})` }, g);
      corners2.push({ g, ox, oy });
    });
    frame = { outer, inner, corners: corners2, t0: 0, t1: 0.95 };
  }

  // 金粉：背后一层（大多数），字前面一层（少量小点）。不透明底时满屏飘；透明底时只在标题周围飘，不碰画面边缘
  const dust = [];
  const gDustBack = el('g', { 'data-layer': 'dust-back' }, svg);
  if (P.dust > 0) {
    const bok = el('radialGradient', { id: `${uid}-bok`, cx: '50%', cy: '50%', r: '50%' }, defs);
    el('stop', { offset: '0%', 'stop-color': C.fill2, 'stop-opacity': 1 }, bok);
    el('stop', { offset: '45%', 'stop-color': C.fill, 'stop-opacity': 0.45 }, bok);
    el('stop', { offset: '100%', 'stop-color': C.fill, 'stop-opacity': 0 }, bok);
    const region = transparent
      ? { x0: Math.max(0.06 * W, block.x0 - 0.3 * fsBig), x1: Math.min(0.94 * W, block.x1 + 0.3 * fsBig), y0: Math.max(0.06 * H, block.y0 - 0.9 * fsBig), y1: Math.min(0.94 * H, block.y1 + 0.9 * fsBig), pad: 0 }
      : { x0: 0.02 * W, x1: 0.98 * W, y0: 0, y1: H, pad: 0.04 * H };
    const r = rng(seed, 'dust');
    const unit = short / 1080;
    for (let k = 0; k < P.dust; k++) {
      const type = r() < 0.16 ? 'bokeh' : r() < 0.55 ? 'flake' : 'dot';
      const front = type === 'dot' && r() < 0.3;
      const size = type === 'bokeh' ? (12 + r() * 26) * unit : type === 'flake' ? (5 + r() * 8) * unit : (1.8 + r() * 3) * unit;
      const node = type === 'bokeh'
        ? el('circle', { r: f3(size), fill: `url(#${uid}-bok)` }, gDustBack)
        : type === 'flake' ? el('path', { fill: r() < 0.5 ? C.fill2 : C.fill }, gDustBack) : el('circle', { r: f3(size), fill: C.fill2 }, front ? null : gDustBack);
      dust.push({
        node, type, front, size,
        x: lerp(region.x0, region.x1, r()), y0: r(),
        v: (type === 'bokeh' ? 0.018 + r() * 0.03 : 0.035 + r() * 0.07) * H, // 每秒往下落多少
        sway: (0.004 + r() * 0.014) * W, sf: 0.15 + r() * 0.35, sp: r() * Math.PI * 2,
        spin: (r() - 0.5) * 5, flip: 2 + r() * 4, fp: r() * Math.PI * 2,
        tw: 0.6 + r() * 1.6, tp: r() * Math.PI * 2, base: type === 'bokeh' ? 0.22 + r() * 0.28 : 0.7 + r() * 0.3,
      });
    }
    dust.region = region;
  }

  // ---------- 标题 ----------
  // 推近（V3）只加在 titleG 上；印章不跟着缩放，只挪位置（小字跟着整组每帧换缩放比例，乱序渲染会对不上，见 003）
  const titleG = el('g', { 'data-layer': 'title' }, svg);
  const textLayer = el('g', {}, titleG);
  // 揭开和收走用的剪切：前沿是一条斜线（跟光带同方向），剪切路径每帧算。
  // 不用渐变遮罩：整个标题组挂着每帧变的渐变遮罩，乱序渲染会在遮罩层的边上差一列像素（2026-11-20 实测，见 STYLE.md 第 11 节）
  const x1g = sMin * nx; const y1g = sMin * ny; const x2g = sMax * nx; const y2g = sMax * ny;
  const gradVec = { gradientUnits: 'userSpaceOnUse', x1: f3(x1g), y1: f3(y1g), x2: f3(x2g), y2: f3(y2g) };
  const wipeC = el('clipPath', { id: `${uid}-wc`, clipPathUnits: 'userSpaceOnUse' }, defs);
  const wipeP = el('path', { d: 'M0,0Z' }, wipeC);
  const BIG = 2 * Math.hypot(W, H);
  // u 以下（keep='below'）或以上（'above'）的半平面
  function halfPlane(u, keep) {
    const sv = sMin + u * (sMax - sMin);
    const fx = sv * nx; const fy = sv * ny; const dx = -ny; const dy = nx;
    const k = keep === 'below' ? -1 : 1;
    const pts = [[fx + dx * BIG, fy + dy * BIG], [fx - dx * BIG, fy - dy * BIG], [fx - dx * BIG + k * nx * BIG, fy - dy * BIG + k * ny * BIG], [fx + dx * BIG + k * nx * BIG, fy + dy * BIG + k * ny * BIG]];
    return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f3(x)},${f3(y)}`).join('') + 'Z';
  }
  // 高光：同方向的渐变，16 个色标每帧重算（两道光带：一道宽的，后面跟一道细的）
  const NS = 24;
  const sheenG = el('linearGradient', { id: `${uid}-sh`, ...gradVec }, defs);
  const sheenStops = Array.from({ length: NS }, () => el('stop', { offset: 1, 'stop-color': mix(C.fill2, '#FFFFFF', 0.7), 'stop-opacity': 0 }, sheenG));

  // 字面渐变：每行一套（普通、关键词各一条），竖向，按这一行墨迹的上下沿。暗带位置每帧轻轻浮动
  const kwFill = mix(C.fill, C.fill2, 0.22); const kwInner = mix(C.inner, C.fill, 0.18);
  // 亮—金—暗带（倒映的「地平线」）—金—亮—金：金属感主要靠中间那道暗带和上下两处亮
  const faceSpec = (fill, fill2, inner) => [
    [0.0, mix(fill, fill2, 0.38)], [0.13, mix(fill, fill2, 0.72)], [0.3, fill], [0.46, mix(fill, inner, 0.6)], [0.54, inner], [0.65, mix(fill, inner, 0.2)], [0.84, mix(fill, fill2, 0.38)], [1.0, mix(fill, inner, 0.5)],
  ];
  const faces = [];
  lineObjs.forEach((l, li) => {
    const lg = glyphs.filter((g) => g.li === li);
    if (!lg.length) return;
    const y0 = Math.min(...lg.map((g) => g.ink.y0)); const y1 = Math.max(...lg.map((g) => g.ink.y1));
    const mk = (key, spec) => {
      const gr = el('linearGradient', { id: `${uid}-${key}${li}`, gradientUnits: 'userSpaceOnUse', x1: 0, y1: f3(y0), x2: 0, y2: f3(y1) }, defs);
      const stops = spec.map(([o, c]) => el('stop', { offset: o, 'stop-color': c }, gr));
      faces.push({ stops, spec });
      return `url(#${uid}-${key}${li})`;
    };
    l.face = mk('f', faceSpec(C.fill, C.fill2, C.inner));
    l.kwFace = lg.some((g) => g.kw) ? mk('k', faceSpec(kwFill, C.fill2, kwInner)) : l.face;
    // 金边：渐变方向跟字面相反（上暗下亮），像金属片的倒角
    const rim = el('linearGradient', { id: `${uid}-r${li}`, gradientUnits: 'userSpaceOnUse', x1: 0, y1: f3(y0), x2: 0, y2: f3(y1) }, defs);
    [[0, mix(C.inner, C.fill, 0.3)], [0.45, C.fill], [0.8, C.fill2], [1, mix(C.fill, C.fill2, 0.5)]].forEach(([o, c]) => el('stop', { offset: o, 'stop-color': c }, rim));
    l.rim = `url(#${uid}-r${li})`;
    // 厚度：几层往右下错开的深金色，越往后越暗
    l.side = (k, K) => mix(mix(C.inner, C.outer, 0.25), C.outer, (k - 1) / Math.max(1, K - 1) * 0.7);
  });

  // 金箔纹理：平铺的图，铺在字面上（userSpaceOnUse，按大字号定格子大小）
  let foilPaint = null;
  if (P.foil > 0 && glyphs.length) {
    const T = Math.round(fsBig * 0.85);
    const pt = el('pattern', { id: `${uid}-foil`, patternUnits: 'userSpaceOnUse', width: T, height: T, x: f3(block.x0), y: f3(block.y0) }, defs);
    el('image', { href: foilTile(seed, 224), x: 0, y: 0, width: T, height: T, preserveAspectRatio: 'none' }, pt);
    foilPaint = `url(#${uid}-foil)`;
  }

  const textAttrs = (g) => ({ x: f3(g.x), y: f3(g.y), 'font-family': family, 'font-size': f3(g.fs), 'text-rendering': 'geometricPrecision' });
  const shadowOp = darkBg || transparent ? 0.6 : 0.42;
  for (const g of glyphs) {
    const l = lineObjs[g.li];
    const fs = g.fs;
    const ew = PR.edge * P.edge * fs; const rw = PR.rim * P.edge * fs;
    g.wrap = el('g', {}, textLayer);
    const mk = (attrs, parent = g.wrap) => { const t = el('text', { ...textAttrs(g), ...attrs }, parent); t.textContent = g.ch; return t; };
    // 剪在字形里面的东西用的剪切路径（倒角高光和暗边）
    const clip = el('clipPath', { id: `${uid}-c${g.i}`, clipPathUnits: 'userSpaceOnUse' }, defs);
    mk({}, clip);
    // 投影
    mk({ fill: C.shadow, stroke: C.shadow, 'stroke-width': f3(2 * ew), 'stroke-linejoin': 'round', 'fill-opacity': shadowOp, 'stroke-opacity': shadowOp, transform: `translate(${f3(PR.shX * fs + PR.depth * P.depth * fs)},${f3(PR.shY * fs + PR.depth * P.depth * fs * 1.2)})` });
    // 厚度
    const K = P.depth > 0 ? PR.steps : 0;
    for (let k = K; k >= 1; k--) {
      const d = (PR.depth * P.depth * fs * k) / K;
      const col = l.side(k, K);
      mk({ fill: col, stroke: col, 'stroke-width': f3(2 * ew), 'stroke-linejoin': 'round', transform: `translate(${f3(d * 0.75)},${f3(d)})` });
    }
    // 外侧暗边、金边
    mk({ fill: C.outer, stroke: C.outer, 'stroke-width': f3(2 * ew), 'stroke-linejoin': 'round' });
    mk({ fill: l.rim, stroke: l.rim, 'stroke-width': f3(2 * rw), 'stroke-linejoin': 'round' });
    // 字面
    g.face = mk({ fill: g.kw ? l.kwFace : l.face });
    if (foilPaint) mk({ fill: foilPaint, 'fill-opacity': f3(clamp(P.foil * (brush ? 0.6 : 0.8))) });
    // 内侧高光（左上）和内侧暗边（右下）：整个字错开一点再描边，剪在字形里面
    const bev = PR.bev * fs; const bw = PR.bevW * fs;
    mk({ fill: 'none', stroke: mix(C.fill2, '#FFFFFF', 0.5), 'stroke-width': f3(2 * bw), 'stroke-opacity': brush ? 0.5 : 0.5, 'stroke-linejoin': 'round', transform: `translate(${f3(bev)},${f3(bev)})`, 'clip-path': `url(#${uid}-c${g.i})` });
    mk({ fill: 'none', stroke: C.inner, 'stroke-width': f3(2 * bw), 'stroke-opacity': brush ? 0.35 : 0.32, 'stroke-linejoin': 'round', transform: `translate(${f3(-bev)},${f3(-bev)})`, 'clip-path': `url(#${uid}-c${g.i})` });
    // 高光（扫过时才显示）
    g.sheen = mk({ fill: `url(#${uid}-sh)` });
  }

  // 副标题两侧的金线（ornament）：一条细线，靠字那头一个小菱形，外头一个小圆点；放在 textLayer 里，跟字一起被烫出来、收走
  if (P.ornament && hasKw) {
    lineObjs.forEach((l, li) => {
      if (l.isKw) return;
      const lg = glyphs.filter((g) => g.li === li);
      if (!lg.length) return;
      const x0 = Math.min(...lg.map((g) => g.ink.x0)); const x1 = Math.max(...lg.map((g) => g.ink.x1));
      const y = (Math.min(...lg.map((g) => g.ink.y0)) + Math.max(...lg.map((g) => g.ink.y1))) / 2;
      const gap = 0.32 * l.fs; const len = Math.min(1.1 * l.fs, x0 - gap - side * W * 0.9);
      if (len < 0.35 * l.fs) return;
      const sw = Math.max(1.5, 0.035 * l.fs); const dm = 0.1 * l.fs;
      for (const dir of [-1, 1]) {
        const xi = dir < 0 ? x0 - gap : x1 + gap; const xo = xi + dir * len;
        const g = el('g', {}, textLayer);
        // 暗边先画一遍（粗一点、深色），再画金色，跟字的暗边一个意思
        el('path', { d: `M${f3(xi + dir * dm)},${f3(y)}L${f3(xo)},${f3(y)}`, stroke: C.outer, 'stroke-width': f3(sw * 2.4), 'stroke-linecap': 'round' }, g);
        el('path', { d: `M${f3(xi)},${f3(y - dm)}L${f3(xi + dir * dm)},${f3(y)}L${f3(xi)},${f3(y + dm)}L${f3(xi - dir * dm)},${f3(y)}Z`, fill: C.outer, stroke: C.outer, 'stroke-width': f3(sw * 1.4), 'stroke-linejoin': 'round' }, g);
        el('path', { d: `M${f3(xi + dir * dm)},${f3(y)}L${f3(xo)},${f3(y)}`, stroke: l.rim, 'stroke-width': f3(sw), 'stroke-linecap': 'round' }, g);
        el('path', { d: `M${f3(xi)},${f3(y - dm)}L${f3(xi + dir * dm)},${f3(y)}L${f3(xi)},${f3(y + dm)}L${f3(xi - dir * dm)},${f3(y)}Z`, fill: l.face }, g);
        el('circle', { cx: f3(xo + dir * sw * 1.6), cy: f3(y), r: f3(sw * 1.1), fill: C.fill }, g);
      }
    });
  }

  // 闪光星：挑几个字（关键词优先），放在墨迹右上角附近；高光扫过那一刻亮一下
  const glintG = el('g', { 'data-layer': 'glints' }, titleG);
  const glints = [];
  if (P.glints > 0 && glyphs.length) {
    const cand = glyphs.filter((g) => !g.punct).map((g) => ({ g, w: (g.kw ? 2 : 1) * (0.5 + hash01(seed, 'gl', g.i)) }));
    cand.sort((a, b) => b.w - a.w);
    const halo = el('radialGradient', { id: `${uid}-gh`, cx: '50%', cy: '50%', r: '50%' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#FFFFFF', 'stop-opacity': 0.9 }, halo);
    el('stop', { offset: '35%', 'stop-color': C.fill2, 'stop-opacity': 0.45 }, halo);
    el('stop', { offset: '100%', 'stop-color': C.fill2, 'stop-opacity': 0 }, halo);
    for (let k = 0; k < Math.min(P.glints, cand.length * 2); k++) {
      const g = cand[k % cand.length].g;
      const r = rng(seed, 'glint', k);
      const x = lerp(g.ink.x0, g.ink.x1, k < cand.length ? 0.6 + 0.35 * r() : 0.1 + 0.4 * r());
      const y = lerp(g.ink.y0, g.ink.y1, k < cand.length ? 0.05 + 0.3 * r() : 0.55 + 0.35 * r());
      const R0 = (g.kw ? 0.27 : 0.2) * g.fs * (0.8 + 0.4 * r());
      const gg = el('g', { visibility: 'hidden' }, glintG);
      el('circle', { cx: 0, cy: 0, r: f3(R0 * 0.7), fill: `url(#${uid}-gh)` }, gg);
      const star = (Rr, w) => `M0,${f3(-Rr)} L${f3(w)},${f3(-w)} L${f3(Rr)},0 L${f3(w)},${f3(w)} L0,${f3(Rr)} L${f3(-w)},${f3(w)} L${f3(-Rr)},0 L${f3(-w)},${f3(-w)}Z`;
      el('path', { d: star(R0, R0 * 0.09), fill: '#FFFFFF' }, gg);
      el('path', { d: star(R0 * 0.45, R0 * 0.07), fill: '#FFFFFF', transform: 'rotate(45)' }, gg);
      glints.push({ gg, x, y, u: uOf(x, y), delay: r() * 0.08, spin: (r() < 0.5 ? -1 : 1) * (25 + r() * 25) });
    }
  }

  // 金粉前景层（少量小点，在字前面）
  const gDustFront = el('g', { 'data-layer': 'dust-front' }, svg);
  for (const d of dust) if (d.front) gDustFront.appendChild(d.node);

  // 印章（V3）：粗糙边的方块，磨损小坑直接在路径里挖洞（evenodd）。外面套一层不变换的组，出场时跟标题共用一个遮罩
  let sealObj = null;
  if (seal) {
    const r = rng(seed, 'seal');
    const S = seal.side;
    const wrap = el('g', {}, svg);
    const gS = el('g', {}, wrap);
    const jag = S * 0.02;
    const pts = [];
    const edge = (x0, y0, x1, y1) => { for (let k = 0; k < 7; k++) { const s = k / 7; pts.push([lerp(x0, x1, s) + (r() - 0.5) * 2 * jag, lerp(y0, y1, s) + (r() - 0.5) * 2 * jag]); } };
    edge(0, 0, S, 0); edge(S, 0, S, S); edge(S, S, 0, S); edge(0, S, 0, 0);
    let d = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${f3(x)},${f3(y)}`).join('') + 'Z';
    for (let k = 0; k < 14; k++) {
      const onEdge = r() < 0.75;
      const rad = S * (onEdge ? 0.012 + r() * 0.028 : 0.006 + r() * 0.012);
      const mm = rad * 1.1 + jag;
      let x; let y;
      if (onEdge) { const e = Math.floor(r() * 4); const s = mm + r() * (S - 2 * mm); const ins = mm + r() * S * 0.04; [x, y] = [[s, ins], [S - ins, s], [s, S - ins], [ins, s]][e]; } else { x = S * (0.15 + r() * 0.7); y = S * (0.15 + r() * 0.7); }
      d += `M${f3(x + rad)},${f3(y)}A${f3(rad)},${f3(rad)} 0 1 0 ${f3(x - rad)},${f3(y)}A${f3(rad)},${f3(rad)} 0 1 0 ${f3(x + rad)},${f3(y)}Z`;
    }
    const sealInk = lum(C.accent) > 0.5 ? mix(C.bg, '#000000', darkBg ? 0.15 : 0.0) : mix(C.fill2, '#FFFFFF', 0.25);
    const sealBody = (!darkBg || transparent || lum(C.accent) < 0.5) ? C.accent : C.accent;
    const rect = el('path', { d, fill: sealBody, 'fill-rule': 'evenodd' }, gS);
    // 印章字用主字体那条链（不用 meta.paramFonts 另指字体：印章留空时底座给那款字体做出的子集是空的，浏览器拒绝解码，导出挂载失败）
    const sealFamily = family;
    const sm = makeMeasurer(sealFamily);
    const n = sealChars.length;
    const padIn = S * 0.13; const inner = S - padIn * 2;
    const cells = n === 1 ? [[0, 0, 1, 1]] : n === 2 ? [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]
      : n === 3 ? [[0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.5, 1]] : [[0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5]];
    const texts = sealChars.map((ch, k) => {
      const [cx, cy, cw, chh] = cells[k];
      const cellW = cw * inner; const cellH = chh * inner;
      const b0 = sm(ch);
      const sc = Math.min((cellW * 0.94) / (b0.r - b0.l), (cellH * 0.94) / (b0.b - b0.t)); // 等比，不拉宽也不拉长（硬规矩第 8 条）
      const ox = padIn + cx * inner + cellW / 2 - ((b0.l + b0.r) / 2) * sc;
      const oy = padIn + cy * inner + cellH / 2 - ((b0.t + b0.b) / 2) * sc;
      const t = el('text', { 'font-family': sealFamily, 'font-size': f3(sc), fill: sealInk, x: f3(ox), y: f3(oy) }, gS);
      t.textContent = ch;
      return t;
    });
    sealObj = { wrap, g: gS, rect, texts, x: seal.x, y: seal.y, S };
  }

  // ---------- 8) seek ----------
  const PUSH = 0.004 * P.push; // 每秒放大多少
  const pushFrom = sweepStart;
  function setStops(stops, list) {
    list.forEach(([o, op], k) => { stops[k].setAttribute('offset', f3(o)); stops[k].setAttribute('stop-opacity', f3(op)); });
  }

  function seek(t) {
    // 推近
    const pz = 1 + PUSH * Math.max(0, t - pushFrom);
    titleG.setAttribute('transform', PUSH > 0 ? `translate(${f3(bcx * (1 - pz))},${f3(bcy * (1 - pz))}) scale(${f3(pz)})` : '');

    // 边框
    if (frame) {
      const p = easeInOutCubic(clamp((t - frame.t0) / (frame.t1 - frame.t0)));
      for (const f of [frame.outer, frame.inner]) {
        f.r.setAttribute('stroke-dashoffset', f3(f.L * (1 - p)));
        f.r.setAttribute('visibility', p > 0.002 ? 'inherit' : 'hidden');
      }
      const q = easeOutCubic(clamp((t - frame.t1 * 0.55) / 0.35));
      for (const c of frame.corners) {
        if (q < 0.05) { c.g.setAttribute('visibility', 'hidden'); continue; }
        const s = lerp(0.6, 1, q);
        c.g.setAttribute('visibility', 'inherit');
        c.g.setAttribute('transform', `translate(${f3(c.ox * (1 - s))},${f3(c.oy * (1 - s))}) scale(${f3(s)})`);
      }
    }

    // 金粉
    if (dust.length) {
      const rg = dust.region;
      const span = rg.y1 - rg.y0 + 2 * rg.pad;
      const fadeIn = smoothstep(0, 0.5, t) * (1 - smoothstep(outroEnd - 0.1, duration, t));
      for (const d of dust) {
        const y = rg.y0 - rg.pad + (((d.y0 * span + d.v * t) % span) + span) % span;
        const x = d.x + d.sway * Math.sin(2 * Math.PI * d.sf * t + d.sp);
        const edgeFade = transparent ? smoothstep(rg.y0, rg.y0 + 0.15 * span, y) * (1 - smoothstep(rg.y1 - 0.15 * span, rg.y1, y)) : 1;
        const tw = 0.65 + 0.35 * Math.sin(2 * Math.PI * d.tw * t + d.tp);
        let op = d.base * tw * edgeFade * fadeIn;
        if (d.type === 'flake') {
          const c = Math.cos(2 * Math.PI * (d.flip / 6) * t + d.fp);
          if (Math.abs(c) < 0.15 || op < 0.02) { d.node.setAttribute('visibility', 'hidden'); continue; }
          const a = d.spin * t + d.fp;
          const ca = Math.cos(a); const sa = Math.sin(a);
          const P4 = [[d.size * c, 0], [0, d.size * 0.6], [-d.size * c, 0], [0, -d.size * 0.6]].map(([px, py]) => [x + px * ca - py * sa, y + px * sa + py * ca]);
          d.node.setAttribute('d', P4.map(([px, py], k) => `${k ? 'L' : 'M'}${f3(px)},${f3(py)}`).join('') + 'Z');
          op *= 0.55 + 0.45 * Math.abs(c);
        } else {
          if (op < 0.02) { d.node.setAttribute('visibility', 'hidden'); continue; }
          d.node.setAttribute('cx', f3(x)); d.node.setAttribute('cy', f3(y));
        }
        d.node.setAttribute('visibility', 'inherit');
        d.node.setAttribute('fill-opacity', f3(clamp(op)));
      }
    }

    // 揭开（入场）、收走（出场）
    const pIn = clamp((t - sweepStart) / sweepDur);
    const fIn = frontU(sweepEase(pIn));
    const pOut = clamp((t - outroStart) / outDur);
    const fOut = frontU(sweepEase(pOut));
    let maskOn = false;
    if (t < outroStart) {
      maskOn = fIn < 1;
      if (maskOn) wipeP.setAttribute('d', halfPlane(fIn, 'below'));
      textLayer.setAttribute('visibility', fIn > 0 ? 'inherit' : 'hidden');
    } else {
      maskOn = pOut > 0;
      if (maskOn) wipeP.setAttribute('d', halfPlane(fOut, 'above'));
      textLayer.setAttribute('visibility', fOut < 1 - 1e-6 ? 'inherit' : 'hidden');
    }
    if (maskOn) textLayer.setAttribute('clip-path', `url(#${uid}-wc)`); else textLayer.removeAttribute('clip-path');
    if (glowEl) glowEl.setAttribute('opacity', f3(lerp(0.25, 1, smoothstep(0, 1, pIn) * (1 - smoothstep(0, 1, pOut)))));

    // 高光：入场时跟着揭开的前沿走（前沿那一道最亮），停留时按 sheens 扫，出场时跟着收走的前沿
    const bands = [];
    if (t < outroStart && fIn > 0 && fIn < 1.25) bands.push({ u: fIn - 0.045, w: 0.06, peak: 1 }, { u: fIn - 0.18, w: 0.1, peak: 0.35 });
    for (const s0 of sheens) {
      if (t >= s0 && t <= s0 + sheenDur) { const u = sheenU(t, s0); bands.push({ u, w: SHEEN_W * 0.45, peak: 1 }, { u, w: SHEEN_W * 1.5, peak: 0.32 }, { u: u - 0.15, w: 0.022, peak: 0.8 }); }
    }
    if (t >= outroStart && pOut > 0 && pOut < 1) bands.push({ u: fOut + 0.045, w: 0.06, peak: 1 });
    const sheenOn = bands.some((b) => b.u + b.w > 0 && b.u - b.w < 1);
    if (sheenOn) setStops(sheenStops, bandStops(bands, NS));

    // 字面暗带浮动（像光在变）
    const drift = 0.025 * Math.sin((2 * Math.PI * t) / 3.2);
    for (const f of faces) f.stops.forEach((s, k) => { const o = f.spec[k][0]; const w = k >= 2 && k <= 5 ? drift : drift * 0.5; s.setAttribute('offset', f3(clamp(o + (k === 0 || k === f.spec.length - 1 ? 0 : w)))); });

    // 每个字：被光带扫到时从 110% 压回原大
    for (const g of glyphs) {
      const q = clamp((t - (g.tHit - 0.1)) / pressDur);
      let s = 1 + 0.1 * P.press * (1 - easeOutCubic(q));
      if (Math.abs(s - 1) < 0.0015) s = 1; // 动的量太小就当没动（几乎没动的帧，见写一个新风格第 3 节的建议）
      g.wrap.setAttribute('transform', s === 1 ? '' : `translate(${f3(g.cx * (1 - s))},${f3(g.cy * (1 - s))}) scale(${f3(s)})`);
      g.sheen.setAttribute('visibility', sheenOn ? 'inherit' : 'hidden');
    }

    // 闪光星：每一道高光（含入场那一道）经过它时亮一下，0.42 秒
    for (const gl of glints) {
      let best = 0; let q0 = 0;
      const tryAt = (tp) => { const q = (t - tp - gl.delay) / 0.5; if (q > 0 && q < 1) { const k = Math.sin(Math.PI * q); if (k > best) { best = k; q0 = q; } } };
      tryAt(tWhenFront(gl.u, sweepStart, sweepDur));
      for (const s0 of sheens) {
        // 反解：高光中心走到 u 的时刻
        let lo = 0; let hi = 1;
        for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (sheenU(s0 + m * sheenDur, s0) < gl.u) lo = m; else hi = m; }
        tryAt(s0 + lo * sheenDur);
      }
      if (t >= outroStart - 0.05) best = 0;
      const sc = best;
      if (sc < 0.2) { gl.gg.setAttribute('visibility', 'hidden'); continue; }
      gl.gg.setAttribute('visibility', 'inherit');
      gl.gg.setAttribute('transform', `translate(${f3(gl.x)},${f3(gl.y)}) rotate(${f3(gl.spin * q0)}) scale(${f3(sc)})`);
    }

    // 印章：从 130% 盖到 100%（越落越快），出场时跟标题一起被光带收走
    if (sealObj) {
      const p = clamp((t - sealT0) / (sealT1 - sealT0));
      if (p <= 0 || (t >= outroStart && fOut >= 1 - 1e-6)) sealObj.g.setAttribute('visibility', 'hidden');
      else {
        const s = lerp(1.3, 1, easeInCubic(p));
        const op = clamp(p / 0.3);
        // 推近时印章只挪位置，不跟着缩放
        const cxS = sealObj.x + sealObj.S / 2; const cyS = sealObj.y + sealObj.S / 2;
        const sx = (cxS - bcx) * (pz - 1); const sy = (cyS - bcy) * (pz - 1);
        sealObj.g.setAttribute('visibility', 'inherit');
        sealObj.g.setAttribute('transform', `translate(${f3(sealObj.x + sx + (sealObj.S * (1 - s)) / 2)},${f3(sealObj.y + sy + (sealObj.S * (1 - s)) / 2)})${s !== 1 ? ` scale(${f3(s)})` : ''}`);
        sealObj.rect.setAttribute('fill-opacity', f3(op));
        for (const tx of sealObj.texts) tx.setAttribute('fill-opacity', f3(op));
      }
      if (t >= outroStart && pOut > 0) sealObj.wrap.setAttribute('clip-path', `url(#${uid}-wc)`); else sealObj.wrap.removeAttribute('clip-path');
    }
  }

  // ---------- 9) 时间轴和排版结果 ----------
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场（光带扫出、盖章）', start: 0, end: introEnd },
      { name: 'hold', label: '停留（高光扫过）', start: introEnd, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...glyphs.map((g) => ({ t: g.tHit, name: 'stamp-char', label: `「${g.ch}」被烫出来` })),
      ...(seal ? [{ t: sealT1, name: 'seal', label: '盖章' }] : []),
      ...sheens.map((s0, k) => ({ t: s0, name: 'sheen', label: `第 ${k + 1} 道高光` })),
      { t: outroStart, name: 'exit', label: '开始出场' },
    ].sort((a, b) => a.t - b.t),
    units: glyphs.map((g) => ({ text: g.ch, line: g.li, emphasis: g.kw, start: g.tHit - 0.1, end: g.tHit - 0.1 + pressDur })),
  };
  const lineText = lineObjs.map((l) => ({ text: atoms.slice(l.a, l.b).map((a) => a.text).join(''), paragraph: atoms[l.a].paragraph, index: atoms[l.a].index, fs: l.fs, keyword: l.isKw }));
  const styleChecks = [
    { id: 'seal-overlap', level: 'warn', pass: !(seal && seal.overlap), message: !seal ? '没有印章' : seal.overlap ? '印章挪了 20 次还压着字：换短一点的标题，或者把印章调小' : '印章没有压到字' },
    { id: 'length', level: 'warn', pass: totalReal <= 12, message: totalReal > 12 ? `${totalReal} 个字，烫金标题超过 12 个字就挤了，长句建议换 002 大字报` : `${totalReal} 个字` },
    { id: 'sheens', level: 'warn', pass: sheens.length >= Math.min(P.sweeps, 1), message: `停留时高光扫过 ${sheens.length} 次（要求 ${P.sweeps} 次；停留太短时会少扫）` },
  ];
  seek(0);
  return {
    timeline,
    layout: {
      fontSize: fsBig,
      lines: lineText.map((l) => l.text),
      linesDetail: lineText.map((l) => ({ text: l.text, paragraph: l.paragraph, fontSize: +l.fs.toFixed(1), keyword: l.keyword })),
      forced,
      issues: checkLineBreaks(lineText, ctx.text, { segment: ctx.segment }),
      warnings: icuBreakWarnings(lineText, ctx.text),
      styleChecks,
      emphasis: glyphs.filter((g) => g.kw).map((g) => g.ch).join(''),
      block: [block.x0, block.y0, block.x1, block.y1].map((v) => +v.toFixed(1)),
      seal: seal ? { chars: sealChars.join(''), box: [seal.x, seal.y, seal.x + seal.side, seal.y + seal.side].map((v) => +v.toFixed(1)) } : null,
      segmentation: ctx.segmentation && ctx.segmentation.sources,
      layoutSearch: { evaluated, cost: best ? +best.cost.toFixed(3) : null },
    },
    seek,
    destroy() { svg.remove(); },
  };
}
