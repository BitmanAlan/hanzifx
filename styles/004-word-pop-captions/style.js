// 004 一词一屏字幕（styles/004-word-pop-captions）
//
// 风格契约见 engine/docs/写一个新风格.md。seek(t) 是纯函数，只看 t；不给整组设透明度（理由见 006 STYLE.md 第 11 节第 3 条）。
//
// 做法：口播字幕一次只出 1–3 个词，大字放在画面中间，跟着说话一屏一屏地换。
//   1. 切屏：用底座给的分词（作者用 | 标的切分 → jieba＋词表＋规则 → 浏览器自带分词），再按「一屏 1–3 个词、不超过 6 个字」合成屏；
//      单个字的虚词（的、了、吧……）粘到前一屏；逗号句号不显示，问号感叹号留下；标点后面一定换屏。
//   2. 卡时间：有逐字时间（ctx.words）就用；没有就按每字 0.23 秒估（实测语速中位每秒 4.3 字），layout 里写明「时间是估的」。
//      每屏比第一个字的声音早 2 帧出来；一屏不到 0.25 秒就跟下一屏合并；停顿超过 0.6 秒，上一屏提前消失。
//   3. 动：只有关键词（*…*）弹，普通词入场很轻，免得整段都在跳；关键词停留时轻轻呼吸。
// 造型预设：V1 日常（默认）、V3 招牌（关键词先刷一块色块再砸进去、落地震一下，每屏左右交替微微倾斜）。

import { hash01 } from '../../engine/src/lib/rand.js';
import { mix } from '../../engine/src/lib/color.js';
import { clamp, lerp, spring, impulse, easeOutCubic } from '../../engine/src/lib/ease.js';
import { graphemes, checkLineBreaks } from '../../engine/src/lib/text.js';
import { f3 } from '../../engine/src/motions/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
// 不显示的标点（显示时去掉，但切屏时仍然算作这一屏的原文）；留下显示的标点
const DROP = new Set([...'，。、；：,.;:「」『』“”‘’"\'（）()《》〈〉【】—…·～~']);
const KEEP = new Set([...'？！?!']);
const BREAK_AFTER = new Set([...'，。、；：,.;:？！?!…—～~']);
// 单个字的虚词：粘到前一屏
const FUNC = new Set([...'的了吗吧啊呢嘛呀哦么着过地得啦哈呗咯嘞']);
// 单个字的方位词：跟虚词一样不放在屏首（「双十一前」不能切成「双十一｜前一定」）
const LOCATIVE = new Set([...'前后里上下中内外时边']);
const isLatin = (ch) => /[A-Za-z0-9]/.test(ch);
const isSpace = (ch) => /\s/.test(ch);

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };

function makeMeasurer(family) {
  const g = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (ch, px) => {
    const key = ch + '|' + px;
    if (cache.has(key)) return cache.get(key);
    g.font = `${px}px ${family}`;
    const w = g.measureText(ch).width;
    cache.set(key, w);
    return w;
  };
}
// 一屏「几个字」：汉字算 1，西文字母和数字算 0.58，空格算 0.3
const unitLen = (s) => [...s].reduce((n, ch) => n + (isSpace(ch) ? 0.3 : isLatin(ch) ? 0.58 : DROP.has(ch) ? 0 : 1), 0);

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const fps = ctx.fps || 30;
  const seed = P.seed;
  const U = ctx.uid || 'hanzifx004'; // SVG 里的 id 加上这次挂载的前缀
  const short = Math.min(W, H);
  const family = ctx.fontFamily(P.font);
  const measure = makeMeasurer(family);
  const showcase = (P.flair ?? 0) > 0;
  const flair = clamp(P.flair ?? 0);
  const maxChars = P.maxChars ?? 6;
  const emphScale = P.emphScale ?? 1.12;
  const box = P.box === 'auto' || !P.box ? ({ C3: 'block', C4: 'neon', C5: 'shadow' }[P.palette] || 'outline') : P.box;
  const warnings = [];

  // ---------- 1. 切屏 ----------
  const rawLines = String(ctx.text).replace(/\r/g, '').split('\n');
  const screens = [];
  rawLines.forEach((rawLine, pi) => {
    const para = rawLine.trim();
    if (!para) return;
    // 先把分词结果变成「块」：作者用 *…* 标的关键词，不管分词怎么切，整段算一个块（「工作流程」不会被切成「工作流／程」）
    const atoms = [];
    for (const w of ctx.segment(para)) {
      const emph = [...w.text].some((_, k) => ctx.isEmphasis(pi, w.index + k));
      const prev = atoms.at(-1);
      if (emph && prev && prev.emph && prev.index + prev.text.length === w.index) { prev.text += w.text; continue; }
      atoms.push({ text: w.text, index: w.index, emph });
    }
    // 按句子分组：标点（连同前后空格）粘到前一个块的尾巴上；遇到能断句的标点，这一句就结束。
    // 句首的标点（比如开引号）粘到下一个块的头上
    const isPunctTok = (t) => [...t].every((ch) => DROP.has(ch) || KEEP.has(ch) || BREAK_AFTER.has(ch) || isSpace(ch));
    const sentences = [];
    let sent = []; let head = ''; let headIndex = null;
    for (const a of atoms) {
      if (isPunctTok(a.text)) {
        if (sent.length) sent.at(-1).tail += a.text; else { if (headIndex == null) headIndex = a.index; head += a.text; }
        if ([...a.text].some((ch) => BREAK_AFTER.has(ch)) && sent.length) { sentences.push(sent); sent = []; }
        continue;
      }
      sent.push({ ...a, head, start: headIndex ?? a.index, tail: '', len: unitLen(a.text), func: [...a.text].length === 1 && (FUNC.has(a.text) || LOCATIVE.has(a.text)) });
      head = ''; headIndex = null;
    }
    if (sent.length) sentences.push(sent);
    if (head && sentences.length) sentences.at(-1).at(-1).tail += head; // 段末只剩标点：粘到最后一个块

    // 每句用动态规划切屏（11-19 用真实口播审出来的：贪心塞满会把修饰语和中心语拆开，比如「就要放在这个｜区域」）。
    // 代价：每屏 3–5 个字最好，一两个字的屏和超过 5 个字的屏都加代价；断在「这个、也、就……」这种后面还要连着的词后面加代价；
    // 单字虚词不许放在屏首；关键词整块单独成屏（后面可以带一个单字虚词）。
    const BAD_END = new Set(['真正', '其实', '一定', '必须', '一直', '马上', '真的', '这个', '那个', '一个', '这', '那', '也', '就', '都', '还', '才', '再', '要', '会', '能', '在', '把', '被', '给', '对', '让', '跟', '和', '与', '从', '向', '往', '最', '很', '太', '更', '非常', '特别', '如果', '因为', '所以', '但是', '而且', '可以', '应该', '已经', '正在', '我们', '你们', '他们']);
    const lenCost = (L) => (L < 3 ? (3 - L) * (3 - L) * 4 : L <= 5 ? 0 : L <= 6 ? 2 : L <= 7 ? 5 : (L - 5) * (L - 5) * 2);
    const mkScreen = (as, sentence, kwOnly) => ({
      paragraph: pi, para, index: as[0].start, raw: as.map((a) => a.head + a.text + a.tail).join(''),
      tokens: as.length, len: as.reduce((n, a) => n + a.len, 0), kwOnly, sentence,
    });
    sentences.forEach((atomsS, sentence) => {
      // 先按关键词把一句拆成几段：关键词（加后面一个单字虚词）固定单独成屏
      let run = [];
      const flushRun = () => {
        if (!run.length) return;
        const n = run.length;
        const best = new Array(n + 1).fill(Infinity); const from = new Array(n + 1).fill(-1);
        best[0] = 0;
        for (let i = 1; i <= n; i++) {
          for (let j = i - 1; j >= 0; j--) {
            const piece = run.slice(j, i);
            const L = piece.reduce((s, a) => s + a.len, 0);
            if (L > maxChars + 1 && piece.length > 1) break; // 再往前装更长，不用试了
            if (piece[0].func && j > 0) continue; // 单字虚词不许在屏首
            const endWord = run[i - 1].text;
            // 断在「的」后面会把修饰语和中心语拆开（「抓眼球的｜金句」），也要加代价
            const breakCost = i < n ? (BAD_END.has(endWord) ? 4 : endWord.endsWith('的') ? 2.5 : 0) : 0;
            const c = best[j] + 1 + lenCost(L) + breakCost + (piece.length > 4 ? 3 : 0);
            if (c < best[i]) { best[i] = c; from[i] = j; }
          }
        }
        for (let i = 1; i <= n; i++) if (!Number.isFinite(best[i])) { best[i] = best[i - 1] + 100; from[i] = i - 1; } // 兜底：找不到合法切法就单独成屏
        const cuts = []; for (let i = n; i > 0; i = from[i]) cuts.unshift([from[i], i]);
        for (const [a, b] of cuts) screens.push(mkScreen(run.slice(a, b), sentence, false));
        run = [];
      };
      for (let k = 0; k < atomsS.length; k++) {
        const a = atomsS[k];
        if (a.emph) {
          flushRun();
          const grp = [a];
          // 关键词后面最多带两个单字虚词（「好笑了吧」）
          while (grp.length < 3 && atomsS[k + 1] && atomsS[k + 1].func && !atomsS[k + 1].emph) { grp.push(atomsS[k + 1]); k++; }
          screens.push(mkScreen(grp, sentence, true));
        } else run.push(a);
      }
      flushRun();
    });
  });

  // ---------- 2. 每个字的时间 ----------
  // 全文的字（按段、按段内位置），标点和空格也列出来，但只有「说出来的字」有自己的时间
  const chars = [];
  rawLines.forEach((rawLine, pi) => {
    const para = rawLine.trim();
    if (!para) return;
    let off = 0;
    for (const ch of para) { chars.push({ pi, off, ch, speak: !(DROP.has(ch) || KEEP.has(ch) || isSpace(ch)) }); off += ch.length; }
    chars.push({ pi, off, ch: '\n', speak: false, paraEnd: true });
  });
  // 时间偏移由底座的 --words-offset 统一做，传进来的 ctx.words 已经加过了，风格这里不再加
  const offsetS = 0;
  let estimated = true;
  const words = Array.isArray(ctx.words) ? ctx.words : [];
  if (words.length) {
    // 把转写的每一段平均分给它里面的字，再按顺序对到原文上
    const q = [];
    for (const w of words) {
      const cs = [...String(w.text)].filter((ch) => !(DROP.has(ch) || KEEP.has(ch) || isSpace(ch)));
      cs.forEach((ch, k) => q.push({ ch, start: w.start + ((w.end - w.start) * k) / cs.length, end: w.start + ((w.end - w.start) * (k + 1)) / cs.length }));
    }
    const speakers = chars.filter((c) => c.speak);
    const ok = speakers.length === q.length && speakers.every((c, i) => c.ch === q[i].ch);
    if (ok) { speakers.forEach((c, i) => { c.start = q[i].start + offsetS; c.end = q[i].end + offsetS; }); estimated = false; }
    if (!estimated) {
      // 识别工具常把停顿算进前后字的时长（实测：句尾的字被拉到 0.66 秒，中位数才 0.175 秒），
      // 这样「停顿超过 0.6 秒字就消失」永远触发不了。先把超长的字截短：超过中位数 2.5 倍的，截到开始加 2 倍中位数
      const durs = speakers.map((c) => c.end - c.start).sort((x, y) => x - y);
      const med = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
      if (med > 0) for (const c of speakers) if (c.end - c.start > 2.5 * med) c.end = c.start + 2 * med;
    }
    else warnings.push({ type: 'words-mismatch', detail: '逐字时间跟文字对不上，改用估的时间' });
  }
  if (estimated) {
    let t = 0.25;
    for (const c of chars) {
      if (c.paraEnd) { t += 0.45; continue; }
      if (c.speak) { c.start = t + offsetS; t += 0.23; c.end = t + offsetS; continue; }
      if ('。！？!?…'.includes(c.ch)) t += 0.4; else if ('，、；：,;:'.includes(c.ch)) t += 0.18;
    }
  }
  const charAt = (pi, off) => chars.find((c) => c.pi === pi && c.off === off);
  // 每屏：第一个和最后一个说出来的字
  for (const s of screens) {
    let first = null; let last = null; let off = s.index;
    for (const ch of s.raw) {
      const c = charAt(s.paragraph, off);
      if (c && c.speak) { if (!first) first = c; last = c; }
      off += ch.length;
    }
    s.speechStart = first ? first.start : (screens.length ? 0 : 0);
    s.speechEnd = last ? last.end : s.speechStart + 0.25;
  }

  // 合并太短的屏：一屏不到 0.25 秒，跟下一屏合并（同一段、合起来不超过 maxChars＋2 个字）
  const lead = 2 / fps;
  for (let i = 0; i < screens.length - 1; i++) {
    const a = screens[i]; const b = screens[i + 1];
    const dur = b.speechStart - a.speechStart;
    const endsSentence = [...a.raw].some((ch) => BREAK_AFTER.has(ch));
    if (dur < 0.25 && a.paragraph === b.paragraph && !endsSentence && a.len + b.len <= maxChars + 2) {
      a.raw += b.raw; a.len += b.len; a.tokens += b.tokens; a.speechEnd = b.speechEnd;
      screens.splice(i + 1, 1); i--;
    }
  }
  // 起止时间
  screens.forEach((s, i) => {
    s.start = Math.max(0, s.speechStart - lead);
    const next = screens[i + 1];
    if (!next) s.end = s.speechEnd + 0.35;
    else if (next.speechStart - s.speechEnd > 0.6) s.end = s.speechEnd + 0.2; // 停顿长：提前消失，画面空着
    else s.end = Math.max(s.start + 0.25, next.speechStart - lead);
    s.sentenceEnd = !next || next.paragraph !== s.paragraph || [...s.raw].some((ch) => '。！？!?'.includes(ch));
  });

  // ---------- 3. 排版每一屏 ----------
  const fs0 = clamp(P.size, 0.06, 0.18) * short;
  const strokeW = box === 'outline' ? 0.06 * (P.outline ?? 1) : box === 'neon' ? 0.03 : 0;
  const maxW = W * 0.84;
  const layers = { back: el('g', {}), main: el('g', {}) };
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
  root.appendChild(svg);
  const defs = el('defs', {}, svg);
  el('feGaussianBlur', { stdDeviation: f3(fs0 * 0.06) }, el('filter', { id: `${U}soft`, x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs));
  el('feGaussianBlur', { stdDeviation: f3(fs0 * 0.09) }, el('filter', { id: `${U}glow`, x: '-40%', y: '-40%', width: '180%', height: '180%' }, defs));
  svg.appendChild(layers.back); svg.appendChild(layers.main);

  const cy = (P.y ?? (H > W ? 0.62 : 0.78)) * H;
  const cx = (P.x ?? 0.5) * W;
  const textColor = box === 'block' ? K.fill : K.fill;
  screens.forEach((s, si) => {
    // 显示的字：去掉不显示的标点，首尾空格去掉
    const glyphs = [];
    let off = s.index;
    const rawChars = [...s.raw];
    rawChars.forEach((ch, k) => {
      // 夹在两个数字或字母中间的「. , :」是小数点、千分位、时刻，要留下（「3.5倍」不能变成「35倍」）
      const inNumber = '.,:'.includes(ch) && isLatin(rawChars[k - 1] || '') && isLatin(rawChars[k + 1] || '');
      if (!DROP.has(ch) || inNumber) glyphs.push({ ch, emph: ctx.isEmphasis(s.paragraph, off) });
      off += ch.length;
    });
    while (glyphs.length && isSpace(glyphs[0].ch)) glyphs.shift();
    while (glyphs.length && isSpace(glyphs.at(-1).ch)) glyphs.pop();
    s.display = glyphs.map((g) => g.ch).join('');
    s.keyword = glyphs.some((g) => g.emph);
    if ([...s.display.replace(/\s/g, '')].length === 1 && !KEEP.has(s.display)) warnings.push({ type: 'single-char-screen', detail: `第 ${si + 1} 屏只有一个字「${s.display}」` });
    // 字号：放不下就缩，最多缩到 70%
    const widthAt = (px) => {
      let w = 0; let prev = null;
      for (const g of glyphs) {
        const sc = g.emph ? emphScale * (showcase ? 1 + 0.12 * flair : 1) : 1;
        if (prev && isLatin(prev) !== isLatin(g.ch) && !isSpace(prev) && !isSpace(g.ch)) w += 0.1 * px; // 中西文之间补一点
        w += measure(g.ch, px * sc) + (isSpace(g.ch) ? 0 : -0.02 * px);
        prev = g.ch;
      }
      return w + 2 * strokeW * px + 0.1 * px;
    };
    let fs = fs0;
    if (widthAt(fs) > maxW) fs = Math.max(fs0 * 0.7, (fs0 * maxW) / widthAt(fs0));
    if (widthAt(fs) > maxW) warnings.push({ type: 'too-wide', detail: `第 ${si + 1} 屏「${s.display}」缩到 70% 还放不下` });
    s.fs = fs;
    // 搭这一屏
    const g = el('g', { visibility: 'hidden' }, layers.main);
    const inner = el('g', {}, g);
    const totalW = widthAt(fs) - 2 * strokeW * fs - 0.1 * fs;
    let x = -totalW / 2; let prev = null;
    const nodes = [];
    for (const gl of glyphs) {
      const sc = gl.emph ? emphScale * (showcase ? 1 + 0.12 * flair : 1) : 1;
      const px = fs * sc;
      if (prev && isLatin(prev) !== isLatin(gl.ch) && !isSpace(prev) && !isSpace(gl.ch)) x += 0.1 * fs;
      const w = measure(gl.ch, px);
      nodes.push({ ch: gl.ch, emph: gl.emph, x, w, px });
      x += w + (isSpace(gl.ch) ? 0 : -0.02 * fs);
      prev = gl.ch;
    }
    const baseline = fs * 0.36;
    const kwNodes = nodes.filter((n) => n.emph);
    // 底块（C3 白底黑字）：整屏一个圆角白块，关键词再垫一块
    let block = null; let kwBlock = null;
    const pad = fs * 0.22;
    if (box === 'block') block = el('rect', { x: f3(-totalW / 2 - pad), y: f3(-fs * 0.62), width: f3(totalW + 2 * pad), height: f3(fs * 1.24), rx: f3(fs * 0.18), fill: K.bg }, inner);
    if (kwNodes.length && (box === 'block' || showcase)) {
      const x0 = kwNodes[0].x - fs * 0.1; const x1 = kwNodes.at(-1).x + kwNodes.at(-1).w + fs * 0.1;
      const hh = Math.max(...kwNodes.map((n) => n.px)) * 1.08;
      kwBlock = el('rect', { x: f3(x0), y: f3(-hh / 2 - fs * 0.02), width: f3(x1 - x0), height: f3(hh), rx: f3(fs * 0.08), fill: showcase ? K.accent : K.fill2 }, inner);
      kwBlock.dataset.x0 = String(x0);
    }
    const shadowEls = []; const glowEls = []; const textEls = [];
    for (const n of nodes) {
      if (isSpace(n.ch)) continue;
      const attrs = { x: f3(n.x), y: f3(baseline * (n.px / fs)), 'font-family': family, 'font-size': f3(n.px), 'font-weight': 900 };
      if (box === 'outline' || box === 'shadow' || box === 'neon') {
        // 招牌造型整屏会微微倾斜；倾斜加上模糊滤镜，乱序渲染会差 1 个色阶（11-19 实测，关掉倾斜就一致），
        // 所以招牌造型用不模糊的硬投影，日常造型照旧用柔和投影
        shadowEls.push(el('text', {
          ...attrs, x: f3(n.x + fs * (showcase ? 0.05 : 0.03)), y: f3(baseline * (n.px / fs) + fs * (showcase ? 0.07 : 0.05)), fill: K.shadow,
          'fill-opacity': showcase ? 0.85 : box === 'shadow' ? 0.7 : 0.55, stroke: K.shadow, 'stroke-opacity': showcase ? 0.85 : 0.55,
          'stroke-width': f3(strokeW * fs * 2 + fs * 0.02), 'stroke-linejoin': 'round', ...(showcase ? {} : { filter: `url(#${U}soft)` }),
        }, inner));
        shadowEls.at(-1).textContent = n.ch; // 投影这一层也要填字（第一版漏了，投影一直没画出来）
      }
      if (box === 'neon') glowEls.push(el('text', { ...attrs, fill: 'none', stroke: n.emph ? K.accent : K.inner, 'stroke-width': f3(fs * 0.14), 'stroke-linejoin': 'round', filter: `url(#${U}glow)` }, inner));
      if (box === 'neon') glowEls.at(-1).textContent = n.ch;
      const onBlock = n.emph && kwBlock;
      const fill = onBlock ? (showcase ? K.fill : K.outer) : n.emph ? K.accent : (box === 'block' ? K.outer : textColor);
      const t = el('text', {
        ...attrs, fill,
        ...(strokeW > 0 && !onBlock ? { stroke: K.outer, 'stroke-width': f3(strokeW * fs * 2), 'paint-order': 'stroke', 'stroke-linejoin': 'round' } : {}),
        ...(onBlock && showcase ? { stroke: K.outer, 'stroke-width': f3(fs * 0.05), 'paint-order': 'stroke', 'stroke-linejoin': 'round' } : {}),
      }, inner);
      t.textContent = n.ch;
      textEls.push(t);
    }
    Object.assign(s, { g, inner, kwBlock, block, textEls, shadowEls, glowEls, totalW, rotSign: hash01(seed, 'rot', si) < 0.5 ? -1 : 1 });
  });

  // ---------- 4. 每一刻怎么动（纯函数） ----------
  const hardIn = R.id === 'R2'; const softIn = R.id === 'R3';
  function seek(t) {
    let shown = -1;
    for (let i = screens.length - 1; i >= 0; i--) { if (t >= screens[i].start && t < screens[i].end) { shown = i; break; } }
    screens.forEach((s, i) => {
      if (i !== shown) { set(s.g, { visibility: 'hidden' }); return; }
      const tau = t - s.start;
      let sc = 1; let dx = 0; let dy = 0; let rot = 0; let fade = 1;
      const kw = s.keyword;
      if (softIn) {
        const u = easeOutCubic(clamp(tau / 0.2));
        fade = u; dy = (1 - u) * 0.02 * H;
      } else if (kw || showcase) {
        const freq = hardIn ? 6 : 4.2;
        sc = (kw ? 0.8 : 0.9) + (kw ? 0.2 : 0.1) * spring(tau, { freq, damping: 0.42 });
        // 弹簧尾巴的死区：非关键词屏之后会一直停着，离中心最远的点挪不到 0.05 像素就直接取 1。
        // 不然停住前那几帧几乎没动，浏览器光栅化会随渲染顺序摇摆（ADR-001「几乎没动的一帧」）。关键词屏后面有呼吸，一直在动，不用管。
        if (!kw && Math.abs(sc - 1) * 0.5 * Math.max(W, H) < 0.05) sc = 1;
        if (hardIn && kw) { const f = Math.floor(tau * fps); dx = f === 0 ? 0.03 * s.fs : f === 1 ? -0.03 * s.fs : 0; }
      } else {
        sc = 0.94 + 0.06 * easeOutCubic(clamp(tau / 0.12));
      }
      // 招牌：关键词先刷色块（0.08 秒），字再砸进去，落地震一下；每屏左右交替微微倾斜
      if (showcase) {
        rot = box === 'neon' ? 0 : s.rotSign * 2 * flair; // 霓虹的外发光要用模糊滤镜，倾斜加滤镜乱序渲染会对不上，所以霓虹不倾斜
        if (kw) {
          const slam = tau - 0.06;
          sc *= slam < 0 ? 1.35 : 1 + 0.35 * Math.max(0, 1 - spring(slam, { freq: 5, damping: 0.5 }));
          dy += impulse(tau - 0.14, { freq: 7, decay: 14 }) * 0.04 * s.fs * flair;
        }
      }
      if (s.kwBlock) {
        const u = showcase ? easeOutCubic(clamp(tau / 0.08)) : 1;
        const x0 = Number(s.kwBlock.dataset.x0);
        set(s.kwBlock, { transform: `translate(${f3(x0)},0) scale(${f3(Math.max(u, 0.001))},1) translate(${f3(-x0)},0)` });
      }
      // 停留：关键词轻轻呼吸
      if (kw && tau > 0.2) sc *= 1 + 0.02 * Math.sin(TAU * 1.4 * (tau - 0.2));
      // 句末最后一屏：最后 0.08 秒淡出（透明度设在单个字上，不设在整组上）
      if (s.sentenceEnd) fade *= 1 - clamp((t - (s.end - 0.08)) / 0.08);
      for (const e of s.textEls) set(e, { 'fill-opacity': fade, 'stroke-opacity': fade });
      for (const e of s.shadowEls) set(e, { 'fill-opacity': (showcase ? 0.85 : box === 'shadow' ? 0.7 : 0.55) * fade, 'stroke-opacity': (showcase ? 0.85 : 0.55) * fade });
      for (const e of s.glowEls) set(e, { 'stroke-opacity': fade });
      if (s.block) set(s.block, { 'fill-opacity': fade });
      if (s.kwBlock) set(s.kwBlock, { 'fill-opacity': fade });
      set(s.g, { visibility: 'visible', transform: `translate(${f3(cx + dx)},${f3(cy + dy)}) rotate(${f3(rot)}) scale(${f3(sc)})` });
    });
  }

  const duration = screens.length ? screens.at(-1).end + 0.3 : 1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '第一屏出现', start: 0, end: screens.length ? screens[0].start + 0.12 : 0 },
      { name: 'hold', label: '逐屏跟着说话换', start: screens.length ? screens[0].start + 0.12 : 0, end: screens.length ? screens.at(-1).end : duration },
      { name: 'outro', label: '结束', start: screens.length ? screens.at(-1).end : duration, end: duration },
    ],
    beats: screens.filter((s) => s.keyword).map((s) => ({ t: s.start + lead, name: 'keyword', label: `关键词「${s.display}」出现` })),
    units: screens.map((s, i) => ({ i, text: s.display, raw: s.raw, start: s.start, end: s.end, keyword: s.keyword, fontSize: s.fs, estimated })),
  };
  // 排版检查：每屏的原文（含标点）按段拼回去要等于原文；屏和屏的分界必须在词边界上
  const linesDetail = screens.map((s) => ({ text: s.raw, paragraph: s.paragraph }));
  const layout = {
    fontSize: fs0,
    lines: screens.map((s) => s.display),
    linesDetail,
    forced: [],
    issues: checkLineBreaks(linesDetail, ctx.text, { segment: ctx.segment }),
    warnings,
    segmentation: ctx.segmentation ? ctx.segmentation.sources : [],
    emphasis: screens.filter((s) => s.keyword).map((s) => s.display).join('、'),
    units: screens.length,
    timingEstimated: estimated,
    screens: screens.length,
  };
  seek(0);
  return { timeline, layout, seek, destroy() { svg.remove(); } };
}
