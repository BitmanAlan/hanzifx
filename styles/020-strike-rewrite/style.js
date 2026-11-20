// 020 划掉改字（Strike & Rewrite）· 字效（styles/020-strike-rewrite）
//
// 一句话出来，其中一个词被一笔划掉，改过的词写在它上方，或者紧跟在它后面砸进来。
// 输入写法（写进 text 参数，跟全库的 | 和 *…* 共用一套）：
//   ~~旧词~~*新词*     划掉「旧词」，改成「新词」（两个标记之间可以空一格）
//   ~~旧词~~           只划掉、不改
//   *关键词*           不跟在 ~~ 后面的 *…* 照旧是关键词（换颜色，有纸底时画荧光笔）
//   |                  照旧是作者手标的切分点；\n 分段
// 宿主把 | 和 * 去掉以后给 ctx.text（~~ 还在），*…* 的位置用 ctx.isEmphasis(段号, 下标) 查。
// 排版：划掉的词连同它的新词当成一个不可拆的块（按宿主给的分词合并），断行只在块的边上断。
//
// 契约（engine/docs/写一个新风格.md）：create 只按参数和画面尺寸搭一次 SVG；seek(t) 是纯函数，
// 每次把会动的属性从头算一遍；随机全走 hash01 / noise1。逐帧一致的硬规矩：
//   图层 <g> 只当容器，不加透明度、不加变换；透明度、位移、缩放全写在每个元素自己身上；
//   不用模糊滤镜（投影全是不模糊的硬投影）；文字只做等比缩放；
//   缓动两头「几乎没动」的帧直接取停住时的值（snap），显示用 inherit、隐藏用 hidden。
//
// 画面分层（从下到上）：纸（整屏或卡片：硬投影、纸、横线、页边线、胶带）→ 荧光笔（关键词）
//   → 正文描边 → 正文 → 划线（墨边 + 笔迹）→ 新词描边 → 新词 → 圈、感叹号（V3）。

import { hash01, noise1 } from '../../engine/src/lib/rand.js';
import { mix, hexToRgb } from '../../engine/src/lib/color.js';
import { clamp, lerp, easeOutCubic, easeInCubic, smoothstep, spring, springFirstCross } from '../../engine/src/lib/ease.js';
import { graphemes, bestBreak, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { shake, f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const CLOSE_P = new Set([...'，。、；：」』）》】〕〉〗”’']);
const OPEN_P = new Set([...'「『（《【〔〈〖“‘']);
const LH = 1.3; // 行距（字号的倍数）
const RW_ABOVE = 0.74; // 写在上方的新词字号（正文字号的倍数）
const INL = 1.06; // 跟在后面的新词字号
const GAP_INL = 0.16; // 跟在后面的新词前面空多少（字号）
const DEG = Math.PI / 180;
const POP = { freq: 2.9, damping: 0.42 }; // 新词砸进来的弹簧
const POP_LAND = springFirstCross(POP);
const POP_END = 0.85; // 弹簧到这里一律取停住时的值
const BOIL_RATE = 8; // 停留时笔迹每秒抖几次（手绘动画的抖线）

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const show = (e, on) => e.setAttribute('visibility', on ? 'inherit' : 'hidden');
const lum = (hex) => { const [r, g, b] = hexToRgb(hex).map((v) => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

/** 量字：在 100px 下量一次，用的时候按字号换算。adv 字身宽，l / r 墨迹左右（相对字的原点） */
function makeGlyph(family) {
  const g = document.createElement('canvas').getContext('2d');
  g.font = `100px ${family}`;
  const cache = new Map();
  return (ch) => {
    if (cache.has(ch)) return cache.get(ch);
    const m = g.measureText(ch);
    const b = {
      adv: m.width / 100, l: -m.actualBoundingBoxLeft / 100, r: m.actualBoundingBoxRight / 100,
      asc: m.fontBoundingBoxAscent / 100, desc: m.fontBoundingBoxDescent / 100,
      blank: /^\s+$/.test(ch), punct: FULLWIDTH_PUNCT.has(ch),
    };
    cache.set(ch, b);
    return b;
  };
}

/**
 * 解析一段里的划改标记。para：这一段（宿主已去掉 | 和 *，~~ 还在）；isEmph(i)：第 i 个下标是不是 *…* 里的字。
 * 返回 { chars:[{ch,i,kind,group,emph}], groups:[{struck:[k],rewrite:[k],start,end}], unclosed }
 * kind：text 普通字、struck 划掉的字、rewrite 新词、marker 标记本身（不显示）、gap 标记和新词之间的空格（不显示）
 */
export function parseStrikes(para, isEmph) {
  const chars = []; let off = 0;
  for (const g of graphemes(para)) { chars.push({ ch: g, i: off, kind: 'text', group: -1, emph: !!isEmph(off) }); off += g.length; }
  const groups = [];
  let open = null; let unclosed = false;
  const isMark = (k) => chars[k] && chars[k].ch === '~' && chars[k + 1] && chars[k + 1].ch === '~';
  for (let k = 0; k < chars.length; k++) {
    if (isMark(k)) {
      chars[k].kind = 'marker'; chars[k + 1].kind = 'marker';
      if (!open) { open = { start: chars[k].i, struck: [] }; k++; continue; }
      // 收尾的 ~~：后面（可以隔着空格）紧跟 *…* 就是新词
      let end = chars[k + 1].i + 1;
      const g = { struck: open.struck, rewrite: [], start: open.start, end };
      let j = k + 2;
      while (chars[j] && /^\s+$/.test(chars[j].ch)) j++;
      if (chars[j] && chars[j].emph && !isMark(j)) {
        for (let s = k + 2; s < j; s++) chars[s].kind = 'gap';
        while (chars[j] && chars[j].emph && !isMark(j)) { chars[j].kind = 'rewrite'; g.rewrite.push(j); j++; }
        g.end = chars[j - 1].i + chars[j - 1].ch.length;
        k = j - 1;
      } else k++;
      if (g.struck.some((s) => !/^\s+$/.test(chars[s].ch))) groups.push(g);
      else for (const s of g.struck) chars[s].kind = 'text';
      open = null;
      continue;
    }
    if (open) { chars[k].kind = 'struck'; open.struck.push(k); }
  }
  if (open) { // 没闭合：照宿主处理 *…* 的办法，划到这一段结尾
    unclosed = true;
    if (open.struck.length) groups.push({ struck: open.struck, rewrite: [], start: open.start, end: para.length });
  }
  groups.forEach((g, gi) => { for (const k of [...g.struck, ...g.rewrite]) chars[k].group = gi; });
  return { chars, groups, unclosed };
}

/** 宿主的分词 → 划改块合成一个词（块里不许断行）；中间缺的（作者切分丢掉的空白）补上，保证首尾相接 */
function mergedWords(para, words, groups) {
  const out = []; let cur = 0;
  const gOf = (a, b) => groups.findIndex((g) => a < g.end && b > g.start);
  for (const w of words) {
    if (w.index > cur) out.push({ index: cur, end: w.index, g: -1 });
    const a = Math.max(w.index, cur); const b = w.index + w.text.length;
    if (b <= a) continue;
    const g = gOf(a, b); const prev = out[out.length - 1];
    if (g >= 0 && prev && prev.g === g) prev.end = b;
    else out.push({ index: a, end: b, g });
    cur = b;
  }
  if (cur < para.length) out.push({ index: cur, end: para.length, g: -1 });
  return out.map((w) => ({ text: para.slice(w.index, w.end), index: w.index }));
}

/** 笔速曲线：落笔慢、中段快、收笔略缓。返回 q(τ)（走过的路程占比）和它的反函数 */
function penCurve() {
  const N = 96; const cum = [0];
  const v = (x) => 0.22 + 1.5 * smoothstep(0.02, 0.32, x) - 0.38 * smoothstep(0.8, 1, x);
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + v((i - 0.5) / N));
  const tot = cum[N];
  const q = (tau) => { const x = clamp(tau) * N; const i = Math.min(N - 1, Math.floor(x)); return (cum[i] + (cum[i + 1] - cum[i]) * (x - i)) / tot; };
  const inv = (s) => { let lo = 0; let hi = 1; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (q(m) < s) lo = m; else hi = m; } return hi; };
  return { q, inv };
}

/** 笔迹轮廓：中心线 pts、每点宽度 wid，画到总长的 q 为止，两头圆头。返回 path 的 d（没东西返回空串） */
function penOutline(pts, wid, q) {
  const n = pts.length;
  if (n < 2 || q <= 0) return '';
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const target = clamp(q) * cum[n - 1];
  const P = []; const Wd = [];
  let k = 0;
  while (k < n - 1 && cum[k + 1] <= target) k++;
  for (let i = 0; i <= k; i++) { P.push(pts[i]); Wd.push(wid[i]); }
  if (k < n - 1 && target > cum[k] + 1e-6) {
    const f = (target - cum[k]) / (cum[k + 1] - cum[k]);
    P.push({ x: lerp(pts[k].x, pts[k + 1].x, f), y: lerp(pts[k].y, pts[k + 1].y, f) });
    Wd.push(lerp(wid[k], wid[k + 1], f));
  }
  if (P.length < 2 || target < 0.35 * wid[0]) {
    // 落笔的一点：从小圆点长出来
    const r = Math.max(0.5, 0.5 * wid[0] * clamp(0.4 + target / (0.35 * wid[0] + 1e-6) * 0.6));
    const c = pts[0];
    return `M${f3(c.x - r)},${f3(c.y)}a${f3(r)},${f3(r)} 0 1,0 ${f3(2 * r)},0a${f3(r)},${f3(r)} 0 1,0 ${f3(-2 * r)},0Z`;
  }
  const m = P.length; const L = []; const Rr = [];
  for (let i = 0; i < m; i++) {
    const a = P[Math.max(0, i - 1)]; const b = P[Math.min(m - 1, i + 1)];
    let tx = b.x - a.x; let ty = b.y - a.y; const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
    const h = Wd[i] / 2;
    L.push([P[i].x - ty * h, P[i].y + tx * h]);
    Rr.push([P[i].x + ty * h, P[i].y - tx * h]);
  }
  const pt = (p) => `${f3(p[0])},${f3(p[1])}`;
  let d = `M${pt(L[0])}`;
  for (let i = 1; i < m; i++) d += `L${pt(L[i])}`;
  d += `A${f3(Wd[m - 1] / 2)},${f3(Wd[m - 1] / 2)} 0 0,0 ${pt(Rr[m - 1])}`;
  for (let i = m - 2; i >= 0; i--) d += `L${pt(Rr[i])}`;
  d += `A${f3(Wd[0] / 2)},${f3(Wd[0] / 2)} 0 0,0 ${pt(L[0])}Z`;
  return d;
}

/** 折线画到 q 为止（给用描边画的乱涂用） */
function polyPart(pts, q) {
  const n = pts.length; if (n < 2 || q <= 0) return '';
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const target = clamp(q) * cum[n - 1];
  let d = `M${f3(pts[0].x)},${f3(pts[0].y)}`;
  for (let i = 1; i < n; i++) {
    if (cum[i] <= target) { d += `L${f3(pts[i].x)},${f3(pts[i].y)}`; continue; }
    const f = (target - cum[i - 1]) / (cum[i] - cum[i - 1]);
    d += `L${f3(lerp(pts[i - 1].x, pts[i].x, f))},${f3(lerp(pts[i - 1].y, pts[i].y, f))}`;
    break;
  }
  if (target < 1) d += `L${f3(pts[0].x + 0.01)},${f3(pts[0].y)}`; // 落笔那一下也要有个圆点
  return d;
}

/** 感叹号（楔形＋圆点）和两道惊叹线，局部坐标，原点在感叹号中间；side=-1 时左右翻过来 */
function bangPath(h, side) {
  const s = side;
  const X = (x) => f3(s * x);
  const top = -0.5 * h; const bot = 0.2 * h; const a = 0.11 * h; const b = 0.035 * h;
  let d = `M${X(-a)},${f3(top)}Q${X(0)},${f3(top - 1.1 * a)} ${X(a)},${f3(top)}L${X(b)},${f3(bot)}Q${X(0)},${f3(bot + 1.3 * b)} ${X(-b)},${f3(bot)}Z`;
  const r = 0.075 * h; const cy = 0.4 * h;
  d += `M${X(-r)},${f3(cy)}a${f3(r)},${f3(r)} 0 1,0 ${f3(2 * r * s)},0a${f3(r)},${f3(r)} 0 1,0 ${f3(-2 * r * s)},0Z`;
  // 惊叹线：从里往外，里头粗、外头细
  for (const [x0, y0, x1, y1, w] of [[0.3, -0.42, 0.7, -0.68, 0.1], [0.36, -0.06, 0.78, -0.1, 0.085]]) {
    const dx = (x1 - x0) * h; const dy = (y1 - y0) * h; const len = Math.hypot(dx, dy);
    const nx = -dy / len; const ny = dx / len; const ww = w * h / 2;
    const p = (x, y) => `${X(x)},${f3(y)}`;
    d += `M${p(x0 * h + nx * ww, y0 * h + ny * ww)}L${p(x1 * h + nx * ww * 0.25, y1 * h + ny * ww * 0.25)}L${p(x1 * h - nx * ww * 0.25, y1 * h - ny * ww * 0.25)}L${p(x0 * h - nx * ww, y0 * h - ny * ww)}Z`;
  }
  return d;
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = { charStagger: 0.04, lineStagger: 0.14, charDur: 0.3, read: 0.5, strike: 0.36, rwDelay: 0.1, rwStagger: 0.075, groupGap: 0.35, outDur: 0.4, ...(P._rhythm || {}) };
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const family = ctx.fontFamily(P.font);
  const glyph = makeGlyph(family);
  const transparent = !!P.transparent || ctx.transparent === true;
  const isEmphasis = typeof ctx.isEmphasis === 'function' ? ctx.isEmphasis : () => false;
  const pen = penCurve();
  const flair = clamp(P.flair ?? 0.35);
  const boil = clamp(P.boil ?? 0);
  const strikeMode = P.strike || 'line';
  const circleOn = !!P.circle;
  const bangOn = !!P.bang;
  const pop = P.entrance === 'pop';
  const dimAmt = clamp(P.dim ?? 0.7);
  // 纸：card 卡片（透明底也画，像贴在画面上的一张便签）；page 整屏纸（透明底时不画）
  const paper = P.paper === 'page' && !transparent ? 'page' : P.paper === 'card' ? 'card' : 'none';
  const onPaper = paper !== 'none';
  const lightInk = lum(K.fill) > 0.6; // 浅色字（深色卡片、黑板）
  const h = (...k) => hash01(seed, ...k);

  // ---------- 解析 ----------
  const paraTexts = String(ctx.text ?? '').replace(/\r/g, '').split('\n').map((p) => p.trim());
  const paras = [];
  paraTexts.forEach((raw, pi) => {
    if (!raw) return;
    const pr = parseStrikes(raw, (i) => isEmphasis(pi, i));
    const words = ctx.segment(raw);
    const segWords = mergedWords(raw, words, pr.groups);
    paras.push({ pi, raw, ...pr, segWords });
  });
  const groupsAll = [];
  paras.forEach((p) => p.groups.forEach((g, gi) => {
    const sw = g.struck.reduce((s, k) => s + (p.chars[k].ch.trim() ? glyph(p.chars[k].ch).adv : 0), 0);
    const rw = g.rewrite.reduce((s, k) => s + glyph(p.chars[k].ch).adv, 0);
    const place = P.place || 'auto';
    g.mode = !g.rewrite.length ? 'none' : place === 'above' ? 'above' : place === 'inline' ? 'inline' : (rw * RW_ABOVE <= sw + 1.9 ? 'above' : 'inline');
    g.para = p; g.gi = gi; g.key = `${p.pi}.${gi}`;
    groupsAll.push(g);
  }));
  const unclosed = paras.some((p) => p.unclosed);

  // ---------- 排版：按词断行、挑最佳断法、放不下就缩字号 ----------
  const cardOn = paper === 'card';
  const side0 = (cardOn ? 0.045 : vertical ? 0.06 : 0.07) * W;
  const anyInline = groupsAll.some((g) => g.mode === 'inline');
  const sideAllow = (fs) => (cardOn ? 0.44 * fs + 0.014 * short : onPaper ? 0.06 * fs : 0.14 * fs) + (circleOn && anyInline ? 0.42 * fs : 0) + 0.01 * short * flair;
  const maxWAt = (fs) => W - 2 * (side0 + sideAllow(fs));
  const top0 = (vertical ? 0.07 : 0.08) * H;
  const bottom0 = vertical ? 0.8 * H : 0.92 * H;
  const padY = (fs) => (cardOn ? 0.5 * fs : 0.1 * fs) + (circleOn ? 0.2 * fs : 0);
  const inlScale = (pi, i) => INL * (1 + (h('rs', pi, i) - 0.5) * 0.06); // 跟在后面的新词：每个字大小略有起伏（手写感）
  const measureAt = (fs) => (text, pos) => {
    const p = paras.find((x) => x.pi === pos.paragraph);
    const a = pos.index; const b = a + text.length;
    let w = 0;
    for (const c of p.chars) {
      if (c.i < a || c.i >= b) continue;
      if (c.kind === 'marker' || c.kind === 'gap') continue;
      if (c.kind === 'rewrite') {
        const g = p.groups[c.group];
        if (g.mode !== 'inline') continue;
        if (c === p.chars[g.rewrite[0]]) w += GAP_INL * fs;
        w += glyph(c.ch).adv * fs * inlScale(p.pi, c.i);
      } else w += glyph(c.ch).adv * fs;
    }
    return w;
  };
  const aboveExtra = (fs) => RW_ABOVE * fs * 1.1 + 0.16 * fs + (circleOn ? 0.18 * fs : 0);
  const maxLinesTotal = vertical ? 5 : 3;
  function tryFit(fs, allowForced) {
    const measure = measureAt(fs); const maxW = maxWAt(fs);
    const lines = []; const forced = []; let score = 0;
    for (const p of paras) {
      const left = maxLinesTotal - lines.length;
      if (left <= 0) return null;
      const r = bestBreak(p.raw, measure, maxW, { maxLines: Math.min(3, left), segment: () => p.segWords, paragraph: p.pi });
      if (!r || (r.forced.length && !allowForced)) return null;
      r.lines.forEach((l) => lines.push({ ...l, paragraph: p.pi }));
      forced.push(...r.forced);
      score += r.score;
    }
    let hh = 0;
    lines.forEach((l, li) => {
      const p = paras.find((x) => x.pi === l.paragraph);
      if (p.groups.some((g) => g.mode === 'above' && g.start >= l.index && g.start < l.index + l.text.length)) hh += aboveExtra(fs);
      hh += fs * LH;
      if (li > 0 && lines[li - 1].paragraph !== l.paragraph) hh += 0.12 * fs;
    });
    hh += 2 * padY(fs);
    if (hh > bottom0 - top0 && !allowForced) return null;
    return { fs, lines, forced, score, height: hh };
  }
  const fs0 = clamp(P.size ?? 0.12, 0.05, 0.3) * short;
  let fit = null;
  for (let k = 0; k <= 24; k++) {
    const scale = 1 - k * 0.025;
    const r = paras.length ? tryFit(fs0 * scale, false) : { fs: fs0, lines: [], forced: [], score: 0, height: 0 };
    if (!r) continue;
    const total = r.score + 2.0 * (1 - scale);
    if (!fit || total < fit.total - 1e-12) fit = { ...r, total, scale };
  }
  if (!fit) {
    // 实在放不下（段太多、词太长）：最小字号硬排，交给检查报出来
    const r = tryFit(fs0 * 0.4, true);
    fit = r ? { ...r, total: 99, scale: 0.4 } : { fs: fs0 * 0.4, lines: paras.map((p) => ({ text: p.raw, index: 0, paragraph: p.pi })), forced: [], score: 99, total: 99, scale: 0.4 };
  }
  const fs = fit.fs;

  // ---------- 落位 ----------
  const units = []; // 每个要显示的字
  const lines = fit.lines.map((l) => ({ ...l, p: paras.find((x) => x.pi === l.paragraph) }));
  const cxAll = (P.x ?? 0.5) * W;
  // 竖排高度
  let cursor = 0;
  lines.forEach((l, li) => {
    const p = l.p;
    l.chars = p.chars.filter((c) => c.i >= l.index && c.i < l.index + l.text.length);
    l.groups = p.groups.filter((g) => g.start >= l.index && g.start < l.index + l.text.length);
    l.above = l.groups.filter((g) => g.mode === 'above');
    if (li > 0 && lines[li - 1].paragraph !== l.paragraph) cursor += 0.12 * fs;
    if (l.above.length) cursor += aboveExtra(fs);
    l.yRel = cursor + (fs * LH) / 2;
    cursor += fs * LH;
  });
  const blockH = cursor;
  const cyWant = (P.y ?? (vertical ? 0.4 : 0.5)) * H;
  const blockTop = clamp(cyWant - blockH / 2, top0 + padY(fs), Math.max(top0 + padY(fs), bottom0 - padY(fs) - blockH));
  const glyphUnit = (c, size, extra = {}) => {
    const b = glyph(c.ch);
    return { ch: c.ch, src: c, kind: c.kind, group: c.group, emph: c.emph, fs: size, b, oy: ((b.asc - b.desc) / 2) * size, ...extra };
  };
  lines.forEach((l, li) => {
    l.y = blockTop + l.yRel;
    // 这一行横排的字：正文、划掉的字、跟在后面的新词
    const flow = l.chars.filter((c) => c.kind === 'text' || c.kind === 'struck' || (c.kind === 'rewrite' && l.p.groups[c.group].mode === 'inline'));
    const vis = flow.filter((c) => !glyph(c.ch).blank);
    let x = 0;
    const placed = [];
    flow.forEach((c, k) => {
      const g = c.kind === 'rewrite' ? l.p.groups[c.group] : null;
      const size = g ? fs * inlScale(l.paragraph, c.i) : fs;
      const b = glyph(c.ch);
      if (g && c === l.p.chars[g.rewrite[0]]) x += GAP_INL * fs;
      let left = 0; let width = b.adv * size;
      const vi = vis.indexOf(c);
      if (b.punct && CLOSE_P.has(c.ch)) {
        const next = vis[vi + 1];
        if (!next || glyph(next.ch).punct) width = Math.min(width, (b.r + 0.08) * size); // 行尾、标点连用：收掉右边的空
      }
      if (b.punct && OPEN_P.has(c.ch)) {
        const prev = vis[vi - 1];
        if (!prev || glyph(prev.ch).punct) { const cut = Math.max(0, (b.l - 0.08) * size); left = cut; width -= cut; } // 行首、紧跟标点：收掉左边的空
      }
      placed.push({ c, size, xs: x, width, left });
      x += width;
    });
    const lineW = x;
    const x0 = clamp(cxAll - lineW / 2, side0 + sideAllow(fs), Math.max(side0 + sideAllow(fs), W - side0 - sideAllow(fs) - lineW));
    l.x0 = x0; l.w = lineW;
    // 跟在后面的新词：每组占多宽（含前面的空），用来算「还没改的时候」这一行是什么样
    const inl = l.groups.filter((g) => g.mode === 'inline').map((g) => {
      const rwFirst = l.p.chars[g.rewrite[0]];
      const wg = placed.filter((q) => q.c.kind === 'rewrite' && q.c.group === g.gi).reduce((s, q) => s + q.width, 0) + GAP_INL * fs;
      return { g, wg, firstI: rwFirst.i };
    });
    l.inl = inl;
    placed.forEach((q) => {
      if (glyph(q.c.ch).blank) return;
      const xF = x0 + q.xs + q.width / 2;
      const u = glyphUnit(q.c, q.size, { line: li, x: xF, y: l.y, ox: -(q.left + q.width / 2), slotL: x0 + q.xs, slotR: x0 + q.xs + q.width });
      // 每组新词让这个字往哪挪：在这组新词后面（含新词自己）＋wg，再整行居中－wg/2
      // 这组自己的新词跟着划掉的词走（还没撑开时贴在它右边），不从它头上冒出来
      u.deltas = inl.map((s) => ({ key: s.g.key, d: (q.c.i >= s.firstI && !(q.c.kind === 'rewrite' && q.c.group === s.g.gi) ? s.wg : 0) - s.wg / 2 }));
      if (q.c.kind === 'rewrite') {
        u.rotF = (h('rr', l.paragraph, q.c.i) - 0.5) * 6;
        u.y += (h('ry', l.paragraph, q.c.i) - 0.5) * 0.06 * fs;
      } else u.rotF = 0;
      units.push(u);
    });
    // 写在上方的新词
    const ab = l.above.map((g) => {
      const st = units.filter((u) => u.line === li && u.kind === 'struck' && u.group === g.gi);
      const sx0 = Math.min(...st.map((u) => u.slotL)); const sx1 = Math.max(...st.map((u) => u.slotR));
      let rf = RW_ABOVE * fs;
      const rws = g.rewrite.map((k) => l.p.chars[k]);
      const adv = (c) => glyph(c.ch).adv * (1 + (h('rs', l.paragraph, c.i) - 0.5) * 0.14);
      let rwW = rws.reduce((s, c) => s + adv(c) * rf, 0) * 1.04;
      const room = W - 2 * (side0 + 0.1 * fs) - (circleOn ? 0.8 * rf : 0);
      if (rwW > room) { rf *= room / rwW; rwW = room; g.shrunk = true; }
      const tilt = (-4 + (h('tilt', g.key) - 0.5) * 5) * DEG;
      const cx = (sx0 + sx1) / 2 + (h('rx', g.key) - 0.35) * 0.3 * fs;
      return { g, rf, rws, adv, rwW, tilt, cx, sx0, sx1, deltas: st[0].deltas };
    });
    // 一行里有两组都写在上方：从左往右推开，别叠在一起
    ab.sort((a, b) => a.cx - b.cx);
    for (let k = 1; k < ab.length; k++) {
      const minC = ab[k - 1].cx + ab[k - 1].rwW / 2 + 0.3 * ab[k].rf + ab[k].rwW / 2;
      if (ab[k].cx < minC) ab[k].cx = minC;
    }
    for (const a of ab) {
      const ext = a.rwW / 2 + (circleOn ? 0.45 * a.rf : 0) + 0.1 * fs + (bangOn ? 0.2 * a.rf : 0);
      a.cx = clamp(a.cx, side0 + ext, Math.max(side0 + ext, W - side0 - ext));
      const yR = l.y - 0.5 * fs - 0.12 * fs - 0.5 * a.rf - (circleOn ? 0.06 * fs : 0);
      let acc = -a.rwW / 2;
      a.rws.forEach((c) => {
        const w = a.adv(c) * a.rf * 1.04;
        const d = acc + w / 2; acc += w;
        const u = glyphUnit(c, a.rf * (1 + (h('rs', l.paragraph, c.i) - 0.5) * 0.14), {
          line: li, above: true,
          x: a.cx + d * Math.cos(a.tilt), y: yR + d * Math.sin(a.tilt) + (h('ry', l.paragraph, c.i) - 0.5) * 0.12 * a.rf,
          ox: -(glyph(c.ch).adv * a.rf) / 2, deltas: a.deltas,
        });
        u.rotF = a.tilt / DEG + (h('rr', l.paragraph, c.i) - 0.5) * 13;
        units.push(u);
      });
      a.g.box = { cx: a.cx, cy: yR, hw: a.rwW / 2, hh: 0.5 * a.rf, rf: a.rf, tilt: a.tilt };
    }
  });
  // 跟在后面的新词：圈和感叹号用的外框
  for (const g of groupsAll) {
    if (g.mode !== 'inline') continue;
    const rw = units.filter((u) => u.kind === 'rewrite' && u.group === g.gi && u.src && g.para.chars.includes(u.src));
    if (!rw.length) continue;
    const x0 = Math.min(...rw.map((u) => u.slotL)); const x1 = Math.max(...rw.map((u) => u.slotR));
    g.box = { cx: (x0 + x1) / 2, cy: rw[0].y, hw: (x1 - x0) / 2, hh: 0.52 * fs * INL, rf: fs * INL, tilt: (h('tilt', g.key) - 0.5) * 3 * DEG, first: rw[0] };
  }
  const unitsOfGroup = (g, kind) => units.filter((u) => u.kind === kind && u.group === g.gi && g.para.chars.includes(u.src));

  // ---------- 时间轴 ----------
  // 正文：一行一行出来，行内逐字错开
  const bodyUnits = units.filter((u) => u.kind !== 'rewrite');
  const lineFirst = new Map();
  bodyUnits.forEach((u) => {
    const k = (lineFirst.get(u.line) ?? 0);
    u.t0 = 0.12 * (onPaper ? 1 : 0) + u.line * R.lineStagger + k * R.charStagger;
    lineFirst.set(u.line, k + 1);
  });
  const introEnd = bodyUnits.length ? Math.max(...bodyUnits.map((u) => u.t0)) + R.charDur + 0.05 : 0.3;
  // 一组一组划、改
  let tCur = introEnd + R.read;
  const order = [...groupsAll].sort((a, b) => a.para.pi - b.para.pi || a.start - b.start);
  order.forEach((g, gk) => {
    const st = unitsOfGroup(g, 'struck');
    g.strikeStart = tCur;
    const spanFs = st.length ? (Math.max(...st.map((u) => u.slotR)) - Math.min(...st.map((u) => u.slotL))) / fs : 1;
    const dur = R.strike * clamp(0.75 + 0.18 * spanFs, 0.85, 1.5);
    g.passes = strikeMode === 'double' ? [{ start: 0, dur: 0.6 * dur }, { start: 0.64 * dur, dur: 0.52 * dur }] : strikeMode === 'scribble' ? [{ start: 0, dur: 1.55 * dur }] : [{ start: 0, dur }];
    g.strikeEnd = g.strikeStart + Math.max(...g.passes.map((p) => p.start + p.dur));
    g.expandStart = g.strikeEnd + 0.02;
    g.expandDur = 0.3;
    const rw = unitsOfGroup(g, 'rewrite');
    g.rwStart = g.strikeEnd + R.rwDelay;
    rw.forEach((u, j) => { u.t0 = g.rwStart + j * R.rwStagger; });
    g.land = rw.length ? g.rwStart + (rw.length - 1) * R.rwStagger + POP_LAND : g.strikeEnd;
    g.circleStart = g.land - 0.04; g.circleDur = 0.42;
    g.bangStart = g.circleStart + (circleOn ? 0.3 : 0.05);
    const hasMarks = rw.length && (circleOn || bangOn);
    g.done = Math.max(g.land + 0.2, hasMarks ? (circleOn ? g.circleStart + g.circleDur : 0) + 0.05 : 0, hasMarks && bangOn ? g.bangStart + 0.35 : 0, g.strikeEnd + 0.15);
    tCur = g.done + R.groupGap;
    g.order = gk;
  });
  const rwEnd = order.length ? Math.max(...order.map((g) => g.done)) + 0.1 : introEnd;
  const totalChars = units.length;
  const holdDur = P.hold ?? Math.max(1.5, totalChars / 5);
  const outroStart = rwEnd + holdDur;
  const outroEnd = outroStart + R.outDur;
  const duration = outroEnd + 0.1;
  // 出场：按阅读顺序逐个缩没
  const exitDur = 0.55 * R.outDur;
  const reading = [...units].sort((a, b) => a.line - b.line || (a.above === b.above ? a.x - b.x : a.above ? -1 : 1));
  const stagger = reading.length > 1 ? (0.45 * R.outDur) / (reading.length - 1) : 0;
  reading.forEach((u, k) => { u.x0 = outroStart + k * stagger; });
  for (const g of groupsAll) {
    const st = unitsOfGroup(g, 'struck');
    g.exit = st.length ? Math.min(...st.map((u) => u.x0)) : outroStart;
    const rw = unitsOfGroup(g, 'rewrite');
    g.exitRw = rw.length ? Math.min(...rw.map((u) => u.x0)) : g.exit; // 圈和感叹号跟着新词一起缩
    for (const u of st) u.pass = g.strikeStart + 0.001; // 先占位，下面按笔尖算
  }

  // ---------- 笔迹几何 ----------
  function strikeBase(g) {
    const st = unitsOfGroup(g, 'struck');
    const sx0 = Math.min(...st.map((u) => u.x + u.ox + u.b.l * u.fs));
    const sx1 = Math.max(...st.map((u) => u.x + u.ox + u.b.r * u.fs));
    const y = st[0].y - 0.03 * fs + (h('sy', g.key) - 0.5) * 0.06 * fs;
    const tilt = -(1.5 + h('st', g.key) * 4) * DEG;
    return { st, sx0, sx1, y, tilt, xa: sx0 - 0.1 * fs, xb: sx1 + 0.14 * fs };
  }
  const sw = (P.weight ?? 1) * (strikeMode === 'scribble' ? 0.105 : 0.125) * fs * (flair > 0.6 ? 1.12 : 1);
  function strikePasses(g, bi) {
    const B = g.base; const span = B.xb - B.xa; const xc = (B.xa + B.xb) / 2;
    const wob = (0.018 + 0.01 * flair) * fs;
    const boilN = (u, key) => (bi >= 0 ? (noise1(seed + 17 * bi, u * 3, `${key}${g.key}`) - 0.5) * 2 * 0.012 * fs * boil : 0);
    const pass = (xa, xb, y0, tilt, bow, wk, key) => {
      const n = Math.max(18, Math.round((Math.abs(xb - xa) / fs) * 16));
      const pts = []; const wid = [];
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1); const x = lerp(xa, xb, u);
        const y = y0 + Math.tan(tilt) * (x - xc) - bow * fs * 4 * u * (1 - u) + (noise1(seed, (x - B.xa) / fs * 1.1, `w${key}${g.key}`) - 0.5) * 2 * wob + boilN(u, key);
        pts.push({ x, y });
        const wv = sw * wk * (0.5 + 0.5 * smoothstep(0, 0.1, u)) * (1 - 0.42 * smoothstep(0.7, 1, u)) * (1 + (noise1(seed, u * 3.1, `ww${key}${g.key}`) - 0.5) * 0.14) * (bi >= 0 ? 1 + (hash01(seed, 'bw', g.key, bi) - 0.5) * 0.08 * boil : 1);
        wid.push(wv);
      }
      return { pts, wid };
    };
    if (strikeMode === 'scribble') {
      const cyc = Math.max(3.5, (span / fs) * 3.4);
      const A = 0.3 * fs;
      const n = Math.max(40, Math.round(cyc * 18));
      const pts = [];
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const x = lerp(B.xa + 0.04 * fs, B.xb - 0.04 * fs, u) + boilN(u, 'sx');
        const y = B.y + Math.tan(B.tilt) * (x - xc) + A * Math.sin(2 * Math.PI * cyc * u + h('ph', g.key) * 6.283) * (0.8 + 0.2 * noise1(seed, u * 4, `sa${g.key}`)) + boilN(u, 'sy');
        pts.push({ x, y });
      }
      return [{ pts, stroke: true }];
    }
    const dbl = strikeMode === 'double';
    const out = [pass(B.xa, B.xb, B.y - (dbl ? 0.1 * fs : 0), B.tilt, 0.06 + 0.04 * h('bow', g.key), 1, 'a')];
    // 来回两道：划过去，再斜着拉回来，落在下半截
    if (dbl) out.push(pass(B.xb - 0.02 * fs, B.xa + 0.1 * fs, B.y + 0.19 * fs, B.tilt + (2 + h('t2', g.key) * 3) * DEG, -0.04, 0.82, 'b'));
    return out;
  }
  function loopGeom(g, bi) {
    const b = g.box; const rf = b.rf;
    const rx = b.hw + 0.36 * rf; const ry = b.hh + 0.3 * rf;
    const n = 80; const a0 = (200 + h('la', g.key) * 30) * DEG; const turn = 2 * Math.PI * 1.1;
    const pts = []; const wid = [];
    const lw = 0.085 * rf * (P.weight ?? 1) * 1.2;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      const a = a0 + s * turn;
      const r = 1 + 0.07 * s + (noise1(seed, s * 3.2, `lr${g.key}`) - 0.5) * 0.09 + (bi >= 0 ? (noise1(seed + 31 * bi, s * 4, `lb${g.key}`) - 0.5) * 0.04 * boil : 0);
      const px = rx * r * Math.cos(a); const py = ry * r * Math.sin(a);
      pts.push({ x: b.cx + px * Math.cos(b.tilt) - py * Math.sin(b.tilt), y: b.cy + px * Math.sin(b.tilt) + py * Math.cos(b.tilt) });
      wid.push(lw * (0.45 + 0.55 * smoothstep(0, 0.12, s)) * (1 - 0.6 * smoothstep(0.8, 1, s)));
    }
    return { pts, wid, rx, ry };
  }
  for (const g of groupsAll) {
    g.base = strikeBase(g);
    // 笔尖走过每个划掉的字的时刻：那个字从这一刻开始变灰、被压一下
    const p0 = g.passes[0];
    const B = g.base;
    for (const u of g.base.st) {
      const s = clamp((u.x - B.xa) / (B.xb - B.xa));
      u.pass = g.strikeStart + p0.start + (strikeMode === 'scribble' ? s : pen.inv(s)) * p0.dur;
    }
    if (g.box && (circleOn || bangOn)) {
      const lg = loopGeom(g, -1);
      // 感叹号放在圈的右上方；右边放不下就放左上方
      const bh = 1.05 * g.box.rf;
      const ang = -38 * DEG;
      const ex = (circleOn ? lg.rx : g.box.hw + 0.2 * g.box.rf) + 0.42 * bh; const ey = (circleOn ? lg.ry : g.box.hh) + 0.1 * bh;
      const by = g.box.cy + ey * Math.sin(ang);
      // 先放右边；整体居中以后右边还放不下，再翻到左边（见下面的整体居中）
      g.bang = { x: g.box.cx + ex * Math.cos(ang), off: ex * Math.cos(ang), y: Math.max(by, 0.03 * H + 0.75 * bh), h: bh, side: 1, rot: 10 + h('br', g.key) * 8 };
      g.loopR = lg;
    }
  }
  // 整体居中：上方的新词、圈、感叹号会让画面偏到一边，按整块的外框把所有东西一起挪回正中（只挪不缩，最多 0.6 个字号，正文不出边距）
  if (units.length && P.x == null) {
    const xs = [];
    for (const u of units) xs.push(u.x - 0.5 * u.fs, u.x + 0.5 * u.fs);
    for (const g of groupsAll) {
      xs.push(g.base.xa, g.base.xb);
      if (g.box && circleOn && g.loopR) xs.push(g.box.cx - g.loopR.rx, g.box.cx + g.loopR.rx);
      if (g.bang) xs.push(g.bang.x + g.bang.side * 0.75 * g.bang.h);
    }
    const body = units.filter((u) => !u.above);
    const bl = Math.min(...body.map((u) => u.x - 0.5 * u.fs)); const br = Math.max(...body.map((u) => u.x + 0.5 * u.fs));
    let dx = clamp(cxAll - (Math.min(...xs) + Math.max(...xs)) / 2, -0.6 * fs, 0.6 * fs);
    dx = clamp(dx, side0 - bl, W - side0 - br);
    if (Math.abs(dx) > 0.5) {
      for (const u of units) { u.x += dx; if (u.slotL != null) { u.slotL += dx; u.slotR += dx; } }
      for (const g of groupsAll) {
        g.base.xa += dx; g.base.xb += dx; g.base.sx0 += dx; g.base.sx1 += dx;
        if (g.box) g.box.cx += dx;
        if (g.bang) g.bang.x += dx;
      }
    }
  }
  const bangRoom = (cardOn ? 0.05 : 0.025) * W;
  for (const g of groupsAll) {
    if (g.bang && g.bang.x + 0.85 * g.bang.h > W - bangRoom) { g.bang.side = -1; g.bang.x = g.box.cx - g.bang.off; g.bang.rot = -g.bang.rot; }
  }
  // 时间轴整理
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: introEnd },
      { name: 'rewrite', label: '划掉改字', start: introEnd, end: rwEnd },
      { name: 'hold', label: '停留', start: rwEnd, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...order.flatMap((g) => [
        { t: g.strikeStart, name: 'strike-start', label: `第 ${g.order + 1} 处开始划` },
        { t: g.strikeEnd, name: 'strike-end', label: `第 ${g.order + 1} 处划完` },
        ...(g.rewrite.length ? [{ t: g.land, name: 'rewrite-land', label: `第 ${g.order + 1} 处新词落下（对音效）` }] : []),
      ]),
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: reading.map((u, i) => ({ i, char: u.ch, line: u.line, kind: u.kind, enter: u.t0, ...(u.kind === 'struck' ? { struck: u.pass } : {}), exitStart: u.x0, exitEnd: u.x0 + exitDur })),
  };

  // ---------- 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-sr` : 'sr' + Math.floor(hash01(seed, ctx.text, W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: 'position:absolute;left:0;top:0;overflow:visible', 'data-hanzifx-style': 'strike-rewrite', 'data-uid': uid });
  const gPaper = el('g', { 'data-layer': 'paper' }, svg);
  const gBand = el('g', { 'data-layer': 'highlight' }, svg);
  const gOut = el('g', { 'data-layer': 'outline' }, svg);
  const gText = el('g', { 'data-layer': 'text' }, svg);
  const gStrike = el('g', { 'data-layer': 'strike' }, svg);
  const gRwOut = el('g', { 'data-layer': 'rewrite-outline' }, svg);
  const gRw = el('g', { 'data-layer': 'rewrite' }, svg);
  const gDeco = el('g', { 'data-layer': 'deco' }, svg);

  // 纸
  const sheet = {};
  if (units.length) {
    const xs = []; const ys = [];
    for (const u of units) { xs.push(u.x - 0.55 * u.fs, u.x + 0.55 * u.fs); ys.push(u.y - 0.55 * u.fs, u.y + 0.55 * u.fs); }
    for (const g of groupsAll) {
      xs.push(g.base.xa - 0.06 * fs, g.base.xb + 0.06 * fs);
      if (g.box && circleOn) { xs.push(g.box.cx - g.loopR.rx * 1.1, g.box.cx + g.loopR.rx * 1.1); ys.push(g.box.cy - g.loopR.ry * 1.12, g.box.cy + g.loopR.ry * 1.12); }
      if (g.bang) { xs.push(g.bang.x - 0.8 * g.bang.h, g.bang.x + 0.8 * g.bang.h); ys.push(g.bang.y - 0.7 * g.bang.h); }
    }
    const bx0 = Math.min(...xs); const bx1 = Math.max(...xs); const by0 = Math.min(...ys); const by1 = Math.max(...ys);
    const padX = 0.42 * fs; const pY = 0.4 * fs;
    const mX = 0.04 * W; const mY = 0.03 * H;
    sheet.x0 = Math.max(bx0 - padX, mX); sheet.x1 = Math.min(W - mX, bx1 + padX);
    sheet.y0 = Math.max(by0 - pY, mY + 0.25 * fs); sheet.y1 = Math.min(H - mY, by1 + pY);
    sheet.cx = (sheet.x0 + sheet.x1) / 2; sheet.cy = (sheet.y0 + sheet.y1) / 2;
    sheet.rot = (h('card') < 0.5 ? -1 : 1) * (1.1 + h('card2') * 1.1);
  }
  const paperEls = [];
  if (paper === 'card' && units.length) {
    const { x0, x1, y0, y1 } = sheet; const r = 0.1 * fs;
    const so = 0.07 * fs;
    paperEls.push({ e: el('rect', { x: x0 + so, y: y0 + so * 1.25, width: x1 - x0, height: y1 - y0, rx: r, fill: K.shadow }, gPaper), op: 1 });
    paperEls.push({ e: el('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: r, fill: K.bg }, gPaper), op: 1 });
    // 横线：每行字底下一条，像本子
    let d = '';
    for (const l of lines) { const y = l.y + 0.62 * fs; if (y < y1 - 0.15 * fs) d += `M${f3(x0 + 0.12 * fs)},${f3(y)}L${f3(x1 - 0.12 * fs)},${f3(y)}`; }
    if (d) paperEls.push({ e: el('path', { d, stroke: K.sub, 'stroke-width': Math.max(1.5, 0.022 * fs), fill: 'none' }, gPaper), op: lightInk ? 0.3 : 0.45 });
    const mx = x0 + 0.24 * fs;
    paperEls.push({ e: el('path', { d: `M${f3(mx)},${f3(y0)}L${f3(mx)},${f3(y1)}`, stroke: K.accent, 'stroke-width': Math.max(1.5, 0.02 * fs), fill: 'none' }, gPaper), op: 0.45 });
    if (P.tape) {
      const tw = Math.min(0.3 * (x1 - x0), 2.4 * fs); const th = 0.36 * fs;
      paperEls.push({ e: el('rect', { x: sheet.cx - tw / 2, y: y0 - th / 2, width: tw, height: th, fill: K.fill2, transform: `rotate(${f3(-4 + h('tape') * 3)},${f3(sheet.cx)},${f3(y0)})` }, gPaper), op: 0.72, tape: true });
    }
  } else if (paper === 'page') {
    paperEls.push({ e: el('rect', { x: 0, y: 0, width: W, height: H, fill: K.bg }, gPaper), op: 1, still: true });
    let d = '';
    const step = fs * LH;
    const ref = lines.length ? lines[0].y + 0.62 * fs : 0.5 * H;
    for (let y = ref - Math.ceil(ref / step) * step; y < H; y += step) if (y > 0) d += `M0,${f3(y)}L${W},${f3(y)}`;
    paperEls.push({ e: el('path', { d, stroke: K.sub, 'stroke-width': Math.max(1.5, 0.02 * fs), fill: 'none' }, gPaper), op: lightInk ? 0.25 : 0.4, still: true });
    paperEls.push({ e: el('path', { d: `M${f3(0.09 * W)},0L${f3(0.09 * W)},${H}`, stroke: K.accent, 'stroke-width': Math.max(1.5, 0.02 * fs), fill: 'none' }, gPaper), op: 0.45, still: true });
  }

  // 关键词：有纸时画荧光笔（一段一段），没纸时换颜色
  const bands = [];
  if (onPaper) {
    lines.forEach((l, li) => {
      let cur = null;
      for (const u of units.filter((v) => v.line === li && !v.above && v.kind === 'text')) {
        if (u.emph) { if (cur) cur.us.push(u); else { cur = { us: [u] }; bands.push(cur); } } else cur = null;
      }
    });
    bands.forEach((bd, k) => {
      bd.x0 = bd.us[0].slotL - 0.04 * fs; bd.x1 = bd.us[bd.us.length - 1].slotR + 0.06 * fs; bd.y = bd.us[0].y; bd.k = k;
      bd.t0 = bd.us[0].t0 + 0.12; bd.dur = 0.18 + 0.05 * bd.us.length;
      bd.e = el('path', { fill: K.fill2 }, gBand);
    });
  }
  const bandD = (bd, p) => {
    const x1 = lerp(bd.x0, bd.x1, p); const n = Math.max(4, Math.round((x1 - bd.x0) / (0.25 * fs)) + 1);
    const top = []; const bot = [];
    for (let i = 0; i < n; i++) {
      const x = lerp(bd.x0, x1, i / (n - 1));
      top.push([x, bd.y - 0.3 * fs + (hash01(seed, 'bt', bd.k, i) - 0.5) * 0.05 * fs]);
      bot.push([x, bd.y + 0.4 * fs + (hash01(seed, 'bb', bd.k, i) - 0.5) * 0.05 * fs]);
    }
    return 'M' + top.map((q) => `${f3(q[0])},${f3(q[1])}`).join('L') + 'L' + bot.reverse().map((q) => `${f3(q[0])},${f3(q[1])}`).join('L') + 'Z';
  };

  // 字
  const textAttrs = (u) => ({ 'font-family': family, 'font-size': f3(u.fs), 'text-rendering': 'geometricPrecision', x: f3(u.ox), y: f3(u.oy) });
  const mk = (u, parent, attrs) => { const t = el('text', { ...textAttrs(u), ...attrs }, parent); t.textContent = u.ch; return t; };
  const bodyColor = (u) => (u.emph && !onPaper ? K.fill2 : K.fill);
  for (const u of units) {
    u.nodes = [];
    if (u.kind === 'rewrite') {
      if (!onPaper) {
        u.nodes.push(mk(u, gRwOut, { fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.24 * u.fs), 'stroke-linejoin': 'round' }));
        u.nodes.push(mk(u, gRwOut, { fill: K.inner, stroke: K.inner, 'stroke-width': f3(0.12 * u.fs), 'stroke-linejoin': 'round' }));
      }
      u.fillNode = mk(u, gRw, { fill: K.accent });
    } else {
      if (!onPaper) u.nodes.push(mk(u, gOut, { fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.14 * u.fs), 'stroke-linejoin': 'round' }));
      u.fillNode = mk(u, gText, { fill: bodyColor(u) });
    }
    u.nodes.push(u.fillNode);
  }
  // 笔迹：每组一套（墨边在下，笔迹在上；有纸时不要墨边）
  for (const g of groupsAll) {
    g.strikeEls = g.passes.map(() => {
      const scr = strikeMode === 'scribble';
      const edge = onPaper ? null : el('path', scr
        ? { fill: 'none', stroke: K.outer, 'stroke-width': f3(sw + 0.06 * fs), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
        : { fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.05 * fs), 'stroke-linejoin': 'round' }, gStrike);
      const ink = el('path', scr
        ? { fill: 'none', stroke: K.accent, 'stroke-width': f3(sw), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
        : { fill: K.accent }, gStrike);
      return { edge, ink };
    });
    if (g.box && circleOn) {
      g.loopEdge = onPaper ? null : el('path', { fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.05 * g.box.rf), 'stroke-linejoin': 'round' }, gDeco);
      g.loopInk = el('path', { fill: K.accent }, gDeco);
    }
    if (g.bang && bangOn) {
      const d = bangPath(g.bang.h, g.bang.side);
      g.bangEdge = onPaper ? null : el('path', { d, fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.07 * g.bang.h), 'stroke-linejoin': 'round' }, gDeco);
      g.bangInk = el('path', { d, fill: K.accent }, gDeco);
    }
  }
  root.appendChild(svg);

  // ---------- 动作（纯函数） ----------
  const snapEps = { s: 0.004, rot: 0.05, px: 0.4 };
  /** 一组跟在后面的新词：这一行撑开了多少（0 还没改，1 改完） */
  const expandOf = (g, t) => {
    if (g.mode !== 'inline') return 1;
    const e = easeOutCubic(clamp((t - g.expandStart) / g.expandDur));
    return e < 0.004 ? 0 : e > 0.996 ? 1 : e;
  };
  const groupByKey = new Map(groupsAll.map((g) => [g.key, g]));
  const shiftOf = (deltas, t) => deltas.reduce((s, d) => s - (1 - expandOf(groupByKey.get(d.key), t)) * d.d, 0);
  /** 新词落下时整块震一下：每个元素各自加位移，不挪整组 */
  function impact(t) {
    let dx = 0; let dy = 0;
    if (flair <= 0) return { dx, dy };
    for (const g of order) {
      if (!g.rewrite.length) continue;
      const m = shake(t, { start: g.land, amplitude: (0.004 + 0.012 * flair) * short, duration: 0.18 + 0.12 * flair, freq: 26, seed: seed + g.order * 7, rotate: 0 });
      dx += m.dx; dy += m.dy;
    }
    if (Math.hypot(dx, dy) < snapEps.px) return { dx: 0, dy: 0 };
    return { dx, dy };
  }
  const exitK = (t, x0) => { const k = easeInCubic(clamp((t - x0) / exitDur)); return k < 0.01 ? 0 : k; };

  function unitState(u, t, imp) {
    if (t < u.t0) return null;
    const tau = t - u.t0;
    let s = 1; let rot = u.rotF; let dy = 0; let op = 1; let color = null;
    if (u.kind === 'rewrite') {
      if (tau < POP_END) {
        const sp = spring(tau, POP);
        const s0 = 1.35 + 0.3 * flair;
        s = lerp(s0, 1, sp);
        rot = lerp(u.rotF + (hash01(seed, 'r0', u.line, u.x) - 0.5) * 28, u.rotF, sp);
        dy = -(1 - sp) * 0.3 * u.fs;
        op = clamp(tau / 0.035);
        if (Math.abs(s - 1) < snapEps.s && Math.abs(rot - u.rotF) < snapEps.rot && Math.abs(dy) < snapEps.px) { s = 1; rot = u.rotF; dy = 0; }
      }
    } else {
      const p = clamp(tau / R.charDur);
      if (pop) {
        if (tau < 0.7) {
          const sp = spring(tau, { freq: 2.6, damping: 0.5 });
          s = lerp(1.32, 1, sp); dy = -(1 - sp) * 0.12 * u.fs;
          if (Math.abs(s - 1) < snapEps.s && Math.abs(dy) < snapEps.px) { s = 1; dy = 0; }
        }
        op = clamp(tau / 0.06);
      } else if (p < 0.985) {
        const e = easeOutCubic(p);
        dy = (1 - e) * 0.24 * u.fs; op = clamp(p * 2.4);
        if (Math.abs(dy) < snapEps.px) dy = 0;
      }
      if (u.kind === 'struck' && t >= u.pass) {
        const k = smoothstep(u.pass, u.pass + 0.16, t) * dimAmt;
        color = k > 0.002 ? mix(bodyColor(u), K.sub, k) : null;
        // 笔尖压过去：字往下一沉再回来
        const tp = t - u.pass;
        if (tp < 0.4) { const im = Math.exp(-10 * tp) * Math.sin(2 * Math.PI * 4.2 * tp); const v = im * (0.03 + 0.03 * flair) * u.fs; if (Math.abs(v) >= snapEps.px) dy += v; }
        if (flair > 0.6) { const ks = smoothstep(u.pass, u.pass + 0.2, t) * 0.06; if (ks > 0.002) s *= 1 - ks; }
      }
    }
    const k = exitK(t, u.x0);
    if (k >= 1) return null;
    if (k > 0) { s *= 1 - k; dy += k * 0.14 * u.fs; }
    if (s < 0.2) return null;
    const x = u.x + shiftOf(u.deltas, t) + imp.dx;
    return { x, y: u.y + dy + imp.dy, s, rot, op, color };
  }
  const markExit = (t, g) => exitK(t, g.exit);
  const markTransform = (cx, cy, dx, dy, s) => (s === 1 ? (dx || dy ? `translate(${f3(dx)},${f3(dy)})` : '') : `translate(${f3(cx + dx)},${f3(cy + dy)}) scale(${f3(s)}) translate(${f3(-cx)},${f3(-cy)})`);
  const setTf = (e, tf) => { if (tf) e.setAttribute('transform', tf); else e.removeAttribute('transform'); };

  function seek(t) {
    const imp = impact(t);
    // 纸
    if (paperEls.length) {
      const tau = t;
      const sp = paper === 'card' ? (tau < 0.8 ? spring(tau, { freq: 2.2, damping: 0.55 }) : 1) : 1;
      let s = paper === 'card' ? lerp(0.9, 1, sp) : 1;
      if (Math.abs(s - 1) < snapEps.s) s = 1;
      let op = paper === 'card' ? clamp(tau / 0.16) : 1;
      const kOut = paper === 'card' ? easeInCubic(clamp((t - (outroStart + 0.45 * R.outDur)) / (0.55 * R.outDur))) : 0;
      const kk = kOut < 0.01 ? 0 : kOut;
      if (kk > 0) { s *= 1 - 0.12 * kk; op *= 1 - kk; }
      const dx = imp.dx * 0.5; const dy = imp.dy * 0.5;
      for (const pe of paperEls) {
        if (pe.still) { show(pe.e, true); pe.e.setAttribute('opacity', f3(pe.op)); continue; }
        show(pe.e, op > 0.004 && s > 0.2);
        pe.e.setAttribute('opacity', f3(pe.op * op));
        const base = `translate(${f3(sheet.cx + (Math.abs(dx) < snapEps.px ? 0 : dx))},${f3(sheet.cy + (Math.abs(dy) < snapEps.px ? 0 : dy))}) rotate(${f3(sheet.rot)}) scale(${f3(s)}) translate(${f3(-sheet.cx)},${f3(-sheet.cy)})`;
        pe.e.setAttribute('transform', pe.tape ? `${base} rotate(${f3(-4 + h('tape') * 3)},${f3(sheet.cx)},${f3(sheet.y0)})` : base);
      }
    }
    // 荧光笔
    for (const bd of bands) {
      const p = clamp((t - bd.t0) / bd.dur);
      const k = exitK(t, bd.us[0].x0);
      if (p <= 0 || k >= 1) { show(bd.e, false); continue; }
      show(bd.e, true);
      bd.e.setAttribute('d', bandD(bd, p < 0.995 ? easeOutCubic(p) : 1));
      bd.e.setAttribute('opacity', f3((lightInk ? 0.38 : 0.85) * (1 - k)));
      setTf(bd.e, imp.dx || imp.dy ? `translate(${f3(imp.dx)},${f3(imp.dy)})` : '');
    }
    // 字
    for (const u of units) {
      const st = unitState(u, t, imp);
      for (const node of u.nodes) {
        if (!st) { show(node, false); continue; }
        show(node, true);
        node.setAttribute('transform', `translate(${f3(st.x)},${f3(st.y)}) rotate(${f3(st.rot)}) scale(${f3(st.s)})`);
        node.setAttribute('opacity', f3(st.op));
      }
      if (st && u.kind === 'struck') u.fillNode.setAttribute('fill', st.color || bodyColor(u));
    }
    // 笔迹
    for (const g of groupsAll) {
      const bi = boil > 0 && t >= g.done ? Math.floor(t * BOIL_RATE) : -1;
      const k = markExit(t, g);
      const st = g.base.st;
      const shift = st.length ? shiftOf(st[0].deltas, t) : 0;
      const sx = (g.base.xa + g.base.xb) / 2; const sy = g.base.y;
      const sMark = 1 - k;
      const passes = t >= g.strikeStart ? strikePasses(g, bi) : null;
      g.passes.forEach((ps, pi) => {
        const els = g.strikeEls[pi];
        const tau = (t - g.strikeStart - ps.start) / ps.dur;
        if (!passes || tau <= 0 || k >= 1 || sMark < 0.2) { show(els.ink, false); if (els.edge) show(els.edge, false); return; }
        const geo = passes[pi];
        const q = strikeMode === 'scribble' ? (tau >= 1 ? 1 : easeOutCubic(clamp(tau)) * 0.15 + clamp(tau) * 0.85) : (tau >= 1 ? 1 : pen.q(tau));
        const d = geo.stroke ? polyPart(geo.pts, q) : penOutline(geo.pts, geo.wid, q);
        const tf = markTransform(sx, sy, shift + imp.dx, imp.dy, sMark);
        for (const e of [els.edge, els.ink]) {
          if (!e) continue;
          if (!d) { show(e, false); continue; }
          show(e, true); e.setAttribute('d', d); setTf(e, tf);
        }
      });
      if (!g.box) continue;
      const rwFirst = unitsOfGroupCache.get(g.key);
      const rShift = rwFirst ? shiftOf(rwFirst.deltas, t) : 0;
      const kR = exitK(t, g.exitRw); const sR = 1 - kR;
      if (g.loopInk) {
        const tau = (t - g.circleStart) / g.circleDur;
        if (tau <= 0 || kR >= 1 || sR < 0.2) { show(g.loopInk, false); if (g.loopEdge) show(g.loopEdge, false); } else {
          const lg = loopGeom(g, bi);
          const d = penOutline(lg.pts, lg.wid, tau >= 1 ? 1 : pen.q(tau));
          const tf = markTransform(g.box.cx, g.box.cy, rShift + imp.dx, imp.dy, sR);
          for (const e of [g.loopEdge, g.loopInk]) { if (!e) continue; show(e, !!d); if (d) { e.setAttribute('d', d); setTf(e, tf); } }
        }
      }
      if (g.bangInk) {
        const tau = t - g.bangStart;
        let s = 0;
        if (tau > 0) s = tau < 0.7 ? spring(tau, { freq: 3.2, damping: 0.4 }) : 1;
        if (Math.abs(s - 1) < snapEps.s) s = 1;
        s *= sR;
        const vis = tau > 0 && s >= 0.2 && kR < 1;
        const jr = bi >= 0 ? (hash01(seed, 'bj', g.key, bi) - 0.5) * 4 * boil : 0;
        const tf = `translate(${f3(g.bang.x + rShift + imp.dx)},${f3(g.bang.y + imp.dy)}) rotate(${f3(g.bang.rot + jr)}) scale(${f3(Math.max(s, 0.2))})`;
        for (const e of [g.bangEdge, g.bangInk]) { if (!e) continue; show(e, vis); e.setAttribute('transform', tf); }
      }
    }
  }
  const unitsOfGroupCache = new Map(groupsAll.map((g) => [g.key, unitsOfGroup(g, 'rewrite')[0] || null]));

  // ---------- 检查和排版信息 ----------
  const linesDetail = lines.map((l) => ({ text: l.text, index: l.index, paragraph: l.paragraph }));
  const styleChecks = [
    { id: 'strike-markup', level: 'warn', pass: groupsAll.length > 0 && !unclosed,
      message: !groupsAll.length ? '没找到 ~~划掉的词~~：整句只是普通字。写法：「我以为是~~努力~~*选择*」' : unclosed ? '有 ~~ 没闭合，已经划到这一段结尾' : `找到 ${groupsAll.length} 处：${groupsAll.map((g) => `「${g.struck.map((k) => g.para.chars[k].ch).join('')}」→${g.rewrite.length ? `「${g.rewrite.map((k) => g.para.chars[k].ch).join('')}」（${g.mode === 'above' ? '写在上方' : '跟在后面'}）` : '只划不改'}`).join('，')}` },
  ];
  const shrunk = groupsAll.filter((g) => g.shrunk);
  if (shrunk.length) styleChecks.push({ id: 'rewrite-shrunk', level: 'warn', pass: false, message: `写在上方的新词太长，缩小了：${shrunk.map((g) => g.rewrite.map((k) => g.para.chars[k].ch).join('')).join('、')}；可以改成 place=inline 跟在后面` });

  return {
    timeline,
    layout: {
      fontSize: fs,
      lines: lines.map((l) => l.text),
      linesDetail: lines.map((l) => ({ text: l.text, index: l.index, paragraph: l.paragraph, fontSize: fs })),
      forced: fit.forced || [],
      issues: checkLineBreaks(linesDetail, ctx.text, { segment: ctx.segment }),
      warnings: icuBreakWarnings(linesDetail, ctx.text),
      styleChecks,
      segmentation: ctx.segmentation ? ctx.segmentation.sources : [],
      groups: groupsAll.map((g) => ({ struck: g.struck.map((k) => g.para.chars[k].ch).join(''), rewrite: g.rewrite.map((k) => g.para.chars[k].ch).join(''), place: g.mode })),
      emphasis: units.filter((u) => u.emph && u.kind === 'text').map((u) => u.ch).join(''),
      paper,
      units: units.length,
      layoutSearch: { cost: +fit.total.toFixed(3), scale: +fit.scale.toFixed(3) },
    },
    seek,
    destroy() { svg.remove(); },
  };
}
