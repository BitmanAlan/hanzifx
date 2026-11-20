// 012 对错判断（Right or Wrong）· 互动元素
// 一句说法放在卡片上：判错时一个大叉两笔砸下来，说法变暗并被一条线划掉；判对时一个大勾一笔画出来，说法变亮。默认透明底。
// 参数（见 meta.json）：text 说法、verdict（wrong / right）、look（V1 日常 / V3 招牌）、palette、rhythm（什么时候打）、font、
//   tag 标签章、card 卡片、size 字号、flair 招牌强度、particles 碎片或亮点、material 质感、hold、x、y、seed。
// 质感（material）：candy 亮面糖果（默认）＝卡片用底座的底座块零件（厚度、白亮边、上沿高光、渐变画的软影子），
//   标签章用徽章零件（白外圈、厚度、高光），大勾大叉每一笔多一道两头收尖的细高光；flat 平面＝原来的扁平卡片和描边章，这条代码路径没动过。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；透明度只设在单个图形上；
//   会转的东西不带模糊（投影用硬投影）；整个部件的震动加在每个元素自己的位移里，不挪整组。
import { hash01 } from '../../engine/src/lib/rand.js';
import { mix, hexToRgb } from '../../engine/src/lib/color.js';
import { clamp, lerp, spring, easeOutCubic, easeInCubic, easeOutBack } from '../../engine/src/lib/ease.js';
import { graphemes, atomize, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { shake, f3 } from '../../engine/src/motions/index.js';
import { createParts } from '../../engine/src/parts/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
const STRONG = new Set([...'。！？!?；;…']);
const WEAK = new Set([...'，、,：:']);

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');

/**
 * 量字：在 100px 下量，按字号归一。返回 { adv 占多宽, off 字身中心相对占位左边的位置 }。
 * 要挤的标点（见 squeezeAt）按墨迹挤窄：占位宽 = 墨迹宽加两边各 0.08，至少 0.5；字身往左挪，让墨迹的左边贴着占位的左边加 0.08。
 * 用固定量去挪不行：「，」的墨迹在字身左下角，挪多了会粘到前一个字上（开发时踩过）。
 */
const OPEN_P = new Set([...'（《「『【〔〈〖“‘']);
const CLOSE_P = new Set([...'，。、；：）》」』】〕〉〗”’']);
/** 要读的字只在三处挤（模板第 6 节）：行尾的收尾标点、行首的开引号开括号、两个标点连用。问号感叹号、句中单个的逗号句号都不挤 */
function squeezeAt(gs, i) {
  const ch = gs[i];
  if (CLOSE_P.has(ch)) return i === gs.length - 1 || FULLWIDTH_PUNCT.has(gs[i + 1]);
  if (OPEN_P.has(ch)) return i === 0 || FULLWIDTH_PUNCT.has(gs[i - 1]);
  return false;
}
function makeMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  g.font = `100px ${family}`;
  g.textAlign = 'center';
  const cache = new Map();
  return (ch, sq = false) => {
    const key = (sq ? '1' : '0') + ch;
    if (cache.has(key)) return cache.get(key);
    const m = g.measureText(ch);
    let r;
    if (sq) {
      const inkL = -m.actualBoundingBoxLeft / 100; const inkR = m.actualBoundingBoxRight / 100; // 相对字身中心
      const adv = Math.max(0.5, inkR - inkL + 0.16);
      r = { adv, off: 0.08 - inkL };
    } else {
      const adv = m.width / 100;
      r = { adv, off: adv / 2 };
    }
    cache.set(key, r);
    return r;
  };
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const family = ctx.fontFamily(P.font);
  const adv = makeMeasurer(family);
  const flair = clamp(P.flair ?? 0);
  const wrong = P.verdict !== 'right';
  const markColor = wrong ? K.accent : K.fill2;
  const useCard = P.card !== false && P.palette !== 'C4';
  const h = (...k) => hash01(seed, ...k);

  // ---------- 说法：最多两行，超过 9 个字按词分成两行，分得匀，优先断在标点后面 ----------
  const paragraphs = String(ctx.text || '').replace(/\r/g, '').split('\n').map((s) => s.trim());
  const lines = [];
  paragraphs.forEach((p, pi) => {
    if (!p) return;
    const atoms = atomize(p, { segment: ctx.segment }).map((a) => ({ text: a.text, index: a.index, n: graphemes(a.text).length }));
    const total = atoms.reduce((s, a) => s + a.n, 0);
    if (total <= 9 || atoms.length < 2 || lines.length >= 1) { lines.push({ text: p, index: 0, paragraph: pi }); return; }
    let best = null;
    let acc = 0;
    for (let k = 1; k < atoms.length; k++) {
      acc += atoms[k - 1].n;
      const last = graphemes(atoms[k - 1].text).at(-1);
      const cost = Math.abs(acc - (total - acc)) - (STRONG.has(last) ? 3 : WEAK.has(last) ? 2 : 0) + (atoms[k - 1].n === 1 && atoms[k].n === 1 ? 1 : 0);
      if (!best || cost < best.cost) best = { k, cost };
    }
    const a = atoms.slice(0, best.k).map((x) => x.text).join('');
    const b = atoms.slice(best.k).map((x) => x.text).join('');
    lines.push({ text: a, index: 0, paragraph: pi }, { text: b, index: a.length, paragraph: pi });
  });
  const hasText = lines.length > 0;

  // ---------- 版式 ----------
  const cx0 = (P.x ?? 0.5) * W;
  const cy = (P.y ?? (vertical ? 0.42 : 0.5)) * H;
  const lineEms = lines.map((l) => { const gs = graphemes(l.text); return gs.reduce((s, ch, i) => s + adv(ch, squeezeAt(gs, i)).adv, 0); });
  let fs = clamp(P.size ?? 0.085, 0.05, 0.14) * short;
  const maxW = (wrong ? 0.8 : 0.6) * W; // 判对时右边要留出勾的位置
  const maxEm = Math.max(1, ...lineEms);
  if (maxEm * fs > maxW) fs = maxW / maxEm; // 太长就缩
  const LH = 1.25;
  const textH = lines.length * fs * LH;
  const padX = 0.55 * fs; const padY = 0.42 * fs;
  const cardW = hasText ? maxEm * fs + 2 * padX : 0;
  const cardH = hasText ? textH + 2 * padY : 0;
  // 记号大小和位置：叉盖住整句话，跟卡片差不多宽；勾压在卡片右侧（像批作业），小一点，不挡说法
  let M = wrong ? clamp(Math.max(cardH * 1.6, cardW * 0.62, 0.3 * short), 0.3 * short, 0.52 * short)
    : clamp(Math.max(cardH * 1.15, 0.24 * short), 0.24 * short, 0.4 * short);
  // 勾放在卡片右边外侧，只压住卡片的边；整组往左挪，让卡片加勾一起居中
  const edge = 0.05 * short; // 离画面边缘至少留这么多
  let markX = wrong || !hasText ? 0 : cardW / 2 + 0.3 * M;
  const markY = wrong || !hasText ? 0 : -0.08 * M;
  let cx = cx0 + (wrong || !hasText ? 0 : -(0.3 * M + 0.45 * M) / 2);
  if (!wrong && hasText) {
    // 勾的右端（画到一半会放大一点，还有轻震）不能出画面：先把整组再往左挪，卡片左边也不能贴边；还不够就把勾缩小
    const rightOf = (m) => cx + cardW / 2 + 0.3 * m + 0.5 * m * 0.86 * 1.12 + 0.073 * m + 0.03 * m;
    const over = rightOf(M) - (W - edge);
    if (over > 0) cx -= Math.min(over, Math.max(0, cx - cardW / 2 - edge));
    for (let k = 0; k < 20 && rightOf(M) > W - edge && M > 0.12 * short; k++) M *= 0.95;
    markX = cardW / 2 + 0.3 * M;
  }
  const sw = 0.1 * M; // 记号的线宽
  // 每个字的位置
  const chars = [];
  lines.forEach((l, li) => {
    const gs = graphemes(l.text);
    let x = -lineEms[li] * fs / 2;
    const y = -textH / 2 + (li + 0.5) * fs * LH;
    gs.forEach((ch, ci) => {
      const a = adv(ch, squeezeAt(gs, ci));
      const w = a.adv * fs;
      const px = x + a.off * fs;
      chars.push({ ch, li, ci, x: px, y, k: chars.length });
      x += w;
    });
  });

  // ---------- 时间轴 ----------
  const markAt = R.markAt ?? 0.7;
  const introEnd = hasText ? Math.min(markAt, 0.18 + chars.length * 0.03 + 0.25) : 0.2;
  const strokeDur = 0.12; // 叉每一笔
  const checkDur = 0.36; // 勾一笔
  const markLand = wrong ? markAt + strokeDur + 0.1 : markAt + checkDur;
  const strikeAt = markAt + (wrong ? 0.22 : 0);
  const tagAt = markLand + 0.12;
  const hold = P.hold ?? 1.4;
  const outroStart = markLand + hold;
  const outDur = 0.3;
  const outroEnd = outroStart + outDur;
  const duration = outroEnd + 0.1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '说法出来', start: 0, end: introEnd },
      { name: 'mark', label: wrong ? '打叉' : '打勾', start: markAt, end: markLand },
      { name: 'hold', label: '停留', start: markLand, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...(wrong ? [{ t: markAt + strokeDur, name: 'stroke-1', label: '第一笔落下' }, { t: markAt + 0.1 + strokeDur, name: 'stroke-2', label: '第二笔落下' }] : [{ t: markLand, name: 'check', label: '勾画完' }]),
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: chars.map((c) => ({ i: c.k, char: c.ch, line: c.li, enter: 0.12 + c.k * 0.03, exitStart: outroStart, exitEnd: outroEnd })),
  };

  // ---------- 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-rw` : 'rw' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  const candy = P.material === 'candy';
  const kit = candy ? createParts(svg, { uid, material: 'candy', defs }) : null;
  // 卡片：一层硬投影＋卡片本身（糖果：底座块零件，画在原点，每帧整体挪、缩放）
  //   浅色卡片（白卡、黄卡）顶面只压暗 5%，侧壁用卡片色混一点强调色和深色、最底下一道深边线（不垫灰板，跟 010 一样）；深色卡片用默认的压暗侧壁
  const lightCard = (() => { const [r0, g0, b0] = hexToRgb(K.bg); return 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0 > 180; })();
  const cardSlab = candy && useCard && hasText ? kit.slab({
    x: -cardW / 2, y: -cardH / 2, w: cardW, h: cardH, radius: 0.3 * fs, color: K.bg, depth: 0.12 * fs,
    ...(lightCard ? { shade: 0.05, sideColors: [mix(K.bg, K.accent, 0.1), mix(mix(K.bg, K.accent, 0.14), K.outer, 0.12)], sideEdge: mix(mix(K.bg, K.accent, 0.2), K.outer, 0.38), sideEdgeWidth: Math.max(1.5, 0.02 * fs) } : {}),
  }) : null;
  const cardShadow = !candy && useCard && hasText ? el('rect', { x: f3(-cardW / 2), y: f3(-cardH / 2), width: f3(cardW), height: f3(cardH), rx: f3(0.3 * fs), fill: K.shadow, 'fill-opacity': 0.28 }, svg) : null;
  const card = !candy && useCard && hasText ? el('rect', { x: f3(-cardW / 2), y: f3(-cardH / 2), width: f3(cardW), height: f3(cardH), rx: f3(0.3 * fs), fill: K.bg }, svg) : null;
  // 说法：逐字；没卡片时字加描边
  const textAttrs = { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(fs) };
  const charReach = chars.reduce((m, c) => Math.max(m, Math.abs(c.x), Math.abs(c.y)), 0); // 离中心最远的字有多远
  const charNodes = chars.map((c) => {
    const g = el('g', {}, svg);
    const stroke = !useCard ? el('text', { ...textAttrs, x: 0, y: 0, fill: K.outer, stroke: K.outer, 'stroke-width': f3(0.16 * fs), 'stroke-linejoin': 'round' }, g) : null;
    const fill = el('text', { ...textAttrs, x: 0, y: 0, fill: K.fill }, g);
    if (stroke) stroke.textContent = c.ch;
    fill.textContent = c.ch;
    return { ...c, g, stroke, fill };
  });
  // 划掉的线（判错）：每行一条，从左往右划
  const strikes = wrong ? lines.map((l, li) => {
    const w = lineEms[li] * fs + 0.2 * fs;
    const y = -textH / 2 + (li + 0.5) * fs * LH;
    const e = el('line', { x1: f3(-w / 2), y1: 0, x2: f3(w / 2), y2: 0, stroke: K.accent, 'stroke-width': f3(0.09 * fs), 'stroke-linecap': 'round' }, svg);
    return { e, w, y, delay: li * 0.08 };
  }) : [];
  // 记号：底下一层描边（粗）＋上面一层颜色
  const half = M / 2;
  const paths = wrong
    ? [`M${f3(-half * 0.82)},${f3(-half * 0.82)} L${f3(half * 0.82)},${f3(half * 0.82)}`, `M${f3(half * 0.82)},${f3(-half * 0.82)} L${f3(-half * 0.82)},${f3(half * 0.82)}`]
    : [`M${f3(-half * 0.78)},${f3(half * 0.02)} L${f3(-half * 0.22)},${f3(half * 0.58)} L${f3(half * 0.86)},${f3(-half * 0.66)}`];
  // 每一笔的折线点（跟上面 paths 一样），糖果高光要沿着它往左上侧挪
  const markPts = wrong
    ? [[[-half * 0.82, -half * 0.82], [half * 0.82, half * 0.82]], [[half * 0.82, -half * 0.82], [-half * 0.82, half * 0.82]]]
    : [[[-half * 0.78, half * 0.02], [-half * 0.22, half * 0.58], [half * 0.86, -half * 0.66]]];
  // 高光：两条浅色细线叠在一起，窄的长、宽的短，中间亮、两头细，看起来两头收尖；
  // 线往笔画左上侧挪 0.2 个线宽（都在彩色笔画里面），每帧用 dashoffset 从离起点 a 处开始、按同一个进度画出来
  const strokeHighlight = (pts, g, len) => {
    // 法线朝左上：x+y 小的那一侧；正好 45° 斜线（「\」那一笔）两侧一样，取上面那一侧（光从左上来，先照到上沿）
    const norm = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; let nx = -dy / l, ny = dx / l; const k = nx + ny; if (k > 1e-9 || (Math.abs(k) <= 1e-9 && ny > 0)) { nx = -nx; ny = -ny; } return [nx, ny]; };
    const ns = pts.slice(1).map((q, j) => norm(q[0] - pts[j][0], q[1] - pts[j][1]));
    const off = 0.2 * sw;
    const shifted = pts.map((q, j) => {
      const a = ns[Math.max(0, j - 1)], b = ns[Math.min(ns.length - 1, j)];
      const [nx, ny] = norm(-(a[1] + b[1]), a[0] + b[0]); // 两段法线的平均方向（折角处）
      return [q[0] + nx * off, q[1] + ny * off];
    });
    const d = 'M' + shifted.map(([x, y]) => `${f3(x)},${f3(y)}`).join(' L');
    const color = mix(markColor, '#FFFFFF', 0.7);
    return [[0.13, 0.06, 0.6], [0.24, 0.18, 0.55]].map(([wk, ak, op]) => ({
      e: el('path', { d, fill: 'none', stroke: color, 'stroke-opacity': op, 'stroke-width': f3(wk * sw), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', visibility: 'hidden' }, g),
      a: ak * len,
    }));
  };
  const lens = wrong ? [Math.hypot(half * 1.64, half * 1.64), Math.hypot(half * 1.64, half * 1.64)] : [Math.hypot(half * 0.56, half * 0.56) + Math.hypot(half * 1.08, half * 1.24)];
  const marks = paths.map((d, i) => {
    const g = el('g', {}, svg);
    const out = el('path', { d, fill: 'none', stroke: K.outer, 'stroke-width': f3(sw * 1.45), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    const col = el('path', { d, fill: 'none', stroke: markColor, 'stroke-width': f3(sw), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    const sh = el('path', { d, fill: 'none', stroke: K.shadow, 'stroke-opacity': 0.3, 'stroke-width': f3(sw * 1.45), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', transform: `translate(${f3(0.03 * M)},${f3(0.04 * M)})` }, g);
    g.insertBefore(sh, out);
    // 糖果：每一笔加一道细高光（沿笔画左上侧、两头收尖），跟笔画同一个画出进度
    const hl = candy ? strokeHighlight(markPts[i], g, lens[i]) : [];
    return { g, parts: [sh, out, col], hl, len: lens[i], start: wrong ? markAt + i * 0.1 : markAt, dur: wrong ? strokeDur : checkDur };
  });
  // 冲击波（V3）
  const wave = flair > 0 ? el('circle', { cx: 0, cy: 0, r: f3(half * 0.9), fill: 'none', stroke: markColor, 'stroke-width': f3(0.04 * M) }, svg) : null;
  // 冲击波最大扩到多大：不碰画面边缘（勾在卡片右侧时离边近）
  const waveRoom = Math.min(cx + markX, W - (cx + markX), cy + markY, H - (cy + markY)) - 0.06 * short - 0.03 * M;
  const waveMax = clamp(waveRoom / (half * 0.9), 1.05, 1.6);
  // 标签章（V3）：歪着砸下来
  const tagText = String(P.tag || '').trim() || (wrong ? '谣言' : '真相');
  let stamp = null;
  if (flair > 0) {
    const tfs = 0.32 * M * Math.min(1, 2 / Math.max(1, graphemes(tagText).length));
    const tw = graphemes(tagText).length * tfs + 0.6 * tfs; const th = 1.35 * tfs;
    const g = el('g', {}, svg);
    const sx = (cardW ? cardW / 2 : half) * 0.78; const sy = -(cardH ? cardH / 2 : half) - 0.35 * th;
    if (candy) {
      // 糖果：徽章零件画进章的组里，跟着组显示、隐藏
      const badge = kit.badge({ cx: 0, cy: 0, w: tw, h: th, radius: 0.18 * tfs, color: markColor, text: tagText, textColor: K.inner, fontFamily: family, fontSize: tfs, baseline: 0.36, parent: g });
      stamp = { g, parts: [], badge, x: sx, y: sy, rot: -10 + (h('tagr') - 0.5) * 8 };
    } else {
      const box = el('rect', { x: f3(-tw / 2), y: f3(-th / 2), width: f3(tw), height: f3(th), rx: f3(0.18 * tfs), fill: markColor, stroke: K.outer, 'stroke-width': f3(0.08 * tfs) }, g);
      const tx = el('text', { ...textAttrs, 'font-size': f3(tfs), x: 0, y: 0, fill: K.inner }, g);
      tx.textContent = tagText;
      stamp = { g, parts: [box, tx], x: sx, y: sy, rot: -10 + (h('tagr') - 0.5) * 8 };
    }
  }
  // 碎片（判错）或亮点（判对）
  const nP = Math.round(P.particles ?? 0);
  const bits = [...Array(nP).keys()].map((i) => {
    const ang = (i / Math.max(1, nP)) * TAU + (h('pa', i) - 0.5) * 0.6;
    const size = lerp(0.04, 0.08, h('ps', i)) * M;
    // 最远飞到哪：不超出画面（留出边距、震动和碎片下落的余量），免得描边贴边被裁
    const ox = cx + markX; const oy = cy + markY;
    const margin = 0.06 * short + size + 0.03 * M;
    const room = (c, dir, lo, hi) => (dir > 1e-6 ? (hi - margin - c) / dir : dir < -1e-6 ? (lo + margin - c) / dir : Infinity);
    const ca = Math.cos(ang); const sa = Math.sin(ang);
    const maxD = Math.max(0.36 * M, Math.min(room(ox, ca, 0, W), room(oy, sa + (wrong ? 0.3 : 0), 0, H)));
    const dist = Math.min(lerp(0.55, 0.95, h('pd', i)) * M, maxD);
    const d = wrong
      ? `M0,${f3(-size)} L${f3(size * 0.8)},${f3(size * 0.6)} L${f3(-size * 0.7)},${f3(size * 0.5)} Z`
      : `M0,${f3(-size)} L${f3(size * 0.25)},${f3(-size * 0.25)} L${f3(size)},0 L${f3(size * 0.25)},${f3(size * 0.25)} L0,${f3(size)} L${f3(-size * 0.25)},${f3(size * 0.25)} L${f3(-size)},0 L${f3(-size * 0.25)},${f3(-size * 0.25)} Z`;
    const e = el('path', { d, fill: h('pc', i) < 0.6 ? markColor : K.inner, stroke: K.outer, 'stroke-width': f3(0.012 * M) }, svg);
    return { e, ang, dist, spin: (h('pr', i) - 0.5) * 540, delay: h('pt', i) * 0.05 };
  });

  // ---------- 每一帧 ----------
  function seek(time) {
    const t = clamp(time, 0, duration);
    // 震动：叉每一笔落下、勾画完时震一下（V1 很轻，V3 重），加在每个元素自己的位移里
    let sx = 0; let sy = 0;
    const amp = (wrong ? 0.03 : 0.015) * M * (0.35 + 0.65 * flair);
    for (const mk of marks) { const m = shake(t, { start: mk.start + mk.dur, amplitude: amp, duration: 0.18, freq: 26, seed: seed + Math.round(mk.start * 100), rotate: 0 }); sx += m.dx; sy += m.dy; }
    // 震动的尾巴不到 0.05 像素就当没动：几乎没动的那一两帧会让后面停住的画面随机出两种画法（ADR-001「逐帧一致的几类坑」，
    // 11-21 判对 V1 横屏透明底复现：震动最后两帧只挪 0.0002–0.04 像素，停留段勾的右上那一头两种结果）
    if (Math.abs(sx) < 0.05) sx = 0;
    if (Math.abs(sy) < 0.05) sy = 0;
    const X = cx + sx; const Y = cy + sy;
    const qOut = easeInCubic(clamp((t - outroStart) / outDur));
    const outS = 1 - qOut;
    // 卡片
    const cardIn = clamp(spring(t, { freq: 2.4, damping: 0.6 }));
    const cs = Math.max(cardIn * outS, 0.001);
    // 字的位置按 cardIn 从中心散开：弹簧的尾巴让离中心最远的字在第 29–36 帧只挪 0.001–0.02 像素，
    // 这种几乎没动的帧跟上面震动的尾巴一样，会让后面停住的画面随机出两种画法，所以不到 0.05 像素就当已经到位
    const charIn = (1 - cardIn) * charReach < 0.05 ? 1 : cardIn;
    for (const e of [cardShadow, card]) {
      if (!e) continue;
      vis(e, cs > 0.002);
      const off = e === cardShadow ? 0.06 * fs : 0;
      set(e, { transform: `translate(${f3(X + off)},${f3(Y + off)}) scale(${f3(cs)})`, opacity: f3(e === card ? (P.palette === 'C2' ? 0.94 : 0.96) : 1) });
    }
    // 糖果卡片不透明（半透明的话侧壁会从面底下透出来）
    if (cardSlab) cardSlab.set({ visible: cs > 0.002, transform: `translate(${f3(X)},${f3(Y)}) scale(${f3(cs)})` });
    // 说法逐字出来；判错以后变暗，判对以后变亮一下
    const dim = wrong ? clamp((t - strikeAt) / 0.25) : 0;
    const glowUp = wrong ? 0 : Math.sin(Math.PI * clamp((t - markLand + 0.1) / 0.5));
    for (const c of charNodes) {
      const u = (t - (0.12 + c.k * 0.03)) / 0.22;
      const on = u > 0 && outS > 0.002;
      vis(c.g, on);
      if (!on) continue;
      const e = easeOutBack(clamp(u));
      const s = lerp(0.6, 1, e) * (1 + 0.06 * glowUp) * outS;
      set(c.g, { transform: `translate(${f3(X + c.x * charIn)},${f3(Y + c.y * charIn)}) scale(${f3(Math.max(s, 0.001))})` });
      const op = clamp(u * 3);
      c.fill.setAttribute('fill', wrong ? mix(K.fill, K.sub, dim) : (glowUp > 0 ? mix(K.fill, K.fill2, 0.35 * glowUp) : K.fill));
      c.fill.setAttribute('opacity', f3(op));
      if (c.stroke) c.stroke.setAttribute('opacity', f3(op));
    }
    // 划掉的线
    for (const st of strikes) {
      const p = easeOutCubic(clamp((t - strikeAt - st.delay) / 0.18));
      vis(st.e, p > 0 && outS > 0.002);
      set(st.e, { transform: `translate(${f3(X)},${f3(Y + st.y)}) scale(${f3(Math.max(outS, 0.001))})`, 'stroke-dasharray': `${f3(st.w * p)} ${f3(st.w)}` });
    }
    // 记号：叉一笔一笔砸下来（从大往下按），勾一笔画出来
    for (const mk of marks) {
      const u = (t - mk.start) / mk.dur;
      const on = u > 0 && outS > 0.002;
      vis(mk.g, on);
      if (!on) continue;
      const p = clamp(u);
      const draw = wrong ? easeOutCubic(p) : easeOutCubic(p);
      const s0 = wrong ? lerp(1.35 + 0.25 * flair, 1, easeOutBack(clamp(u * 1.2))) : 1 + 0.06 * Math.sin(Math.PI * p) * (0.5 + flair);
      set(mk.g, { transform: `translate(${f3(X + markX)},${f3(Y + markY)}) scale(${f3(Math.max(s0 * outS, 0.001))})` });
      for (const part of mk.parts) part.setAttribute('stroke-dasharray', `${f3(mk.len * draw)} ${f3(mk.len * 2)}`);
      for (const hl of mk.hl) {
        // 画出来的长度扣掉起点那截 a，最多到离终点 a 处；太短就藏起来（长度 0 的圆头线会画出一个点）。显示写 inherit，跟着这一笔的组走
        const v = Math.min(mk.len * draw - hl.a, mk.len - 2 * hl.a);
        hl.e.setAttribute('visibility', v > 0.5 ? 'inherit' : 'hidden');
        set(hl.e, { 'stroke-dasharray': `${f3(Math.max(v, 0))} ${f3(mk.len * 2)}`, 'stroke-dashoffset': -hl.a });
      }
    }
    // 冲击波
    if (wave) {
      const u = (t - markLand + 0.05) / 0.5;
      const on = u > 0 && u < 1;
      vis(wave, on);
      if (on) set(wave, { transform: `translate(${f3(X + markX)},${f3(Y + markY)}) scale(${f3(1 + (waveMax - 1) * easeOutCubic(u))})`, opacity: f3((1 - u) * 0.8 * flair) });
    }
    // 标签章
    if (stamp) {
      const u = (t - tagAt) / 0.22;
      const on = u > 0 && outS > 0.002;
      vis(stamp.g, on);
      if (on) {
        const s = lerp(1.7, 1, easeOutBack(clamp(u))) * outS;
        set(stamp.g, { transform: `translate(${f3(X + stamp.x)},${f3(Y + stamp.y)}) rotate(${f3(stamp.rot)}) scale(${f3(Math.max(s, 0.001))})` });
        for (const part of stamp.parts) part.setAttribute('opacity', f3(clamp(u * 4)));
      }
      if (stamp.badge) stamp.badge.set({ visible: on ? 'inherit' : false, opacity: on ? clamp(u * 4) : 1 });
    }
    // 碎片和亮点
    for (const b of bits) {
      const u = (t - markLand - b.delay) / 0.6;
      const on = u > 0 && u < 1;
      vis(b.e, on);
      if (!on) continue;
      const d = lerp(0.35 * M, b.dist, easeOutCubic(u));
      set(b.e, { transform: `translate(${f3(X + markX + Math.cos(b.ang) * d)},${f3(Y + markY + Math.sin(b.ang) * d + (wrong ? 0.25 * M * u * u : 0))}) rotate(${f3(b.spin * u)}) scale(${f3(Math.max(1 - u * 0.7, 0.001))})`, opacity: f3(1 - u * 0.5) });
    }
  }

  const issues = hasText ? checkLineBreaks(lines, ctx.text, { segment: ctx.segment }) : [];
  const warnings = hasText ? icuBreakWarnings(lines, ctx.text) : [];
  seek(0);
  return {
    timeline,
    layout: { fontSize: fs, lines: lines.map((l) => l.text), forced: [], issues, warnings, segmentation: ctx.segmentation.sources, units: chars.length, markSize: M, verdict: wrong ? 'wrong' : 'right' },
    seek,
    destroy() { svg.remove(); },
  };
}
