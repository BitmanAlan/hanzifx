// 002 大字报（styles/002-big-poster）
//
// 风格契约见 engine/docs/写一个新风格.md：create 只按 (参数, 画面尺寸) 搭一次 SVG；seek(t) 是纯函数，
// 每次把所有会动的属性从头算一遍，结果只取决于 t。随机数一律来自 hash01(seed, …)。
//
// 这个风格的核心是排版：一段话排满画面，**每一行各自算字号，正好撑满一行的宽度**，
// 关键词（*关键词*）那一行最大，其余行字号接近，大小反差撑起版面。做法：
//   1. 按词切成「不可再拆的块」（atomize：标点粘在前后的词上，单字虚词粘到前一个词后面）；
//   2. 在块的边界上枚举所有断法（每行字数有上限），每种断法算出每行的字号和总高度；
//   3. 按「行数、孤字、关键词完整且最大、其余行字号接近、断在标点后、填满高度」打分，挑分最低的；
//   4. 总高度放不下就整体等比缩小。
// 断行检查（checkLineBreaks）用宿主给的同一个分词函数，跟排版一致。
//
// 画面分层（从下到上）：底色 → 底纹（可选）→ 关键词色块（可选）→ 斜线装饰（可选）→ 硬投影（可选）
//   → 描边（只在透明底时画，颜色＝底色）→ 字。
// 造型预设（meta.json 的 looks）只是下面几个参数的组合：scatter 错落、hardShadow 硬投影、kwBlock 关键词色块、
//   texture 底纹、slashes 斜线、impact 落地冲击、maxLines／maxChars 行数和每行字数上限。

import { hash01 } from '../../engine/src/lib/rand.js';
import { mix } from '../../engine/src/lib/color.js';
import { clamp, lerp, easeOutCubic, easeInCubic, smoothstep, spring } from '../../engine/src/lib/ease.js';
import { graphemes, atomize, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { shake, holdWeight, f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
// 「几乎没动」的帧直接取静止值：动作尾巴只差零点零几个像素时，浏览器抗锯齿会随机画成两种，乱序渲染对不上（008、012 踩过）。
// 门槛：位移不到 0.05 像素、缩放差乘尺寸不到 0.05 像素；转角另外按不到 0.02 度
const still = (v, rest, size) => (Math.abs(v - rest) * size < 0.05 ? rest : v);
const STRONG = new Set([...'。！？!?…；;']);
const WEAK = new Set([...'，、,：:']);
const LH = 1.06; // 行距：大字报要密
const TRACK = -0.02; // 字距：黑体 Black 默认偏松，大字号下收紧一点

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

/** 量字：普通字按字身宽度；全角标点按墨迹收紧（标点挤压）。在 100px 下量，用的时候按比例换算 */
function makeMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  const BASE = 100;
  g.font = `${BASE}px ${family}`;
  return function glyph(ch) {
    if (cache.has(ch)) return cache.get(ch);
    const m = g.measureText(ch);
    let box;
    if (/\s/.test(ch)) box = { left: 0, width: m.width / BASE, blank: true };
    else if (FULLWIDTH_PUNCT.has(ch)) {
      // 标点挤压到半个字宽（墨迹太宽的按墨迹加边距），墨迹靠槽位左边。挤得比半字更紧，大字号下看起来像半角标点粘在字上
      const l = -m.actualBoundingBoxLeft; const r = m.actualBoundingBoxRight;
      const pad = 0.08 * BASE;
      const w = Math.max(0.5 * BASE, r - l + 2 * pad);
      box = { left: (l - pad) / BASE, width: w / BASE, punct: true };
    } else box = { left: 0, width: m.width / BASE };
    box.ascent = m.fontBoundingBoxAscent / BASE;
    box.descent = m.fontBoundingBoxDescent / BASE;
    cache.set(ch, box);
    return box;
  };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const cvOf = (a) => { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; const v = a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length; return Math.sqrt(v) / m; };

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const family = ctx.fontFamily(P.font);
  const glyph = makeMeasurer(family);
  const scatter = P.scatter ?? 0;
  const impact = P.impact ?? 0.3;
  // 透明底：用户传了 transparent，或者底座说现在是透明背景（导出透明素材、跑检查、试玩台棋盘格）
  const transparent = !!P.transparent || ctx.transparent === true;
  const maxLines = P.maxLines ?? 7;
  const maxChars = P.maxChars ?? 9;

  // ---------- 文字 → 块 ----------
  const paragraphs = String(ctx.text).replace(/\r/g, '').split('\n').map((p) => p.trim());
  const atoms = [];
  paragraphs.forEach((p, pi) => {
    if (!p) return;
    const as = atomize(p, { segment: ctx.segment });
    as.forEach((a, ai) => {
      const gs = a.graphemes;
      let off = a.index; let real = 0; let kw = 0; const chars = [];
      for (const g of gs) {
        const b = glyph(g);
        const isKw = !b.punct && !b.blank && ctx.isEmphasis(pi, off);
        chars.push({ ch: g, off, box: b, kw: isKw });
        if (!b.punct && !b.blank) { real++; if (isKw) kw++; }
        off += g.length;
      }
      const w = chars.reduce((s, c) => s + c.box.width + TRACK, 0);
      const last = gs[gs.length - 1];
      atoms.push({
        text: a.text, index: a.index, paragraph: pi, chars, w, real,
        kw: real > 0 && kw * 2 >= real, // 一半以上是关键词就算关键词块
        endPara: ai === as.length - 1,
        breakBonus: STRONG.has(last) ? 0.5 : WEAK.has(last) ? 0.3 : 0,
      });
    });
  });
  const hasKw = atoms.some((a) => a.kw);
  const totalReal = atoms.reduce((s, a) => s + a.real, 0);

  // ---------- 排版区域 ----------
  const vertical = H > W;
  const top0 = 0.08 * H; // 上边留白
  const bottom0 = vertical ? (1 - 0.2) * H : 0.92 * H; // 竖屏避开底部 20% 遮挡区（safeArea.bottom）
  const Hmax = (bottom0 - top0) * 0.94;
  const sideMargin = 0.08 * W;
  // 每个字号外扩多少：入场冲过头、错落的倾斜和大小起伏、硬投影
  const allowK = 0.06 + 0.05 * scatter + (P.hardShadow ? 0.07 : 0);
  // 单行字号上限：两三个字的关键词不至于大到失控；横屏高度少，上限还要受可用高度限制，不然关键词单独一行就装不下
  const capPx = Math.min(0.36 * short, 0.36 * Hmax);
  // 有关键词时，普通行的上限是关键词上限的 0.75 倍：短到会顶格的普通行（「我总结了」）不至于跟关键词一样大
  const lineFs = (nat, isKw) => Math.min((W - 2 * sideMargin) / (nat + 2 * allowK), hasKw && !isKw ? 0.75 * capPx : capPx);

  // ---------- 枚举断法 ----------
  const evalCap = 60000;
  let evaluated = 0;
  let best = null;
  // 行数目标只是次要参考：竖屏每行 4 个字左右、其他画幅 6 个字左右；主要靠「填满高度」来选
  const tgtLines = clamp(Math.round(totalReal / (vertical ? 4 : 6)), 3, maxLines);

  function score(lines) {
    // lines: [[起始块, 结束块（不含）], …]
    const info = lines.map(([a, b]) => {
      let nat = 0; let real = 0; let kwReal = 0; let kwAtoms = 0;
      for (let i = a; i < b; i++) { nat += atoms[i].w; real += atoms[i].real; if (atoms[i].kw) { kwAtoms++; kwReal += atoms[i].real; } }
      nat -= TRACK; // 最后一个字后面不加字距
      const isKw = kwReal > 0 && kwReal * 2 >= real;
      const fs = lineFs(nat, isKw);
      return { a, b, nat, real, kwReal, kwAtoms, fs, capped: fs >= (hasKw && !isKw ? 0.75 : 1) * capPx - 1e-6, isKw };
    });
    const k = info.length;
    let cost = 0.25 * Math.abs(k - tgtLines);
    if (k < 3 && totalReal >= 6) cost += 3;
    const hsum = info.reduce((s, l) => s + l.fs * LH, 0);
    const scale = hsum > Hmax ? Hmax / hsum : 1;
    for (const l of info) {
      if (l.real <= 1 && totalReal > 1) cost += 6; // 孤字
      if (l.capped) cost += 0.4; // 没撑满宽度
      if (!l.isKw && l.real <= 2 && totalReal > 4) cost += 1.5; // 普通行只有一两个字（「是把」「它当」），读起来断在意思中间
      if (hasKw && l.kwReal > 0 && !l.isKw) cost += 2.5; // 关键词跟普通字挤在一行，而且不占多数
      if (hasKw && l.isKw) cost += 0.5 * (l.real - l.kwReal); // 关键词行里混了普通字
    }
    // 关键词被拆到两行
    for (let i = 1; i < atoms.length; i++) {
      if (atoms[i].kw && atoms[i - 1].kw && atoms[i].paragraph === atoms[i - 1].paragraph) {
        if (lines.some(([a]) => a === i)) cost += 5;
      }
    }
    const kwL = info.filter((l) => l.isKw); const otL = info.filter((l) => !l.isKw);
    if (hasKw && !kwL.length) cost += 3; // 标了关键词，却没有一行是关键词行（横屏最容易这样）
    if (hasKw && kwL.length && otL.length) {
      const fK = Math.min(...kwL.map((l) => l.fs)); const fO = Math.max(...otL.map((l) => l.fs));
      // 普通行比关键词还大：重罚，接近硬性规定。跟关键词一样大可以接受（字数一样、各自撑满时必然一样大），关键词靠颜色或色块区分
      if (fO > 1.02 * fK) cost += 12 * (fO / fK - 1);
      cost += 1.2 * Math.abs(Math.log(median(kwL.map((l) => l.fs)) / median(otL.map((l) => l.fs)) / 1.8)); // 大中字号比靠近 1.8
      cost += 2.5 * cvOf(otL.map((l) => l.fs)); // 其余行字号要接近
    } else {
      cost += 1.5 * cvOf(info.map((l) => l.fs));
    }
    for (let j = 1; j < k; j++) {
      cost -= atoms[info[j].a - 1].breakBonus; // 断在标点后面加分
      // 断点两边都是单字词（「是把它｜当」）：分词上没断错，读起来却断在意思中间
      const prev = atoms[info[j].a - 1]; const next = atoms[info[j].a];
      if (prev.real === 1 && next.real === 1 && !prev.breakBonus) cost += 1.5;
    }
    // 大字报要满：字块高度至少填到可用高度的 82%，填得越满越好
    const fill = (hsum * scale) / Hmax;
    if (fill < 0.82) cost += (0.82 - fill) * 8;
    if (scale < 1) cost += (1 - scale) * 3; // 要整体缩小，行就撑不满了
    return { cost, info, scale };
  }

  function walk(i, lines) {
    if (evaluated >= evalCap) return;
    if (i >= atoms.length) {
      evaluated++;
      const r = score(lines);
      if (!best || r.cost < best.cost - 1e-9) best = r;
      return;
    }
    if (lines.length >= maxLines) return;
    let real = 0;
    for (let j = i; j < atoms.length; j++) {
      real += atoms[j].real;
      const single = j === i;
      if (real > maxChars && !single) break; // 一行字数超上限（单个块本身就超的除外，只能自己占一行）
      const mustBreak = atoms[j].endPara;
      lines.push([i, j + 1]);
      walk(j + 1, lines);
      lines.pop();
      if (mustBreak) break; // 段落结尾必须换行
    }
  }
  if (atoms.length) walk(0, []);
  if (!best && atoms.length) {
    // 行数上限内排不下（字太多）：每行塞满 maxChars 个字，硬排，交给检查报出来
    const lines = []; let a = 0; let real = 0;
    atoms.forEach((at, i) => {
      if (i > a && (real + at.real > maxChars || atoms[i - 1].endPara)) { lines.push([a, i]); a = i; real = 0; }
      real += at.real;
    });
    lines.push([a, atoms.length]);
    best = score(lines);
  }

  // ---------- 落位：每行的字号、每个字的位置 ----------
  const lines = best ? best.info.map((l) => ({ ...l, fs: l.fs * best.scale })) : [];
  const blockH = lines.reduce((s, l) => s + l.fs * LH, 0);
  const autoCy = (top0 + bottom0) / 2;
  const cy = P.y != null ? clamp(P.y * H, top0 + blockH / 2, bottom0 - blockH / 2) : autoCy;
  let yCursor = cy - blockH / 2;
  const units = [];
  const lineObjs = [];
  lines.forEach((l, li) => {
    const fs = l.fs;
    const chars = [];
    for (let i = l.a; i < l.b; i++) chars.push(...atoms[i].chars);
    const width = (l.nat) * fs;
    let x = W / 2 - width / 2;
    const yMid = yCursor + (fs * LH) / 2;
    yCursor += fs * LH;
    const first = atoms[l.a];
    const text = atoms.slice(l.a, l.b).map((a) => a.text).join('');
    lineObjs.push({ text, index: first.index, paragraph: first.paragraph, fs, isKw: l.isKw });
    chars.forEach((c, ci) => {
      const wPx = c.box.width * fs;
      if (!c.box.blank) {
        units.push({
          ch: c.ch, line: li, ci, kw: c.kw, fs,
          x: x + wPx / 2, y: yMid,
          ox: -(c.box.left * fs + wPx / 2), oy: ((c.box.ascent - c.box.descent) / 2) * fs,
          w: wPx,
        });
      }
      x += wPx + TRACK * fs;
    });
  });
  const n = units.length;

  // ---------- 时间轴 ----------
  // 入场顺序：普通行从上到下，关键词行最后（没有关键词就从上到下）
  const order = lineObjs.map((l, i) => i).sort((a, b) => (lineObjs[a].isKw - lineObjs[b].isKw) || a - b);
  const lineStart = new Array(lineObjs.length);
  order.forEach((li, k) => { lineStart[li] = k * R.lineStagger; });
  const charCount = lineObjs.map((_, li) => units.filter((u) => u.line === li).length);
  units.forEach((u, i) => {
    u.i = i;
    u.t0 = lineStart[u.line] + u.ci * R.charStagger;
    u.t1 = u.t0 + R.lineDur;
    u.over = lerp(0.03, 0.07, hash01(seed, 'ov', u.line, u.ci)); // 每个字冲过头的幅度不一样
    // 错落：落地后保留的倾斜和大小起伏（V3）
    u.rotF = scatter * (hash01(seed, 'rot', u.line, u.ci) - 0.5) * 6;
    u.sF = 1 + scatter * (hash01(seed, 'sc', u.line, u.ci) - 0.5) * 0.1;
    u.rot0 = (hash01(seed, 'rot0', u.line, u.ci) - 0.5) * lerp(0, 22, scatter); // 入场时的起始倾斜
    u.phase = hash01(seed, 'ph', u.line, u.ci) * 6.283;
  });
  const lineLand = lineObjs.map((_, li) => lineStart[li] + Math.max(0, charCount[li] - 1) * R.charStagger + R.lineDur);
  const lastLand = Math.max(0, ...lineLand);
  // 入场段算到画面静下来为止：落地后的回弹和抖动约 0.3 秒，斜线弹出来要 0.6 秒。海报帧取这一刻，才是完整的样子
  const hasSlashes = !!P.slashes && lineObjs.some((l) => l.isKw);
  const introEnd = lastLand + (hasSlashes ? 0.6 : 0.3);
  const holdDur = P.hold ?? Math.max(2.0, totalReal / 6);
  const outroStart = introEnd + holdDur;
  const outroEnd = outroStart + R.outDur;
  // 出场：逐字缩没，从上往下依次走；整块同时往上推。不用整组透明度——Chrome 局部重画时，整组半透明加硬投影加底纹，
  // 乱序渲染会跟顺序渲染差几个像素（实测过）
  const exitDur = 0.5 * R.outDur;
  const exitStagger = n > 1 ? (0.5 * R.outDur) / (n - 1) : 0;
  [...units].sort((a, b) => a.line - b.line || a.ci - b.ci).forEach((u, rank) => {
    u.x0 = outroStart + rank * exitStagger;
    u.xRot = (hash01(seed, 'xr', u.line, u.ci) - 0.5) * 30;
  });
  const duration = outroEnd + 0.1;
  const kwLines = lineObjs.map((l, i) => (l.isKw ? i : -1)).filter((i) => i >= 0);
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: introEnd },
      { name: 'hold', label: '停留', start: introEnd, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...lineObjs.map((l, li) => ({ t: lineLand[li], name: l.isKw ? 'land-keyword' : 'land-line', line: li, label: `第 ${li + 1} 行落地${l.isKw ? '（关键词）' : ''}` })),
      { t: lastLand, name: 'land-all', label: '全部落地' },
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: units.map((u) => ({ i: u.i, char: u.ch, line: u.line, emphasis: u.kw, enter: u.t0, land: u.t1, exitStart: u.x0, exitEnd: u.x0 + exitDur })),
  };

  // ---------- 搭 SVG ----------
  // id 前缀：底座给的 ctx.uid（画廊一页放几个预览时 id 不会撞），旧底座没有就自己算一个
  const uid = ctx.uid ? `${ctx.uid}-bp` : 'bp' + Math.floor(hash01(seed, ctx.text, W, H) * 1e9).toString(36);
  const svg = el('svg', {
    xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`,
    style: 'position:absolute;left:0;top:0;overflow:visible', 'data-hanzifx-style': 'big-poster',
  });
  const defs = el('defs', {}, svg);
  if (!transparent) {
    el('rect', { x: 0, y: 0, width: W, height: H, fill: K.bg, 'data-layer': 'bg' }, svg);
    if (P.texture) {
      // 网点底纹：固定的点阵，每个点的大小用种子取，静态，不闪
      const step = Math.max(6, Math.round(short / 90));
      const pat = el('pattern', { id: `${uid}-dots`, patternUnits: 'userSpaceOnUse', width: step * 4, height: step * 4 }, defs);
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          const r = step * lerp(0.12, 0.3, hash01(seed, 'dot', a, b));
          el('circle', { cx: f3((a + 0.5) * step), cy: f3((b + 0.5) * step), r: f3(r), fill: mix(K.bg, K.fill, 0.5) }, pat);
        }
      }
      el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${uid}-dots)`, opacity: 0.12, 'data-layer': 'texture' }, svg);
    }
  }
  const block = el('g', {}, svg);
  const gBlocks = el('g', { 'data-layer': 'kw-block' }, block);
  const gDeco = el('g', { 'data-layer': 'deco' }, block);
  const gShadow = P.hardShadow ? el('g', { 'data-layer': 'shadow' }, block) : null;
  const gOutline = transparent ? el('g', { 'data-layer': 'outline' }, block) : null;
  const gFill = el('g', { 'data-layer': 'fill' }, block);

  // 关键词色块：每行里连续的关键词一块
  const kwSpans = [];
  if (P.kwBlock) {
    lineObjs.forEach((l, li) => {
      let cur = null;
      for (const u of units.filter((v) => v.line === li)) {
        if (u.kw) {
          if (cur) { cur.x1 = u.x + u.w / 2; cur.last = u; } else { cur = { li, x0: u.x - u.w / 2, x1: u.x + u.w / 2, y: u.y, fs: u.fs, first: u, last: u }; }
        } else if (cur) { kwSpans.push(cur); cur = null; }
      }
      if (cur) kwSpans.push(cur);
    });
  }
  kwSpans.forEach((s) => {
    const pad = 0.06 * s.fs;
    s.rect = el('rect', { x: f3(s.x0 - pad), y: f3(s.y - 0.52 * s.fs), height: f3(1.04 * s.fs), width: f3(s.x1 - s.x0 + 2 * pad), fill: K.accent, rx: f3(0.03 * s.fs) }, gBlocks);
    s.full = s.x1 - s.x0 + 2 * pad;
    s.start = s.first.t0 - 0.12; // 色块先刷出来，字再砸进去
    // 色块里的字换成「色块上的字」颜色
    for (const u of units) if (u.line === s.li && u.x >= s.x0 && u.x <= s.x1) u.onBlock = true;
  });

  // 斜线装饰：关键词行左右两侧各两道
  const slashes = [];
  if (P.slashes && kwLines.length) {
    const li = kwLines[0];
    const lu = units.filter((u) => u.line === li);
    if (lu.length) {
      const fs = lineObjs[li].fs;
      const left = lu[0].x - lu[0].w / 2; const right = lu[lu.length - 1].x + lu[lu.length - 1].w / 2;
      // 放在关键词行左右两侧、行中间偏上，往外斜；不往上伸，免得压到上一行
      const len = Math.min(0.2 * fs, 0.06 * W); const sw = Math.max(0.05 * fs, 0.012 * short);
      const yMid = lu[0].y - 0.12 * fs;
      [[left, -1], [right, 1]].forEach(([x, dir], side) => {
        const g = el('g', {}, gDeco);
        for (let k = 0; k < 2; k++) {
          const oy = k * 0.55 * len;
          el('path', { d: `M0,${f3(oy - 0.3 * len)} L${f3(dir * len)},${f3(oy - 0.3 * len - 0.45 * len)}`, stroke: K.accent, 'stroke-width': f3(sw), 'stroke-linecap': 'round', fill: 'none' }, g);
        }
        const px = dir < 0 ? Math.max(x - 0.04 * fs, len + sw + 0.01 * W) : Math.min(x + 0.04 * fs, W - len - sw - 0.01 * W);
        slashes.push({ g, x: px, y: yMid, side, land: lineLand[li], size: 1.5 * len + sw });
      });
    }
  }

  const textAttrs = (fs) => ({ 'font-family': family, 'font-size': f3(fs), 'text-rendering': 'geometricPrecision' });
  units.forEach((u) => {
    const color = u.onBlock ? K.inner : u.kw ? K.accent : K.fill;
    const mk = (parent, attrs) => { const t = el('text', { ...textAttrs(u.fs), x: f3(u.ox), y: f3(u.oy), ...attrs, 'data-unit': u.i }, parent); t.textContent = u.ch; return t; };
    u.nodes = [];
    if (gShadow) { u.shadow = mk(gShadow, { fill: K.shadow }); u.nodes.push(u.shadow); }
    // 透明底的描边：色块上的字不描（色块本身就是对比，描了反而跟字同色糊成一团）
    if (gOutline && !u.onBlock) u.nodes.push(mk(gOutline, { fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.12 * u.fs), 'stroke-linejoin': 'round' }));
    u.nodes.push(mk(gFill, { fill: color }));
  });
  root.appendChild(svg);

  // ---------- 动作（纯函数） ----------
  function unitState(u, t) {
    if (t < u.t0) return null;
    const p = clamp((t - u.t0) / R.lineDur);
    const e = easeOutCubic(p);
    // 从大往下砸：起点 115%（错落时更大），每个字冲过头的幅度不同；落地后轻轻回弹一下
    const s0 = 1 + 0.15 + u.over + 0.4 * scatter;
    let s = lerp(s0, u.sF, e);
    if (t > u.t1) s *= 1 - 0.03 * Math.exp(-(t - u.t1) * 14) * Math.sin((t - u.t1) * 34);
    s = still(s, u.sF, u.fs); // 落地缓动的尾巴、回弹的衰减尾巴（约 0.3 秒）：缩放差乘字号不到 0.05 像素就取落定值
    let rot = lerp(u.rot0, u.rotF, e);
    if (Math.abs(rot - u.rotF) < 0.02) rot = u.rotF;
    // 停留：只有关键词呼吸（刚起步、快收住时幅度太小的帧当成没呼吸）
    if (u.kw) { const b = 0.015 * Math.sin(2 * Math.PI * 1.2 * (t - u.t1) + u.phase) * holdWeight(t, u.t1, outroStart); if (Math.abs(b) * s * u.fs >= 0.05) s *= 1 + b; }
    if (t >= u.x0) {
      const k = still(easeInCubic(clamp((t - u.x0) / exitDur)), 0, s * u.fs);
      if (k >= 1) return null;
      s *= 1 - k; rot += k * u.xRot;
    }
    const op = clamp(p * 4);
    return { s, rot, op };
  }

  function seek(t) {
    // 整块：关键词行落地时震一下（V3 每行都震）；出场时往上推并淡出
    let dx = 0; let dy = 0;
    lineObjs.forEach((l, li) => {
      const strong = l.isKw;
      if (!strong && impact < 0.5) return;
      const amp = (strong ? 0.012 : 0.006) * short * impact * (strong ? 1 : 1);
      const dur = strong ? lerp(0.1, 0.14, impact) : 0.07;
      const m = shake(t, { start: lineLand[li], amplitude: amp, duration: dur, freq: 30, seed: seed + li, rotate: 0 });
      dx += m.dx; dy += m.dy;
    });
    const q = clamp((t - outroStart) / R.outDur);
    const outY = -0.06 * H * easeInCubic(q);
    dx = still(dx, 0, 1); dy = still(dy, 0, 1); // 震动收尾只挪零点零几个像素的帧当成没震
    block.setAttribute('transform', `translate(${f3(dx)},${f3(dy + outY)})`);
    block.setAttribute('visibility', q >= 1 ? 'hidden' : 'visible');

    for (const u of units) {
      const st = unitState(u, t);
      for (const node of u.nodes) {
        if (!st) { node.setAttribute('visibility', 'hidden'); continue; }
        node.setAttribute('visibility', 'visible');
        const off = node === u.shadow ? 0.06 * u.fs : 0;
        node.setAttribute('transform', `translate(${f3(u.x + off)},${f3(u.y + off)}) rotate(${f3(st.rot)}) scale(${f3(st.s)})`);
        node.setAttribute('opacity', f3(st.op));
      }
    }
    for (const s of kwSpans) {
      const xk = easeInCubic(clamp((t - s.first.x0) / exitDur)); // 出场时色块跟着第一个字一起收掉
      const k = still(easeOutCubic(clamp((t - s.start) / 0.12)), 1, s.full) * (1 - xk);
      s.rect.setAttribute('visibility', k > 0 ? 'visible' : 'hidden');
      s.rect.setAttribute('width', f3(Math.max(0.001, s.full * k)));
    }
    for (const sl of slashes) {
      const k = still(Math.max(0, spring(t - sl.land, { freq: 2.6, damping: 0.5 })) * (1 - easeInCubic(clamp((t - outroStart) / exitDur))), 1, sl.size); // 弹簧的尾巴：缩放差乘斜线大小不到 0.05 像素就取 1
      sl.g.setAttribute('visibility', k > 1e-3 ? 'visible' : 'hidden');
      sl.g.setAttribute('transform', `translate(${f3(sl.x)},${f3(sl.y)}) scale(${f3(Math.max(k, 1e-3))})`);
    }
  }

  return {
    timeline,
    layout: {
      fontSize: lineObjs.length ? Math.max(...lineObjs.map((l) => l.fs)) : 0,
      lines: lineObjs.map((l) => l.text),
      linesDetail: lineObjs.map((l) => ({ text: l.text, index: l.index, paragraph: l.paragraph, fontSize: l.fs, keyword: l.isKw })),
      forced: [],
      issues: checkLineBreaks(lineObjs, ctx.text, { segment: ctx.segment }),
      warnings: icuBreakWarnings(lineObjs, ctx.text),
      segmentation: ctx.segmentation.sources,
      emphasis: units.filter((u) => u.kw).map((u) => u.ch).join(''),
      units: n,
      layoutSearch: { evaluated, cost: best ? +best.cost.toFixed(3) : null, scale: best ? +best.scale.toFixed(3) : 1 },
    },
    seek,
    destroy() { svg.remove(); },
  };
}
