// 016 二选一投票条（Vote Bar）· 互动元素
// 「你选哪个」：A、B 两个选项的百分比条同时长，数字跟着滚，加起来正好 100%；滚完赢的一边放大、头上出一顶皇冠，输的一边变暗。默认透明底。
// 两种版式（layout）：stack＝上下两条（V1 默认）；split＝一根对决条，A 从左、B 从右往中间顶，中间一个「VS」跟着分界点走（V3 默认）。
// 参数（见 meta.json）：text 问题（可留空）、optionA、optionB、percent（A 的百分比，B＝100 减它）、decimals、layout、look、palette、
//   rhythm、growTime、font、size、winner 标出赢家、flair、particles、material 质感（flat 平面 / candy 亮面糖果）、hold、x、y、seed。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；
//   透明度只设在单个图形上，不给整组做透明度动画；文字只做等比缩放；震动和缩放写进每个元素自己的 transform；
//   动的量极小的那几帧当成没动；缩得很小的图形先隐藏。
import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, easeOutCubic, easeInCubic, easeOutBack } from '../../engine/src/lib/ease.js';
import { graphemes } from '../../engine/src/lib/text.js';
import { countUp, formatNumber, shake, shineSweep, shineStops, f3 } from '../../engine/src/motions/index.js';
import { createParts } from '../../engine/src/parts/index.js';
import { mix } from '../../engine/src/lib/color.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');
const oneLine = (s) => graphemes(String(s ?? '').replace(/\s*\n\s*/g, ' ').trim()).join('');

// 进度条、对决条用底座的胶囊条 pillBar，A、B、VS 圆徽章用底座的按键 key（engine/src/parts）。
// 平面画法跟换零件之前完全一样；material=candy 换成亮面糖果质感，动画代码不变。皇冠是这个元素自己的。

/** 皇冠：硬投影一层、本体一层。路径以 (0,0) 为中心、半宽 1，每帧 translate、rotate、scale 到位。
 *  糖果质感多一层高光（竖向渐变，跟本体同形状），本体换成上亮下暗的渐变 */
const CROWN = 'M-1,0.55 L-0.82,-0.55 L-0.4,-0.05 L0,-0.75 L0.4,-0.05 L0.82,-0.55 L1,0.55 Z';
function drawCrown(parent, { fill, shadow, gloss }) {
  return [el('path', { d: CROWN, fill: shadow }, parent), el('path', { d: CROWN, fill }, parent), ...(gloss ? [el('path', { d: CROWN, fill: gloss }, parent)] : [])];
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm || {};
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const family = ctx.fontFamily(P.font);
  const flair = clamp(P.flair ?? 0);
  const showcase = flair > 0.5;
  const h = (...k) => hash01(seed, ...k);

  // ---------- 数：两边加起来正好 100 ----------
  const decimals = clamp(Math.round(Number.isFinite(P.decimals) ? P.decimals : 0), 0, 1);
  const unit = 10 ** decimals;
  const aU = Math.round(clamp(Number(P.percent ?? 63), 0, 100) * unit); // 按显示的精度取整，再让 B＝100 减 A
  const pctA = aU / unit;
  const pctB = (100 * unit - aU) / unit;
  const fmt = (v) => formatNumber(v, { decimals }) + '%';
  const tie = aU * 2 === 100 * unit;
  const winSide = P.winner === false || tie ? null : aU > 50 * unit ? 'A' : 'B';
  const layout = P.layout === 'split' ? 'split' : 'stack';
  const question = oneLine(ctx.text);
  const optA = oneLine(P.optionA ?? 'A') || 'A';
  const optB = oneLine(P.optionB ?? 'B') || 'B';

  // ---------- 量字 ----------
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `100px ${family}`;
  const adv = (s) => meas.measureText(s).width / 100;

  // ---------- 版式 ----------
  const barW = Math.min(clamp(P.size ?? 0.8, 0.4, 0.95) * W, (vertical ? 1 : 1.1) * short);
  const cx = (P.x ?? 0.5) * W;
  const cy = (P.y ?? (vertical ? 0.6 : 0.55)) * H;
  const left = cx - barW / 2;
  const qFs0 = 0.085 * barW;
  const qFs = question ? Math.min(qFs0, (barW * 1.05) / Math.max(1, adv(question))) : 0;
  const shrunk = [];
  let geo;
  if (layout === 'stack') {
    const barH = 0.17 * barW;
    const gap = 0.07 * barW;
    const qGap = question ? qFs * 2.1 : 0; // 留出皇冠的位置
    const totalH = qGap + 2 * barH + gap;
    const top = cy - totalH / 2;
    const labFs0 = 0.4 * barH;
    const pctFs = 0.48 * barH;
    const badgeR = 0.31 * barH;
    const labX = left + 0.16 * barH + 2 * badgeR + 0.18 * barH;
    const labMax = barW - (labX - left) - adv('100%') * pctFs - 0.6 * barH;
    const labFs = (s) => { const f = Math.min(labFs0, labMax / Math.max(0.5, adv(s))); if (f < labFs0 * 0.999) shrunk.push({ s, k: f / labFs0 }); return f; };
    geo = {
      barH, qY: top + qFs * 0.95,
      bars: [0, 1].map((i) => {
        const y = top + qGap + i * (barH + gap);
        return { side: i ? 'B' : 'A', y, mid: y + barH / 2, labFs: labFs(i ? optB : optA), badgeX: left + 0.16 * barH + badgeR, badgeR, labX, pctX: left + barW - 0.35 * barH, pctFs };
      }),
    };
  } else {
    const barH = 0.15 * barW;
    const labFs0 = 0.075 * barW;
    const pctFs = 0.1 * barW;
    const qGap = question ? qFs * 2.0 : 0;
    const labRow = labFs0 * 1.45;
    const pctRow = pctFs * 1.35;
    const totalH = qGap + labRow + barH + pctRow;
    const top = cy - totalH / 2;
    const half = barW * 0.46;
    const labFs = (s) => { const f = Math.min(labFs0, half / Math.max(0.5, adv(s))); if (f < labFs0 * 0.999) shrunk.push({ s, k: f / labFs0 }); return f; };
    const barY = top + qGap + labRow;
    geo = {
      barH, qY: top + qFs * 0.95, barY, mid: barY + barH / 2,
      labY: barY - labFs0 * 0.42, pctY: barY + barH + pctFs * 1.02,
      labFsA: labFs(optA), labFsB: labFs(optB), pctFs, vsR: 0.62 * barH,
    };
  }

  // ---------- 时间轴 ----------
  const t0 = 0.05;
  const introDur = 0.45;
  const growStart = t0 + introDur * 0.7;
  const growDur = P.growTime ?? R.grow ?? 1.2;
  const land = growStart + growDur;
  const verdict = land + 0.05;
  const holdStart = verdict + (winSide ? 0.3 : 0.1);
  const holdDur = P.hold ?? 1.8;
  const outroStart = holdStart + holdDur;
  const outDur = 0.35;
  const outroEnd = outroStart + outDur;
  const duration = outroEnd + 0.1;
  const fromA = layout === 'split' ? 50 : 0; // 对决条从五五开往两边顶，两条从 0 长
  const fromB = layout === 'split' ? 50 : 0;
  const valA = (t) => countUp(t, { from: fromA, to: pctA, start: growStart, duration: growDur, decimals }).value;
  const valB = (t) => countUp(t, { from: fromB, to: pctB, start: growStart, duration: growDur, decimals }).value;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: growStart },
      { name: 'grow', label: '百分比长出来', start: growStart, end: land },
      { name: 'hold', label: '停留（赢家放大）', start: holdStart, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      { t: growStart, name: 'grow', label: '开始长' },
      { t: land, name: 'land', label: `长到 ${fmt(pctA)} 比 ${fmt(pctB)}` },
      ...(winSide ? [{ t: verdict, name: 'winner', label: `「${winSide === 'A' ? optA : optB}」赢` }] : []),
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: [
      ...(question ? [{ i: 0, kind: 'question', text: question, enter: t0, exitStart: outroStart, exitEnd: outroEnd }] : []),
      { i: 1, kind: 'option', side: 'A', text: optA, percent: pctA, enter: t0, land, exitStart: outroStart, exitEnd: outroEnd },
      { i: 2, kind: 'option', side: 'B', text: optB, percent: pctB, enter: t0 + 0.08, land, exitStart: outroStart, exitEnd: outroEnd },
    ],
  };

  // ---------- 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-vb` : 'vb' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  const shineId = `${uid}-shine`;
  const shineGrad = el('linearGradient', { id: shineId, gradientUnits: 'userSpaceOnUse', x1: left, y1: 0, x2: left + barW, y2: 0 }, defs);
  const shineStopEls = [0, 1, 2, 3, 4].map(() => el('stop', { offset: 0, 'stop-color': '#FFFFFF', 'stop-opacity': 0 }, shineGrad));
  const T = (fs, extra = {}) => ({ 'font-family': family, 'font-size': f3(fs), ...extra });
  const candy = P.material === 'candy';
  const kit = createParts(svg, { uid, material: candy ? 'candy' : 'flat', defs });
  // 带描边的字：描边一层、字一层
  const outlined = (txt, fs, x, y, anchor, color, sw = 0.16) => {
    const s = el('text', T(fs, { x: f3(x), y: f3(y), 'text-anchor': anchor, fill: K.outer, stroke: K.outer, 'stroke-width': f3(sw * fs), 'stroke-linejoin': 'round' }), svg);
    const f = el('text', T(fs, { x: f3(x), y: f3(y), 'text-anchor': anchor, fill: color }), svg);
    s.textContent = txt; f.textContent = txt;
    return [s, f];
  };
  const qEls = question ? outlined(question, qFs, cx, geo.qY, 'middle', K.sub, 0.18) : [];
  const starPath = 'M0,-1 C0.12,-0.12 0.12,-0.12 1,0 C0.12,0.12 0.12,0.12 0,1 C-0.12,0.12 -0.12,0.12 -1,0 C-0.12,-0.12 -0.12,-0.12 0,-1 Z';

  let parts;
  if (layout === 'stack') {
    const { barH } = geo;
    parts = geo.bars.map((b) => {
      const color = b.side === 'A' ? K.fill : K.fill2;
      // 糖果：轨道是奶白的槽（不用 bg 色），填充在槽里长
      const bar = kit.pillBar({ x: left, y: b.y, w: barW, h: barH, track: candy ? null : K.bg, trackOpacity: 0.55, fill: color, shineFill: `url(#${shineId})` });
      const badge = kit.key({ shape: 'circle', cx: b.badgeX, cy: b.mid, r: b.badgeR, color: K.inner, text: b.side, textColor: color, fontFamily: family, fontSize: b.badgeR * 1.25, baseline: 0.36 });
      // 糖果：槽是奶白的，压在槽上的字换成深色。深色字垫在下面，白字带描边那份按填充条的范围裁出来，
      // 裁切框每帧跟着填充条的长度走，同一个字一半白一半深
      let dark = [], litClip = null;
      if (candy) {
        const txt = (s0, fs, x, anchor) => { const e = el('text', T(fs, { x: f3(x), y: f3(b.mid + fs * 0.36), 'text-anchor': anchor, fill: K.outer })); svg.appendChild(e); e.textContent = s0; return e; };
        dark = [txt(b.side === 'A' ? optA : optB, b.labFs, b.labX, 'start'), txt(fmt(0), b.pctFs, b.pctX, 'end')];
        const clip = el('clipPath', { id: `${uid}-lit${b.side}` }, defs);
        litClip = el('rect', { x: f3(left), y: f3(b.y), width: f3(barH), height: f3(barH) }, clip);
      }
      const lab = outlined(b.side === 'A' ? optA : optB, b.labFs, b.labX, b.mid + b.labFs * 0.36, 'start', K.inner);
      const pct = outlined(fmt(0), b.pctFs, b.pctX, b.mid + b.pctFs * 0.36, 'end', K.inner);
      if (candy) for (const e of [...lab, ...pct]) e.setAttribute('clip-path', `url(#${uid}-lit${b.side})`);
      return { ...b, color, bar, badge, lab, pct, dark, litClip };
    });
  } else {
    const { barH, barY } = geo;
    const bar = kit.pillBar({ split: true, x: left, y: barY, w: barW, h: barH, colorA: K.fill, colorB: K.fill2, shadow: K.shadow, shineFill: `url(#${shineId})` });
    const vs = kit.key({ shape: 'circle', cx, cy: geo.mid, r: geo.vsR, color: K.accent, stroke: K.outer, strokeWidth: 0.1 * geo.vsR, text: 'VS', textColor: K.outer, fontFamily: family, fontSize: geo.vsR * 0.95, baseline: 0.36 });
    const labA = outlined(optA, geo.labFsA, left + 0.04 * barW, geo.labY, 'start', K.inner);
    const labB = outlined(optB, geo.labFsB, left + barW - 0.04 * barW, geo.labY, 'end', K.inner);
    const pctElA = outlined(fmt(50), geo.pctFs, left + 0.04 * barW, geo.pctY, 'start', K.fill);
    const pctElB = outlined(fmt(50), geo.pctFs, left + barW - 0.04 * barW, geo.pctY, 'end', K.fill2);
    parts = { bar, vs, labA, labB, pctA: pctElA, pctB: pctElB };
  }
  // 皇冠和小星星（赢家）
  let crownFill = K.accent, crownGloss = null;
  if (winSide && candy) {
    const cg = el('linearGradient', { id: `${uid}-crown`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    [[0, mix(K.accent, '#FFFFFF', 0.35)], [0.55, K.accent], [1, mix(K.accent, '#000000', 0.18)]].forEach(([o, c]) => el('stop', { offset: o, 'stop-color': c }, cg));
    const gg = el('linearGradient', { id: `${uid}-crown-gloss`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    [[0, 0], [0.35, 0], [0.5, 0.55], [0.75, 0]].forEach(([o, a]) => el('stop', { offset: o, 'stop-color': '#FFFFFF', 'stop-opacity': a }, gg));
    crownFill = `url(#${uid}-crown)`;
    crownGloss = `url(#${uid}-crown-gloss)`;
  }
  const crown = winSide ? drawCrown(svg, { fill: crownFill, shadow: K.outer, gloss: crownGloss }) : [];
  const nSpark = winSide ? Math.round(clamp(P.particles ?? 0, 0, 24)) : 0;
  const sparks = [...Array(nSpark)].map((_, i) => ({
    e: el('path', { d: starPath, fill: i % 2 ? K.accent : K.inner }, svg),
    ang: (i / Math.max(1, nSpark)) * Math.PI * 2 + (h('sa', i) - 0.5) * 0.6, dist: lerp(0.8, 1.25, h('sd', i)), r: lerp(0.035, 0.07, h('sr', i)) * geo.barH * 4, delay: h('sl', i) * 0.08,
  }));

  // ---------- 每帧 ----------
  const mat = (s, px, py, dx = 0, dy = 0) => {
    if (Math.abs(s - 1) < 0.004 && Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return '';
    return `matrix(${f3(s)},0,0,${f3(s)},${f3(px * (1 - s) + dx)},${f3(py * (1 - s) + dy)})`;
  };
  const tf = (e, m) => (m ? e.setAttribute('transform', m) : e.removeAttribute('transform'));
  const outU = (t) => clamp((t - outroStart) / outDur);
  const snap = (v) => (Math.abs(v) < 0.05 ? 0 : v);

  function seek(time) {
    const t = clamp(time, 0, duration);
    const oa = 1 - easeInCubic(outU(t));
    const os = 1 - 0.12 * easeInCubic(outU(t));
    const alive = t < outroEnd && oa > 0.02;
    const shk = showcase ? shake(t, { start: verdict, amplitude: 0.012 * barW * flair, duration: 0.28, seed, rotate: 0 }) : { dx: 0, dy: 0 };
    const sdx = snap(shk.dx), sdy = snap(shk.dy);
    const va = t < growStart ? fromA : valA(t);
    const vb = t < growStart ? fromB : valB(t);
    const wU = clamp((t - verdict) / 0.3);
    const winPop = winSide ? easeOutBack(wU, 2) : 0; // 0 → 1（带回弹）
    const dimL = winSide ? easeOutCubic(wU) : 0;

    // 问题
    if (qEls.length) {
      const u = clamp((t - t0) / 0.3);
      const s = (0.7 + 0.3 * easeOutBack(u)) * os;
      const on = t >= t0 && alive;
      for (const e of qEls) { vis(e, on); tf(e, mat(s, cx, geo.qY - qFs * 0.35, sdx, sdy)); set(e, { opacity: clamp(u * 2.5) * oa }); }
    }

    let winX = cx, winY = cy, winScale = 1;
    if (layout === 'stack') {
      for (const [i, b] of parts.entries()) {
        const enter = t0 + 0.06 + i * 0.08;
        const u = easeOutCubic(clamp((t - enter) / 0.32));
        const slide = (1 - u) * -0.12 * barW;
        const on = t >= enter && alive;
        const v = b.side === 'A' ? va : vb;
        const isWin = winSide === b.side;
        const s = (isWin ? 1 + 0.06 * winPop : 1) * os;
        const m = mat(s, cx, b.mid, snap(slide) + sdx, sdy);
        const fw = Math.max(b.barH ?? geo.barH, (v / 100) * barW);
        b.bar.set({ visible: on, shine: showcase && isWin, transform: m, opacity: u * oa, dim: winSide && !isWin ? dimL : 0, fillW: fw });
        b.badge.set({ visible: on, transform: m, opacity: u * oa });
        for (const e of [...b.lab, ...b.pct]) { vis(e, on); tf(e, m); }
        for (const e of b.lab) set(e, { opacity: u * oa });
        const txt = fmt(v);
        for (const e of b.pct) { e.textContent = txt; set(e, { opacity: u * oa * (t >= growStart ? 1 : 0.6) }); }
        if (b.litClip) {
          const fb = b.bar.fillBox(fw); // 裁切框在字自己的坐标里（字的 transform 会带着它一起变）
          set(b.litClip, { x: fb.x, y: fb.y, width: fb.w, height: fb.h, rx: fb.h / 2 }); // 跟填充条同形状，切口顺着圆头走
          const [dl, dp] = b.dark;
          dp.textContent = txt;
          for (const e of b.dark) { vis(e, on); tf(e, m); }
          set(dl, { opacity: u * oa });
          set(dp, { opacity: u * oa * (t >= growStart ? 1 : 0.6) });
        }
        if (isWin) { winX = b.bar.fillRight(fw) - 0.5 * geo.barH; winY = b.y; winScale = s; }
      }
    } else {
      const p = parts;
      const u = easeOutCubic(clamp((t - t0 - 0.04) / 0.35));
      const rise = (1 - u) * 0.05 * barW;
      const on = t >= t0 && alive;
      const splitX = left + (va / 100) * barW;
      const m = mat(os, cx, geo.mid, sdx, snap(rise) + sdy);
      p.bar.set({ visible: on, transform: m, opacity: u * oa, splitX, shine: showcase && !!winSide, shineSide: winSide, dimA: winSide === 'B' ? dimL : 0, dimB: winSide === 'A' ? dimL : 0 });
      // VS 跟着分界点走；滚完以后缩小让位给皇冠
      const vu = clamp((t - t0 - 0.12) / 0.3);
      const vsS = easeOutBack(vu, 2.2) * (1 - 0.25 * dimL) * os;
      const vsOn = on && vsS >= 0.2;
      const vm = `translate(${f3(splitX - cx + sdx)},${f3(snap(rise) + sdy)})` + (Math.abs(vsS - 1) < 0.004 ? '' : ` translate(${f3(cx)},${f3(geo.mid)}) scale(${f3(vsS)}) translate(${f3(-cx)},${f3(-geo.mid)})`);
      p.vs.set({ visible: vsOn, transform: vm, opacity: oa });
      // 选项名和百分比：赢的一边放大
      for (const side of ['A', 'B']) {
        const isWin = winSide === side;
        const s = (isWin ? 1 + 0.12 * winPop : 1) * os;
        const ax = side === 'A' ? left + 0.04 * barW : left + barW - 0.04 * barW;
        const lab = side === 'A' ? p.labA : p.labB;
        const pct = side === 'A' ? p.pctA : p.pctB;
        const lm = mat(s, ax, geo.labY - geo.labFsA * 0.35, sdx, snap(rise) + sdy);
        const pm = mat(s, ax, geo.pctY - geo.pctFs * 0.35, sdx, snap(rise) + sdy);
        const dim = winSide && !isWin ? 1 - 0.35 * dimL : 1;
        for (const e of lab) { vis(e, on); tf(e, lm); set(e, { opacity: u * oa * dim }); }
        const txt = fmt(side === 'A' ? va : vb);
        for (const e of pct) { vis(e, on); tf(e, pm); e.textContent = txt; set(e, { opacity: u * oa * dim }); }
        if (isWin) {
          const fs = side === 'A' ? geo.labFsA : geo.labFsB;
          const w = adv(side === 'A' ? optA : optB) * fs;
          winX = side === 'A' ? ax + (w / 2) * s : ax - (w / 2) * s;
          winY = geo.labY - fs * 0.88 * s; // 选项名的字顶
          winScale = s;
        }
      }
    }

    // 高光：赢家那条，皇冠出来以后扫一次
    const sw = shineSweep(t, { start: verdict + 0.1, duration: 0.55, width: 0.2 });
    if (sw.visible) shineStops(sw.u, { width: 0.2, peak: 0.7 }).forEach(([o, op], i) => { if (shineStopEls[i]) set(shineStopEls[i], { offset: o, 'stop-opacity': op }); });
    else for (const st of shineStopEls) set(st, { 'stop-opacity': 0 });

    // 皇冠：赢家头上弹出来
    if (crown.length) {
      const cs = winPop * os;
      const on = t >= verdict && cs >= 0.2 && alive;
      const r = 0.36 * geo.barH * (layout === 'split' ? 1.15 : 1);
      const yy = layout === 'stack' ? winY - 0.1 * geo.barH : winY - 0.55 * r - 0.05 * geo.barH; // 对决条：皇冠底边在字顶上面，不压字
      crown.forEach((e, i) => {
        vis(e, on);
        const off = i === 0 ? 0.06 * r : 0;
        e.setAttribute('transform', `translate(${f3(winX + sdx + off)},${f3(yy + sdy + off)}) rotate(${layout === 'stack' ? 12 : -8}) scale(${f3(r * cs)})`);
        set(e, { opacity: oa });
      });
    }
    // 小星星：赢家周围弹出来再收回去
    for (const sp of sparks) {
      const u = clamp((t - verdict - sp.delay) / 0.36);
      const k = u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u);
      const on = k >= 0.2 && alive;
      vis(sp.e, on);
      if (!on) continue;
      const d = sp.dist * (0.75 + 0.35 * easeOutCubic(u)) * geo.barH * 1.1;
      sp.e.setAttribute('transform', `translate(${f3(winX + Math.cos(sp.ang) * d + sdx)},${f3(winY + geo.barH * 0.5 + Math.sin(sp.ang) * d * 0.6 + sdy)}) rotate(${f3(sp.ang * 57.2958)}) scale(${f3(sp.r * k)})`);
    }
  }

  // ---------- 检查 ----------
  const warnings = [];
  for (const x of shrunk) warnings.push({ type: 'too-long', detail: `「${x.s}」太长，缩到 ${(x.k * 100).toFixed(0)}%` });
  const styleChecks = [
    { id: 'sum-100', level: 'warn', pass: aU + (100 * unit - aU) === 100 * unit, message: `${optA} ${fmt(pctA)} ＋ ${optB} ${fmt(pctB)} ＝ 100%（按显示的精度取整后，B＝100 减 A）` },
    { id: 'winner', level: 'warn', pass: true, message: tie ? '五五开，不标赢家' : winSide ? `赢的是「${winSide === 'A' ? optA : optB}」` : '没开「标出赢家」' },
    { id: 'label-fit', level: 'warn', pass: !shrunk.some((x) => x.k < 0.7), message: shrunk.length ? shrunk.map((x) => `「${x.s}」缩到 ${(x.k * 100).toFixed(0)}%`).join('、') + (shrunk.some((x) => x.k < 0.7) ? '，太小了，选项名改短一点（6 个字以内最好）' : '') : '选项名都放得下' },
  ];

  seek(0);
  return {
    timeline,
    layout: {
      fontSize: layout === 'stack' ? geo.bars[0].pctFs : geo.pctFs,
      lines: [question, optA, optB].filter(Boolean),
      forced: [],
      issues: [],
      warnings,
      segmentation: ctx.segmentation.sources,
      units: timeline.units.length,
      styleChecks,
      layoutKind: layout,
      percent: { A: pctA, B: pctB, winner: winSide },
    },
    seek,
    destroy() { svg.remove(); },
  };
}
