// 测试用：四个新共用动作各占一块，看效果对不对
import { shineSweep, shineStops, countUp, wipe, wipeStops, inkSpread, f3 } from '../../engine/src/motions/index.js';
const NS = 'http://www.w3.org/2000/svg';
const el = (t, a, p) => { const e = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); if (p) p.appendChild(e); return e; };
export function create(root, ctx) {
  const { width: W, height: H, uid } = ctx; const ff = ctx.fontFamily(ctx.params.font); const fs = W * 0.1;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: 'position:absolute;left:0;top:0' });
  const defs = el('defs', {}, svg);
  const T = (y, txt, attrs = {}) => { const t = el('text', { x: W / 2, y, 'text-anchor': 'middle', 'font-size': fs, 'font-family': ff, fill: '#fff', stroke: '#2b1460', 'stroke-width': fs * 0.08, 'paint-order': 'stroke', ...attrs }, svg); t.textContent = txt; return t; };
  // 1 高光扫过
  T(H * 0.18, '高光扫过', { fill: '#ffb11c' });
  const sg = el('linearGradient', { id: `${uid}-sh`, gradientUnits: 'userSpaceOnUse', x1: W * 0.25, y1: 0, x2: W * 0.75, y2: H * 0.05 }, defs);
  const shine = T(H * 0.18, '高光扫过', { fill: `url(#${uid}-sh)`, stroke: 'none' });
  // 2 数字滚动
  const num = T(H * 0.38, '0', { fill: '#4df0ff' });
  T(H * 0.44, '粉丝', { 'font-size': fs * 0.5 });
  // 3 遮罩扫出（羽化）
  const wg = el('linearGradient', { id: `${uid}-wg`, gradientUnits: 'userSpaceOnUse', x1: W * 0.2, y1: 0, x2: W * 0.8, y2: 0 }, defs);
  const wm = el('mask', { id: `${uid}-wm`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
  el('rect', { x: 0, y: H * 0.5, width: W, height: H * 0.15, fill: `url(#${uid}-wg)` }, wm);
  T(H * 0.6, '遮罩扫出', { fill: '#ff62a6', mask: `url(#${uid}-wm)` });
  // 4 墨迹晕开（遮罩里画墨团，字只在墨到的地方露出来）
  const im = el('mask', { id: `${uid}-im`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
  const inkG = el('g', { fill: '#fff' }, im);
  T(H * 0.82, '墨迹晕开', { fill: '#111', stroke: 'none', 'font-size': fs * 1.1, mask: `url(#${uid}-im)` });
  const pts = [0.2, 0.4, 0.6, 0.8].map((x, i) => ({ x: W * x, y: H * 0.79 + (i % 2 ? -10 : 10) }));
  root.appendChild(svg);
  const setStops = (g, stops, color = '#fff') => { g.innerHTML = ''; for (const [o, a] of stops) el('stop', { offset: f3(o), 'stop-color': color, 'stop-opacity': f3(a) }, g); };
  const duration = 3;
  return {
    timeline: { duration, segments: [{ name: 'intro', label: '入场', start: 0, end: 1.5 }, { name: 'hold', label: '停留', start: 1.5, end: 2.5 }, { name: 'outro', label: '出场', start: 2.5, end: 3 }], beats: [], units: [] },
    layout: { fontSize: fs, lines: [], linesDetail: [], forced: [], issues: [], warnings: [], units: 0 },
    seek(t) {
      const s = shineSweep(t % 1.5, { start: 0.2, duration: 0.8 });
      setStops(sg, s.visible ? shineStops(s.u) : [[0, 0], [1, 0]]);
      num.textContent = countUp(t, { from: 0, to: 128000, start: 0, duration: 2, unit: '万' }).text;
      setStops(wg, wipeStops(wipe(t, { start: 0.3, duration: 1.2 })));
      inkG.innerHTML = '';
      for (const b of inkSpread(t, { seed: 5, points: pts, start: 0.2, duration: 1.4, maxR: W * 0.14 })) if (b.d) el('path', { d: b.d }, inkG);
    },
    destroy() { svg.remove(); },
  };
}
