// 010 评论卡（互动元素，styles/010-comment-card）
//
// 风格契约见 engine/docs/写一个新风格.md。seek(t) 只看 t；不给整组设透明度；缩放小于 0.2 先隐藏；倾斜的东西不带模糊滤镜。
//
// 做法：口播答疑、回复评论时叠在画面上的一张评论卡：头像（昵称第一个字）、昵称、小标签、评论内容、点赞数。
//   卡片从下往上浮起来，内容按词断行（底座的分词，跟检查用同一套）；*关键词* 用荧光笔从左往右划一道。
//   版式是自己设计的：左边一道强调色竖条、圆角卡片、头像和昵称在一行，不照任何平台评论区的样子做。
// 造型预设：V1 日常（默认）；V3 招牌（卡片微微倾斜、砸进来，左上角一个大引号，划完重点冒几颗小爱心）。
// 质感（material）：candy 亮面糖果（默认）＝卡片底用底座的底座块零件（有厚度、白亮边、上沿高光，影子用渐变画、不用模糊滤镜），
//   头像圆用圆按钮零件；flat 平面＝原来的扁平卡片，这条代码路径没动过。

import { hash01 } from '../../engine/src/lib/rand.js';
import { mix, hexToRgb } from '../../engine/src/lib/color.js';
import { clamp, lerp, spring, easeOutCubic, easeInCubic, easeInBack } from '../../engine/src/lib/ease.js';
import { graphemes, fitText, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { f3 } from '../../engine/src/motions/index.js';
import { createParts } from '../../engine/src/parts/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const HEART = 'M0 3.4 C-3.6 0.7 -5 -1.4 -3.8 -3.3 C-2.5 -5.2 -0.6 -4.6 0 -2.9 C0.6 -4.6 2.5 -5.2 3.8 -3.3 C5 -1.4 3.6 0.7 0 3.4 Z';
// 标点挤压：只在行尾挤收尾标点（逗号句号、闭引号、闭括号），在行首挤开引号、开括号；两个标点连用时挤前一个。
// 问号、感叹号是居中的标点，不挤；句中的标点也不挤（11-20 看样片发现：句中的「！」挤了以后像英文的「!」）。
// 挤多少按画布量出的墨迹位置算，不按固定半格：换了字体，标点墨迹的位置会变（模板第 6 节）。
const CLOSERS = new Set([...'，。、；：」』”’）》〉】〕〗']);
const OPENERS = new Set([...'「『“‘（《〈【〔〖']);

// 量一个字的墨迹左右边界（相对于起笔点），挤标点时用
function makeInk(family) {
  const g = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (ch, px) => {
    const key = ch + '|' + px;
    if (cache.has(key)) return cache.get(key);
    g.font = `700 ${px}px ${family}`;
    const m = g.measureText(ch);
    const v = { l: -m.actualBoundingBoxLeft, r: m.actualBoundingBoxRight };
    cache.set(key, v);
    return v;
  };
}

function makeMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (ch, px) => {
    const key = ch + '|' + px;
    if (cache.has(key)) return cache.get(key);
    g.font = `700 ${px}px ${family}`;
    const w = g.measureText(ch).width;
    cache.set(key, w);
    return w;
  };
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const U = ctx.uid || 'hanzifx010';
  const seed = P.seed;
  const family = ctx.fontFamily(P.font);
  const measure = makeMeasurer(family);
  const ink = makeInk(family);
  const flair = clamp(P.flair ?? 0);
  const showcase = flair > 0;
  const portrait = H > W;

  // ---------- 尺寸 ----------
  const cardW = clamp(P.width ?? (portrait ? 0.84 : 0.5), 0.4, 0.92) * W;
  const pad = 0.06 * cardW;
  const avatarD = 0.115 * cardW;
  const nameFs = 0.04 * cardW;
  const labelFs = 0.03 * cardW;
  const fs0 = clamp(P.size ?? 0.062, 0.045, 0.09) * cardW;
  const lineH = 1.45;
  const innerW = cardW - 2 * pad - 0.012 * cardW; // 左边强调色竖条占一点宽

  // ---------- 评论内容排版：按词断行，放不下就缩，最多 maxLines 行 ----------
  const atomWidth = (px) => (text) => { let w = 0; for (const g of graphemes(text)) w += measure(g, px); return w; };
  const fit = fitText(ctx.text, {
    fs0, measureAt: atomWidth, maxWidthAt: () => innerW, maxLines: P.maxLines ?? 5, lineHeight: lineH, minScale: 0.7, segment: ctx.segment,
  });
  const fs = fit.fs;
  const lines = fit.lines;

  // ---------- 卡片高度和位置 ----------
  const headerH = Math.max(avatarD, nameFs * 1.4);
  const footerH = P.likes ? 0.07 * cardW : 0;
  const bodyH = lines.length * lineH * fs;
  const cardH = pad + headerH + 0.035 * cardW + bodyH + (footerH ? 0.02 * cardW + footerH : 0) + pad * 0.9;
  const cx = (P.x ?? 0.5) * W;
  const cyWant = (P.y ?? (portrait ? 0.3 : 0.32)) * H;
  const margin = 0.04 * Math.min(W, H);
  const cy = clamp(cyWant, margin + cardH / 2, H - margin - cardH / 2);
  const x0 = -cardW / 2; const y0 = -cardH / 2; // 卡片坐标：中心在原点

  // ---------- 搭 SVG ----------
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  el('feGaussianBlur', { stdDeviation: f3(cardW * 0.018) }, el('filter', { id: `${U}soft`, x: '-20%', y: '-20%', width: '140%', height: '160%' }, defs));
  const candy = P.material === 'candy';
  const kit = candy ? createParts(svg, { uid: U, material: 'candy', defs }) : null;
  const fx = el('g', {}, svg);
  const card = el('g', { visibility: 'hidden' }, svg);
  // 投影：日常用柔和投影；招牌会倾斜，倾斜加模糊滤镜乱序渲染对不上，所以用不模糊的硬投影
  // 糖果：卡片底是底座块（画进卡片组，显示跟着组走）。
  //   浅色卡片：侧壁用卡片色跟强调色、深色混出来的浅色（不垫一块灰板），最底下一道深一点的边线撑厚度；深色卡片用零件默认的压暗侧壁。
  //   招牌会倾斜，保留原来那道近黑的硬投影（往右下错开、几乎不透明），浅色、深色画面都压得住；日常用渐变画的地面软影子。
  const lightCard = (() => { const [r0, g0, b0] = hexToRgb(K.bg); return 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0 > 180; })();
  const cardSlab = candy
    ? kit.slab({
      x: x0, y: y0, w: cardW, h: cardH, radius: cardW * 0.045, color: K.bg, shade: 0.05, depth: cardW * 0.024, parent: card,
      ...(lightCard ? { sideColors: [mix(K.bg, K.accent, 0.1), mix(mix(K.bg, K.accent, 0.14), K.outer, 0.12)], sideEdge: mix(mix(K.bg, K.accent, 0.2), K.outer, 0.38), sideEdgeWidth: Math.max(1.5, cardW * 0.004) } : {}),
      ...(showcase
        ? { shadowStyle: 'drop', shadowColor: K.shadow, shadowOpacity: 0.85, shadowOffset: [cardW * 0.018, cardW * 0.022 - cardW * 0.012] }
        : { shadowStyle: 'soft' }),
    })
    : null;
  if (!candy) {
    if (showcase) el('rect', { x: f3(x0 + cardW * 0.018), y: f3(y0 + cardW * 0.022), width: f3(cardW), height: f3(cardH), rx: f3(cardW * 0.045), fill: K.shadow, 'fill-opacity': 0.85 }, card);
    else el('rect', { x: f3(x0), y: f3(y0 + cardW * 0.02), width: f3(cardW), height: f3(cardH), rx: f3(cardW * 0.045), fill: K.shadow, 'fill-opacity': 0.35, filter: `url(#${U}soft)` }, card);
    el('rect', { x: f3(x0), y: f3(y0), width: f3(cardW), height: f3(cardH), rx: f3(cardW * 0.045), fill: K.bg, stroke: K.outer, 'stroke-opacity': 0.12, 'stroke-width': f3(cardW * 0.003) }, card);
  }
  // 左边强调色竖条
  el('rect', { x: f3(x0 + pad * 0.42), y: f3(y0 + pad), width: f3(cardW * 0.012), height: f3(cardH - 2 * pad), rx: f3(cardW * 0.006), fill: K.accent }, card);
  // 招牌：左上角一个大引号
  if (showcase) {
    const q = el('text', { x: f3(x0 + cardW - pad * 1.6), y: f3(y0 + pad * 2.6), 'font-family': family, 'font-size': f3(cardW * 0.2), 'font-weight': 700, fill: K.accent, 'fill-opacity': 0.18, 'text-anchor': 'middle' }, card);
    q.textContent = '“';
  }
  // 头像（昵称第一个字）、昵称、小标签
  const ax = x0 + pad + 0.012 * cardW + avatarD / 2; const ay = y0 + pad + headerH / 2;
  const avatarG = el('g', {}, card);
  const avatarKey = candy ? kit.key({ shape: 'circle', cx: 0, cy: 0, r: avatarD / 2, color: K.accent, glow: false, parent: avatarG }) : null;
  if (!candy) el('circle', { cx: 0, cy: 0, r: f3(avatarD / 2), fill: K.accent }, avatarG);
  const initial = graphemes(String(P.name || '网友').trim())[0] || '友';
  const av = el('text', { x: 0, y: f3(avatarD * 0.17), 'text-anchor': 'middle', 'font-family': family, 'font-size': f3(avatarD * 0.48), 'font-weight': 700, fill: K.inner }, avatarG);
  av.textContent = initial;
  const nameX = ax + avatarD / 2 + 0.03 * cardW;
  const nameT = el('text', { x: f3(nameX), y: f3(ay + nameFs * 0.36), 'font-family': family, 'font-size': f3(nameFs), 'font-weight': 700, fill: K.sub }, card);
  nameT.textContent = String(P.name || '网友');
  let labelG = null;
  if (P.label) {
    const nameW = graphemes(String(P.name || '网友')).reduce((w, g) => w + measure(g, nameFs), 0);
    const lx = nameX + nameW + 0.03 * cardW;
    const lw = graphemes(String(P.label)).reduce((w, g) => w + measure(g, labelFs), 0) + labelFs * 1.1;
    labelG = el('g', {}, card);
    el('rect', { x: f3(lx), y: f3(ay - labelFs * 0.8), width: f3(lw), height: f3(labelFs * 1.6), rx: f3(labelFs * 0.8), fill: 'none', stroke: K.accent, 'stroke-width': f3(labelFs * 0.1) }, labelG);
    const lt = el('text', { x: f3(lx + lw / 2), y: f3(ay + labelFs * 0.36), 'text-anchor': 'middle', 'font-family': family, 'font-size': f3(labelFs), 'font-weight': 700, fill: K.accent }, labelG);
    lt.textContent = String(P.label);
  }
  // 评论内容：每个字单独放，关键词底下垫一道荧光笔
  const bodyX = x0 + pad + 0.012 * cardW;
  const bodyY = y0 + pad + headerH + 0.035 * cardW;
  const markLayer = el('g', {}, card);
  const textLayer = el('g', {}, card);
  const marks = []; // 每一段连续的关键词一道荧光笔
  lines.forEach((ln, li) => {
    let x = bodyX; const base = bodyY + (li + 0.78) * lineH * fs - (lineH - 1) * fs * 0.5;
    let run = null;
    const gs = graphemes(ln.text);
    gs.forEach((g, k) => {
      let w = measure(g, fs);
      const emph = ctx.isEmphasis(ln.paragraph, ln.index + k);
      // 行首的开引号往左挪，挪到墨迹离起点只剩一点空（最多挪半格）；
      // 行尾的收尾标点、连用标点的前一个，把墨迹右边多出来的空收掉（最多收半格）。两种都按墨迹量，不按固定半格
      let dx = 0;
      const gap = fs * 0.06;
      // 开引号、开括号：在行首，或者紧跟在别的标点后面（如「？（」），把左边的空收掉；前面的问号、感叹号本身不动
      if (OPENERS.has(g) && (k === 0 || FULLWIDTH_PUNCT.has(gs[k - 1]))) { dx = -clamp(ink(g, fs).l - gap, 0, w / 2); w += dx; }
      const squeeze = CLOSERS.has(g) && (k === gs.length - 1 || FULLWIDTH_PUNCT.has(gs[k + 1] || ''));
      if (squeeze) w = clamp(ink(g, fs).r + gap, w / 2, w);
      const t = el('text', { x: f3(x + dx), y: f3(base), 'font-family': family, 'font-size': f3(fs), 'font-weight': 700, fill: emph ? mix(K.fill, K.accent, 0.35) : K.fill }, textLayer);
      t.textContent = g;
      if (emph) { if (!run) run = { x0: x, x1: x + w, y: base, li }; else run.x1 = x + w; }
      else if (run) { marks.push(run); run = null; }
      x += w;
    });
    if (run) marks.push(run);
  });
  const markEls = marks.map((m) => el('rect', { x: f3(m.x0 - fs * 0.06), y: f3(m.y - fs * 0.42), width: f3(m.x1 - m.x0 + fs * 0.12), height: f3(fs * 0.55), rx: f3(fs * 0.12), fill: K.fill2, 'fill-opacity': 0.75 }, markLayer));
  // 点赞数（可选，不填就不显示，默认不编造数字）
  let likeG = null;
  if (P.likes) {
    likeG = el('g', {}, card);
    const ly = y0 + cardH - pad * 0.9 - footerH / 2;
    const lt = el('text', { x: f3(x0 + cardW - pad), y: f3(ly + labelFs * 0.4), 'text-anchor': 'end', 'font-family': family, 'font-size': f3(labelFs * 1.1), 'font-weight': 700, fill: K.sub, 'font-variant-numeric': 'tabular-nums' }, likeG);
    lt.textContent = String(P.likes);
    const tw = graphemes(String(P.likes)).reduce((w, g) => w + measure(g, labelFs * 1.1), 0);
    el('path', { d: HEART, transform: `translate(${f3(x0 + cardW - pad - tw - labelFs * 0.9)},${f3(ly)}) scale(${f3(labelFs * 0.16)})`, fill: K.accent }, likeG);
  }
  // 招牌：划完重点冒几颗小爱心
  const hearts = [];
  if (showcase && marks.length) {
    const last = marks.at(-1);
    for (let j = 0; j < 6; j++) {
      const h = (k) => hash01(seed, 'heart', j, k);
      hearts.push({ p: el('path', { d: HEART, fill: K.accent, opacity: 0 }, fx), sx: last.x1, sy: last.y - fs * 0.4, ang: -Math.PI / 2 + (h('a') - 0.5) * 1.6, dist: fs * lerp(0.8, 1.6, h('d')), size: fs * lerp(0.07, 0.12, h('s')), delay: h('t') * 0.08 });
    }
  }

  // ---------- 时间 ----------
  const R = P._rhythm; const k = R.speed ?? 1;
  const nChars = graphemes(ctx.text.replace(/\s/g, '')).length;
  const introEnd = 0.45 * k;
  const markStart = introEnd + 0.15 * k;
  const markDur = 0.32 * k;
  const holdEnd = introEnd + clamp(P.hold ?? (1.2 + nChars * 0.12), 1.8, 8) * (R.holdScale ?? 1);
  const outDur = 0.35 * k;
  const duration = holdEnd + outDur;
  const rot = showcase ? (hash01(seed, 'rot') < 0.5 ? -1 : 1) * 1.6 * flair : 0;

  function seek(t) {
    // 卡片：从下往上浮起来（招牌是砸进来），停留时轻轻浮动，出场往下沉、缩小
    let dy = 0; let s = 1;
    if (t < introEnd + 0.4 * k) {
      const p = spring(t, { freq: (showcase ? 2.8 : 2.1) / k, damping: showcase ? 0.5 : 0.62 });
      dy = (1 - p) * (showcase ? -0.06 : 0.08) * H;
      s = showcase ? 1.25 - 0.25 * p : 0.94 + 0.06 * p;
    }
    if (t > introEnd) dy += Math.sin(TAU * 0.5 * (t - introEnd)) * 0.0025 * H;
    const ou = clamp((t - holdEnd) / outDur);
    if (ou > 0) { dy += easeInCubic(ou) * 0.1 * H; s *= Math.max(0, 1 - easeInBack(ou, 1.4)); }
    const vis = t > 0 && ou < 1 && s > 0.2;
    set(card, { visibility: vis ? 'visible' : 'hidden', transform: `translate(${f3(cx)},${f3(cy + dy)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.2))})` });
    // 头像弹一下
    const at = t - 0.12 * k;
    const as = at <= 0 ? 0 : spring(at, { freq: 3 / k, damping: 0.45 });
    set(avatarG, { transform: `translate(${f3(ax)},${f3(ay)}) scale(${f3(Math.max(as, 0.001))})`, visibility: as > 0.2 ? 'visible' : 'hidden' });
    // 糖果零件画在卡片组、头像组里：只跟着组显示、隐藏（visibility 写 inherit），透明度、变换都不动
    if (cardSlab) cardSlab.set({ visible: 'inherit' });
    if (avatarKey) avatarKey.set({ visible: 'inherit' });
    // 荧光笔：一道一道从左往右划
    markEls.forEach((m, i) => {
      const u = easeOutCubic(clamp((t - markStart - i * markDur * 0.8) / markDur));
      const mk = marks[i];
      set(m, { transform: `translate(${f3(mk.x0)},0) scale(${f3(Math.max(u, 0.001))},1) translate(${f3(-mk.x0)},0)`, visibility: u > 0.01 ? 'visible' : 'hidden' });
    });
    // 招牌：小爱心
    const heartAt = markStart + Math.max(0, markEls.length - 1) * markDur * 0.8 + markDur;
    for (const hh of hearts) {
      const u = (t - heartAt - hh.delay) / (0.7 * k);
      if (u <= 0 || u >= 1 || !vis) { set(hh.p, { opacity: 0 }); continue; }
      const e = easeOutCubic(u);
      const x = cx + (hh.sx + Math.cos(hh.ang) * hh.dist * e) * s;
      const y = cy + dy + (hh.sy + Math.sin(hh.ang) * hh.dist * e) * s;
      set(hh.p, { opacity: 1 - u * u, transform: `translate(${f3(x)},${f3(y)}) scale(${f3(hh.size / 4 * (u < 0.15 ? u / 0.15 : 1))})` });
    }
  }

  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '卡片浮起', start: 0, end: introEnd },
      { name: 'hold', label: '停留（划重点）', start: introEnd, end: holdEnd },
      { name: 'outro', label: '出场', start: holdEnd, end: duration },
    ],
    beats: markEls.map((_, i) => ({ t: markStart + i * markDur * 0.8, name: 'mark', label: `第 ${i + 1} 道荧光笔开始划` })),
    units: lines.map((l, i) => ({ i, text: l.text })),
  };
  const layout = {
    fontSize: fs,
    lines: lines.map((l) => l.text),
    linesDetail: lines,
    forced: fit.forced || [],
    issues: checkLineBreaks(lines, ctx.text, { segment: ctx.segment }),
    warnings: icuBreakWarnings(lines, ctx.text),
    segmentation: ctx.segmentation ? ctx.segmentation.sources : [],
    emphasis: marks.length ? `${marks.length} 道荧光笔` : '',
    units: lines.length,
    card: { width: cardW, height: cardH },
  };
  seek(0);
  return { timeline, layout, seek, destroy() { svg.remove(); } };
}
