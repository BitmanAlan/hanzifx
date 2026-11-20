// 006 三连引导（互动元素，styles/006-triple-tap）
//
// 风格契约见 engine/docs/写一个新风格.md：create(root, ctx) 只按 (参数, 画面尺寸) 搭好 SVG，
// 返回 { timeline, layout, seek, destroy }；seek(t) 是纯函数，只看 t，随机全走 hash01(种子, …)。
//
// 画面：三个圆形按钮（图标全部自己画，不用任何平台的图标、品牌色和布局），一只简笔画的手，点亮时爆出粒子。
//   横排 row：点赞、投币、收藏。手按住点赞 → 投币和收藏外面的圆环从 12 点方向顺时针走满 → 三个一起点亮绽放。
//   竖排 column：点赞、收藏、转发。手从上往下依次点，点一个亮一个。
// 每个按钮从下到上：光晕 → 投影 → 底盘 → 圆环（只有蓄力的按钮有）→ 图标 → 「+1」；按钮下面一行小字，可选数字。
// 造型预设：V1 日常（默认）、V3 招牌（粒子更多，加放射光、冲击波、彩纸，停留时有小爱心往上飘）。
// 质感（material）：candy 亮面糖果（默认）＝按钮用底座的圆按钮零件（engine/src/parts）：没点亮是灰色糖果按钮、白色实心图标，
//   点亮那一下换成主色；按住、点下去时按钮面往下陷。flat 平面＝原来的半透明底盘加描线图标，这条代码路径没动过。

import { hash01 } from '../../engine/src/lib/rand.js';
import { mix } from '../../engine/src/lib/color.js';
import { clamp, lerp, spring, impulse, easeOutCubic, easeInCubic, easeInOutCubic, easeInBack } from '../../engine/src/lib/ease.js';
import { checkLineBreaks } from '../../engine/src/lib/text.js';
import { f3 } from '../../engine/src/motions/index.js';
import { createParts, PRESS_SINK } from '../../engine/src/parts/index.js';

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

function starPath(cx, cy, R, r, n = 5) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rad = i % 2 === 0 ? R : r;
    pts.push(`${f3(cx + rad * Math.cos(a))} ${f3(cy + rad * Math.sin(a))}`);
  }
  return `M${pts.join(' L')} Z`;
}

// 图标：都画在 100×100 的格子里，中心 (50,50)。body 是点亮时要填色的外形，detail 是只描线的细节。
const ICONS = {
  like: {
    body: [
      'M31 47 L44.5 22 C46.5 16.5 55 15.5 57.5 21.5 C59 25.5 58.5 31 56 38 L54 45 L77 45 C84.5 45 89 51.5 87 58 L81.5 79 C80.5 84 76.5 87 71.5 87 L31 87 Z',
      'M17.5 47 L24.5 47 Q28 47 28 50.5 L28 83.5 Q28 87 24.5 87 L17.5 87 Q14 87 14 83.5 L14 50.5 Q14 47 17.5 47 Z',
    ],
    detail: [],
  },
  coin: {
    body: ['M50 15 A35 35 0 1 1 49.99 15 Z'],
    // 只留一个粗的「¥」：原来还有一圈内环，缩小以后内环加「¥」像一张猫脸
    detail: ['M37 29 L50 47 L63 29 M50 47 L50 71 M38 52 L62 52 M38 61.5 L62 61.5'],
  },
  fav: { body: [starPath(50, 53, 38, 16.5)], detail: [] },
  share: {
    body: ['M19 73 C23 49.5 39.5 39 60 39 L60 25 L86 49.5 L60 74 L60 59.5 C44 59.5 31.5 63.5 19 73 Z'],
    detail: [],
  },
};
// 手：食指朝上的简笔画，指尖在 (44,6)
const HAND = 'M36 13 C36 4.5 52 4.5 52 13 L52 44 C54.5 39.5 62.5 39.5 64 45.5 C66 40.5 74.5 41 75.5 47.5 C77.5 43.5 85 45 85 51.5 L85 70 C85 84.5 74.5 94.5 60 94.5 L50.5 94.5 C40.5 94.5 33.5 88.5 30 80 L21.5 62 C19.5 56.5 25.5 52.5 30.5 57 L36 63.5 Z';
const HAND_TIP = { x: 44, y: 6 };
// 粒子外形：画在中心 (0,0)、半径约 4 的格子里
const SHAPES = {
  heart: 'M0 3.4 C-3.6 0.7 -5 -1.4 -3.8 -3.3 C-2.5 -5.2 -0.6 -4.6 0 -2.9 C0.6 -4.6 2.5 -5.2 3.8 -3.3 C5 -1.4 3.6 0.7 0 3.4 Z',
  star: starPath(0, 0.3, 4.4, 1.9),
  coin: 'M0 -3.6 A3.6 3.6 0 1 1 -0.01 -3.6 Z',
  confetti: 'M-1.2 -3.4 L1.2 -3.4 L1.2 3.4 L-1.2 3.4 Z',
};

const SETS = {
  coin: { icons: ['like', 'coin', 'fav'], labels: ['点赞', '投币', '收藏'] },
  share: { icons: ['like', 'fav', 'share'], labels: ['点赞', '收藏', '转发'] },
};

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const seed = P.seed;
  const U = ctx.uid || 'hanzifx006'; // SVG 里的 id 加上这次挂载的前缀，画廊一页放几个预览时不撞
  const short = Math.min(W, H);
  const family = ctx.fontFamily(P.font);
  const layoutMode = P.layout === 'column' ? 'column' : 'row';
  const setId = P.set === 'auto' || !P.set ? (layoutMode === 'row' ? 'coin' : 'share') : P.set;
  const SET = SETS[setId] || SETS.coin;
  const showcase = (P.flair ?? 0) > 0; // 招牌造型（V3）
  const flair = clamp(P.flair ?? 0);
  const R = P._rhythm;
  const k = R.speed ?? 1; // 时间缩放：R2 快 = 0.667
  const holdExtra = R.holdExtra ?? 0; // R3 挂着：停留段加长

  // ---------- 小字：按钮下面的三个标签 ----------
  let labels = String(ctx.text || '').split(/[\s,，、|/]+/).filter(Boolean);
  const coinDefaults = SETS.coin.labels.join('');
  if (setId === 'share' && labels.join('') === coinDefaults) labels = SET.labels.slice(); // 竖排没改字时，换成竖排的默认三个字
  while (labels.length < 3) labels.push(SET.labels[labels.length]);
  labels = labels.slice(0, 3);
  const counts = String(P.counts || '').split(/[\s,，、|/]+/).filter(Boolean).slice(0, 3);
  const showCounts = counts.length > 0;

  // ---------- 尺寸和位置 ----------
  let D = clamp(P.size, 0.07, 0.16) * short; // 按钮直径
  const fsLabel = Math.max(0.028 * short, D * 0.22); // 小字不能小于短边的 0.028
  const gapRow = D * 0.6;
  const labelBlock = fsLabel * 1.5 + (showCounts ? fsLabel * 1.25 : 0);
  // 横排太宽就缩：三个按钮加两个间距不超过画面宽的 70%
  if (layoutMode === 'row') {
    const total = 3 * D + 2 * gapRow;
    if (total > W * 0.7) D *= (W * 0.7) / total;
  }
  const r = D / 2;
  const centers = [];
  if (layoutMode === 'row') {
    const cx = (P.x ?? 0.5) * W;
    const cy = (P.y ?? (H > W ? 0.66 : 0.72)) * H;
    const step = D + gapRow;
    for (let i = 0; i < 3; i++) centers.push({ x: cx + (i - 1) * step, y: cy });
  } else {
    // 竖排放在右侧，但往左让开平台自己的按钮列：右边缘离画面右侧 18%（经验值，待实测）
    const cx = P.x != null ? P.x * W : W * (1 - 0.18) - r;
    const cy = (P.y ?? 0.52) * H;
    const step = D + labelBlock + D * 0.35;
    for (let i = 0; i < 3; i++) centers.push({ x: cx, y: cy + (i - 1) * step });
  }

  // ---------- 颜色（全从 8 个角色推） ----------
  // 第三个按钮用 accent 和 fill2 对半混的颜色：横排的「收藏」不再跟「投币」一样黄（三个亮起来是粉、金、橙），竖排的「转发」照旧
  const litColor = [K.accent, K.fill2, mix(K.accent, K.fill2, 0.5)];
  const C = {
    idle: K.fill, outline: K.outer, disc: K.bg, ring: K.inner, label: K.sub, shadow: K.shadow,
    lit: litColor, litEdge: litColor.map((c) => mix(c, '#000000', 0.28)), litDetail: litColor.map((c) => mix(c, '#000000', 0.42)),
  };

  // ---------- 时间轴 ----------
  const T = {};
  const units = [];
  if (layoutMode === 'row') {
    T.intro = [0, 0.3 * k];
    T.press = [0.3 * k, 0.7 * k];
    T.charge = [0.7 * k, 1.5 * k];
    T.burst = [1.5 * k, 1.95 * k];
    T.hold = [1.95 * k, 2.7 * k + holdExtra];
    T.outro = [T.hold[1], T.hold[1] + 0.3 * k];
    for (let i = 0; i < 3; i++) {
      units.push({ i, enter: T.intro[0] + 0.06 * k * i, lit: T.burst[0], exit: T.outro[0] + 0.04 * k * i });
    }
  } else {
    T.intro = [0, 0.3 * k];
    const taps = [0, 1, 2].map((i) => (0.35 + 0.45 * i) * k);
    T.press = [taps[0] - 0.12 * k, taps[2] + 0.35 * k];
    T.hold = [T.press[1], T.press[1] + 0.9 * k + holdExtra];
    T.outro = [T.hold[1], T.hold[1] + 0.3 * k];
    for (let i = 0; i < 3; i++) {
      units.push({ i, enter: T.intro[0] + 0.06 * k * i, tap: taps[i], lit: taps[i] + 0.14 * k, exit: T.outro[0] + 0.04 * k * i });
    }
  }
  const duration = T.outro[1];
  const outDur = 0.26 * k;

  // ---------- 搭 SVG ----------
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  litColor.forEach((c, i) => {
    const g = el('radialGradient', { id: `${U}glow${i}` }, defs);
    el('stop', { offset: '0%', 'stop-color': c, 'stop-opacity': 0.9 }, g);
    el('stop', { offset: '55%', 'stop-color': c, 'stop-opacity': 0.35 }, g);
    el('stop', { offset: '100%', 'stop-color': c, 'stop-opacity': 0 }, g);
  });

  const candy = P.material === 'candy';
  const kit = candy ? createParts(svg, { uid: U, material: 'candy', defs }) : null;
  const IDLE = '#3A3A42'; // 糖果：没点亮的按钮是这组灰

  const fxBack = el('g', {}, svg); // 放射光、冲击波（在按钮后面）
  // 光晕单独一层，不放进按钮组：按钮组出场时整组淡出，渐变的外圈（透明度只有 1/255 左右）在不同轮次里取整会不一样，
  // 乱序渲染逐帧就对不上（11-19 实测，差在浏览器给渐变加的抖动纹理）。光晕自己算位置和透明度。
  const glowLayer = el('g', {}, svg);
  const btnLayer = el('g', {}, svg);
  const fxFront = el('g', {}, svg); // 粒子、彩纸、小爱心（在按钮前面）
  const labelLayer = el('g', {}, svg); // 小字放在粒子上面，免得飘过的粒子挡住「点赞」
  const handLayer = el('g', {}, svg);

  const iconScale = (D * 0.6) / 100;
  const sw = (0.07 * D) / iconScale; // 图标线宽 = 直径的 7%，换算到 100 格子里
  const buttons = SET.icons.map((name, i) => {
    const c = centers[i];
    const g = el('g', {}, btnLayer);
    const glow = el('circle', { cx: 0, cy: 0, r: r * 1.9, fill: `url(#${U}glow${i})`, opacity: 0 }, glowLayer);
    // 糖果：圆按钮零件画进按钮组，跟着组的 transform、visibility 走（光晕在按钮组外面，零件自己的外发光不要）
    const key = candy ? kit.key({ shape: 'circle', cx: 0, cy: 0, r, color: C.lit[i], idleColor: IDLE, glow: false, parent: g }) : null;
    const shadow = candy ? null : el('circle', { cx: 0, cy: 0.05 * D, r, fill: C.shadow, opacity: 0.22 }, g);
    const disc = candy ? null : el('circle', { cx: 0, cy: 0, r, fill: C.disc, 'fill-opacity': 0.42, stroke: C.idle, 'stroke-opacity': 0.35, 'stroke-width': 0.03 * D }, g);
    const hasRing = layoutMode === 'row' && name !== 'like';
    let track = null; let ring = null;
    const ringR = r * 1.16; const circ = TAU * ringR;
    if (hasRing) {
      track = el('circle', { cx: 0, cy: 0, r: ringR, fill: 'none', stroke: C.ring, 'stroke-opacity': 0, 'stroke-width': 0.07 * D }, g);
      // SVG 圆从 3 点方向开始、顺时针画；转 -90° 让它从 12 点方向开始，方向仍是顺时针
      ring = el('circle', { cx: 0, cy: 0, r: ringR, fill: 'none', stroke: C.ring, 'stroke-width': 0.07 * D, 'stroke-linecap': 'round', transform: 'rotate(-90)', 'stroke-dasharray': `0 ${f3(circ)}`, opacity: 0 }, g);
    }
    // 糖果：图标套一层组，按下去时整个图标跟着按钮面往下挪；图标白色实心，底下压一份往下错开的淡黑硬投影
    const iconG = candy ? el('g', {}, g) : null;
    const ig = el('g', { transform: `scale(${f3(iconScale)}) translate(-50,-50)` }, candy ? iconG : g);
    if (candy) {
      const off = (0.02 * D) / iconScale;
      for (const d of ICONS[name].body) el('path', { d, fill: '#000000', 'fill-opacity': 0.12, transform: `translate(0,${f3(off)})` }, ig);
    }
    const bodies = ICONS[name].body.map((d) => el('path', candy
      ? { d, fill: '#FFFFFF', 'stroke-linejoin': 'round' }
      : { d, fill: C.lit[i], 'fill-opacity': 0, stroke: C.idle, 'stroke-width': sw, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, ig));
    const details = ICONS[name].detail.map((d) => el('path', { d, fill: 'none', stroke: candy ? IDLE : C.idle, 'stroke-width': sw * 1.05, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, ig));
    const plus = el('text', {
      x: 0, y: -r * 1.25, 'text-anchor': 'middle', 'font-family': family, 'font-size': fsLabel * 1.05, 'font-weight': 700,
      fill: C.lit[i], stroke: C.outline, 'stroke-width': fsLabel * 0.16, 'paint-order': 'stroke', 'stroke-linejoin': 'round', opacity: 0,
    }, g);
    plus.textContent = '+1';
    const lg = el('g', {}, labelLayer);
    const label = el('text', {
      x: 0, y: r + fsLabel * 1.2, 'text-anchor': 'middle', 'font-family': family, 'font-size': fsLabel, 'font-weight': 700,
      fill: C.label, stroke: C.outline, 'stroke-width': fsLabel * 0.18, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
      'font-variant-numeric': 'tabular-nums',
    }, lg);
    label.textContent = labels[i];
    let count = null;
    if (showCounts && counts[i]) {
      count = el('text', {
        x: 0, y: r + fsLabel * 2.45, 'text-anchor': 'middle', 'font-family': family, 'font-size': fsLabel * 0.9, 'font-weight': 700,
        fill: C.label, 'fill-opacity': 0.85, stroke: C.outline, 'stroke-width': fsLabel * 0.16, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
        'font-variant-numeric': 'tabular-nums',
      }, lg);
      count.textContent = counts[i];
    }
    return { name, i, c, g, lg, glow, shadow, disc, key, iconG, track, ring, circ, bodies, details, plus, label, count, hasRing };
  });

  // 粒子：每个按钮一组，数量、方向、速度、大小、转速全按种子定
  const nPer = Math.max(0, Math.round((P.particles ?? 14) / 3));
  const kinds = setId === 'coin' ? ['heart', 'coin', 'star'] : ['heart', 'star', 'star'];
  const particles = [];
  buttons.forEach((b) => {
    const n = nPer + (showcase ? Math.round(6 * flair) : 0);
    for (let j = 0; j < n; j++) {
      const h = (key) => hash01(seed, 'p', b.i, j, key);
      const kind = showcase && j % 3 === 2 ? 'confetti' : kinds[(j + b.i) % kinds.length];
      // 竖排在画面右侧，右边是平台自己的按钮列：粒子主要往左上方飞，不往右边去
      const ang = layoutMode === 'column'
        ? -Math.PI * 0.72 + (h('a') - 0.5) * TAU * (showcase ? 0.55 : 0.45)
        : -Math.PI / 2 + (h('a') - 0.5) * (showcase ? TAU * 0.95 : TAU * 0.8);
      const dist = D * lerp(0.75, 1.35, h('d')) * (showcase ? 1.1 : 1);
      const size = (D / 9) * lerp(0.7, 1.25, h('s'));
      const color = kind === 'heart' ? C.lit[0] : kind === 'coin' ? K.fill2 : kind === 'confetti' ? [K.accent, K.fill2, K.inner][j % 3] : mix(K.fill2, '#FFFFFF', 0.25);
      const p = el('path', { d: SHAPES[kind], fill: color, stroke: C.outline, 'stroke-width': kind === 'confetti' ? 0 : 0.6, opacity: 0 }, fxFront);
      particles.push({ b, p, kind, ang, dist, size, spin: (h('r') - 0.5) * 720, delay: h('t') * 0.05 * k, life: (showcase ? 0.95 : 0.72) * k, tumble: h('tb') });
    }
  });

  // 招牌造型才有的：放射光、冲击波、往上飘的小爱心
  const rays = []; const waves = []; const floaters = [];
  if (showcase) {
    const center = layoutMode === 'row' ? centers[1] : null;
    const spots = layoutMode === 'row' ? [center] : centers;
    spots.forEach((s, si) => {
      // 光线长度不超过到画面边的距离，免得被画面边缘切掉
      // 竖排在右侧：右边只能伸到平台按钮区的左边界（画面右侧 15%，经验值），别的方向到画面边
      const rightLimit = layoutMode === 'column' ? W * 0.85 - s.x : W - s.x;
      const room = Math.max(D * 0.6, Math.min(s.x, rightLimit, s.y, H - s.y) * 0.92);
      const len = Math.min(D * (layoutMode === 'row' ? 2.6 : 1.5), room);
      const nRays = 12;
      // 光线越往外越淡：渐变以爆点为圆心，用光线自己的坐标（userSpaceOnUse），半径就是光线长度
      [K.fill2, K.inner].forEach((col, ci) => {
        const g = el('radialGradient', { id: `${U}ray${si}_${ci}`, gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: f3(len) }, defs);
        el('stop', { offset: '0%', 'stop-color': col, 'stop-opacity': 0.95 }, g);
        el('stop', { offset: '45%', 'stop-color': col, 'stop-opacity': 0.55 }, g);
        el('stop', { offset: '100%', 'stop-color': col, 'stop-opacity': 0 }, g);
      });
      for (let j = 0; j < nRays; j++) {
        const a0 = (j / nRays) * TAU + hash01(seed, 'ray', si, j) * 0.2;
        const wdt = 0.09;
        const d = `M0 0 L${f3(Math.cos(a0 - wdt) * len)} ${f3(Math.sin(a0 - wdt) * len)} L${f3(Math.cos(a0 + wdt) * len)} ${f3(Math.sin(a0 + wdt) * len)} Z`;
        rays.push({ si, s, p: el('path', { d, fill: `url(#${U}ray${si}_${j % 2})`, opacity: 0 }, fxBack) });
      }
      waves.push({ si, s, room, c: el('circle', { cx: f3(s.x), cy: f3(s.y), r: r, fill: 'none', stroke: K.inner, 'stroke-width': 0.05 * D, opacity: 0 }, fxBack) });
    });
    for (let j = 0; j < 5; j++) {
      floaters.push({ j, p: el('path', { d: SHAPES.heart, fill: C.lit[0], stroke: C.outline, 'stroke-width': 0.6, opacity: 0 }, fxFront) });
    }
  }

  const handG = el('g', {}, handLayer);
  const hand = el('path', { d: HAND, fill: '#FFFFFF', stroke: C.outline, 'stroke-width': sw * 0.75, 'stroke-linejoin': 'round' }, handG);
  const handScale = (D * 0.95) / 100;

  // ---------- 每一刻怎么动（纯函数） ----------
  const enterScale = (tau) => (tau <= 0 ? 0 : toRest(spring(tau, { freq: 2.6 / k, damping: 0.46 }), 1, D));
  function burstScale(u, amp) { return u <= 0 ? 1 : 1 + amp * impulse(u, { freq: 1.8 / k, decay: 5 / k }); }

  function handPose(t) {
    if (!P.hand) return null;
    // 横排：手从右下方伸进来；竖排在画面右侧，手改从左下方伸进来（左右镜像），不伸进右边的平台按钮区
    const side = layoutMode === 'column' ? -1 : 1;
    const out = { x: centers[0].x + side * D * 1.5, y: centers[0].y + D * 1.6 };
    // 指尖落在按钮中心偏右，手掌往右下方斜，让开按钮下面的小字
    const on = (i) => ({ x: centers[i].x + side * D * 0.14, y: centers[i].y + D * 0.02 });
    if (layoutMode === 'row') {
      const a = T.press[0] - 0.12 * k; const b = T.press[0] + 0.08 * k; const c = T.burst[0] + 0.05 * k; const d2 = c + 0.25 * k;
      if (t < a || t > d2) return null;
      let pos; let press = 0; let alpha = 1;
      if (t < b) { const u = easeOutCubic(clamp((t - a) / (b - a))); pos = { x: lerp(out.x, on(0).x, u), y: lerp(out.y, on(0).y, u) }; alpha = u; }
      else if (t < c) { pos = on(0); press = clamp((t - b) / (0.08 * k)); }
      else { const u = easeInCubic(clamp((t - c) / (d2 - c))); pos = { x: lerp(on(0).x, out.x, u), y: lerp(on(0).y, out.y, u) }; alpha = 1 - u; press = 1 - u; }
      return { ...pos, press, alpha };
    }
    const taps = units.map((u) => u.tap);
    const a = taps[0] - 0.12 * k; const end = taps[2] + 0.35 * k + 0.2 * k;
    if (t < a || t > end) return null;
    if (t < taps[0]) { const u = easeOutCubic(clamp((t - a) / (0.12 * k))); return { x: lerp(out.x, on(0).x, u), y: lerp(out.y, on(0).y, u), press: 0, alpha: u }; }
    for (let i = 0; i < 3; i++) {
      const s = taps[i]; const nextS = i < 2 ? taps[i + 1] : null;
      const pressU = clamp((t - s) / (0.08 * k)) * (1 - clamp((t - s - 0.2 * k) / (0.08 * k)));
      if (nextS != null && t < nextS) {
        const mv0 = s + 0.25 * k;
        if (t < mv0) return { ...on(i), press: pressU, alpha: 1 };
        const u = easeInOutCubic(clamp((t - mv0) / (nextS - mv0)));
        return { x: lerp(on(i).x, on(i + 1).x, u), y: lerp(on(i).y, on(i + 1).y, u) - Math.sin(Math.PI * u) * D * 0.15, press: 0, alpha: 1 };
      }
      if (nextS == null) {
        const lv = s + 0.3 * k;
        if (t < lv) return { ...on(i), press: pressU, alpha: 1 };
        const u = easeInCubic(clamp((t - lv) / (end - lv)));
        return { x: lerp(on(i).x, out.x, u), y: lerp(on(i).y, out.y, u), press: 0, alpha: 1 - u };
      }
    }
    return null;
  }

  function seek(t) {
    // 按钮
    for (const b of buttons) {
      const u = units[b.i];
      const tau = t - u.enter;
      let s = enterScale(tau);
      let dx = 0; let dy = toRest((1 - clamp(spring(tau, { freq: 2.2 / k, damping: 0.6 }))) * D * 0.55, 0, 1);
      let rot = 0; let alpha = clamp(tau / (0.08 * k));
      // 按住：点赞被按着，左右抖（横排）
      if (layoutMode === 'row') {
        if (b.i === 0 && t >= T.press[0] && t < T.burst[0]) {
          const env = clamp((t - T.press[0]) / (0.1 * k));
          dx += Math.sin(TAU * 12 * (t - T.press[0])) * D * 0.03 * env;
          s *= 1 - 0.06 * env;
        }
        // 蓄力：三个按钮越抖越厉害，攒劲
        if (t >= T.charge[0] && t < T.burst[0]) {
          const g = (t - T.charge[0]) / (T.burst[0] - T.charge[0]);
          const amp = D * 0.012 * g * (1 + flair);
          dx += Math.sin(TAU * 17 * t + b.i * 1.7) * amp; dy += Math.cos(TAU * 13 * t + b.i) * amp;
          s *= 1 - 0.04 * g;
        }
      } else if (t >= u.tap && t < u.lit + 0.06 * k) {
        s *= 1 - 0.1 * clamp((t - u.tap) / (0.08 * k));
      }
      // 绽放：先放大到约 1.18 倍再弹回 1
      const lu = t - u.lit;
      const lit = clamp(lu / (0.06 * k));
      s *= burstScale(lu, 0.35 * (1 + 0.45 * flair));
      if (lu > 0) rot += impulse(lu, { freq: 2.2 / k, decay: 6 / k }) * (b.i % 2 ? -8 : 8) * (1 + flair);
      // 停留：轻轻呼吸
      if (t >= T.hold[0] && t < T.outro[0]) s *= 1 + 0.025 * Math.sin(TAU * 1.2 * (t - T.hold[0]));
      // 出场：往下缩小淡出，逐个错开
      const ou = clamp((t - u.exit) / outDur);
      if (ou > 0) { s *= Math.max(0, 1 - easeInBack(ou, 1.6)); dy += easeInCubic(ou) * D * 0.35; alpha *= 1 - ou; }
      // 缩放小于 0.2 时整个按钮还不到 24 个像素、线条细到 1 像素，直接隐藏（下一帧就到 0.46，看不出区别）：几乎缩成一个点的图形，浏览器的覆盖率取整不稳定，
      // 同一帧有时多画出一个透明度 7/255 的像素，逐帧就对不上（11-20 在底座 determinism 里复现）
      const vis = tau > 0 && ou < 1 && s > 0.2;
      // 不给整组设透明度：Chrome 会按「透明度是不是一直在变」决定要不要单独提一个合成层，提没提层画出来的取整差一点，
      // 乱序渲染逐帧就对不上（11-19 实测）。入场、出场只靠缩放。
      set(b.g, { transform: `translate(${f3(b.c.x + dx)},${f3(b.c.y + dy)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))})`, visibility: vis ? 'visible' : 'hidden' });
      // 小字跟着按钮进出，但不跟着抖和放大
      const ls = clamp(enterScale(tau - 0.05 * k)) * Math.max(0, 1 - easeInBack(ou, 1.6));
      set(b.lg, { transform: `translate(${f3(b.c.x)},${f3(b.c.y + toRest((1 - clamp(spring(tau - 0.05 * k, { freq: 2.2 / k, damping: 0.6 }))) * D * 0.3, 0, 1) + easeInCubic(ou) * D * 0.35)}) scale(${f3(Math.max(ls, 0.001))})`, visibility: vis ? 'visible' : 'hidden' });
      if (candy) {
        // 糖果：按住（横排点赞）、点下去（竖排）时按钮面往下陷，点亮以后 0.06 秒弹回来；点亮那一下主色盖上来
        let press = 0;
        if (layoutMode === 'row') {
          if (b.i === 0 && t >= T.press[0] && t < T.burst[0]) press = clamp((t - T.press[0]) / (0.1 * k));
          else if (b.i === 0 && t >= T.burst[0]) press = 1 - clamp((t - T.burst[0]) / (0.06 * k));
        } else if (t >= u.tap && t < u.lit) press = clamp((t - u.tap) / (0.08 * k));
        else if (t >= u.lit) press = 1 - clamp((t - u.lit) / (0.06 * k));
        b.key.set({ visible: 'inherit', press, lit });
        const sink = press * PRESS_SINK * b.key.depth;
        if (Math.abs(sink) < 0.05) b.iconG.removeAttribute('transform');
        else set(b.iconG, { transform: `translate(0,${f3(sink)})` });
        for (const p of b.details) set(p, { stroke: lit > 0.5 ? C.lit[b.i] : IDLE });
      } else {
        // 点亮：图标从描线变成填色
        for (const p of b.bodies) set(p, { 'fill-opacity': lit, stroke: lit > 0.5 ? C.litEdge[b.i] : C.idle });
        for (const p of b.details) set(p, { stroke: lit > 0.5 ? C.litDetail[b.i] : C.idle });
        set(b.disc, { fill: lit > 0 ? mix(C.disc, C.lit[b.i], 0.22 * lit) : C.disc });
      }
      // 光晕：点亮那一下最亮，之后留一点
      const glowA = lu > 0 ? (0.25 + 0.75 * Math.exp(-3.2 * lu / k)) * (0.75 + 0.25 * flair) : 0;
      const glowOp = glowA * alpha * (1 - clamp(ou / 0.35));
      set(b.glow, {
        opacity: glowOp < 0.02 || !vis ? 0 : glowOp, r: r * (1.6 + 0.35 * Math.exp(-4 * Math.max(lu, 0) / k)),
        transform: `translate(${f3(b.c.x + dx)},${f3(b.c.y + dy)}) scale(${f3(Math.max(s, 0.001))})`,
      });
      // 圆环：蓄力时从 12 点方向顺时针走满，满了以后往外扩一下淡掉
      if (b.hasRing) {
        const cu = clamp((t - T.charge[0]) / (T.charge[1] - T.charge[0]));
        const prog = easeInOutCubic(cu);
        const after = clamp((t - T.burst[0]) / (0.25 * k));
        set(b.track, { 'stroke-opacity': t >= T.charge[0] && after < 1 ? 0.22 * (1 - after) : 0 });
        set(b.ring, {
          'stroke-dasharray': `${f3(prog * b.circ)} ${f3(b.circ)}`,
          opacity: t >= T.charge[0] ? 1 - after : 0,
          transform: `rotate(-90) scale(${f3(1 + 0.28 * easeOutCubic(after))})`,
        });
      }
      // 「+1」：点亮后往上飘
      const pu = (t - u.lit - 0.08 * k) / (0.7 * k);
      if (P.plusOne && !showCounts && pu > 0 && pu < 1) set(b.plus, { opacity: Math.sin(Math.PI * clamp(pu * 1.4)) * alpha, transform: `translate(0,${f3(-easeOutCubic(pu) * D * 0.38)})` });
      else set(b.plus, { opacity: 0 });
    }
    // 粒子：从按钮中心冲出去，带一点重力往下落，转着淡掉
    for (const q of particles) {
      const u = (t - units[q.b.i].lit - q.delay) / q.life;
      if (u <= 0 || u >= 1) { set(q.p, { opacity: 0 }); continue; }
      const e = easeOutCubic(u);
      const x = q.b.c.x + Math.cos(q.ang) * q.dist * e;
      const y = q.b.c.y + Math.sin(q.ang) * q.dist * e + D * 0.55 * u * u;
      const sc = (q.size / 4) * (u < 0.15 ? u / 0.15 : 1) * (1 - 0.35 * u);
      const flip = q.kind === 'confetti' ? Math.cos(TAU * (1.5 + q.tumble) * u) : 1;
      set(q.p, { transform: `translate(${f3(x)},${f3(y)}) rotate(${f3(q.spin * u)}) scale(${f3(sc * flip)},${f3(sc)})`, opacity: 1 - u * u });
    }
    // 招牌：放射光和冲击波
    if (showcase) {
      for (const ry of rays) {
        const litAt = layoutMode === 'row' ? T.burst[0] : units[ry.si].lit;
        const u = (t - litAt) / (0.9 * k);
        const a = u > 0 && u < 1 ? Math.sin(Math.PI * clamp(u * 1.6)) * 0.55 * flair : 0;
        set(ry.p, { opacity: a < 0.02 ? 0 : a, transform: `translate(${f3(ry.s.x)},${f3(ry.s.y)}) rotate(${f3(25 * Math.max(u, 0))}) scale(${f3(0.6 + 0.4 * easeOutCubic(clamp(u)))})` });
      }
      for (const wv of waves) {
        const litAt = layoutMode === 'row' ? T.burst[0] : units[wv.si].lit;
        const u = (t - litAt) / (0.55 * k);
        if (u <= 0 || u >= 1) { set(wv.c, { opacity: 0 }); continue; }
        const maxR = Math.min(wv.room, D * 2.2);
        set(wv.c, { r: lerp(r, maxR, easeOutCubic(u)), opacity: (1 - u) * 0.9 * flair, 'stroke-width': 0.05 * D * (1 - u * 0.7) });
      }
      // 停留时从点赞上方飘起几颗小爱心
      for (const f of floaters) {
        const start = T.hold[0] + f.j * 0.22 * k;
        const u = (t - start) / (1.1 * k);
        if (u <= 0 || u >= 1 || t > T.outro[0] + 0.1 * k) { set(f.p, { opacity: 0 }); continue; }
        const b0 = buttons[0].c;
        const x = b0.x + Math.sin(TAU * 0.9 * u + f.j) * D * 0.22 + (hash01(seed, 'fl', f.j) - 0.5) * D * 0.4;
        const y = b0.y - r - easeOutCubic(u) * D * 1.1;
        const sc = (D / 9 / 4) * (0.8 + 0.5 * hash01(seed, 'fs', f.j)) * (u < 0.2 ? u / 0.2 : 1);
        set(f.p, { opacity: Math.sin(Math.PI * u) * flair, transform: `translate(${f3(x)},${f3(y)}) scale(${f3(sc)})` });
      }
    }
    // 手
    const hp = handPose(t);
    if (!hp) set(handG, { visibility: 'hidden' });
    else {
      const hs = handScale * (1 - 0.08 * hp.press);
      set(hand, { 'fill-opacity': hp.alpha, 'stroke-opacity': hp.alpha }); // 透明度设在图形自己身上，理由同按钮组
      set(handG, {
        visibility: 'visible',
        transform: `translate(${f3(hp.x)},${f3(hp.y + hp.press * D * 0.04)}) rotate(${layoutMode === 'column' ? 42 : -42}) scale(${f3(layoutMode === 'column' ? -hs : hs)},${f3(hs)}) translate(${-HAND_TIP.x},${-HAND_TIP.y})`,
      });
    }
  }

  const segs = layoutMode === 'row'
    ? [['intro', '入场'], ['press', '按住'], ['charge', '蓄力'], ['burst', '绽放'], ['hold', '停留'], ['outro', '出场']]
    : [['intro', '入场'], ['press', '依次点'], ['hold', '停留'], ['outro', '出场']];
  const timeline = {
    duration,
    segments: segs.map(([name, label]) => ({ name, label, start: T[name][0], end: T[name][1] })),
    beats: [
      ...units.map((u) => ({ t: u.lit, name: 'lit', unit: u.i, label: `「${labels[u.i]}」点亮（配「叮」）` })),
      { t: T.outro[0], name: 'exit', label: '开始出场' },
    ],
    units: units.map((u) => ({ i: u.i, icon: SET.icons[u.i], label: labels[u.i], enter: u.enter, lit: u.lit, exitStart: u.exit, exitEnd: u.exit + outDur })),
  };
  // 排版：只有三个小字，每个小字自成一段、不断行
  const linesDetail = labels.map((text, paragraph) => ({ text, paragraph }));
  const layout = {
    fontSize: fsLabel,
    lines: labels.slice(),
    linesDetail,
    forced: [],
    issues: checkLineBreaks(linesDetail, labels.join('\n')),
    warnings: [],
    segmentation: ctx.segmentation ? ctx.segmentation.sources : [],
    emphasis: '',
    units: 3,
    buttonDiameter: D,
    layoutMode,
    set: setId,
  };
  seek(0);
  return { timeline, layout, seek, destroy() { svg.remove(); } };
}
