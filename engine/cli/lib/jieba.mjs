// 第二层分词（Node 端，准备阶段用）：jieba-wasm + 补充词表。
// 浏览器里用的是同一个包的 web 版（src/jieba-browser.js），同一份 wasm 和词典，两边切出来一样。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_WORDS } from '../../src/lib/lexicon.js';
import { ENGINE_DIR } from './fonts.mjs';

const require = createRequire(import.meta.url);
let jw = null;
// jieba-wasm 的 exports 没开放 package.json，直接读文件
export const JIEBA_VERSION = JSON.parse(readFileSync(join(ENGINE_DIR, 'node_modules', 'jieba-wasm', 'package.json'), 'utf8')).version;
export const LEXICON_FREQ = 200000; // 补充词表的词频：要高过 jieba 词典里拆开的组合
export const IDIOM_FREQ = 50000; // 成语的词频

/** 降权词：jieba 词典里频率太高、会把常用词拆开的词（比如「从来不」把「从来／不是」拆坏），照开发集定 */
export function demoteWords() {
  return readFileSync(join(ENGINE_DIR, 'data', 'lexicon-demote.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[0].trim());
}
export const DEMOTE_FREQ = 1;

/** 成语和四字以上固定说法（THUOCL，MIT），见 data/idioms-thuocl.txt */
export function idiomWords() {
  return readFileSync(join(ENGINE_DIR, 'data', 'idioms-thuocl.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
}

export function loadJieba(extraWords = []) {
  if (!jw) {
    jw = require('jieba-wasm');
    for (const w of idiomWords()) jw.add_word(w, IDIOM_FREQ);
    for (const w of BUILTIN_WORDS) jw.add_word(w, LEXICON_FREQ);
    for (const w of demoteWords()) jw.add_word(w, DEMOTE_FREQ);
  }
  for (const w of extraWords) jw.add_word(w, LEXICON_FREQ);
  // 用带词性的切分（tag），规则层要靠词性判断「动词＋补语」；浏览器端也用 tag，两边一致
  return (paragraph) => jw.tag(paragraph, true).map((x) => ({ w: x.word, t: x.tag }));
}

/** 评测用：每次建一个全新的 jieba 实例（清掉模块缓存重新加载 wasm），只加给定的词，互不影响 */
export function loadJiebaWith(words, { idioms = true } = {}) {
  const entry = require.resolve('jieba-wasm');
  for (const k of Object.keys(require.cache)) if (k.includes(`${join('node_modules', 'jieba-wasm')}`)) delete require.cache[k];
  const inst = require(entry);
  for (const k of Object.keys(require.cache)) if (k.includes(`${join('node_modules', 'jieba-wasm')}`)) delete require.cache[k];
  if (idioms) for (const w of idiomWords()) inst.add_word(w, IDIOM_FREQ);
  for (const w of words) inst.add_word(w, LEXICON_FREQ);
  if (idioms) for (const w of demoteWords()) inst.add_word(w, DEMOTE_FREQ);
  return { cut: (paragraph) => inst.tag(paragraph, true).map((x) => ({ w: x.word, t: x.tag })) };
}
