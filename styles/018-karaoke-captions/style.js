// 018 逐字点亮字幕（styles/018-karaoke-captions）
//
// 风格契约见 engine/docs/写一个新风格.md。seek(t) 是纯函数，只看 t；不给 <g> 整组设透明度（硬规矩第 6 条），
// 透明度只写在单个 <text>、<rect> 上；平移写进每个元素自己的 transform，不给整组做亚像素平移。
//
// 做法：口播字幕，一句话整句先暗着显示成 1–2 行，跟着说话一个字一个字（或一个词一个词）亮起来，
// *关键词* 读到时换强调色、弹一下；按句换屏。
//   1. 切屏：段落 → 句子（句号、问号、感叹号、分号后一定换屏）→ 每屏 1–2 行。屏内用动态规划挑断点：
//      逗号后面断最好，一屏一个分句；不到 4 个字的短分句并到相邻一屏；说话停顿超过 0.6 秒的地方尽量换屏；
//      不在「这个、就、的」这种后面还连着的词后面断。行内断行用底座的 bestBreak（按词断、标点不在行首、不留孤字）。
//   2. 时间：有逐字时间（ctx.words）就用：每段时间平均分给里面的字，按顺序对到原文；没有就按每字 0.23 秒估，
//      逗号停 0.18 秒，句号停 0.4 秒，分段停 0.45 秒。标点不占时间，跟着前一个字一起亮。
//   3. 点亮：每个字一层暗字、一层亮字，亮字用自己的裁切矩形从左往右刷开（R1 每字 0.09 秒刷完，R3 按这个字的时长匀速刷，
//      像 KTV）。逐词模式（unit=word）一个词一起刷开。
// 造型预设：V1 日常（默认：暗字半透明＋描边，亮字白字黑边带柔和投影，关键词变色弹一下）；
//           V3 招牌（未读是空心描边字，读到的字跳一下，读的位置有一道光带跟着走，关键词刷出一块倾斜的色块，入场逐字升起）。

import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, spring, easeOutCubic, easeOutBack, easeInCubic } from '../../engine/src/lib/ease.js';
import { graphemes, bestBreak, checkLineBreaks, icuBreakWarnings } from '../../engine/src/lib/text.js';
import { f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
// 「说出来的字」：跟底座校验逐字时间用的是同一条规则（engine/src/lib/words.js），这样两边数字的个数一定对得上
const SPEAK = (g) => !/^[\s\p{P}]+$/u.test(g);
const HIDE = new Set([...'，。、；：,.;:']); // 字幕习惯：这几个标点不显示，句中的换成一点空
const STRONG = new Set([...'。！？!?；;…']); // 句子在这后面结束，一定换屏
const WEAK = new Set([...'，、：,:—～~']); // 分句：最好在这后面换屏
const OPENERS = new Set([...'「『“‘（《【〔〈(']);
const CLOSERS = new Set([...'」』”’）》】〕〉)']);
const PAUSE_PUNCT = new Set([...'，、；：,;:']);
const STOP_PUNCT = new Set([...'。！？!?…']);
// 断在这些词后面会把后面要连着说的东西拆开（跟 004 同一套经验）
const BAD_END = new Set(['真正', '其实', '一定', '必须', '一直', '马上', '真的', '这个', '那个', '一个', '这', '那', '也', '就', '都', '还', '才', '再', '要', '会', '能', '在', '把', '被', '给', '对', '让', '跟', '和', '与', '从', '向', '往', '最', '很', '太', '更', '非常', '特别', '如果', '因为', '所以', '但是', '而且', '可以', '应该', '已经', '正在', '我们', '你们', '他们', '是']);
const isAlnum = (g) => /^[A-Za-z0-9]$/.test(g || '');
const isSpace = (g) => /^\s+$/.test(g);
const invOutCubic = (y) => 1 - Math.cbrt(1 - clamp(y));

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
// 动的量太小时当成没动（《写一个新风格》第 3 节的建议：缓动两头「几乎没动」的帧会随机画出两种结果）
const dead = (v, eps) => (Math.abs(v) < eps ? 0 : v);

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm || {};
  const seed = P.seed;
  const U = ctx.uid || 'hanzifx018';
  const short = Math.min(W, H);
  const portrait = H > W * 1.05; const landscape = W > H * 1.05;
  const family = ctx.fontFamily(P.font);
  const flair = clamp(P.flair ?? 0);
  const showcase = flair > 0;
  const unitWord = P.unit === 'word';
  const keepPunct = P.punct === 'keep';
  const maxLines = Math.max(1, Math.min(2, Math.round(P.maxLines ?? 2)));
  const fs = clamp(P.size ?? 0.06, 0.035, 0.12) * short;
  const em = (k) => k * fs;
  const maxW = clamp(P.width ?? (portrait ? 0.7 : landscape ? 0.72 : 0.78), 0.3, 0.94) * W;
  const cx = (P.x ?? 0.5) * W;
  const bottomY = (P.y ?? (portrait ? 0.77 : landscape ? 0.9 : 0.86)) * H;
  const dimLevel = clamp(P.dim ?? 0.4, 0.1, 0.8);
  const emphScale = clamp(P.emphScale ?? 1.14, 1, 1.4);
  const plateOn = (P.plate === 'auto' || !P.plate) ? P.palette === 'C3' : P.plate === 'on';
  const continuous = !!R.continuous;
  const snap = R.snap ?? 0.09;
  const wordSnap = R.wordSnap ?? 0.16;
  const lead = R.lead ?? 0.1;
  const warnings = [];
  const styleChecks = [];

  // ---------- 量字 ----------
  const cv = document.createElement('canvas').getContext('2d');
  cv.font = `${f3(fs)}px ${family}`;
  const advC = new Map(); const inkC = new Map();
  const adv = (s) => { if (!advC.has(s)) advC.set(s, cv.measureText(s).width); return advC.get(s); };
  const ink = (s) => {
    if (!inkC.has(s)) { const m = cv.measureText(s); inkC.set(s, { l: -m.actualBoundingBoxLeft, r: m.actualBoundingBoxRight, a: m.actualBoundingBoxAscent, d: m.actualBoundingBoxDescent }); }
    return inkC.get(s);
  };
  const G = ink('国');
  const inkAsc = G.a || fs * 0.84; const inkDesc = G.d || fs * 0.1;
  const inkH = inkAsc + inkDesc;
  const lineH = inkH + em(maxLines > 1 ? 0.42 : 0.3);
  const track = em(0.02);
  const spaceW = Math.max(adv(' '), em(0.25));
  const hidGap = em(0.45);

  // ---------- 1. 拆成「格」：一个汉字一格，一串西文字母数字一格，标点一格，空格一格 ----------
  const rawLines = String(ctx.text).replace(/\r/g, '').split('\n');
  const paras = []; // { pi, text, cells, words }
  let speakCount = 0;
  rawLines.forEach((rawLine, pi) => {
    const text = rawLine.trim();
    if (!text) return;
    const gs = graphemes(text);
    const cells = [];
    let off = 0;
    for (let k = 0; k < gs.length; k++) {
      const g = gs[k];
      const prev = cells.at(-1);
      // 西文和数字连成一格：字母数字，夹在中间的 . , : ' -，紧跟在后面的 % +
      const joinLatin = prev && prev.kind === 'latin' && (isAlnum(g) || ('.,:\'’-'.includes(g) && isAlnum(gs[k + 1])) || '%+'.includes(g));
      if (joinLatin) { prev.text += g; prev.gs.push({ g, off }); off += g.length; continue; }
      const kind = isSpace(g) ? 'space' : isAlnum(g) ? 'latin' : SPEAK(g) ? 'char' : 'punct';
      cells.push({ kind, text: g, off, gs: [{ g, off }], pi });
      off += g.length;
    }
    for (const c of cells) {
      c.end = c.off + c.text.length;
      c.emph = c.gs.some((x) => ctx.isEmphasis(pi, x.off));
      c.sp = [];
      for (const x of c.gs) if (SPEAK(x.g)) c.sp.push(speakCount++);
      c.hidden = c.kind === 'punct' && !keepPunct && HIDE.has(c.text);
    }
    // 分词：作者 | → jieba＋词表 → 浏览器分词（宿主选好了）。*关键词* 覆盖到的词合成一个，断行不会把关键词拆开
    const words = [];
    for (const w of ctx.segment(text)) {
      const emph = [...w.text].some((_, k) => ctx.isEmphasis(pi, w.index + k));
      const prev = words.at(-1);
      if (emph && prev && prev.emph && prev.index + prev.text.length === w.index) { prev.text += w.text; continue; }
      words.push({ text: w.text, index: w.index, emph });
    }
    paras.push({ pi, text, cells, words });
  });

  // ---------- 2. 每个说出来的字的时间 ----------
  const spS = new Array(speakCount); const spE = new Array(speakCount);
  let estimated = true;
  const words = Array.isArray(ctx.words) ? ctx.words : [];
  if (words.length) {
    const q = [];
    for (const w of words) {
      const gs = graphemes(String(w.text).replace(/[|*]/g, '')).filter(SPEAK);
      gs.forEach((g, k) => q.push({ g, s: w.start + ((w.end - w.start) * k) / gs.length, e: w.start + ((w.end - w.start) * (k + 1)) / gs.length }));
    }
    const mine = [];
    for (const p of paras) for (const c of p.cells) for (const x of c.gs) if (SPEAK(x.g)) mine.push(x.g);
    if (q.length === mine.length && q.every((x, i) => x.g === mine[i])) {
      q.forEach((x, i) => { spS[i] = x.s; spE[i] = x.e; });
      estimated = false;
      // 识别工具常把停顿算进前后字的时长：超过中位数 2.5 倍的截到「开始＋2 倍中位数」（跟 004 一样的处理）
      const durs = q.map((x) => x.e - x.s).sort((a, b) => a - b);
      const med = durs[Math.floor(durs.length / 2)] || 0;
      if (med > 0) for (let i = 0; i < speakCount; i++) if (spE[i] - spS[i] > 2.5 * med) spE[i] = spS[i] + 2 * med;
    } else warnings.push({ type: 'words-mismatch', detail: '逐字时间跟文字对不上，改用估的时间' });
  }
  if (estimated) {
    let t = 0.3;
    for (const p of paras) {
      for (const c of p.cells) {
        if (c.kind === 'punct') {
          if ([...c.text].some((g) => STOP_PUNCT.has(g))) t += 0.4; else if ([...c.text].some((g) => PAUSE_PUNCT.has(g))) t += 0.18;
          continue;
        }
        if (!c.sp.length) continue;
        // 西文：字母大约每个 0.1 秒、数字每个 0.2 秒（一串至少 0.23 秒）；汉字每个 0.23 秒（实测语速中位每秒 4.3 字）
        const total = c.kind === 'latin'
          ? Math.max(0.23, c.gs.reduce((n, x) => n + (/[0-9]/.test(x.g) ? 0.2 : SPEAK(x.g) ? 0.1 : 0), 0))
          : 0.23 * c.sp.length;
        c.sp.forEach((i, k) => { spS[i] = t + (total * k) / c.sp.length; spE[i] = t + (total * (k + 1)) / c.sp.length; });
        t += total;
      }
      t += 0.45;
    }
  }
  // 每格的时间：说出来的格用自己的字；标点、空格跟着前一格（段首的跟着后一格）
  for (const p of paras) {
    for (const c of p.cells) if (c.sp.length) { c.tS = spS[c.sp[0]]; c.tE = spE[c.sp.at(-1)]; }
  }

  // ---------- 3. 点亮分组：逐字＝每个说出来的格一组；逐词＝分词的一个词一组 ----------
  const groups = [];
  for (const p of paras) {
    const wordOf = (off) => p.words.findIndex((w) => off >= w.index && off < w.index + w.text.length);
    let cur = null; let curKey = null; const pending = [];
    for (const c of p.cells) {
      if (c.kind === 'space') continue;
      if (!c.sp.length) { // 标点：跟前一组一起亮；开引号、开括号跟后一组一起亮
        if (cur && !OPENERS.has(c.text)) cur.extras.push(c); else pending.push(c);
        continue;
      }
      const key = unitWord ? wordOf(c.off) : c.off;
      if (!cur || key !== curKey || pending.length) { cur = { cells: [], extras: [], lead: [] }; groups.push(cur); curKey = key; if (pending.length) { cur.lead.push(...pending); pending.length = 0; } }
      cur.cells.push(c);
    }
    if (pending.length && groups.length) groups.at(-1).extras.push(...pending);
  }
  for (const g of groups) {
    g.S = g.cells[0].tS; g.E = Math.max(...g.cells.map((c) => c.tE));
    const dur = Math.max(0, g.E - g.S);
    if (continuous) g.D = Math.max(0.06, dur);
    else if (unitWord && g.cells.length > 1) g.D = Math.min(wordSnap, Math.max(snap, 0.8 * dur));
    else g.D = g.cells[0].kind === 'latin' ? Math.max(snap, 0.7 * dur) : snap;
    g.cells.forEach((c, k) => { c.group = g; c.gk = k; });
    for (const c of g.extras) { c.group = g; c.gk = g.cells.length - 1; }
    for (const c of g.lead) { c.group = g; c.gk = 0; }
  }

  // ---------- 4. 切屏 ----------
  // 一段 x 到 y（段内下标）显示出来多宽：句中被隐藏的标点算一小段空，行尾的隐藏标点和空格不算
  const cellW = (c) => (c.kind === 'space' ? spaceW : c.hidden ? hidGap : adv(c.text) + track);
  function spanWidth(p, a, b) {
    const cs = p.cells.filter((c) => c.off >= a && c.off < b);
    while (cs.length && (cs.at(-1).kind === 'space' || cs.at(-1).hidden)) cs.pop();
    while (cs.length && cs[0].kind === 'space') cs.shift();
    let w = 0; let prev = null;
    for (const c of cs) {
      if (prev && prev.kind !== 'space' && c.kind !== 'space' && ((prev.kind === 'latin' && c.kind === 'char') || (prev.kind === 'char' && c.kind === 'latin'))) w += em(0.12);
      w += cellW(c); prev = c;
    }
    return Math.max(0, w - track);
  }
  const screens = [];
  for (const p of paras) {
    const segRel = (a, b) => p.words.filter((w) => w.index >= a && w.index < b).map((w) => ({ text: w.text, index: w.index - a }));
    // 整段先按词切成块（关键词一整块、标点粘在前一个词上），再按句子分组
    const atomsAll = segRel(0, p.text.length).map((w) => ({ text: w.text, index: w.index }));
    // 标点粘到前一块，段首的开引号粘到后一块，单字虚词粘到前一块（跟底座 atomize 的禁则一致）
    const atoms = [];
    let carry = null;
    for (const w of atomsAll) {
      const gs = graphemes(w.text);
      const allPunct = gs.every((g) => !SPEAK(g) || isSpace(g));
      if (carry) { w.text = carry.text + w.text; w.index = carry.index; carry = null; }
      if (allPunct && gs.every((g) => OPENERS.has(g) || isSpace(g))) { carry = w; continue; }
      if (allPunct && atoms.length) { atoms.at(-1).text += w.text; continue; }
      if (gs.length === 1 && '了吧啊呢吗呀哦嘛啦咯呗的地得着过'.includes(gs[0]) && atoms.length && !/[\s\p{P}]$/u.test(atoms.at(-1).text)) { atoms.at(-1).text += w.text; continue; }
      atoms.push(w);
    }
    if (carry) { if (atoms.length) atoms.at(-1).text += carry.text; else atoms.push(carry); }
    for (const a of atoms) {
      a.end = a.index + a.text.length;
      a.cells = p.cells.filter((c) => c.off >= a.index && c.off < a.end);
      const spk = a.cells.filter((c) => c.sp.length);
      a.tS = spk.length ? spk[0].tS : null; a.tE = spk.length ? Math.max(...spk.map((c) => c.tE)) : null;
      a.L = a.cells.reduce((n, c) => n + (c.kind === 'char' ? 1 : c.kind === 'latin' ? Math.max(1, c.sp.length * 0.55) : c.hidden || c.kind === 'space' ? 0 : 0.6), 0);
      const lastG = graphemes(a.text.trimEnd()).at(-1) || '';
      a.strong = STRONG.has(lastG);
      a.weak = WEAK.has(lastG) || HIDE.has(lastG);
      a.core = a.text.replace(/[\s\p{P}]+$/u, '');
      a.w = spanWidth(p, a.index, a.end);
    }
    // 句子
    const sentences = []; let cur = [];
    for (const a of atoms) { cur.push(a); if (a.strong) { sentences.push(cur); cur = []; } }
    if (cur.length) sentences.push(cur);
    // 每句用动态规划切成屏
    const fitMemo = new Map();
    const fitOf = (A, j, i) => {
      const key = `${A[j].index}-${A[i - 1].end}`;
      if (fitMemo.has(key)) return fitMemo.get(key);
      const a = A[j].index; const b = A[i - 1].end;
      const text = p.text.slice(a, b);
      // 能排成一行就别拆两行（行数的代价调高到 0.8，底座默认 0.25）
      const r = bestBreak(text, (t, pos) => spanWidth(p, a + pos.index, a + pos.index + t.length), maxW, { maxLines, weights: { line: 0.8 }, segment: () => segRel(a, b), paragraph: p.pi });
      fitMemo.set(key, r);
      return r;
    };
    for (const A of sentences) {
      const n = A.length;
      const best = new Array(n + 1).fill(Infinity); const from = new Array(n + 1).fill(-1);
      best[0] = 0;
      for (let i = 1; i <= n; i++) {
        for (let j = i - 1; j >= 0; j--) {
          const wsum = A.slice(j, i).reduce((s, a) => s + a.w, 0);
          if (j < i - 1 && wsum > maxLines * maxW * 1.02) break;
          const r = fitOf(A, j, i);
          if (!r && j < i - 1) break;
          const L = A.slice(j, i).reduce((s, a) => s + a.L, 0);
          let c = 1;
          if (L < 4) c += (4 - L) * (4 - L) * 0.6;
          if (r && r.lines.length > 1) c += 0.3;
          for (let k = j; k < i - 1; k++) {
            if (A[k].weak) c += 1.2; // 屏里夹着一个分句的边界：能拆成两屏就拆
            if (!estimated && A[k].tE != null && A[k + 1].tS != null && A[k + 1].tS - A[k].tE >= 0.6) c += 1.5; // 屏里有长停顿
          }
          if (i < n) {
            const last = A[i - 1];
            const pause = !estimated && last.tE != null && A[i].tS != null ? A[i].tS - last.tE : 0;
            if (last.weak) c += 0.1;
            else if (pause >= 0.45) c += 0.35;
            else c += 2.2 + (BAD_END.has(last.core) ? 2 : 0) + (last.core.endsWith('的') ? 1.2 : 0);
          }
          const tS = A[j].tS; const tE = A[i - 1].tE;
          if (tS != null && tE != null) { const d = tE - tS; if (d > 6) c += (d - 6) * 1.2; if (d < 0.5 && n > 1) c += 2; }
          if (best[j] + c < best[i]) { best[i] = best[j] + c; from[i] = j; }
        }
        if (!Number.isFinite(best[i])) { best[i] = best[i - 1] + 50; from[i] = i - 1; }
      }
      const cuts = []; for (let i = n; i > 0; i = from[i]) cuts.unshift([from[i], i]);
      for (const [j, i] of cuts) {
        const a = A[j].index; const b = A[i - 1].end;
        let r = fitOf(A, j, i);
        if (!r) r = bestBreak(p.text.slice(a, b), (t, pos) => spanWidth(p, a + pos.index, a + pos.index + t.length), maxW, { maxLines: 9, segment: () => segRel(a, b), paragraph: p.pi });
        screens.push({ p, a, b, lines: r.lines.map((l) => ({ a: a + l.index, b: a + l.index + l.text.length, raw: l.text })), forced: r.forced || [] });
      }
    }
  }
  const forced = screens.flatMap((s) => s.forced);
  for (const s of screens) if (s.lines.length > maxLines) warnings.push({ type: 'too-long', detail: `「${s.p.text.slice(s.a, s.b)}」一屏放不下 ${maxLines} 行` });

  // ---------- 5. 屏的起止时间 ----------
  for (const s of screens) {
    const cs = s.p.cells.filter((c) => c.off >= s.a && c.off < s.b && c.sp.length);
    s.cells = s.p.cells.filter((c) => c.off >= s.a && c.off < s.b);
    s.tS = cs.length ? cs[0].tS : null; s.tE = cs.length ? Math.max(...cs.map((c) => c.tE)) : null;
  }
  screens.forEach((s, i) => { if (s.tS == null) { const prev = screens[i - 1]; s.tS = prev ? prev.tE : 0.3; s.tE = s.tS + 0.3; } });
  const entryDur = showcase ? 0.24 : 0.16;
  screens.forEach((s, i) => {
    const prev = screens[i - 1];
    s.appear = Math.max(0, s.tS - lead, prev ? prev.appear + 0.25 : 0);
    s.vanish = null;
    if (prev && prev.vanish == null) prev.vanish = s.appear;
    // 停顿长（下一句晚于这句说完 1 秒以上）：这句说完 0.7 秒后先下去，画面空着
    if (prev && s.tS - lead - prev.tE > 1.0) { prev.vanish = Math.min(prev.vanish, prev.tE + 0.7); prev.exitDur = 0.14; }
  });
  screens.forEach((s, i) => {
    if (i === screens.length - 1) { s.vanish = s.tE + 0.8; s.exitDur = 0.16; }
    if (s.exitDur == null) s.exitDur = 0.07; // 紧接着下一句：两帧收掉，干净地换屏
    s.vanish = Math.max(s.vanish, s.appear + 0.2);
    s.exitStart = s.vanish - s.exitDur;
  });
  // 在这一屏下去之前，所有字都要亮完：来不及的压缩刷开的时间、必要时提前一点
  for (const s of screens) {
    const limit = s.exitStart - 0.03;
    for (const g of new Set(s.cells.filter((c) => c.group).map((c) => c.group))) {
      if (g.S > limit - 0.04) { g.S = Math.max(s.appear, limit - 0.06); g.D = Math.min(g.D, 0.05); }
      if (g.S + g.D > limit) g.D = Math.max(0.03, limit - g.S);
    }
  }
  const duration = screens.length ? screens.at(-1).vanish + 0.25 : 1;

  // ---------- 6. 每屏排版 ----------
  const strokeLit = em(showcase ? 0.12 : 0.1); // paint-order=stroke，露在外面的是一半
  const shOff = { x: em(0.045), y: em(0.07) };
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  if (!showcase && !plateOn) {
    // 日常：亮字一层柔和投影（不倾斜、不旋转，所以可以用模糊，硬规矩第 7 条）
    const f = el('filter', { id: `${U}-sh`, x: '-20%', y: '-40%', width: '140%', height: '190%' }, defs);
    el('feGaussianBlur', { in: 'SourceAlpha', stdDeviation: f3(em(0.07)), result: 'b' }, f);
    el('feOffset', { in: 'b', dx: 0, dy: f3(em(0.05)), result: 'o' }, f);
    el('feFlood', { 'flood-color': K.shadow, 'flood-opacity': 0.6, result: 'c' }, f);
    el('feComposite', { in: 'c', in2: 'o', operator: 'in', result: 's' }, f);
    const m = el('feMerge', {}, f); el('feMergeNode', { in: 's' }, m); el('feMergeNode', { in: 'SourceGraphic' }, m);
  }
  if (showcase) {
    // 招牌：没读到的空心字外面一层淡投影，让它在浅色画面上也能先读到。
    // 只给不转的字用（关键词那一组读到时会歪，转的东西不带模糊滤镜，硬规矩第 7 条），关键词的暗字用不模糊的淡投影
    const f = el('filter', { id: `${U}-dsh`, x: '-20%', y: '-40%', width: '140%', height: '190%' }, defs);
    el('feGaussianBlur', { in: 'SourceAlpha', stdDeviation: f3(em(0.08)), result: 'b' }, f);
    el('feOffset', { in: 'b', dx: 0, dy: f3(em(0.04)), result: 'o' }, f);
    el('feFlood', { 'flood-color': K.shadow, 'flood-opacity': 0.6, result: 'c' }, f);
    el('feComposite', { in: 'c', in2: 'o', operator: 'in', result: 's' }, f);
    const m = el('feMerge', {}, f); el('feMergeNode', { in: 's' }, m); el('feMergeNode', { in: 'SourceGraphic' }, m);
  }
  const main = el('g', {}, svg);
  let clipN = 0;
  const allLines = []; const linesDetail = [];
  const kwRuns = [];
  // 招牌的没读到的字是空心字：0.06 字宽的浅色描边，空心里垫一层 35% 的深色（outer 色），外面一层淡投影
  const dimFill = showcase ? 0.35 : dimLevel;
  const dimStroke = showcase ? 0.9 : Math.min(1, dimLevel * 0.9 + 0.1);
  screens.forEach((s, si) => {
    s.g = el('g', { visibility: 'hidden' }, main);
    s.lineObjs = [];
    let order = 0; // 这一格在这一屏里是第几个画出来的字（招牌入场逐字错开用）
    const nL = s.lines.length;
    s.lines.forEach((ln, li) => {
      linesDetail.push({ text: ln.raw, paragraph: s.p.pi });
      // 这一行的格：去掉行首行尾的空格；行尾被隐藏的标点不占宽
      const cs = s.p.cells.filter((c) => c.off >= ln.a && c.off < ln.b);
      const drawable = (c) => c.kind !== 'space' && !c.hidden;
      let firstD = cs.findIndex(drawable); let lastD = cs.length - 1 - [...cs].reverse().findIndex(drawable);
      if (firstD < 0) { firstD = 0; lastD = -1; }
      let x = 0; let prev = null;
      const placed = [];
      for (let k = firstD; k <= lastD; k++) {
        const c = cs[k];
        if (c.kind === 'space') { x += spaceW; prev = c; continue; }
        if (c.hidden) { x += hidGap; prev = c; continue; }
        if (prev && prev.kind !== 'space' && !prev.hidden && ((prev.kind === 'latin' && c.kind === 'char') || (prev.kind === 'char' && c.kind === 'latin'))) x += em(0.12);
        let w = adv(c.text); let shift = 0;
        if (c.kind === 'punct') {
          // 标点挤压（要读的字的规则，见 STYLE.md 第 6 节）：问号感叹号不挤；行首开引号开括号收掉左边的空；
          // 行尾或紧跟着别的标点的闭引号闭括号（keep 模式下还有逗号句号）收掉右边的空
          const I = ink(c.text);
          const nextC = cs.slice(k + 1).find((z) => z.kind !== 'space');
          const atEnd = k === lastD || (nextC && nextC.kind === 'punct');
          const afterPunct = prev && prev.kind === 'punct';
          if (OPENERS.has(c.text) && (placed.length === 0 || afterPunct)) { const sl = Math.max(0, I.l - em(0.06)); shift = -sl; w -= sl; }
          if ((CLOSERS.has(c.text) || (keepPunct && HIDE.has(c.text))) && atEnd) w = Math.min(w, Math.max(I.r + em(0.08), em(0.5)) + shift);
        }
        placed.push({ c, x, w, tx: x + shift });
        x += w + track; prev = c;
      }
      const lineW = Math.max(0, x - track);
      if (lineW > maxW + 1) warnings.push({ type: 'too-wide', detail: `「${ln.raw}」宽 ${Math.round(lineW)}px，超过行宽 ${Math.round(maxW)}px` });
      const left = clamp(cx - lineW / 2, W * 0.02, Math.max(W * 0.02, W * 0.98 - lineW));
      const centerY = bottomY - (nL - 1 - li) * lineH - inkH / 2 - em(0.06);
      const base = centerY + (inkAsc - inkDesc) / 2;
      const lg = el('g', {}, s.g);
      const L = { g: lg, cells: [], left, right: left + lineW, centerY, base, screen: s, idx: allLines.length };
      allLines.push(L);
      // 图层：底条 → 暗字 → 关键词色块 → 亮字（日常带投影）
      if (plateOn && lineW > 0) {
        L.plate = el('rect', { x: f3(left - em(0.32)), y: f3(centerY - inkH / 2 - em(0.2)), width: f3(lineW + em(0.64)), height: f3(inkH + em(0.4)), rx: f3(em(0.2)), fill: K.bg, 'fill-opacity': 0 }, lg);
      }
      const dimLayer = el('g', showcase ? { filter: `url(#${U}-dsh)` } : {}, lg);
      const dimKwLayer = showcase ? el('g', {}, lg) : dimLayer; // 招牌：关键词的暗字单独一层，不带模糊
      const blockLayer = el('g', {}, lg);
      const litLayer = el('g', !showcase && !plateOn ? { filter: `url(#${U}-sh)` } : {}, lg);
      if (showcase) {
        L.grad = el('linearGradient', { id: `${U}-gl${L.idx}`, gradientUnits: 'userSpaceOnUse', x1: f3(left - em(0.5)), y1: 0, x2: f3(left + lineW + em(0.5)), y2: 0 }, defs);
        L.stops = [0, 1, 2, 3, 4, 5].map(() => el('stop', { offset: 0, 'stop-color': K.inner, 'stop-opacity': 0 }, L.grad));
      }
      const textAttrs = { 'font-family': family, 'font-size': f3(fs) };
      for (const pc of placed) {
        const c = pc.c;
        const X = left + pc.tx; const bx0 = left + pc.x; const bx1 = left + pc.x + pc.w;
        const kw = c.emph;
        let dimSh = null;
        if (showcase && kw) {
          dimSh = el('text', { ...textAttrs, x: f3(X), y: f3(base + em(0.045)), fill: K.shadow, 'fill-opacity': 0, stroke: K.shadow, 'stroke-opacity': 0, 'stroke-width': f3(em(0.08)), 'stroke-linejoin': 'round' }, dimKwLayer);
          dimSh.textContent = c.text;
        }
        const dim = el('text', {
          ...textAttrs, x: f3(X), y: f3(base),
          fill: showcase ? K.outer : K.fill2, 'fill-opacity': 0,
          stroke: showcase ? K.fill2 : K.outer, 'stroke-opacity': 0,
          'stroke-width': f3(showcase ? em(0.06) : strokeLit), 'stroke-linejoin': 'round', ...(showcase ? {} : { 'paint-order': 'stroke' }),
        }, showcase && kw ? dimKwLayer : dimLayer);
        dim.textContent = c.text;
        const clip = el('clipPath', { id: `${U}-c${clipN}` }, defs);
        const padL = em(0.12); const padR = em(0.12) + (showcase ? shOff.x : 0);
        const crect = el('rect', { x: f3(bx0 - padL), y: f3(base - inkAsc - em(0.35)), width: 0, height: f3(inkH + em(0.7) + shOff.y) }, clip);
        const lit = el('g', { 'clip-path': `url(#${U}-c${clipN})` }, litLayer);
        clipN++;
        let shadow = null; let glint = null;
        const onBlock = showcase && kw;
        if (showcase && !onBlock) {
          shadow = el('text', { ...textAttrs, x: f3(X + shOff.x), y: f3(base + shOff.y), fill: K.shadow, 'fill-opacity': 0, stroke: K.shadow, 'stroke-opacity': 0, 'stroke-width': f3(strokeLit), 'stroke-linejoin': 'round' }, lit);
          shadow.textContent = c.text;
        }
        const litText = el('text', {
          ...textAttrs, x: f3(X), y: f3(base),
          fill: onBlock ? K.outer : kw ? K.accent : K.fill, 'fill-opacity': 0,
          ...(onBlock ? {} : { stroke: K.outer, 'stroke-opacity': 0, 'stroke-width': f3(strokeLit), 'stroke-linejoin': 'round', 'paint-order': 'stroke' }),
        }, lit);
        litText.textContent = c.text;
        if (showcase && !onBlock) {
          glint = el('text', { ...textAttrs, x: f3(X), y: f3(base), fill: `url(#${U}-gl${L.idx})`, 'fill-opacity': 0 }, lit);
          glint.textContent = c.text;
        }
        const cellObj = { c, order: order++, dimSh, x0: bx0, x1: bx1, padL, padR, dim, crect, lit, litText, shadow, glint, kw, hopAmp: em(0.085) * flair * (0.8 + 0.4 * hash01(seed, 'hop', c.pi, c.off)) };
        L.cells.push(cellObj);
      }
      // 关键词：一行里连着的关键词格算一组，读到第一个字时一起弹
      let run = null;
      L.cells.forEach((co, k) => {
        if (co.kw && run && L.cells[k - 1] && L.cells[k - 1].kw) { run.cells.push(co); return; }
        if (co.kw) { run = { cells: [co], line: L }; kwRuns.push(run); } else run = null;
      });
      for (const r of kwRuns.filter((z) => z.line === L)) {
        r.x0 = r.cells[0].x0; r.x1 = r.cells.at(-1).x1;
        r.cx = (r.x0 + r.x1) / 2; r.cy = centerY;
        r.idx = kwRuns.indexOf(r);
        r.tilt = showcase ? (hash01(seed, 'tilt', r.idx) < 0.5 ? -1 : 1) * (1.6 + 1.4 * hash01(seed, 'tiltA', r.idx)) * flair : 0;
        r.text = r.cells.map((co) => co.c.text).join('');
        if (showcase) {
          const bx = r.x0 - em(0.16); const by = centerY - inkH / 2 - em(0.17); const bh = inkH + em(0.34);
          r.full = r.x1 - r.x0 + em(0.32);
          r.bshadow = el('rect', { x: f3(bx + em(0.06)), y: f3(by + em(0.08)), width: 0, height: f3(bh), rx: f3(em(0.12)), fill: K.shadow, 'fill-opacity': 0 }, blockLayer);
          r.block = el('rect', { x: f3(bx), y: f3(by), width: 0, height: f3(bh), rx: f3(em(0.12)), fill: K.accent, 'fill-opacity': 0 }, blockLayer);
        }
        for (const co of r.cells) co.run = r;
      }
      s.lineObjs.push(L);
    });
    s.display = s.lineObjs.map((L) => L.cells.map((co) => co.c.text).join('')).join(' / ');
  });
  for (const r of kwRuns) r.start = Math.min(...r.cells.map((co) => litStartOf(co.c)));

  // 一格从几秒开始亮、几秒亮完（给弹跳、光带和 timeline 用）
  function litStartOf(c) {
    const g = c.group; if (!g) return 0;
    const n = g.cells.length; const y = c.sp.length ? c.gk / n : (g.lead.includes(c) ? 0 : (n - 1) / n);
    return g.S + g.D * (continuous ? y : invOutCubic(y));
  }
  function litDoneOf(c) {
    const g = c.group; if (!g) return 0;
    const n = g.cells.length; const y = c.sp.length ? (c.gk + 1) / n : 1;
    return g.S + g.D * (continuous ? y : invOutCubic(Math.min(y, 0.985)));
  }
  // 这一刻这格亮了多少（0–1）
  function litP(c, t) {
    const g = c.group; if (!g) return 1;
    const u = clamp((t - g.S) / g.D);
    let ue = continuous ? u : easeOutCubic(u);
    if (ue > 0.985) ue = 1;
    const n = g.cells.length;
    const k = c.sp.length ? c.gk : g.lead.includes(c) ? 0 : n - 1;
    let p = clamp(ue * n - k);
    if (p > 0.985) p = 1; if (p < 0.015) p = 0;
    return p;
  }

  // ---------- 7. 每一刻怎么动（纯函数） ----------
  function popV(tau) {
    // 关键词弹一下：0.07 秒冲到最大，再用弹簧回到原样；0.75 秒以后一律停住
    if (tau <= 0 || tau >= 0.75) return 0;
    const rise = 0.07;
    const v = tau < rise ? easeOutCubic(tau / rise) : 1 - spring(tau - rise, { freq: 2.4, damping: 0.5 });
    return dead(v, 0.02);
  }
  function hopV(tau) {
    // 招牌：每个字亮起来时跳一下（只平移，不缩放）
    const T = 0.26;
    if (tau <= 0 || tau >= T) return 0;
    const u = tau / T;
    return dead(Math.sin(Math.PI * (u < 0.3 ? u / 0.6 : 0.5 + (u - 0.3) / 1.4)), 0.03);
  }
  const fadeIn = showcase ? 0.09 : 0.1;
  function seek(t) {
    for (const s of screens) {
      if (!(t >= s.appear && t < s.vanish)) { set(s.g, { visibility: 'hidden' }); continue; }
      set(s.g, { visibility: 'visible' });
      const tau = t - s.appear;
      const uo = clamp((t - s.exitStart) / s.exitDur);
      const outA = 1 - uo;
      const outDy = dead(-em(showcase ? 0.18 : 0.1) * easeInCubic(uo), 0.25);
      // 日常：整屏一起从下面 0.18 个字高升上来
      let eV1 = easeOutCubic(clamp(tau / entryDur)); if (1 - eV1 < 0.015) eV1 = 1;
      const aV1 = clamp(tau / fadeIn);
      for (const L of s.lineObjs) {
        let front = -Infinity; let anyLit = false;
        for (const co of L.cells) {
          const c = co.c;
          // 入场：日常整屏一起；招牌逐字错开 0.014 秒升起来（带一点回弹）
          let a = aV1 * outA; let dy = (1 - eV1) * em(0.18) + outDy;
          if (showcase) {
            const tk = tau - Math.min(0.22, co.order * 0.014);
            let e = clamp(tk / entryDur); e = e >= 1 ? 1 : easeOutBack(e, 1.6);
            a = clamp(tk / fadeIn) * outA;
            dy = dead((1 - e) * em(0.42), 0.25) + outDy;
          }
          const p = litP(c, t);
          if (p > 0) { anyLit = true; front = Math.max(front, co.x0 + p * (co.x1 - co.x0)); }
          // 招牌：亮起来跳一下（关键词另有自己的弹法）
          if (showcase && !co.kw) dy -= co.hopAmp * hopV(t - litStartOf(c));
          let tf = `translate(0,${f3(dy)})`;
          if (co.run) {
            const r = co.run; const v = popV(t - r.start);
            const sc = 1 + (emphScale - 1) * v;
            const rot = r.tilt * easeOutCubic(clamp((t - r.start) / 0.12));
            const lift = -em(0.1) * v;
            tf = `translate(0,${f3(dy + lift)}) translate(${f3(r.cx)},${f3(r.cy)}) rotate(${f3(dead(rot, 0.02))}) scale(${f3(sc)}) translate(${f3(-r.cx)},${f3(-r.cy)})`;
            co.tf = tf;
          }
          set(co.dim, { transform: tf, 'fill-opacity': dimFill * a, 'stroke-opacity': dimStroke * a });
          if (co.dimSh) set(co.dimSh, { transform: tf, 'fill-opacity': 0.3 * a, 'stroke-opacity': 0.3 * a });
          set(co.lit, { transform: tf });
          set(co.crect, { width: p * (co.x1 - co.x0 + co.padL + co.padR) });
          set(co.litText, { 'fill-opacity': a, ...(co.kw && showcase ? {} : { 'stroke-opacity': a }) });
          if (co.shadow) set(co.shadow, { 'fill-opacity': 0.9 * a, 'stroke-opacity': 0.9 * a });
          if (co.glint) set(co.glint, { 'fill-opacity': a });
        }
        // 关键词色块：跟着读到的位置刷开
        for (const r of kwRuns) {
          if (r.line !== L || !r.block) continue;
          const wsum = r.cells.reduce((n, co) => n + (co.x1 - co.x0), 0) || 1;
          const lit = r.cells.reduce((n, co) => n + litP(co.c, t) * (co.x1 - co.x0), 0) / wsum;
          const a = (showcase ? clamp((tau - Math.min(0.22, 0.014 * r.cells[0].order)) / fadeIn) : aV1) * outA;
          const bw = lit <= 0 ? 0 : r.full * (lit >= 0.999 ? 1 : 0.12 + 0.88 * lit);
          set(r.block, { width: bw, 'fill-opacity': a, transform: r.cells[0].tf || 'translate(0,0)' });
          set(r.bshadow, { width: bw, 'fill-opacity': 0.9 * a, transform: r.cells[0].tf || 'translate(0,0)' });
        }
        if (L.plate) set(L.plate, { 'fill-opacity': (P.plateOpacity ?? (P.palette === 'C3' ? 0.92 : 0.5)) * aV1 * outA, transform: `translate(0,${f3((1 - eV1) * em(0.18) + outDy)})` });
        // 招牌：读的位置一道光带（强调色的亮带拖在刚亮的字上），一段时间没有新字亮就慢慢退掉
        if (L.grad) {
          const x1 = L.left - em(0.5); const span = (L.right + em(0.5)) - x1;
          const since = t - Math.min(t, L.lastLitBefore(t));
          const I = anyLit ? 0.95 * (1 - clamp((since - 0.18) / 0.35)) * outA : 0;
          const o = (x) => clamp((x - x1) / span);
          const fx = anyLit ? front : L.left;
          const pts = [[0, 0], [o(fx - em(1.6)), 0], [o(fx - em(0.5)), I], [o(fx + em(0.05)), I], [o(fx + em(0.3)), 0], [1, 0]];
          for (let k = 1; k < pts.length; k++) if (pts[k][0] < pts[k - 1][0]) pts[k][0] = pts[k - 1][0];
          L.stops.forEach((st, k) => set(st, { offset: pts[k][0], 'stop-opacity': pts[k][1] }));
        }
      }
    }
  }
  // 这一行在 t 之前最后一个亮完的字是什么时候（光带退掉要用）
  for (const L of allLines) {
    const dones = L.cells.map((co) => litDoneOf(co.c)).sort((a, b) => a - b);
    L.lastLitBefore = (t) => { let r = -Infinity; for (const d of dones) { if (d <= t) r = d; else break; } return r === -Infinity ? t : r; };
  }

  // ---------- 8. 表演数据和排版结果 ----------
  const chars = (s) => s.lineObjs.flatMap((L) => L.cells.map((co) => [co.c.text, Math.round(litStartOf(co.c) * 1000) / 1000]));
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '第一句出现', start: 0, end: screens.length ? screens[0].appear + entryDur : 0 },
      { name: 'hold', label: '逐句跟着说话点亮', start: screens.length ? screens[0].appear + entryDur : 0, end: screens.length ? screens.at(-1).exitStart : duration },
      { name: 'outro', label: '最后一句下去', start: screens.length ? screens.at(-1).exitStart : duration, end: duration },
    ],
    beats: kwRuns.map((r) => ({ t: r.start, name: 'keyword', label: `关键词「${r.text}」点亮` })),
    units: screens.map((s, i) => ({ i, text: s.display, raw: s.p.text.slice(s.a, s.b), start: s.appear, end: s.vanish, lines: s.lines.length, speechStart: s.tS, speechEnd: s.tE, lights: chars(s), estimated })),
  };
  // 读得过来吗：一屏的字数除以停留时间，超过每秒 9 个字就提示（只提示，不卡导出）
  const fast = screens.filter((s) => { const n = s.cells.filter((c) => c.sp.length).length; return n / Math.max(0.1, s.vanish - s.appear) > 9; });
  styleChecks.push({ id: 'reading-speed', level: 'warn', pass: !fast.length, message: fast.length ? `${fast.length} 屏字太多、停得太短（超过每秒 9 个字）：${fast.map((s) => `「${s.display}」`).join('')}` : '每屏都读得过来' });
  const longest = screens.reduce((m, s) => Math.max(m, s.vanish - s.appear), 0);
  styleChecks.push({ id: 'screen-hold', level: 'warn', pass: longest <= 8, message: longest <= 8 ? `最长一屏停 ${longest.toFixed(1)} 秒` : `有一屏停了 ${longest.toFixed(1)} 秒，太久了，考虑在原文里加个逗号或回车` });
  const layout = {
    fontSize: fs,
    lines: allLines.map((L) => L.cells.map((co) => co.c.text).join('')),
    linesDetail,
    forced,
    issues: checkLineBreaks(linesDetail, ctx.text, { segment: ctx.segment }),
    warnings: [...icuBreakWarnings(linesDetail, ctx.text), ...warnings],
    styleChecks,
    segmentation: ctx.segmentation ? ctx.segmentation.sources : [],
    emphasis: kwRuns.map((r) => r.text).join('、'),
    screens: screens.length,
    timingEstimated: estimated,
  };
  seek(0);
  return { timeline, layout, seek, destroy() { svg.remove(); } };
}
