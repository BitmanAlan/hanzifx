// 015 点赞收藏引导（Single Tap）· 互动元素
// 只求一个动作：手按下点赞（按钮亮起弹一下）、双击屏幕冒爱心、收藏星点亮转一圈、转发箭头往右弹；旁边一句提示语。默认透明底。
// 参数（见 meta.json）：text 提示语（空着按模式自动配）、kind（like / double / save / share）、look、palette、rhythm、font、
//   hand、plusOne、size、flair、particles、material、x、y、seed。
// 质感：material=flat 平面是原来的画法，一个元素、一个属性都没改；默认 candy 亮面糖果：按钮换成底座的圆按钮零件，
//   没点亮是灰色糖果按钮、白色实心图标，手按下去按钮面往下陷，点亮那一下主色盖上来、扫过一道高光；提示语底下的胶囊条换成底座块；
//   双击的爱心加一层径向渐变和镜面高光。手、粒子、放射光两种质感一样。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；透明度只设在单个图形上；不用模糊滤镜；
//   图标、手跟 006 是同一套画法（本项目自己画的），不仿任何平台。
import { hash01 } from '../../engine/src/lib/rand.js';
import { mix } from '../../engine/src/lib/color.js';
import { clamp, lerp, spring, easeOutCubic, easeInCubic, easeOutBack, easeInOutCubic } from '../../engine/src/lib/ease.js';
import { graphemes, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { f3, shineSweep } from '../../engine/src/motions/index.js';
import { createParts, PRESS_SINK, SWEEP_WIDTH } from '../../engine/src/parts/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');

function starPath(cx, cy, R, r, n = 5) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rad = i % 2 === 0 ? R : r;
    pts.push(`${f3(cx + rad * Math.cos(a))} ${f3(cy + rad * Math.sin(a))}`);
  }
  return `M${pts.join(' L')} Z`;
}
// 图标：画在 100×100 的格子里，中心 (50,50)；跟 006 同一套画法
const ICONS = {
  like: [
    'M31 47 L44.5 22 C46.5 16.5 55 15.5 57.5 21.5 C59 25.5 58.5 31 56 38 L54 45 L77 45 C84.5 45 89 51.5 87 58 L81.5 79 C80.5 84 76.5 87 71.5 87 L31 87 Z',
    'M17.5 47 L24.5 47 Q28 47 28 50.5 L28 83.5 Q28 87 24.5 87 L17.5 87 Q14 87 14 83.5 L14 50.5 Q14 47 17.5 47 Z',
  ],
  save: [starPath(50, 53, 38, 16.5)],
  share: ['M19 73 C23 49.5 39.5 39 60 39 L60 25 L86 49.5 L60 74 L60 59.5 C44 59.5 31.5 63.5 19 73 Z'],
  heart: ['M50 86 C24 66 12 52 14 36 C16 22 30 15 41 21 C45 23 48 27 50 31 C52 27 55 23 59 21 C70 15 84 22 86 36 C88 52 76 66 50 86 Z'],
};
// 手：食指朝上的简笔画，指尖在 (44,6)
const HAND = 'M36 13 C36 4.5 52 4.5 52 13 L52 44 C54.5 39.5 62.5 39.5 64 45.5 C66 40.5 74.5 41 75.5 47.5 C77.5 43.5 85 45 85 51.5 L85 70 C85 84.5 74.5 94.5 60 94.5 L50.5 94.5 C40.5 94.5 33.5 88.5 30 80 L21.5 62 C19.5 56.5 25.5 52.5 30.5 57 L36 63.5 Z';
const HAND_TIP = { x: 44, y: 6 };
// 粒子外形：中心 (0,0)、半径约 4
const SHAPES = {
  heart: 'M0 3.4 C-3.6 0.7 -5 -1.4 -3.8 -3.3 C-2.5 -5.2 -0.6 -4.6 0 -2.9 C0.6 -4.6 2.5 -5.2 3.8 -3.3 C5 -1.4 3.6 0.7 0 3.4 Z',
  star: starPath(0, 0.3, 4.4, 1.9),
  dot: 'M0 -3 A3 3 0 1 1 -0.01 -3 Z',
};
const AUTO = { like: '点个赞吧', double: '双击屏幕', save: '先收藏，慢慢看', share: '转给需要的人' };

const OPEN_P = new Set([...'（《「『【〔〈〖“‘']);
const CLOSE_P = new Set([...'，。、；：）》」』】〕〉〗”’']);
/** 要读的字只在三处挤（模板第 6 节）：行尾的收尾标点、行首的开引号开括号、两个标点连用。问号感叹号、句中单个的逗号句号都不挤 */
function squeezeAt(gs, i) {
  const ch = gs[i];
  if (CLOSE_P.has(ch)) return i === gs.length - 1 || FULLWIDTH_PUNCT.has(gs[i + 1]);
  if (OPEN_P.has(ch)) return i === 0 || FULLWIDTH_PUNCT.has(gs[i - 1]);
  return false;
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const family = ctx.fontFamily(P.font);
  const flair = clamp(P.flair ?? 0);
  const kind = ['like', 'double', 'save', 'share'].includes(P.kind) ? P.kind : 'like';
  const k = R.speed ?? 1;
  const h = (...a) => hash01(seed, ...a);
  const userText = String(ctx.text || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const label = userText || AUTO[kind];
  const litColor = kind === 'like' || kind === 'double' ? K.accent : K.fill2;
  const candy = P.material === 'candy';

  // ---------- 量字：要挤的标点（见 squeezeAt）按墨迹挤窄，用画布量出墨迹位置，不按固定量挪 ----------
  const g2 = document.createElement('canvas').getContext('2d');
  g2.font = `100px ${family}`; g2.textAlign = 'center';
  const meas = (ch, sq) => {
    const m = g2.measureText(ch);
    if (sq) { const L = -m.actualBoundingBoxLeft / 100; const Rr = m.actualBoundingBoxRight / 100; const adv = Math.max(0.5, Rr - L + 0.16); return { adv, off: 0.08 - L }; }
    return { adv: m.width / 100, off: m.width / 200 };
  };

  // ---------- 版式 ----------
  const single = kind !== 'double';
  const labelGs = graphemes(label);
  const chars = labelGs.map((ch, i) => ({ ch, ...meas(ch, squeezeAt(labelGs, i)) }));
  const labelEm = chars.reduce((s, c) => s + c.adv, 0);
  const m = 0.05 * short; // 离画面边缘至少留这么多
  // 按钮在左、提示语的胶囊条从按钮后面伸出来。总宽度（按按钮直径算）＝ 按钮 1 ＋ 间隙 0.22 ＋ 字 0.3×字数 ＋ 右边距 0.15；
  // 按钮左边还要留出光晕（半径 1.14 个直径）和 V3 的放射光（1.37 个直径）。装不下就整体缩小按钮和字号
  const decoL = flair > 0 ? 1.37 : 1.14;
  let D = clamp(P.size ?? 0.2, 0.1, 0.32) * short; // 按钮直径
  if (single) D = Math.min(D, (W - 2 * m) / (1 + 0.22 + 0.3 * labelEm + 0.15 - 0.5 + decoL));
  const r = D / 2;
  const fs = 0.3 * D; // 提示语字号
  const labelW = labelEm * fs;
  const cx = (P.x ?? 0.5) * W;
  const gap = 0.22 * D; const padR = 0.5 * fs;
  const pillH = 0.62 * D;
  const pillW = single ? r + gap + labelW + padR : labelW + 2 * padR;
  const totalW = single ? r + pillW : pillW;
  // 双击模式：没有按钮，爱心和下面的提示语当一组，按整组的高度居中；超出底边就整组往上挪
  const heartH = 0.36 * short;
  const groupH = heartH + 0.06 * short + pillH;
  let cy = (P.y ?? (single ? (vertical ? 0.62 : 0.66) : 0.48)) * H;
  if (!single) cy = clamp(cy, m + groupH / 2, H - m - groupH / 2);
  const discX = single ? clamp(cx - totalW / 2 + r, m + decoL * D, W - m - (totalW - r)) : cx;
  const discY = cy;
  const pillX0 = single ? discX : cx - pillW / 2; // 胶囊条左边
  const heartC = { x: cx, y: single ? cy : cy - groupH / 2 + heartH / 2 };
  const pillY = single ? cy : cy + groupH / 2 - pillH / 2;
  const textX0 = single ? discX + r + gap : cx - labelW / 2;
  const iconS = (0.58 * D) / 100; // 图标从 100 格缩到按钮里
  const handS = (0.95 * D) / 100;

  // ---------- 时间轴 ----------
  const tLabel = 0.15 * k;
  const tHandIn = 0.25 * k; const tPress = 0.55 * k; const tLit = 0.68 * k; const tHandOut = 0.85 * k;
  const taps = kind === 'double' ? [0.5 * k, 0.8 * k] : [];
  const tLast = kind === 'double' ? taps[1] : tLit;
  const holdEnd = tLast + 1.7 + (R.holdExtra ?? 0);
  const outDur = 0.3;
  const outroEnd = holdEnd + outDur;
  const duration = outroEnd + 0.1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: 0.3 * k },
      { name: 'tap', label: kind === 'double' ? '双击、冒爱心' : '按下、点亮', start: tHandIn, end: tLast + 0.4 },
      { name: 'hold', label: '停留', start: tLast + 0.4, end: holdEnd },
      { name: 'outro', label: '出场', start: holdEnd, end: outroEnd },
    ],
    beats: kind === 'double' ? taps.map((t, i) => ({ t, name: 'tap', label: `第 ${i + 1} 下` })) : [{ t: tLit, name: 'lit', label: '点亮' }],
    units: chars.map((c, i) => ({ i, char: c.ch, enter: tLabel + i * 0.03 * k, exitStart: holdEnd, exitEnd: outroEnd })),
  };

  // ---------- 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-st` : 'st' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  const gr = el('radialGradient', { id: `${uid}-glow` }, defs);
  el('stop', { offset: '0', 'stop-color': litColor, 'stop-opacity': 0.6 }, gr);
  el('stop', { offset: '0.55', 'stop-color': litColor, 'stop-opacity': 0.18 }, gr);
  el('stop', { offset: '1', 'stop-color': litColor, 'stop-opacity': 0 }, gr);
  if (candy && kind === 'double') {
    const lighten = (c, k) => mix(c, '#FFFFFF', k); const darken = (c, k) => mix(c, '#000000', k);
    const hf = el('radialGradient', { id: `${uid}-hface`, cx: '0.35', cy: '0.3', r: '0.8' }, defs);
    [[0, lighten(K.accent, 0.3)], [0.55, K.accent], [1, darken(K.accent, 0.28)]].forEach(([o, c]) => el('stop', { offset: f3(o), 'stop-color': c }, hf));
    const hg = el('linearGradient', { id: `${uid}-hgloss`, x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    el('stop', { offset: '0', 'stop-color': '#FFFFFF', 'stop-opacity': 0.85 }, hg);
    el('stop', { offset: '1', 'stop-color': '#FFFFFF', 'stop-opacity': 0.1 }, hg);
  }
  // 三层：背景（光晕、放射光、涟漪、粒子）在胶囊条底下，提示语那组压在它们上面，按钮、爱心、「+1」、手在最上面。
  // 这三个 <g> 只当容器，不加透明度也不加变换
  const back = el('g', {}, svg); const mid = el('g', {}, svg); const front = el('g', {}, svg);
  const glowC = single ? { x: discX, y: discY } : heartC;
  const glow = el('circle', { cx: 0, cy: 0, r: f3(single ? r * 1.9 : 0.3 * short), fill: `url(#${uid}-glow)` }, back);
  // 胶囊条和提示语
  const pill = candy ? null : el('rect', { x: 0, y: f3(-pillH / 2), width: f3(pillW), height: f3(pillH), rx: f3(pillH / 2), fill: K.bg }, mid);
  // 糖果：胶囊条换成底座块（不透明：糖果一层叠一层，半透明会透出侧壁）；单个按钮时宽度每帧跟着伸出来，用 place 改
  const kitMid = candy ? createParts(svg, { uid: `${uid}-pm`, material: 'candy', defs, parent: mid }) : null;
  const kitTop = candy ? createParts(svg, { uid: `${uid}-pk`, material: 'candy', defs, parent: front }) : null;
  const pillSlab = candy ? kitMid.slab({ y: pillY - pillH / 2, h: pillH, radius: pillH / 2, color: K.bg, depth: 0.16 * pillH }) : null;
  if (pillSlab && !single) pillSlab.place({ x: pillX0, w: pillW });
  const charNodes = chars.map((c, i) => {
    const t = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(fs), fill: K.sub }, mid);
    t.textContent = c.ch;
    return { ...c, t, i };
  });
  let acc = 0;
  for (const c of charNodes) { c.x = textX0 + (acc + c.off) * fs; acc += c.adv; }
  // 放射光（V3）
  const rayBase = single ? D : 0.3 * short;
  const rayRoom = Math.min(glowC.x, W - glowC.x, glowC.y, H - glowC.y) - 0.05 * short - 0.32 * D;
  const rayMax = clamp(rayRoom / rayBase, 0.2, 1.05); // 放射光最远到哪：不出画面
  const rays = flair > 0 ? [...Array(10).keys()].map((i) => ({ e: el('line', { x1: 0, y1: 0, x2: f3(0.32 * D), y2: 0, stroke: litColor, 'stroke-width': f3(0.045 * D), 'stroke-linecap': 'round' }, back), ang: (i / 10) * TAU + h('ra', i) * 0.3 })) : [];
  // 按钮
  let disc = null; let ring = null; let icon = null; let key = null;
  // 糖果：图标白色实心（亮色点亮时换深色，不然白按钮上看不见），底下压一份往下错开的淡黑硬投影；按下去时整个图标跟着按钮面往下挪
  const lumOf = (hex) => { const v = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const IDLE = '#3A3A42';
  const iconLit = lumOf(litColor) > 0.75 ? K.outer : '#FFFFFF';
  if (single && candy) {
    key = kitTop.key({ shape: 'circle', cx: discX, cy: discY, r, color: litColor, idleColor: IDLE, glow: false }); // 光晕用后面那层，零件自己的不要
    const g = el('g', {}, front);
    const inner = el('g', { transform: `scale(${f3(iconS)}) translate(-50,-50)` }, g);
    const off = (0.02 * D) / iconS;
    for (const d of ICONS[kind]) el('path', { d, fill: '#000000', 'fill-opacity': 0.12, transform: `translate(0,${f3(off)})` }, inner);
    const bodies = ICONS[kind].map((d) => el('path', { d, fill: '#FFFFFF', stroke: '#FFFFFF', 'stroke-width': 2, 'stroke-linejoin': 'round' }, inner));
    icon = { g, bodies };
  } else if (single) {
    disc = el('circle', { cx: 0, cy: 0, r: f3(r), fill: K.bg }, front);
    ring = el('circle', { cx: 0, cy: 0, r: f3(r * 0.97), fill: 'none', stroke: K.fill, 'stroke-width': f3(0.035 * D) }, front);
    const g = el('g', {}, front);
    const inner = el('g', { transform: `scale(${f3(iconS)}) translate(-50,-50)` }, g);
    const bodies = ICONS[kind].map((d) => el('path', { d, fill: 'none', stroke: K.fill, 'stroke-width': 7, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, inner));
    icon = { g, bodies };
  }
  // 双击：两颗大爱心、两圈涟漪
  const hearts = kind === 'double' ? taps.map((t, i) => {
    const g = el('g', {}, front);
    const size = (i === 0 ? 0.3 : 0.36) * short / 100;
    const inner = el('g', { transform: `scale(${f3(size)}) translate(-50,-50)` }, g);
    const out = el('path', { d: ICONS.heart[0], fill: K.outer, stroke: K.outer, 'stroke-width': 9, 'stroke-linejoin': 'round' }, inner);
    const body = el('path', { d: ICONS.heart[0], fill: candy ? `url(#${uid}-hface)` : K.accent }, inner);
    // 糖果：爱心面换成径向渐变（左上亮、右下暗），左上一块镜面高光
    const gloss = candy ? el('ellipse', { cx: 33, cy: 33, rx: 12, ry: 7.5, transform: 'rotate(-38 33 33)', fill: `url(#${uid}-hgloss)` }, inner) : null;
    const ripple = el('circle', { cx: 0, cy: 0, r: f3(0.12 * short), fill: 'none', stroke: K.inner, 'stroke-width': f3(0.012 * short) }, back);
    return { g, parts: [out, body, ...(gloss ? [gloss] : [])], ripple, t, tilt: (h('ht', i) - 0.5) * 28, dx: (h('hx', i) - 0.5) * 0.08 * short, rise: lerp(0.18, 0.26, h('hr', i)) * short };
  }) : [];
  // 「+1」
  const plus = single && kind !== 'share' && P.plusOne !== false ? el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(0.3 * D), fill: litColor, stroke: K.outer, 'stroke-width': f3(0.035 * D), 'paint-order': 'stroke' }, front) : null;
  if (plus) plus.textContent = '+1';
  // 转发的速度线
  const speed = kind === 'share' ? [0, 1, 2].map((i) => el('line', { x1: 0, y1: 0, x2: f3(-0.22 * D), y2: 0, stroke: litColor, 'stroke-width': f3(0.04 * D), 'stroke-linecap': 'round' }, front)) : [];
  // 粒子
  const nP = Math.round(P.particles ?? 10);
  const shape = kind === 'save' ? 'star' : kind === 'share' ? 'dot' : 'heart';
  const parts = [...Array(nP).keys()].map((i) => {
    const ang = -Math.PI / 2 + (h('pa', i) - 0.5) * (kind === 'double' ? 2.6 : TAU * 0.85);
    const sz = lerp(0.9, 1.6, h('ps', i)) * (single ? D : 0.5 * D) / 40;
    // 最远飞到哪：不出画面（留边距和粒子自身大小），免得描边贴边被裁
    const o = single ? { x: discX, y: discY } : heartC;
    const margin = 0.05 * short + 5 * sz;
    const room = (c, dir, hi) => (dir > 1e-6 ? (hi - margin - c) / dir : dir < -1e-6 ? (margin - c) / dir : Infinity);
    const maxD = Math.max(0.3 * D, Math.min(room(o.x, Math.cos(ang), W), room(o.y, Math.sin(ang) - 0.15, H)));
    const dist = Math.min(lerp(0.65, 1.25, h('pd', i)) * (single ? D : 0.28 * short), maxD);
    const e = el('path', { d: SHAPES[shape], fill: h('pc', i) < 0.65 ? litColor : K.inner }, back);
    const at = kind === 'double' ? taps[i % 2] : tLit;
    return { e, ang, dist, sz, at: at + h('pt', i) * 0.06, spin: (h('pr', i) - 0.5) * 300 };
  });
  // 手
  const handG = P.hand !== false ? el('g', {}, front) : null;
  let handPath = null;
  if (handG) {
    const inner = el('g', { transform: `scale(${f3(handS)}) translate(${-HAND_TIP.x},${-HAND_TIP.y})` }, handG);
    handPath = el('path', { d: HAND, fill: K.inner === K.fill ? '#FFFFFF' : K.inner, stroke: K.outer, 'stroke-width': 5.5, 'stroke-linejoin': 'round' }, inner);
  }

  // ---------- 每一帧 ----------
  function seek(time) {
    const t = clamp(time, 0, duration);
    const qOut = easeInCubic(clamp((t - holdEnd) / outDur));
    const outS = Math.max(1 - qOut, 0.001);
    // 「几乎没动」的帧直接取静止值：动作尾巴只差零点零几个像素时，浏览器抗锯齿会随机画成两种，乱序渲染对不上（008、012 踩过）。
    // 门槛：位移不到 0.05 像素、缩放差乘尺寸不到 0.05 像素、转角不到 0.02 度
    const still = (v, rest, size) => (Math.abs(v - rest) * size < 0.05 ? rest : v);
    const enter = still(clamp(spring(t, { freq: 2.5 / k, damping: 0.5 })), 1, Math.max(D, pillW));
    const on = enter * outS > 0.002;
    // 点亮那一下
    const litU = t - tLit;
    const lit = single && litU >= 0;
    // 胶囊条：从按钮后面伸出来
    const pillP = easeOutCubic(clamp((t - 0.08 * k) / (0.3 * k)));
    const bump = single ? still(1 + (0.06 + 0.08 * flair) * Math.max(0, Math.sin(Math.PI * clamp(litU / 0.35))), 1, pillH) : 1;
    const pw = single ? Math.max(pillW * pillP, 0.001) : pillW;
    if (pillSlab) {
      if (single) pillSlab.place({ x: pillX0, w: pw });
      let ps = single ? outS : Math.max(enter * outS, 0.001);
      if (Math.abs(ps - 1) < 0.003) ps = 1; // 放大偏差不到 0.3%，当成没动
      const ox = single ? pillX0 : pillX0 + pillW / 2;
      pillSlab.set({ visible: on && pillP > 0.002, transform: `translate(${f3(ox)},${f3(pillY)}) scale(${f3(ps)}) translate(${f3(-ox)},${f3(-pillY)})` });
    }
    if (pill) {
      vis(pill, on && pillP > 0.002);
      set(pill, {
        transform: single ? `translate(${f3(pillX0)},${f3(pillY)}) scale(${f3(outS)},${f3(bump * outS)})` : `translate(${f3(pillX0 + pillW / 2)},${f3(pillY)}) scale(${f3(Math.max(enter * outS, 0.001))}) translate(${f3(-pillW / 2)},0)`,
        width: f3(pw), 'fill-opacity': f3(0.6),
      });
    }
    // 提示语逐字跟进；点亮时跳一下
    for (const c of charNodes) {
      const u = (t - (tLabel + 0.12 * k + c.i * 0.03 * k)) / (0.22 * k);
      const vOn = u > 0 && outS > 0.002;
      vis(c.t, vOn);
      if (!vOn) continue;
      const hop = lit ? still(Math.max(0, Math.sin(Math.PI * clamp((litU - c.i * 0.025) / 0.3))) * (0.1 + 0.08 * flair) * fs, 0, 1) : 0;
      const s = still(lerp(0.5, 1, easeOutBack(clamp(u))), 1, fs) * outS;
      set(c.t, { transform: `translate(${f3(c.x)},${f3(pillY - hop)}) scale(${f3(Math.max(s, 0.001))})`, opacity: f3(clamp(u * 3)) });
    }
    // 光晕
    const gk = single ? Math.max(0, 1 - Math.abs(litU - 0.1) / 0.5) : Math.max(0, ...taps.map((tp) => Math.max(0, 1 - Math.abs(t - tp - 0.1) / 0.5)));
    const gOp = (0.25 + 0.75 * flair) * gk * outS;
    vis(glow, gOp > 0.002);
    set(glow, { transform: `translate(${f3(glowC.x)},${f3(glowC.y)}) scale(${f3(0.7 + 0.5 * gk)})`, opacity: f3(gOp) });
    // 放射光
    for (const ry of rays) {
      const at = single ? tLit : tLast;
      const u = (t - at) / 0.45;
      const rOn = u > 0 && u < 1;
      vis(ry.e, rOn);
      if (!rOn) continue;
      const d = lerp(0.55 * rayMax, rayMax, easeOutCubic(u)) * rayBase;
      set(ry.e, { transform: `translate(${f3(glowC.x + Math.cos(ry.ang) * d)},${f3(glowC.y + Math.sin(ry.ang) * d)}) rotate(${f3((ry.ang * 180) / Math.PI)}) scale(${f3(Math.max(1 - u, 0.001))},1)`, opacity: f3(1 - u) });
    }
    // 按钮：按下压小，点亮以后弹一下；收藏的星星转一圈，转发的箭头往右弹两下
    if (single && candy) {
      // 糖果：按下去按钮面往下陷（不压小），点亮那 0.06 秒主色盖上来、按钮面弹回，再扫过一道高光；点亮以后照样弹一下
      let sc = enter;
      if (lit) sc *= 1 + (0.22 + 0.1 * flair) * Math.exp(-litU * 7) * Math.sin(litU * 22 + 0.6);
      sc *= outS;
      if (Math.abs(sc - 1) < 0.003) sc = 1; // 放大偏差不到 0.3%，当成没动
      let press = 0;
      if (t >= tPress && t < tLit) press = easeOutCubic(clamp((t - tPress) / 0.08));
      else if (lit) press = 1 - clamp(litU / 0.08);
      const litV = lit ? clamp(litU / 0.06) : 0;
      key.set({ visible: on, transform: `translate(${f3(discX)},${f3(discY)}) scale(${f3(Math.max(sc, 0.001))}) translate(${f3(-discX)},${f3(-discY)})`, press, lit: litV,
        sweep: shineSweep(t, { start: tLit + 0.12, duration: 0.55, width: SWEEP_WIDTH, ease: easeInOutCubic }) });
      let rot = 0; let dx = 0;
      if (kind === 'save' && lit) rot = 360 * easeOutCubic(clamp(litU / 0.6));
      if (kind === 'share' && lit) dx = 0.13 * D * (Math.max(0, Math.sin(Math.PI * clamp(litU / 0.2))) + 0.7 * Math.max(0, Math.sin(Math.PI * clamp((litU - 0.25) / 0.2))));
      if (Math.abs(rot - 360) < 0.02) rot = 360;
      dx = still(dx, 0, 1);
      let sink = press * PRESS_SINK * key.depth * sc; // 图标跟着按钮面往下挪同样的距离
      if (Math.abs(sink) < 0.05) sink = 0;
      vis(icon.g, on);
      set(icon.g, { transform: `translate(${f3(discX + dx)},${f3(discY + sink)}) rotate(${f3(rot)}) scale(${f3(Math.max(sc, 0.001))})` });
      for (const b of icon.bodies) { b.setAttribute('fill', litV > 0.5 ? iconLit : '#FFFFFF'); b.setAttribute('stroke', litV > 0.5 ? iconLit : '#FFFFFF'); }
    }
    if (single) {
      if (!candy) {
        let s = enter;
        if (t >= tPress && t < tLit) s *= 1 - 0.12 * easeOutCubic(clamp((t - tPress) / 0.08));
        if (lit) s *= 1 + (0.22 + 0.1 * flair) * Math.exp(-litU * 7) * Math.sin(litU * 22 + 0.6);
        s = still(s, 1, D) * outS;
        vis(disc, on); vis(ring, on); vis(icon.g, on);
        set(disc, { transform: `translate(${f3(discX)},${f3(discY)}) scale(${f3(Math.max(s, 0.001))})`, 'fill-opacity': f3(0.62) });
        set(ring, { transform: `translate(${f3(discX)},${f3(discY)}) scale(${f3(Math.max(s, 0.001))})`, stroke: lit ? litColor : K.fill, 'stroke-opacity': f3(lit ? 1 : 0.5) });
        let rot = 0; let dx = 0;
        if (kind === 'save' && lit) rot = 360 * easeOutCubic(clamp(litU / 0.6));
        if (kind === 'share' && lit) dx = 0.13 * D * (Math.max(0, Math.sin(Math.PI * clamp(litU / 0.2))) + 0.7 * Math.max(0, Math.sin(Math.PI * clamp((litU - 0.25) / 0.2))));
        if (Math.abs(rot - 360) < 0.02) rot = 360;
        dx = still(dx, 0, 1);
        set(icon.g, { transform: `translate(${f3(discX + dx)},${f3(discY)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))})` });
        for (const b of icon.bodies) {
          b.setAttribute('fill', lit ? litColor : 'none');
          b.setAttribute('stroke', lit ? K.outer : K.fill);
        }
      }
      // 速度线
      speed.forEach((ln, i) => {
        const u = (litU - i * 0.04) / 0.45;
        const sOn = lit && u > 0 && u < 1;
        vis(ln, sOn);
        if (sOn) set(ln, { transform: `translate(${f3(discX - 0.12 * D - 0.12 * D * u)},${f3(discY + (i - 1) * 0.16 * D)}) scale(${f3(Math.max(1 - u, 0.001))},1)`, opacity: f3(1 - u) });
      });
      // +1
      if (plus) {
        const u = litU / 0.8;
        const pOn = lit && u > 0 && u < 1;
        vis(plus, pOn);
        if (pOn) set(plus, { transform: `translate(${f3(discX)},${f3(discY - r - 0.12 * D - 0.35 * D * easeOutCubic(u))})`, opacity: f3(Math.sin(Math.PI * clamp(u * 1.3))) });
      }
    }
    // 双击的爱心：点一下冒一颗，弹出来、歪一点，再往上飘、淡掉
    for (const ht of hearts) {
      const u = t - ht.t;
      const hOn = u >= 0 && u < 1.3 && outS > 0.002;
      vis(ht.g, hOn);
      if (hOn) {
        const pop = u < 0.3 ? easeOutBack(clamp(u / 0.3)) * 1.05 : 1;
        let fly = easeInCubic(clamp((u - 0.45) / 0.85));
        if (fly * ht.rise < 0.05) fly = 0; // 刚开始往上飘那几帧只挪零点零几个像素，当成没动
        set(ht.g, { transform: `translate(${f3(heartC.x + ht.dx)},${f3(heartC.y - ht.rise * fly)}) rotate(${f3(ht.tilt)}) scale(${f3(Math.max(pop * (1 - 0.3 * fly) * outS, 0.001))})` });
        for (const p of ht.parts) p.setAttribute('opacity', f3(1 - fly));
      }
      const ru = u / 0.4;
      const rOn = ru > 0 && ru < 1;
      vis(ht.ripple, rOn);
      if (rOn) set(ht.ripple, { transform: `translate(${f3(heartC.x)},${f3(heartC.y)}) scale(${f3(0.4 + 0.9 * easeOutCubic(ru))})`, opacity: f3(0.8 * (1 - ru)) });
    }
    // 粒子
    for (const p of parts) {
      const u = (t - p.at) / 0.7;
      const pOn = u > 0 && u < 1;
      vis(p.e, pOn);
      if (!pOn) continue;
      const o = single ? { x: discX, y: discY } : heartC;
      const d = p.dist * easeOutCubic(u);
      set(p.e, { transform: `translate(${f3(o.x + Math.cos(p.ang) * d)},${f3(o.y + Math.sin(p.ang) * d - 0.1 * D * u)}) rotate(${f3(p.spin * u)}) scale(${f3(Math.max(p.sz * (1 - 0.5 * u), 0.001))})`, opacity: f3(1 - u) });
    }
    // 手：从右下伸进来，按下（双击就点两下），再收回去
    if (handG) {
      const target = single ? { x: discX + 0.05 * D, y: discY + 0.08 * D } : { x: heartC.x + 0.02 * short, y: heartC.y + 0.04 * short };
      // 从右下伸进来：起点收在画面里（手的右边、下边都不出画面），伸进来、收回去时淡入淡出。
      // 双击：手斜着（往左上指，歪 32 度）从右边伸进来，点完沿原路收回去，手掌一直在爱心右下方、够不到下面的提示语。
      // 原来跟单个按钮一样从右下竖着进出，收回去时正好扫过胶囊条右半截的字（海报那一帧手压在「幕」上）
      const fromX = single ? Math.min(target.x + 0.9 * D, W - 0.05 * short - 0.42 * D) : Math.min(target.x + 1.0 * D, W - 0.05 * short - 0.75 * D);
      const fromY = single ? Math.min(target.y + 1.1 * D, H - 0.05 * short - 0.9 * D) : target.y + 0.25 * D;
      const from = { x: Math.max(fromX, target.x), y: Math.max(fromY, target.y) };
      const inP = easeOutCubic(clamp((t - tHandIn) / (0.28 * k)));
      const outP = easeInCubic(clamp((t - (kind === 'double' ? taps[1] + 0.25 : tHandOut)) / (0.3 * k)));
      let press = 0;
      const pressAt = kind === 'double' ? taps : [tPress];
      for (const pa of pressAt) press = Math.max(press, Math.max(0, Math.sin(Math.PI * clamp((t - pa + 0.06) / 0.16))));
      let p = inP * (1 - outP);
      if ((1 - p) * Math.hypot(from.x - target.x, from.y - target.y) < 0.05) p = 1; // 伸到位前、刚要收回时只差零点零几个像素，当成到位
      if (press * 0.06 * D < 0.05) press = 0;
      const hOn = p > 0.002 && outS > 0.002;
      vis(handG, hOn);
      const tilt = single ? -14 * (1 - p) : -32 - 12 * (1 - p);
      if (hOn) set(handG, { transform: `translate(${f3(lerp(from.x, target.x, p))},${f3(lerp(from.y, target.y, p) + press * 0.06 * D)}) rotate(${f3(tilt)}) scale(${f3(1 - 0.06 * press)})` });
      // 淡入淡出写在手那条路径上，不写在整组上（底座硬规矩第 6 条）
      if (hOn) handPath.setAttribute('opacity', f3(clamp(p * 2.5) * outS));
    }
  }

  const lines = userText ? [{ text: userText, index: 0, paragraph: 0 }] : [];
  const issues = userText ? checkLineBreaks(lines, ctx.text, { segment: ctx.segment }) : [];
  const warnings = userText ? icuBreakWarnings(lines, ctx.text) : [];
  if (graphemes(label).length > 8) warnings.push({ type: 'too-long', detail: `提示语 ${graphemes(label).length} 个字，超过 8 个字胶囊条会很长` });
  seek(0);
  return {
    timeline,
    layout: { fontSize: fs, lines: [label], forced: [], issues, warnings, segmentation: ctx.segmentation.sources, units: chars.length, kind, buttonDiameter: D },
    seek,
    destroy() { svg.remove(); },
  };
}
