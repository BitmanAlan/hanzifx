// 共用零件的单元测试：node --test test/
// 用一个很小的假 DOM（只有 createElementNS、setAttribute、appendChild 这几样），不开浏览器。
// 平面模式要跟 013、016 换零件之前的画法逐个元素、逐个属性一样：下面把原来的画法原样抄一份当对照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParts, SWEEP_WIDTH } from '../src/parts/index.js';
import { keyColors, roundColors, badgeColors, lighten, darken } from '../src/parts/color.js';
import { hexToRgb } from '../src/lib/color.js';
import { f3, shineSweep } from '../src/motions/index.js';

// ---------- 假 DOM ----------
class Node {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.attrs = new Map(); this.children = []; this.textContent = ''; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { this.children.push(c); return c; }
}
const makeDoc = () => { const doc = { createElementNS: (ns, tag) => new Node(doc, tag) }; return doc; };
const ser = (n) => `<${n.tagName}${[...n.attrs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.textContent}${n.children.map(ser).join('')}</${n.tagName}>`;
const walk = (n, out = []) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
function mount() {
  const doc = makeDoc();
  const svg = doc.createElementNS('', 'svg');
  const defs = doc.createElementNS('', 'defs');
  svg.appendChild(defs);
  return { doc, svg, defs };
}

// ---------- 原来的画法（013、016 换零件之前，原样抄过来） ----------
const SVGNS = 'http://www.w3.org/2000/svg';
const oldKit = (doc) => {
  const el = (tag, attrs = {}, parent) => { const e = doc.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (parent) parent.appendChild(e); return e; };
  const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
  const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');
  const tf = (e, m) => (m ? e.setAttribute('transform', m) : e.removeAttribute('transform'));
  function drawCapsule(parent, { cx, cy, w, h, radius, fill, shadow, shadowOffset = [0, 0], text, textColor, fontFamily, fontSize, baseline = 0.36 }) {
    const r = radius ?? h / 2;
    const box = (dx, dy, color) => el('rect', { x: f3(cx - w / 2 + dx), y: f3(cy - h / 2 + dy), width: f3(w), height: f3(h), rx: f3(r), fill: color }, parent);
    const out = [];
    if (shadow) out.push(box(shadowOffset[0], shadowOffset[1], shadow));
    out.push(box(0, 0, fill));
    const t = el('text', { 'font-family': fontFamily, 'font-size': f3(fontSize), 'text-anchor': 'middle', x: f3(cx), y: f3(cy + fontSize * baseline), fill: textColor }, parent);
    t.textContent = text;
    out.push(t);
    return out;
  }
  function drawTagPlate(parent, { y, h, radius, fill, edge, edgeWidth, shadow }) {
    const sh = el('rect', { y: f3(y), height: f3(h), rx: f3(radius), fill: shadow }, parent);
    const plate = el('rect', { y: f3(y), height: f3(h), rx: f3(radius), fill, stroke: edge, 'stroke-width': f3(edgeWidth) }, parent);
    return { sh, plate };
  }
  function placeTagPlate(tp, { x, w, y, shadowOffset }) {
    set(tp.plate, { x, width: w });
    set(tp.sh, { x: x + shadowOffset[0], y: y + shadowOffset[1], width: w });
  }
  function drawBar(parent, { x, y, w, h, track, trackOpacity, fill, shineFill }) {
    const r = h / 2;
    const trackEl = el('rect', { x: f3(x), y: f3(y), width: f3(w), height: f3(h), rx: f3(r), fill: track, 'fill-opacity': trackOpacity }, parent);
    const fillEl = el('rect', { x: f3(x), y: f3(y), width: f3(h), height: f3(h), rx: f3(r), fill }, parent);
    const shineEl = el('rect', { x: f3(x), y: f3(y), width: f3(h), height: f3(h), rx: f3(r), fill: shineFill }, parent);
    return { track: trackEl, fill: fillEl, shine: shineEl };
  }
  function drawRoundBadge(parent, { cx, cy, r, fill, stroke, strokeWidth, text, textColor, fontFamily, fontSize, baseline }) {
    const c = el('circle', { cx: f3(cx), cy: f3(cy), r: f3(r), fill, ...(stroke ? { stroke, 'stroke-width': f3(strokeWidth) } : {}) }, parent);
    const t = el('text', { 'font-family': fontFamily, 'font-size': f3(fontSize), x: f3(cx), y: f3(cy + fontSize * baseline), 'text-anchor': 'middle', fill: textColor }, parent);
    t.textContent = text;
    return [c, t];
  }
  return { el, set, vis, tf, drawCapsule, drawTagPlate, placeTagPlate, drawBar, drawRoundBadge };
};

const FONT = "'hanzifx-notosc-black', sans-serif";
const frames = [0, 0.13, 0.5, 0.77, 1];

test('配色公式：同一个主色每次一样；顶面上亮下暗，侧壁比顶面暗，按下去比平时暗', () => {
  const lum = (c) => { const [r, g, b] = hexToRgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  for (const c of ['#FF4F2E', '#FFB000', '#3C86FF', '#2A2A33', '#FFFFFF']) {
    assert.deepEqual(keyColors(c), keyColors(c));
    const k = keyColors(c);
    assert.ok(lum(k.top[0]) >= lum(k.top[1]) && lum(k.top[1]) >= lum(k.top[2]), `${c} 顶面从亮到暗`);
    assert.ok(lum(k.side[0]) >= lum(k.side[1]), `${c} 侧壁上亮下暗`);
    assert.ok(lum(k.side[0]) <= lum(k.top[2]), `${c} 侧壁比顶面最暗处还暗`);
    assert.ok(lum(k.pressed[0]) <= lum(c) && lum(k.pressed[1]) <= lum(k.pressed[0]), `${c} 按下去变暗`);
    const r = roundColors(c);
    assert.ok(lum(r.face[0]) >= lum(r.face[1]) && lum(r.face[1]) >= lum(r.face[2]));
    const b = badgeColors(c);
    assert.ok(lum(b.face[0]) >= lum(b.face[1]) && lum(b.side) <= lum(b.face[1]));
  }
  assert.equal(lighten('#000000', 0.5), '#808080');
  assert.equal(darken('#FFFFFF', 0.5), '#808080');
});

test('平面徽章：跟 013 原来的 drawCapsule 逐个元素、每帧逐个属性一样', () => {
  for (const o of [
    { cx: 300, cy: 900, w: 180.3, h: 61.7, fill: '#FF2D2D', shadow: '#5C0005', shadowOffset: [3.1, 4.2], text: '到手价', textColor: '#FFFFFF', fontFamily: FONT, fontSize: 44.1 },
    { cx: 0, cy: 0, w: 260, h: 70, radius: 17.6, fill: '#FFE14A', shadow: '#5C0005', shadowOffset: [3, 4], text: '省¥200', textColor: '#E3141C', fontFamily: FONT, fontSize: 41 },
  ]) {
    const a = mount(); const b = mount();
    const old = oldKit(a.doc).drawCapsule(a.svg, o);
    const p = createParts(b.svg, { uid: 'x', material: 'flat', defs: b.defs }).badge({ ...o, color: o.fill });
    assert.equal(ser(b.svg), ser(a.svg));
    const K = oldKit(a.doc);
    for (const u of frames) {
      const tr = u > 0.5 ? `translate(${f3(400 + u)},${f3(900)}) rotate(-6) scale(${f3(u)})` : u ? `matrix(${f3(u)},0,0,${f3(u)},1,2)` : '';
      for (const e of old) { K.vis(e, u > 0.1); K.tf(e, tr); K.set(e, { opacity: 1 - u / 3 }); }
      p.set({ visible: u > 0.1, transform: tr, opacity: 1 - u / 3 });
      assert.equal(ser(b.svg), ser(a.svg), `第 ${u} 帧`);
    }
  }
});

test('平面圆按键：跟 016 原来的 drawRoundBadge 一样（带描边的 VS、不带描边的 A）', () => {
  for (const o of [
    { cx: 160, cy: 980, r: 44.5, fill: '#FFFFFF', text: 'A', textColor: '#FF3B5C', fontFamily: FONT, fontSize: 55.6, baseline: 0.36 },
    { cx: 540, cy: 1100, r: 80.1, fill: '#FFD23F', stroke: '#111111', strokeWidth: 8.01, text: 'VS', textColor: '#111111', fontFamily: FONT, fontSize: 76.1, baseline: 0.36 },
  ]) {
    const a = mount(); const b = mount();
    const old = oldKit(a.doc).drawRoundBadge(a.svg, o);
    const p = createParts(b.svg, { uid: 'x', material: 'flat', defs: b.defs }).key({ shape: 'circle', ...o, color: o.fill });
    assert.equal(ser(b.svg), ser(a.svg));
    const K = oldKit(a.doc);
    for (const u of frames) {
      const tr = u ? `matrix(${f3(1 + u)},0,0,${f3(1 + u)},3,4)` : '';
      for (const e of old) { K.vis(e, u < 0.9); K.tf(e, tr); K.set(e, { opacity: u }); }
      p.set({ visible: u < 0.9, transform: tr, opacity: u });
      assert.equal(ser(b.svg), ser(a.svg), `第 ${u} 帧`);
    }
  }
});

test('平面底座块：跟 013 原来的吊牌底板（投影＋带边的底，宽度每帧变）一样', () => {
  const a = mount(); const b = mount();
  const o = { y: 700.4, h: 412.9, radius: 41.3, fill: '#C9000E', edge: '#FFE14A', edgeWidth: 9.03, shadow: '#5C0005' };
  const K = oldKit(a.doc);
  const old = K.drawTagPlate(a.svg, o);
  const p = createParts(b.svg, { uid: 'x', material: 'flat', defs: b.defs }).slab({ ...o, color: o.fill, shadowOffset: [12.9, 15.5] });
  assert.equal(ser(b.svg), ser(a.svg));
  for (const u of frames) {
    const x = 100 + 50 * u, w = 800 - 100 * u;
    K.placeTagPlate(old, { x, w, y: o.y, shadowOffset: [12.9, 15.5] });
    for (const e of [old.sh, old.plate]) { K.vis(e, u > 0); K.tf(e, u ? `translate(0,${f3(-30 * u)}) rotate(${f3(u)},1,2)` : ''); K.set(e, { opacity: 1 - u }); }
    p.place({ x, w });
    p.set({ visible: u > 0, transform: u ? `translate(0,${f3(-30 * u)}) rotate(${f3(u)},1,2)` : '', opacity: 1 - u });
    assert.equal(ser(b.svg), ser(a.svg), `第 ${u} 帧`);
  }
});

test('平面进度条：跟 016 原来的 drawBar 一样（轨道透明度、填充按输赢变暗、高光只给赢家）', () => {
  const a = mount(); const b = mount();
  const o = { x: 108, y: 900.2, w: 864, h: 146.9, track: '#000000', trackOpacity: 0.55, fill: '#FF3B5C', shineFill: 'url(#x-vb-shine)' };
  const K = oldKit(a.doc);
  const old = K.drawBar(a.svg, o);
  const p = createParts(b.svg, { uid: 'x', material: 'flat', defs: b.defs }).pillBar(o);
  assert.equal(ser(b.svg), ser(a.svg));
  for (const u of frames) for (const lose of [false, true]) {
    const fw = Math.max(o.h, u * o.w), dimL = u, isWin = !lose, showcase = true;
    K.set(old.fill, { width: fw }); K.set(old.shine, { width: fw });
    const loseDim = lose ? 1 - 0.45 * dimL : 1;
    for (const e of [old.track, old.fill, old.shine]) { K.vis(e, u > 0 && (e !== old.shine || (showcase && isWin))); K.tf(e, u ? `matrix(1,0,0,1,${f3(-10 * u)},0)` : ''); }
    K.set(old.track, { opacity: u * 0.9 });
    K.set(old.fill, { opacity: u * 0.9 * loseDim });
    p.set({ visible: u > 0, shine: showcase && isWin, transform: u ? `matrix(1,0,0,1,${f3(-10 * u)},0)` : '', opacity: u * 0.9, dim: lose ? dimL : 0, fillW: fw });
    assert.equal(ser(b.svg), ser(a.svg), `第 ${u} 帧 ${lose ? '输' : '赢'}`);
  }
});

test('平面对决条：跟 016 原来的 split 版（投影、裁切、A/B 两段、高光）一样', () => {
  const a = mount(); const b = mount();
  const left = 108, barY = 1000.3, barW = 864, barH = 129.6, cx = 540;
  const K = oldKit(a.doc);
  // 原来的写法（016 style.js 的 split 分支）
  const clip = K.el('clipPath', { id: 'x-vb-clip' }, a.defs);
  const clipRect = K.el('rect', { x: left, y: barY, width: barW, height: barH, rx: barH / 2 }, clip);
  const back = K.el('rect', { x: left - 0.02 * barH, y: barY - 0.02 * barH + 0.06 * barH, width: barW + 0.04 * barH, height: barH, rx: barH / 2, fill: '#000000', 'fill-opacity': 0.6 }, a.svg);
  const g = K.el('g', { 'clip-path': 'url(#x-vb-clip)' }, a.svg);
  const fillA = K.el('rect', { x: left, y: barY, width: barW / 2, height: barH, fill: '#FF3B5C' }, g);
  const fillB = K.el('rect', { x: cx, y: barY, width: barW / 2, height: barH, fill: '#2F7BFF' }, g);
  const shine = K.el('rect', { x: left, y: barY, width: barW / 2, height: barH, fill: 'url(#x-vb-shine)' }, g);
  const p = createParts(b.svg, { uid: 'x-vb', material: 'flat', defs: b.defs }).pillBar({ split: true, x: left, y: barY, w: barW, h: barH, colorA: '#FF3B5C', colorB: '#2F7BFF', shadow: '#000000', shineFill: 'url(#x-vb-shine)' });
  assert.equal(ser(b.svg), ser(a.svg));
  for (const u of frames) for (const winSide of ['A', 'B', null]) {
    const va = 50 + 13 * u, splitX = left + (va / 100) * barW, dimL = u, on = u > 0, showcase = true;
    const m = u ? `matrix(${f3(1 - u / 9)},0,0,${f3(1 - u / 9)},1,2)` : '';
    for (const e of [back, clipRect, fillA, fillB, shine]) K.tf(e, m);
    K.vis(back, on); K.vis(fillA, on); K.vis(fillB, on);
    K.set(fillA, { width: splitX - left });
    K.set(fillB, { x: splitX, width: left + barW - splitX });
    const winA = winSide === 'A';
    K.set(shine, { x: winA ? left : splitX, width: winA ? splitX - left : left + barW - splitX });
    K.vis(shine, on && showcase && !!winSide);
    K.set(back, { opacity: u * 0.8 });
    K.set(fillA, { opacity: u * 0.8 * (winSide === 'B' ? 1 - 0.4 * dimL : 1) });
    K.set(fillB, { opacity: u * 0.8 * (winSide === 'A' ? 1 - 0.4 * dimL : 1) });
    p.set({ visible: on, transform: m, opacity: u * 0.8, splitX, shine: showcase && !!winSide, shineSide: winSide, dimA: winSide === 'B' ? dimL : 0, dimB: winSide === 'A' ? dimL : 0 });
    assert.equal(ser(b.svg), ser(a.svg), `第 ${u} 帧 赢家 ${winSide}`);
  }
});

function candyMount() {
  const { doc, svg, defs } = mount();
  const P = createParts(svg, { uid: 'm1-pt', material: 'candy', defs });
  return { doc, svg, defs, P };
}

test('糖果零件：不用滤镜、不给 <g> 设透明度、渐变 id 带挂载前缀且不重复、引用的渐变都存在', () => {
  const { svg, P } = candyMount();
  const parts = [
    P.badge({ cx: 300, cy: 900, w: 180, h: 62, color: '#FF2D2D', text: '到手价', textColor: '#FFFFFF', fontFamily: FONT, fontSize: 44 }),
    P.key({ cx: 200, cy: 400, w: 150, h: 150, color: '#F5506A', text: '赞', textColor: '#FFFFFF', fontFamily: FONT, fontSize: 60 }),
    P.key({ shape: 'circle', cx: 600, cy: 400, r: 60, color: '#FFB000', text: 'A', textColor: '#FFFFFF', fontFamily: FONT, fontSize: 60 }),
    P.slab({ x: 50, y: 1200, w: 900, h: 240, groove: 16 }),
    P.slab({ y: 700, h: 400, radius: 40, color: '#C9000E', edge: '#FFE14A', edgeWidth: 9, shadowStyle: 'drop', shadowOffset: [12, 15] }),
    P.pillBar({ x: 108, y: 1500, w: 864, h: 146, fill: '#FF3B5C', shineFill: 'url(#s)' }),
    P.pillBar({ split: true, x: 108, y: 1700, w: 864, h: 130, colorA: '#FF3B5C', colorB: '#2F7BFF', shineFill: 'url(#s)' }),
  ];
  parts[4].place({ x: 100, w: 700 });
  for (const p of parts) p.set({ visible: true, transform: 'matrix(1.1,0,0,1.1,-5,-6)', opacity: 0.7, press: 0.5, glow: 0.5, sweep: shineSweep(0.3, { start: 0, duration: 0.6, width: SWEEP_WIDTH }), fillW: 500, splitX: 600, shine: true, dim: 0.5, dimA: 0.3 });
  const all = walk(svg);
  const ids = all.filter((n) => n.attrs.has('id')).map((n) => n.attrs.get('id'));
  assert.equal(new Set(ids).size, ids.length, '渐变 id 不重复');
  for (const id of ids) assert.ok(id.startsWith('m1-pt'), `id ${id} 带挂载前缀`);
  for (const n of all) {
    assert.ok(!n.attrs.has('filter'), `${n.tagName} 不用滤镜`);
    if (n.tagName === 'g') assert.ok(!n.attrs.has('opacity'), '<g> 不设透明度');
    for (const [k, v] of n.attrs) {
      const m = /url\(#([^)]+)\)/.exec(v);
      if (m && m[1] !== 's') assert.ok(ids.includes(m[1]), `${k} 引用的 ${m[1]} 存在`);
    }
    // 只做等比缩放：transform 里不许出现 scale(a,b) 两个不同的数
    const t = n.attrs.get('transform');
    if (t && /scale\(/.test(t)) for (const s of t.matchAll(/scale\(([^)]+)\)/g)) { const v = s[1].split(/[ ,]+/); assert.ok(v.length === 1 || v[0] === v[1]); }
  }
  // 糖果五样都在：顶面渐变、白亮边、镜面高光、往下挤出的侧壁、按下去的顶面
  const key = parts[1].els;
  const fills = key.map((e) => e.getAttribute('fill') || '').join(' ');
  for (const name of ['ktop', 'kspec', 'kside', 'kpress']) assert.ok(fills.includes(name), `方按键有 ${name}`);
  assert.ok(key.some((e) => (e.getAttribute('stroke') || '').includes('rim')), '方按键有白亮边');
});

test('糖果按键：按下去顶面这一组往下挪、侧壁不动；press 很小就当没按；每次 set 都从默认值算，不沿用上一帧', () => {
  const { P } = candyMount();
  const k = P.key({ cx: 200, cy: 400, w: 150, h: 150, color: '#F5506A', text: '赞', textColor: '#FFFFFF', fontFamily: FONT, fontSize: 60 });
  const d = k.depth;
  k.set({ transform: 'matrix(2,0,0,2,1,1)', press: 1, sweep: { u: 0.5, visible: true }, glow: 1 });
  const tops = k.els.filter((e) => (e.getAttribute('transform') || '').includes('translate(0,'));
  assert.ok(tops.length >= 6, '顶面、按下去的顶面、高光、反光、亮边、扫光、字都往下挪');
  assert.ok(tops.every((e) => e.getAttribute('transform') === `matrix(2,0,0,2,1,1) translate(0,${f3(0.565 * d)})`));
  const side = k.els.find((e) => (e.getAttribute('fill') || '').includes('kside'));
  assert.equal(side.getAttribute('transform'), 'matrix(2,0,0,2,1,1)', '侧壁不跟着挪');
  k.set({ transform: 'matrix(2,0,0,2,1,1)', press: 0.001 });
  assert.ok(k.els.every((e) => e.getAttribute('transform') === 'matrix(2,0,0,2,1,1)'), '按下 0.1% 当没按');
  k.set({});
  assert.ok(k.els.every((e) => e.getAttribute('transform') === null), '不给 transform 就是不变换');
  const hidden = k.els.filter((e) => e.getAttribute('visibility') === 'hidden');
  assert.ok(hidden.length >= 4, '按下去的顶面、外发光两层、扫光默认都藏起来');
  assert.ok(k.els.every((e) => e.getAttribute('opacity') !== null), '每层都写了透明度');
});

test('糖果扫光：色标跟着 u 走，扫完全部归零', () => {
  const { defs, P } = candyMount();
  const k = P.key({ cx: 200, cy: 400, w: 150, h: 150, color: '#3C86FF' });
  const grad = defs.children.find((n) => /sweep$/.test(n.getAttribute('id') || ''));
  assert.ok(grad, '有扫光渐变');
  assert.equal(grad.getAttribute('gradientUnits'), 'userSpaceOnUse');
  assert.match(grad.getAttribute('gradientTransform'), /^rotate\(24,/);
  k.set({ sweep: shineSweep(0.3, { start: 0, duration: 0.6, width: SWEEP_WIDTH }) });
  assert.ok(grad.children.some((s) => Number(s.getAttribute('stop-opacity')) > 0.5), '扫到一半有亮带');
  k.set({ sweep: shineSweep(0.7, { start: 0, duration: 0.6, width: SWEEP_WIDTH }) });
  assert.ok(grad.children.every((s) => Number(s.getAttribute('stop-opacity')) === 0), '扫完没有亮带');
});

test('糖果胶囊条：填充宽度从最短到满格，满格时正好填满槽', () => {
  const { P } = candyMount();
  const x = 108, w = 864, h = 146;
  const bar = P.pillBar({ x, y: 1500, w, h, fill: '#FF3B5C', shineFill: 'url(#s)' });
  const ins = 0.13 * h, hi = h - 2 * ins;
  assert.equal(bar.fillRight(h), x + ins + hi, '最短是一个圆头');
  assert.ok(Math.abs(bar.fillRight(w) - (x + w - ins)) < 1e-9, '满格到槽的右头');
  assert.ok(bar.fillRight(w * 0.6) < bar.fillRight(w * 0.7), '越长越往右');
});

test('零件画进指定的组；visible: inherit 时显示的层写 inherit（不盖过父组的 hidden），藏起来的层照样 hidden', () => {
  const { doc, svg, P } = candyMount();
  const g = doc.createElementNS('', 'g');
  svg.appendChild(g);
  const k = P.key({ shape: 'circle', cx: 0, cy: 0, r: 50, color: '#F5506A', parent: g });
  assert.ok(k.els.every((e) => g.children.includes(e)), '全部画在指定的组里');
  k.set({ visible: 'inherit' });
  const v = k.els.map((e) => e.getAttribute('visibility'));
  assert.ok(v.includes('inherit') && !v.includes('visible'), '显示的层写 inherit');
  assert.ok(v.includes('hidden'), '按下去的顶面、外发光、扫光照样藏着');
  const flat = createParts(svg, { uid: 'f', material: 'flat' }).key({ shape: 'circle', cx: 0, cy: 0, r: 50, color: '#FFFFFF', text: 'A', textColor: '#000000', fontFamily: FONT, fontSize: 40, parent: g });
  assert.ok(flat.els.every((e) => g.children.includes(e)), '平面也画进指定的组');
});

test('按键 idleColor：没点亮只看得到灰的那套，点亮一半主色盖一半，按下去时没点亮的不盖主色的压暗顶面', () => {
  const { P } = candyMount();
  for (const shape of ['circle', 'rect']) {
    const k = P.key({ shape, cx: 0, cy: 0, r: 50, w: 100, h: 100, color: '#F5506A', idleColor: '#3A3A42' });
    const litLayers = (st) => { k.set(st); return k.els.filter((e) => e.getAttribute('visibility') === 'visible' && (e.getAttribute('fill') || '').includes(shape === 'circle' ? 'rfaceF5506A' : 'ktop')); };
    assert.equal(litLayers({}).length, shape === 'circle' ? 0 : 1, `${shape}：不给 lit 就是没点亮（方键的灰顶面也用 ktop 渐变，只算 1 层）`);
    k.set({ lit: 0.5 });
    const over = k.els.filter((e) => Number(e.getAttribute('opacity')) === 0.5);
    assert.ok(over.length >= 2, `${shape}：点亮一半时主色的侧壁和顶面透明度 0.5`);
    k.set({ press: 1, lit: 0 });
    const pressed = k.els.filter((e) => /press/.test(e.getAttribute('fill') || ''));
    assert.ok(pressed.length && pressed.every((e) => e.getAttribute('visibility') !== 'visible' || Number(e.getAttribute('opacity')) === 0), `${shape}：没点亮按下去，压暗顶面不显出来`);
  }
});
