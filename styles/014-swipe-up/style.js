// 014 上滑看下一集（Swipe Up）· 互动元素
// 集末提示：一只手从下往上滑，指尖拖着一道渐变拖影，上方三个箭头依次点亮；下面一句「上滑看下一集」，每滑一次逐字往上跳。
// V3 拖影上掉亮点、每滑一次箭头飞上去一个残影，最后箭头飞走、弹出「第 2 集」标签。默认透明底。
// 参数（见 meta.json）：text 提示语（*词* 标关键词）、peekText、swipes、look、palette、rhythm、font、hand、chevrons、peek、
//   size、flair、particles、material、x、y、seed。
// 质感：material=flat 平面是原来的画法，一个元素、一个属性都没改；默认 candy 亮面糖果，提示语底下的胶囊条换成底座块，
//   V3 的「第 2 集」标签换成键帽（有厚度、白亮边、镜面高光，弹出来以后扫过一道高光）。手、箭头、拖影两种质感一样。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；透明度只设在单个图形上；不用模糊滤镜；
//   文字只做等比缩放；位移和缩放的进度都过一段死区，不出现「只挪零点几个像素」「只歪零点零几度」的帧（008 开发时踩过两次：
//   这种帧的边缘抗锯齿会随机画成两种，乱序渲染对不上）。门槛按图形最远那条边挪多少像素来定。
import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, easeOutCubic, easeInCubic, easeInOutCubic, easeOutBack } from '../../engine/src/lib/ease.js';
import { graphemes, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { f3, shineSweep } from '../../engine/src/motions/index.js';
import { createParts, SWEEP_WIDTH } from '../../engine/src/parts/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');
/** 死区：进度不到 1% 当成 0，超过 99% 当成 1，中间连续接上 */
const dz = (e) => clamp((e - 0.01) / 0.98);
/** 接近 1 的缩放直接取 1 */
const s1 = (s) => (Math.abs(s - 1) < 0.003 ? 1 : s);
const bump = (u) => (u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0);

// 手：食指朝上的简笔画，指尖在 (44,6)；跟 006、008、015 同一套画法
const HAND = 'M36 13 C36 4.5 52 4.5 52 13 L52 44 C54.5 39.5 62.5 39.5 64 45.5 C66 40.5 74.5 41 75.5 47.5 C77.5 43.5 85 45 85 51.5 L85 70 C85 84.5 74.5 94.5 60 94.5 L50.5 94.5 C40.5 94.5 33.5 88.5 30 80 L21.5 62 C19.5 56.5 25.5 52.5 30.5 57 L36 63.5 Z';
const HAND_TIP = { x: 44, y: 6 };
// 亮点：四角星，中心 (0,0)、半径 4
const SPARK = 'M0 -4 Q0.7 -0.7 4 0 Q0.7 0.7 0 4 Q-0.7 0.7 -4 0 Q-0.7 -0.7 0 -4 Z';

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
  const flair = clamp(P.flair ?? 0);
  const candy = P.material === 'candy';
  const k = R.speed ?? 1;
  const h = (...a) => hash01(seed, ...a);
  const family = ctx.fontFamily(P.font);
  const nSwipes = clamp(Math.round(P.swipes ?? 2), 1, 4);
  const showChev = P.chevrons !== false;
  const showPeek = !!P.peek && String(P.peekText ?? '').trim() !== '';
  const peekText = String(P.peekText ?? '').trim();

  // 提示语：取第一行非空的；关键词按底座给的标记（段号、段内下标）
  const paras = String(ctx.text || '').replace(/\r/g, '').split('\n');
  let pi = paras.findIndex((s) => s.trim());
  const label = pi >= 0 ? paras[pi].trim() : '';
  if (pi < 0) pi = 0;

  // ---------- 量字 ----------
  const cv = document.createElement('canvas').getContext('2d');
  const meas = (ch, sq) => {
    cv.font = `100px ${family}`; cv.textAlign = 'center';
    const m = cv.measureText(ch);
    if (sq) { const L = -m.actualBoundingBoxLeft / 100; const Rr = m.actualBoundingBoxRight / 100; return { adv: Math.max(0.5, Rr - L + 0.16), off: 0.08 - L }; }
    return { adv: m.width / 100, off: m.width / 200 };
  };
  const gs = graphemes(label);
  let idx = 0;
  const chars = gs.map((ch, i) => { const c = { ch, i, kw: ctx.isEmphasis(pi, idx), ...meas(ch, squeezeAt(gs, i)) }; idx += ch.length; return c; });
  const labelEm = chars.reduce((s, c) => s + c.adv, 0);
  // 标签逐字摆：空格只留间距、不放进文字节点（底座做字体子集时不收空白，一个文字节点里夹着空格会回退到系统字体）
  cv.font = `100px ${family}`;
  const peekGlyphs = []; let peekEm = 0;
  if (showPeek) for (const ch of graphemes(peekText)) { const sp = /^\s+$/.test(ch); const adv = sp ? 0.25 : cv.measureText(ch).width / 100; peekGlyphs.push({ ch, sp, x: peekEm + adv / 2 }); peekEm += adv; }

  // ---------- 版式 ----------
  // 以手的高度 U 为单位：滑动距离 1.9U；箭头在滑动终点上方；手在起点时身子往下伸 0.885U；提示语的胶囊条在手下面。
  // 整组从上到下约 4.55U（V3 箭头残影再往上 0.4U），装不下就整体缩小
  const m = 0.05 * short;
  // 糖果的胶囊条多出往下的厚度和软影子，底下多留 0.18U
  const topF = 1.11 + 0.4 * flair; const botF = 1.545 + (candy ? 0.18 : 0);
  let U = clamp(P.size ?? 0.16, 0.1, 0.24) * short;
  U = Math.min(U, (H - 2 * m) / (1.9 + topF + botF));
  let fs = 0.3 * U;
  const padX = 0.55 * fs;
  fs = Math.min(fs, (W - 2 * m) / (labelEm + 1.1)); // 提示语太长就缩小字号
  const labelW = labelEm * fs;
  const pillW = labelW + 2 * padX; const pillH = 1.7 * fs;
  const L = 1.9 * U;
  const groupH = L + (topF + botF) * U;
  const cyG = clamp((P.y ?? (vertical ? 0.55 : 0.5)) * H, m + groupH / 2, H - m - groupH / 2); // 整组中心
  const sc = cyG - (botF - topF) * U / 2; // 滑动中点
  const y0 = sc + L / 2; const y1 = sc - L / 2; // 指尖的起点、终点
  const halfW = Math.max(pillW / 2, 0.45 * U);
  const cx = clamp((P.x ?? 0.5) * W, m + halfW, W - m - halfW);
  const labelY = y0 + 1.29 * U;
  const chevW = 0.46 * U; const chevH = 0.18 * U;
  const chevY = [0, 1, 2].map((j) => y1 - 0.42 * U - j * 0.3 * U); // 从下往上
  const peekY = y1 - 0.72 * U;
  const peekFs = 0.3 * U; const triW = 0.5 * peekFs; const peekPad = 0.5 * peekFs;
  const peekW = peekPad * 2 + triW + 0.25 * peekFs + peekEm * peekFs; const peekH = 1.6 * peekFs;
  const handS = U / 100;
  { let acc = 0; for (const c of chars) { c.x = cx - labelW / 2 + (acc + c.off) * fs; acc += c.adv; } }

  // ---------- 时间轴 ----------
  const tIntro = 0.45 * k;
  const loopDur = 1.0 * k;
  const swipeAt = [...Array(nSwipes).keys()].map((i) => tIntro + i * loopDur);
  const tSwEnd = tIntro + nSwipes * loopDur;
  const tPeek = swipeAt[nSwipes - 1] + 0.62 * loopDur; // 最后一次滑完，箭头飞走、标签弹出来
  const holdEnd = tSwEnd + 1.2 + (R.holdExtra ?? 0);
  const outDur = 0.3;
  const outroEnd = holdEnd + outDur;
  const duration = outroEnd + 0.1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: tIntro },
      { name: 'swipe', label: `上滑 ${nSwipes} 次`, start: tIntro, end: tSwEnd },
      { name: 'hold', label: '停留', start: tSwEnd, end: holdEnd },
      { name: 'outro', label: '出场', start: holdEnd, end: outroEnd },
    ],
    beats: [
      ...swipeAt.map((t0, i) => ({ t: t0 + 0.55 * loopDur, name: 'swipe', label: `第 ${i + 1} 次滑到顶` })),
      ...(showPeek ? [{ t: tPeek, name: 'peek', label: '弹出下一集标签' }] : []),
    ],
    units: chars.map((c) => ({ i: c.i, char: c.ch, enter: 0.1 * k + c.i * 0.03 * k, exitStart: holdEnd, exitEnd: outroEnd })),
  };

  // ---------- 搭 SVG ----------
  // 三层：最下面是拖影、涟漪、亮点、箭头残影；中间是箭头、标签、提示语；最上面是手。这几个 <g> 只当容器
  const uid = ctx.uid ? `${ctx.uid}-su` : 'su' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  const back = el('g', {}, svg); const mid = el('g', {}, svg); const front = el('g', {}, svg);
  // 拖影：一条竖线，渐变从尾巴的透明到指尖的强调色；渐变两端每帧跟着尾巴和指尖走
  const grad = el('linearGradient', { id: `${uid}-trail`, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0', 'stop-color': K.accent, 'stop-opacity': 0.08 }, grad);
  el('stop', { offset: '1', 'stop-color': K.accent, 'stop-opacity': 0.95 }, grad);
  const trail = el('line', { x1: f3(cx), y1: 0, x2: f3(cx), y2: 0, stroke: `url(#${uid}-trail)`, 'stroke-width': f3((0.22 + 0.04 * flair) * U), 'stroke-linecap': 'round' }, back); // 比手指宽一点，手盖住的地方两边也露得出来
  const core = flair > 0 ? el('line', { x1: f3(cx), y1: 0, x2: f3(cx), y2: 0, stroke: K.inner, 'stroke-width': f3(0.045 * U), 'stroke-linecap': 'round' }, back) : null;
  // 按下时的涟漪
  const ripples = swipeAt.map(() => el('circle', { cx: 0, cy: 0, r: f3(0.3 * U), fill: 'none', stroke: K.accent, 'stroke-width': f3(0.035 * U) }, back));
  // 亮点（V3）：每滑一次，沿着拖影掉一串
  const nP = Math.round(P.particles ?? 0);
  const sparks = [];
  for (let s = 0; s < nSwipes; s++) for (let i = 0; i < nP; i++) {
    const at = lerp(0.18, 0.55, h('sa', s, i)); // 在滑动的哪一刻掉下来（按一次滑动的进度算）
    const side = h('sx', s, i) < 0.5 ? -1 : 1;
    const drift = side * lerp(0.12, 0.38, h('sd', s, i)) * U;
    const maxDrift = side > 0 ? W - m - cx - 0.05 * U : cx - m - 0.05 * U; // 不出画面
    sparks.push({ s, at, drift: side * Math.min(Math.abs(drift), maxDrift), fall: lerp(0.05, 0.25, h('sf', s, i)) * U, sz: lerp(0.6, 1.2, h('sz', s, i)) * 0.025 * U, spin: (h('sr', s, i) - 0.5) * 240, e: el('path', { d: SPARK, fill: h('sc', s, i) < 0.6 ? K.accent : K.inner }, back) });
  }
  // 箭头残影（V3）：每次滑到顶，最上面那个箭头飞上去一个残影
  const chevPath = `M${f3(-chevW / 2)} ${f3(chevH / 2)} L0 ${f3(-chevH / 2)} L${f3(chevW / 2)} ${f3(chevH / 2)}`;
  const chevStroke = { fill: 'none', 'stroke-width': f3(0.075 * U), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const ghosts = flair > 0 && showChev ? swipeAt.map(() => el('path', { d: chevPath, stroke: K.accent, ...chevStroke }, back)) : [];
  // 箭头：底色一层、点亮一层
  const chevs = showChev ? chevY.map(() => ({ base: el('path', { d: chevPath, stroke: K.fill2, ...chevStroke }, mid), lit: el('path', { d: chevPath, stroke: K.accent, ...chevStroke }, mid) })) : [];
  // 下一集标签（V3）：强调色胶囊，里面一个播放三角加字
  // 糖果：标签和胶囊条用底座的共用零件，画在中间这一层（跟平面一样在箭头之后、提示语的字之前）
  const kit = candy ? createParts(svg, { uid: `${uid}-pk`, material: 'candy', defs, parent: mid }) : null;
  let peek = null; let peekKey = null;
  if (showPeek && candy) {
    // 三角和字直接画在画面坐标上：零件每帧会改写它们自己的 transform
    const cw = triW + 0.25 * peekFs + peekEm * peekFs; const lx = cx - cw / 2;
    peekKey = kit.key({ cx, cy: peekY, w: peekW, h: peekH, radius: peekH / 2, color: K.accent,
      draw: (par) => {
        const tx = lx + triW / 2;
        const tri = el('path', { d: `M${f3(tx - triW * 0.42)} ${f3(peekY - triW * 0.5)} L${f3(tx + triW * 0.58)} ${f3(peekY)} L${f3(tx - triW * 0.42)} ${f3(peekY + triW * 0.5)} Z`, fill: K.bg, 'stroke-linejoin': 'round', stroke: K.bg, 'stroke-width': f3(0.08 * triW) }, par);
        const gs = peekGlyphs.filter((g) => !g.sp).map((g) => { const e = el('text', { x: f3(lx + triW + 0.25 * peekFs + g.x * peekFs), y: f3(peekY), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(peekFs), fill: K.bg }, par); e.textContent = g.ch; return e; });
        return [tri, ...gs];
      } });
  } else if (showPeek) {
    peek = {
      rect: el('rect', { x: f3(-peekW / 2), y: f3(-peekH / 2), width: f3(peekW), height: f3(peekH), rx: f3(peekH / 2), fill: K.accent }, mid),
      tri: el('path', { d: `M${f3(-triW * 0.42)} ${f3(-triW * 0.5)} L${f3(triW * 0.58)} 0 L${f3(-triW * 0.42)} ${f3(triW * 0.5)} Z`, fill: K.bg, 'stroke-linejoin': 'round', stroke: K.bg, 'stroke-width': f3(0.08 * triW) }, mid),
      glyphs: peekGlyphs.filter((g) => !g.sp).map((g) => { const e = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(peekFs), fill: K.bg }, mid); e.textContent = g.ch; return { e, x: g.x }; }),
    };
  }
  // 提示语的胶囊条和字
  const pill = label && !candy ? el('rect', { x: f3(-pillW / 2), y: f3(-pillH / 2), width: f3(pillW), height: f3(pillH), rx: f3(pillH / 2), fill: K.bg }, mid) : null;
  // 糖果的胶囊条不透明（平面是半透明的底）：糖果一层叠一层，半透明会透出侧壁
  const pillSlab = label && candy ? kit.slab({ x: cx - pillW / 2, y: labelY - pillH / 2, w: pillW, h: pillH, radius: pillH / 2, color: K.bg, depth: 0.18 * pillH }) : null;
  for (const c of chars) {
    c.t = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(fs), fill: c.kw ? K.accent : K.sub }, mid);
    c.t.textContent = c.ch;
  }
  // 手
  const handG = P.hand !== false ? el('g', {}, front) : null;
  let handPath = null;
  if (handG) {
    const inner = el('g', { transform: `scale(${f3(handS)}) translate(${-HAND_TIP.x},${-HAND_TIP.y})` }, handG);
    handPath = el('path', { d: HAND, fill: K.inner, stroke: '#1E1E1E', 'stroke-width': 5.5, 'stroke-linejoin': 'round' }, inner);
  }

  // 第几次滑动、这一次的进度（0–1）；不在滑动里返回 null
  const loopAt = (t) => {
    for (let i = nSwipes - 1; i >= 0; i--) if (t >= swipeAt[i]) { const p = (t - swipeAt[i]) / loopDur; return p < 1 ? { i, p } : null; }
    return null;
  };
  // 指尖在一次滑动里的位置
  const tipAt = (p) => lerp(y0, y1, dz(easeInOutCubic(clamp((p - 0.12) / 0.43))));

  // ---------- 每一帧 ----------
  function seek(time) {
    const t = clamp(time, 0, duration);
    const qOut = dz(easeInCubic(clamp((t - holdEnd) / outDur)));
    const outS = s1(Math.max(1 - qOut, 0.001));
    const op = clamp(t / (0.15 * k)) * (1 - qOut);
    const on = op > 0.002;
    const lp = loopAt(t);

    // 提示语：胶囊条弹出来，字逐个跟进；每滑一次，字从左到右依次往上跳一下（关键词跳得更高）
    if (pill) {
      const pu = clamp(t / (0.3 * k));
      const ps = s1(easeOutBack(pu) * outS);
      vis(pill, on && pu > 0);
      set(pill, { transform: `translate(${f3(cx)},${f3(labelY)}) scale(${f3(Math.max(ps, 0.001))})`, 'fill-opacity': f3((K.bg === '#FFFFFF' ? 0.85 : 0.6) * op) });
    }
    if (pillSlab) {
      const pu = clamp(t / (0.3 * k));
      const ps = s1(easeOutBack(pu) * outS);
      pillSlab.set({ visible: on && pu > 0, transform: `translate(${f3(cx)},${f3(labelY)}) scale(${f3(Math.max(ps, 0.001))}) translate(${f3(-cx)},${f3(-labelY)})`, opacity: op });
    }
    for (const c of chars) {
      const u = (t - (0.1 * k + c.i * 0.03 * k)) / (0.25 * k);
      const cOn = on && u > 0;
      vis(c.t, cOn);
      if (!cOn) continue;
      let hop = 0;
      if (lp) hop = bump((lp.p - 0.3 - c.i * 0.045) / 0.32) * (0.16 + 0.1 * flair) * (c.kw ? 1.35 : 1) * fs;
      if (Math.abs(hop) < 0.3) hop = 0; // 跳动不到 0.3 像素当成没跳
      const rise = (1 - dz(easeOutCubic(clamp(u)))) * 0.4 * fs;
      const s = s1(lerp(0.5, 1, easeOutBack(clamp(u))) * outS);
      set(c.t, { transform: `translate(${f3(c.x)},${f3(labelY + rise - hop)}) scale(${f3(Math.max(s, 0.001))})`, opacity: f3(clamp(u * 3) * op) });
    }

    // 箭头：入场时从下往上依次出来；每滑一次依次点亮，点亮的往上抬一点。V3 最后一次滑完，箭头飞走
    const flyOff = showPeek ? dz(easeInCubic(clamp((t - tPeek) / 0.25))) : 0;
    chevs.forEach((cg, j) => {
      const u = (t - (0.15 * k + j * 0.06 * k)) / (0.25 * k);
      let lit = 0;
      if (lp) lit = bump((lp.p - 0.3 - j * 0.1) / 0.3);
      const up = (Math.abs(lit) < 0.03 ? 0 : lit) * 0.07 * U + flyOff * (0.5 + 0.15 * j) * U; // 抬不到 0.3 像素当成没抬
      const s = s1(lerp(0.4, 1, easeOutBack(clamp(u))) * outS * (1 - 0.3 * flyOff));
      const cOn = on && u > 0 && flyOff < 0.999;
      const T = `translate(${f3(cx)},${f3(chevY[j] - up)}) scale(${f3(Math.max(s, 0.001))})`;
      vis(cg.base, cOn); vis(cg.lit, cOn && lit > 0.01);
      set(cg.base, { transform: T, opacity: f3(0.4 * clamp(u * 2) * op * (1 - flyOff)) });
      set(cg.lit, { transform: T, opacity: f3(lit * op * (1 - flyOff)) });
    });
    // 箭头残影（V3）
    ghosts.forEach((g, i) => {
      const u = (t - (swipeAt[i] + 0.55 * loopDur)) / 0.4;
      const gOn = on && u > 0 && u < 1;
      vis(g, gOn);
      if (gOn) set(g, { transform: `translate(${f3(cx)},${f3(chevY[2] - dz(easeOutCubic(u)) * 0.4 * U)}) scale(${f3(s1(1 + 0.3 * easeOutCubic(u)))})`, opacity: f3(0.8 * (1 - u) * op) });
    });
    // 下一集标签（V3）：弹出来，歪一下再摆正
    if (peekKey) {
      const u = (t - tPeek - 0.08) / 0.35;
      const s = s1(easeOutBack(clamp(u)) * outS);
      let rot = -8 * (1 - dz(easeOutCubic(clamp(u * 1.4))));
      if (Math.abs(rot) < 0.3) rot = 0; // 0.3 度以下归零
      peekKey.set({ visible: on && u > 0, transform: `translate(${f3(cx)},${f3(peekY)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))}) translate(${f3(-cx)},${f3(-peekY)})`, opacity: op,
        sweep: shineSweep(t, { start: tPeek + 0.45, duration: 0.6, width: SWEEP_WIDTH, ease: easeInOutCubic }) });
    }
    if (peek) {
      const u = (t - tPeek - 0.08) / 0.35;
      const pOn = on && u > 0;
      for (const e of [peek.rect, peek.tri, ...peek.glyphs.map((g) => g.e)]) vis(e, pOn);
      if (pOn) {
        const s = s1(easeOutBack(clamp(u)) * outS);
        let rot = -8 * (1 - dz(easeOutCubic(clamp(u * 1.4))));
        if (Math.abs(rot) < 0.3) rot = 0; // 0.3 度以下归零
        const T = `translate(${f3(cx)},${f3(peekY)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))})`;
        const cw = triW + 0.25 * peekFs + peekEm * peekFs;
        set(peek.rect, { transform: T, opacity: f3(op) });
        set(peek.tri, { transform: `${T} translate(${f3(-cw / 2 + triW / 2)},0)`, opacity: f3(op) });
        for (const g of peek.glyphs) set(g.e, { transform: `${T} translate(${f3(-cw / 2 + triW + 0.25 * peekFs + g.x * peekFs)},0)`, opacity: f3(op) });
      }
    }

    // 拖影：指尖往上走时，尾巴落后一截跟着；滑到顶以后尾巴追上来，拖影收掉
    let tail = y0; let tip = y0; let tOn = false;
    if (lp && lp.p > 0.12 && lp.p < 0.8) {
      tip = tipAt(Math.min(lp.p, 0.55));
      const pt = lp.p <= 0.55 ? lp.p - 0.3 : 0.25 + (lp.p - 0.55) * 2; // 尾巴落后一截；到顶以后加速追上来，第 0.7 左右收完
      tail = tipAt(Math.min(pt, 0.55));
      tOn = tail - tip > 1;
    }
    vis(trail, on && tOn);
    if (core) vis(core, on && tOn);
    if (tOn) {
      set(grad, { x1: f3(cx), y1: f3(tail), x2: f3(cx), y2: f3(tip) });
      set(trail, { y1: f3(tail), y2: f3(tip), opacity: f3(op) });
      if (core) set(core, { y1: f3(lerp(tail, tip, 0.45)), y2: f3(tip), opacity: f3(0.7 * op) });
    }
    // 涟漪：每次按下时在起点扩开
    ripples.forEach((rp, i) => {
      const u = (t - (swipeAt[i] + 0.06 * loopDur)) / 0.4;
      const rOn = on && u > 0 && u < 1;
      vis(rp, rOn);
      if (rOn) set(rp, { transform: `translate(${f3(cx)},${f3(y0)}) scale(${f3(0.35 + 1.1 * dz(easeOutCubic(u)))})`, opacity: f3(0.8 * (1 - u) * op) });
    });
    // 亮点（V3）：在拖影上掉下来，往两边飘、往下落，淡掉
    for (const sp of sparks) {
      const born = swipeAt[sp.s] + sp.at * loopDur;
      const u = (t - born) / 0.55;
      const sOn = on && u > 0 && u < 1;
      vis(sp.e, sOn);
      if (!sOn) continue;
      const y = tipAt(sp.at);
      const e = dz(easeOutCubic(u));
      set(sp.e, { transform: `translate(${f3(cx + sp.drift * e)},${f3(y + sp.fall * e)}) rotate(${f3(sp.spin * u)}) scale(${f3(Math.max(sp.sz * (1 - 0.4 * u), 0.001))})`, opacity: f3((1 - u) * op) });
    }

    // 手：入场时在起点淡入；每一次：按下 → 往上滑 → 到顶松开淡出 → 回到起点淡入；滑完以后停在起点
    if (handG) {
      let y = y0; let a = 0; let s = 1; let rot = 0;
      if (t < tIntro) {
        a = clamp((t - 0.2 * k) / (0.25 * k));
        s = lerp(0.85, 1, dz(easeOutCubic(a)));
      } else if (lp) {
        const p = lp.p;
        if (p < 0.12) { a = 1; s = 1 - 0.06 * bump(p / 0.24); }
        else if (p < 0.55) { a = 1; y = tipAt(p); rot = -6 * bump((p - 0.12) / 0.43); }
        else if (p < 0.68) { y = y1; const u = (p - 0.55) / 0.13; a = 1 - u; s = 1 + 0.05 * u; rot = 0; }
        else if (p < 0.82) { a = 0; }
        else { const u = (p - 0.82) / 0.18; a = u; s = lerp(0.9, 1, dz(easeOutCubic(u))); }
      } else { a = 1; }
      if (Math.abs(rot) < 0.3) rot = 0; // 0.3 度以下归零
      s = s1(s * outS);
      const hOn = on && a > 0.002;
      vis(handG, hOn);
      if (hOn) {
        set(handG, { transform: `translate(${f3(cx)},${f3(y)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))})` });
        // 淡入淡出写在手那条路径上，不写在整组上（底座硬规矩第 6 条）
        handPath.setAttribute('opacity', f3(clamp(a) * op));
      }
    }
  }

  const lines = label ? [{ text: label, index: 0, paragraph: pi }] : [];
  const issues = label ? checkLineBreaks(lines, ctx.text, { segment: ctx.segment }) : [];
  const warnings = label ? icuBreakWarnings(lines, ctx.text) : [];
  if (gs.length > 8) warnings.push({ type: 'too-long', detail: `提示语 ${gs.length} 个字，超过 8 个字胶囊条会很长` });
  seek(0);
  return {
    timeline,
    layout: { fontSize: fs, lines: label ? [label] : [], forced: [], issues, warnings, segmentation: ctx.segmentation ? ctx.segmentation.sources : [], units: chars.length, handHeight: U },
    seek,
    destroy() { svg.remove(); },
  };
}
