// 007 文字快闪（styles/007-type-flash）
//
// 风格契约：create(root, ctx) → { timeline, layout, seek(t), destroy() }；seek 只看 t。
// 画面：一屏一个词，跟着拍子硬切。每一屏都当一张小海报排：字大、居中、字越少越大（一行最多占画面宽 80%）。
//   每屏入场只用 2 帧（从 115% 砸到 100%，或者左右滑进 6%），没有出场动画，靠硬切出冲击力。
//   隔几屏插一屏「变化」：反色、倾斜 −8°、特大字（出画面一半）；V3 还有「大词加一圈小词」。
// 时间：每一屏的开始时刻按「第一拍＋第 n 拍」的绝对时间算，不一屏一屏累加（128 拍每分钟时一拍 14.06 帧，累加取整 30 秒后差 2 帧）。
//   给了外部拍点（ctx.beats）就按外部拍点切。
// 闪烁：默认安全版。整屏翻底色（C1 黑白、C3 柠檬交替；反色屏）每秒最多 2 次，超了这一屏就不翻；
//   C2 红底固定、只换字色（不做红色和别的颜色整屏交替）。导出时底座再逐帧按 WCAG 2.3.1 算一遍，超标默认不导出。
//   flashMode=strong 时每屏都翻（照样会被逐帧检查算出来，超标只警告）。

import { hash01, rng } from '../../engine/src/lib/rand.js';
import { clamp, lerp, easeOutCubic, easeOutBack } from '../../engine/src/lib/ease.js';
import { graphemes } from '../../engine/src/lib/text.js';
import { shake, f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent = null) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
};
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * c((n >> 16) & 255) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
};
const DIV = { half: 0.5, beat: 1, double: 2 };

/** 把原文拆成一屏一屏：「｜」或回车分屏；没有分隔符就按词。每个字带上是不是 *强调*。屏首记号 ! ^ ~ 和「大/小」两行只在手动分屏时认 */
function parseScreens(raw, ctx) {
  const chars = []; let emph = false;
  for (const g of graphemes(raw)) {
    if (g === '*') { emph = !emph; continue; }
    if (g === '|') continue;
    chars.push({ ch: g, emph });
  }
  const manual = chars.some((c) => c.ch === '｜' || c.ch === '\n');
  const screens = [];
  if (manual) {
    let cur = [];
    const flush = () => { if (cur.length) screens.push(cur); cur = []; };
    for (const c of chars) { if (c.ch === '｜' || c.ch === '\n') flush(); else cur.push(c); }
    flush();
    return screens.map((cs) => {
      let mark = null;
      while (cs.length && /^[!！^~～]$/.test(cs[0].ch)) { const m = cs.shift().ch; mark = m === '!' || m === '！' ? 'invert' : m === '^' ? 'giant' : 'tilt'; }
      const slash = cs.findIndex((c) => c.ch === '/');
      const big = (slash >= 0 ? cs.slice(0, slash) : cs).filter((c) => !/\s/.test(c.ch));
      const small = slash >= 0 ? cs.slice(slash + 1).filter((c) => !/^\s$/.test(c.ch) || true) : [];
      return { big, small: small.map((c) => c.ch).join('').trim(), mark: slash >= 0 ? 'stack' : mark };
    }).filter((s) => s.big.length);
  }
  // 自动：按分词（作者手标 | → jieba＋词表 → 兜底）一词一屏
  const plain = chars.filter((c) => !/\s/.test(c.ch));
  let k = 0;
  for (const w of ctx.segment(ctx.text.replace(/\s+/g, ''))) {
    const n = graphemes(w.text).length;
    const cs = plain.slice(k, k + n); k += n;
    if (cs.some((c) => !/^[\p{P}\p{S}]$/u.test(c.ch))) screens.push({ big: cs, small: '', mark: null });
    else if (screens.length) screens[screens.length - 1].big.push(...cs); // 单独的标点跟着前一屏
  }
  return screens;
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const C = P._palette.colors;
  const pal = P._palette;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const fps = 30;
  const uid = ctx.uid;
  const strong = P.flashMode === 'strong';
  const family = ctx.fontFamily(P.font);
  const g2d = document.createElement('canvas').getContext('2d');
  const measure = (s, px) => {
    g2d.font = `${px}px ${family}`;
    const m = g2d.measureText(s);
    return { l: -m.actualBoundingBoxLeft, r: m.actualBoundingBoxRight, a: m.actualBoundingBoxAscent, d: m.actualBoundingBoxDescent, adv: m.width };
  };

  // ---------- 1) 分屏 ----------
  const screens = parseScreens(P.text, ctx);
  if (!screens.length) screens.push({ big: [{ ch: '　', emph: false }], small: '', mark: null });
  const N = screens.length;

  // ---------- 2) 时间：按绝对拍点算每屏的开始 ----------
  const bpm = P.bpm || R.bpm || 120;
  const division = P.division || R.division || 'beat';
  const period = 60 / bpm;
  const step = period * DIV[division];
  const lead = 0.5; // 开头一屏至少留 0.5 秒
  let grid;
  if (ctx.beats && ctx.beats.length) {
    // 外部拍点：半拍一屏就补中点，两拍一屏就隔一个取一个
    let b = [...ctx.beats];
    if (division === 'half') b = b.flatMap((t, i) => (i + 1 < b.length ? [t, (t + b[i + 1]) / 2] : [t]));
    if (division === 'double') b = b.filter((_, i) => i % 2 === 0);
    grid = b;
  } else grid = [];
  const gridAt = (j) => {
    if (!ctx.beats || !ctx.beats.length) return (P.firstBeat || 0) + j * step;
    if (j < grid.length) return grid[j];
    const last = grid[grid.length - 1]; const d = grid.length > 1 ? grid[grid.length - 1] - grid[grid.length - 2] : step;
    return last + (j - grid.length + 1) * d; // 外部拍点不够了，按最后一段间隔往后推
  };
  let j0 = 0; while (gridAt(j0) < lead - 1e-9) j0++;
  // 每小节第一拍（4 拍一小节）：重拍震屏、V3 的小星星
  const beatsPerScreen = DIV[division];
  const starts = screens.map((_, i) => (i === 0 ? 0 : gridAt(j0 + i - 1)));
  const lastStart = starts[N - 1];
  const duration = lastStart + Math.max(0.3, P.endHold);
  for (let i = 0; i < N; i++) {
    screens[i].t0 = starts[i];
    screens[i].t1 = i + 1 < N ? starts[i + 1] : duration;
    // 第几拍＝拍点序号 × 每屏几拍；能被 4 整除就是每小节第一拍
    const beatNum = (j0 + i - 1) * beatsPerScreen;
    screens[i].downbeat = i === 0 || Math.abs(beatNum / 4 - Math.round(beatNum / 4)) < 1e-6;
  }

  // ---------- 3) 每屏的样子：变化屏按种子挑，翻底色按次数上限 ----------
  const varietyKinds = ['invert', 'tilt', 'giant', ...(P.cloud && N >= 4 ? ['cloud', 'cloud'] : [])];
  let lastVar = -9;
  for (let i = 0; i < N; i++) {
    const s = screens[i];
    if (s.mark) continue;
    if (i === 0 || i === N - 1 || i - lastVar < 2) continue;
    if (hash01(seed, 'var', i) >= P.variety) continue;
    const opts = varietyKinds.filter((k) => k !== 'giant' || s.big.length <= 2);
    s.mark = opts[Math.floor(hash01(seed, 'vk', i) * opts.length)];
    lastVar = i;
  }
  // 底色：C1/C3 交替（alternate=bg）；反色屏也算翻一次。安全版：任意 1 秒内最多翻 2 次，超了这一屏就不翻
  const flips = []; const warnings = [];
  let baseB = false; // 这一屏用不用第二套底色
  let skippedFlips = 0;
  const canFlip = (t) => strong || flips.filter((x) => x > t - 1 + 1e-9).length < 2;
  let prevDark = null;
  for (let i = 0; i < N; i++) {
    const s = screens[i];
    let useB = baseB;
    if (P.flip !== 'off' && pal.alternate === 'bg' && i > 0) useB = !baseB;
    let invert = s.mark === 'invert';
    // 先算这一屏想要的底色，再看翻不翻得了
    const wantBg = (b, inv) => { const bg = b ? C.sub : C.bg; const fg = b ? C.fill2 : C.fill; return inv ? { bg: fg, fg: bg } : { bg, fg }; };
    let look = wantBg(useB, invert);
    const isFlip = (bg) => prevDark !== null && Math.abs(lum(bg) - lum(prevDark)) > 0.1;
    if (isFlip(look.bg) && !canFlip(s.t0)) {
      // 翻不了：先试不交替、只反色，再试都不做
      skippedFlips++;
      useB = baseB; look = wantBg(useB, invert);
      if (isFlip(look.bg)) { invert = false; if (s.mark === 'invert') s.mark = null; look = wantBg(useB, false); }
    }
    if (isFlip(look.bg)) flips.push(s.t0);
    baseB = useB; prevDark = look.bg;
    s.bg = look.bg; s.fg = look.fg; s.invert = invert;
    // C2：底色不变，字在白和黑之间换；C4：强调色在两种之间换
    if (pal.alternate === 'text' && !invert) s.fg = i % 2 ? C.fill2 : C.fill;
    s.accent = pal.alternate === 'accent' ? (i % 2 ? C.outer : C.accent) : C.accent;
    if (s.invert) s.accent = s.fg; // 反色屏：强调色（短杠、强调字）跟字同色，不然白杠落在金底这类浅底上看不见
    if (P.fill) s.fg = invert ? s.fg : P.fill;
  }
  if (skippedFlips) warnings.push(`为了不超过每秒 2 次整屏翻转，有 ${skippedFlips} 屏没有翻底色`);

  // ---------- 4) 排版：一屏一张小海报 ----------
  const BASE = 200;
  const cap = P.size * short;
  for (const s of screens) {
    const text = s.big.map((c) => c.ch).join('');
    const m = measure(text, BASE);
    const inkW = Math.max(1, m.r - m.l); const inkH = Math.max(1, m.a + m.d);
    let fs;
    // 特大字：墨迹宽到画面宽的 1.6 倍（1 个字）或 1.3 倍（2 个字），两边都出画面，字还认得出来
    if (s.mark === 'giant') fs = ((s.big.length > 1 ? 1.3 : 1.6) * W * BASE) / inkW;
    else if (s.mark === 'cloud') fs = Math.min(cap * 0.9, (W * 0.62 * BASE) / inkW, (H * 0.32 * BASE) / inkH);
    else fs = Math.min(cap, (W * 0.8 * BASE) / inkW, (H * (s.small ? 0.42 : 0.6) * BASE) / inkH);
    const k = fs / BASE;
    s.fs = fs; s.text = text;
    s.ink = { l: m.l * k, r: m.r * k, a: m.a * k, d: m.d * k };
    // 摆放：墨迹居中（竖向按墨迹的中线），特大字往一边挪、出画面一半
    let cx = W / 2; let cy = H * (H > W ? 0.46 : 0.5);
    if (s.small) cy -= fs * 0.18;
    if (s.mark === 'giant') cx = W / 2 + (hash01(seed, 'gs', s.t0) - 0.5) * 0.2 * W;
    s.x = cx - (s.ink.l + s.ink.r) / 2; s.y = cy + (s.ink.a - s.ink.d) / 2;
    s.cx = cx; s.cy = cy;
    s.rot = s.mark === 'tilt' ? -8 : 0;
    // 入场：砸入或滑入（按种子），第一屏总是砸入
    s.ent = P.entrance === 'mix' ? (hash01(seed, 'ent', s.t0) < 0.55 ? 'slam' : 'slide') : P.entrance;
    s.dir = hash01(seed, 'dir', s.t0) < 0.5 ? -1 : 1;
    // 强调：整屏都是 *强调* 的字就用强调色；只有一部分就分段上色
    s.runs = [];
    for (const c of s.big) { const last = s.runs[s.runs.length - 1]; if (last && last.emph === c.emph) last.text += c.ch; else s.runs.push({ text: c.ch, emph: c.emph }); }
  }

  // ---------- 5) 搭 SVG ----------
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: 'position:absolute;left:0;top:0;overflow:hidden' });
  root.appendChild(svg);
  const bgRect = ctx.transparent ? null : el('rect', { x: 0, y: 0, width: W, height: H, fill: screens[0].bg }, svg);
  const scene = el('g', {}, svg);
  const allWords = screens.map((s) => s.text);
  for (const [i, s] of screens.entries()) {
    s.g = el('g', { visibility: 'hidden' }, scene);
    // 大字放在会动的那一组里；小字（两行屏的小字、一圈小词）单独一组不动：小字跟着整组每帧换缩放，画法会跟渲染顺序有关
    s.move = el('g', {}, s.g);
    s.still = el('g', {}, s.g);
    const mkText = (parent, extra = {}) => {
      const t = el('text', { x: f3(s.x), y: f3(s.y), 'font-family': family, 'font-size': f3(s.fs), fill: s.fg, ...extra }, parent);
      for (const r of s.runs) { const sp = el('tspan', { fill: r.emph ? s.accent : null }, t); sp.textContent = r.text; }
      return t;
    };
    if (P.ghost && s.ent === 'slide') s.ghosts = [0.28, 0.12].map((op) => mkText(s.move, { 'fill-opacity': op }));
    s.main = mkText(s.move);
    if (P.underline && s.mark !== 'giant') {
      const w = (s.ink.r - s.ink.l) * 0.42; const h = Math.max(6, s.fs * 0.07);
      s.bar = el('rect', { x: f3(s.cx - w / 2), y: f3(s.cy + (s.ink.a + s.ink.d) / 2 + s.fs * 0.1), width: f3(w), height: f3(h), fill: s.accent }, s.move);
    }
    if (s.small) {
      const px = Math.min(s.fs * 0.26, (W * 0.8 * BASE) / Math.max(1, measure(s.small, BASE).adv));
      const t = el('text', { x: f3(s.cx), y: f3(s.cy + (s.ink.a + s.ink.d) / 2 + px * 1.5), 'font-family': family, 'font-size': f3(px), 'text-anchor': 'middle', fill: s.fg, 'fill-opacity': 0.85 }, s.still);
      t.textContent = s.small;
    }
    if (s.mark === 'cloud') {
      // 一圈小词：取别的屏的词，摆在大词周围，不压大词、不出画面
      const others = allWords.filter((_, k) => k !== i);
      const r = rng(seed, 'cloud', i);
      const placed = [];
      const box = { x0: s.cx + s.ink.l - (s.ink.r + s.ink.l) / 2 - s.fs * 0.15, x1: s.cx + (s.ink.r - s.ink.l) / 2 + s.fs * 0.15, y0: s.cy - (s.ink.a + s.ink.d) / 2 - s.fs * 0.15, y1: s.cy + (s.ink.a + s.ink.d) / 2 + s.fs * 0.15 };
      for (let k = 0; k < Math.min(14, others.length * 3); k++) {
        const word = others[k % others.length];
        const px = short * (0.035 + r() * 0.03);
        const m = measure(word, px);
        const w = m.adv; const h = px;
        for (let tries = 0; tries < 30; tries++) {
          const x = W * 0.06 + r() * (W * 0.88 - w); const y = H * 0.12 + r() * (H * 0.72);
          const b = { x0: x - px * 0.3, x1: x + w + px * 0.3, y0: y - h, y1: y + h * 0.4 };
          const hit = (a, c) => a.x0 < c.x1 && a.x1 > c.x0 && a.y0 < c.y1 && a.y1 > c.y0;
          if (hit(b, box) || placed.some((p) => hit(b, p))) continue;
          placed.push(b);
          const t = el('text', { x: f3(x), y: f3(y), 'font-family': family, 'font-size': f3(px), fill: C.inner, 'fill-opacity': f3(0.55 + r() * 0.35) }, s.still);
          t.textContent = word;
          break;
        }
      }
    }
    // 小星星：重拍那一屏在字周围溅出几颗（面积很小，不算闪烁）
    s.sparks = [];
    if (P.sparks > 0 && s.downbeat && i > 0) {
      const r = rng(seed, 'spark', i);
      const n = Math.round(4 + 5 * P.sparks);
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2 + r() * 0.6;
        const dist = Math.max(s.ink.r - s.ink.l, s.ink.a + s.ink.d) * (0.55 + r() * 0.25);
        const x = s.cx + Math.cos(ang) * dist; const y = s.cy + Math.sin(ang) * dist * 0.75;
        if (x < 20 || x > W - 20 || y < 20 || y > H - 20) continue;
        const rad = short * (0.022 + r() * 0.024);
        const p = el('path', { d: star(rad), fill: k % 2 ? s.accent : s.fg }, s.g);
        s.sparks.push({ p, x, y, delay: r() * 0.05 });
      }
    }
  }

  // ---------- 6) seek ----------
  const enterDur = 2 / fps + 1e-6;
  function seek(t) {
    const i = Math.max(0, screens.findIndex((s, k) => t >= s.t0 && (t < s.t1 || k === N - 1)));
    const s = screens[i];
    if (bgRect) bgRect.setAttribute('fill', s.bg);
    for (const [k, x] of screens.entries()) if (k !== i) x.g.setAttribute('visibility', 'hidden');
    s.g.setAttribute('visibility', 'visible');
    const local = t - s.t0;
    const p = clamp(local / enterDur);
    // 入场 2 帧：砸入 115% → 100%；滑入左右 6%
    const sc = s.ent === 'slam' || i === 0 ? lerp(1.15, 1, easeOutCubic(p)) : 1;
    const dx = s.ent === 'slide' && i > 0 ? s.dir * 0.06 * W * (1 - easeOutCubic(p)) : 0;
    // 最后一屏慢慢放大 3%
    const zoom = i === N - 1 ? 1 + 0.03 * clamp(local / Math.max(0.3, P.endHold)) : 1;
    const k = sc * zoom;
    s.move.setAttribute('transform', `translate(${f3(s.cx + dx)},${f3(s.cy)}) rotate(${f3(s.rot)}) scale(${f3(k)}) translate(${f3(-s.cx)},${f3(-s.cy)})`);
    if (s.ghosts) s.ghosts.forEach((g, gi) => {
      const on = p < 1;
      g.setAttribute('visibility', on ? 'inherit' : 'hidden');
      g.setAttribute('transform', `translate(${f3(-s.dir * 0.035 * W * (gi + 1) * (1 - p))},0)`);
    });
    if (s.rot && s.still) s.still.setAttribute('transform', `rotate(${f3(s.rot)} ${f3(s.cx)} ${f3(s.cy)})`);
    // 重拍震屏 2 帧
    let m = { dx: 0, dy: 0 };
    if (s.downbeat && i > 0 && P.shake > 0) m = shake(t, { start: s.t0, amplitude: 0.004 * short * P.shake, duration: enterDur, freq: fps, seed: seed + i, rotate: 0 });
    scene.setAttribute('transform', `translate(${f3(m.dx)},${f3(m.dy)})`);
    for (const sp of s.sparks) {
      const q = clamp((local - sp.delay) / 0.22);
      const a = q <= 0 ? 0 : q < 0.35 ? easeOutBack(q / 0.35) : 1 - (q - 0.35) / 0.65;
      // 几乎缩成一点的那几帧先隐藏（《写一个新风格》第 3 节的建议）
      if (a < 0.2) { sp.p.setAttribute('visibility', 'hidden'); continue; }
      sp.p.setAttribute('visibility', 'inherit');
      sp.p.setAttribute('transform', `translate(${f3(sp.x)},${f3(sp.y)}) scale(${f3(a)})`);
    }
  }

  // ---------- 7) 时间轴和检查 ----------
  const frameOf = (x) => Math.round(x * fps);
  const drift = screens.slice(1).map((s, k) => ({ screen: k + 2, beat: s.t0, frame: frameOf(s.t0), errFrames: +(Math.abs(frameOf(s.t0) - s.t0 * fps)).toFixed(3) }));
  const maxDrift = Math.max(0, ...drift.map((d) => d.errFrames));
  const readRate = screens.map((s, k) => ({ screen: k + 1, text: s.text, chars: s.big.length, seconds: +(s.t1 - s.t0).toFixed(3), perSecond: +(s.big.length / Math.max(1e-6, s.t1 - s.t0)).toFixed(2) }));
  const tooFast = readRate.filter((r, k) => k < N - 1 && r.perSecond > 12);
  const styleChecks = [
    { id: 'read-rate', level: 'warn', pass: !tooFast.length, message: tooFast.length ? `有 ${tooFast.length} 屏字太多读不过来（超过每秒 12 个字）：${tooFast.slice(0, 4).map((r) => `「${r.text}」${r.chars} 个字停 ${r.seconds} 秒`).join('、')}；改成一拍一屏，或者拆成两屏` : '每屏的字都读得过来（每秒不超过 12 个字）' },
    { id: 'beat-drift', level: 'warn', pass: maxDrift <= 1, message: `每屏开始的帧跟理论拍点最多差 ${maxDrift.toFixed(2)} 帧（按绝对时间取整，不累加）` },
    { id: 'flip-rate', level: 'warn', pass: strong || !skippedFlips, message: strong ? `强闪烁模式：整屏翻转 ${flips.length} 次，不限次数` : skippedFlips ? warnings[0] : `整屏翻转 ${flips.length} 次，任意 1 秒内不超过 2 次` },
    { id: 'transparent-bg', level: 'warn', pass: !ctx.transparent || pal.alternate !== 'bg', message: ctx.transparent && pal.alternate === 'bg' ? '透明底导出会去掉底色，黑白／柠檬交替的底色就没了，只留字（字色按第一套）' : '透明底只留字' },
  ];
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '第一屏', start: 0, end: screens.length > 1 ? screens[1].t0 : duration },
      { name: 'flash', label: '快闪', start: screens.length > 1 ? screens[1].t0 : duration, end: lastStart },
      { name: 'hold', label: '最后一屏', start: lastStart, end: duration },
    ].filter((x) => x.end > x.start),
    beats: screens.map((s, k) => ({ t: s.t0, name: s.downbeat ? 'downbeat' : 'beat', label: `第 ${k + 1} 屏「${s.text}」` })),
    units: screens.map((s, k) => ({ text: s.text, start: s.t0, end: s.t1, kind: s.mark || 'plain', bg: s.bg, screen: k + 1 })),
    tempo: { bpm, division, firstBeat: P.firstBeat || 0, externalBeats: !!(ctx.beats && ctx.beats.length) },
  };
  return {
    timeline,
    layout: {
      fontSize: Math.max(...screens.map((s) => s.fs)),
      lines: screens.map((s) => s.text + (s.small ? ` / ${s.small}` : '')),
      linesDetail: screens.map((s) => ({ text: s.text, small: s.small, fs: +s.fs.toFixed(1), mark: s.mark, bg: s.bg, fg: s.fg })),
      forced: [],
      issues: [],
      warnings: [],
      styleChecks,
      readRate,
      beatDrift: drift,
      flips: flips.map((x) => +x.toFixed(3)),
      segmentation: ctx.segmentation && ctx.segmentation.sources,
    },
    seek,
    destroy() { svg.remove(); },
  };
}

/** 四角星（中心在原点，半径 r） */
function star(r) {
  const k = 0.32;
  const pts = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 - Math.PI / 2; const rr = i % 2 ? r * k : r; pts.push(`${f3(Math.cos(a) * rr)},${f3(Math.sin(a) * rr)}`); }
  return `M${pts.join('L')}Z`;
}
