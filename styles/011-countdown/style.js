// 011 倒计时（Countdown）· 互动元素
// 大数字一秒一个弹出来，外面一圈圆环从 12 点方向顺时针走完一圈；数到头砸出一句结束语（默认「开始！」）。默认透明底。
// 参数（见 meta.json）：text 结束语、look（V1 日常 / V3 招牌）、palette、rhythm（每个数停几秒）、font、from 从几开始、tick、
//   showEnd、ring 圆环、disc 半透明圆底、size 圆环直径、flair 招牌强度、particles 火花数、material、hold、x、y、seed。
// 质感：material=flat 平面是原来的画法，一个元素、一个属性都没改；默认 candy 亮面糖果：数字后面的圆底换成底座的圆按钮零件
//   （不透明，有厚度、白亮边、镜面高光），每换一个数字按钮面往下顿一下，开场和最后一个数各扫过一道高光。圆环、数字、结束语两种质感一样。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；
//   透明度只设在单个图形上，不给整组做透明度动画；会转的东西不带模糊（投影用不模糊的硬投影）；
//   整个部件的轻震加在每个元素自己的位移里，不挪整组。
import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, spring, easeOutCubic, easeInCubic, easeOutBack, easeInOutCubic } from '../../engine/src/lib/ease.js';
import { graphemes, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { shake, f3, shineSweep } from '../../engine/src/motions/index.js';
import { createParts, SWEEP_WIDTH } from '../../engine/src/parts/index.js';

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

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const family = ctx.fontFamily(P.font);
  const flair = clamp(P.flair ?? 0);
  const candy = P.material === 'candy';
  const showcase = flair > 0.5;
  const from = clamp(Math.round(P.from ?? 3), 1, 10);
  const tick = P.tick ?? R.tick ?? 1;
  const endText = String(ctx.text || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).join('');
  const showEnd = P.showEnd !== false && endText.length > 0;
  const h = (...k) => hash01(seed, ...k);

  // ---------- 版式 ----------
  const D = clamp(P.size ?? 0.36, 0.18, 0.6) * short; // 圆环直径
  const r = D / 2;
  const cx = (P.x ?? 0.5) * W;
  const cy = (P.y ?? (vertical ? 0.42 : 0.5)) * H;
  const numFs = 0.64 * D;
  const endChars = graphemes(endText);
  // 结束语：一行。圆环在结束语出来时往外扩、淡掉，所以结束语可以比圆环宽，最宽到圆环直径的 1.6 倍；字太多就缩。
  // 每个字的宽度：汉字 0.98 个字号；墨迹居中的全角标点（！？：；）0.7，墨迹靠左的（，。、等）挤到 0.55；数字和字母 0.62。
  // 结束语的描边很粗（字号的 14%），挤得太紧，描边会跟前一个字粘在一起
  const advOf = (ch) => (/[！？：；]/.test(ch) ? 0.7 : FULLWIDTH_PUNCT.has(ch) ? 0.55 : /^[0-9A-Za-z!?.,]$/.test(ch) ? 0.62 : 0.98);
  // 墨迹靠左的标点（，。、等）：用画布量出墨迹的真实位置，让墨迹左边贴着占位左边加 0.1（固定量去挪会粘到前一个字上）
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `100px ${family}`; meas.textAlign = 'center';
  const inkLeftOf = (ch) => -meas.measureText(ch).actualBoundingBoxLeft / 100;
  const endEm = endChars.reduce((a, ch) => a + advOf(ch), 0);
  const endFs = Math.min(0.5 * D, (1.6 * D) / Math.max(1, endEm));

  // ---------- 时间轴 ----------
  const t0 = 0.05;
  const ticks = [...Array(from).keys()].map((i) => ({ n: from - i, start: t0 + i * tick, end: t0 + (i + 1) * tick, last: i === from - 1 }));
  const countEnd = t0 + from * tick;
  const endStart = countEnd;
  const endLand = endStart + 0.28;
  const holdDur = P.hold ?? 0.9;
  const outroStart = showEnd ? endLand + holdDur : countEnd;
  const outDur = 0.35;
  const outroEnd = outroStart + outDur;
  const duration = outroEnd + 0.1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: t0 + 0.25 },
      { name: 'count', label: '倒数', start: t0, end: countEnd },
      ...(showEnd ? [{ name: 'hold', label: '结束语停留', start: endStart, end: outroStart }] : []),
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...ticks.map((k) => ({ t: k.start, name: 'tick', value: k.n, label: `数到 ${k.n}` })),
      ...(showEnd ? [{ t: endLand, name: 'go', label: `「${endText}」落地` }] : []),
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: [
      ...ticks.map((k, i) => ({ i, kind: 'number', text: String(k.n), enter: k.start, exitStart: k.end - 0.12, exitEnd: k.end })),
      ...(showEnd ? endChars.map((ch, j) => ({ i: from + j, kind: 'end', char: ch, enter: endStart + j * 0.05, land: endLand + j * 0.05, exitStart: outroStart, exitEnd: outroEnd })) : []),
    ],
  };

  // ---------- 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-cd` : 'cd' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  // 光晕：径向渐变的圆（不用模糊滤镜）
  const halo = el('radialGradient', { id: `${uid}-halo` }, defs);
  el('stop', { offset: '0', 'stop-color': K.fill2, 'stop-opacity': 0.55 }, halo);
  el('stop', { offset: '0.6', 'stop-color': K.fill2, 'stop-opacity': 0.15 }, halo);
  el('stop', { offset: '1', 'stop-color': K.fill2, 'stop-opacity': 0 }, halo);
  const gGlow = el('g', {}, svg);
  const glow = el('circle', { cx: 0, cy: 0, r: f3(r * 1.25), fill: `url(#${uid}-halo)` }, gGlow);
  const disc = P.disc !== false && !candy ? el('circle', { cx: 0, cy: 0, r: f3(r * 0.94), fill: K.bg }, svg) : null;
  // 糖果：圆底换成圆按钮零件（不透明）。厚度压薄到直径的 4%，侧壁的下沿藏在圆环下面
  const kit = candy && P.disc !== false ? createParts(svg, { uid: `${uid}-pk`, material: 'candy', defs }) : null;
  const discKey = kit ? kit.key({ shape: 'circle', cx, cy, r: r * 0.94, color: K.bg, depth: 0.04 * 2 * r * 0.94, glow: false }) : null;
  const track = P.ring !== false ? el('circle', { cx: 0, cy: 0, r: f3(r), fill: 'none', stroke: K.sub, 'stroke-width': f3(0.055 * D) }, svg) : null;
  const ring = P.ring !== false ? el('circle', { cx: 0, cy: 0, r: f3(r), fill: 'none', stroke: K.inner, 'stroke-width': f3(0.055 * D), 'stroke-linecap': 'round' }, svg) : null;
  const circ = TAU * r;
  // 冲击波（V3）：每次换数字时从圆环往外扩一圈
  const waves = showcase || flair > 0 ? ticks.map(() => el('circle', { cx: 0, cy: 0, r: f3(r), fill: 'none', stroke: K.accent, 'stroke-width': f3(0.03 * D) }, svg)) : [];
  // 数字：一层硬投影（不模糊）＋一层描边＋一层填色
  const textAttrs = (fs) => ({ x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(fs), 'font-variant-numeric': 'tabular-nums' });
  const numbers = ticks.map((k) => {
    const g = el('g', {}, svg);
    const shadow = el('text', { ...textAttrs(numFs), fill: K.shadow, 'fill-opacity': 0.45, transform: `translate(${f3(0.035 * numFs)},${f3(0.05 * numFs)})` }, g);
    const stroke = el('text', { ...textAttrs(numFs), fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.1 * numFs), 'stroke-linejoin': 'round' }, g);
    const fill = el('text', { ...textAttrs(numFs), fill: k.last && flair > 0 ? K.accent : K.fill }, g);
    for (const n of [shadow, stroke, fill]) n.textContent = String(k.n);
    return { g, parts: [shadow, stroke, fill], k, tilt: (h('tilt', k.n) - 0.5) * 8 * flair, over: lerp(0.06, 0.14, h('over', k.n)) };
  });
  // 结束语：逐字
  const endW = endEm * endFs;
  let acc = 0;
  const endNodes = showEnd ? endChars.map((ch, j) => {
    const g = el('g', {}, svg);
    const a = advOf(ch) * endFs;
    // 挤窄的全角标点：墨迹靠字身左边的（，。、）往左挪，免得跟前一个字隔开；墨迹居中的（！？）不挪
    const leftInk = FULLWIDTH_PUNCT.has(ch) && !/[！？：；]/.test(ch);
    const xs = -endW / 2 + acc + (leftInk ? (0.1 - inkLeftOf(ch)) * endFs : a / 2);
    acc += a;
    const shadow = el('text', { ...textAttrs(endFs), fill: K.shadow, 'fill-opacity': 0.45, transform: `translate(${f3(0.04 * endFs)},${f3(0.06 * endFs)})` }, g);
    const stroke = el('text', { ...textAttrs(endFs), fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.14 * endFs), 'stroke-linejoin': 'round' }, g);
    const fill = el('text', { ...textAttrs(endFs), fill: K.fill2 }, g);
    for (const n of [shadow, stroke, fill]) n.textContent = ch;
    return { g, parts: [shadow, stroke, fill], x: xs, j, tilt: (h('et', j) - 0.5) * 10 * flair, over: lerp(0.08, 0.2, h('eo', j)) };
  }) : [];
  // 火花（V3）：结束语落地时往外迸，种子定方向、长短
  const nSpark = showEnd ? Math.round(P.particles ?? 0) : 0;
  const sparks = [...Array(nSpark).keys()].map((i) => {
    const ang = (i / Math.max(1, nSpark)) * TAU + (h('sa', i) - 0.5) * 0.5;
    const len = lerp(0.08, 0.16, h('sl', i)) * D;
    const dist = lerp(0.62, 0.95, h('sd', i)) * D;
    const color = h('sc', i) < 0.5 ? K.fill2 : K.accent;
    const e = el('line', { x1: 0, y1: 0, x2: f3(len), y2: 0, stroke: color, 'stroke-width': f3(0.028 * D), 'stroke-linecap': 'round' }, svg);
    return { e, ang, len, dist, delay: h('sdl', i) * 0.06 };
  });

  // ---------- 每一帧 ----------
  function seek(time) {
    const t = clamp(time, 0, duration);
    // 整个部件的轻震（V3）：每次换数字、结束语落地时震一下，加在每个元素自己的位移里
    let sx = 0; let sy = 0;
    if (flair > 0) {
      for (const k of ticks) { const m = shake(t, { start: k.start, amplitude: 0.018 * D * flair * (k.last ? 1.6 : 1), duration: 0.16, freq: 26, seed: seed + k.n, rotate: 0 }); sx += m.dx; sy += m.dy; }
      if (showEnd) { const m = shake(t, { start: endLand, amplitude: 0.035 * D * flair, duration: 0.22, freq: 24, seed: seed + 99, rotate: 0 }); sx += m.dx; sy += m.dy; }
    }
    const X = cx + sx; const Y = cy + sy;
    const qOut = easeInCubic(clamp((t - outroStart) / outDur));
    const enter = clamp(spring(t, { freq: 2.4, damping: 0.55 }));
    const frameScale = enter * (1 - qOut);
    const frameOn = frameScale > 0.002;
    // 光晕：每次换数字亮一下，结束语时最亮
    let glowK = 0.25;
    for (const k of ticks) { const u = t - k.start; if (u >= 0 && u < 0.5) glowK = Math.max(glowK, 0.25 + 0.55 * (1 - u / 0.5) * (0.4 + 0.6 * flair)); }
    if (showEnd && t >= endStart) glowK = Math.max(glowK, 0.3 + 0.6 * clamp(1 - (t - endLand) / 0.6) * (0.5 + 0.5 * flair));
    vis(glow, frameOn);
    set(glow, { transform: `translate(${f3(X)},${f3(Y)}) scale(${f3(Math.max(frameScale, 0.001) * (0.9 + 0.25 * glowK))})`, opacity: f3(clamp(glowK) * (1 - qOut)) });
    // 结束语砸下来时，圆环和圆底往外扩、淡掉，让结束语单独站着
    const ringGone = showEnd ? easeOutCubic(clamp((t - endStart) / 0.4)) : 0;
    const ringScale = Math.max(frameScale, 0.001) * (1 + 0.35 * ringGone);
    const ringOp = (1 - qOut) * (1 - ringGone);
    if (disc) { vis(disc, frameOn && ringOp > 0.002); set(disc, { transform: `translate(${f3(X)},${f3(Y)}) scale(${f3(ringScale)})`, 'fill-opacity': f3(0.38 * ringOp) }); }
    if (discKey) {
      // 每换一个数字，按钮面往下顿一下（0.18 秒按下去再弹回）；开场落定时、最后一个数各扫一道高光
      let press = 0;
      for (const k of ticks) { const u = (t - k.start) / 0.18; if (u > 0 && u < 1) press = Math.max(press, (0.45 + 0.25 * flair) * Math.sin(Math.PI * u)); }
      const last = ticks[ticks.length - 1];
      const sw1 = shineSweep(t, { start: 0.3, duration: 0.6, width: SWEEP_WIDTH, ease: easeInOutCubic });
      const sw = sw1.visible ? sw1 : shineSweep(t, { start: last.start + 0.1, duration: 0.55, width: SWEEP_WIDTH, ease: easeInOutCubic });
      const ks = Math.abs(ringScale - 1) < 0.003 ? 1 : ringScale; // 放大偏差不到 0.3%，当成没动
      discKey.set({ visible: frameOn && ringOp > 0.002, transform: `translate(${f3(X)},${f3(Y)}) scale(${f3(ks)}) translate(${f3(-cx)},${f3(-cy)})`, opacity: ringOp, press, sweep: sw });
    }
    // 圆环：每个数字一秒走完一圈，从 12 点方向顺时针；倒数完了满圈
    if (ring) {
      let p = 1;
      const cur = ticks.find((k) => t >= k.start && t < k.end);
      if (cur) p = clamp((t - cur.start) / tick);
      else if (t < t0) p = 0;
      const dash = circ * easeOutCubic(p);
      vis(ring, frameOn && ringOp > 0.002); vis(track, frameOn && ringOp > 0.002);
      const tr = `translate(${f3(X)},${f3(Y)}) scale(${f3(ringScale)}) rotate(-90)`;
      set(ring, { transform: tr, 'stroke-dasharray': `${f3(dash)} ${f3(circ)}`, opacity: f3(ringOp) });
      set(track, { transform: tr, 'stroke-opacity': f3(0.28 * ringOp) });
    }
    // 冲击波（V3）
    waves.forEach((w, i) => {
      const u = (t - ticks[i].start) / 0.5;
      const on = u > 0 && u < 1;
      vis(w, on && flair > 0);
      if (on) set(w, { transform: `translate(${f3(X)},${f3(Y)}) scale(${f3(1 + 0.55 * easeOutCubic(u) * (ticks[i].last ? 1.3 : 1))})`, opacity: f3((1 - u) * 0.85 * flair) });
    });
    // 数字：这一秒的数字弹进来，最后 0.12 秒缩小离开
    for (const nb of numbers) {
      const { k } = nb;
      const u = t - k.start;
      const on = u >= 0 && t < k.end;
      vis(nb.g, on);
      if (!on) continue;
      const pin = clamp(u / 0.32);
      let s = lerp(1.5 + 0.25 * flair, 1, easeOutBack(pin)) + nb.over * Math.sin(Math.PI * pin) * 0.4;
      if (flair === 0) s = lerp(0.6, 1, easeOutBack(pin));
      const qx = clamp((t - (k.end - 0.12)) / 0.12);
      s *= 1 - 0.85 * easeInCubic(qx);
      const op = clamp(pin * 5) * (1 - qx);
      const rot = nb.tilt * (1 - easeOutCubic(pin) * 0.6);
      set(nb.g, { transform: `translate(${f3(X)},${f3(Y)}) rotate(${f3(rot)}) scale(${f3(Math.max(s * frameScale, 0.001))})` });
      for (const part of nb.parts) part.setAttribute('opacity', f3(op));
    }
    // 结束语：逐字砸下来
    for (const en of endNodes) {
      const u = t - (endStart + en.j * 0.05);
      const on = u >= 0 && qOut < 1;
      vis(en.g, on);
      if (!on) continue;
      const pin = clamp(u / 0.28);
      const s0 = flair > 0 ? 1.9 : 0.4;
      let s = lerp(s0, 1, easeOutBack(pin)) + (flair > 0 ? en.over * Math.sin(Math.PI * pin) * 0.5 : 0);
      s *= 1 - easeInCubic(clamp((t - outroStart - en.j * 0.03) / outDur));
      const dy = flair > 0 ? 0 : (1 - easeOutCubic(pin)) * 0.25 * endFs;
      const rot = en.tilt * (0.4 + 0.6 * (1 - easeOutCubic(pin)));
      set(en.g, { transform: `translate(${f3(X + en.x)},${f3(Y + dy)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))})` });
      for (const part of en.parts) part.setAttribute('opacity', f3(clamp(pin * 4)));
    }
    // 火花
    for (const sp of sparks) {
      const u = (t - endLand - sp.delay) / 0.55;
      const on = u > 0 && u < 1;
      vis(sp.e, on);
      if (!on) continue;
      const d = lerp(0.55 * D, sp.dist, easeOutCubic(u));
      const deg = (sp.ang * 180) / Math.PI;
      set(sp.e, { transform: `translate(${f3(X + Math.cos(sp.ang) * d)},${f3(Y + Math.sin(sp.ang) * d)}) rotate(${f3(deg)}) scale(${f3(Math.max(1 - u, 0.001))},1)`, opacity: f3(1 - u * 0.6) });
    }
  }

  const lines = showEnd ? [{ text: endText, index: 0, paragraph: 0 }] : [];
  const issues = showEnd ? checkLineBreaks(lines, ctx.text, { segment: ctx.segment }) : [];
  const warnings = showEnd ? icuBreakWarnings(lines, ctx.text) : [];
  if (showEnd && endChars.length > 6) warnings.push({ type: 'too-long', detail: `结束语 ${endChars.length} 个字，超过 6 个会缩得比较小` });
  seek(0);
  return {
    timeline,
    layout: {
      fontSize: numFs,
      lines: lines.map((l) => l.text),
      forced: [],
      issues,
      warnings,
      segmentation: ctx.segmentation.sources,
      units: timeline.units.length,
      ringDiameter: D,
      endFontSize: showEnd ? endFs : null,
    },
    seek,
    destroy() { svg.remove(); },
  };
}
