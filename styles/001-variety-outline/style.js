// 001 综艺花字（原型，styles/001-variety-outline）
//
// 风格契约（engine/docs/写一个新风格.md 有完整说明）：
//   create(root, ctx) 只按 (参数, 画面尺寸) 搭好 SVG，返回 { timeline, layout, seek, destroy }；
//   seek(t) 是纯函数：每次都把所有会动的属性从头算一遍写进去，结果只取决于 t，
//   不依赖上一次 seek、真实时钟或 Math.random()。所以可以任意跳帧、乱序、并行渲染。
//
// 画面分层（从下到上；所有字的同一层画在一起，相邻字的描边才会连成一整块）：
//   陪衬图形（爆炸框，可选）→ 装饰 → 厚度（外描边形状往右下挤出几层）→ 外描边（深色）→ 内描边（白）
//   → 填充（上下两段渐变，外带一圈细边线；*关键词* 换强调色）→ 高光（柔光，或者一道硬边高光加左上角亮边）
// 装饰：右上角三道感叹线（有爆炸框时不画）、周围三颗四角星。
// 造型预设 V0–V3（meta.json 的 looks）只是下面几个参数的组合：jump 跳字、emph 关键词、depth 厚度、gloss 高光、
// burst 陪衬图形、bounce 入场弹性。V0 的参数全取 0/关，画面跟第 0 阶段逐帧一致。

import { hash01, stepNoise } from '../../engine/src/lib/rand.js';
import { mix } from '../../engine/src/lib/color.js';
import { clamp, lerp, spring, impulse, easeInBack } from '../../engine/src/lib/ease.js';
import { graphemes, fitText, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import {
  bounceIn, bounceTiming, popOut, wave, jitter, holdWeight, scaleBy, combine, toSvgTransform, f3,
} from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
// 尾巴死区：离静止值的偏差乘上它影响的尺寸（像素）不到 0.05，就直接落到静止值。
// 几乎没动的帧会让后面停住的画面随机出两种画法（engine/ADR-001「逐帧一致的几类坑」）
const toRest = (v, rest, reach) => (Math.abs(v - rest) * reach < 0.05 ? rest : v);
const DEG = 180 / Math.PI;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

/** 量字：普通字按字身宽度；全角标点按墨迹收紧（标点挤压）。返回槽位相对字原点的左边和宽度。
 *  family 是宿主给的整条字体链（CSS 写法，已带引号），主字体缺的字会按链落到备用字体上 */
function makeMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return function glyphBox(ch, px) {
    const key = ch + '|' + px;
    if (cache.has(key)) return cache.get(key);
    g.font = `${px}px ${family}`;
    const m = g.measureText(ch);
    let box;
    if (/\s/.test(ch)) box = { left: 0, width: m.width, blank: true };
    else if (FULLWIDTH_PUNCT.has(ch)) {
      const l = -m.actualBoundingBoxLeft;
      const r = m.actualBoundingBoxRight;
      const pad = 0.1 * px;
      box = { left: l - pad, width: Math.max(r - l, 0.1 * px) + 2 * pad };
    } else box = { left: 0, width: m.width };
    box.ascent = m.fontBoundingBoxAscent;
    box.descent = m.fontBoundingBoxDescent;
    cache.set(key, box);
    return box;
  };
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  // 配色用全库统一的 8 个角色；这个风格要的 4 档渐变、细边线和星星颜色都从角色推出来
  const K = P._palette.colors;
  const C = {
    light: mix(K.fill, '#FFFFFF', 0.78), // 渐变最上面，接近白
    mid: K.fill, // 上半段主色
    low: mix(K.fill, K.fill2, 0.45), // 下半段起点
    deep: K.fill2, // 最下面
    edge: mix(K.fill2, '#000000', 0.15), // 填充外的一圈细边线
    inner: K.inner, outer: K.outer, shadow: K.shadow, accent: K.accent,
    spark: mix(K.fill, '#FFFFFF', 0.55), // 星星
  };
  // 关键词用的渐变：从强调色推
  const E = {
    light: mix(K.accent, '#FFFFFF', 0.7), mid: mix(K.accent, '#FFFFFF', 0.15),
    low: K.accent, deep: mix(K.accent, '#000000', 0.22), edge: mix(K.accent, '#000000', 0.35),
  };
  const R = P._rhythm;
  const family = ctx.fontFamily(P.font);
  const seed = P.seed;
  const short = Math.min(W, H);
  const glyphBox = makeMeasurer(family);
  const jump = P.jump ?? 0; const depth = P.depth ?? 0; const bounce = P.bounce ?? 0;
  const useEmph = (P.emph ?? 'none') !== 'none';
  const burstOn = (P.burst ?? 'none') !== 'none';
  // 新造型（跳字或关键词）时，每个字的大小参与排版，随机值按（段号, 段内下标）取，跟断成几行无关
  const varied = jump > 0 || useEmph;
  // 垂直位置：用户没给就自动，竖屏 0.38（抖音实测花字中心中位在画面高度 33.5%），其他 0.5
  const posY = P.y ?? (H > W ? 0.38 : 0.5);
  const single = (P.strokes ?? 'full') === 'single';
  const shadowMode = P.shadow ?? 'extrude';

  /** 每个字的起伏：大小、角度、基线。jump=0 时退化成原来的轻微随机；jump=1 时大小交替、高低交替 */
  function charVar(paragraph, offset) {
    const h = (k) => hash01(seed, k, paragraph, offset);
    const phase = hash01(seed, 'alt', paragraph) < 0.5 ? 0 : 1;
    const alt = (offset + phase) % 2 === 0 ? 1 : -1;
    const rotAmp = lerp(5, 14, jump); const dyAmp = lerp(0.04, 0.15, jump); const sAmp = lerp(0.05, 0.22, jump);
    const rot = (1 - jump) * (h('rot') - 0.5) * 2 * rotAmp + jump * -alt * (0.45 + 0.55 * h('rot')) * rotAmp;
    const dy = (1 - jump) * (h('dy') - 0.5) * 2 * dyAmp + jump * alt * (0.45 + 0.55 * h('dy')) * dyAmp; // 单位：字号
    const sz = h('sz') < 0.5 ? -1 : 1;
    let s = 1 + (1 - jump) * (h('sc') - 0.5) * 2 * sAmp + jump * sz * (0.25 + 0.75 * h('sc')) * sAmp;
    const emph = useEmph && ctx.isEmphasis(paragraph, offset);
    if (emph) s = (P.emphScale ?? 1.3) * (1 + (s - 1) * 0.3); // 关键词固定在约 1.3 倍，只留一点起伏
    return { rot, dy, s, emph };
  }
  const layoutScale = (paragraph, offset) => (varied ? charVar(paragraph, offset).s : 1);

  // ---------- 排版：按词断行（分词由宿主给，见 engine/src/lib/segment.js）、挑最佳断法、放不下就缩字号 ----------
  const tracking = -0.035; // 花字字距收紧，描边才连得起来
  const ol = P.outline;
  // 一行最多多宽：画面两边各留 5%，再扣掉描边、厚度和弹跳过冲的余量，保证描边不被画面边缘切掉
  // 全部落地时整块「咚」一下：振幅 bumpAmp，衰减冲击的峰值约是振幅的 0.65 倍
  const bumpAmp = lerp(P.entrance === 'drop' ? 0.07 : 0.05, 0.07, bounce);
  const bumpPeak = bumpAmp * 0.65;
  // 最大的字按多大算：跳字最多放大 sAmp，关键词再乘 emphScale；入场冲过头的余量按最大的字留
  const sMax = varied ? (1 + lerp(0.05, 0.22, jump)) * (useEmph ? (P.emphScale ?? 1.3) : 1) : 1;
  const strokeK = (P.strokes ?? 'full') === 'single' ? 0.06 : 0.167;
  const edgeAllowance = (px) => (strokeK * ol * sMax + lerp(0.03, 0.06, depth) + 0.12 * sMax + 0.07 * bounce * sMax) * px; // 弹性大时字边转边冲过头，行尾要多留
  const atomWidth = (px) => (text, pos) => {
    let off = pos ? pos.index : 0; let w = 0;
    for (const g of graphemes(text)) {
      w += glyphBox(g, px).width * (pos ? layoutScale(pos.paragraph, off) : 1) + tracking * px;
      off += g.length;
    }
    return w;
  };
  const lineHk = 1.22 + 0.12 * jump;
  const fit = fitText(ctx.text, {
    fs0: P.size * short,
    measureAt: atomWidth,
    maxWidthAt: (px) => (W * 0.9 - 2 * edgeAllowance(px)) / (1 + bumpPeak), // 落地「咚」那一下整块会放大，宽度也要留出来
    maxLines: 3,
    maxHeight: H * 0.8,
    lineHeight: lineHk,
    segment: ctx.segment,
    weights: (typeof window !== 'undefined' && window.__hanzifxBreakWeights) || undefined, // 只给调权重的实验用
  });
  const fs = fit.fs;
  const broken = fit;
  const lineH = lineHk * fs;
  const units = [];
  broken.lines.forEach((line, li) => {
    const gs = graphemes(line.text);
    const offs = []; let o = line.index;
    for (const g of gs) { offs.push(o); o += g.length; }
    const vars = gs.map((g, gi) => (varied ? charVar(line.paragraph, offs[gi]) : null));
    const boxes = gs.map((g) => glyphBox(g, fs));
    const wOf = (gi) => boxes[gi].width * (vars[gi] ? vars[gi].s : 1);
    const total = gs.reduce((s, g, gi) => s + wOf(gi) + tracking * fs, 0) - tracking * fs;
    let cursor = -total / 2;
    const ly = (li - (broken.lines.length - 1) / 2) * lineH;
    gs.forEach((g, gi) => {
      const b = boxes[gi];
      if (!b.blank) {
        units.push({
          ch: g, line: li, x: cursor + wOf(gi) / 2, y: ly, v: vars[gi],
          ox: -(b.left + b.width / 2), // 字原点 → 槽位中心，旋转缩放都绕字的中心
          oy: (b.ascent - b.descent) / 2,
          lineWidth: total,
        });
      }
      cursor += wOf(gi) + tracking * fs;
    });
  });
  const n = units.length;
  units.forEach((u, i) => {
    u.i = i;
    if (u.v) {
      u.rot0 = u.v.rot; u.dy0 = u.v.dy * fs; u.s0 = u.v.s; u.emph = u.v.emph;
    } else {
      // 第 0 阶段的写法，保证 V0 跟原来逐帧一致
      u.rot0 = (hash01(seed, 'rot', i) - 0.5) * 10; // 每个字随机歪 ±5°
      u.dy0 = (hash01(seed, 'dy', i) - 0.5) * 0.08 * fs; // 基线上下错一点
      u.s0 = 1 + (hash01(seed, 'sc', i) - 0.5) * 0.1; // 大小差一点
      u.emph = false;
    }
    u.sign = hash01(seed, 'sign', i) < 0.5 ? -1 : 1;
  });

  // ---------- 时间轴（「表演」数据，导出时写成 timeline.json） ----------
  const bounceOpt = {
    mode: P.entrance, fs,
    freq: R.freq * (1 + 0.12 * bounce),
    damping: lerp(R.damping, Math.max(0.22, R.damping - 0.16), bounce),
    rise: lerp(0.35, 0.6, bounce), spin: lerp(28, 36, bounce), stretch: lerp(0.16, 0.3, bounce),
  };
  const { landAt, settle } = bounceTiming(bounceOpt);
  const introEnd = Math.max(0, n - 1) * R.stagger + settle;
  // 停留：用户没给就自动；4 个字以内缩到节奏停留的 3/4（R1 即 1.2 秒，按抖音实测：短句停得比长句短）
  const holdDur = P.hold ?? (n <= 4 ? R.hold * 0.75 : R.hold);
  const outroStart = introEnd + holdDur;
  const outroEnd = outroStart + Math.max(0, n - 1) * R.outStagger + R.outDur;
  const duration = outroEnd + 0.15;
  const tAllLand = Math.max(0, n - 1) * R.stagger + landAt;
  const enterAt = (i) => i * R.stagger;
  const exitAt = (i) => outroStart + i * R.outStagger;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: introEnd },
      { name: 'hold', label: '停留', start: introEnd, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...units.map((u) => ({ t: enterAt(u.i) + landAt, name: 'land', unit: u.i, label: `「${u.ch}」落地` })),
      { t: tAllLand, name: 'land-all', label: '全部落地' },
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: units.map((u) => ({
      i: u.i, char: u.ch, line: u.line, emphasis: u.emph,
      enter: enterAt(u.i), land: enterAt(u.i) + landAt,
      exitStart: exitAt(u.i), exitEnd: exitAt(u.i) + R.outDur,
    })),
  };

  // ---------- 搭 SVG ----------
  const uid = 'vo' + Math.floor(hash01(seed, ctx.text, W, H) * 1e9).toString(36);
  const svg = el('svg', {
    xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`,
    style: 'position:absolute;left:0;top:0;overflow:visible',
    'data-hanzifx-style': 'variety-outline',
  });
  const defs = el('defs', {}, svg);
  const makeFill = (id, c) => {
    const g = el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, y1: -0.5 * fs, x2: 0, y2: 0.42 * fs }, defs);
    [[0, c.light], [0.46, c.mid], [0.54, c.low], [1, c.deep]].forEach(([o, col]) => el('stop', { offset: o, 'stop-color': col }, g));
  };
  makeFill(`${uid}-fill`, C);
  if (useEmph) makeFill(`${uid}-fillE`, E);
  const glossBand = (P.gloss ?? 'soft') === 'band';
  // 柔光：上半部分从白渐隐。硬边高光：字的上半部横过去一道白色亮条，上下两条边都是清楚的分界线
  const gloss = el('linearGradient', { id: `${uid}-gloss`, gradientUnits: 'userSpaceOnUse', x1: 0, y1: -0.5 * fs, x2: 0, y2: glossBand ? 0.5 * fs : 0.05 * fs }, defs);
  (glossBand ? [[0, 0], [0.17, 0], [0.18, 0.82], [0.3, 0.62], [0.31, 0], [1, 0]] : [[0, 0.75], [0.55, 0.18], [1, 0]])
    .forEach(([o, a]) => el('stop', { offset: o, 'stop-color': '#FFFFFF', 'stop-opacity': a }, gloss));

  // 描边：完整四层＝细边线＋白内描边＋深色外描边；一层＝只有深色外描边（抖音网感 vlog 那一路）
  const ringEdge = single ? 0 : 0.022 * fs * ol; // 填充外的一圈细边线
  const ringInner = single ? 0 : 0.075 * fs * ol; // 白描边可见宽度
  const ringOuter = (single ? 0.06 : 0.07) * fs * ol; // 深色外描边可见宽度
  const outerW = 2 * (ringEdge + ringInner + ringOuter);
  const olK = Math.max(ol, 0.6);
  const exX = lerp(0.026, 0.05, depth) * fs * olK; // 厚度：往右下挤出的总距离
  const exY = lerp(0.08, 0.17, depth) * fs * olK;
  const textAttrs = {
    'font-family': family, 'font-size': f3(fs),
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'text-rendering': 'geometricPrecision',
  };

  const block = el('g', {}, svg);
  const gBurst = el('g', { 'data-layer': 'burst' }, block);
  const gDeco = el('g', { 'data-layer': 'deco' }, block); // 压在字下面，描边跟字连成一块
  // 厚度层：depth=0 时是原来的 3 层同色；depth>0 时层数加到 12（层多了台阶才看不出来），颜色从前往后逐层加深，最后面再包一圈深色边
  const steps = 3 + Math.round(9 * depth);
  const sideFront = mix(K.outer, K.fill2, 0.38);
  const layerDefs = [];
  if (shadowMode === 'extrude') {
    if (depth > 0) layerDefs.push({ key: 'exRim', off: 1, fill: K.outer, stroke: K.outer, sw: outerW + 2 * 0.03 * fs * depth });
    for (let k = steps; k >= 1; k--) {
      const tint = steps > 1 ? (k - 1) / (steps - 1) : 1;
      const col = depth > 0 ? mix(C.shadow, mix(sideFront, C.shadow, tint), depth) : C.shadow;
      layerDefs.push({ key: `ex${k}`, off: k / steps, fill: col, stroke: col, sw: outerW });
    }
  } else if (shadowMode === 'soft') {
    // 柔和投影：外描边的形状往右下错一点，半透明、模糊（模糊加在整层上，一层一个滤镜）
    const blur = el('filter', { id: `${uid}-blur`, x: '-20%', y: '-20%', width: '140%', height: '140%', 'color-interpolation-filters': 'sRGB' }, defs);
    el('feGaussianBlur', { stdDeviation: f3(0.035 * fs) }, blur);
    layerDefs.push({ key: 'drop', off: 1, offX: 0.025 * fs, offY: 0.06 * fs, fill: C.shadow, stroke: C.shadow, sw: outerW, groupAttrs: { filter: `url(#${uid}-blur)`, opacity: 0.6 } });
  }
  layerDefs.push({ key: 'outer', off: 0, fill: C.outer, stroke: C.outer, sw: outerW });
  if (!single) layerDefs.push({ key: 'inner', off: 0, fill: C.inner, stroke: C.inner, sw: 2 * (ringEdge + ringInner) });
  layerDefs.push(
    single
      ? { key: 'fill', off: 0, fill: (u) => (u.emph ? `url(#${uid}-fillE)` : `url(#${uid}-fill)`), stroke: 'none', sw: 0 }
      : { key: 'fill', off: 0, fill: (u) => (u.emph ? `url(#${uid}-fillE)` : `url(#${uid}-fill)`), stroke: (u) => (u.emph ? E.edge : C.edge), sw: 2 * ringEdge, paintOrder: 'stroke' },
  );
  if ((P.gloss ?? 'soft') !== 'none') layerDefs.push({ key: 'gloss', off: 0, fill: `url(#${uid}-gloss)`, stroke: 'none', sw: 0 });
  if (glossBand) {
    // 左上角亮边：字形减去往右下错开一点的字形，剩下的月牙形涂白（遮罩）
    units.forEach((u) => {
      const m = el('mask', { id: `${uid}-m${u.i}`, maskUnits: 'userSpaceOnUse', x: f3(-2 * fs), y: f3(-2 * fs), width: f3(4 * fs), height: f3(4 * fs) }, defs);
      const a = el('text', { ...textAttrs, x: f3(u.ox), y: f3(u.oy), fill: '#FFFFFF' }, m); a.textContent = u.ch;
      const b = el('text', { ...textAttrs, x: f3(u.ox + 0.032 * fs), y: f3(u.oy + 0.048 * fs), fill: '#000000' }, m); b.textContent = u.ch;
    });
    layerDefs.push({ key: 'shine', off: 0, fill: '#FFFFFF', stroke: 'none', sw: 0, opacity: 0.8, mask: (u) => `url(#${uid}-m${u.i})` });
  }
  const val = (x, u) => (typeof x === 'function' ? x(u) : x);
  const layers = layerDefs.map((L) => {
    const g = el('g', { 'data-layer': L.key, ...(L.groupAttrs || {}) }, block);
    const nodes = units.map((u) => {
      const t = el('text', {
        ...textAttrs, x: f3(u.ox), y: f3(u.oy),
        fill: val(L.fill, u), stroke: val(L.stroke, u), 'stroke-width': f3(L.sw),
        ...(L.paintOrder ? { 'paint-order': L.paintOrder } : {}),
        ...(L.mask ? { mask: val(L.mask, u) } : {}),
        ...(L.opacity != null ? { opacity: L.opacity } : {}),
        'data-unit': u.i,
      }, g);
      t.textContent = u.ch;
      return t;
    });
    return { ...L, nodes };
  });

  const first = units.filter((u) => u.line === 0);
  const last = n ? units.filter((u) => u.line === units[n - 1].line) : [];
  const cx = P.x * W; const cy = posY * H;
  const safe = (v, pad, size) => Math.min(Math.max(v, pad), size - pad);

  // ---------- 陪衬图形：爆炸框（自己画的锯齿星形，带外描边和厚度） ----------
  let burst = null;
  if (burstOn && n > 0) {
    const maxLW = Math.max(...units.map((u) => u.lineWidth));
    const blockH = broken.lines.length * lineH;
    const strokeB = 0.07 * fs * ol;
    // 框按字来定大小（字不迁就框）：先按字块算一个椭圆，再逐个尖角检查——
    // 冲过头（×1.12）、整块倾斜、框自己晃 ±3° 以后还会伸出画面的尖角，就往回缩，所以框会贴着字和画面边缘长
    const rx = maxLW / 2 + 0.42 * fs;
    const ry = Math.max(blockH / 2 + 0.5 * fs, 0.62 * rx);
    const N = 15;
    const m = 0.02 * short + strokeB + Math.hypot(exX, exY);
    const fitK = (px, py) => {
      let k = 1;
      for (const dTh of [-3, 3]) {
        const th = (P.tilt + dTh) / DEG;
        const qx = 1.12 * (px * Math.cos(th) - py * Math.sin(th));
        const qy = 1.12 * (px * Math.sin(th) + py * Math.cos(th));
        if (qx > 0) k = Math.min(k, (W - m - cx) / qx); else if (qx < 0) k = Math.min(k, (m - cx) / qx);
        if (qy > 0) k = Math.min(k, (H - m - cy) / qy); else if (qy < 0) k = Math.min(k, (m - cy) / qy);
      }
      return Math.max(0, k);
    };
    const spikes = [];
    for (let j = 0; j < 2 * N; j++) {
      const outer = j % 2 === 0;
      const a = -Math.PI / 2 + (j * Math.PI) / N + (hash01(seed, 'ba', j) - 0.5) * (Math.PI / N) * 0.5;
      let r = outer ? 1 + (hash01(seed, 'br', j) - 0.5) * 0.22 : 0.74 + (hash01(seed, 'br', j) - 0.5) * 0.08;
      r *= Math.min(1, fitK(Math.cos(a) * rx * r * 1.025, Math.sin(a) * ry * r * 1.025)); // 1.025：边缘抖动
      spikes.push({ a, r, outer });
    }
    // 尖角被压短的地方，两边的凹口也跟着压，保持锯齿形状
    for (let j = 1; j < 2 * N; j += 2) {
      const nb = Math.min(spikes[j - 1].r, spikes[(j + 1) % (2 * N)].r);
      spikes[j].r = Math.min(spikes[j].r, nb * 0.86);
    }
    const pathAt = (t, scale) => spikes.map((sp, j) => {
      const boil = 1 + (stepNoise(seed, t, 6, 'boil', j) - 0.5) * 0.05 * P.jitter;
      const r = sp.r * boil * scale;
      return `${j ? 'L' : 'M'}${f3(Math.cos(sp.a) * rx * r)},${f3(Math.sin(sp.a) * ry * r)}`;
    }).join(' ') + 'Z';
    const common = { 'stroke-linejoin': 'round' };
    burst = {
      sh: el('path', { ...common, fill: C.shadow, stroke: C.shadow, 'stroke-width': f3(2 * strokeB) }, gBurst),
      main: el('path', { ...common, fill: K.accent, stroke: K.outer, 'stroke-width': f3(2 * strokeB), 'paint-order': 'stroke' }, gBurst),
      inner: el('path', { ...common, fill: mix(K.sub, '#FFFFFF', 0.25), stroke: 'none' }, gBurst),
      pathAt,
    };
  }

  // ---------- 装饰 ----------
  const deco = { rays: null, stars: [] };
  if (P.deco && n > 0) {
    const lw0 = first[0].lineWidth; const y0 = first[0].y;
    const lwN = last[0].lineWidth; const yN = last[0].y;
    // 感叹线：第一行右上角，三根，分三层画（阴影 → 外描边 → 颜色），彼此不会互相盖住。有爆炸框时不画
    const rayW = 0.08 * fs;
    if (!burstOn) {
      const reach = 0.5 * fs + rayW + 2 * (ringOuter + ringEdge) + 0.02 * short;
      const ax = Math.min(cx + lw0 / 2 + 0.04 * fs, W - reach) - cx;
      const ay = Math.max(cy + y0 - 0.52 * fs, reach) - cy;
      const ds = [-82, -46, -10].map((a, k) => {
        const r0 = 0.15 * fs; const r1 = (k === 1 ? 0.5 : 0.42) * fs;
        const ca = Math.cos(a / DEG); const sa = Math.sin(a / DEG);
        return `M${f3(r0 * ca)},${f3(r0 * sa)} L${f3(r1 * ca)},${f3(r1 * sa)}`;
      }).join(' ');
      const common = { d: ds, fill: 'none', 'stroke-linecap': 'round' };
      const rg = el('g', {}, gDeco);
      deco.rays = {
        ax, ay,
        sh: el('path', { ...common, stroke: C.shadow, 'stroke-width': f3(rayW + 2 * (ringOuter + ringEdge)) }, rg),
        out: el('path', { ...common, stroke: C.outer, 'stroke-width': f3(rayW + 2 * (ringOuter + ringEdge)) }, rg),
        top: el('path', { ...common, stroke: C.accent, 'stroke-width': f3(rayW) }, rg),
      };
    }
    // 四角星：三颗，位置带一点种子随机
    const starPath = 'M0,-1 Q0.13,-0.13 1,0 Q0.13,0.13 0,1 Q-0.13,0.13 -1,0 Q-0.13,-0.13 0,-1Z';
    const spots = [
      [-lw0 / 2 - 0.36 * fs, y0 - 0.32 * fs, 0.26],
      [lwN / 2 + 0.4 * fs, yN + 0.28 * fs, 0.2],
      [-lwN / 2 + 0.05 * fs, yN + 0.66 * fs, 0.13],
    ];
    spots.forEach(([x, y, r], k) => {
      const rr = r * fs;
      const pad = rr * 1.3 + 0.06 * fs + 0.02 * short; // 星星弹出时会冲过头约 20%，边距按冲过头以后的大小留
      const jx0 = (hash01(seed, 'star-x', k) - 0.5) * 0.14 * fs;
      const jy0 = (hash01(seed, 'star-y', k) - 0.5) * 0.14 * fs;
      const sx = safe(cx + x + jx0, pad, W) - cx; const sy = safe(cy + y + jy0, pad, H) - cy;
      const jx = sx - x; const jy = sy - y;
      const g = el('g', {}, gDeco);
      const sw = (0.055 * fs) / rr; // 星星路径是单位大小，描边宽度按缩放折算回去
      el('path', { d: starPath, fill: C.outer, stroke: C.outer, 'stroke-width': f3(sw * 2), 'stroke-linejoin': 'round' }, g);
      el('path', { d: starPath, fill: C.spark }, g);
      deco.stars.push({ k, g, x: x + jx, y: y + jy, r: rr, phase: hash01(seed, 'star-p', k) * 6.283 });
    });
  }

  root.appendChild(svg);

  // ---------- 单个字在时间 t 的变换（纯函数，全部来自 engine/src/motions） ----------
  function unitTransform(u, t) {
    const enter = bounceIn(t - enterAt(u.i), { ...bounceOpt, sign: u.sign });
    if (!enter.visible) return null;
    const hw = holdWeight(t, enterAt(u.i) + landAt, exitAt(u.i));
    const m = combine(
      { dx: 0, dy: u.dy0, rot: u.rot0, sx: u.s0, sy: u.s0 },
      enter,
      hw > 0 ? scaleBy(wave(t, u.i, { fs, amount: P.wave }), hw) : null,
      hw > 0 ? scaleBy(jitter(seed, t, u.i, { fs, amount: P.jitter }), hw) : null,
      popOut(clamp((t - exitAt(u.i)) / R.outDur), { fs, sign: u.sign }),
    );
    if (Math.abs(m.sx) < 1e-3 || Math.abs(m.sy) < 1e-3) return null;
    return toSvgTransform(u.x, u.y, m);
  }

  const REACH = Math.max(W, H) * 0.5; // 整块、爆炸框、光芒按画面一半算影响的尺寸（偏大，宁可晚一点落到静止值）
  function seek(t) {
    // 整块：全部落地时「咚」一下
    const bump = toRest(1 + bumpAmp * impulse(t - tAllLand, { freq: 2.6, decay: 5 }), 1, REACH);
    block.setAttribute('transform', `translate(${f3(P.x * W)},${f3(posY * H)}) rotate(${f3(P.tilt)}) scale(${f3(bump)})`);
    for (const u of units) {
      const tr = unitTransform(u, t);
      for (const L of layers) {
        const node = L.nodes[u.i];
        if (!tr) { node.setAttribute('visibility', 'hidden'); continue; }
        node.setAttribute('visibility', 'visible');
        node.setAttribute('transform', L.off ? `translate(${f3(L.offX ?? exX * L.off)},${f3(L.offY ?? exY * L.off)}) ${tr}` : tr);
      }
    }
    // 爆炸框：比字先弹出来，停留时慢慢晃、边缘抖，出场时缩回
    if (burst) {
      const sIn = toRest(spring(t, { freq: 2.4, damping: 0.62 }), 1, REACH); // 阻尼 0.62：冲过头约 8%，不会冲出画面
      const sOut = 1 - easeInBack(clamp((t - outroStart - 0.06) / 0.3), 1.6);
      const s = Math.max(0, sIn * sOut);
      const vis = s > 1e-3 ? 'visible' : 'hidden';
      const rot = (1 - clamp(sIn)) * -14 + 2 * Math.sin(2 * Math.PI * 0.4 * t);
      const base = `rotate(${f3(rot)}) scale(${f3(Math.max(s, 1e-3))})`;
      const d = burst.pathAt(t, 1);
      burst.sh.setAttribute('d', d);
      burst.main.setAttribute('d', d);
      burst.inner.setAttribute('d', burst.pathAt(t + 0.5, 0.8));
      burst.sh.setAttribute('transform', `translate(${f3(exX)},${f3(exY)}) ${base}`);
      burst.main.setAttribute('transform', base);
      burst.inner.setAttribute('transform', `${base} rotate(9)`);
      for (const node of [burst.sh, burst.main, burst.inner]) node.setAttribute('visibility', vis);
    }
    // 装饰：全部落地时弹出，停留时闪，出场时缩回
    const din = toRest(spring(t - tAllLand + 0.05, { freq: 2.6, damping: 0.45 }), 1, REACH);
    const dout = 1 - easeInBack(clamp((t - outroStart) / 0.22), 1.6);
    const dv = Math.max(0, din * dout);
    if (deco.rays) {
      const r = deco.rays;
      const s = dv * (1 + 0.12 * (stepNoise(seed, t, 5, 'ray') - 0.5) * P.jitter);
      const vis = s > 1e-3 ? 'visible' : 'hidden';
      const base = `translate(${f3(r.ax)},${f3(r.ay)}) scale(${f3(Math.max(s, 1e-3))})`;
      r.sh.setAttribute('transform', `translate(${f3(exX)},${f3(exY)}) ${base}`);
      r.out.setAttribute('transform', base);
      r.top.setAttribute('transform', base);
      for (const node of [r.sh, r.out, r.top]) node.setAttribute('visibility', vis);
    }
    for (const s of deco.stars) {
      const tw = 0.78 + 0.22 * Math.sin(2 * Math.PI * 1.4 * t + s.phase);
      const sc = dv * tw * s.r;
      const rot = 12 * Math.sin(2 * Math.PI * 0.5 * t + s.phase);
      s.g.setAttribute('visibility', sc > 1e-3 ? 'visible' : 'hidden');
      s.g.setAttribute('transform', `translate(${f3(s.x)},${f3(s.y)}) rotate(${f3(rot)}) scale(${f3(Math.max(sc, 1e-3))})`);
    }
  }

  return {
    timeline,
    layout: {
      fontSize: fs,
      lines: broken.lines.map((l) => l.text),
      linesDetail: broken.lines,
      forced: broken.forced,
      issues: checkLineBreaks(broken.lines, ctx.text, { segment: ctx.segment }),
      warnings: icuBreakWarnings(broken.lines, ctx.text),
      segmentation: ctx.segmentation.sources,
      emphasis: units.filter((u) => u.emph).map((u) => u.ch).join(''),
      units: n,
    },
    seek,
    destroy() { svg.remove(); },
  };
}
