// 021 聊天气泡对话（Chat Bubbles）· 字效
// 按脚本排出一整段对话：每行一条「名字：内容」，名字是「我」的放右边；左右气泡一条条弹出来，对方打字时先冒「正在输入」的三个点；
// 气泡宽度跟着字数变、按词断行；消息多了整段往上滚，最上面的在碰到画面边缘之前淡掉。V3 是漫画风：粗描边、硬投影，最后一条当包袱。
// 参数（见 meta.json）：text、look、palette、rhythm、font、avatars、names、typing、punch、size、flair、seed。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；透明度只设在单个图形上；不用模糊滤镜；
//   滚动、弹出、震动都写进每个图形自己的 transform，不挪整组；文字只做等比缩放；
//   位移、缩放、旋转的进度过死区，不出现「只挪零点几个像素」「只歪零点零几度」的帧（这种帧的抗锯齿会随机画成两种）。
// 气泡、头像、三个点都是自己画的，不照任何聊天软件的样子做：没有尾巴，靠外侧下角的小圆角分左右。
import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, spring, easeOutCubic, easeInCubic, easeOutBack } from '../../engine/src/lib/ease.js';
import { graphemes, breakParagraph, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { mix } from '../../engine/src/lib/color.js';
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
/** 死区：进度不到 1% 当成 0，超过 99% 当成 1，中间连续接上 */
const dz = (e) => clamp((e - 0.01) / 0.98);
const s1 = (s) => (Math.abs(s - 1) < 0.003 ? 1 : s);
const snap = (v, eps) => (Math.abs(v) < eps ? 0 : v);
const bump = (u) => (u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0);

/** 圆角矩形，四个角各自的半径：[左上, 右上, 右下, 左下] */
function roundRect(w, h, [a, b, c, d]) {
  const m = Math.min(w, h) / 2;
  [a, b, c, d] = [a, b, c, d].map((r) => Math.min(r, m));
  return `M${f3(a)} 0 L${f3(w - b)} 0 Q${f3(w)} 0 ${f3(w)} ${f3(b)} L${f3(w)} ${f3(h - c)} Q${f3(w)} ${f3(h)} ${f3(w - c)} ${f3(h)} L${f3(d)} ${f3(h)} Q0 ${f3(h)} 0 ${f3(h - d)} L0 ${f3(a)} Q0 0 ${f3(a)} 0 Z`;
}

const OPEN_P = new Set([...'（《「『【〔〈〖“‘']);
const CLOSE_P = new Set([...'，。、；：）》」』】〕〉〗”’']);
/** 要读的字只在三处挤（模板第 6 节）：行尾的收尾标点、行首的开引号开括号、两个标点连用。问号感叹号、句中单个的逗号句号都不挤 */
function squeezeAt(gs, i) {
  const ch = gs[i];
  if (CLOSE_P.has(ch)) return i === gs.length - 1 || FULLWIDTH_PUNCT.has(gs[i + 1]);
  if (OPEN_P.has(ch)) return i === 0 || FULLWIDTH_PUNCT.has(gs[i - 1]);
  return false;
}
const isMe = (n) => /^(我|me|Me|ME)$/.test(n);
const EMOJI = /\p{Extended_Pictographic}/u;

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const flair = clamp(P.flair ?? 0);
  const k = R.speed ?? 1;
  const h = (...a) => hash01(seed, ...a);
  const family = ctx.fontFamily(P.font);
  const f0 = clamp(P.size ?? 0.05, 0.03, 0.06) * short;
  const m = 0.05 * short; // 离画面边缘至少留这么多

  // ---------- 解析对话：每段一条消息，「名字：内容」 ----------
  const paras = String(ctx.text || '').replace(/\r/g, '').split('\n');
  const msgs = [];
  paras.forEach((raw, pi) => {
    const para = raw.trim();
    if (!para) return;
    const mt = /^([^：:\s，。！？、,.!?]{1,4})\s*[：:]\s*/.exec(para);
    const named = mt && mt[0].length < para.length;
    msgs.push({ pi, para, name: named ? mt[1] : null, bodyStart: named ? mt[0].length : 0 });
  });
  for (const mg of msgs) mg.body = mg.para.slice(mg.bodyStart);
  // 左右：名字是「我」的放右边；没有「我」，第二个出现的人放右边；没写名字的接着上一条；整段都没名字就左右交替
  const names = [...new Set(msgs.filter((x) => x.name).map((x) => x.name))];
  if (!names.length) msgs.forEach((x, i) => { x.side = i % 2 ? 'R' : 'L'; x.name = x.side === 'R' ? '我' : '对方'; x.anon = true; });
  else {
    const rightName = names.find(isMe) || (names.length >= 2 ? names[1] : null);
    let prev = null;
    for (const x of msgs) { if (!x.name) x.name = prev ? prev.name : names[0]; x.side = x.name === rightName ? 'R' : 'L'; prev = x; }
  }
  const leftNames = new Set(msgs.filter((x) => x.side === 'L').map((x) => x.name));
  const showNames = !msgs.some((x) => x.anon) && (P.names === 'always' || (P.names !== 'never' && leftNames.size > 1));
  const showAvatars = P.avatars !== false && !msgs.some((x) => x.anon); // 整段都没写名字就不放头像（没有字可写）
  const useTyping = P.typing !== false;
  const punchOn = flair > 0 && P.punch !== false && msgs.length >= 2;

  // ---------- 量字 ----------
  const cv = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  const meas = (ch, sq) => {
    const key = (sq ? '1' : '0') + ch;
    if (cache.has(key)) return cache.get(key);
    cv.font = `100px ${family}`; cv.textAlign = 'center';
    const mm = cv.measureText(ch);
    let r;
    if (sq) { const L = -mm.actualBoundingBoxLeft / 100; const Rr = mm.actualBoundingBoxRight / 100; r = { adv: Math.max(0.5, Rr - L + 0.16), off: 0.08 - L }; }
    else r = { adv: mm.width / 100, off: mm.width / 200 };
    cache.set(key, r);
    return r;
  };
  const textEm = (s) => graphemes(s).reduce((a, g) => a + meas(g, false).adv, 0);

  // ---------- 版式 ----------
  const colW = Math.min(W - 2 * m, vertical ? W : 0.92 * H); // 横屏时对话只占中间一栏
  const colX0 = (W - colW) / 2; const colX1 = colX0 + colW;
  const D = 1.75 * f0; const gapA = 0.32 * f0;
  const avatarSpace = showAvatars ? D + gapA : 0;
  const topLim = (vertical ? 0.13 : 0.1) * H;
  const botLim = (vertical ? 0.8 : 0.85) * H;
  const nameH = 0.85 * f0;
  let y = 0;
  const allCheckLines = [];
  const warnings = [];
  msgs.forEach((x, i) => {
    x.i = i;
    x.punch = punchOn && i === msgs.length - 1;
    const f = x.punch ? 1.22 * f0 : f0;
    x.f = f; x.padX = 0.72 * f; x.padY = 0.5 * f; x.lineH = 1.36 * f;
    const maxTextW = colW - avatarSpace - 2 * x.padX - 0.14 * colW;
    // 分词用整段（带说话人前缀）查底座预先算好的结果，再截出正文那部分重新编号，跟检查用的同一套
    const full = ctx.segment ? ctx.segment(x.para) : null;
    const bodyWords = full ? full.filter((w) => w.index >= x.bodyStart).map((w) => ({ text: w.text, index: w.index - x.bodyStart })) : null;
    const segBody = (s) => (s === x.body && bodyWords && bodyWords.map((w) => w.text).join('') === x.body ? bodyWords : (ctx.segment ? ctx.segment(s) : null));
    const br = breakParagraph(x.body, (s) => textEm(s) * f, maxTextW, { segment: segBody });
    x.lines = br.lines.map((ln, li) => {
      const gs = graphemes(ln.text);
      let acc = 0; let off16 = 0;
      const chars = gs.map((ch, j) => {
        const mm = meas(ch, squeezeAt(gs, j));
        const c = { ch, x: (acc + mm.off) * f, kw: ctx.isEmphasis(x.pi, x.bodyStart + ln.index + off16), j };
        acc += mm.adv; off16 += ch.length;
        if (EMOJI.test(ch)) warnings.push({ type: 'emoji', detail: `第 ${x.pi + 1} 行有表情符号「${ch}」：本库的字体里没有表情，导出会因为缺字失败，先删掉或换成文字` });
        return c;
      });
      return { text: ln.text, index: ln.index, chars, w: acc * f, li };
    });
    x.lines.forEach((ln, li) => allCheckLines.push({ text: (li === 0 ? x.para.slice(0, x.bodyStart) : '') + ln.text, index: li === 0 ? 0 : x.bodyStart + ln.index, paragraph: x.pi }));
    x.textW = Math.max(...x.lines.map((l) => l.w), 0);
    x.bw = Math.max(x.textW + 2 * x.padX, 1.9 * f);
    x.bh = 2 * x.padY + f + (x.lines.length - 1) * x.lineH;
    x.runStart = i === 0 || msgs[i - 1].name !== x.name;
    x.label = showNames && x.side === 'L' && x.runStart;
    x.avatar = showAvatars && x.runStart;
    y += i === 0 ? 0 : x.runStart ? 0.8 * f0 : 0.3 * f0;
    if (x.label) { x.labelY = y; y += nameH; }
    x.top = y; y += x.bh; x.bottom = y;
    x.x0 = x.side === 'L' ? colX0 + avatarSpace : colX1 - avatarSpace - x.bw;
    x.ax = x.side === 'L' ? colX0 + D / 2 : colX1 - D / 2;
  });
  const contentH = y;
  const availH = botLim - topLim;
  const baseY = contentH <= availH ? topLim + (availH - contentH) * 0.45 : topLim;

  // ---------- 时间轴 ----------
  const indW = 2.8 * f0; const indH = 1.55 * f0;
  let t = 0.2 * k;
  msgs.forEach((x) => {
    x.typing = useTyping && x.side === 'L';
    const len = graphemes(x.body).length;
    if (x.typing) { x.tType = t; x.tPop = t + clamp(0.55 + 0.035 * len, 0.55, 1.2) * k; } else { x.tType = null; x.tPop = t + 0.12 * k; }
    t = x.tPop + clamp(0.55 + 0.085 * len, 0.7, 2.2) * k;
  });
  const last = msgs[msgs.length - 1];
  const tLast = last ? last.tPop : 0.3;
  const holdStart = tLast + 0.45 * k;
  const holdEnd = tLast + (1.6 + (punchOn ? 0.6 : 0)) * k + (R.holdExtra ?? 0);
  const outDur = 0.4;
  const outroEnd = holdEnd + outDur;
  const duration = outroEnd + 0.1;
  // 滚动：每冒出一条（或者一个「正在输入」），就看最新那条的下边缘有没有出对话区，出了就往上滚。
  // 气泡出来之前 0.25 秒先滚，把位置腾出来再弹出：先弹出再滚的话，横屏时新气泡刚冒出来下边缘就贴到画面底边了（开发时踩过）
  const sd = 0.25 * k;
  const events = [];
  for (const x of msgs) {
    if (x.typing) events.push({ t: x.tType, target: Math.max(0, baseY + x.top + indH - botLim) });
    events.push({ t: Math.max(0, x.tPop - sd), target: Math.max(0, baseY + x.bottom - botLim) });
  }
  events.sort((a, b) => a.t - b.t);
  const scrollAt = (tt) => {
    let v = 0;
    for (const e of events) {
      if (tt < e.t) break;
      v = v + (e.target - v) * dz(easeOutCubic(clamp((tt - e.t) / sd)));
    }
    return v;
  };
  const units = [];
  for (const x of msgs) for (const ln of x.lines) for (const c of ln.chars) units.push({ i: units.length, char: c.ch, enter: x.tPop + 0.08 * k + c.j * 0.014 * k, exitStart: holdEnd, exitEnd: outroEnd });
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '第一条出来', start: 0, end: msgs.length ? msgs[0].tPop + 0.3 * k : 0.5 },
      { name: 'chat', label: `${msgs.length} 条消息`, start: msgs.length ? msgs[0].tPop + 0.3 * k : 0.5, end: holdStart },
      { name: 'hold', label: '停留', start: holdStart, end: holdEnd },
      { name: 'outro', label: '出场', start: holdEnd, end: outroEnd },
    ],
    beats: msgs.map((x) => ({ t: x.tPop, name: x.punch ? 'punch' : 'message', label: `${x.name}：${x.body.slice(0, 8)}` })),
    units,
  };

  // ---------- 搭 SVG ----------
  // 层：投影 → 气泡 → 关键词下面的线 → 字 → 头像和名字 → 包袱的炸线。这几个 <g> 只当容器
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const Lsh = el('g', {}, svg); const Lb = el('g', {}, svg); const Lm = el('g', {}, svg); const Lt = el('g', {}, svg); const La = el('g', {}, svg); const Lfx = el('g', {}, svg);
  const outlineW = flair * 0.07 * f0;
  const shOff = { x: lerp(0, 0.1, flair) * f0, y: lerp(0.06, 0.12, flair) * f0 };
  const shOp = lerp(0.14, 0.9, flair);
  // 头像颜色：右边（我）一种；左边每个人轮着用三种，群聊里分得清谁是谁
  const leftList = [...leftNames];
  const leftColors = [K.accent, mix(K.accent, K.fill2, 0.55), mix(K.accent, K.sub, 0.6)];
  const avColorOf = (x) => (x.side === 'R' ? mix(K.fill2, '#000000', 0.22) : leftColors[leftList.indexOf(x.name) % leftColors.length]);
  for (const x of msgs) {
    const small = 0.22 * x.f; const big = 0.9 * x.f;
    const radii = x.side === 'L' ? [big, big, big, small] : [big, big, small, big];
    const d = roundRect(x.bw, x.bh, radii);
    x.sh = el('path', { d, fill: K.shadow }, Lsh);
    x.bub = el('path', { d, fill: x.side === 'L' ? K.bg : K.fill2, ...(outlineW > 0 ? { stroke: K.outer, 'stroke-width': f3(outlineW), 'stroke-linejoin': 'round' } : {}) }, Lb);
    x.marks = [];
    for (const ln of x.lines) {
      // 关键词：同一行里连着的关键词字合成一段，下面划一道线
      let run = null;
      for (const c of ln.chars) {
        if (c.kw) { if (!run) { run = { li: ln.li, x0: c.x - meas(c.ch, false).adv * x.f / 2, x1: c.x + meas(c.ch, false).adv * x.f / 2 }; x.marks.push(run); } else run.x1 = c.x + meas(c.ch, false).adv * x.f / 2; }
        else run = null;
      }
    }
    // 关键词下面划一道实心粗线：左边气泡用强调色；右边是彩色气泡，用字的颜色，哪套配色都看得清
    for (const mk of x.marks) mk.e = el('rect', { x: 0, y: 0, width: f3(mk.x1 - mk.x0 + 0.12 * x.f), height: f3(0.13 * x.f), rx: f3(0.065 * x.f), fill: x.side === 'L' ? K.accent : K.inner }, Lm);
    const txtColor = x.side === 'L' ? K.fill : K.inner;
    for (const ln of x.lines) for (const c of ln.chars) {
      c.e = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(x.f), fill: c.kw && x.side === 'L' ? K.accent : txtColor }, Lt);
      c.e.textContent = c.ch;
    }
    if (x.avatar) {
      x.avC = el('circle', { cx: 0, cy: 0, r: f3(D / 2), fill: avColorOf(x), ...(outlineW > 0 ? { stroke: K.outer, 'stroke-width': f3(outlineW) } : {}) }, La);
      x.avT = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(0.8 * f0), fill: '#FFFFFF' }, La);
      x.avT.textContent = graphemes(x.name)[0];
    }
    if (x.label) { x.lab = el('text', { x: 0, y: 0, 'dominant-baseline': 'central', 'font-family': family, 'font-size': f3(0.6 * f0), fill: K.sub }, La); x.lab.textContent = x.name; }
    if (x.typing) {
      const idr = roundRect(indW, indH, x.side === 'L' ? [0.9 * f0, 0.9 * f0, 0.9 * f0, 0.22 * f0] : [0.9 * f0, 0.9 * f0, 0.22 * f0, 0.9 * f0]);
      x.ind = el('path', { d: idr, fill: K.bg, ...(outlineW > 0 ? { stroke: K.outer, 'stroke-width': f3(outlineW), 'stroke-linejoin': 'round' } : {}) }, Lb);
      x.dots = [0, 1, 2].map(() => el('circle', { cx: 0, cy: 0, r: f3(0.17 * f0), fill: K.sub }, Lt));
    }
    if (x.punch) x.burst = [0, 1, 2].map(() => el('line', { x1: 0, y1: 0, x2: f3(0.55 * f0), y2: 0, stroke: K.accent, 'stroke-width': f3(0.13 * f0), 'stroke-linecap': 'round' }, Lfx));
  }

  // ---------- 每一帧 ----------
  function seek(time) {
    const tt = clamp(time, 0, duration);
    const qOut = dz(easeInCubic(clamp((tt - holdEnd) / outDur)));
    const outS = s1(1 - 0.05 * qOut);
    const scroll = scrollAt(tt);
    for (const x of msgs) {
      const yTop = baseY + (x.label ? x.labelY : x.top) - scroll;
      // 滚到对话区上面就淡掉：碰到画面边缘之前已经完全透明
      const fade = clamp((yTop - (topLim - 1.2 * f0)) / (1.2 * f0));
      const op = fade * (1 - qOut);
      const by = baseY + x.top - scroll; // 气泡上边缘
      // 正在输入：弹出来，三个点轮流跳；要发出去的那一刻缩掉
      if (x.typing) {
        const ui = (tt - x.tType) / (0.18 * k);
        const uo = clamp((tt - (x.tPop - 0.1 * k)) / (0.1 * k));
        const on = ui > 0 && tt < x.tPop && op > 0.002;
        vis(x.ind, on); x.dots.forEach((dt) => vis(dt, on));
        if (on) {
          const s = s1(easeOutBack(clamp(ui)) * (1 - uo));
          const ox = x.side === 'L' ? x.x0 : x.x0 + x.bw; const oy = by + indH;
          const ix = x.side === 'L' ? x.x0 : x.x0 + x.bw - indW;
          const PT = `translate(${f3(ox)},${f3(oy)}) scale(${f3(Math.max(s, 0.001))}) translate(${f3(-ox)},${f3(-oy)})`;
          set(x.ind, { transform: `${PT} translate(${f3(ix)},${f3(by)})`, opacity: f3(op) });
          x.dots.forEach((dt, j) => {
            const b = snap(0.24 * f0 * Math.max(0, Math.sin(2 * Math.PI * ((tt - x.tType) * 2.4 / k - j * 0.18))), 0.3);
            set(dt, { transform: `${PT} translate(${f3(ix + indW / 2 + (j - 1) * 0.58 * f0)},${f3(by + indH / 2 - b)})`, opacity: f3(op) });
          });
        }
      }
      // 气泡：从外侧下角弹出来；自己发的从下面升上来；V3 弹得更狠、歪一下再摆正
      const u = (tt - x.tPop) / (0.32 * k);
      const on = u > 0 && op > 0.002;
      vis(x.sh, on); vis(x.bub, on);
      for (const ln of x.lines) for (const c of ln.chars) vis(c.e, false);
      for (const mk of x.marks) vis(mk.e, false);
      if (x.avC) { vis(x.avC, false); vis(x.avT, false); }
      if (x.lab) vis(x.lab, false);
      if (x.burst) x.burst.forEach((b) => vis(b, false));
      if (!on) continue;
      let s = flair > 0 ? lerp(easeOutBack(clamp(u)), spring(tt - x.tPop, { freq: 2.6 / k, damping: 0.32 }), flair) : easeOutBack(clamp(u));
      // 弹过头的放大有上限：气泡远端那条边不出画面（V3 的弹簧会冲到 1.3 倍，长气泡的右边缘开发时冲到了离边 6 像素）
      const sMax = Math.min(x.side === 'L' ? (W - m - x.x0) / x.bw : (x.x0 + x.bw - m) / x.bw, (by + x.bh - m) / x.bh);
      s = s1(Math.min(s, sMax)) * outS;
      let rot = flair > 0 ? (x.side === 'L' ? -1 : 1) * 6 * flair * Math.exp(-7 * u) * Math.cos(9 * u) : 0;
      rot = snap(rot, 0.3);
      const rise = x.side === 'R' ? (1 - dz(easeOutCubic(clamp(u * 1.3)))) * 0.7 * f0 : 0;
      // 包袱：落地后震几下
      let sx = 0;
      if (x.punch) { const us = (tt - x.tPop - 0.12 * k) / 0.32; sx = us > 0 && us < 1 ? snap(Math.sin(us * Math.PI * 6) * (1 - us) * 0.16 * f0, 0.3) : 0; }
      const ox = (x.side === 'L' ? x.x0 : x.x0 + x.bw) + sx; const oy = by + x.bh + rise;
      const PT = `translate(${f3(ox)},${f3(oy)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))}) translate(${f3(-ox + sx)},${f3(-oy + rise)})`;
      set(x.sh, { transform: `${PT} translate(${f3(x.x0 + shOff.x)},${f3(by + shOff.y)})`, opacity: f3(shOp * op) });
      set(x.bub, { transform: `${PT} translate(${f3(x.x0)},${f3(by)})`, opacity: f3(op) });
      // 字：从左往右很快地一个个浮出来；关键词落定以后跳一下
      for (const ln of x.lines) {
        const ly = by + x.padY + 0.5 * x.f + ln.li * x.lineH;
        for (const c of ln.chars) {
          const uc = (tt - x.tPop - 0.08 * k - (ln.li * 8 + c.j) * 0.014 * k) / (0.14 * k);
          const cOn = uc > 0;
          vis(c.e, cOn);
          if (!cOn) continue;
          const lift = (1 - dz(easeOutCubic(clamp(uc)))) * 0.25 * x.f;
          const hop = c.kw ? snap(bump((tt - x.tPop - 0.45 * k - c.j * 0.03) / 0.3) * (0.12 + 0.14 * flair) * x.f, 0.3) : 0;
          set(c.e, { transform: `${PT} translate(${f3(x.x0 + x.padX + c.x)},${f3(ly + lift - hop)})`, opacity: f3(clamp(uc * 2) * op) });
        }
      }
      // 关键词下面那道线：那几个字落定以后，从左往右划过去
      for (const mk of x.marks) {
        const p = dz(easeOutCubic(clamp((tt - x.tPop - 0.3 * k - mk.li * 0.1 * k) / (0.3 * k))));
        vis(mk.e, p > 0);
        if (p > 0) set(mk.e, { transform: `${PT} translate(${f3(x.x0 + x.padX + mk.x0 - 0.06 * x.f)},${f3(by + x.padY + 0.5 * x.f + mk.li * x.lineH + 0.5 * x.f)}) scale(${f3(Math.max(p, 0.001))},1)`, opacity: f3(op) });
      }
      // 头像和名字：跟这一串的第一条一起出来
      if (x.avC) {
        const as = s1(easeOutBack(clamp(u * 1.2))) * outS;
        const AT = `translate(${f3(x.ax)},${f3(by + D / 2 + rise)}) scale(${f3(Math.max(as, 0.001))})`;
        vis(x.avC, true); vis(x.avT, true);
        set(x.avC, { transform: AT, opacity: f3(op) }); set(x.avT, { transform: AT, opacity: f3(op) });
      }
      if (x.lab) { vis(x.lab, true); set(x.lab, { transform: `translate(${f3(x.x0 + 0.2 * f0)},${f3(baseY + x.labelY + 0.42 * f0 - scroll)})`, opacity: f3(clamp(u * 2) * op) }); }
      // 包袱的炸线：从气泡靠里那一侧的上角往外炸
      if (x.burst) {
        const bxp = x.side === 'L' ? x.x0 + x.bw + 0.1 * f0 : x.x0 - 0.1 * f0; const byp = by - 0.1 * f0;
        const dir = x.side === 'L' ? 1 : -1;
        x.burst.forEach((b, j) => {
          const ub = (tt - x.tPop - 0.1 * k - j * 0.04) / 0.45;
          const bOn = ub > 0 && ub < 1;
          vis(b, bOn);
          if (!bOn) return;
          const ang = -(35 + j * 28 + (h('ba', j) - 0.5) * 10); // 往上炸，左边的往右上、右边的往左上
          const a = dir > 0 ? ang : 180 - ang;
          const dist = 0.25 * f0 + dz(easeOutCubic(ub)) * 0.35 * f0;
          const rad = (a * Math.PI) / 180;
          set(b, { transform: `translate(${f3(bxp + Math.cos(rad) * dist)},${f3(byp + Math.sin(rad) * dist)}) rotate(${f3(a)}) scale(${f3(Math.max(1 - ub, 0.001))},1)`, opacity: f3((1 - ub) * op) });
        });
      }
    }
  }

  const issues = checkLineBreaks(allCheckLines, ctx.text, { segment: ctx.segment });
  warnings.push(...icuBreakWarnings(allCheckLines, ctx.text));
  if (contentH > availH) warnings.push({ type: 'scroll', detail: `对话一共 ${msgs.length} 条，放不下一屏，会往上滚；最早的几条会滚出对话区淡掉` });
  seek(0);
  return {
    timeline,
    layout: { fontSize: f0, lines: msgs.flatMap((x) => x.lines.map((l) => l.text)), forced: [], issues, warnings, segmentation: ctx.segmentation ? ctx.segmentation.sources : [], units: units.length, messages: msgs.map((x) => ({ name: x.name, side: x.side, lines: x.lines.length })) },
    seek,
    destroy() { svg.remove(); },
  };
}
