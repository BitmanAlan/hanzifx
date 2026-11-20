#!/usr/bin/env node
// 分词评测（内部工具，要自备数据）：node cli/seg-eval.mjs <标注数据.tsv>
// 数据格式：第一行是表头；之后每行「句子<TAB>标准切分（用 ／ 隔开）<TAB>备注<TAB>类别（可选）」，备注里写「拿不准」的行不计分。
// 我们自己用的开发集和留出集不公开（发布的仓库里没有），没给文件、文件不存在时只打一句提示就退出。
// 「切开了不该切开的」= 标注的一个单位内部出现了切分（排版时就可能断在词中间，最要命）；
// 「连在一起」= 标注的单位边界没切（少了能断行的位置，问题小）；
// 边界准确率/召回率只算句子内部的边界（不算句首句尾）。
// 规矩：补词表只看开发集，留出集不在这里读，另外有人单独评测。
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENGINE_DIR } from './lib/fonts.mjs';
import { loadJiebaWith } from './lib/jieba.mjs';
import { applyRules } from '../src/lib/segment.js';
import { lexiconWords } from '../src/lib/lexicon.js';

// 内部开发集默认放在内部目录里（不公开）；发布的仓库里没有，要自己给文件
const internal = join(ENGINE_DIR, '..', 'research', 'seg-dev.tsv');
const file = process.argv[2] ? resolve(process.argv[2]) : internal;
if (!existsSync(file)) {
  console.error(`分词评测要一份自己标注的数据（${process.argv[2] ? `找不到 ${file}` : '没给文件'}）。\n用法：node cli/seg-eval.mjs 标注数据.tsv；格式见这个文件开头的注释。`);
  process.exit(2);
}
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).map((line, i) => {
  const [sent, gold, note = '', cat = ''] = line.split('\t');
  return { row: i + 2, sent, gold: gold.split('／'), unsure: note.includes('拿不准'), cat: cat.trim() };
});
// 分类：数据第 4 列写了类别就按它分；没写的话，内部开发集按行号分段（它是按类别成段写的），别的数据就不分
const CATS = file === internal ? [['网络热词', 2, 26], ['平台和产品名', 27, 46], ['AI 术语', 47, 66], ['中英混排', 67, 86], ['数字和单位', 87, 106], ['四字成语', 107, 126], ['口播和带货', 127, 151], ['第二批·真实字幕', 152, 9999]] : [];
const catOf = (r) => r.cat || (CATS.find(([, a, b]) => r.row >= a && r.row <= b) || ['全部'])[0];
const bounds = (units) => { const s = new Set(); let p = 0; for (const u of units.slice(0, -1)) s.add((p += u.length)); return s; };

function score(name, cut) {
  let scored = 0; let exact = 0; let split = 0; let merged = 0; let tp = 0; let pred = 0; let goldB = 0;
  const byCat = new Map(); const splitSamples = [];
  for (const r of rows) {
    const units = cut(r.sent);
    if (units.join('') !== r.sent) throw new Error(`${name}：第 ${r.row} 行切完拼不回原句`);
    if (r.unsure) continue;
    scored++;
    const pb = bounds(units); const gb = bounds(r.gold);
    const ok = units.join('／') === r.gold.join('／');
    if (ok) exact++;
    const c = byCat.get(catOf(r)) || [0, 0]; c[0] += ok ? 1 : 0; c[1]++; byCat.set(catOf(r), c);
    pred += pb.size; goldB += gb.size;
    for (const b of pb) if (gb.has(b)) tp++;
    let p = 0;
    for (const u of r.gold) {
      const s = p; const e = (p += u.length);
      for (let k = s + 1; k < e; k++) if (pb.has(k)) { split++; if (splitSamples.length < 400) splitSamples.push(`${r.row}:${u}`); break; }
      if (e < r.sent.length && !pb.has(e)) merged++;
    }
  }
  return { name, scored, exact, split, merged, precision: tp / pred, recall: tp / goldB, byCat: Object.fromEntries(byCat), splitSamples };
}

const icu = new Intl.Segmenter('zh', { granularity: 'word' });
const J = { none: loadJiebaWith([], { idioms: false }), exp: loadJiebaWith(lexiconWords(['exp'])), dev: loadJiebaWith(lexiconWords(['dev'])), all: loadJiebaWith(lexiconWords()) };
const words = (j) => (s) => j.cut(s).map((x) => x.w);
const configs = [
  ['Intl.Segmenter（基线）', (s) => [...icu.segment(s)].map((x) => x.segment)],
  ['jieba，不加词表（也不加成语表）', words(J.none)],
  ['jieba＋经验词表', words(J.exp)],
  ['jieba＋开发集词表', words(J.dev)],
  ['jieba＋合并词表', words(J.all)],
  ['jieba＋合并词表＋规则（底座现在用的）', (s) => applyRules(J.all.cut(s))],
];
const results = configs.map(([n, f]) => score(n, f));
const pct = (a, b) => `${a}/${b}（${((100 * a) / b).toFixed(1)}%）`;
console.log(`开发集：${file.split('/').slice(-2).join('/')}，${rows.length} 句，计分 ${results[0].scored} 句\n`);
console.log('| 方案 | 整句全对 | 切开了不该切的 | 连在一起 | 边界准确率 | 边界召回率 |');
console.log('|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${pct(r.exact, r.scored)} | ${r.split} | ${r.merged} | ${r.precision.toFixed(3)} | ${r.recall.toFixed(3)} |`);
console.log('\n分类（整句全对／计分句数）：');
for (const r of results) console.log(`- ${r.name}：${Object.entries(r.byCat).map(([k, [a, b]]) => `${k} ${a}/${b}`).join('，')}`);
const last = results.at(-1);
console.log(`\n底座现在用的方案还切开的单位（${last.split} 处）：${last.splitSamples.join('  ')}`);
if (process.argv.includes('--json')) console.log(JSON.stringify(results.map(({ splitSamples, ...r }) => r)));
