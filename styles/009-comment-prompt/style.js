// 009 「评论区告诉我」引导（互动元素，styles/009-comment-prompt）
//
// 风格契约见 engine/docs/写一个新风格.md。seek(t) 只看 t；不给整组设透明度；缩放小于 0.2 先隐藏；倾斜的东西不带模糊滤镜；
// 文字不做非等比缩放。
//
// 做法：口播结尾求评论。一个评论图标弹出来，旁边长出一个对话泡；泡里先是三个一跳一跳的点，像对方正在输入，
// 然后问题一个字一个字打出来（按词断行）；最后底下出一行小字「评论区告诉我」，配一个往下点的箭头。
// 图标、对话泡、箭头都是自己画的，不用任何平台的评论图标。
// 造型预设：V1 日常（默认）；V3 招牌（对话泡砸进来弹得更厉害，问题打完以后冒几个小对话泡，箭头跳得更欢）。
// 质感（material）：candy 亮面糖果（默认）＝评论图标的圆用圆按钮零件，对话泡用底座块（有厚度、白亮边、上沿高光，宽高照旧跟着打字长），
//   尾巴也带一截侧壁，底下小字垫不透明的糖果胶囊条；flat 平面＝原来的扁平图标、对话泡和半透明小字底，这条代码路径没动过。招牌的小泡两种质感一样。

import { hash01 } from '../../engine/src/lib/rand.js';
import { mix, hexToRgb } from '../../engine/src/lib/color.js';
import { clamp, lerp, spring, easeOutCubic, easeInCubic, easeInBack } from '../../engine/src/lib/ease.js';
import { graphemes, fitText, checkLineBreaks, icuBreakWarnings } from '../../engine/src/lib/text.js';
import { f3 } from '../../engine/src/motions/index.js';
import { createParts } from '../../engine/src/parts/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
// 尾巴死区：离静止值的偏差乘上它影响的尺寸（像素）不到 0.05，就直接落到静止值。
// 几乎没动的帧会让后面停住的画面随机出两种画法（engine/ADR-001「逐帧一致的几类坑」）
const toRest = (v, rest, reach) => (Math.abs(v - rest) * reach < 0.05 ? rest : v);
const TAU = Math.PI * 2;
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
// 行尾的收尾标点挤半格；问号、感叹号是居中的标点，不挤（跟 010 一样）
const CLOSERS = new Set([...'，。、；：」』”’）》〉】〕〗']);
// 评论图标：一个圆角对话框，里面三道横线（100×100 格子，自己画的）
const ICON = 'M22 24 L78 24 Q88 24 88 34 L88 62 Q88 72 78 72 L48 72 L32 86 L34 72 L22 72 Q12 72 12 62 L12 34 Q12 24 22 24 Z';
const ICON_LINES = 'M28 40 L72 40 M28 52 L60 52';

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
  const seed = P.seed;
  const family = ctx.fontFamily(P.font);
  const measure = makeMeasurer(family);
  const flair = clamp(P.flair ?? 0);
  const showcase = flair > 0;
  const portrait = H > W;
  const short = Math.min(W, H);
  const R = P._rhythm; const k = R.speed ?? 1;

  // ---------- 尺寸 ----------
  const iconD = clamp(P.size ?? 0.13, 0.08, 0.2) * short; // 评论图标的圆的直径
  const fs0 = iconD * 0.36; // 问题的字号
  const maxBubbleW = (portrait ? 0.7 : 0.42) * W;
  const padX = fs0 * 0.7; const padY = fs0 * 0.55;
  const lineH = 1.35;

  // ---------- 问题排版：按词断行，最多 2 行 ----------
  const atomWidth = (px) => (text) => { let w = 0; for (const g of graphemes(text)) w += measure(g, px); return w; };
  const fit = fitText(ctx.text, { fs0, measureAt: atomWidth, maxWidthAt: () => maxBubbleW - 2 * padX, maxLines: 2, lineHeight: lineH, minScale: 0.7, segment: ctx.segment });
  const fs = fit.fs; const lines = fit.lines;
  const lineWidths = lines.map((l) => graphemes(l.text).reduce((w, g, i, a) => w + measure(g, fs) * (i === a.length - 1 && CLOSERS.has(g) ? 0.5 : 1), 0));
  const bubbleW = Math.max(fs * 4.2, ...lineWidths) + 2 * padX;
  const bubbleH = lines.length * lineH * fs + 2 * padY - (lineH - 1) * fs;
  const gap = iconD * 0.22;
  const totalW = iconD + gap + bubbleW;
  const labelFs = fs * 0.74;
  const cx = (P.x ?? 0.5) * W;
  const cy = (P.y ?? (portrait ? 0.66 : 0.7)) * H;
  const left = cx - totalW / 2;
  const iconC = { x: left + iconD / 2, y: cy };
  const bubbleX = left + iconD + gap; const bubbleY = cy - bubbleH / 2;

  // ---------- 搭 SVG ----------
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
  root.appendChild(svg);
  const candy = P.material === 'candy';
  const kit = candy ? createParts(svg, { uid: ctx.uid ? `${ctx.uid}-cp` : 'cp009', material: 'candy' }) : null;
  // 评论图标（糖果：圆按钮零件画进图标组，显示跟着组走）
  const iconG = el('g', {}, svg);
  const iconKey = candy ? kit.key({ shape: 'circle', cx: 0, cy: 0, r: iconD / 2, color: K.accent, glow: false, parent: iconG }) : null;
  if (!candy) {
    el('circle', { cx: 0, cy: f3(iconD * 0.04), r: f3(iconD / 2), fill: K.shadow, 'fill-opacity': 0.25 }, iconG);
    el('circle', { cx: 0, cy: 0, r: f3(iconD / 2), fill: K.accent }, iconG);
  }
  const ig = el('g', { transform: `scale(${f3(iconD * 0.56 / 100)}) translate(-50,-55)` }, iconG);
  el('path', { d: ICON, fill: K.inner, stroke: 'none' }, ig);
  el('path', { d: ICON_LINES, fill: 'none', stroke: K.accent, 'stroke-width': 7, 'stroke-linecap': 'round' }, ig);
  // 对话泡（尾巴指向图标）
  const bubbleG = el('g', {}, svg);
  const r = Math.min(bubbleH / 2, fs * 0.7);
  const tail = `M${f3(0)} ${f3(bubbleH * 0.5 - fs * 0.32)} L${f3(-fs * 0.42)} ${f3(bubbleH * 0.5)} L${f3(0)} ${f3(bubbleH * 0.5 + fs * 0.32)} Z`;
  // 泡的宽高跟着输入进度长（真实聊天里，泡是跟着字一点点变宽的），所以先记下这两块，seek 里改宽高
  // 糖果：尾巴先画（侧壁一截、面一截），再画底座块盖住尾巴根；浅色泡的侧壁用泡的颜色混一点强调色，底下一道深边线
  let bubbleSlab = null, bubbleShadow = null, tailEl = null, bubbleRect = null;
  if (candy) {
    const [r0, g0, b0] = hexToRgb(K.bg);
    const light = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0 > 180;
    const depth = fs * 0.16;
    const sideTop = light ? mix(K.bg, K.accent, 0.12) : mix(K.bg, '#000000', 0.3);
    el('path', { d: tail, fill: sideTop, transform: `translate(0,${f3(depth)})` }, bubbleG);
    el('path', { d: tail, fill: K.bg }, bubbleG);
    bubbleSlab = kit.slab({
      x: 0, y: 0, w: bubbleW, h: bubbleH, radius: r, color: K.bg, shade: 0.05, depth, parent: bubbleG,
      ...(light ? { sideColors: [sideTop, mix(mix(K.bg, K.accent, 0.16), K.outer, 0.12)], sideEdge: mix(mix(K.bg, K.accent, 0.22), K.outer, 0.38) } : {}),
    });
  } else {
    bubbleShadow = el('rect', { x: 0, y: f3(iconD * 0.04), width: f3(bubbleW), height: f3(bubbleH), rx: f3(r), fill: K.shadow, 'fill-opacity': 0.22 }, bubbleG);
    tailEl = el('path', { d: tail, fill: K.bg }, bubbleG);
    bubbleRect = el('rect', { x: 0, y: 0, width: f3(bubbleW), height: f3(bubbleH), rx: f3(r), fill: K.bg }, bubbleG);
  }
  // 正在输入的三个点
  const dots = [0, 1, 2].map((i) => el('circle', { cx: f3(padX + fs * (0.35 + i * 0.62)), cy: f3(bubbleH / 2), r: f3(fs * 0.17), fill: mix(K.fill, K.bg, 0.45) }, bubbleG));
  // 问题文字：每个字单独放，打字时一个一个出现；整组跟着泡的高度上下居中
  const textG = el('g', {}, bubbleG);
  const chars = [];
  lines.forEach((ln, li) => {
    let x = padX; const base = padY + (li + 0.82) * lineH * fs - (lineH - 1) * fs * 0.55;
    const gs = graphemes(ln.text);
    gs.forEach((g, i) => {
      const emph = ctx.isEmphasis(ln.paragraph, ln.index + i);
      const t = el('text', { x: f3(x), y: f3(base), 'font-family': family, 'font-size': f3(fs), 'font-weight': 700, fill: emph ? K.accent : K.fill, visibility: 'hidden' }, textG);
      t.textContent = g;
      x += measure(g, fs);
      chars.push({ t, right: x, line: li });
    });
  });
  // 底下的小字和箭头
  const labelG = el('g', {}, svg);
  const label = String(P.label ?? '评论区告诉我');
  const labelW = graphemes(label).reduce((w, g) => w + measure(g, labelFs), 0);
  // 糖果：小字底下换成不透明的糖果胶囊条（底座块零件，两头圆到头），跟 014、015 的提示语一样；
  //   颜色跟着字走：字是浅色就用深色胶囊（投影色提亮一点），字是深色（C4）就用浅色胶囊
  let labelSlab = null;
  if (candy) {
    const [sr, sg, sb] = hexToRgb(K.sub);
    const lightText = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb > 140;
    const ph = labelFs * 1.56;
    labelSlab = kit.slab({ x: -labelW / 2 - labelFs * 1.1, y: -ph / 2, w: labelW + labelFs * 2.1, h: ph, radius: ph / 2, color: lightText ? mix(K.shadow, '#FFFFFF', 0.16) : mix(K.bg, '#FFFFFF', 0.5), depth: 0.18 * ph, parent: labelG });
  } else el('rect', { x: f3(-labelW / 2 - labelFs * 1.1), y: f3(-labelFs * 0.78), width: f3(labelW + labelFs * 2.1), height: f3(labelFs * 1.56), rx: f3(labelFs * 0.78), fill: K.shadow, 'fill-opacity': 0.38 }, labelG);
  const lt = el('text', { x: f3(-labelW / 2 - labelFs * 0.5), y: f3(labelFs * 0.36), 'font-family': family, 'font-size': f3(labelFs), 'font-weight': 700, fill: K.sub, stroke: K.shadow, 'stroke-opacity': 0.55, 'stroke-width': f3(labelFs * 0.16), 'paint-order': 'stroke', 'stroke-linejoin': 'round' }, labelG);
  lt.textContent = label;
  const arrowG = el('g', {}, labelG);
  const aw = labelFs * 0.7;
  el('path', { d: `M${f3(-aw * 0.5)} ${f3(-aw * 0.15)} L0 ${f3(aw * 0.45)} L${f3(aw * 0.5)} ${f3(-aw * 0.15)}`, fill: 'none', stroke: K.sub, 'stroke-width': f3(labelFs * 0.16), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, arrowG);
  const labelPos = { x: cx, y: cy + Math.max(bubbleH, iconD) / 2 + labelFs * 1.5 };
  // 招牌：问题打完以后冒出来的小对话泡
  const pops = [];
  if (showcase) {
    for (let j = 0; j < 4; j++) {
      const h = (kk) => hash01(seed, 'pop', j, kk);
      const w = fs * lerp(0.9, 1.4, h('w')); const hh = w * 0.62;
      const g = el('g', { visibility: 'hidden' }, svg);
      el('rect', { x: f3(-w / 2), y: f3(-hh / 2), width: f3(w), height: f3(hh), rx: f3(hh / 2), fill: j % 2 ? K.accent : K.bg, stroke: K.shadow, 'stroke-opacity': 0.2, 'stroke-width': f3(fs * 0.04) }, g);
      for (let d = 0; d < 3; d++) el('circle', { cx: f3((d - 1) * w * 0.22), cy: 0, r: f3(hh * 0.11), fill: j % 2 ? K.bg : K.accent }, g);
      pops.push({ g, sx: bubbleX + bubbleW * lerp(0.3, 1, h('x')), sy: bubbleY, dx: (h('dx') - 0.3) * fs * 2.4, dy: -fs * lerp(1.4, 2.6, h('dy')), delay: j * 0.09 * k, rot: (h('r') - 0.5) * 20 });
    }
  }

  // ---------- 时间 ----------
  const iconIn = 0; const bubbleIn = 0.18 * k; const typingStart = 0.45 * k;
  const typingDur = (P.typing ?? 0.7) * k; // 正在输入的点跳多久
  const charStep = 0.045 * k;
  const typeStart = typingStart + typingDur;
  const typeEnd = typeStart + chars.length * charStep;
  const labelIn = typeEnd + 0.12 * k;
  const holdEnd = labelIn + clamp(P.hold ?? 1.8, 0.8, 8) * (R.holdScale ?? 1);
  const outDur = 0.32 * k;
  const duration = holdEnd + outDur;

  function seek(t) {
    const ou = clamp((t - holdEnd) / outDur);
    const outS = Math.max(0, 1 - easeInBack(ou, 1.4));
    // 图标：弹出来
    const is = (t - iconIn <= 0 ? 0 : toRest(spring(t - iconIn, { freq: 2.8 / k, damping: 0.45 }), 1, iconD)) * outS;
    set(iconG, { visibility: is > 0.2 ? 'visible' : 'hidden', transform: `translate(${f3(iconC.x)},${f3(iconC.y)}) scale(${f3(Math.max(is, 0.2))})` });
    if (iconKey) iconKey.set({ visible: 'inherit' });
    // 对话泡：从图标那边长出来（以左侧中点为原点放大），招牌弹得更厉害
    const bt = t - bubbleIn;
    const bs = (bt <= 0 ? 0 : toRest(spring(bt, { freq: (showcase ? 3.2 : 2.6) / k, damping: showcase ? 0.38 : 0.5 }), 1, bubbleW)) * outS;
    // 停留时轻轻上下浮
    const bob = t > labelIn ? Math.sin(TAU * 0.6 * (t - labelIn)) * fs * 0.06 : 0;
    set(bubbleG, { visibility: bs > 0.2 ? 'visible' : 'hidden', transform: `translate(${f3(bubbleX)},${f3(bubbleY + bob)}) translate(0,${f3(bubbleH / 2)}) scale(${f3(Math.max(bs, 0.2))}) translate(0,${f3(-bubbleH / 2)})` });
    // 正在输入：三个点依次跳；开始打字就消失
    const typing = t >= typingStart && t < typeStart;
    dots.forEach((d, i) => {
      const ph = (t - typingStart) * 2.4 / k - i * 0.18;
      const jump = typing ? Math.max(0, Math.sin(TAU * ph)) * fs * 0.22 : 0;
      set(d, { visibility: typing ? 'visible' : 'hidden', cy: bubbleH / 2 - jump });
    });
    // 打字：一个字一个字出现
    let typed = 0;
    chars.forEach((c, i) => { const on = t >= typeStart + i * charStep; if (on) typed = i + 1; set(c.t, { visibility: on ? 'visible' : 'hidden' }); });
    // 泡的大小：输入时只有三个点那么宽；打字时宽到已经打出来的字；两行的问题打到第二行才变高
    const dotsW = padX * 2 + fs * 1.7;
    let w = dotsW; let nLines = 1;
    if (t >= typeStart && typed > 0) {
      const last = chars[typed - 1];
      nLines = last.line + 1;
      const widest = nLines > 1 ? Math.max(...lineWidths.slice(0, nLines - 1)) : 0;
      w = Math.max(dotsW, widest + 2 * padX, last.right + padX);
    }
    if (t >= typeEnd) { w = bubbleW; nLines = lines.length; }
    const hNow = nLines * lineH * fs + 2 * padY - (lineH - 1) * fs;
    const yOff = (bubbleH - hNow) / 2; // 泡上下居中
    if (candy) {
      bubbleSlab.place({ x: 0, w, y: yOff, h: hNow, r: Math.min(hNow / 2, r) });
      bubbleSlab.set({ visible: 'inherit' });
    } else {
      set(bubbleRect, { width: w, height: hNow, y: yOff, rx: Math.min(hNow / 2, r) });
      set(bubbleShadow, { width: w, height: hNow, y: yOff + iconD * 0.04, rx: Math.min(hNow / 2, r) });
    }
    set(textG, { transform: `translate(0,${f3(yOff)})` }); // 字跟着泡居中（第一版打第一行时字顶出了泡）
    // 小字和箭头：问题打完以后出现，箭头往下点
    const lu = t - labelIn;
    const ls = (lu <= 0 ? 0 : toRest(spring(lu, { freq: 2.6 / k, damping: 0.55 }), 1, labelW + labelFs * 2.1)) * outS;
    set(labelG, { visibility: ls > 0.2 ? 'visible' : 'hidden', transform: `translate(${f3(labelPos.x)},${f3(labelPos.y)}) scale(${f3(Math.max(ls, 0.2))})` });
    if (labelSlab) labelSlab.set({ visible: 'inherit' });
    const hop = lu > 0 ? Math.abs(Math.sin(TAU * (showcase ? 1.6 : 1.2) * lu)) * labelFs * (showcase ? 0.35 : 0.22) : 0;
    set(arrowG, { transform: `translate(${f3(labelW / 2 + labelFs * 0.1)},${f3(hop - labelFs * 0.05)})` });
    // 招牌：冒小对话泡
    for (const p of pops) {
      const u = (t - typeEnd - p.delay) / (0.8 * k);
      if (u <= 0 || u >= 1 || ou > 0) { set(p.g, { visibility: 'hidden' }); continue; }
      const e = easeOutCubic(u);
      const sc = (u < 0.25 ? spring(u * 0.8, { freq: 3, damping: 0.5 }) : 1) * (1 - easeInCubic(clamp((u - 0.7) / 0.3)));
      set(p.g, { visibility: sc > 0.2 ? 'visible' : 'hidden', transform: `translate(${f3(p.sx + p.dx * e)},${f3(p.sy + p.dy * e)}) rotate(${f3(p.rot * e)}) scale(${f3(Math.max(sc, 0.2))})` });
    }
  }

  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '图标和对话泡弹出', start: 0, end: typingStart },
      { name: 'typing', label: '正在输入', start: typingStart, end: typeStart },
      { name: 'type', label: '打出问题', start: typeStart, end: typeEnd },
      { name: 'hold', label: '停留（评论区告诉我）', start: labelIn, end: holdEnd },
      { name: 'outro', label: '出场', start: holdEnd, end: duration },
    ],
    beats: [
      { t: typeStart, name: 'type', label: '开始打字（配键盘声）' },
      { t: labelIn, name: 'label', label: '「评论区告诉我」出现（配「叮」）' },
    ],
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
    emphasis: '',
    units: lines.length,
  };
  seek(0);
  return { timeline, layout, seek, destroy() { svg.remove(); } };
}
