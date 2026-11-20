#!/usr/bin/env node
// 生成 src/lib/lexicon.js：把几份词表合成一份，每个词标来源。改词表改源文件，别手改生成的 lexicon.js。
//   data/lexicon-base.txt        基础词表：开发集（浏览器自带分词会切开的整体单位）＋短视频语料审核通过的词
//   data/lexicon-exp.txt         经验词（v0.1，开发集之前写的，只删不加）
//   data/lexicon-dev-jieba.txt   开发集里 jieba 仍然切错的词（照开发集补）
// 开发集本身不公开（它是评测用的标注数据），这里只用到从它整理出来的词。
// 成语（data/idioms-thuocl.txt）量大，不进 lexicon.js，分词器加载时单独读。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_DIR } from './lib/fonts.mjs';

const read = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const entries = new Map(); // 词 → 来源集合
const add = (w, src) => {
  if (!w) return;
  const e = entries.get(w) || new Set();
  e.add(src);
  entries.set(w, e);
};
for (const l of read(join(ENGINE_DIR, 'data', 'lexicon-base.txt'))) {
  const [w, source = '开发集'] = l.split('\t');
  add(w.trim(), source.includes('语料') ? 'corpus' : 'dev');
}
for (const l of read(join(ENGINE_DIR, 'data', 'lexicon-exp.txt'))) add(l.trim(), 'exp');
for (const l of read(join(ENGINE_DIR, 'data', 'lexicon-dev-jieba.txt'))) add(l.split('\t')[0].trim(), 'dev');
const list = [...entries].map(([w, e]) => [w, [...e].sort().join('+')]);
const body = list.map(([w, s]) => `  [${JSON.stringify(w)}, '${s}'],`).join('\n');
const out = `// 补充词表（由 cli/lexicon-build.mjs 生成，别手改；改词表去改 data/lexicon-*.txt）
// 每条：[词, 来源]。来源：dev 开发集、corpus 短视频语料、exp 经验词（开发集之前写的），多个来源用 + 连
// 规矩：以后补词只照开发集和语料补，不看留出集。版本记录见 engine/docs/词表版本记录.md。
// 数字加单位、英文、型号、叠词、补语这些不进词表，由 segment.js 里的规则处理；成语表单独在 data/idioms-thuocl.txt。
export const LEXICON_VERSION = '0.4';

export const LEXICON = [
${body}
];

/** 取词：sources 不给就是全部；比如 lexiconWords(['dev']) 只要开发集来的 */
export function lexiconWords(sources) {
  return LEXICON.filter(([, src]) => !sources || sources.some((s) => src.split('+').includes(s))).map(([w]) => w);
}

export const BUILTIN_WORDS = lexiconWords();
`;
const old = readFileSync(join(ENGINE_DIR, 'src', 'lib', 'lexicon.js'), 'utf8');
const tail = old.slice(old.indexOf('/**\n * 把 ICU 的词边界按词表校正'));
writeFileSync(join(ENGINE_DIR, 'src', 'lib', 'lexicon.js'), out + '\n' + tail);
const count = {};
for (const [, s] of list) count[s] = (count[s] || 0) + 1;
console.log(`词表 ${list.length} 条：${JSON.stringify(count)}`);
