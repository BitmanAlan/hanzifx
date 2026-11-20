// 023 杂志封面标题（Magazine Cover）· 字效
// 杂志封面的版式：刊头小字和细线、宋体大标题（关键词换强调色，最后补一道细线）、字距拉开的英文、菱形细线、副标题、期号，大量留白。
// 各部分依次淡入，字距从拉开慢慢收拢。V3「特刊」：标题背后一个巨大的描边期号缓缓升起，右边一列竖排小字，标题逐字从随机的位置收拢。
// C3、C4 自带纸面底色（导出透明底时不画）。
// 参数（见 meta.json）：text 大标题、en、kicker、sub、issue、side、look、palette、rhythm、font、size、flair、seed。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；透明度只设在单个图形上；不用模糊滤镜；
//   字距收拢写成每个字自己的位移，不缩放文字；位移、缩放的进度过死区，不出现「只挪零点几个像素」的帧。
import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, easeOutCubic, easeInCubic, easeOutBack } from '../../engine/src/lib/ease.js';
import { graphemes, fitText, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');
const dz = (e) => clamp((e - 0.01) / 0.98);
const s1 = (s) => (Math.abs(s - 1) < 0.003 ? 1 : s);

const OPEN_P = new Set([...'（《「『【〔〈〖“‘']);
const CLOSE_P = new Set([...'，。、；：）》」』】〕〉〗”’']);
/** 要读的字只在三处挤（模板第 6 节）：行尾的收尾标点、行首的开引号开括号、两个标点连用 */
function squeezeAt(gs, i) {
  const ch = gs[i];
  if (CLOSE_P.has(ch)) return i === gs.length - 1 || FULLWIDTH_PUNCT.has(gs[i + 1]);
  if (OPEN_P.has(ch)) return i === 0 || FULLWIDTH_PUNCT.has(gs[i - 1]);
  return false;
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W; const squareish = Math.abs(W - H) / Math.max(W, H) < 0.3;
  const flair = clamp(P.flair ?? 0);
  const k = R.speed ?? 1;
  const h = (...a) => hash01(seed, ...a);
  const famT = ctx.fontFamily(P.font);
  const famB = ctx.fontFamily('notoserif-semibold');
  const famN = ctx.fontFamily('notoserif-black');
  const paper = ['C3', 'C4'].includes(P.palette) && !ctx.transparent;
  const str = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const en = str(P.en); const kicker = str(P.kicker); const sub = str(P.sub); const issue = str(P.issue).replace(/\s+/g, ''); const side = str(P.side).replace(/\s+/g, '');
  const m = 0.05 * short;

  // ---------- 量字 ----------
  const cv = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  const meas = (fam, ch, sq) => {
    const key = fam + (sq ? '1' : '0') + ch;
    if (cache.has(key)) return cache.get(key);
    cv.font = `100px ${fam}`; cv.textAlign = 'center';
    const mm = cv.measureText(ch);
    let r;
    if (sq) { const L = -mm.actualBoundingBoxLeft / 100; const Rr = mm.actualBoundingBoxRight / 100; r = { adv: Math.max(0.5, Rr - L + 0.16), off: 0.08 - L }; }
    else r = { adv: mm.width / 100, off: mm.width / 200 };
    cache.set(key, r);
    return r;
  };
  /** 一行字排开：每个字的中心位置（相对行的左边）和总宽；tr 是字距（按字号的比例）；空格只占位置不出字 */
  const lay = (fam, s, fs, tr, squeeze = false) => {
    const gs = graphemes(s);
    let x = 0;
    const chars = gs.map((ch, i) => {
      const mm = meas(fam, ch, squeeze && squeezeAt(gs, i));
      const c = { ch, x: x + mm.off * fs, sp: /^\s+$/.test(ch) };
      x += mm.adv * fs + (i < gs.length - 1 ? tr * fs : 0);
      return c;
    });
    return { chars, w: x };
  };

  // ---------- 版式 ----------
  const colW = Math.min(W * 0.84, 1.25 * H);
  const cx = W / 2;
  const kickerY = (vertical ? 0.1 : 0.12) * H;
  const fsK = 0.026 * short; const fsE0 = 0.03 * short; const fsS0 = 0.036 * short; const fsF = 0.03 * short;
  const trT = 0.04; const trK = 0.22; const trE = 0.3; const trS = 0.14;
  const ruleY = kickerY + 0.045 * short;
  const footerY = (vertical ? 0.76 : squareish ? 0.84 : 0.86) * H;
  // 大标题：按词断行，最多两行，撑满版心；字距 0.04 个字，行距 1.2
  const fit = fitText(ctx.text, {
    fs0: clamp(P.size ?? 0.19, 0.1, 0.26) * short,
    measureAt: (px) => (s) => lay(famT, s, px, trT).w + trT * px,
    maxWidthAt: () => colW,
    maxLines: 2, maxHeight: 0.34 * H, lineHeight: 1.2, segment: ctx.segment,
  });
  const fsT = fit.fs; const lhT = 1.2 * fsT; // 行距留出关键词下面那道线的位置
  const enL = en ? lay(famB, en, fsE0, trE) : null; const fsE = enL && enL.w > colW ? fsE0 * colW / enL.w : fsE0;
  const enLay = en ? lay(famB, en, fsE, trE) : null;
  const subL = sub ? lay(famB, sub, fsS0, trS, true) : null; const fsS = subL && subL.w > colW ? fsS0 * colW / subL.w : fsS0;
  const subLay = sub ? lay(famB, sub, fsS, trS, true) : null;
  const kickL = kicker ? lay(famB, kicker, fsK, trK) : null;
  // 中间一块（标题、英文、菱形细线、副标题）的高度，放在刊头和期号之间，偏上一点
  const gapE = 0.07 * short; const gapO = 0.05 * short; const gapS = 0.055 * short;
  const titleH = fit.lines.length * lhT;
  const blockH = titleH + (en ? gapE : 0) + (en || sub ? gapO : 0) + (sub ? gapS : 0);
  const midTop = ruleY + 0.06 * short; const midBot = footerY - 0.07 * short;
  const want = (vertical ? 0.42 : squareish ? 0.44 : 0.46) * H;
  const blockTop = clamp(want - blockH / 2, midTop, Math.max(midTop, midBot - blockH));
  const titleTop = blockTop;
  const enY = titleTop + titleH + gapE * 0.7;
  const ornY = titleTop + titleH + (en ? gapE : 0) + gapO * 0.5;
  const subY = ornY + gapS;
  // 标题的字：逐字摆开，记下关键词
  const titleChars = [];
  const kwBars = [];
  fit.lines.forEach((ln, li) => {
    const L = lay(famT, ln.text, fsT, trT, true);
    const x0 = cx - L.w / 2;
    const y = titleTop + (li + 0.5) * lhT;
    let off = 0; let run = null;
    L.chars.forEach((c, j) => {
      const kw = ctx.isEmphasis(ln.paragraph, ln.index + off);
      off += c.ch.length;
      const o = { ch: c.ch, x: x0 + c.x, y, li, j, kw, n: titleChars.length, lineCx: cx, sp: c.sp };
      titleChars.push(o);
      const half = meas(famT, c.ch, false).adv * fsT / 2;
      if (kw && !c.sp) { if (!run) { run = { li, y, x0: o.x - half, x1: o.x + half }; kwBars.push(run); } else run.x1 = o.x + half; }
      else run = null;
    });
  });
  // V3：标题背后的描边大期号；右边一列竖排小字
  const fsN = 0.62 * short;
  const numL = flair > 0 && issue ? lay(famN, issue, fsN, -0.02) : null;
  const numCx = numL ? clamp(cx + colW * 0.12, 1.6 * m + numL.w / 2, W - 1.6 * m - numL.w / 2) : 0;
  const numCy = clamp(titleTop + titleH * 0.35, m + 0.4 * fsN, H - m - 0.4 * fsN);
  const fsSide = 0.026 * short;
  const sideX = W - Math.max(m + fsSide / 2, (W - colW) / 4);
  const sideGs = flair > 0 && side ? graphemes(side) : [];
  const sideY0 = ruleY + 0.08 * short;

  // ---------- 时间轴 ----------
  const nT = titleChars.length;
  const tRule = 0.1 * k; const tKick = 0.2 * k; const tTitle = 0.35 * k; const tEn = 0.9 * k; const tOrn = 1.1 * k; const tSub = 1.25 * k; const tFoot = 1.4 * k; const tSide = 0.8 * k;
  const titleDelay = (c) => tTitle + c.n * 0.06 * k + flair * h('td', c.n) * 0.18 * k;
  const tBar = tTitle + nT * 0.06 * k + 1.0 * k;
  const introEnd = Math.max(tBar + 0.5 * k, tFoot + 0.8 * k, tSub + 0.9 * k);
  const holdEnd = introEnd + 2.6 + (R.holdExtra ?? 0);
  const outDur = 0.6;
  const outroEnd = holdEnd + outDur;
  const duration = outroEnd + 0.1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '依次淡入、字距收拢', start: 0, end: introEnd },
      { name: 'hold', label: '停留', start: introEnd, end: holdEnd },
      { name: 'outro', label: '淡出', start: holdEnd, end: outroEnd },
    ],
    beats: [{ t: tTitle, name: 'title', label: '标题开始出来' }, { t: tBar, name: 'keyword', label: '关键词补线' }],
    units: titleChars.filter((c) => !c.sp).map((c, i) => ({ i, char: c.ch, enter: titleDelay(c), exitStart: holdEnd, exitEnd: outroEnd })),
  };

  // ---------- 搭 SVG ----------
  const uid = ctx.uid ? `${ctx.uid}-mc` : 'mc' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  if (paper) {
    // 纸面：底色加一层很淡的暗角（径向渐变，不用滤镜）；V3 再加一圈细边框
    const g = el('radialGradient', { id: `${uid}-vig`, cx: '50%', cy: '45%', r: '75%' }, defs);
    el('stop', { offset: '0.6', 'stop-color': '#000000', 'stop-opacity': 0 }, g);
    el('stop', { offset: '1', 'stop-color': '#000000', 'stop-opacity': 0.14 }, g);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: K.bg }, svg);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${uid}-vig)` }, svg);
  }
  const frame = paper && flair > 0 ? el('rect', { x: f3(m * 0.7), y: f3(m * 0.7), width: f3(W - 1.4 * m), height: f3(H - 1.4 * m), fill: 'none', stroke: K.sub, 'stroke-width': f3(0.0016 * short) }, svg) : null;
  const num = numL ? numL.chars.filter((c) => !c.sp).map((c) => { const e = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famN, 'font-size': f3(fsN), fill: 'none', stroke: K.accent, 'stroke-width': f3(0.0035 * short) }, svg); e.textContent = c.ch; return { e, x: numCx - numL.w / 2 + c.x }; }) : [];
  const rule = el('rect', { x: f3(-colW / 2), y: f3(-(0.0018 + 0.0022 * flair) * short / 2), width: f3(colW), height: f3((0.0018 + 0.0022 * flair) * short), fill: flair > 0 ? K.accent : K.sub }, svg);
  const mk = (fam, fs, fill, ch) => { const e = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': fam, 'font-size': f3(fs), fill }, svg); e.textContent = ch; return e; };
  const kickE = kickL ? kickL.chars.filter((c) => !c.sp).map((c) => ({ e: mk(famB, fsK, K.sub, c.ch), x: cx - kickL.w / 2 + c.x })) : [];
  for (const c of titleChars) if (!c.sp) c.e = mk(famT, fsT, c.kw ? K.accent : K.fill, c.ch);
  const bars = kwBars.map((b) => ({ ...b, e: el('rect', { x: 0, y: f3(-0.018 * fsT), width: f3(b.x1 - b.x0), height: f3(0.036 * fsT), fill: K.accent }, svg) }));
  const enE = enLay ? enLay.chars.filter((c) => !c.sp).map((c) => ({ e: mk(famB, fsE, K.fill, c.ch), x: cx - enLay.w / 2 + c.x })) : [];
  const ornW = 0.16 * colW; const dia = 0.012 * short;
  const orn = en || sub ? {
    l: el('rect', { x: f3(-ornW / 2), y: f3(-0.0008 * short), width: f3(ornW / 2 - dia * 1.4), height: f3(0.0016 * short), fill: K.sub }, svg),
    r: el('rect', { x: f3(dia * 1.4), y: f3(-0.0008 * short), width: f3(ornW / 2 - dia * 1.4), height: f3(0.0016 * short), fill: K.sub }, svg),
    d: el('path', { d: `M0 ${f3(-dia)} L${f3(dia)} 0 L0 ${f3(dia)} L${f3(-dia)} 0 Z`, fill: K.accent }, svg),
  } : null;
  const subE = subLay ? subLay.chars.filter((c) => !c.sp).map((c) => ({ e: mk(famB, fsS, K.sub, c.ch), x: cx - subLay.w / 2 + c.x })) : [];
  const footL = issue ? lay(famN, issue, fsF, 0.1) : null;
  const footE = footL ? footL.chars.map((c) => ({ e: mk(famN, fsF, K.sub, c.ch), x: cx - footL.w / 2 + c.x })) : [];
  const dashW = 0.05 * short; const dashGap = 0.025 * short;
  const dashes = footL ? [-1, 1].map((s) => ({ s, e: el('rect', { x: f3(-dashW / 2), y: f3(-0.0008 * short), width: f3(dashW), height: f3(0.0016 * short), fill: K.sub }, svg) })) : [];
  const sideE = sideGs.map((ch, j) => ({ e: mk(famB, fsSide, K.sub, ch), y: sideY0 + j * 1.3 * fsSide }));

  // 一组字的淡入加字距收拢：e 是进度（过了死区），spread 是开始时字距拉开的倍数
  const gather = (x, center, e, spread) => center + (x - center) * (1 + spread * (1 - e));
  // 拉开的倍数有上限：一行越宽，两端的字推得越远，最外侧的字拉开时也不能出画面（开发时标题第一个字被推出了左边）
  const capSpread = (rowW, fs, spread) => clamp(Math.min(spread, (W / 2 - m - fs * 0.6) / Math.max(rowW / 2, 1) - 1), 0, spread);
  const kickSp = kickL ? capSpread(kickL.w, fsK, 0.6) : 0;
  const enSp = enLay ? capSpread(enLay.w, fsE, 0.5) : 0;
  const subSp = subLay ? capSpread(subLay.w, fsS, 0.25) : 0;
  const lineW = new Map();
  for (const c of titleChars) lineW.set(c.li, Math.max(lineW.get(c.li) || 0, 2 * Math.abs(c.x - c.lineCx) + fsT));
  const titleSp = (li) => capSpread(lineW.get(li) || 0, fsT, lerp(0.5, 1.0, flair));

  // ---------- 每一帧 ----------
  function seek(time) {
    const t = clamp(time, 0, duration);
    const qOut = dz(easeInCubic(clamp((t - holdEnd) / outDur)));
    const outOp = 1 - qOut;
    const outSpread = 0.12 * qOut; // 出场时字距再微微散开
    const prog = (t0, dur) => dz(easeOutCubic(clamp((t - t0) / dur)));
    // 细线：从中间往两边画出来
    const pr = prog(tRule, 0.7 * k);
    vis(rule, pr > 0 && outOp > 0.002);
    set(rule, { transform: `translate(${f3(cx)},${f3(ruleY)}) scale(${f3(Math.max(pr, 0.001))},1)`, opacity: f3(outOp) });
    if (frame) set(frame, { opacity: f3(0.5 * prog(0, 0.8 * k) * outOp) });
    // 刊头
    const pk = prog(tKick, 0.9 * k);
    for (const c of kickE) {
      vis(c.e, pk > 0 && outOp > 0.002);
      set(c.e, { transform: `translate(${f3(gather(c.x, cx, pk, kickSp) + (c.x - cx) * outSpread)},${f3(kickerY)})`, opacity: f3(pk * outOp) });
    }
    // 大标题：逐字淡入，字距收拢、往上落定；V3 从按种子错开的位置收拢
    for (const c of titleChars) {
      if (c.sp) continue;
      const u = (t - titleDelay(c)) / (1.4 * k);
      const e = dz(easeOutCubic(clamp(u)));
      const on = u > 0 && outOp > 0.002;
      vis(c.e, on);
      if (!on) continue;
      const spread = titleSp(c.li);
      const dy = (1 - e) * (0.08 + flair * (h('dy', c.n) - 0.3) * 0.5) * fsT;
      set(c.e, { transform: `translate(${f3(gather(c.x, c.lineCx, e, spread) + (c.x - c.lineCx) * outSpread)},${f3(c.y + dy)})`, opacity: f3(clamp(u * 1.6) * outOp) });
    }
    // 关键词下面那道细线
    for (const b of bars) {
      const pb = prog(tBar + b.li * 0.1 * k, 0.5 * k);
      vis(b.e, pb > 0 && outOp > 0.002);
      set(b.e, { transform: `translate(${f3(b.x0)},${f3(b.y + 0.58 * fsT)}) scale(${f3(Math.max(pb, 0.001))},1)`, opacity: f3(outOp) });
    }
    // 英文
    const pe = prog(tEn, 1.2 * k);
    for (const c of enE) {
      vis(c.e, pe > 0 && outOp > 0.002);
      set(c.e, { transform: `translate(${f3(gather(c.x, cx, pe, enSp) + (c.x - cx) * outSpread)},${f3(enY)})`, opacity: f3(pe * outOp) });
    }
    // 菱形细线
    if (orn) {
      const po = prog(tOrn, 0.6 * k);
      for (const e of [orn.l, orn.r]) { vis(e, po > 0 && outOp > 0.002); set(e, { transform: `translate(${f3(cx)},${f3(ornY)}) scale(${f3(Math.max(po, 0.001))},1)`, opacity: f3(outOp) }); }
      const pd = s1(easeOutBack(clamp((t - tOrn - 0.2 * k) / (0.4 * k))));
      vis(orn.d, pd > 0.001 && outOp > 0.002);
      set(orn.d, { transform: `translate(${f3(cx)},${f3(ornY)}) rotate(0) scale(${f3(Math.max(pd, 0.001))})`, opacity: f3(outOp) });
    }
    // 副标题
    const ps = prog(tSub, 0.9 * k);
    for (const c of subE) {
      vis(c.e, ps > 0 && outOp > 0.002);
      set(c.e, { transform: `translate(${f3(gather(c.x, cx, ps, subSp) + (c.x - cx) * outSpread)},${f3(subY + (1 - ps) * 0.3 * fsS)})`, opacity: f3(ps * outOp) });
    }
    // 期号：两边两段细线，中间数字
    const pf = prog(tFoot, 0.8 * k);
    for (const c of footE) { vis(c.e, pf > 0 && outOp > 0.002); set(c.e, { transform: `translate(${f3(c.x)},${f3(footerY)})`, opacity: f3(pf * outOp) }); }
    for (const d of dashes) {
      vis(d.e, pf > 0 && outOp > 0.002);
      const dx = d.s * (footL.w / 2 + dashGap + dashW / 2);
      set(d.e, { transform: `translate(${f3(cx + dx)},${f3(footerY)}) scale(${f3(Math.max(pf, 0.001))},1)`, opacity: f3(outOp) });
    }
    // V3：描边大期号缓缓升起；竖排小字一个个淡入
    const pn = dz(easeOutCubic(clamp((t - 0.2 * k) / (1.8 * k))));
    for (const c of num) {
      vis(c.e, pn > 0 && outOp > 0.002);
      set(c.e, { transform: `translate(${f3(c.x)},${f3(numCy + (1 - pn) * 0.05 * short)})`, opacity: f3(0.55 * pn * outOp) });
    }
    sideE.forEach((c, j) => {
      const p = prog(tSide + j * 0.06 * k, 0.6 * k);
      vis(c.e, p > 0 && outOp > 0.002);
      set(c.e, { transform: `translate(${f3(sideX)},${f3(c.y + (1 - p) * 0.4 * fsSide)})`, opacity: f3(p * outOp) });
    });
  }

  const issues = checkLineBreaks(fit.lines, ctx.text, { segment: ctx.segment });
  const warnings = icuBreakWarnings(fit.lines, ctx.text);
  if (fit.fs < 0.6 * clamp(P.size ?? 0.19, 0.1, 0.26) * short) warnings.push({ type: 'too-long', detail: `标题太长，字号缩到了设定的 ${Math.round((fit.fs / (clamp(P.size ?? 0.19, 0.1, 0.26) * short)) * 100)}%` });
  seek(0);
  return {
    timeline,
    layout: { fontSize: fsT, lines: fit.lines.map((l) => l.text), forced: fit.forced || [], issues, warnings, segmentation: ctx.segmentation ? ctx.segmentation.sources : [], units: nT, paper },
    seek,
    destroy() { svg.remove(); },
  };
}
