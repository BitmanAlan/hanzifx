#!/usr/bin/env node
// 风格目录：从 styles/*/meta.json 生成 README 的索引表和画廊的卡片数据（表和卡都别手改，改 meta.json 再跑这个）。
//
//   node cli/catalog.mjs                          只打印索引表，顺带检查字段
//   node cli/catalog.mjs --readme ../README.md    把索引表写进 README 里两行标记之间（标记外的内容不动）
//   node cli/catalog.mjs --json ../docs/catalog.json   写卡片数据（画廊每张卡一项）
//   node cli/catalog.mjs --readme ../README.md --check  只核对 README 里的表是不是最新，不是就退出码 1（给提交前检查用）；
//       --check 和 --strict 一样，字段不全、样片文件不在也退出码 1
//   node cli/catalog.mjs --template ../docs/README.template.md --readme ../README.md   从模板生成 README：
//       模板里用双花括号包起来的「风格数」「互动数」换成数出来的数（kind=style 和 kind=interaction 各数一个），
//       「字效名单」「互动名单」换成「编号 名字」的名单（中文用 name、顿号隔开；英文用 nameEn、逗号隔开），标记之间换成索引表。
//       哪些风格、什么顺序、怎么分组，跟宣传片拼贴（promo/style-names.mjs）读同一份规则：cli/lib/style-list.mjs
//   加 --lang en 出英文表（给英文 README）：
//   node cli/catalog.mjs --lang en --template ../docs/README.en.template.md --readme ../README.en.md
//       英文表的列：Code｜Name｜中文名｜Type｜What it does｜Default / Signature。用 nameEn、kind、summaryEn、looks[].nameEn；
//       summaryEn 没填就显示「—」并在最后列出来。英文平台名 meta 里还没有，所以英文表不放「适合发哪」。
//
// 索引表的列：编号｜名字｜一句话｜默认 / 招牌｜适合发哪｜状态。「适合发哪」来自 meta.platforms，推断的项后面标「（推断）」；「状态」来自 meta.status。
// 卡片字段：编号、中文名、英文名、曾用名、一句话、调用句（模板和例子）、适合做什么 / 不适合、适合发哪（每项标实测或推断，带依据）、
// 默认和招牌预设、样片文件（核对过文件在不在）、状态。
// README 里的标记：<!-- hanzifx:styles-index:start --> 和 <!-- hanzifx:styles-index:end -->，各占一行。
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { REPO_ROOT } from './lib/server.mjs';
import { listStyles } from './lib/style-list.mjs';

const START = '<!-- hanzifx:styles-index:start -->';
const END = '<!-- hanzifx:styles-index:end -->';
const STATUS = { prototype: '原型可用', draft: '在做', stable: '稳定', deprecated: '不再维护' };
const STATUS_EN = { prototype: 'Prototype', draft: 'In progress', stable: 'Stable', deprecated: 'Deprecated' };
const BASIS = { measured: '实测', inferred: '推断' };
const KIND_EN = { style: 'Text effect', interaction: 'Interactive overlay' };

const args = parseArgs(process.argv.slice(2));
const lang = args.lang === 'en' ? 'en' : 'zh';
if (args.lang && args.lang !== 'en' && args.lang !== 'zh') { console.error(`--lang 只认 zh 和 en，收到 ${args.lang}`); process.exit(2); }
const stylesDir = join(REPO_ROOT, 'styles');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const problems = [];
const cards = [];
// draft-<slug> 还没分配编号、没合并，不进索引表；规则在 lib/style-list.mjs，宣传片拼贴也用它
for (const { dir, meta: m } of await listStyles(stylesDir)) {
  const where = `styles/${dir}`;
  const looks = m.looks || [];
  const byRole = (role) => looks.find((l) => l.role === role) || null;
  const def = byRole('default'); const show = byRole('showcase');
  if (looks.length && !def) problems.push(`${where}：looks 里没有标 role: "default" 的预设`);
  if (looks.length && !show) problems.push(`${where}：looks 里没有标 role: "showcase" 的预设`);
  for (const l of [def, show]) if (l && !l.nameEn) problems.push(`${where}：预设 ${l.id} 没有 nameEn（英文 README 和画廊要用）`);
  if (!m.nameEn) problems.push(`${where}：没有 nameEn（英文 README 和画廊要用）`);
  if (!STATUS[m.status]) problems.push(`${where}：status 要写 ${Object.keys(STATUS).join('、')} 之一，现在是 ${JSON.stringify(m.status)}`);
  if (lang === 'en' && !m.summaryEn) problems.push(`${where}：没有 summaryEn，英文表里先显示「—」`);
  const platforms = Array.isArray(m.platforms) ? m.platforms : [];
  if (!platforms.length) problems.push(`${where}：缺 platforms（适合发哪）`);
  for (const p of platforms) {
    if (!p.name || !BASIS[p.basis] || !p.note) problems.push(`${where}：platforms 里有一项不完整（要有 name、basis=measured/inferred、note）：${JSON.stringify(p)}`);
  }
  // 样片：meta.demo.default / showcase 里写的文件要真的在
  const demo = {};
  for (const [role, d] of Object.entries(m.demo || {})) {
    const files = {};
    for (const k of ['video', 'gif', 'poster']) {
      if (!d[k]) { if (k !== 'video') problems.push(`${where}：demo.${role}.${k} 没写`); continue; }
      const f = join(stylesDir, dir, d[k]);
      const ok = await exists(f);
      // 视频不进仓库（.gitignore），只核动图和海报
      if (!ok && k !== 'video') problems.push(`${where}：demo.${role}.${k} 写的 ${d[k]} 不存在`);
      files[k] = { path: `${where}/${d[k]}`, exists: ok };
    }
    demo[role] = { look: d.look || null, text: d.text || null, ...files };
  }
  const lookLabel = (l) => (l ? `${l.id} ${l.name}` : '—');
  const lookLabelEn = (l) => (l ? `${l.id} ${l.nameEn || l.name}` : '—');
  const cell = (s) => String(s || '').replace(/\|/g, '｜').replace(/\n/g, ' ');
  cards.push({
    code: m.code, id: m.id, dir: where, name: m.name, nameEn: m.nameEn || '', aliases: m.aliases || [], kind: m.kind || 'style', tags: m.tags || [],
    summary: m.summary || '', summaryEn: m.summaryEn || '', invoke: m.invoke || '', invokeTemplate: m.invokeTemplate || '', example: (m.demo && m.demo.default && m.demo.default.text) || '',
    fitFor: m.fitFor || [], notFor: m.notFor || [],
    platforms: platforms.map((p) => ({ name: p.name, basis: p.basis, label: BASIS[p.basis] || p.basis, note: p.note })),
    looks: { default: def && { id: def.id, name: def.name, nameEn: def.nameEn || '' }, showcase: show && { id: show.id, name: show.name, nameEn: show.nameEn || '' } },
    demo, status: m.status || '', statusLabel: STATUS[m.status] || m.status || '', version: m.version || '',
    _row: [m.code, m.name, cell(m.summary), `${lookLabel(def)} / ${lookLabel(show)}`,
      platforms.map((p) => p.name + (p.basis === 'inferred' ? '（推断）' : '')).join('、') || '—', STATUS[m.status] || m.status || '—'],
    _rowEn: [m.code, cell(m.nameEn) || '—', m.name, KIND_EN[m.kind || 'style'] || m.kind, cell(m.summaryEn) || '—', `${lookLabelEn(def)} / ${lookLabelEn(show)}`, STATUS_EN[m.status] || m.status || '—'],
  });
}

const table = lang === 'en' ? [
  '| Code | Name | 中文名 | Type | What it does | Default / Signature | Status |',
  '|---|---|---|---|---|---|---|',
  ...cards.map((c) => `| ${c._rowEn.join(' | ')} |`),
].join('\n') : [
  '| 编号 | 名字 | 一句话 | 默认 / 招牌 | 适合发哪 | 状态 |',
  '|---|---|---|---|---|---|',
  ...cards.map((c) => `| ${c._row.join(' | ')} |`),
].join('\n');
const note = lang === 'en'
  ? "<!-- Generated from each style's meta.json by engine/cli/catalog.mjs. Don't edit by hand. -->"
  : '<!-- 这张表由 engine/cli/catalog.mjs 从各风格的 meta.json 生成，别手改 -->';
const block = `${START}\n${note}\n${table}\n${END}`;

const counts = { style: cards.filter((c) => c.kind === 'style').length, interaction: cards.filter((c) => c.kind === 'interaction').length };
// 占位符拼出来写：源码里直接写双花括号，发布自检会把它当成「没填的占位符」
const token = (name) => ['{', '{', name, '}', '}'].join('');
// 拼贴下面的名单：「编号 名字」，按 listStyles 的顺序，按 kind 分开（跟宣传片拼贴的格子一一对应）
const roster = (kind) => cards.filter((c) => c.kind === kind).map((c) => (lang === 'en' ? `${c.code} ${c.nameEn || c.name}` : `${c.code} ${c.name}`)).join(lang === 'en' ? ', ' : '、');
const fill = (t) => t.replaceAll(token('风格数'), String(counts.style)).replaceAll(token('互动数'), String(counts.interaction))
  .replaceAll(token('字效名单'), roster('style')).replaceAll(token('互动名单'), roster('interaction'));

if (args.readme) {
  const p = resolve(args.readme);
  const text = args.template ? fill(await readFile(resolve(args.template), 'utf8')) : await readFile(p, 'utf8').catch(() => '');
  const a = text.indexOf(START); const b = text.indexOf(END);
  if (a < 0 || b < a) {
    console.error(`✗ ${relative(process.cwd(), p)} 里没找到这两行标记，先把它们放到要放表的位置：\n${START}\n${END}`);
    process.exit(2);
  }
  const next = text.slice(0, a) + block + text.slice(b + END.length);
  const current = args.template ? await readFile(p, 'utf8').catch(() => '') : text;
  if (args.check) {
    if (next !== current) { console.error(`✗ ${relative(process.cwd(), p)} 不是最新的，跑一遍 node engine/cli/catalog.mjs${args.template ? ' --template …' : ''} --readme 更新`); process.exit(1); }
    console.error('✓ README 是最新的');
  } else if (next !== current) { await writeFile(p, next); console.error(`写到 ${relative(process.cwd(), p)}（风格 ${counts.style} 个，互动元素 ${counts.interaction} 个）`); } else console.error('README 已经是最新的');
} else console.log(table);


if (args.json) {
  const out = cards.map(({ _row, _rowEn, ...c }) => c);
  await writeFile(resolve(args.json), JSON.stringify({ generatedBy: 'engine/cli/catalog.mjs', counts, styles: out }, null, 2) + '\n');
  console.error(`卡片数据写到 ${relative(process.cwd(), resolve(args.json))}（${out.length} 项：风格 ${counts.style} 个，互动元素 ${counts.interaction} 个）`);
}
if (problems.length) {
  console.error(`\n⚠ ${problems.length} 处要补：\n  ${problems.join('\n  ')}`);
  // --strict 和 --check 都把「要补的」当失败：CI 和提交前检查靠退出码，缺样片、缺字段不能悄悄过
  if (args.strict || args.check) process.exit(1);
}
