// 013 价格标签（Price Tag）· 互动元素
// 原价先出来、被一道斜线划掉；到手价砸进来，数字从原价一路滚到最终价，落地时弹一下；价格下面弹出「省 ××」小标签。默认透明底。
// 参数（见 meta.json）：text 价格前面的小标签（默认「到手价」）、price 到手价、original 原价、strike 划掉原价、save 省多少标签、
//   currency 货币写法、decimals 小数位、roll 数字怎么滚、originalLabel、saveLabel、look（V1 日常 / V3 招牌）、palette、rhythm、
//   font、size、card 吊牌底、flair 招牌强度、particles 小星星数、material 质感（flat 平面 / candy 亮面糖果）、hold、x、y、seed。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；
//   透明度只设在单个图形上，不给整组做透明度动画；会转的东西不带模糊（投影用不模糊的硬投影）；
//   文字只做等比缩放；震动、缩放都写进每个元素自己的 transform，不挪整组；
//   动的量极小的那几帧直接当成没动（《写一个新风格》第 3 节的建议），吊牌只有底板在晃，上面的字不跟着转。
import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, easeOutCubic, easeInCubic, easeOutBack, easeInOutCubic } from '../../engine/src/lib/ease.js';
import { graphemes } from '../../engine/src/lib/text.js';
import { countUp, formatNumber, shake, shineSweep, shineStops, f3 } from '../../engine/src/motions/index.js';
import { createParts } from '../../engine/src/parts/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');

/** 小数位：按用户写的数推，最多 2 位 */
function decimalsOf(v) {
  const s = String(v);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(2, s.length - i - 1);
}

// 胶囊（小标签、省多少）用底座的徽章 badge，吊牌底板用底座块 slab（engine/src/parts）。
// 平面画法跟换零件之前完全一样；material=candy 换成亮面糖果质感，动画代码不变。

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm || {};
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const family = ctx.fontFamily(P.font);
  const flair = clamp(P.flair ?? 0);
  const h = (...k) => hash01(seed, ...k);

  // ---------- 数 ----------
  const price = Math.max(0, Number(P.price ?? 99) || 0);
  const original = P.original === null || P.original === undefined || P.original === '' ? null : Math.max(0, Number(P.original) || 0);
  const wantStrike = P.strike !== false && original !== null;
  const strike = wantStrike && original > price;
  const showSave = strike && P.save !== false;
  const decimals = Number.isFinite(P.decimals) && P.decimals >= 0 ? clamp(Math.round(P.decimals), 0, 2) : Math.max(decimalsOf(price), strike ? decimalsOf(original) : 0);
  const fmt = (v) => formatNumber(v, { decimals });
  const cur = P.currency || '¥'; // '¥' 写在前面、'元' 写在后面、'none' 不写
  const money = (v) => (cur === '¥' ? '¥' + fmt(v) : cur === '元' ? fmt(v) + '元' : fmt(v));
  const label = graphemes(String(ctx.text ?? '').replace(/\s+/g, '')).join('');
  const origLabel = String(P.originalLabel ?? '原价').trim();
  const saveLabel = String(P.saveLabel ?? '省').trim();
  const origText = strike || wantStrike ? (origLabel ? origLabel + ' ' : '') + money(original ?? 0) : '';
  const showOrig = strike; // 原价不比到手价高就不画（检查里报出来）
  const saveText = showSave ? saveLabel + money(original - price) : '';
  const rollMode = P.roll || 'down';
  const rollFrom = rollMode === 'none' ? price : rollMode === 'down' && strike ? original : 0;

  // ---------- 量字 ----------
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `100px ${family}`;
  const adv = (s) => meas.measureText(s).width / 100;
  const digitAdv = Math.max(...[...'0123456789'].map(adv));
  const asc = meas.measureText('0').actualBoundingBoxAscent / 100 || 0.72; // 数字的高（占字号）

  // 下面的尺寸都以「大数字的字号」为 1
  const CUR = 0.5, DEC = 0.56, YUAN = 0.42, LABEL = 0.34, ORIG = 0.36, SAVE = 0.32;
  const slot = digitAdv * 0.98; // 每一位数字一个固定宽的格子，滚的时候不左右晃
  const decSlot = digitAdv * DEC * 0.98;
  const curW = cur === '¥' ? adv('¥') * CUR + 0.03 : 0;
  const pointW = decimals ? adv('.') * DEC + 0.01 : 0;
  const yuanW = cur === '元' ? 0.04 + adv('元') * YUAN : 0;
  const priceW = (n) => curW + n * slot + pointW + decimals * decSlot + yuanW;
  const piecesOf = (v) => { const [i, d = ''] = fmt(v).split('.'); return { int: i, dec: d }; };
  const finalP = piecesOf(price);
  const maxInt = Math.max(finalP.int.length, piecesOf(rollFrom).int.length);
  const pillPadX = 0.14, pillH = LABEL * 1.42;
  const pillW = label ? adv(label) * LABEL + 2 * pillPadX : 0;
  const gap = label ? 0.1 : 0;
  const blockW = (n) => pillW + gap + priceW(n);
  const origW = origText ? adv(origText) * ORIG : 0;
  const saveW = saveText ? adv(saveText) * SAVE + 0.26 : 0;
  const saveH = SAVE * 1.4;
  const card = (P.card ?? false) === true;
  const pad = card ? 0.22 : 0;
  const widest = Math.max(blockW(maxInt), pillW + gap + origW) + 2 * pad;
  const want = clamp(P.size ?? 0.25, 0.12, 0.5) * short;
  const fit = Math.min(1, (0.9 * W) / (widest * want));
  const F = want * fit; // 大数字的字号（像素）

  // 竖向：原价一行 → 价格一行 → 省多少标签（压在价格右下角）
  const rowGap = 0.2;
  const topRow = showOrig ? ORIG * 1.05 + rowGap : 0;
  const blockH = topRow + asc + (showSave ? saveH * 0.75 : 0.06);
  const cx = (P.x ?? 0.5) * W;
  const cy = (P.y ?? (vertical ? 0.64 : 0.55)) * H;
  // 按最终价居中。从原价往下滚、位数比最终价多的时候，先按最宽的位数居中（不出画面），位数降下来以后再平滑挪回正中
  const left = cx - (blockW(finalP.int.length) * F) / 2;
  const leftMax = cx - (blockW(maxInt) * F) / 2;
  const top = cy - ((blockH + 2 * pad) * F) / 2 + pad * F;
  const yB = top + (topRow + asc) * F; // 大数字基线
  const priceX = left + (pillW + gap) * F;
  const priceRight = (n) => priceX + priceW(n) * F;
  const priceMidY = yB - (asc * F) / 2;

  // ---------- 时间轴 ----------
  const showcase = flair > 0.5;
  const t0 = card ? 0.28 : 0.05; // 有吊牌时先让吊牌落下来
  const origIn = t0;
  const strikeStart = origIn + 0.32, strikeDur = 0.22;
  const labelIn = showOrig ? strikeStart + 0.1 : t0;
  const priceIn = showOrig ? strikeStart + 0.16 : t0 + 0.05;
  const rollDur = rollMode === 'none' ? 0 : P.rollTime ?? R.roll ?? 0.9;
  const rollStart = priceIn + 0.08;
  const land = rollStart + rollDur;
  const saveIn = land + 0.1;
  // 整数位数降到最终价位数的时刻（滚动是单调的，二分找）
  const valueAt = (t) => (t < rollStart ? rollFrom : rollDur > 0 ? countUp(t, { from: rollFrom, to: price, start: rollStart, duration: rollDur, decimals }).value : price);
  let shiftAt = rollStart;
  if (maxInt > finalP.int.length) {
    let a = rollStart, b = land;
    for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (piecesOf(valueAt(m)).int.length > finalP.int.length) a = m; else b = m; }
    shiftAt = b;
  }
  const shiftDur = 0.28;
  const lxAt = (t) => (leftMax - left) * (1 - easeInOutCubic(clamp((t - shiftAt) / shiftDur)));
  const holdStart = showSave ? saveIn + 0.28 : land + 0.2;
  const holdDur = P.hold ?? 1.6;
  const outroStart = holdStart + holdDur;
  const outDur = 0.35;
  const outroEnd = outroStart + outDur;
  const duration = outroEnd + 0.1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '原价出来、划掉', start: 0, end: priceIn },
      { name: 'roll', label: '到手价滚动', start: priceIn, end: Math.max(land, priceIn + 0.01) },
      { name: 'hold', label: '停留', start: holdStart, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...(showOrig ? [{ t: strikeStart, name: 'strike', label: '划掉原价' }] : []),
      { t: land, name: 'land', label: `到手价落地 ${money(price)}` },
      ...(showSave ? [{ t: saveIn, name: 'save', label: `弹出「${saveText}」` }] : []),
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: [
      ...(showOrig ? [{ i: 0, kind: 'original', text: origText, enter: origIn, exitStart: outroStart, exitEnd: outroEnd }] : []),
      ...(label ? [{ i: 1, kind: 'label', text: label, enter: labelIn, exitStart: outroStart, exitEnd: outroEnd }] : []),
      { i: 2, kind: 'price', text: money(price), enter: priceIn, land, exitStart: outroStart, exitEnd: outroEnd },
      ...(showSave ? [{ i: 3, kind: 'save', text: saveText, enter: saveIn, exitStart: outroStart, exitEnd: outroEnd }] : []),
    ],
  };

  // ---------- 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-pt` : 'pt' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  const shineId = `${uid}-shine`;
  const shineGrad = el('linearGradient', { id: shineId, gradientUnits: 'userSpaceOnUse', x1: priceX, y1: 0, x2: priceRight(finalP.int.length), y2: 0 }, defs);
  const shineStopEls = [0, 1, 2, 3, 4].map(() => el('stop', { offset: 0, 'stop-color': '#FFFFFF', 'stop-opacity': 0 }, shineGrad));
  const textAttrs = (fs, extra = {}) => ({ 'font-family': family, 'font-size': f3(fs), 'text-anchor': 'middle', ...extra });
  const candy = P.material === 'candy';
  const parts = createParts(svg, { uid, material: candy ? 'candy' : 'flat', defs });

  // 吊牌（V3）：底板、穿绳的孔、一截绳子。只有底板会晃
  const cardBox = { x: left - pad * F, y: top - pad * F, w: (blockW(finalP.int.length) + 2 * pad) * F, h: (blockH + 2 * pad) * F };
  const cardWMax = (blockW(maxInt) + 2 * pad) * F;
  const plateLayout = { y: cardBox.y, shadowOffset: [0.05 * F, 0.06 * F], holeInset: 0.2 * F, stringTo: [-0.35 * F, -0.75 * F] };
  let cardEls = null;
  if (card) {
    const plate = parts.slab({ y: cardBox.y, h: cardBox.h, radius: 0.16 * F, color: K.bg, edge: K.fill, edgeWidth: 0.035 * F, shadow: K.shadow, shadowOffset: plateLayout.shadowOffset, shadowStyle: 'drop', depth: 0.09 * F });
    const hole = el('circle', { r: f3(0.055 * F), fill: K.fill }, svg);
    const string = el('path', { stroke: K.fill, 'stroke-width': f3(0.03 * F), 'stroke-linecap': 'round', fill: 'none' }, svg);
    cardEls = { plate, hole, string };
  }
  // 吊牌每帧：底板挪到位、算出穿绳的孔，再挂绳子
  const placeCard = (x, w) => {
    cardEls.plate.place({ x, w });
    const hx = x + plateLayout.holeInset, hy = plateLayout.y + plateLayout.holeInset;
    set(cardEls.hole, { cx: hx, cy: hy });
    set(cardEls.string, { d: `M${f3(hx)},${f3(hy)} L${f3(hx + plateLayout.stringTo[0])},${f3(hy + plateLayout.stringTo[1])}` });
    return { hx, hy };
  };

  // 原价：描边一层、字一层
  const origX = priceX + (origW * F) / 2;
  const origY = yB - asc * F - rowGap * F;
  const origEls = showOrig ? ['stroke', 'fill'].map((kind) => el('text', textAttrs(ORIG * F, kind === 'stroke'
    ? { x: f3(origX), y: f3(origY), fill: K.shadow, stroke: K.shadow, 'stroke-width': f3(0.12 * ORIG * F), 'stroke-linejoin': 'round' }
    : { x: f3(origX), y: f3(origY), fill: K.inner }), svg)) : [];
  for (const e of origEls) e.textContent = origText;
  const sx0 = priceX - 0.05 * F, sx1 = priceX + (origW + 0.05) * F;
  const sy0 = origY - 0.18 * ORIG * F, sy1 = origY - 0.5 * ORIG * F;
  const strikeEls = showOrig ? [
    el('line', { x1: sx0, y1: sy0, x2: sx0, y2: sy0, stroke: K.shadow, 'stroke-width': f3(0.15 * ORIG * F), 'stroke-linecap': 'round' }, svg),
    el('line', { x1: sx0, y1: sy0, x2: sx0, y2: sy0, stroke: K.accent, 'stroke-width': f3(0.08 * ORIG * F), 'stroke-linecap': 'round' }, svg),
  ] : [];

  // 价格前面的小标签（胶囊）
  const pillCx = left + (pillW * F) / 2;
  const pillCy = yB - asc * F * 0.38;
  const pill = label ? parts.badge({ cx: pillCx, cy: pillCy, w: pillW * F, h: pillH * F, color: K.accent, shadow: K.shadow, shadowOffset: [0.03 * F, 0.04 * F], text: label, textColor: K.fill2, fontFamily: family, fontSize: LABEL * F }) : null;

  // 大价格：货币符号、每一位整数、小数点、小数、「元」，每个字四层（硬投影、描边、字、高光）
  const strokeW = 0.13 * F;
  const glyph = () => {
    const g = {};
    g.shadow = el('text', textAttrs(F, { fill: K.shadow, stroke: K.shadow, 'stroke-width': f3(strokeW), 'stroke-linejoin': 'round' }), svg);
    g.stroke = el('text', textAttrs(F, { fill: K.outer, stroke: K.outer, 'stroke-width': f3(strokeW), 'stroke-linejoin': 'round' }), svg);
    g.fill = el('text', textAttrs(F, { fill: K.fill }), svg);
    g.shine = el('text', textAttrs(F, { fill: `url(#${shineId})` }), svg);
    g.all = [g.shadow, g.stroke, g.fill, g.shine];
    return g;
  };
  const curG = cur === '¥' ? glyph() : null;
  const intG = [...Array(maxInt)].map(() => glyph());
  const pointG = decimals ? glyph() : null;
  const decG = [...Array(decimals)].map(() => glyph());
  const yuanG = cur === '元' ? glyph() : null;
  if (curG) for (const e of curG.all) { e.textContent = '¥'; set(e, { 'font-size': CUR * F }); }
  if (pointG) for (const e of pointG.all) { e.textContent = '.'; set(e, { 'font-size': DEC * F }); }
  for (const g of decG) for (const e of g.all) set(e, { 'font-size': DEC * F });
  if (yuanG) for (const e of yuanG.all) { e.textContent = '元'; set(e, { 'font-size': YUAN * F }); }

  // 省多少标签：压在价格右下角，往左歪 6°
  const saveCx = priceRight(finalP.int.length) - (saveW * F) / 2 + 0.06 * F;
  const saveCy = yB + 0.1 * F + (saveH * F) / 2 - 0.12 * F;
  // 徽章画在原点，每帧整体 translate、rotate、scale 到位
  const saveBadge = showSave ? parts.badge({ cx: 0, cy: 0, w: saveW * F, h: saveH * F, radius: 0.08 * F, color: K.fill, shadow: K.shadow, shadowOffset: [0.03 * F, 0.04 * F], text: saveText, textColor: K.outer, fontFamily: family, fontSize: SAVE * F }) : null;

  // 落地时溅出的小星星（V3）
  const nSpark = Math.round(clamp(P.particles ?? 0, 0, 24));
  const starPath = 'M0,-1 C0.12,-0.12 0.12,-0.12 1,0 C0.12,0.12 0.12,0.12 0,1 C-0.12,0.12 -0.12,0.12 -1,0 C-0.12,-0.12 -0.12,-0.12 0,-1 Z';
  const sparks = [...Array(nSpark)].map((_, i) => {
    const ang = -Math.PI / 2 + (i / Math.max(1, nSpark)) * Math.PI * 2 + (h('sa', i) - 0.5) * 0.5;
    const span = (priceW(finalP.int.length) * F) / 2;
    return {
      e: el('path', { d: starPath, fill: i % 3 === 0 ? K.fill : K.sub }, svg),
      ang, dx: Math.cos(ang) * span * lerp(0.95, 1.3, h('sd', i)), dy: Math.sin(ang) * asc * F * lerp(0.9, 1.4, h('sy', i)),
      r: F * lerp(0.05, 0.1, h('sr', i)), delay: h('sl', i) * 0.08,
    };
  });

  // ---------- 每帧 ----------
  // 等比缩放加位移写成一个矩阵：以 (px,py) 为中心缩放 s，再挪 (dx,dy)。动得太少就当没动
  const mat = (s, px, py, dx = 0, dy = 0) => {
    if (Math.abs(s - 1) < 0.004 && Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return '';
    return `matrix(${f3(s)},0,0,${f3(s)},${f3(px * (1 - s) + dx)},${f3(py * (1 - s) + dy)})`;
  };
  const tf = (e, m) => (m ? e.setAttribute('transform', m) : e.removeAttribute('transform'));
  const outU = (t) => clamp((t - outroStart) / outDur);
  const outScale = (t) => 1 - 0.3 * easeInCubic(outU(t));
  const outAlpha = (t) => 1 - easeInCubic(outU(t));

  function seek(t) {
    const shk = showcase ? shake(t, { start: land, amplitude: 0.035 * F * flair, duration: 0.3, seed, rotate: 0 }) : { dx: 0, dy: 0 };
    const lx = lxAt(t);
    const sdx = (Math.abs(shk.dx) < 0.05 ? 0 : shk.dx) + (Math.abs(lx) < 0.05 ? 0 : lx), sdy = Math.abs(shk.dy) < 0.05 ? 0 : shk.dy;
    const kw = leftMax < left ? 1 - (lx / (leftMax - left)) : 1; // 吊牌宽度从最宽收到最终宽
    const oa = outAlpha(t), os = outScale(t);
    const alive = t < outroEnd && oa > 0.02;

    // 吊牌：从上面落下来、晃两下，晃的幅度不到 0.02° 就当没晃
    if (cardEls) {
      const u = clamp((t - 0.02) / 0.3);
      // 往下落的距离：最多 0.8 个字号，而且绳头不能伸出画面顶边
      const dropMax = Math.min(0.8 * F, Math.max(0, cardBox.y + plateLayout.holeInset + plateLayout.stringTo[1] - 0.02 * H));
      const drop = (1 - easeOutBack(u, 1.2)) * -dropMax;
      const tt = t - 0.3;
      let ang = tt > 0 ? 6 * Math.exp(-5.5 * tt) * Math.sin(tt * Math.PI * 2 * 1.7) : 0;
      if (Math.abs(ang) < 0.02 || tt > 1.6) ang = 0;
      const on = t >= 0.02 && alive;
      const cw = lerp(cardWMax, cardBox.w, kw);
      const { hx, hy } = placeCard(cx - cw / 2, cw); // 吊牌跟内容一起居中
      const moves = [];
      if (Math.abs(drop) >= 0.05) moves.push(`translate(0,${f3(drop)})`);
      if (ang) moves.push(`rotate(${f3(ang)},${f3(hx)},${f3(hy)})`);
      const tr = [mat(os, cx, cy), ...moves].filter(Boolean).join(' ');
      cardEls.plate.set({ visible: on, transform: tr, opacity: oa });
      for (const e of [cardEls.hole, cardEls.string]) {
        vis(e, on);
        tf(e, tr);
        set(e, { opacity: oa });
      }
    }

    // 原价：弹出来，划掉以后变暗一点
    if (showOrig) {
      const u = clamp((t - origIn) / 0.26);
      const s = (0.6 + 0.4 * easeOutBack(u)) * os;
      const dim = 1 - 0.22 * easeOutCubic(clamp((t - strikeStart - strikeDur) / 0.2));
      const on = t >= origIn && alive;
      const m = mat(s, origX, origY, sdx, sdy);
      origEls.forEach((e, i) => { vis(e, on); tf(e, m); set(e, { opacity: clamp(u * 3) * oa * (i === 1 ? dim : 1) }); });
      const p = easeOutCubic(clamp((t - strikeStart) / strikeDur));
      const on2 = p > 0.02 && alive;
      for (const e of strikeEls) {
        vis(e, on2);
        set(e, { x2: lerp(sx0, sx1, p), y2: lerp(sy0, sy1, p), opacity: oa });
        tf(e, mat(os, origX, origY, sdx, sdy));
      }
    }

    // 小标签胶囊
    if (label) {
      const u = clamp((t - labelIn) / 0.28);
      const s = easeOutBack(u) * os;
      const on = t >= labelIn && s >= 0.2 && alive;
      pill.set({ visible: on, transform: mat(s, pillCx, pillCy, sdx, sdy), opacity: oa });
    }

    // 大价格：砸进来（1.25 倍 → 1），边滚边落，落地弹一下
    const showPrice = t >= priceIn && alive;
    const v = valueAt(t);
    const pc = piecesOf(v);
    const n = pc.int.length;
    const uIn = clamp((t - priceIn) / 0.22);
    // 放大量不能让价格碰到画面边：按这一帧价格的左右外沿（含描边）离画面边还剩多少，算出最多能放大多少
    const pcx0 = (priceX + priceRight(finalP.int.length)) / 2;
    const xl = priceX - strokeW, xr = priceRight(n) + strokeW;
    const margin = 0.02 * W;
    const room = Math.min((pcx0 + lx - margin) / Math.max(1, pcx0 - xl), (W - margin - pcx0 - lx) / Math.max(1, xr - pcx0)) - 1;
    const sIn = 1 + clamp(room, 0, 0.25) * (1 - easeOutCubic(uIn));
    const bumpU = clamp((t - land) / 0.24);
    const bump = t >= land ? clamp(room, 0, 0.1) * Math.sin(Math.PI * bumpU) * (1 - bumpU * 0.3) : 0;
    const s = (sIn + bump) * os;
    const pcx = pcx0;
    const m = mat(s, pcx, priceMidY, sdx, sdy);
    const aIn = clamp(uIn * 2.5) * oa;
    const sw = shineSweep(t, { start: land + 0.08, duration: 0.55, width: 0.22 });
    const shineOn = showcase && sw.visible;
    if (shineOn) shineStops(sw.u, { width: 0.22, peak: 0.85 }).forEach(([o, op], i) => { if (shineStopEls[i]) set(shineStopEls[i], { offset: o, 'stop-opacity': op }); });
    const place = (g, ch, x, y) => {
      for (const e of g.all) {
        const on = showPrice && (e !== g.shine || shineOn);
        vis(e, on);
        e.textContent = ch;
        const off = e === g.shadow ? 0.045 * F : 0;
        set(e, { x: x + off, y: y + off, opacity: aIn });
        tf(e, m);
      }
    };
    let x = priceX;
    if (curG) { place(curG, '¥', x + (adv('¥') * CUR * F) / 2, yB); x += curW * F; }
    intG.forEach((g, j) => {
      if (j < n) place(g, pc.int[j], x + (j + 0.5) * slot * F, yB);
      else for (const e of g.all) vis(e, false);
    });
    x += n * slot * F;
    if (pointG) { place(pointG, '.', x + (pointW * F) / 2, yB); x += pointW * F; }
    decG.forEach((g, j) => place(g, pc.dec[j] || '0', x + (j + 0.5) * decSlot * F, yB));
    x += decimals * decSlot * F;
    if (yuanG) place(yuanG, '元', x + (0.04 + (adv('元') * YUAN) / 2) * F, yB);

    // 省多少：落地后弹出来
    if (showSave) {
      const u = clamp((t - saveIn) / 0.3);
      const ss = easeOutBack(u, 2.2) * os;
      const on = t >= saveIn && ss >= 0.2 && alive;
      const tr = `translate(${f3(saveCx + sdx)},${f3(saveCy + sdy)}) rotate(-6) scale(${f3(ss)})`;
      saveBadge.set({ visible: on, transform: tr, opacity: oa });
    }

    // 小星星：落地时从价格周围弹出来再收回去，缩得很小的那几帧先隐藏
    for (const sp of sparks) {
      const u = clamp((t - land - sp.delay) / 0.34);
      const k = u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u);
      const on = k >= 0.2 && alive;
      vis(sp.e, on);
      if (!on) continue;
      const d = 0.8 + 0.35 * easeOutCubic(u);
      sp.e.setAttribute('transform', `translate(${f3(pcx + sp.dx * d + sdx)},${f3(priceMidY + sp.dy * d + sdy)}) rotate(${f3(sp.ang * 57.2958)}) scale(${f3(sp.r * k)})`);
    }
  }

  // ---------- 检查 ----------
  const warnings = [];
  const styleChecks = [
    { id: 'price-order', level: 'warn', pass: !wantStrike || strike, message: wantStrike && !strike ? `原价 ${money(original)} 不比到手价 ${money(price)} 高，没画划线和「${saveLabel}」标签` : strike ? `原价 ${money(original)} 划掉，到手价 ${money(price)}，${saveLabel} ${money(original - price)}` : '没给原价，只出到手价' },
    { id: 'fit', level: 'warn', pass: fit >= 0.85, message: fit < 0.999 ? `价格太长，整体缩到设定字号的 ${(fit * 100).toFixed(0)}%，才放得进画面宽的 90%` : `字号 ${F.toFixed(0)} 像素，最宽占画面宽 ${((widest * F) / W * 100).toFixed(0)}%` },
    { id: 'roll-consistent', level: 'warn', pass: fmt(price) === finalP.int + (decimals ? '.' + finalP.dec : ''), message: `滚到最后显示 ${money(price)}，跟停住时的写法一样（${decimals} 位小数）` },
  ];
  if (label && graphemes(label).length > 4) warnings.push({ type: 'too-long', detail: `价格前面的小标签 ${graphemes(label).length} 个字，超过 4 个会把价格挤小` });

  seek(0);
  return {
    timeline,
    layout: {
      fontSize: F,
      lines: [origText, label, money(price), saveText].filter(Boolean),
      forced: [],
      issues: [],
      warnings,
      segmentation: ctx.segmentation.sources,
      units: timeline.units.length,
      styleChecks,
      priceBox: { x: priceX, y: yB - asc * F, w: priceW(finalP.int.length) * F, h: asc * F },
    },
    seek,
    destroy() { svg.remove(); },
  };
}
