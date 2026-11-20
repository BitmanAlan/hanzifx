#!/usr/bin/env node
// 把各种转写结果变成 004 要的逐字时间文件（--words-file 用的那种）：[{ text, start, end }, …]，单位秒，按时间升序。
//
//   node styles/004-word-pop-captions/tools/to-words.mjs <输入文件> [--out 时间.json] [--text "口播稿" | --text-file 口播稿.txt]
//
// 认得这几种输入（按内容自动判断）：
//   1. SRT 字幕（剪映、各家剪辑软件都能导出）：一条字幕一段，时间按字数平均分给里面的字（是估的）
//   2. rea-video 的 breakdown.json：用 speech.lines（语音识别出来的台词，每句有起止时间）
//   3. whisper 一类的 JSON：segments[].words[]（{ word, start, end }，词级时间，最准）；没有 words 就用 segments[]
//   4. whisper.cpp 的 -ojf 输出：transcription[].tokens[]，时间在 offsets.from / offsets.to（毫秒）。
//      跳过 [_BEG_]、[_TT_…]、<|…|> 这类特殊标记；中文一个字可能被拆成两个 token（会出现半个字的乱码 �），
//      哪一段有这种情况，这一段就改用整段文字和整段时间（段内的字时间是估的）
//   5. 已经是 [{ text, start, end }] 的数组：原样检查后输出
//
// 加 --text（或 --text-file）口播稿时：把识别结果按字做编辑距离，对齐到口播稿上——
//   对上的字用识别出来的时间；对不上的字（认错、漏认）在前后两个对上的字之间插值；识别里多出来的字丢掉。
//   输出的时间文件一字一项、逐字等于口播稿（去掉空白和标点以后），能直接过底座的严格校验。
//   打印对上的比例，列出哪几个字是插值出来的；对上的比例低于 85% 就报错、不输出（多半不是同一段话）。
//   去标点的规则跟底座（engine/src/lib/words.js）一样：按「看到的一个字」拆，去掉空白和 Unicode 标点，去掉 * 和 | 标记。
//
// 2026-11-20 从按字对齐的原型改写而来，补了插值到头尾、连续错字合并报告、85% 的线、whisper.cpp 格式。零依赖，只用 Node 自带的模块。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIN_RATIO = 0.85;
const PER_CHAR = 0.23; // 头尾没有锚点可插值时，每字估多少秒（004 的语速估计）

const seg = new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' });
/** 说出来的字：跟底座同一个规则——去掉 * | 标记，按「看到的一个字」拆，去掉空白和标点 */
export const spokenChars = (s) => Array.from(seg.segment(String(s).replace(/[|*]/g, '')), (x) => x.segment).filter((g) => !/^[\s\p{P}]+$/u.test(g));
const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

function fromSrt(text) {
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex((l) => /-->/.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const t = lines.slice(ti + 1).join('').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
    if (t) out.push({ text: t, start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]) });
  }
  return { words: out, kind: 'SRT（一条字幕一段，字的时间是估的）' };
}

const SPECIAL = /^\s*(\[_[^\]]*\]|<\|[^|]*\|>)\s*$/;

function fromWhisperCpp(obj) {
  const out = []; let fallbackSegs = 0;
  for (const s of obj.transcription) {
    const toks = (Array.isArray(s.tokens) ? s.tokens : []).filter((t) => t && typeof t.text === 'string' && !SPECIAL.test(t.text) && t.offsets);
    const broken = toks.some((t) => t.text.includes('�'));
    if (toks.length && !broken) {
      for (const t of toks) if (t.text.trim()) out.push({ text: t.text.trim(), start: t.offsets.from / 1000, end: t.offsets.to / 1000 });
    } else if (s.text && s.offsets) {
      // 这一段的 token 有半个字（乱码）或者没有 token：用整段文字和整段时间
      fallbackSegs++;
      out.push({ text: String(s.text).trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000 });
    }
  }
  return { words: out, kind: `whisper.cpp -ojf（token 级时间${fallbackSegs ? `；有 ${fallbackSegs} 段的 token 拆坏了字，这几段用整段时间估` : ''}）` };
}

function fromJson(obj) {
  if (Array.isArray(obj) && obj.length && obj.every((x) => x && 'text' in x && 'start' in x && 'end' in x)) return { words: obj, kind: '已经是逐字时间格式' };
  if (obj && Array.isArray(obj.transcription)) return fromWhisperCpp(obj);
  if (obj && obj.speech && Array.isArray(obj.speech.lines)) {
    return { words: obj.speech.lines.map((l) => ({ text: l.text, start: l.start, end: l.end })), kind: 'rea-video 语音识别（一句一段，句内的字时间是估的）' };
  }
  if (obj && Array.isArray(obj.segments)) {
    const ws = obj.segments.flatMap((s) => (Array.isArray(s.words) ? s.words : []));
    if (ws.length) return { words: ws.map((w) => ({ text: String(w.word ?? w.text).trim(), start: w.start, end: w.end })).filter((w) => w.text), kind: 'whisper 词级时间' };
    return { words: obj.segments.map((s) => ({ text: String(s.text).trim(), start: s.start, end: s.end })), kind: 'whisper 句级时间（句内的字时间是估的）' };
  }
  return null;
}

/** 认格式、整理成 [{ text, start, end }]（按时间升序，去掉没有字的段）。认不出返回 null */
export function parseTranscript(raw) {
  let res = null;
  if (/-->/.test(raw)) res = fromSrt(raw);
  else {
    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }
    res = fromJson(obj);
  }
  if (!res) return null;
  const words = res.words
    .map((w) => ({ text: String(w.text), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start && spokenChars(w.text).length)
    .sort((a, b) => a.start - b.start);
  return { words, kind: res.kind };
}

/**
 * 把识别结果按字对齐到口播稿上。返回 { words（口播稿每个字一项）, ratio, interpolated: [{ index, char, heard }] }。
 * heard：这个位置识别成了什么字（编辑距离里的替换），没识别到是 null。
 */
export function alignToScript(words, script) {
  // 识别结果摊成逐字（一段里有几个字就平分这一段的时间）
  const A = []; const At = [];
  for (const w of words) {
    const cs = spokenChars(w.text);
    cs.forEach((c, k) => { A.push(c); At.push([w.start + ((w.end - w.start) * k) / cs.length, w.start + ((w.end - w.start) * (k + 1)) / cs.length]); });
  }
  const B = spokenChars(script);
  const n = A.length; const m = B.length;
  if (!m) return { words: [], ratio: 1, interpolated: [] };
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = 0; i <= n; i++) dp[i * W] = i;
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * W + j] = Math.min(dp[(i - 1) * W + j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1), dp[(i - 1) * W + j] + 1, dp[i * W + j - 1] + 1);
    }
  }
  // 回溯：口播稿第 j 个字对到识别的第几个字（-1 没对上），是不是同一个字
  const map = new Int32Array(m).fill(-1); const same = new Uint8Array(m);
  let i = n; let j = m;
  while (i > 0 && j > 0) {
    const cur = dp[i * W + j];
    if (cur === dp[(i - 1) * W + j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)) { map[j - 1] = i - 1; same[j - 1] = A[i - 1] === B[j - 1] ? 1 : 0; i--; j--; } else if (cur === dp[(i - 1) * W + j] + 1) i--; else j--;
  }
  // 只有一字不差的才当锚点；认错的字（替换）和漏认的字都在前后锚点之间插值
  const out = B.map((c, k) => (same[k] ? { text: c, start: At[map[k]][0], end: At[map[k]][1] } : { text: c, start: null, end: null }));
  for (let k = 0; k < m; k++) {
    if (out[k].start != null) continue;
    let a = k - 1; while (a >= 0 && out[a].start == null) a--;
    let b = k + 1; while (b < m && !same[b]) b++;
    const ta = a >= 0 ? out[a].end : null; const tb = b < m ? out[b].start : null;
    for (let x = k; x < b; x++) {
      let s; let e;
      if (ta != null && tb != null) { const step = (tb - ta) / (b - a - 1); s = ta + step * (x - a - 1); e = s + step; } else if (ta != null) { s = ta + PER_CHAR * (x - a - 1); e = s + PER_CHAR; } else if (tb != null) { e = tb - PER_CHAR * (b - x - 1); s = e - PER_CHAR; } else { s = PER_CHAR * x; e = s + PER_CHAR; } // 一个锚点都没有：从 0 秒按语速估
      out[x].start = Math.max(0, s); out[x].end = Math.max(out[x].start, e);
    }
    k = b - 1;
  }
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  for (const w of out) { w.start = r6(w.start); w.end = r6(w.end); }
  const interpolated = [];
  for (let k = 0; k < m; k++) if (!same[k]) interpolated.push({ index: k + 1, char: B[k], heard: map[k] >= 0 ? A[map[k]] : null });
  return { words: out, ratio: (m - interpolated.length) / m, interpolated };
}

export const describeInterpolated = (list, limit = 40) => list.slice(0, limit).map((x) => `第 ${x.index} 个字『${x.char}』：${x.heard ? `识别成『${x.heard}』` : '没识别到'}，插值`).join('\n') + (list.length > limit ? `\n……还有 ${list.length - limit} 个` : '');

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const input = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
  const fail = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };
  if (!input) fail('用法：node to-words.mjs <输入文件> [--out 时间.json] [--text "口播稿" | --text-file 口播稿.txt]', 2);
  let raw;
  try { raw = readFileSync(input, 'utf8'); } catch { fail(`读不了输入文件：${input}`, 2); }
  const parsed = parseTranscript(raw);
  if (!parsed) fail('认不出这个文件的格式：支持 SRT、rea-video 的 breakdown.json、whisper 的 segments JSON、whisper.cpp 的 -ojf JSON、[{text,start,end}] 数组', 2);
  if (!parsed.words.length) fail(`认出来是：${parsed.kind}，可是里面没有带时间的字`, 2);
  const nChars = parsed.words.reduce((s, w) => s + spokenChars(w.text).length, 0);
  console.error(`认出来是：${parsed.kind}；共 ${parsed.words.length} 段，${nChars} 个说出来的字`);

  let script = opt('--text');
  const tf = opt('--text-file');
  if (tf) { try { script = readFileSync(tf, 'utf8'); } catch { fail(`读不了口播稿文件：${tf}`, 2); } }
  let words = parsed.words;
  if (script != null) {
    const r = alignToScript(parsed.words, script);
    const pct = (r.ratio * 100).toFixed(1);
    if (r.ratio < MIN_RATIO) {
      console.error(describeInterpolated(r.interpolated, 12));
      fail(`口播稿 ${r.words.length} 个字只对上 ${pct}%（低于 ${MIN_RATIO * 100}%），多半不是同一段话，没有输出`);
    }
    console.error(`✓ 按字对齐到口播稿：${r.words.length} 个字，对上 ${pct}%${r.interpolated.length ? `，${r.interpolated.length} 个字是插值出来的：` : '，没有插值'}`);
    if (r.interpolated.length) console.error(describeInterpolated(r.interpolated));
    words = r.words;
  }
  const json = JSON.stringify(words, null, 1);
  const out = opt('--out');
  if (out) { writeFileSync(out, json + '\n'); console.error(`写到 ${out}`); } else process.stdout.write(json + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
