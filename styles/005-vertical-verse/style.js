// 005 竖排诗句（Vertical Verse）
// 一首诗竖着排，从右往左一列一列、一个字一个字淡出来，最后盖一方小印章。好不好看全看竖排的细节：
//   标点换竖排字形、挤到半格；引号换直角引号；括号、书名号换竖排字形；两位以内的数字和英文横着并排（纵中横），更长的转 90°；
//   列首不放标点、列尾不放开引号。
// 参数（见 meta.json）：text、author 署名、seal 印章字、look 造型（V1 清读 / V3 水墨卷轴）、palette、rhythm、font、
//   columns 分列（sentence 一句一列 / 数字＝每列最多几个字）、punct 标点开关、numbers 数字英文的排法、size 字号、colGap 列距、
//   transparent 透明底、inkBloom 墨晕、wobble 手写错落、paper 宣纸和远山、pan 镜头平移、sealHalo 印章晕开、hold、x、y、seed。
// 随机全部走 hash01(seed, …)；seek(t) 是纯函数，每个属性每次都重新设。
// 不给整组设透明度（Chrome 局部重画时会让乱序渲染跟顺序渲染差几个像素，002、006 都实测踩过），淡入淡出都写在单个元素上。
import { hash01 } from '../../engine/src/lib/rand.js';
import { mix } from '../../engine/src/lib/color.js';
import { clamp, lerp, easeOutCubic, easeInCubic } from '../../engine/src/lib/ease.js';
import { graphemes, atomize, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { shake, holdWeight, f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TRACK = 0.08; // 字距（上下）：字号的 0.08
const AUTHOR_RATIO = 0.5; // 署名字号是正文的一半
const SEAL_RATIO = 0.9; // 印章边长是正文字号的 0.9

// 横排标点 → 竖排字形（Unicode 竖排兼容字形 U+FE10–FE19、U+FE30–FE44）
const VERT = new Map(Object.entries({
  '，': '︐', ',': '︐', '、': '︑', '。': '︒', '：': '︓', ':': '︓', '；': '︔', ';': '︔', '！': '︕', '!': '︕', '？': '︖', '?': '︖',
  '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '“': '﹁', '”': '﹂', '‘': '﹃', '’': '﹄',
  '《': '︽', '》': '︾', '（': '︵', '）': '︶', '(': '︵', ')': '︶', '〈': '︿', '〉': '﹀', '【': '︻', '】': '︼',
  '〔': '︹', '〕': '︺', '〖': '︗', '〗': '︘', '…': '︙', '—': '︱', '–': '︲',
}));
const VERT_FORMS = new Set(VERT.values());
const ROTATE_PUNCT = new Set([...'～~']); // 竖排里转 90°
const UPRIGHT_PUNCT = new Set([...'·・']); // 竖排里照样立着、居中
const SENT_END = new Set([...'，。！？；：、,!?;:…']);
const STRONG_END = new Set([...'。！？；!?;…']);
const CLOSERS = new Set([...'」』”’）》】〕〉〗)']);
const LATIN = /^[0-9A-Za-z]$/;
const LATIN_INNER = /^[0-9A-Za-z.%+\-:'’]$/;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const isPunct = (g) => VERT.has(g) || FULLWIDTH_PUNCT.has(g) || ROTATE_PUNCT.has(g) || /^[,.!?;:()"'\-]$/.test(g);

/** 量字：在 100px 下量，返回以字身中线为 0 的墨迹上下沿和横向宽度（都按字号归一） */
function makeMeasurer(family, weight) {
  const g = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  const BASE = 100;
  g.font = `${weight} ${BASE}px ${family}`;
  g.textBaseline = 'middle';
  return function measure(s) {
    if (cache.has(s)) return cache.get(s);
    const m = g.measureText(s);
    const r = { top: -m.actualBoundingBoxAscent / BASE, bottom: m.actualBoundingBoxDescent / BASE, width: m.width / BASE };
    cache.set(s, r);
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
  const WEIGHT = 'normal'; // 字重由底座登记的字体档决定（思源宋体 SemiBold 600），这里不再要粗
  const measure = makeMeasurer(family, WEIGHT);
  const transparent = !!P.transparent || ctx.transparent === true || P.palette === 'C3';
  const softShadow = P.palette === 'C3'; // 叠在画面上：每个字一层柔和投影
  const wobble = P.wobble ?? 0;
  const colGap = P.colGap ?? 1.0;
  const showPunct = P.punct !== false;
  const numMode = P.numbers || 'tcy';
  const perCol = P.columns && P.columns !== 'sentence' ? Number(P.columns) : 0;
  const maxPer = perCol || 12; // 一句太长（超过 12 个字）也要拆成几列

  // ---------- 文字 → 列 ----------
  const paragraphs = String(ctx.text).replace(/\r/g, '').split('\n').map((p) => p.trim());
  const columns = []; // { text, index, paragraph, atoms }
  const realOf = (s) => graphemes(s).filter((g) => !isPunct(g) && !/\s/.test(g)).length;
  paragraphs.forEach((p, pi) => {
    if (!p) return;
    const atoms = atomize(p, { segment: ctx.segment }).map((a) => ({ text: a.text, index: a.index, real: realOf(a.text) }));
    const push = (list) => { if (list.length) columns.push({ paragraph: pi, index: list[0].index, text: list.map((a) => a.text).join(''), atoms: list }); };
    // 一组块拆成几列：列数取「装得下的最少列数」，再用动态规划挑断点，让各列字数尽量匀，优先断在标点后面。
    // 单个块比 maxPer 还长时只能独占一列
    const endsWith = (a, set) => { const gs = graphemes(a.text); let k = gs.length - 1; while (k >= 0 && CLOSERS.has(gs[k])) k--; return k >= 0 && set.has(gs[k]); };
    const splitEven = (list) => {
      if (!list.length) return;
      const total = list.reduce((s0, a) => s0 + a.real, 0);
      const kMin = Math.max(1, Math.ceil(total / maxPer));
      if (kMin === 1 && total <= maxPer) { push(list); return; }
      const m = list.length;
      const pre = [0]; for (const a of list) pre.push(pre[pre.length - 1] + a.real);
      const brk = (jj) => (jj >= m ? 0 : endsWith(list[jj - 1], STRONG_END) ? -0.6 : endsWith(list[jj - 1], SENT_END) ? -0.4 : (list[jj - 1].real === 1 && list[jj].real === 1 ? 0.5 : 0));
      const INF = 1e9;
      // 分成 kk 列的最好断法；块有大有小，最少列数不一定装得下，所以从最少列数起多试几种，多一列加 0.35 的代价
      const solve = (kk) => {
        const target = total / kk;
        const best = Array.from({ length: kk + 1 }, () => new Array(m + 1).fill(INF));
        const from = Array.from({ length: kk + 1 }, () => new Array(m + 1).fill(-1));
        best[0][0] = 0;
        for (let c = 1; c <= kk; c++) {
          for (let jj = 1; jj <= m; jj++) {
            for (let ii = c - 1; ii < jj; ii++) {
              if (best[c - 1][ii] >= INF) continue;
              const sum = pre[jj] - pre[ii];
              if (sum > maxPer && jj - ii > 1) continue;
              const cost = best[c - 1][ii] + 4 * ((sum - target) / target) ** 2 + brk(jj);
              if (cost < best[c][jj]) { best[c][jj] = cost; from[c][jj] = ii; }
            }
          }
        }
        if (best[kk][m] >= INF) return null;
        const cuts = []; let jj = m;
        for (let c = kk; c > 0; c--) { const ii = from[c][jj]; cuts.unshift([ii, jj]); jj = ii; }
        return { cost: best[kk][m] + 0.35 * (kk - kMin), cuts };
      };
      let pick = null;
      for (let kk = kMin; kk <= Math.min(m, kMin + 3); kk++) {
        const r = solve(kk);
        if (r && (!pick || r.cost < pick.cost - 1e-9)) pick = r;
      }
      if (!pick) { list.forEach((a) => push([a])); return; }
      for (const [a0, a1] of pick.cuts) push(list.slice(a0, a1));
    };
    // 书名号里的标题（不超过一列）当成一整块，不拆到两列
    for (let a = 0; a < atoms.length; a++) {
      if (!atoms[a].text.includes('《')) continue;
      let b = a; while (b < atoms.length && !atoms[b].text.includes('》')) b++;
      if (b >= atoms.length || b === a) continue;
      const group = atoms.slice(a, b + 1);
      const real = group.reduce((s0, x) => s0 + x.real, 0);
      if (real > maxPer) continue;
      atoms.splice(a, b - a + 1, { text: group.map((x) => x.text).join(''), index: group[0].index, real });
    }
    if (perCol) { splitEven(atoms); return; }
    // 一句一列：块的末尾（去掉收尾的引号、括号）是逗号、句号这类标点，就在这里换列
    let sent = [];
    for (const a of atoms) {
      sent.push(a);
      if (endsWith(a, SENT_END)) { splitEven(sent); sent = []; }
    }
    splitEven(sent);
  });

  // ---------- 列 → 字格 ----------
  // 字格高度都按字号归一：普通字 1；标点按墨迹挤到半格；转 90° 的按横排宽度
  const emph = (pi, off) => pi >= 0 && ctx.isEmphasis(pi, off);
  // 半角双引号分不出开闭：同一段里按出现顺序交替，第一个当开引号
  const asciiQuote = new Map();
  paragraphs.forEach((p, pi) => { let open = true; let o = 0; for (const g of graphemes(p)) { if (g === '"') { asciiQuote.set(`${pi}:${o}`, open ? '﹁' : '﹂'); open = !open; } o += g.length; } });
  const vIssues = [];
  function cellsOf(text, pi, base, ratio = 1) {
    const gs = graphemes(text);
    const cells = [];
    let off = base;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      if (/\s/.test(g)) { cells.push({ type: 'space', h: 0.3, off }); off += g.length; continue; }
      if (LATIN.test(g)) {
        // 拉丁字母和数字连成一段
        let j = i; let s = ''; let o = off;
        while (j < gs.length && (LATIN.test(gs[j]) || (j > i && LATIN_INNER.test(gs[j]) && j + 1 < gs.length && LATIN.test(gs[j + 1])))) { s += gs[j]; o += gs[j].length; j++; }
        const kw = [...Array(s.length).keys()].some((k) => emph(pi, off + k));
        const w = measure(s).width;
        if (numMode === 'upright') {
          let oo = off;
          for (const ch of graphemes(s)) { cells.push({ type: 'char', glyph: ch, h: 1, off: oo, kw: emph(pi, oo), src: ch }); oo += ch.length; }
        } else if (numMode === 'tcy' && graphemes(s).length <= 2) {
          cells.push({ type: 'tcy', glyph: s, h: 1, sx: Math.min(1, 0.92 / Math.max(w, 0.01)), off, kw, src: s });
        } else {
          cells.push({ type: 'rot', glyph: s, h: w + 0.12, off, kw, src: s });
        }
        off = o; i = j - 1; continue;
      }
      if (isPunct(g)) {
        if (!showPunct) { off += g.length; continue; }
        if (ROTATE_PUNCT.has(g)) { cells.push({ type: 'rot', glyph: g, h: measure(g).width, off, src: g }); off += g.length; continue; }
        let v = VERT.get(g) || asciiQuote.get(`${pi}:${off}`) || g;
        if (!VERT.has(g) && !UPRIGHT_PUNCT.has(g) && !VERT_FORMS.has(v)) vIssues.push({ type: 'vertical-punct', detail: `标点「${g}」没有竖排字形，原样立着放了` });
        const m = measure(v);
        const pad = 0.06;
        const h = Math.max(0.5, m.bottom - m.top + 2 * pad);
        // 半格窗口从墨迹上沿往上留一点边；字身中线相对字格中线的偏移
        const winTop = Math.min(m.top - pad, 0.5 - h); // 墨迹太靠下时窗口别超出字身下沿
        const offY = -winTop - h / 2;
        cells.push({ type: 'punct', glyph: v, h, offY, off, src: g });
        off += g.length; continue;
      }
      cells.push({ type: 'char', glyph: g, h: 1, off, kw: emph(pi, off), src: g });
      off += g.length;
    }
    // 引号检查：竖排里不能留横排引号
    for (const c of cells) if (c.type === 'punct' && /[“”‘’"]/.test(c.glyph)) vIssues.push({ type: 'vertical-quote', detail: `引号「${c.glyph}」没换成直角引号` });
    let y = 0;
    cells.forEach((c, k) => { c.y0 = y; y += c.h + (k < cells.length - 1 ? TRACK : 0); });
    return { cells: cells.map((c) => ({ ...c, h: c.h * ratio, y0: c.y0 * ratio, offY: (c.offY || 0) * ratio })), len: y * ratio };
  }
  const cols = columns.map((c) => ({ ...c, ...cellsOf(c.text, c.paragraph, c.index) }));
  // 列首标点检查（一句一列时一般不会出现；按字数分列时块已经把标点粘在前一个词后面）
  cols.forEach((c, i) => {
    const first = c.cells.find((x) => x.type !== 'space');
    if (i > 0 && first && first.type === 'punct' && !/[﹁﹃︵︽︿︻︹︗]/.test(first.glyph)) vIssues.push({ type: 'column-start-punct', detail: `第 ${i + 1} 列以标点「${first.src}」开头` });
  });
  const author = String(P.author || '').trim();
  const sealText = graphemes(String(P.seal || '').replace(/\s/g, '')).slice(0, 4);
  const authorCol = author ? cellsOf(author, -1, 0, AUTHOR_RATIO) : null;

  // ---------- 字号和位置 ----------
  const n = cols.length;
  const maxLen = Math.max(0, ...cols.map((c) => c.len));
  const hasSide = !!authorCol || sealText.length > 0;
  const sideW = hasSide ? 0.8 + SEAL_RATIO : 0; // 署名列：离正文 0.8 个字，宽度按印章算
  const sideLen = hasSide ? 2 + (authorCol ? authorCol.len + 0.4 : 0) + (sealText.length ? SEAL_RATIO : 0) : 0; // 往下错开两个字
  const blockW = n + Math.max(0, n - 1) * colGap + sideW;
  const blockL = Math.max(maxLen, sideLen);
  const panReserve = (P.pan || 0) * W * 0.5;
  const bandTop = 0.1 * H;
  const bandBot = vertical ? 0.78 * H : 0.9 * H; // 竖屏避开底部 20% 的遮挡区
  const rightLimit = vertical ? 0.85 * W - panReserve : 0.92 * W - panReserve; // 竖屏避开右侧 15% 的按钮区
  const leftLimit = 0.08 * W + panReserve;
  const capFs = (vertical ? 0.09 : 0.1) * short;
  const fitFs = Math.min((bandBot - bandTop) / Math.max(blockL, 1), (rightLimit - leftLimit) / Math.max(blockW, 1));
  const warnings = [];
  let fs = P.size ? P.size * short : Math.min(fitFs, capFs);
  if (!P.size && fitFs < 0.04 * short) warnings.push({ type: 'too-long', detail: `字太多，字号自动缩到了短边的 ${(fs / short).toFixed(3)}，建议分成几屏` });
  // V3 的墨晕和错落在小字号下不好认：字号低于短边 0.055，或者超过 4 列，入场就退回 V1 的做法
  const v3Entrance = !!P.inkBloom && fs >= 0.055 * short && n <= 4;
  const blockWpx = blockW * fs; const blockLpx = blockL * fs;
  let cx = P.x != null ? P.x * W : (vertical ? 0.53 : 0.5) * W;
  let right = cx + blockWpx / 2;
  if (right > rightLimit) right = rightLimit;
  if (right - blockWpx < leftLimit) right = leftLimit + blockWpx;
  const cyMid = P.y != null ? P.y * H : (bandTop + bandBot) / 2;
  const top = clamp(cyMid - blockLpx / 2, 0.04 * H, H - 0.04 * H - blockLpx);
  const colX = (i) => right - 0.5 * fs - i * (1 + colGap) * fs; // 第一列在最右边
  const sideX = colX(Math.max(0, n - 1)) - (0.5 + 0.8 + SEAL_RATIO / 2) * fs;
  const authorTop = top + 2 * fs;
  const sealTop = authorTop + (authorCol ? authorCol.len * fs + 0.4 * fs : 0);

  // ---------- 时间轴 ----------
  const units = [];
  let t = 0.2;
  cols.forEach((c, ci) => {
    c.start = t;
    c.cells.forEach((cell, k) => {
      if (cell.type === 'space') return;
      const jitter = (hash01(seed, 'jit', ci, k) - 0.5) * 0.06; // ±0.03 秒，像人在读，不是机器匀速
      const u = { cell, ci, k, kw: !!cell.kw, x: colX(ci), y: top + (cell.y0 + cell.h / 2) * fs };
      u.t0 = Math.max(0, t + jitter);
      u.dx = wobble * (hash01(seed, 'wx', ci, k) - 0.5) * 0.04 * fs; // 手写的错落：左右 ±2%
      u.sF = 1 + wobble * (hash01(seed, 'ws', ci, k) - 0.5) * 0.06; // 大小 ±3%
      units.push(u);
      t += cell.type === 'punct' ? R.charStagger * 0.5 : R.charStagger;
      if (u.kw) t += 0.15; // 关键字多停一下
    });
    t += R.colPause;
  });
  const lastEnd = units.length ? Math.max(...units.map((u) => u.t0 + R.charDur)) : 0;
  const authorStart = lastEnd + 0.4;
  const authorEnd = authorCol ? authorStart + 0.4 : lastEnd;
  const sealStart = sealText.length ? (authorCol ? authorEnd : lastEnd + 0.4) : null;
  const sealEnd = sealStart != null ? sealStart + 0.25 : null;
  const introEnd = sealEnd != null ? sealEnd + (P.sealHalo ? 0.45 : 0.15) : authorEnd + 0.1;
  const realCount = units.filter((u) => u.cell.type !== 'punct').length;
  const holdDur = P.hold ?? Math.max(3, realCount / 5);
  const outroStart = introEnd + holdDur;
  const outroEnd = outroStart + R.outDur;
  const duration = outroEnd + 0.1;
  // 出场：按阅读顺序逐字淡出，再往上漂一点
  const xDur = 0.6 * R.outDur;
  const xStagger = units.length > 1 ? (0.4 * R.outDur) / (units.length - 1) : 0;
  units.forEach((u, i) => { u.x0 = outroStart + i * xStagger; });
  const sideExit = outroStart + 0.4 * R.outDur;

  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '入场', start: 0, end: introEnd },
      { name: 'hold', label: '停留', start: introEnd, end: outroStart },
      { name: 'outro', label: '出场', start: outroStart, end: outroEnd },
    ],
    beats: [
      ...cols.map((c, ci) => ({ t: c.start, name: 'column', column: ci, label: `第 ${ci + 1} 列开始` })),
      ...(sealStart != null ? [{ t: sealEnd, name: 'seal', label: '印章盖下' }] : []),
      { t: outroStart, name: 'exit', label: '开始出场' },
    ],
    units: units.map((u, i) => ({ i, char: u.cell.src, column: u.ci, emphasis: u.kw, enter: u.t0, land: u.t0 + R.charDur, exitStart: u.x0, exitEnd: u.x0 + xDur })),
  };

  // ---------- 搭 SVG ----------
  // id 前缀：底座给的 ctx.uid（画廊一页放几个预览时 id 不会撞），旧底座没有就自己算一个
  const uid = ctx.uid ? `${ctx.uid}-vv` : 'vv' + Math.floor(hash01(seed, ctx.text, W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  if (!transparent) {
    el('rect', { x: 0, y: 0, width: W, height: H, fill: K.bg, 'data-layer': 'bg' }, svg);
    if (P.paper) {
      // 宣纸：细纤维加大块的深浅，静态
      const f = el('filter', { id: `${uid}-paper`, x: 0, y: 0, width: W, height: H, filterUnits: 'userSpaceOnUse' }, defs);
      el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.75 0.45', numOctaves: 2, seed: Math.floor(hash01(seed, 'paper') * 1000), result: 'fine' }, f);
      el('feColorMatrix', { in: 'fine', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.6 0 0 0 -0.7', result: 'fineA' }, f);
      el('feTurbulence', { type: 'fractalNoise', baseFrequency: f3(3 / short), numOctaves: 3, seed: Math.floor(hash01(seed, 'mottle') * 1000), result: 'big' }, f);
      el('feColorMatrix', { in: 'big', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.2 0 0 0 -0.45', result: 'bigA' }, f);
      el('feComposite', { in: 'fineA', in2: 'bigA', operator: 'arithmetic', k1: 0, k2: 0.5, k3: 0.5, k4: 0, result: 'a' }, f);
      el('feFlood', { 'flood-color': mix(K.bg, K.fill, 0.5), result: 'c' }, f);
      el('feComposite', { in: 'c', in2: 'a', operator: 'in' }, f);
      el('rect', { x: 0, y: 0, width: W, height: H, fill: '#000', filter: `url(#${uid}-paper)`, opacity: 0.22, 'data-layer': 'paper' }, svg);
    }
  }
  const scene = el('g', { 'data-layer': 'scene' }, svg);
  let gm = null; // 远山那一组（只有宣纸开着、不透明时才有）
  if (P.paper && !transparent) {
    // 远山墨影：两层，种子定起伏，越往下越淡，静态（跟镜头一起平移）
    gm = el('g', { 'data-layer': 'mountains' }, scene);
    [[0.7, 0.06, 0.09, 'far'], [0.8, 0.08, 0.07, 'near']].forEach(([base, amp, op, tag], li) => {
      const grad = el('linearGradient', { id: `${uid}-m${li}`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el('stop', { offset: '0', 'stop-color': K.shadow, 'stop-opacity': op }, grad);
      el('stop', { offset: '1', 'stop-color': K.shadow, 'stop-opacity': 0 }, grad);
      const ph = [0, 1, 2].map((k) => hash01(seed, 'mt', tag, k) * 6.283);
      const pts = [];
      const x0 = -0.1 * W; const x1 = 1.1 * W;
      for (let x = x0; x <= x1; x += W / 90) {
        const u = x / W;
        const yy = base - amp * (0.55 * Math.sin(u * 5.1 + ph[0]) + 0.3 * Math.sin(u * 11.3 + ph[1]) + 0.15 * Math.sin(u * 23.7 + ph[2])) - amp * 0.4 * Math.exp(-(((u - lerp(0.15, 0.4, hash01(seed, 'peak', tag))) / 0.12) ** 2));
        pts.push(`${f3(x)},${f3(yy * H)}`);
      }
      el('path', { d: `M${f3(x0)},${f3(H)} L${pts.join(' L')} L${f3(x1)},${f3(H)} Z`, fill: `url(#${uid}-m${li})` }, gm);
    });
  }
  const gBloom = el('g', { 'data-layer': 'ink' }, scene);
  const gText = el('g', { 'data-layer': 'text' }, scene);
  const gSide = el('g', { 'data-layer': 'side' }, scene);

  // 每个字一个滤镜：入场的模糊（动），C3 再加一层柔和投影（静）
  let fid = 0;
  function blurFilter(withShadow) {
    const id = `${uid}-f${fid++}`;
    const f = el('filter', { id, x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
    const b = el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0, result: 'b' }, f);
    if (withShadow) el('feDropShadow', { in: 'b', dx: 0, dy: f3(0.03 * fs), stdDeviation: f3(0.07 * fs), 'flood-color': K.outer, 'flood-opacity': 0.5 }, f);
    return { id, b };
  }
  function glyphNode(parent, cell, size, color, offPx = 0) {
    const g = el('g', {}, parent);
    const inner = el('g', {}, g);
    const common = { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-weight': WEIGHT, 'font-size': f3(size), fill: color };
    if (cell.type === 'tcy') {
      // 纵中横放不下一个字格就整体缩小字号，不横向压扁：文字不做非等比缩放（底座硬规矩第 8 条）
      el('text', { ...common, 'font-size': f3(size * cell.sx) }, inner).textContent = cell.glyph;
    } else if (cell.type === 'rot') {
      inner.setAttribute('transform', 'rotate(90)');
      el('text', common, inner).textContent = cell.glyph;
    } else {
      if (offPx) inner.setAttribute('transform', `translate(0,${f3(offPx)})`);
      el('text', common, inner).textContent = cell.glyph;
    }
    return g;
  }
  for (const u of units) {
    const color = u.kw ? K.fill2 : K.fill;
    u.flt = blurFilter(softShadow);
    u.g = glyphNode(gText, u.cell, fs, color, u.cell.offY * fs);
    if (v3Entrance && u.cell.type !== 'punct') {
      // 墨晕：一团淡墨从字底下晕开，形状用种子取
      const gr = el('radialGradient', { id: `${uid}-ink${u.ci}-${u.k}` }, defs);
      el('stop', { offset: '0', 'stop-color': u.kw ? K.fill2 : K.fill, 'stop-opacity': 0.5 }, gr);
      el('stop', { offset: '0.55', 'stop-color': u.kw ? K.fill2 : K.fill, 'stop-opacity': 0.18 }, gr);
      el('stop', { offset: '1', 'stop-color': u.kw ? K.fill2 : K.fill, 'stop-opacity': 0 }, gr);
      u.ink = el('ellipse', { cx: 0, cy: 0, rx: f3(0.62 * fs * lerp(0.85, 1.2, hash01(seed, 'irx', u.ci, u.k))), ry: f3(0.55 * fs * lerp(0.8, 1.2, hash01(seed, 'iry', u.ci, u.k))), fill: `url(#${uid}-ink${u.ci}-${u.k})` }, gBloom);
      u.inkRot = hash01(seed, 'irot', u.ci, u.k) * 180;
    }
  }
  // 署名：小一号，竖着排在最后一列左边，往下错开两个字
  const sideNodes = [];
  if (authorCol) {
    for (const cell of authorCol.cells) {
      if (cell.type === 'space') continue;
      const node = glyphNode(gSide, cell, AUTHOR_RATIO * fs, K.sub, cell.offY * fs);
      node.setAttribute('transform', `translate(${f3(sideX)},${f3(authorTop + (cell.y0 + cell.h / 2) * fs)})`);
      sideNodes.push({ node, flt: blurFilter(softShadow), y: authorTop + (cell.y0 + cell.h / 2) * fs });
    }
  }
  // 印章：边角用种子抖一点，像手刻的；白文（底是朱红，字是纸色）
  let seal = null;
  if (sealText.length) {
    const S = SEAL_RATIO * fs;
    const g = el('g', {}, gSide);
    const j = (k) => (hash01(seed, 'seal', k) - 0.5) * 0.06 * S;
    const r = 0.08 * S; const h2 = S / 2;
    const d = `M${f3(-h2 + r + j(0))},${f3(-h2 + j(1))} L${f3(h2 - r + j(2))},${f3(-h2 + j(3))} Q${f3(h2)},${f3(-h2)} ${f3(h2 + j(4))},${f3(-h2 + r)} L${f3(h2 + j(5))},${f3(h2 - r)} Q${f3(h2)},${f3(h2)} ${f3(h2 - r)},${f3(h2 + j(6))} L${f3(-h2 + r)},${f3(h2 + j(7))} Q${f3(-h2)},${f3(h2)} ${f3(-h2 + j(8))},${f3(h2 - r)} L${f3(-h2 + j(9))},${f3(-h2 + r)} Q${f3(-h2)},${f3(-h2)} ${f3(-h2 + r + j(0))},${f3(-h2 + j(1))} Z`;
    // 朱砂晕开：一团从章底下散开、越往外越淡的红，不是一道细圈
    let halo = null;
    if (P.sealHalo) {
      const hg = el('radialGradient', { id: `${uid}-halo` }, defs);
      el('stop', { offset: '0.45', 'stop-color': K.accent, 'stop-opacity': 0.55 }, hg);
      el('stop', { offset: '0.75', 'stop-color': K.accent, 'stop-opacity': 0.18 }, hg);
      el('stop', { offset: '1', 'stop-color': K.accent, 'stop-opacity': 0 }, hg);
      halo = el('circle', { cx: 0, cy: 0, r: f3(0.85 * S), fill: `url(#${uid}-halo)` }, g);
    }
    const rect = el('path', { d, fill: K.accent }, g);
    // 1 个字居中；2 个字上下叠；3、4 个字右列先读、再读左列
    const nS = sealText.length;
    const slots = nS === 1 ? [[0, 0, 0.72]] : nS === 2 ? [[0, -0.22, 0.42], [0, 0.22, 0.42]]
      : nS === 3 ? [[0.22, -0.22, 0.4], [0.22, 0.22, 0.4], [-0.22, 0, 0.4]] : [[0.22, -0.22, 0.4], [0.22, 0.22, 0.4], [-0.22, -0.22, 0.4], [-0.22, 0.22, 0.4]];
    const texts = sealText.map((ch, k) => {
      const [sx, sy, sz] = slots[k];
      // 印章字要粗：每次导出只加载一款主字体，900 那一档用不上，就给字加一圈同色描边加粗，像刻出来的
      const tx = el('text', { x: f3(sx * S), y: f3(sy * S), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-weight': WEIGHT, 'font-size': f3(sz * S), fill: K.inner, stroke: K.inner, 'stroke-width': f3(0.035 * S), 'stroke-linejoin': 'round' }, g);
      tx.textContent = ch;
      return tx;
    });
    seal = { g, rect, texts, halo, x: sideX, y: sealTop + S / 2 };
  }

  function setFilter(node, flt, blurPx) {
    if (blurPx > 0.05 || softShadow) {
      flt.b.setAttribute('stdDeviation', f3(Math.max(0, blurPx)));
      node.setAttribute('filter', `url(#${flt.id})`);
    } else node.removeAttribute('filter');
  }

  function seek(time) {
    const tt = clamp(time, 0, duration);
    // 镜头：跟着阅读方向从右往左慢慢平移（画面往右走）
    // 镜头平移：不给整个场景那一组设位移（整组每帧挪零点几个像素时，横屏透明底的乱序渲染偶尔有一两帧在印章边缘差一两列像素，
    // 2026-11-20 实测），把平移量加进每个字、墨晕、署名、印章各自的位移里；远山单独一组跟着挪
    const panX = (P.pan || 0) * W * (tt / duration - 0.5);
    if (gm) gm.setAttribute('transform', `translate(${f3(panX)},0)`);
    for (const u of units) {
      const p = clamp((tt - u.t0) / R.charDur);
      const e = easeOutCubic(p);
      const q = easeInCubic(clamp((tt - u.x0) / xDur));
      let op = e * (1 - q);
      let s = u.sF;
      let blur;
      let dy = -(1 - e) * 0.04 * fs - q * 0.02 * fs; // 入场往下落 4%，出场往上漂 2%
      if (v3Entrance) {
        // 墨晕：从模糊加淡墨里长出来，放大 4% 再回落
        blur = (1 - e) * 0.1 * fs;
        s *= 1 + 0.04 * Math.sin(Math.PI * Math.min(1, p * 1.15));
        op = smoothOp(p) * (1 - q);
      } else blur = (1 - e) * 0.04 * fs;
      // 关键字停留时轻轻发亮：只动大小，不动颜色
      if (u.kw) s *= 1 + 0.012 * Math.sin(2 * Math.PI * 0.8 * (tt - u.t0)) * holdWeight(tt, u.t0 + R.charDur, outroStart);
      u.g.setAttribute('visibility', op > 0.001 ? 'visible' : 'hidden');
      u.g.setAttribute('opacity', f3(op));
      // 不旋转：入场带模糊滤镜，会转的东西带模糊会让乱序渲染对不上（底座硬规矩第 7 条）
      u.g.setAttribute('transform', `translate(${f3(u.x + u.dx + panX)},${f3(u.y + dy)}) scale(${f3(s)})`);
      setFilter(u.g, u.flt, blur);
      if (u.ink) {
        const ki = clamp((tt - u.t0 + 0.05) / 0.8);
        const io = ki > 0 && ki < 1 ? Math.sin(Math.PI * Math.min(1, ki * 1.6)) * (1 - ki) * 1.4 * (1 - q) : 0;
        u.ink.setAttribute('visibility', io > 0.001 ? 'visible' : 'hidden');
        u.ink.setAttribute('opacity', f3(clamp(io)));
        u.ink.setAttribute('transform', `translate(${f3(u.x + panX)},${f3(u.y)}) rotate(${f3(u.inkRot)}) scale(${f3(lerp(0.5, 1.45, easeOutCubic(ki)))})`);
      }
    }
    // 署名淡入
    const qa = easeInCubic(clamp((tt - sideExit) / xDur));
    const pa = easeOutCubic(clamp((tt - authorStart) / 0.4));
    for (const sn of sideNodes) {
      const op = pa * (1 - qa);
      sn.node.setAttribute('visibility', op > 0.001 ? 'visible' : 'hidden');
      sn.node.setAttribute('opacity', f3(op));
      sn.node.setAttribute('transform', `translate(${f3(sideX + panX)},${f3(sn.y)})`);
      setFilter(sn.node, sn.flt, 0);
    }
    // 印章盖下：从大往下按，最后轻震
    if (seal) {
      const k = clamp((tt - sealStart) / 0.25);
      const op = clamp(k * 4) * (1 - qa);
      let s = lerp(1.35, 1, easeOutCubic(k));
      let dx = 0; let dy = 0;
      if (P.sealHalo) {
        const m = shake(tt, { start: sealEnd, amplitude: 0.025 * SEAL_RATIO * fs, duration: 0.12, freq: 28, seed: seed + 99, rotate: 0 });
        dx = m.dx; dy = m.dy;
        const kh = clamp((tt - sealEnd) / 0.45);
        const ho = kh > 0 && kh < 1 ? 0.6 * (1 - kh) ** 1.5 : 0;
        seal.halo.setAttribute('visibility', ho > 0.001 ? 'visible' : 'hidden');
        seal.halo.setAttribute('opacity', f3(ho));
        seal.halo.setAttribute('transform', `scale(${f3(lerp(0.8, 1.5, easeOutCubic(kh)))})`);
      }
      seal.g.setAttribute('visibility', op > 0.001 ? 'visible' : 'hidden');
      seal.g.setAttribute('transform', `translate(${f3(seal.x + dx + panX)},${f3(seal.y + dy)}) scale(${f3(s)})`);
      // 透明度写在章面和字上，不写在整组上
      seal.rect.setAttribute('opacity', f3(op));
      for (const tx of seal.texts) tx.setAttribute('opacity', f3(op));
    }
  }
  function smoothOp(p) { return clamp(p * 1.6) ** 1.4; }

  const issues = [...checkLineBreaks(columns, ctx.text, { segment: ctx.segment }), ...vIssues];
  const layout = {
    fontSize: fs,
    lines: columns.map((c) => c.text),
    linesDetail: cols.map((c, i) => ({ text: c.text, index: c.index, paragraph: c.paragraph, column: i, x: colX(i), length: c.len * fs, cells: c.cells.map((x) => `${x.type}:${x.glyph ?? ''}`) })),
    forced: [],
    issues,
    warnings: [...icuBreakWarnings(columns, ctx.text), ...warnings],
    segmentation: ctx.segmentation.sources,
    emphasis: units.filter((u) => u.kw).map((u) => u.cell.src).join(''),
    units: units.length,
    writingMode: 'vertical-rl',
    v3Entrance,
  };
  seek(0);
  return { timeline, layout, seek, destroy() { svg.remove(); } };
}
