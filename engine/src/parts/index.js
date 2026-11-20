// 共用零件：底座块 slab、按键 key、徽章 badge、胶囊条 pillBar。互动元素直接调，不要每个元素自己画一遍。
// 两种质感（material）：
//   'flat'  平面：原来的画法（013、016 里的胶囊、吊牌、进度条、圆徽章原样搬过来，画出来跟换零件之前逐帧一样）；
//   'candy' 亮面糖果：顶面渐变、白亮边、镜面高光、往下挤出的侧壁、按下去侧壁变薄、高光扫过。
//           一律正面朝前（不做透视倾斜，倾斜会让上面的字非等比缩放）；软影子用径向渐变画，不用模糊滤镜。
// 守《写一个新风格》第 3 节的规矩：不用任何滤镜；不给整组做透明度动画（透明度只写在单个图形上）；
//   只做等比缩放和位移，写进每个元素自己的 transform；数字过 f3；渐变只建一次，id 带挂载前缀。
//
// 用法：
//   const parts = createParts(svg, { uid, material: P.material, defs });
//   const k = parts.key({ shape: 'circle', cx, cy, r, color: K.fill, text: 'A', textColor: K.inner, fontFamily, fontSize });
//   每帧（seek 里）调一次 set，没写的项用默认值（显示、不变换、不透明、没按下），不沿用上一帧，保证 seek(t) 只看 t：
//   k.set({ visible, transform, opacity, press: 0..1, glow: 0..1, lit: 0..1, sweep: shineSweep(t, { width: SWEEP_WIDTH, … }) });
//   零件放在一个自己会整体显示、隐藏的 <g> 里时（建零件时给 parent），visible 传 'inherit'：
//   显示的层写 visibility="inherit"，跟着父层走（子元素写 visible 会盖过父层的 hidden，见第 3 节第 1 条）。
import { f3, shineStops } from '../motions/index.js';
import { keyColors, roundColors, badgeColors, CREAM, lighten, darken } from './color.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export const MATERIALS = ['candy', 'flat'];
/** 高光扫过的带宽（半宽，占零件宽）：带子总宽 34% */
export const SWEEP_WIDTH = 0.17;
/** 按下去顶面往下挪侧壁厚度的多少（0.13u / 0.23u） */
export const PRESS_SINK = 0.565;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const snap = (v) => (Math.abs(v) < 0.05 ? 0 : v);
const setA = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on, shown = 'visible') => e.setAttribute('visibility', on ? shown : 'hidden');
const tf = (e, m) => (m ? e.setAttribute('transform', m) : e.removeAttribute('transform'));

// 渐变方向（objectBoundingBox）：竖向、CSS 160°、170°、175°
const VERT = [0, 0, 0, 1];
const DEG160 = [0.329, 0.03, 0.671, 0.97];
const DEG170 = [0.413, 0.008, 0.587, 0.992];
const DEG175 = [0.456, 0.002, 0.544, 0.998];
// 白亮边：上沿白、往下淡掉，下沿一点点压暗（描在往里缩半个线宽的同形状上）
const RIM = [[0, '#FFFFFF', 0.75], [0.35, '#FFFFFF', 0], [0.7, '#000000', 0], [1, '#000000', 0.1]];
const GLOSS = [[0, '#FFFFFF', 0.62], [1, '#FFFFFF', 0]];

/** 圆角矩形的属性（f3 过） */
const rr = (x, y, w, h, r) => ({ x: f3(x), y: f3(y), width: f3(Math.max(0, w)), height: f3(Math.max(0, h)), rx: f3(Math.max(0, Math.min(r, w / 2, h / 2))) });

/**
 * createParts(svg, { uid, material, defs, parent })
 * - uid：挂载前缀（风格自己的 uid），渐变 id 用它开头，一页挂多个预览不撞
 * - material：'candy' | 'flat'，默认 'candy'
 * - defs：风格自己的 <defs>（平面胶囊条的裁切要放进去，跟原来一样）；不给就在用到时新建一个
 * - parent：零件画在哪个元素里，默认 svg
 */
export function createParts(svg, { uid = 'p', material = 'candy', defs = null, parent = null, doc = null } = {}) {
  const D = doc || svg.ownerDocument || globalThis.document;
  const el = (tag, attrs = {}, par) => {
    const e = D.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (par) par.appendChild(e);
    return e;
  };
  const host0 = parent || svg;
  const candy = material !== 'flat';
  let defsEl = defs;
  const getDefs = () => (defsEl ||= el('defs', {}, svg));
  let partNo = 0;

  // ---------- 渐变 ----------
  const shared = new Map();
  const grad = (kind, id, attrs, stops) => {
    const g = el(kind, { id, ...attrs }, getDefs());
    const stopEls = stops.map(([o, c, op = 1]) => el('stop', { offset: f3(o), 'stop-color': c, 'stop-opacity': f3(op) }, g));
    return { g, stops: stopEls, url: `url(#${id})` };
  };
  const lin = (id, [x1, y1, x2, y2], stops, extra = {}) => grad('linearGradient', id, { x1: f3(x1), y1: f3(y1), x2: f3(x2), y2: f3(y2), ...extra }, stops);
  const rad = (id, { cx = 0.5, cy = 0.5, r = 0.5, transform } = {}, stops) =>
    grad('radialGradient', id, { cx: f3(cx), cy: f3(cy), r: f3(r), ...(transform ? { gradientTransform: transform } : {}) }, stops);
  /** 同样参数的渐变整页只建一个 */
  const once = (key, make) => {
    if (!shared.has(key)) shared.set(key, make(`${uid}-pt-${key.replace(/[^0-9A-Za-z]+/g, '')}`));
    return shared.get(key).url;
  };
  const linUrl = (name, dir, stops) => once(`${name}${stops.map((s) => s.join('')).join('')}`, (id) => lin(id, dir, stops));
  const rimUrl = () => linUrl('rim', VERT, RIM);
  const glossUrl = () => linUrl('gloss', VERT, GLOSS);
  /** 软影子：椭圆，中间深、往外透明 */
  const softUrl = (color, a = 0.32) => once(`soft${color}${a}`, (id) => rad(id, {}, [[0, color, a], [0.55, color, a * 0.55], [1, color, 0]]));
  /** 外发光：径向渐变，主色 50% → 透明 */
  const glowUrl = (color) => once(`glow${color}`, (id) => rad(id, {}, [[0, color, 0.5], [0.6, color, 0.28], [1, color, 0]]));

  /** 高光扫过：一条倾斜 24° 的白带，横向渐变（userSpaceOnUse），每帧只改色标位置 */
  function sweepGrad(x0, w, cx, cy) {
    const id = `${uid}-pt${partNo}-sweep`;
    const g = lin(id, [x0, cy, x0 + w, cy], [0, 0, 0, 0, 0, 0].map(() => [0, '#FFFFFF', 0]), { gradientUnits: 'userSpaceOnUse', gradientTransform: `rotate(24,${f3(cx)},${f3(cy)})` });
    return {
      url: g.url,
      update(sw) {
        const pts = sw && sw.visible ? shineStops(sw.u, { width: SWEEP_WIDTH, peak: 0.85 }) : [];
        g.stops.forEach((s, i) => { const p = pts[i]; setA(s, { offset: p ? p[0] : 1, 'stop-opacity': p ? p[1] : 0 }); });
      },
    };
  }

  // ---------- 每帧 ----------
  // 每层：{ e, top（按下去跟着顶面往下挪）, on(st)（额外的显示条件）, op(st)（这一层的透明度）,
  //         noVis / noTf / noOp（这一层不写显示 / 变换 / 透明度，平面模式照原来的写法） }
  function makeSet(layers, { sink = 0, before, litDefault = 1 } = {}) {
    return (o = {}) => {
      const st = { ...o, visible: o.visible ?? true, transform: o.transform ?? '', opacity: o.opacity ?? 1, press: clamp01(o.press ?? 0), glow: clamp01(o.glow ?? 0), lit: clamp01(o.lit ?? litDefault), sweep: o.sweep ?? null };
      if (before) before(st);
      const dy = snap(st.press * sink);
      const topT = [st.transform, dy ? `translate(0,${f3(dy)})` : ''].filter(Boolean).join(' ');
      const shown = st.visible === 'inherit' ? 'inherit' : 'visible';
      for (const L of layers) {
        if (!L.noVis) vis(L.e, st.visible && (L.on ? L.on(st) : true), shown);
        if (!L.noTf) tf(L.e, L.top ? topT : st.transform);
        if (!L.noOp) setA(L.e, { opacity: L.op ? L.op(st) : st.opacity });
      }
    };
  }
  const pressedOn = (st) => st.press > 0.01;
  const litOn = (st) => st.lit > 0.01;
  const glowOn = (st) => st.glow > 0.01;
  const sweepOn = (st) => !!(st.sweep && st.sweep.visible);

  // ======================================================================
  // 徽章：胶囊或圆角矩形加一行字。(cx, cy) 是中心；radius 不给就圆到头。
  //   平面：硬投影（给了 shadow 才有）、底、字。
  //   糖果：投影、白外圈、厚度、竖向渐变的面、镜面高光、白亮边、字（带一层很淡的硬投影）。
  function badge({ cx, cy, w, h, radius, color, text = '', textColor, fontFamily, fontSize, baseline = 0.36, shadow, shadowOffset = [0, 0], ring, depth, parent: par } = {}) {
    partNo++;
    const host = par || host0;
    const r = radius ?? h / 2;
    const txt = (attrs, par) => { const t = el('text', { 'font-family': fontFamily, 'font-size': f3(fontSize), 'text-anchor': 'middle', x: f3(cx), y: f3(cy + fontSize * baseline), ...attrs }, par); t.textContent = text; return t; };
    if (!candy) {
      const box = (dx, dy, c) => el('rect', { x: f3(cx - w / 2 + dx), y: f3(cy - h / 2 + dy), width: f3(w), height: f3(h), rx: f3(r), fill: c }, host);
      const els = [];
      if (shadow) els.push(box(shadowOffset[0], shadowOffset[1], shadow));
      els.push(box(0, 0, color));
      els.push(txt({ fill: textColor }, host));
      return { els, set: makeSet(els.map((e) => ({ e }))) };
    }
    const C = badgeColors(color);
    const d = depth ?? 0.1 * h;
    const ringW = ring === false ? 0 : ring ?? Math.max(2, 0.07 * h);
    const x0 = cx - w / 2, y0 = cy - h / 2;
    const sw = Math.max(1.5, 0.06 * h);
    const faceUrl = linUrl('bface', VERT, [[0, C.face[0]], [1, C.face[1]]]);
    const sweep = sweepGrad(x0, w, cx, cy);
    const L = [];
    const add = (e, extra = {}) => { L.push({ e, ...extra }); return e; };
    add(el('rect', { ...rr(x0 - ringW, y0 - ringW + 0.12 * h, w + 2 * ringW, h + d + 2 * ringW, r + ringW), fill: C.shadow, 'fill-opacity': 0.35 }, host));
    if (ringW) add(el('rect', { ...rr(x0 - ringW, y0 - ringW, w + 2 * ringW, h + d + 2 * ringW, r + ringW), fill: '#FFFFFF' }, host));
    add(el('rect', { ...rr(x0, y0 + d, w, h, r), fill: C.side }, host));
    add(el('rect', { ...rr(x0, y0, w, h, r), fill: faceUrl }, host));
    const gx = Math.min(0.24 * h, 0.2 * w);
    add(el('rect', { ...rr(x0 + gx, y0 + 0.07 * h, w - 2 * gx, 0.4 * h, 0.2 * h), fill: glossUrl() }, host));
    add(el('rect', { ...rr(x0 + sw / 2, y0 + sw / 2, w - sw, h - sw, r - sw / 2), fill: 'none', stroke: rimUrl(), 'stroke-width': f3(sw) }, host));
    add(el('rect', { ...rr(x0, y0, w, h, r), fill: sweep.url }, host), { on: sweepOn });
    const ts = 0.03 * h;
    add(txt({ fill: '#000000', 'fill-opacity': 0.14, x: f3(cx + ts), y: f3(cy + fontSize * baseline + ts) }, host));
    add(txt({ fill: textColor }, host));
    return { els: L.map((x) => x.e), set: makeSet(L, { before: (st) => sweep.update(st.sweep) }), footprint: { x: x0 - ringW, y: y0 - ringW, w: w + 2 * ringW, h: h + d + 2 * ringW + 0.12 * h } };
  }

  // ======================================================================
  // 按键：方形键帽（shape 'rect'，w、h、radius）或圆按钮（shape 'circle'，r），上面一行字（text）或自己画的图标（draw）。
  //   平面：一个底（可带描边）加字；按下去只往下挪一点。
  //   糖果：软影子、外发光（glow）、侧壁、顶面渐变、按下去的顶面、镜面高光、底边反光、白亮边、高光扫过、内容。
  //   按下（press 0..1）：顶面这一组往下挪侧壁厚度的 56.5%，侧壁看起来变薄；顶面换成压暗的渐变，高光变弱。
  //   点亮（给了 idleColor 才有）：没点亮时侧壁和顶面用 idleColor 那一套颜色，lit 0..1 时主色那一套盖上来（只调这两层自己的透明度）。
  // draw(parent, { cx, cy, u }) 返回画好的元素数组，它们跟着顶面一起动。
  function key({ shape = 'rect', cx, cy, w, h, r, radius, color, idleColor = null, depth, text, textColor, fontFamily, fontSize, baseline = 0.36, stroke, strokeWidth, draw, shadow = true, glow: withGlow = true, parent: par } = {}) {
    partNo++;
    const host = par || host0;
    const round = shape === 'circle';
    if (round) { w = h = 2 * r; }
    const u = Math.min(w, h);
    const x0 = cx - w / 2, y0 = cy - h / 2;
    const content = (par, extra = {}) => {
      const out = [];
      if (text !== undefined && text !== null && text !== '') {
        const t = el('text', { 'font-family': fontFamily, 'font-size': f3(fontSize), x: f3(cx), y: f3(cy + fontSize * baseline), 'text-anchor': 'middle', fill: textColor, ...extra }, par);
        t.textContent = text;
        out.push(t);
      }
      return out;
    };
    if (!candy) {
      const body = round
        ? el('circle', { cx: f3(cx), cy: f3(cy), r: f3(r), fill: color, ...(stroke ? { stroke, 'stroke-width': f3(strokeWidth) } : {}) }, host)
        : el('rect', { ...rr(x0, y0, w, h, radius ?? 0.28 * u), fill: color, ...(stroke ? { stroke, 'stroke-width': f3(strokeWidth) } : {}) }, host);
      const els = [body, ...content(host), ...(draw ? draw(host, { cx, cy, u }) : [])];
      return { els, set: makeSet(els.map((e) => ({ e, top: true })), { sink: 0.06 * u }) };
    }
    const d = depth ?? (round ? 0.08 * u : 0.23 * u);
    const rad0 = radius ?? 0.28 * u;
    const sw = Math.max(1.5, round ? 0.03 * u : 0.02 * u);
    const sweep = sweepGrad(x0, w, cx, cy);
    const L = [];
    const add = (e, extra = {}) => { L.push({ e, ...extra }); return e; };
    const shape0 = (dx, dy, grow, attrs) => (round
      ? el('circle', { cx: f3(cx + dx), cy: f3(cy + dy), r: f3(r + grow), ...attrs }, host)
      : el('rect', { ...rr(x0 + dx - grow, y0 + dy - grow, w + 2 * grow, h + 2 * grow, rad0 + grow), ...attrs }, host));
    if (round) {
      const C = roundColors(color);
      if (shadow) add(el('ellipse', { cx: f3(cx), cy: f3(cy + r + d * 0.6), rx: f3(0.95 * r), ry: f3(0.3 * r), fill: softUrl(C.shadow) }, host));
      if (withGlow) add(shape0(0, 0, 0.4 * r, { fill: glowUrl(color) }), { on: glowOn, op: (st) => st.opacity * st.glow });
      add(shape0(0, d + Math.max(1, 0.01 * u), 0, { fill: '#000000', 'fill-opacity': 0.15 }));
      const rFace = (c, CC) => once(`rface${c}`, (id) => rad(id, { cx: 0.35, cy: 0.25, r: 0.95 }, [[0, CC.face[0]], [0.55, CC.face[1]], [1, CC.face[2]]]));
      const litOp = (st) => st.opacity * st.lit;
      if (idleColor) {
        const I = roundColors(idleColor);
        add(shape0(0, d, 0, { fill: I.side }));
        add(shape0(0, d, 0, { fill: C.side }), { on: litOn, op: litOp });
      } else add(shape0(0, d, 0, { fill: C.side }));
      const faceUrl = rFace(color, C);
      const pressUrl = once(`rpress${color}`, (id) => rad(id, { cx: 0.35, cy: 0.25, r: 0.95 }, [[0, darken(color, 0.02)], [1, darken(color, 0.22)]]));
      if (idleColor) {
        add(shape0(0, 0, 0, { fill: rFace(idleColor, roundColors(idleColor)) }), { top: true });
        add(shape0(0, 0, 0, { fill: faceUrl }), { top: true, on: litOn, op: litOp });
      } else add(shape0(0, 0, 0, { fill: faceUrl }), { top: true });
      add(shape0(0, 0, 0, { fill: pressUrl }), { top: true, on: pressedOn, op: (st) => st.opacity * st.press * (idleColor ? st.lit : 1) });
      add(el('ellipse', { cx: f3(cx - 0.12 * r), cy: f3(cy - 0.48 * r), rx: f3(0.64 * r), ry: f3(0.4 * r), fill: linUrl('gloss8', VERT, [[0, '#FFFFFF', 0.8], [1, '#FFFFFF', 0]]) }, host), { top: true, op: (st) => st.opacity * (1 - 0.4 * st.press) });
      add(el('circle', { cx: f3(cx), cy: f3(cy), r: f3(r - sw / 2), fill: 'none', stroke: linUrl('rim6', VERT, [[0, '#FFFFFF', 0.6], [0.35, '#FFFFFF', 0], [0.7, '#000000', 0], [1, '#000000', 0.1]]), 'stroke-width': f3(sw) }, host), { top: true });
      add(shape0(0, 0, 0, { fill: sweep.url }), { top: true, on: sweepOn });
    } else {
      const C = keyColors(color);
      if (shadow) add(el('ellipse', { cx: f3(cx), cy: f3(cy + h / 2 + d * 0.75), rx: f3(0.62 * w), ry: f3(0.2 * h + 0.3 * d), fill: softUrl(C.shadow) }, host));
      if (withGlow) {
        add(shape0(0, 0, 0.27 * u, { fill: glowUrl(color) }), { on: glowOn, op: (st) => st.opacity * st.glow });
        add(shape0(0, 0, 0.1 * u, { fill: 'none', stroke: color, 'stroke-opacity': 0.55, 'stroke-width': f3(Math.max(2, 0.02 * u)) }), { on: glowOn, op: (st) => st.opacity * st.glow });
      }
      const sideOf = (CC) => linUrl('kside', VERT, [[0, CC.side[0]], [1, CC.side[1]]]);
      const topOf = (CC) => linUrl('ktop', DEG160, [[0, CC.top[0]], [0.48, CC.top[1]], [1, CC.top[2]]]);
      const litOp = (st) => st.opacity * st.lit;
      if (idleColor) {
        const I = keyColors(idleColor);
        add(shape0(0, d, 0, { fill: sideOf(I) }));
        add(shape0(0, d, 0, { fill: sideOf(C) }), { on: litOn, op: litOp });
        add(shape0(0, 0, 0, { fill: topOf(I) }), { top: true });
        add(shape0(0, 0, 0, { fill: topOf(C) }), { top: true, on: litOn, op: litOp });
      } else {
        add(shape0(0, d, 0, { fill: sideOf(C) }));
        add(shape0(0, 0, 0, { fill: topOf(C) }), { top: true });
      }
      add(shape0(0, 0, 0, { fill: linUrl('kpress', DEG160, [[0, C.pressed[0]], [1, C.pressed[1]]]) }), { top: true, on: pressedOn, op: (st) => st.opacity * st.press * (idleColor ? st.lit : 1) });
      // 镜面高光：中心在顶面 (28%, 8%)、半径 85% × 55% 的椭圆
      const specUrl = once('kspec', (id) => rad(id, { cx: 0.28, cy: 0.08, r: 0.85, transform: 'translate(0.28,0.08) scale(1,0.647) translate(-0.28,-0.08)' }, [[0, '#FFFFFF', 0.72], [0.45, '#FFFFFF', 0.12], [0.62, '#FFFFFF', 0], [1, '#FFFFFF', 0]]));
      add(shape0(0, 0, 0, { fill: specUrl }), { top: true, op: (st) => st.opacity * (1 - 0.4 * st.press) });
      add(shape0(0, 0, 0, { fill: linUrl('kreflect', VERT, [[0.72, '#FFFFFF', 0], [1, '#FFFFFF', 0.16]]) }), { top: true });
      add(el('rect', { ...rr(x0 + sw / 2, y0 + sw / 2, w - sw, h - sw, rad0 - sw / 2), fill: 'none', stroke: rimUrl(), 'stroke-width': f3(sw) }, host), { top: true });
      add(shape0(0, 0, 0, { fill: sweep.url }), { top: true, on: sweepOn });
    }
    // 内容：字带一层很淡的硬投影（往下错开 0.02u，黑 12%），用平移画，不用滤镜
    if (text !== undefined && text !== null && text !== '') {
      const ts = 0.02 * u;
      for (const e of content(host, { fill: '#000000', 'fill-opacity': 0.12, x: f3(cx + ts * 0.5), y: f3(cy + fontSize * baseline + ts) })) add(e, { top: true });
      for (const e of content(host)) add(e, { top: true });
    }
    if (draw) for (const e of draw(host, { cx, cy, u })) add(e, { top: true });
    return {
      els: L.map((x) => x.e),
      set: makeSet(L, { sink: PRESS_SINK * d, before: (st) => sweep.update(st.sweep), litDefault: idleColor ? 0 : 1 }),
      depth: d,
      footprint: round ? { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r + d } : { x: x0, y: y0, w, h: h + d },
    };
  }

  // ======================================================================
  // 底座块：圆角矩形的托盘、吊牌、卡片底。color 不给就是奶白（承托按钮的托盘）。
  //   宽度可以每帧变：建的时候不给 x、w，每帧调 place({ x, w })（吊牌跟着价格收窄就是这样）；糖果还能给 y、h、r（对话泡跟着字长高）。
  //   平面：硬投影（给了 shadow 才有，位置 = 底 + shadowOffset）、底（edge 是描边色）。
  //   糖果：影子（shadowStyle 'soft' 地面软影子 / 'drop' 往右下错开的投影，会晃的吊牌用 drop）、侧壁、顶面、
  //         镜面高光（彩色底才有）、凹槽（groove，奶白托盘用）、描边（edge，细一点）、白亮边。
  // 可选（不给就是默认画法）：
  //   shade：彩色底座块顶面往下压暗多少（默认 0.12，跟按键一样）；面积大、上面要放字的白卡片可以给小一点（比如 0.05），不显灰
  //   sideColors [上, 下]：侧壁颜色（默认按 color 压暗）；白卡片用浅一点、带点色调的侧壁，别垫一块灰板
  //   sideEdge：侧壁最底下一道深色边线的颜色（厚度感靠它撑），sideEdgeWidth 线宽
  //   shadowColor、shadowOpacity：影子的颜色和浓度（drop 默认 0.4；招牌要压得住画面时给到 0.85）
  function slab({ x, y, w, h, radius, color = null, depth, edge, edgeWidth = 0, shadow, shadowOffset = [0, 0], shadowStyle = 'soft', groove = 0, shade = null, sideColors = null, sideEdge = null, sideEdgeWidth = null, shadowColor: shadowColorIn = null, shadowOpacity = null, parent: par } = {}) {
    partNo++;
    const host = par || host0;
    const r = radius ?? 0.27 * h;
    if (!candy) {
      const xw = (x0, w0, y, h, r) => (x0 === undefined ? {} : { x: f3(x0), width: f3(w0) });
      const sh = shadow ? el('rect', { y: f3(y), height: f3(h), rx: f3(r), fill: shadow }, host) : null;
      const plate = el('rect', { y: f3(y), height: f3(h), rx: f3(r), fill: color, ...(edge ? { stroke: edge, 'stroke-width': f3(edgeWidth) } : {}) }, host);
      const els = [sh, plate].filter(Boolean);
      const place = (o) => {
        setA(plate, { x: o.x, width: o.w });
        if (sh) setA(sh, { x: o.x + shadowOffset[0], y: y + shadowOffset[1], width: o.w });
      };
      if (x !== undefined) { setA(plate, xw(x, w)); place({ x, w }); }
      return { els, set: makeSet(els.map((e) => ({ e }))), place };
    }
    const d = depth ?? 0.2 * h;
    const sw = Math.max(1.5, 0.018 * h);
    const cream = !color;
    const C = cream ? CREAM : keyColors(color);
    const shadowColor = shadowColorIn ?? (cream ? CREAM.shadow : C.shadow);
    const L = [];
    const add = (e, at, extra = {}) => { L.push({ e, at, ...extra }); return e; };
    if (shadowStyle === 'drop') {
      add(el('rect', { fill: shadowColor, 'fill-opacity': shadowOpacity ?? 0.4 }, host), (x0, w0, y, h, r) => rr(x0 + shadowOffset[0], y + shadowOffset[1] + d * 0.5, w0, h + d, r));
    } else {
      add(el('ellipse', { fill: softUrl(shadowColor, shadowOpacity ?? (cream ? 0.28 : 0.32)) }, host), (x0, w0, y, h, r) => ({ cx: f3(x0 + w0 / 2), cy: f3(y + h + d * 0.55), rx: f3(0.54 * w0), ry: f3(0.14 * h + 0.5 * d) }));
    }
    if (sideEdge) {
      const ew0 = sideEdgeWidth ?? Math.max(1.5, 0.14 * d);
      add(el('rect', { fill: sideEdge }, host), (x0, w0, y, h, r) => rr(x0, y + d + ew0, w0, h, r));
    }
    const side = sideColors || C.side;
    add(el('rect', { fill: linUrl(cream && !sideColors ? 'cside' : 'kside', VERT, [[0, side[0]], [1, side[1]]]) }, host), (x0, w0, y, h, r) => rr(x0, y + d, w0, h, r));
    const top2 = !cream && shade !== null ? darken(color, shade) : C.top[2];
    const topUrl = cream ? linUrl('ctop', DEG170, [[0, C.top[0]], [0.6, C.top[1]], [1, C.top[2]]]) : linUrl('ktop', DEG160, [[0, C.top[0]], [0.48, C.top[1]], [1, top2]]);
    add(el('rect', { fill: topUrl }, host), (x0, w0, y, h, r) => rr(x0, y, w0, h, r));
    // 描边（配色里的边色）贴着最外沿，白亮边在它里面
    const ew = edge && edgeWidth > 0 ? edgeWidth * 0.8 : 0;
    if (!cream) {
      // 彩色底座块的镜面高光：跟底座块同样圆角、往里缩一圈的形状，上沿最亮，往下软过渡到 45% 处没有
      // （底座块面积大，比按键的高光淡，免得盖住上面的字）
      const m = ew + 1.5 * sw;
      add(el('rect', { fill: linUrl('sgloss', VERT, [[0, '#FFFFFF', 0.4], [0.2, '#FFFFFF', 0.24], [0.45, '#FFFFFF', 0]]) }, host), (x0, w0, y, h, r) => rr(x0 + m, y + m, w0 - 2 * m, h - 2 * m, Math.max(r - m, 0.7 * r)));
    }
    if (groove > 0) {
      add(el('rect', { fill: 'none', stroke: '#FFFFFF', 'stroke-opacity': 0.9, 'stroke-width': 1 }, host), (x0, w0, y, h, r) => rr(x0 + groove + 1, y + groove + 1, w0 - 2 * groove, h - 2 * groove, Math.max(0, r - groove)));
      add(el('rect', { fill: 'none', stroke: CREAM.groove, 'stroke-opacity': 0.18, 'stroke-width': 1 }, host), (x0, w0, y, h, r) => rr(x0 + groove, y + groove, w0 - 2 * groove, h - 2 * groove, Math.max(0, r - groove)));
    }
    if (ew) add(el('rect', { fill: 'none', stroke: edge, 'stroke-width': f3(ew) }, host), (x0, w0, y, h, r) => rr(x0 + ew / 2, y + ew / 2, w0 - ew, h - ew, Math.max(0, r - ew / 2)));
    add(el('rect', { fill: 'none', stroke: rimUrl(), 'stroke-width': f3(sw) }, host), (x0, w0, y, h, r) => rr(x0 + ew + sw / 2, y + ew + sw / 2, w0 - 2 * ew - sw, h - 2 * ew - sw, Math.max(0, r - ew - sw / 2)));
    // 每帧挪位置、改大小：x、w 必给；y、h、r 不给就用建的时候的值（对话泡这类跟着内容长高的用得上）
    const place = (o) => { for (const l of L) setA(l.e, l.at(o.x, o.w, o.y ?? y, o.h ?? h, o.r ?? r)); };
    if (x !== undefined) place({ x, w });
    return { els: L.map((l) => l.e), set: makeSet(L), place, depth: d };
  }
  // ======================================================================
  // 胶囊条：两头圆到头的长条。两种用法：
  //   单条（进度条）：轨道 + 从左边长出来的一段填充。每帧 set({ fillW })，fillW 是平面画法里填充的外宽（≥ 高）。
  //   对决条（split: true）：A 从左、B 从右，在分界点 splitX 相遇。每帧 set({ splitX })。
  // shineFill：风格自己的高光渐变（url），盖在填充上，set({ shine }) 控制显示（对决条另有 shineSide 'A'|'B'）。
  // 输的一边变暗：set({ dim })（单条）/ set({ dimA, dimB })（对决条），0..1。
  //   平面：填充的透明度乘 (1 - 0.45·dim)（对决条 0.4），跟原来一样；糖果：盖一层压暗，填充本身不透明，不会透出侧壁。
  function pillBar(o = {}) { partNo++; return o.split ? duelBar(o) : progressBar(o); }

  function progressBar({ x, y, w, h, track, trackOpacity, fill, shineFill, depth, inset, parent: par } = {}) {
    const host = par || host0;
    if (!candy) {
      const r = h / 2;
      const trackEl = el('rect', { x: f3(x), y: f3(y), width: f3(w), height: f3(h), rx: f3(r), fill: track, 'fill-opacity': trackOpacity }, host);
      const fillEl = el('rect', { x: f3(x), y: f3(y), width: f3(h), height: f3(h), rx: f3(r), fill }, host);
      const shineEl = el('rect', { x: f3(x), y: f3(y), width: f3(h), height: f3(h), rx: f3(r), fill: shineFill }, host);
      return {
        els: [trackEl, fillEl, shineEl],
        set: makeSet([{ e: trackEl }, { e: fillEl, op: (st) => st.opacity * (1 - 0.45 * (st.dim ?? 0)) }, { e: shineEl, noOp: true, on: (st) => !!st.shine }], {
          before: (st) => { if (st.fillW !== undefined) { setA(fillEl, { width: st.fillW }); setA(shineEl, { width: st.fillW }); } },
        }),
        fillRight: (fw) => x + fw,
        fillBox: (fw) => ({ x, y, w: fw, h }),
      };
    }
    const d = depth ?? 0.07 * h;
    const ins = inset ?? 0.13 * h;
    const hi = h - 2 * ins;
    const cream = !track;
    const T = cream ? CREAM : keyColors(track);
    const F = keyColors(fill);
    const sw = Math.max(1.5, 0.03 * h);
    const innerW = (fw) => Math.max(hi, ((Math.max(h, fw) - h) / Math.max(1, w - h)) * (w - 2 * ins - hi) + hi);
    const L = [];
    const add = (e, extra = {}) => { L.push({ e, ...extra }); return e; };
    const fillOp = (st) => st.opacity;
    add(el('ellipse', { cx: f3(x + w / 2), cy: f3(y + h + d * 0.6), rx: f3(0.53 * w), ry: f3(0.24 * h), fill: softUrl(cream ? CREAM.shadow : T.shadow, 0.3) }, host));
    add(el('rect', { ...rr(x, y + d + 1, w, h, h / 2), fill: cream ? CREAM.edge : darken(track, 0.45) }, host));
    add(el('rect', { ...rr(x, y + d, w, h, h / 2), fill: cream ? '#E7C5B4' : T.side[0] }, host));
    add(el('rect', { ...rr(x, y, w, h, h / 2), fill: cream ? linUrl('ptop', DEG175, [[0, '#FFFFFF'], [0.55, '#FFF6F1'], [1, '#F7E7DE']]) : linUrl('ktop', DEG160, [[0, T.top[0]], [0.48, T.top[1]], [1, T.top[2]]]) }, host));
    add(el('rect', { ...rr(x + sw / 2, y + sw / 2, w - sw, h - sw, h / 2 - sw / 2), fill: 'none', stroke: rimUrl(), 'stroke-width': f3(sw) }, host));
    // 凹槽：填充走的那条槽，上沿暗、下沿亮，看起来是压下去的
    const gi = ins * 0.55;
    add(el('rect', { ...rr(x + gi, y + gi, w - 2 * gi, h - 2 * gi, h / 2 - gi), fill: linUrl('groove', VERT, [[0, CREAM.groove, 0.24], [0.55, CREAM.groove, 0.08], [1, CREAM.groove, 0.03]]), stroke: linUrl('groovel', VERT, [[0, CREAM.groove, 0.22], [0.5, '#FFFFFF', 0], [1, '#FFFFFF', 0.95]]), 'stroke-width': f3(Math.max(1, 0.012 * h)) }, host));
    // 填充：竖向渐变的糖果面、上半截高光、白亮边（宽度每帧变）
    const fx = x + ins, fy = y + ins;
    const fFace = add(el('rect', { ...rr(fx, fy, hi, hi, hi / 2), fill: linUrl('fface', VERT, [[0, F.top[0]], [0.48, F.top[1]], [1, F.top[2]]]) }, host), { op: fillOp });
    const fGloss = add(el('rect', { ...rr(fx + 0.18 * hi, fy + 0.1 * hi, 0, 0.36 * hi, 0.18 * hi), fill: glossUrl() }, host), { op: fillOp });
    const fRim = add(el('rect', { ...rr(fx + sw / 2, fy + sw / 2, hi - sw, hi - sw, hi / 2 - sw / 2), fill: 'none', stroke: rimUrl(), 'stroke-width': f3(sw) }, host), { op: fillOp });
    const fDim = add(el('rect', { ...rr(fx, fy, hi, hi, hi / 2), fill: '#000000' }, host), { on: (st) => (st.dim ?? 0) > 0.01, op: (st) => st.opacity * 0.4 * (st.dim ?? 0) });
    const shineEl = add(el('rect', { ...rr(fx, fy, hi, hi, hi / 2), fill: shineFill }, host), { noOp: true, on: (st) => !!st.shine });
    return {
      els: L.map((l) => l.e),
      set: makeSet(L, {
        before: (st) => {
          if (st.fillW === undefined) return;
          const iw = innerW(st.fillW);
          for (const e of [fFace, fDim, shineEl]) setA(e, { width: iw });
          setA(fGloss, { width: Math.max(0, iw - 0.36 * hi) });
          setA(fRim, { width: Math.max(0, iw - sw) });
        },
      }),
      fillRight: (fw) => fx + innerW(fw),
      fillBox: (fw) => ({ x: fx, y: fy, w: innerW(fw), h: hi }),
      depth: d,
    };
  }

  function duelBar({ x, y, w, h, colorA, colorB, shadow, shineFill, depth, parent: par } = {}) {
    const host = par || host0;
    // 平面沿用 016 原来的裁切 id（一页只有一根）；糖果每根条自己一个 id，一页放几根也不撞
    const clipId = candy ? `${uid}-pt${partNo}-clip` : `${uid}-clip`;
    if (!candy) {
      // 原样：投影、裁切（放进风格的 defs）、裁切组里的 A、B 两段和高光
      const left = x, barY = y, barW = w, barH = h;
      const clip = el('clipPath', { id: clipId }, getDefs());
      const clipRect = el('rect', { x: left, y: barY, width: barW, height: barH, rx: barH / 2 }, clip);
      const back = el('rect', { x: left - 0.02 * barH, y: barY - 0.02 * barH + 0.06 * barH, width: barW + 0.04 * barH, height: barH, rx: barH / 2, fill: shadow, 'fill-opacity': 0.6 }, host);
      const g = el('g', { 'clip-path': `url(#${clipId})` }, host);
      const fillA = el('rect', { x: left, y: barY, width: barW / 2, height: barH, fill: colorA }, g);
      const fillB = el('rect', { x: x + w / 2, y: barY, width: barW / 2, height: barH, fill: colorB }, g);
      const shine = el('rect', { x: left, y: barY, width: barW / 2, height: barH, fill: shineFill }, g);
      return {
        els: [back, g, fillA, fillB, shine],
        clip,
        set: makeSet([
          { e: back }, { e: clipRect, noVis: true, noOp: true },
          { e: fillA, op: (st) => st.opacity * (1 - 0.4 * (st.dimA ?? 0)) },
          { e: fillB, op: (st) => st.opacity * (1 - 0.4 * (st.dimB ?? 0)) },
          { e: shine, noOp: true, on: (st) => !!st.shine },
        ], {
          before: (st) => {
            if (st.splitX === undefined) return;
            const s = st.splitX;
            setA(fillA, { width: s - left });
            setA(fillB, { x: s, width: left + barW - s });
            const winA = st.shineSide === 'A';
            setA(shine, { x: winA ? left : s, width: winA ? s - left : left + barW - s });
          },
        }),
      };
    }
    const d = depth ?? 0.09 * h;
    const sw = Math.max(1.5, 0.03 * h);
    const A = keyColors(colorA), B = keyColors(colorB);
    const L = [];
    const add = (e, extra = {}) => { L.push({ e, ...extra }); return e; };
    add(el('ellipse', { cx: f3(x + w / 2), cy: f3(y + h + d * 0.6), rx: f3(0.54 * w), ry: f3(0.26 * h), fill: softUrl(darken(colorA, 0.62), 0.32) }, host));
    // 侧壁：两种颜色在分界点硬切开（横向渐变，色标每帧挪）
    const sideId = `${uid}-pt${partNo}-side`;
    const side = lin(sideId, [x, 0, x + w, 0], [[0, A.side[1]], [0.5, A.side[1]], [0.5, B.side[1]], [1, B.side[1]]], { gradientUnits: 'userSpaceOnUse' });
    add(el('rect', { ...rr(x, y + d, w, h, h / 2), fill: side.url }, host));
    const clip = el('clipPath', { id: clipId }, getDefs());
    add(el('rect', { ...rr(x, y, w, h, h / 2) }, clip), { noVis: true, noOp: true }); // 裁切形状跟着条一起变换
    const g = el('g', { 'clip-path': `url(#${clipId})` }, host);
    const faceA = add(el('rect', { x: f3(x), y: f3(y), width: f3(w / 2), height: f3(h), fill: linUrl('fface', VERT, [[0, A.top[0]], [0.48, A.top[1]], [1, A.top[2]]]) }, g));
    const faceB = add(el('rect', { x: f3(x + w / 2), y: f3(y), width: f3(w / 2), height: f3(h), fill: linUrl('fface', VERT, [[0, B.top[0]], [0.48, B.top[1]], [1, B.top[2]]]) }, g));
    const dimA = add(el('rect', { x: f3(x), y: f3(y), width: f3(w / 2), height: f3(h), fill: '#000000' }, g), { on: (st) => (st.dimA ?? 0) > 0.01, op: (st) => st.opacity * 0.4 * (st.dimA ?? 0) });
    const dimB = add(el('rect', { x: f3(x + w / 2), y: f3(y), width: f3(w / 2), height: f3(h), fill: '#000000' }, g), { on: (st) => (st.dimB ?? 0) > 0.01, op: (st) => st.opacity * 0.4 * (st.dimB ?? 0) });
    const shine = add(el('rect', { x: f3(x), y: f3(y), width: f3(w / 2), height: f3(h), fill: shineFill }, g), { noOp: true, on: (st) => !!st.shine });
    add(el('rect', { ...rr(x + 0.14 * h, y + 0.07 * h, w - 0.28 * h, 0.38 * h, 0.19 * h), fill: glossUrl() }, host));
    add(el('rect', { ...rr(x + sw / 2, y + sw / 2, w - sw, h - sw, h / 2 - sw / 2), fill: 'none', stroke: rimUrl(), 'stroke-width': f3(sw) }, host));
    return {
      els: [...L.map((l) => l.e), g],
      clip,
      depth: d,
      set: makeSet(L, {
        before: (st) => {
          if (st.splitX === undefined) return;
          const s = st.splitX;
          const k = (s - x) / w;
          [[0, A.side[1]], [k, A.side[1]], [k, B.side[1]], [1, B.side[1]]].forEach(([o, c], i) => setA(side.stops[i], { offset: o, 'stop-color': c }));
          for (const e of [faceA, dimA]) setA(e, { width: s - x });
          for (const e of [faceB, dimB]) setA(e, { x: s, width: x + w - s });
          const winA = st.shineSide === 'A';
          setA(shine, { x: winA ? x : s, width: winA ? s - x : x + w - s });
        },
      }),
    };
  }

  return { material: candy ? 'candy' : 'flat', badge, key, slab, pillBar };
}
