// 017 拟声词爆炸字（Sound Burst）
//
// 风格契约（engine/docs/写一个新风格.md）：create(root, ctx) 只按参数和画面尺寸搭一次 SVG，
// 返回 { timeline, layout, seek(t), destroy() }；seek(t) 是纯函数，结果只取决于 t。
//
// 画面：一个拟声词就是「一爆」——
//   锯齿爆炸底框（带网点）＋ 立体字：字有黑色粗描边、白色内描边、上下两段色；厚度往一个消失点收，
//   字从前往后一个比一个大，整块歪着，看起来像从画面里冲出来（透视感全靠位置和等比缩放，不用斜切和非等比缩放）。
//   V3 招牌再加：外圈尖刺框、放射线、碎片、更狠的震屏（其他已经停住的爆也跟着震）。
// 一串拟声词依次砸：「哐！|咚！|啪！」用 | 分开；不写 | 时，感叹号、问号后面接着还有字就自动拆开。
//   pile 叠放（默认）：排在画面不同位置，前面的留着，最多同时留 3 个；swap 顶替：都砸在同一个位置，新的把旧的撞走。
// 时间：每一爆从字砸下来到震完、放射线和碎片落定约 0.5 秒；停留；最后一起收走。
//
// 逐帧一致的规矩（第 3 节）：
//   - 不给整组做透明度动画：这里没有任何透明度动画，出现和消失全靠缩放、位移和 visibility；
//   - 会转的东西不带模糊：底框投影、字的厚度都是不模糊的硬投影，全风格不用滤镜；
//   - 文字只做等比缩放；
//   - 从 0 放大的底框、尖刺框、碎片，缩放小于 0.2 时先隐藏；
//   - 震动、回弹的尾巴留死区：动的量不到 0.5 像素就直接取停住时的值；
//   - SVG 子元素要显示写 inherit，不写 visible。

import { hash01, stepNoise } from '../../engine/src/lib/rand.js';
import { mix } from '../../engine/src/lib/color.js';
import { clamp, lerp, easeOutCubic, easeInCubic, easeInOutCubic } from '../../engine/src/lib/ease.js';
import { graphemes, bestBreak, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const lumOf = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
const show = (e, on, top = false) => e.setAttribute('visibility', on ? (top ? 'visible' : 'inherit') : 'hidden');

// 收尾的标点：后面还有字，就在这里拆成下一爆
const SPLIT_AFTER = new Set([...'！？!?～~…。，、']);
const isPunct = (g) => FULLWIDTH_PUNCT.has(g) || /^[!?~.,…]$/.test(g);
const isSpace = (g) => /^\s+$/.test(g);

/** 死区：|x| 不到 eps 就当 0 */
const dz = (x, eps) => (Math.abs(x) < eps ? 0 : x);
/** 缩放的死区：离 1 不到 0.003 就当 1（缓动尾巴上「几乎没动的一帧」） */
const dz1 = (s) => (Math.abs(s - 1) < 0.003 ? 1 : s);

/** 多段缓动：keys = [[时刻, 值], …]，段内用 easeInOutCubic，超出两头取端点值。只看 τ，两头精确等于端点值 */
function keyed(tau, keys, ease = easeInOutCubic) {
  if (tau <= keys[0][0]) return keys[0][1];
  for (let k = 1; k < keys.length; k++) {
    if (tau <= keys[k][0]) {
      const [t0, v0] = keys[k - 1]; const [t1, v1] = keys[k];
      const e = typeof ease === 'function' ? ease : ease[k - 1];
      return v0 + (v1 - v0) * e((tau - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

/** 量字：canvas 量 100px 下的字宽和墨迹，返回以字号为单位的数据 */
function makeMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  g.font = `100px ${family}`;
  const cache = new Map();
  const ref = g.measureText('国');
  const asc = ref.fontBoundingBoxAscent / 100; const desc = ref.fontBoundingBoxDescent / 100;
  return {
    baseline: (asc - desc) / 2, // 字身中心到基线的距离：text 的 y 写这个，字的中心就在 0
    glyph(ch) {
      if (cache.has(ch)) return cache.get(ch);
      const m = g.measureText(ch);
      const inkL = -m.actualBoundingBoxLeft / 100; const inkR = m.actualBoundingBoxRight / 100;
      let box;
      if (isPunct(ch)) {
        // 标点按墨迹收紧：占位＝墨迹宽加两边各 0.1 个字，至少 0.42 个字；字身左移让墨迹居中
        const w = Math.max(inkR - inkL + 0.2, 0.42);
        box = { adv: w, ox: -(inkL + inkR) / 2, punct: true };
      } else {
        box = { adv: m.width / 100, ox: -m.width / 200, punct: false };
      }
      cache.set(ch, box);
      return box;
    },
  };
}

// 底框的基准曲线用超椭圆（指数 3.2）：比椭圆更贴字块的四个角，底框不用撑得很大就盖得住字
const SE = 3.2;
const seDir = (a) => { const c = Math.cos(a); const s = Math.sin(a); return [Math.sign(c) * Math.abs(c) ** (2 / SE), Math.sign(s) * Math.abs(s) ** (2 / SE)]; };
/** 超椭圆在方向 a 上的半径 */
const seR = (rx, ry, a) => (Math.abs(Math.cos(a) / rx) ** SE + Math.abs(Math.sin(a) / ry) ** SE) ** (-1 / SE);
/**
 * 锯齿星形：返回 [{a, k, e, ux, uy}]。顶点在 (ux · rx·k + cos a · e, uy · ry·k + sin a · e)：
 * (ux, uy) 是超椭圆上的方向，rx、ry 贴着字块，k 是倍数，e 是尖角往外再伸出去多少（字号的倍数）。
 * 尖角的长度用 e 写成绝对长度，字多、底框长的时候尖角不会跟着变得又长又大。尖角和凹口交替，角度和长短按种子抖
 */
function starShape(h, key, { n, spike, spikeVar, valleyK, valleyE, phase = 0 }) {
  const pts = [];
  for (let j = 0; j < 2 * n; j++) {
    const outer = j % 2 === 0;
    const a = phase + (j * Math.PI) / n + (h(key, 'a', j) - 0.5) * (Math.PI / n) * 0.6;
    const [ux, uy] = seDir(a);
    if (outer) pts.push({ a, ux, uy, k: 1, e: spike * (1 + (h(key, 'r', j) - 0.5) * 2 * spikeVar), outer });
    else pts.push({ a, ux, uy, k: valleyK * (1 + (h(key, 'v', j) - 0.5) * 0.06), e: valleyE, outer });
  }
  return pts;
}
/** 椭圆周长（Ramanujan 近似） */
const ellPerim = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm || {};
  const seed = P.seed;
  const h = (...k) => hash01(seed, ...k);
  const short = Math.min(W, H);
  const family = ctx.fontFamily(P.font);
  const M = makeMeasurer(family);
  const flair = clamp(P.flair ?? 0);
  const persp = clamp(P.persp ?? 0.6);
  const depth = clamp(P.depth ?? 0.6);
  const shakeAmt = clamp(P.shake ?? 0.6, 0, 1.5);
  const raysAmt = clamp(P.rays ?? 0.3);
  const nDebris = Math.max(0, Math.min(40, Math.round(P.debris ?? 0)));
  const boilAmt = clamp(P.boil ?? 0.5);
  const frameKind = P.frame || 'burst';
  const ringOn = !!P.ring && frameKind !== 'none';
  const halftone = P.halftone !== false && frameKind !== 'none';
  const swap = P.mode === 'swap';

  // 配色：全库统一的 8 个角色，这里要的几档从角色推
  const C = {
    light: mix(K.fill, '#FFFFFF', lumOf(K.fill) > 0.35 ? 0.45 : 0.16), fill: K.fill, low: K.fill2, deep: mix(K.fill2, K.shadow, 0.28),
    inner: K.inner, ink: K.outer,
    sideFront: K.shadow, sideBack: mix(K.shadow, K.outer, 0.55),
    plate: K.bg, plateShadow: K.outer, dots: K.sub,
    ring: K.accent, ringShadow: mix(K.accent, K.outer, 0.6),
    ray: K.accent, rayB: K.fill, debrisA: K.accent, debrisB: K.fill, debrisC: K.bg,
  };
  const E = { light: mix(K.accent, '#FFFFFF', 0.5), fill: mix(K.accent, '#FFFFFF', 0.12), low: K.accent, deep: mix(K.accent, K.outer, 0.25) };

  // ---------- 1. 拆成一爆一爆 ----------
  const rawParas = String(P.text ?? '').replace(/\r/g, '').split('\n');
  const paras = String(ctx.text).replace(/\r/g, '').split('\n').map((s) => s.trim());
  const bursts = [];
  paras.forEach((para, pi) => {
    if (!para) return;
    const words = ctx.segment(para);
    const bounds = new Set([0, para.length]);
    for (const w of words) { bounds.add(w.index); bounds.add(w.index + w.text.length); }
    const author = (rawParas[pi] || '').includes('|');
    let cuts = [0];
    if (author) {
      for (const w of words) if (w.index > 0) cuts.push(w.index);
    } else if (P.split !== 'none') {
      const gs = graphemes(para);
      let off = 0;
      for (let i = 0; i < gs.length; i++) {
        const g = gs[i]; const next = gs[i + 1];
        off += g.length;
        if (next === undefined) break;
        const endPunct = SPLIT_AFTER.has(g) && !SPLIT_AFTER.has(next) && !isSpace(next);
        const spaceEnd = isSpace(g) && !isSpace(next);
        if ((endPunct || spaceEnd) && bounds.has(off)) cuts.push(off);
      }
    }
    cuts = [...new Set(cuts)].sort((a, b) => a - b);
    cuts.push(para.length);
    for (let k = 0; k < cuts.length - 1; k++) {
      const text = para.slice(cuts[k], cuts[k + 1]);
      if (!text.trim()) continue;
      bursts.push({ text, paragraph: pi, start: cuts[k], words });
    }
  });
  const nB = bursts.length;

  // ---------- 2. 每一爆的排版（以字号为单位） ----------
  const tracking = -0.05; // 字距收紧，粗描边连成一块
  const RING_IN = 0.038; const RING_OUT = 0.075; // 白内描边、黑外描边的可见宽度（字号的倍数）
  const outerSW = 2 * (RING_IN + RING_OUT);
  const rimW = 0.035;
  const D = lerp(0.035, 0.075, depth); // 厚度：往消失点收多少
  const lineH = 1.08;
  const allLines = []; const forced = [];
  bursts.forEach((b, bi) => {
    // 断行：一爆一般一行，太长才断成两三行。分词用这一段的分词结果截出来的部分，跟检查用的同一套
    const local = b.words
      .filter((w) => w.index + w.text.length > b.start && w.index < b.start + b.text.length)
      .map((w) => {
        const a = Math.max(w.index, b.start); const z = Math.min(w.index + w.text.length, b.start + b.text.length);
        return { text: b.text.slice(a - b.start, z - b.start), index: a - b.start };
      });
    const trimmed = b.text.replace(/\s+$/, '');
    const widthOf = (s) => graphemes(s).reduce((acc, g) => acc + (isSpace(g) ? 0 : M.glyph(g).adv + tracking), 0);
    let lines = [{ text: trimmed, index: 0 }];
    // 一行太长就按词断成两三行（竖屏 3.4 个字宽、横屏 5 个字宽以上才断）；只在词边上断，断不开就留一行
    const maxLineEm = H > W ? 3.4 : 5;
    if (widthOf(trimmed) > maxLineEm) {
      const r = bestBreak(trimmed, (s) => widthOf(s), Math.max(maxLineEm, widthOf(trimmed) / 3 + 0.3), { maxLines: 3, segment: () => local, paragraph: b.paragraph });
      if (r && !(r.forced || []).length && r.lines.length > 1) lines = r.lines;
    }
    // 断行结果给检查用：行拼回去要等于原段落，所以末尾的空白也算进最后一行
    lines.forEach((l, li) => {
      const end = li + 1 < lines.length ? lines[li + 1].index : b.text.length;
      allLines.push({ text: b.text.slice(l.index, end), index: b.start + l.index, paragraph: b.paragraph });
    });
    // 每个字：大小（透视：越往后越大）、角度、上下错位
    // 歪的方向：单个往左歪（右边抬起来）；一串时一左一右交替
    b.lean = bi % 2 === 0 ? -1 : 1;
    b.tilt = (P.tilt ?? 0) > 0 ? (P.tilt * b.lean + (h('tilt', bi) - 0.5) * 6) : 0;
    const chars = [];
    lines.forEach((l, li) => {
      let off = b.start + l.index;
      for (const g of graphemes(l.text)) {
        if (!isSpace(g)) chars.push({ ch: g, line: li, offset: off, box: M.glyph(g), emph: ctx.isEmphasis(b.paragraph, off) });
        off += g.length;
      }
    });
    // 透视：字一个比一个大（越往后越近），标点也算在里面
    const m = chars.length;
    chars.forEach((c, i) => {
      const u = m > 1 ? i / (m - 1) : 0.5;
      let s = 1 + persp * 0.34 * (u - 0.5) + (h('sz', bi, i) - 0.5) * 0.06;
      if (c.box.punct) s *= 0.98;
      if (c.emph) s *= 1.12;
      c.s = s;
      c.rot = (h('rot', bi, i) - 0.5) * 2 * lerp(4, 9, persp) + (c.box.punct ? b.lean * 6 : 0);
      c.jy = (h('jy', bi, i) - 0.5) * 0.08;
    });
    // 逐行排：字身中心排成一行，行内居中，各行垂直居中
    const lineIds = [...new Set(chars.map((c) => c.line))];
    const nL = lineIds.length;
    lineIds.forEach((li, k) => {
      const cs = chars.filter((c) => c.line === li);
      const total = cs.reduce((acc, c) => acc + c.box.adv * c.s, 0) + tracking * (cs.length - 1);
      let cur = -total / 2;
      const maxS = Math.max(...cs.map((c) => c.s));
      cs.forEach((c) => {
        c.x = cur + (c.box.adv * c.s) / 2;
        cur += c.box.adv * c.s + tracking;
        c.y = (k - (nL - 1) / 2) * lineH * maxS + c.jy + (maxS - c.s) * 0.28; // 小的字往下沉一点，底边大致对齐
      });
    });
    // 整块居中（按字的外框，含描边）
    const ext = (c) => 0.5 * c.s + RING_IN + RING_OUT;
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
    for (const c of chars) {
      const e = ext(c);
      x0 = Math.min(x0, c.x - e); x1 = Math.max(x1, c.x + e); y0 = Math.min(y0, c.y - e); y1 = Math.max(y1, c.y + e);
    }
    const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
    for (const c of chars) { c.x -= mx; c.y -= my; }
    b.chars = chars;
    b.halfW = (x1 - x0) / 2; b.halfH = (y1 - y0) / 2;
    // 消失点：在字块下方偏后，厚度往那里收（左倾的往右下收，右倾的往左下收）
    b.vp = { x: -b.lean * lerp(1.2, 2.6, persp), y: lerp(4.2, 3.2, persp) };
    // 底框：超椭圆的半径按字块定，凹口大约贴着字块的边，尖角伸出去；字的四个角可以压出底框一点（漫画里常这么画）
    let rx = b.halfW * 1.04 + 0.08; let ry = b.halfH * 1.1 + 0.08;
    ry = Math.max(ry, 0.42 * rx); rx = Math.max(rx, 0.95 * ry);
    b.rx = rx; b.ry = ry;
    const spiky = frameKind === 'spiky';
    const per = ellPerim(rx, ry);
    b.plate = starShape(h, `plate${bi}`, spiky
      ? { n: Math.round(clamp(per / 0.5, 14, 30)), spike: 0.42, spikeVar: 0.35, valleyK: 0.97, valleyE: 0.02, phase: h('ph', bi) * TAU }
      : { n: Math.round(clamp(per / 0.68 + h('pn', bi) * 2, 10, 24)), spike: 0.3, spikeVar: 0.4, valleyK: 0.97, valleyE: 0.03, phase: h('ph', bi) * TAU });
    b.ring = starShape(h, `ring${bi}`, { n: Math.round(clamp(per / 0.95 + h('rn', bi) * 2, 8, 18)), spike: 0.58, spikeVar: 0.4, valleyK: 1, valleyE: 0.14, phase: h('rph', bi) * TAU });
  });

  // ---------- 3. 位置和字号：每一爆放进自己的位置，整块（含尖角、投影、回弹、震动）不出画面 ----------
  const vertical = H > W; const square = W === H;
  const nSlots = swap ? 1 : Math.min(3, Math.max(1, nB));
  const SLOTS = vertical
    ? [[[0.5, 0.42]], [[0.42, 0.32], [0.58, 0.52]], [[0.37, 0.25], [0.64, 0.42], [0.4, 0.59]]]
    : square
      ? [[[0.5, 0.5]], [[0.37, 0.38], [0.63, 0.62]], [[0.32, 0.3], [0.68, 0.5], [0.38, 0.72]]]
      : [[[0.5, 0.48]], [[0.34, 0.43], [0.66, 0.57]], [[0.21, 0.42], [0.5, 0.6], [0.79, 0.42]]];
  // 叠放时一个比一个大一点（越砸越狠）
  const ESC = [[1], [0.92, 1.08], [0.88, 1, 1.12]];
  const slotsN = SLOTS[nSlots - 1];
  const defY = slotsN.reduce((a, s) => a + s[1], 0) / nSlots;
  const offX = P.x == null ? 0 : P.x - 0.5; const offY = P.y == null ? 0 : P.y - defY;
  const margin = 0.03 * short + 3;
  const shakeEm = 0.075 * shakeAmt * (1 + 0.5 * flair); // 震动最大位移（字号的倍数）
  const shakeRot = 3 * shakeAmt * (1 + 0.5 * flair); // 震动最大角度
  const dSlot = nSlots > 1 ? [Math.abs(slotsN[1][0] - slotsN[0][0]) * W, Math.abs(slotsN[1][1] - slotsN[0][1]) * H] : [Infinity, Infinity];
  const slotSpacing = vertical ? dSlot[1] : square ? Math.hypot(dSlot[0], dSlot[1]) : dSlot[0];
  bursts.forEach((b, bi) => {
    // 整块的外形点（以字号为单位，绕爆的中心）：底框尖角（回弹冲过头 12%、抖边 4%）、底框投影、尖刺框、字和厚度
    const pts = [];
    const add = (x, y, pad) => pts.push([x, y, pad]);
    if (frameKind !== 'none') {
      const k = 1.12 * 1.04;
      const sh = { x: (b.vp.x) * 0.032, y: b.vp.y * 0.032 };
      for (const p of b.plate) {
        const x = (p.ux * b.rx * p.k + Math.cos(p.a) * p.e) * k; const y = (p.uy * b.ry * p.k + Math.sin(p.a) * p.e) * k;
        add(x, y, 0.05); add(x + sh.x * k, y + sh.y * k, 0.05);
      }
      if (ringOn) for (const p of b.ring) add((p.ux * b.rx * p.k + Math.cos(p.a) * p.e) * 1.16 * 1.04, (p.uy * b.ry * p.k + Math.sin(p.a) * p.e) * 1.16 * 1.04, 0.05);
    }
    for (const c of b.chars) {
      const e = 0.5 * c.s * 1.06 + RING_IN + RING_OUT + rimW;
      const bx = b.vp.x + (c.x - b.vp.x) * (1 - D); const by = b.vp.y + (c.y - b.vp.y) * (1 - D);
      for (const [x, y] of [[c.x, c.y], [bx, by]]) for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add(x + dx * e, y + dy * e, 0);
    }
    let bx0 = Infinity; let bx1 = -Infinity; let by0 = Infinity; let by1 = -Infinity;
    for (const dth of [-shakeRot - 1, 0, shakeRot + 1]) {
      const th = (b.tilt + dth) * DEG; const cs = Math.cos(th); const sn = Math.sin(th);
      for (const [x, y, pad] of pts) {
        const X = x * cs - y * sn; const Y = x * sn + y * cs;
        bx0 = Math.min(bx0, X - pad); bx1 = Math.max(bx1, X + pad); by0 = Math.min(by0, Y - pad); by1 = Math.max(by1, Y + pad);
      }
    }
    bx0 -= shakeEm; by0 -= shakeEm; bx1 += shakeEm; by1 += shakeEm;
    const esc = swap ? 1 : ESC[nSlots - 1][bi % nSlots];
    let fs = (P.size ?? 0.36) * short;
    // 叠放时：沿排列方向，一爆的尺寸约是两个位置间距的 2.15 倍（竖屏）、1.55 倍（横屏）——底框压住一点，字都露在外面
    if (!swap && nSlots > 1) {
      const along = vertical ? by1 - by0 : square ? Math.max(bx1 - bx0, by1 - by0) : bx1 - bx0;
      fs = Math.min(fs, (slotSpacing * (vertical ? 2.15 : 1.55)) / along);
    }
    fs = Math.min(fs * esc, (W - 2 * margin) / (bx1 - bx0), (H - 2 * margin) / (by1 - by0));
    b.fs = fs;
    const slot = slotsN[swap ? 0 : bi % nSlots];
    let cx = (slot[0] + offX) * W; let cy = (slot[1] + offY) * H;
    if (swap && nB > 1) { cx += (h('sx', bi) - 0.5) * 0.06 * short; cy += (h('sy', bi) - 0.5) * 0.05 * short; }
    cx = clamp(cx, margin - bx0 * fs, W - margin - bx1 * fs);
    cy = clamp(cy, margin - by0 * fs, H - margin - by1 * fs);
    b.cx = cx; b.cy = cy;
    // 字砸下来时从多大开始：不超过 2.3 倍（V1 1.7 倍），也不能大到出画面
    const rText = Math.max(...b.chars.map((c) => Math.hypot(c.x, c.y) + 0.5 * c.s + RING_IN + RING_OUT + 0.25));
    const room = Math.min(cx - margin, W - margin - cx, cy - margin, H - margin - cy);
    b.s0 = Math.max(1.12, Math.min(lerp(1.7, 2.3, flair), (room - 0.1 * fs) / (rText * fs)));
    // 砸下来时还从上方落下一段（竖屏左右放不下大倍数时，靠这一段落差撑出重量）：最多 0.6 字号，不出画面
    b.dropPx = clamp(cy - margin - rText * fs * b.s0 - 0.05 * fs, 0, lerp(0.45, 0.6, flair) * fs);
  });

  // ---------- 4. 时间轴 ----------
  const gap = P.gap ?? R.gap ?? 0.42;
  const holdDur = P.hold ?? R.hold ?? 1.1;
  const lead = 0.12; // 字从开始砸到落地
  const beats = (ctx.beats || []).filter((x) => x >= lead + 0.02);
  const impacts = [];
  // 砸在同一个位置的两爆至少隔 0.5 秒（顶替模式每一爆、叠放模式隔三爆）：同一块地方连着砸，快了就是来回闪，过不了闪烁检查
  const minGap = (k) => (swap ? 0.5 : k >= 3 && impacts[k - 3] != null ? Math.max(0.12, 0.5 - (impacts[k - 1] - impacts[k - 3])) : 0.12);
  for (let k = 0; k < nB; k++) {
    let tk = k < beats.length ? beats[k] : k === 0 ? lead + 0.06 : impacts[k - 1] + gap;
    if (k > 0) tk = Math.max(tk, impacts[k - 1] + minGap(k));
    impacts.push(tk);
  }
  bursts.forEach((b, k) => { b.tI = impacts[k]; b.t0 = b.tI - lead; });
  const tLast = nB ? impacts[nB - 1] : 0;
  const settle = 0.62;
  const introEnd = tLast + 0.38;
  const outroStart = tLast + Math.max(settle, holdDur);
  const outDur = 0.26;
  const outroEnd = outroStart + outDur + (swap ? 0 : 0.03 * (Math.min(nB, 3) - 1));
  const duration = outroEnd + 0.12;
  // 出场：叠放时第 k 爆被第 k+3 爆撞走；顶替时被下一爆撞走；剩下的最后一起收走。
  // 被撞走的：字在新字砸下来的 0.12 秒里缩没；底框和尖刺框留着，等新底框弹出来盖住以后直接撤掉
  //（不做缩小动画：同一块地方底框一会儿亮一会儿暗，连击时会变成来回闪，闪烁检查过不了）
  bursts.forEach((b, k) => {
    const knock = swap ? bursts[k + 1] : bursts[k + 3];
    b.knocked = !!knock;
    if (knock) {
      b.tOut = knock.tI + 0.07; b.outDur = 0.001;
      b.tTextOut = knock.t0; b.textOutDur = 0.12;
    } else {
      b.tOut = outroStart + (nB - 1 - k) * 0.03 * (swap ? 0 : 1); b.outDur = outDur;
    }
  });
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '砸入', start: 0, end: introEnd },
      { name: 'hold', label: '停住', start: introEnd, end: outroStart },
      { name: 'outro', label: '收走', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...bursts.map((b, k) => ({ t: b.tI, name: 'impact', unit: k, label: `「${b.text.trim()}」砸下` })),
      { t: outroStart, name: 'exit', label: '开始收走' },
    ],
    units: bursts.map((b, k) => ({ i: k, text: b.text.trim(), enter: b.t0, land: b.tI, exitStart: b.tOut, exitEnd: b.tOut + b.outDur })),
  };

  // ---------- 5. 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-sb` : 'sb' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: 'position:absolute;left:0;top:0;overflow:visible', 'data-hanzifx-style': 'sound-burst' });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  const gRays = el('g', { 'data-layer': 'rays' }, svg);
  // 尖刺框单独一层，压在所有底框下面：叠放时后来的尖刺框不会盖住前面的字
  const gRings = el('g', { 'data-layer': 'rings' }, svg);
  const gMain = el('g', { 'data-layer': 'plates' }, svg);
  // 字单独一层，压在所有底框上面：叠放时后来的底框不会盖住前面的字
  const gTexts = el('g', { 'data-layer': 'texts' }, svg);
  const gDebris = el('g', { 'data-layer': 'debris' }, svg);

  // 底框路径（像素）：停住以后每秒抖 6 次，尖角长短 ±3%（boil=1、V3 时 ±4.5%）
  const starPath = (pts, b, fs, boilT, key) => pts.map((p, j) => {
    const boil = boilT == null ? 1 : 1 + (stepNoise(seed, boilT, 6, key, j) - 0.5) * 0.06 * boilAmt * (1 + 0.5 * flair);
    const x = (p.ux * b.rx * p.k + Math.cos(p.a) * p.e) * fs * boil; const y = (p.uy * b.ry * p.k + Math.sin(p.a) * p.e) * fs * boil;
    return `${j ? 'L' : 'M'}${f3(x)},${f3(y)}`;
  }).join('') + 'Z';

  const textAttrs = (fs) => ({ 'font-family': family, 'font-size': f3(fs), 'text-anchor': 'start', 'stroke-linejoin': 'round', 'text-rendering': 'geometricPrecision' });
  const B = bursts.map((b, bi) => {
    const fs = b.fs;
    const g = el('g', { 'data-burst': bi }, gMain);
    const o = { b, g, fs };
    // 底框（投影 → 尖刺框 → 底板 → 网点 → 墨线）
    if (frameKind !== 'none') {
      o.gPlate = el('g', {}, g);
      const shOff = { x: b.vp.x * 0.032 * fs, y: b.vp.y * 0.032 * fs };
      o.shOff = shOff;
      const inkW = 0.06 * fs;
      if (ringOn) {
        o.gRingWrap = el('g', {}, gRings);
        o.gRing = el('g', {}, o.gRingWrap);
        o.ringSh = el('path', { fill: C.ringShadow, stroke: C.ringShadow, 'stroke-width': f3(inkW), 'stroke-linejoin': 'miter', 'stroke-miterlimit': 8, transform: `translate(${f3(shOff.x)},${f3(shOff.y)})` }, o.gRing);
        o.ringP = el('path', { fill: C.ring, stroke: C.ink, 'stroke-width': f3(inkW), 'stroke-linejoin': 'miter', 'stroke-miterlimit': 8, 'paint-order': 'stroke' }, o.gRing);
      }
      o.plateSh = el('path', { fill: C.plateShadow, stroke: C.plateShadow, 'stroke-width': f3(inkW), 'stroke-linejoin': 'miter', 'stroke-miterlimit': 8, transform: `translate(${f3(shOff.x)},${f3(shOff.y)})` }, o.gPlate);
      o.plateP = el('path', { fill: C.plate, stroke: 'none' }, o.gPlate);
      if (halftone) {
        const clip = el('clipPath', { id: `${uid}-clip${bi}` }, defs);
        o.clipP = el('path', {}, clip);
        // 网点：45° 方格，左上亮、右下暗（点越来越大），像印刷的网点
        const sp = Math.max(9, 0.072 * fs);
        const RX = (b.rx + 0.3) * fs; const RY = (b.ry + 0.3) * fs;
        let d = '';
        const span = Math.ceil((Math.max(RX, RY) * 1.1) / sp);
        for (let i = -span * 2; i <= span * 2; i++) {
          for (let j = -span * 2; j <= span * 2; j++) {
            const x = (i - j) * sp * Math.SQRT1_2; const y = (i + j) * sp * Math.SQRT1_2;
            const ex = x / RX; const ey = y / RY;
            if (Math.abs(ex) ** SE + Math.abs(ey) ** SE > 1.05) continue;
            const lx = (ex * 0.62 + ey * 0.78); // 往右下越暗
            const radial = Math.hypot(ex, ey);
            const shade = clamp(0.5 * lx + 0.55 * radial - 0.08);
            const r = 0.5 * sp * 0.92 * Math.pow(shade, 0.85);
            if (r < 0.9) continue;
            d += `M${f3(x - r)},${f3(y)}a${f3(r)},${f3(r)} 0 1,0 ${f3(2 * r)},0a${f3(r)},${f3(r)} 0 1,0 ${f3(-2 * r)},0`;
          }
        }
        const gh = el('g', { 'clip-path': `url(#${uid}-clip${bi})` }, o.gPlate);
        el('path', { d, fill: C.dots }, gh);
      }
      o.plateInk = el('path', { fill: 'none', stroke: C.ink, 'stroke-width': f3(inkW), 'stroke-linejoin': 'miter', 'stroke-miterlimit': 8 }, o.gPlate);
    }
    // 字：渐变（上下两段色，中间硬分界）
    const mkGrad = (id, c) => {
      const gr = el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, y1: f3(-0.48 * fs), x2: 0, y2: f3(0.44 * fs) }, defs);
      [[0, c.light], [0.42, c.fill], [0.5, c.low], [1, c.deep]].forEach(([of, col]) => el('stop', { offset: of, 'stop-color': col }, gr));
    };
    mkGrad(`${uid}-f${bi}`, C);
    if (b.chars.some((c) => c.emph)) mkGrad(`${uid}-e${bi}`, E);
    o.gT = el('g', {}, gTexts);
    const gText = el('g', {}, o.gT);
    const steps = Math.round(lerp(5, 10, depth));
    const layerDefs = [];
    // 厚度外的墨线：隔一层画一圈黑边，整块厚度外面都有黑边
    for (let j = steps; j >= 1; j -= 2) layerDefs.push({ key: `rim${j}`, a: (D * j) / steps, fill: C.ink, stroke: C.ink, sw: (outerSW + 2 * rimW) * fs });
    for (let j = steps; j >= 1; j--) {
      const col = mix(C.sideFront, C.sideBack, (j - 1) / Math.max(1, steps - 1));
      layerDefs.push({ key: `ex${j}`, a: (D * j) / steps, fill: col, stroke: col, sw: outerSW * fs });
    }
    layerDefs.push({ key: 'outer', a: 0, fill: C.ink, stroke: C.ink, sw: outerSW * fs });
    layerDefs.push({ key: 'inner', a: 0, fill: C.inner, stroke: C.inner, sw: 2 * RING_IN * fs });
    layerDefs.push({ key: 'fill', a: 0, fill: (c) => (c.emph ? `url(#${uid}-e${bi})` : `url(#${uid}-f${bi})`), stroke: 'none', sw: 0 });
    // 高光：字形减去往右下错一点的字形，剩下左上的一道月牙涂白（遮罩，不用模糊）
    b.chars.forEach((c, i) => {
      const m = el('mask', { id: `${uid}-m${bi}-${i}`, maskUnits: 'userSpaceOnUse', x: f3(-2 * fs), y: f3(-2 * fs), width: f3(4 * fs), height: f3(4 * fs) }, defs);
      const a = el('text', { ...textAttrs(fs), x: f3(c.box.ox * fs), y: f3(M.baseline * fs), fill: '#FFFFFF' }, m); a.textContent = c.ch;
      const z = el('text', { ...textAttrs(fs), x: f3(c.box.ox * fs + 0.03 * fs), y: f3(M.baseline * fs + 0.045 * fs), fill: '#000000' }, m); z.textContent = c.ch;
    });
    layerDefs.push({ key: 'shine', a: 0, fill: '#FFFFFF', stroke: 'none', sw: 0, opacity: 0.75, mask: (c, i) => `url(#${uid}-m${bi}-${i})` });
    const val = (x, c, i) => (typeof x === 'function' ? x(c, i) : x);
    o.layers = layerDefs.map((L) => {
      const lg = el('g', { 'data-layer': L.key }, gText);
      const nodes = b.chars.map((c, i) => {
        const t = el('text', {
          ...textAttrs(fs), x: f3(c.box.ox * fs), y: f3(M.baseline * fs),
          fill: val(L.fill, c, i), stroke: val(L.stroke, c, i), 'stroke-width': f3(L.sw),
          ...(L.mask ? { mask: val(L.mask, c, i) } : {}), ...(L.opacity != null ? { opacity: L.opacity } : {}),
        }, lg);
        t.textContent = c.ch;
        return t;
      });
      return { ...L, nodes };
    });
    return o;
  });

  // 放射线：从底框边缘往外冲的楔形，头粗尾尖；长度按到画面边的距离收住
  // 竖屏时放射线和碎片的下边界收在底部 20%（平台文案区，经验值）上面
  const floorY = vertical ? Math.max(H * 0.8, Math.max(...bursts.map((b) => b.cy)) + 0.1 * short) : H - margin;
  const rayLen = (x, y, a) => {
    const c = Math.cos(a); const s = Math.sin(a);
    let tMax = Infinity;
    if (c > 1e-6) tMax = Math.min(tMax, (W - margin - x) / c); else if (c < -1e-6) tMax = Math.min(tMax, (margin - x) / c);
    if (s > 1e-6) tMax = Math.min(tMax, (floorY - y) / s); else if (s < -1e-6) tMax = Math.min(tMax, (margin - y) / s);
    return tMax;
  };
  const RAYS = [];
  if (raysAmt > 0) {
    bursts.forEach((b, bi) => {
      const fs = b.fs;
      const nR = Math.round(lerp(11, 30, flair));
      const shakePx = shakeEm * fs;
      for (let k = 0; k < nR; k++) {
        const a = (k / nR) * TAU + (h('ra', bi, k) - 0.5) * (TAU / nR) * 0.7;
        // 底框在这个方向上的半径（屏幕方向，扣掉整块的倾斜）
        const la = a - b.tilt * DEG;
        const rEll = seR(b.rx * fs, b.ry * fs, la);
        const r0 = frameKind === 'none' ? rEll * 0.8 : rEll + 0.12 * fs;
        const lim = rayLen(b.cx, b.cy, a) - shakePx - 0.03 * fs;
        // V3 冲到画面边上（长短交错），V1 只是贴着底框的一圈短线
        const want = flair > 0.5 ? r0 + lerp(1.2, 3.4, h('rl', bi, k) ** 0.7) * fs * raysAmt : r0 + lerp(0.5, 0.85, h('rl', bi, k)) * fs * (0.4 + raysAmt);
        const r1 = Math.min(want, lim);
        if (r1 - r0 < 0.12 * fs) continue;
        const w = lerp(0.05, 0.12, h('rw', bi, k)) * fs * (flair > 0.5 ? 1 : 0.75);
        const rc = h('rc', bi, k);
        const node = el('path', { fill: rc < 0.34 ? C.ink : rc < 0.72 || flair < 0.5 ? C.ray : C.rayB, stroke: C.ink, 'stroke-width': f3(0.016 * fs), 'stroke-linejoin': 'round' }, gRays);
        RAYS.push({ bi, node, a, r0, r1, w, delay: h('rd', bi, k) * 0.05 });
      }
    });
  }
  // 碎片：底框边上迸出来的不规则小块，带黑边，飞出去、转、往下掉，最后缩没
  const DEB = [];
  if (nDebris > 0) {
    bursts.forEach((b, bi) => {
      const fs = b.fs;
      for (let k = 0; k < nDebris; k++) {
        const a = -Math.PI / 2 + (h('da', bi, k) - 0.5) * TAU * 0.95;
        const la = a - b.tilt * DEG;
        const rEll = seR(b.rx * fs, b.ry * fs, la);
        const size = lerp(0.06, 0.17, h('ds', bi, k) ** 1.3) * fs;
        const nv = 4 + Math.floor(h('dn', bi, k) * 3);
        let d = '';
        for (let v = 0; v < nv; v++) {
          const aa = (v / nv) * TAU + (h('dv', bi, k, v) - 0.5) * 0.9;
          const rr = size * lerp(0.55, 1.1, h('dr', bi, k, v));
          d += `${v ? 'L' : 'M'}${f3(Math.cos(aa) * rr)},${f3(Math.sin(aa) * rr)}`;
        }
        d += 'Z';
        const kind = h('dk', bi, k);
        const fill = kind < 0.45 ? C.debrisA : kind < 0.8 ? C.debrisB : C.debrisC;
        const node = el('path', { d, fill, stroke: C.ink, 'stroke-width': f3(0.02 * fs), 'stroke-linejoin': 'round' }, gDebris);
        const r0 = rEll + 0.1 * fs;
        const sx = b.cx + Math.cos(a) * r0; const sy = b.cy + Math.sin(a) * r0;
        let dist = lerp(0.6, 1.7, h('dd', bi, k)) * fs * (0.6 + 0.4 * flair);
        let drop = lerp(0.2, 0.6, h('dg', bi, k)) * fs;
        // 整条轨迹（含往下掉）都要在画面里，放不下就缩短
        const pad = size * 1.2 + 0.02 * fs + 2;
        // 飞的距离和往下掉的高度一起缩，缩到整条轨迹都在画面里为止；实在放不下就不要这一块
        let fits = false;
        for (let it = 0; it < 14 && !fits; it++) {
          fits = true;
          for (let q = 0; q <= 10; q++) {
            const u = q / 10;
            const x = sx + Math.cos(a) * dist * easeOutCubic(u); const y = sy + Math.sin(a) * dist * easeOutCubic(u) + drop * u * u;
            if (x < margin + pad || x > W - margin - pad || y < margin + pad || y > floorY - pad) { fits = false; break; }
          }
          if (!fits) { dist *= 0.82; drop *= 0.82; }
        }
        if (!fits) { node.remove(); continue; }
        DEB.push({ bi, node, a, sx, sy, dist, drop, spin: (h('dsp', bi, k) - 0.5) * 900, delay: h('dl', bi, k) * 0.04, dur: lerp(0.5, 0.75, h('du', bi, k)) });
      }
    });
  }

  // ---------- 6. 每一帧 ----------
  // 震动：每一爆落地时自己猛震，V3 时别的爆也跟着震（一半）。动的量不到 0.5 像素就当没动（死区）
  const shakeOf = (t, tI, ampPx, rotDeg, key) => {
    const tau = t - tI; const dur = 0.34;
    if (tau < 0 || tau > dur || ampPx <= 0) return { dx: 0, dy: 0, rot: 0 };
    const env = Math.pow(1 - tau / dur, 2);
    if (ampPx * env < 0.5) return { dx: 0, dy: 0, rot: 0 };
    const freq = 15;
    const kk = Math.floor(tau * freq); const f = tau * freq - kk;
    const n = (axis) => {
      const a = hash01(seed, key, axis, kk) * 2 - 1; const z = hash01(seed, key, axis, kk + 1) * 2 - 1;
      return a + (z - a) * (f * f * (3 - 2 * f));
    };
    // 第一下固定往下砸（重量感），之后随机
    const first = tau < 1 / freq ? 1 - tau * freq : 0;
    return { dx: n('x') * ampPx * env * (1 - first), dy: (n('y') * (1 - first) + first) * ampPx * env, rot: dz(n('r') * rotDeg * env, 0.03) };
  };

  function seek(time) {
    const t = clamp(time, 0, duration);
    // 每一爆这一刻的震动
    const shk = B.map(() => ({ dx: 0, dy: 0, rot: 0 }));
    bursts.forEach((src, k) => {
      for (let j = 0; j < nB; j++) {
        const own = j === k;
        if (!own && flair < 0.5) continue;
        if (!own && !(bursts[j].tI < src.tI)) continue; // 只震已经在画面上的
        const amp = shakeEm * B[j].fs * (own ? 1 : 0.45);
        const s = shakeOf(t, src.tI, amp, own ? shakeRot : shakeRot * 0.4, `sh${k}-${j}`);
        shk[j].dx += s.dx; shk[j].dy += s.dy; shk[j].rot += s.rot;
      }
    });
    B.forEach((o, bi) => {
      const { b, fs } = o;
      const onScreen = t >= b.t0 && t < b.tOut + b.outDur;
      show(o.g, onScreen, true);
      if (o.gRingWrap) show(o.gRingWrap, onScreen, true);
      show(o.gT, onScreen, true);
      if (!onScreen) return;
      // 出场：先鼓一下再缩没，边缩边转；小于 0.2 就隐藏
      const outCurve = (u) => (u < 0.25 ? 1 + 0.08 * easeOutCubic(u / 0.25) : 1.08 * (1 - easeInCubic((u - 0.25) / 0.75)));
      let sOut = 1; let rOut = 0;
      const uo = b.knocked ? 0 : clamp((t - b.tOut) / b.outDur);
      if (uo > 0) { sOut = outCurve(uo); rOut = dz(b.lean * -28 * easeInCubic(uo), 0.05); }
      let sT = sOut; let rT = rOut;
      if (b.knocked) {
        const ut = clamp((t - b.tTextOut) / b.textOutDur);
        if (ut > 0) { sT = outCurve(ut); rT = dz(b.lean * -28 * easeInCubic(ut), 0.05); }
      }
      if (sOut < 0.2) { show(o.g, false, true); show(o.gT, false, true); if (o.gRingWrap) show(o.gRingWrap, false, true); return; }
      const sh = shk[bi];
      const at = (sc, r) => `translate(${f3(b.cx + dz(sh.dx, 0.5))},${f3(b.cy + dz(sh.dy, 0.5))}) rotate(${f3(b.tilt + sh.rot + r)}) scale(${f3(sc)})`;
      const gT = at(sOut, rOut);
      o.g.setAttribute('transform', gT);
      if (o.gRingWrap) o.gRingWrap.setAttribute('transform', gT);
      show(o.gT, sT >= 0.2, true);
      o.gT.setAttribute('transform', at(sT, rT));
      // 底框：落地那一刻弹出来（0 → 1.12 → 0.96 → 1），之后抖边
      const tauP = t - b.tI + 0.02;
      if (o.gPlate) {
        const sP = dz1(keyed(tauP, [[0, 0], [0.07, 1.12], [0.15, 0.96], [0.24, 1]], [easeOutCubic, easeInOutCubic, easeInOutCubic]));
        const onP = tauP > 0 && sP >= 0.2;
        show(o.gPlate, onP);
        if (onP) {
          o.gPlate.setAttribute('transform', `scale(${f3(sP)})`);
          const boilT = t >= b.tI + 0.24 ? t : null; // 弹出来的时候不抖，停住了才抖
          const d = starPath(b.plate, b, fs, boilT, `pb${bi}`);
          o.plateP.setAttribute('d', d); o.plateSh.setAttribute('d', d); o.plateInk.setAttribute('d', d);
          if (o.clipP) o.clipP.setAttribute('d', d);
        }
        if (o.gRing) {
          const tauR = tauP - 0.03;
          const sR = dz1(keyed(tauR, [[0, 0], [0.09, 1.16], [0.18, 0.95], [0.28, 1]], [easeOutCubic, easeInOutCubic, easeInOutCubic]));
          const onR = tauR > 0 && sR >= 0.2;
          show(o.gRing, onR);
          if (onR) {
            o.gRing.setAttribute('transform', `scale(${f3(sR)})`);
            const boilT = t >= b.tI + 0.28 ? t + 0.37 : null;
            const d = starPath(b.ring, b, fs, boilT, `rb${bi}`);
            o.ringP.setAttribute('d', d); o.ringSh.setAttribute('d', d);
          }
        }
      }
      // 字：一个接一个砸下来（从 s0 倍砸到 1，同时从上方落下、转正），落地后等比回弹一下，0.22 秒后精确停在 1
      b.chars.forEach((c, i) => {
        const tau = t - b.t0 - i * 0.035;
        const on = tau >= 0;
        let S = 1; let rOff = 0;
        if (on) {
          if (tau < lead) {
            const u = tau / lead;
            S = lerp(b.s0, 1, easeInCubic(u));
            rOff = b.lean * 16 * (1 - easeInCubic(u));
          } else {
            S = dz1(keyed(tau - lead, [[0, 1], [0.05, 0.9], [0.13, 1.045], [0.22, 1]]));
          }
        }
        const fall = tau >= 0 && tau < lead ? (1 - easeInCubic(tau / lead)) * b.dropPx : 0;
        const px = c.x * fs * (tau < lead ? S : 1) + b.lean * 0.15 * fall; const py = c.y * fs * (tau < lead ? S : 1) - fall;
        const sc = c.s * S;
        const rot = c.rot + rOff;
        const vx = b.vp.x * fs; const vy = b.vp.y * fs;
        for (const L of o.layers) {
          const node = L.nodes[i];
          show(node, on);
          if (!on) continue;
          if (L.a) {
            const q = 1 - L.a;
            node.setAttribute('transform', `translate(${f3(vx + (px - vx) * q)},${f3(vy + (py - vy) * q)}) rotate(${f3(rot)}) scale(${f3(sc * q)})`);
          } else node.setAttribute('transform', `translate(${f3(px)},${f3(py)}) rotate(${f3(rot)}) scale(${f3(sc)})`);
        }
      });
    });
    // 放射线：落地时从底框边上冲出去，头先到、尾巴跟上，0.42 秒走完
    for (const r of RAYS) {
      const b = bursts[r.bi];
      const u = (t - b.tI - r.delay) / 0.42;
      const gone = t >= b.tOut;
      if (u <= 0 || u >= 1 || gone) { show(r.node, false, true); continue; }
      const head = r.r0 + (r.r1 - r.r0) * easeOutCubic(clamp(u * 1.7));
      const tail = r.r0 + (r.r1 - r.r0) * easeInOutCubic(clamp((u - 0.18) / 0.82));
      if (head - tail < 4) { show(r.node, false, true); continue; }
      const sh = shk[r.bi];
      const cx = b.cx + dz(sh.dx, 0.5); const cy = b.cy + dz(sh.dy, 0.5);
      const ca = Math.cos(r.a); const sa = Math.sin(r.a);
      const w = r.w * Math.min(1, Math.sqrt((head - tail) / Math.max(1, (r.r1 - r.r0) * 0.5)));
      const hx = cx + ca * head; const hy = cy + sa * head;
      const tx = cx + ca * tail; const ty = cy + sa * tail;
      const nx = -sa * w / 2; const ny = ca * w / 2;
      r.node.setAttribute('d', `M${f3(tx)},${f3(ty)}L${f3(hx + nx)},${f3(hy + ny)}L${f3(hx - nx)},${f3(hy - ny)}Z`);
      show(r.node, true, true);
    }
    // 碎片
    for (const p of DEB) {
      const b = bursts[p.bi];
      const u = (t - b.tI - p.delay) / p.dur;
      if (u <= 0 || u >= 1) { show(p.node, false, true); continue; }
      const s = u < 0.55 ? 1 : 1 - easeInCubic((u - 0.55) / 0.45);
      if (s < 0.2) { show(p.node, false, true); continue; }
      const x = p.sx + Math.cos(p.a) * p.dist * easeOutCubic(u);
      const y = p.sy + Math.sin(p.a) * p.dist * easeOutCubic(u) + p.drop * u * u;
      p.node.setAttribute('transform', `translate(${f3(x)},${f3(y)}) rotate(${f3(p.spin * u)}) scale(${f3(s)})`);
      show(p.node, true, true);
    }
  }

  const issues = checkLineBreaks(allLines, ctx.text, { segment: ctx.segment });
  const warnings = icuBreakWarnings(allLines, ctx.text);
  bursts.forEach((b) => { if (b.chars.length > 6) warnings.push({ type: 'too-long', detail: `「${b.text.trim()}」${b.chars.length} 个字，拟声词一爆最好 1–4 个字，长了会缩小` }); });
  seek(0);
  return {
    timeline,
    layout: {
      fontSize: nB ? Math.max(...bursts.map((b) => b.fs)) : 0,
      lines: allLines.map((l) => l.text),
      linesDetail: allLines,
      forced,
      issues,
      warnings,
      segmentation: ctx.segmentation.sources,
      units: nB,
      bursts: bursts.map((b) => ({ text: b.text.trim(), fontSize: Math.round(b.fs), x: Math.round(b.cx), y: Math.round(b.cy), tilt: +b.tilt.toFixed(1), impact: +b.tI.toFixed(3) })),
    },
    seek,
    destroy() { svg.remove(); },
  };
}
