// 中文排版小工具：拆字、分词断行（不在词中间断）、标点禁则、检查。
// 浏览器和 Node 都能跑（只用 Intl.Segmenter，不碰 DOM）。量宽度由调用方传函数进来。
// 分词 = 浏览器自带 ICU 分词 + 本项目的补充词表（lexicon.js），零依赖。

import { applyLexicon, BUILTIN_WORDS } from './lexicon.js';

/** 不能出现在行首的标点（避头） */
export const LINE_START_FORBIDDEN = new Set([...'，。、；：？！）》」』】〕〉〗…—～·%,.;:?!)]}”’']);
/** 不能出现在行尾的标点（避尾） */
export const LINE_END_FORBIDDEN = new Set([...'（《「『【〔〈〖“‘([{']);
/** 不宜放在行首的单字虚词（语气词、助词）：排版时粘到前一个词后面。分词仍然把它们单独切开（切分标准第 5 条），这里只是少了一个断行点 */
export const PARTICLES = new Set([...'了吧啊呢吗呀哦嘛啦咯呗的地得着过']);
/** 全角标点：字身是一个字宽，墨迹只占一小块，排版时要按墨迹收紧（标点挤压） */
export const FULLWIDTH_PUNCT = new Set([...'，。、；：？！（）《》「」『』【】〔〕〈〉〖〗“”‘’…—～·']);

const graphemeSeg = new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' });
const wordSeg = new Intl.Segmenter('zh-Hans', { granularity: 'word' });

/** 按「用户看到的一个字」拆分（emoji、组合字符不会被拆坏） */
export function graphemes(str) {
  return Array.from(graphemeSeg.segment(str), (s) => s.segment);
}

/** 全文用到的不重复字符（去掉空白），按码位排序，用来做字体子集 */
export function charset(str) {
  const set = new Set();
  for (const g of graphemes(str)) {
    for (const ch of g) if (!/\s/.test(ch)) set.add(ch);
  }
  return [...set].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join('');
}

/** 只用 ICU 的词边界（UTF-16 下标集合），用来对比补充词表的效果 */
export function icuBoundaries(str) {
  const set = new Set([0, str.length]);
  for (const s of wordSeg.segment(str)) {
    set.add(s.index);
    set.add(s.index + s.segment.length);
  }
  return set;
}

/** 词边界：ICU 分词，再按补充词表校正。extraWords 可以加这次专用的词 */
export function wordBoundaries(str, { extraWords = [] } = {}) {
  return applyLexicon(str, icuBoundaries(str), [...BUILTIN_WORDS, ...extraWords]);
}

/** 切词结果 → 边界集合 */
export function boundariesOf(words, str) {
  const set = new Set([0, str.length]);
  for (const w of words) { set.add(w.index); set.add(w.index + w.text.length); }
  return set;
}

/** 按词切开，返回 [{text, index}] */
export function segmentWords(str, opts) {
  const b = [...wordBoundaries(str, opts)].sort((x, y) => x - y);
  const out = [];
  for (let k = 0; k < b.length - 1; k++) out.push({ text: str.slice(b[k], b[k + 1]), index: b[k] });
  return out.filter((s) => s.text.length);
}

const isLatinish = (g) => /^[A-Za-z0-9À-ɏ'’\-_.@#&+]+$/u.test(g);

/**
 * 把一段文字切成「不可再拆的块」：
 * - 中文按 ICU 分词切成词；
 * - 连续的拉丁字母和数字粘在一起；
 * - 避头标点粘到前一块，避尾标点粘到后一块。
 * 每个块记下它在原文里的起始下标，检查断行时要用。
 */
export function atomize(paragraph, opts = {}) {
  const raw = opts.segment ? opts.segment(paragraph) : segmentWords(paragraph, opts);
  // 拉丁/数字连写
  const merged = [];
  for (const a of raw) {
    const prev = merged[merged.length - 1];
    if (prev && isLatinish(prev.text) && isLatinish(a.text)) {
      prev.text += a.text;
    } else merged.push({ ...a });
  }
  // 标点禁则：避头的并到前面，避尾的并到后面
  const out = [];
  let carry = null; // 等着并到下一块的避尾标点
  for (const a of merged) {
    const gs = graphemes(a.text);
    const allStartForbidden = gs.every((g) => LINE_START_FORBIDDEN.has(g));
    const allEndForbidden = gs.every((g) => LINE_END_FORBIDDEN.has(g));
    if (carry) {
      a.text = carry.text + a.text;
      a.index = carry.index;
      carry = null;
    }
    if (allStartForbidden && out.length) {
      out[out.length - 1].text += a.text;
      continue;
    }
    // 单字虚词不放行首：粘到前一块（「了吧」这种连着的也一起粘）
    if (gs.length === 1 && PARTICLES.has(gs[0]) && out.length) {
      out[out.length - 1].text += a.text;
      continue;
    }
    if (allEndForbidden) {
      carry = a;
      continue;
    }
    out.push(a);
  }
  if (carry) {
    if (out.length) out[out.length - 1].text += carry.text;
    else out.push(carry);
  }
  return out.map((a) => ({ ...a, graphemes: graphemes(a.text) }));
}

const posOf = (a, opts) => ({ paragraph: opts && opts.paragraph != null ? opts.paragraph : 0, index: a.index });

function greedy(atoms, widths, limit) {
  const lines = [];
  let cur = [];
  let w = 0;
  for (let i = 0; i < atoms.length; i++) {
    if (cur.length && w + widths[i] > limit) {
      lines.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(atoms[i]);
    w += widths[i];
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * 一段文字断行：先用最少的行数，再在这个行数下把各行宽度拉平（花字不要出现「七个字＋一个字」）。
 * measureAtom(text) 返回这块文字的宽度。
 * 单个词比一行还宽时才按字拆开，这种情况记成 forced。
 */
export function breakParagraph(paragraph, measureAtom, maxWidth, opts) {
  let atoms = atomize(paragraph, opts);
  const m0 = measureAtom;
  measureAtom = (text, pos) => m0(text, pos);
  const forced = [];
  // 太长的块拆成单字（仍保留标点禁则：标点跟着前一个字）
  const expanded = [];
  for (const a of atoms) {
    if (measureAtom(a.text, posOf(a, opts)) <= maxWidth || a.graphemes.length === 1) {
      expanded.push(a);
      continue;
    }
    forced.push(a.text);
    let idx = a.index;
    for (const g of a.graphemes) {
      const prev = expanded[expanded.length - 1];
      if (prev && LINE_START_FORBIDDEN.has(g) && prev.forced) {
        prev.text += g;
        prev.graphemes.push(g);
      } else expanded.push({ text: g, index: idx, graphemes: [g], forced: true });
      idx += g.length;
    }
  }
  atoms = expanded;
  const widths = atoms.map((a) => measureAtom(a.text, posOf(a, opts)));
  const n = greedy(atoms, widths, maxWidth).length;
  let lo = Math.max(...widths, 0);
  let hi = Math.max(maxWidth, lo);
  if (greedy(atoms, widths, lo).length !== n) {
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (greedy(atoms, widths, mid).length <= n) hi = mid;
      else lo = mid;
    }
  } else hi = lo;
  const lines = greedy(atoms, widths, hi);
  return {
    lines: lines.map((ls) => ({
      text: ls.map((a) => a.text).join(''),
      index: ls[0].index,
    })),
    forced,
  };
}

/** 多段（按 \n 分段）断行 */
export function breakText(text, measureAtom, maxWidth, opts) {
  const paragraphs = String(text).replace(/\r/g, '').split('\n');
  const lines = [];
  const forced = [];
  paragraphs.forEach((p, pi) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    const r = breakParagraph(trimmed, measureAtom, maxWidth, { ...opts, paragraph: pi });
    r.lines.forEach((l) => lines.push({ ...l, paragraph: pi }));
    forced.push(...r.forced);
  });
  return { lines, forced };
}

/**
 * 独立检查断行结果（不信排版函数自己说没问题，重新分词核一遍）：
 * - mid-word：断在词中间；
 * - line-start-punct：标点出现在行首；
 * - line-end-punct：开引号、开括号出现在行尾。
 * lines：[{text, paragraph}]，paragraphs：原文按 \n 分段后的数组。
 */
export function checkLineBreaks(lines, text, opts) {
  const paragraphs = String(text).replace(/\r/g, '').split('\n').map((p) => p.trim());
  const issues = [];
  const byPara = new Map();
  for (const l of lines) {
    if (!byPara.has(l.paragraph)) byPara.set(l.paragraph, []);
    byPara.get(l.paragraph).push(l.text);
  }
  for (const [pi, ls] of byPara) {
    const para = paragraphs[pi];
    if (ls.join('') !== para) {
      issues.push({ type: 'text-mismatch', detail: `第 ${pi + 1} 段断行后拼回去跟原文不一致` });
      continue;
    }
    const bounds = opts && opts.segment ? boundariesOf(opts.segment(para), para) : wordBoundaries(para, opts);
    let off = 0;
    ls.forEach((l, li) => {
      if (li > 0) {
        if (!bounds.has(off)) {
          issues.push({ type: 'mid-word', line: li, detail: `「${para.slice(Math.max(0, off - 2), off)}｜${para.slice(off, off + 2)}」断在词中间` });
        }
        const first = graphemes(l)[0];
        if (LINE_START_FORBIDDEN.has(first)) {
          issues.push({ type: 'line-start-punct', line: li, detail: `第 ${li + 1} 行以「${first}」开头` });
        }
        const prevLast = graphemes(ls[li - 1]).at(-1);
        if (LINE_END_FORBIDDEN.has(prevLast)) {
          issues.push({ type: 'line-end-punct', line: li - 1, detail: `第 ${li} 行以「${prevLast}」结尾` });
        }
      }
      off += l.length;
    });
  }
  return issues;
}

const STRONG_BREAK = new Set([...'。！？!?…；;']);
const WEAK_BREAK = new Set([...'，、,：:']);

/** 断行打分的权重（fitText / bestBreak 可以用 opts.weights 覆盖其中几项） */
export const BREAK_WEIGHTS = { width: 1, line: 0.25, plain: 0.22, weak: 0.05, orphan: 0.4, orphanLast: 0.6, balance: 0.15, shrink: 2.0 };

function breakPenalty(prevText, W) {
  const last = graphemes(prevText).at(-1);
  if (STRONG_BREAK.has(last)) return 0;
  if (WEAK_BREAK.has(last)) return W.weak;
  return W.plain;
}

/**
 * 一段文字在给定宽度下的最佳断法（行数 ≤ maxLines）。块数不多时枚举全部断法打分：
 * 最宽那行越窄越好、行数越少越好、断在句末标点后面最好、逗号后面其次、普通词边上再次；
 * 单字成行要扣分；各行宽度要匀称。权重见 BREAK_WEIGHTS。块太多时退回「最少行数 + 拉平」的做法。
 * 返回 { lines:[{text,index}], forced, score }；放不下返回 null。
 */
export function bestBreak(paragraph, measureAtom, maxWidth, { maxLines = 3, weights, ...opts } = {}) {
  const Wt = { ...BREAK_WEIGHTS, ...(weights || {}) };
  const atoms0 = atomize(paragraph, opts);
  if (atoms0.length === 0) return { lines: [], forced: [], score: 0 };
  if (atoms0.some((a) => measureAtom(a.text, posOf(a, opts)) > maxWidth)) {
    const r = breakParagraph(paragraph, measureAtom, maxWidth, opts);
    return r.lines.length <= maxLines ? { ...r, score: 9 } : null;
  }
  const atoms = atoms0;
  const widths = atoms.map((a) => measureAtom(a.text, posOf(a, opts)));
  const m = atoms.length;
  if (m > 24) {
    const r = breakParagraph(paragraph, measureAtom, maxWidth, opts);
    return r.lines.length <= maxLines ? { ...r, score: 5 } : null;
  }
  let best = null;
  const evalCuts = (cuts) => {
    const bounds = [0, ...cuts, m];
    const lw = [];
    let pen = 0;
    for (let k = 0; k < bounds.length - 1; k++) {
      let w = 0;
      for (let i = bounds[k]; i < bounds[k + 1]; i++) w += widths[i];
      if (w > maxWidth) return;
      lw.push(w);
      const text = atoms.slice(bounds[k], bounds[k + 1]).map((a) => a.text).join('');
      if (k > 0) pen += breakPenalty(atoms[bounds[k] - 1].text, Wt);
      if (graphemes(text).length === 1 && bounds.length > 2) pen += k === bounds.length - 2 ? Wt.orphanLast : Wt.orphan;
    }
    const mx = Math.max(...lw);
    const mn = Math.min(...lw);
    const score = Wt.width * (mx / maxWidth) + Wt.line * (lw.length - 1) + pen + Wt.balance * ((mx - mn) / maxWidth);
    if (!best || score < best.score - 1e-12) best = { score, cuts: [...cuts] };
  };
  evalCuts([]);
  for (let a = 1; a < m && maxLines >= 2; a++) {
    evalCuts([a]);
    for (let b = a + 1; b < m && maxLines >= 3; b++) evalCuts([a, b]);
  }
  if (!best) return null;
  const bounds = [0, ...best.cuts, m];
  const lines = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const seg = atoms.slice(bounds[k], bounds[k + 1]);
    lines.push({ text: seg.map((a) => a.text).join(''), index: seg[0].index });
  }
  return { lines, forced: [], score: best.score };
}

/**
 * 自动排字号：从 fs0 开始逐步缩小，每个字号下找最佳断法，综合「断法分数 + 缩小的代价（BREAK_WEIGHTS.shrink）」挑最好的。
 * measureAt(px) 返回「量一个块宽度」的函数；maxWidthAt(px) 返回这个字号下一行最多多宽（要扣掉描边余量）。
 * 多段（\n）时每段各自断行，行数合起来不超过 maxLines。
 */
export function fitText(text, { fs0, measureAt, maxWidthAt, maxLines = 3, maxHeight = Infinity, lineHeight = 1.2, minScale = 0.5, weights, ...opts }) {
  const Wt = { ...BREAK_WEIGHTS, ...(weights || {}) };
  const paragraphs = String(text).replace(/\r/g, '').split('\n').map((p) => p.trim());
  let best = null;
  for (let k = 0; k <= 20; k++) {
    const scale = 1 - k * 0.025;
    if (scale < minScale) break;
    const fs = fs0 * scale;
    const measure = measureAt(fs);
    const maxW = maxWidthAt(fs);
    const lines = []; const forced = []; let score = 0; let ok = true;
    paragraphs.forEach((p, pi) => {
      if (!ok || !p) return;
      const r = bestBreak(p, measure, maxW, { maxLines: maxLines - lines.length, weights, ...opts, paragraph: pi });
      if (!r) { ok = false; return; }
      r.lines.forEach((l) => lines.push({ ...l, paragraph: pi }));
      forced.push(...r.forced);
      score += r.score;
    });
    if (!ok || lines.length > maxLines || lines.length * lineHeight * fs > maxHeight) continue;
    const total = score + Wt.shrink * (1 - scale); // 缩字号的代价
    if (!best || total < best.total - 1e-12) best = { fs, lines, forced, score, total };
  }
  if (best) return best;
  // 实在放不下：最小字号下用最少行数硬排，交给检查报出来
  const fs = fs0 * minScale;
  const r = breakText(text, measureAt(fs), maxWidthAt(fs), opts);
  return { fs, ...r, score: 99, total: 99 };
}

/**
 * 独立核对（只出警告，不卡发布）：用浏览器自带的 ICU 分词重新切一遍，
 * 看断行的位置在 ICU 眼里是不是也在词边上。不一致的地方拿去补词表。
 */
export function icuBreakWarnings(lines, text) {
  const paragraphs = String(text).replace(/\r/g, '').split('\n').map((p) => p.trim());
  const warns = [];
  const byPara = new Map();
  for (const l of lines) {
    if (!byPara.has(l.paragraph)) byPara.set(l.paragraph, []);
    byPara.get(l.paragraph).push(l.text);
  }
  for (const [pi, ls] of byPara) {
    const para = paragraphs[pi];
    if (ls.join('') !== para) continue;
    const icu = icuBoundaries(para);
    let off = 0;
    ls.forEach((l, li) => {
      if (li > 0 && !icu.has(off)) {
        warns.push({ type: 'icu-disagree', detail: `浏览器自带分词认为「${para.slice(Math.max(0, off - 2), off)}｜${para.slice(off, off + 2)}」在词中间（只是提示，可以拿去补词表）` });
      }
      off += l.length;
    });
  }
  return warns;
}
