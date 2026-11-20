#!/usr/bin/env node
// 列出库里所有风格：编号、名字、一句话、适合做什么、不适合（换哪个）、造型预设、要不要额外输入、适合发哪。
// 给 agent 挑风格用，不用一个个打开 meta.json。零依赖。
//   node skills/hanzifx/scripts/list-styles.mjs            # 给人和 agent 看的文字版
//   node skills/hanzifx/scripts/list-styles.mjs --json     # 机器读的 JSON
//   node skills/hanzifx/scripts/list-styles.mjs 004        # 只看一个风格的详情（含全部参数）
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STYLES = join(ROOT, 'styles');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const only = args.find((a) => !a.startsWith('--'));

const metas = readdirSync(STYLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{3}-/.test(d.name) && existsSync(join(STYLES, d.name, 'meta.json')))
  .map((d) => ({ dir: `styles/${d.name}`, ...JSON.parse(readFileSync(join(STYLES, d.name, 'meta.json'), 'utf8')) }))
  .sort((a, b) => a.code.localeCompare(b.code));

const pick = only ? metas.filter((m) => m.code === only.padStart(3, '0') || m.id === only || m.name === only || (m.aliases || []).includes(only)) : metas;
if (only && !pick.length) { console.error(`没有这个风格：${only}。可用：${metas.map((m) => `${m.code} ${m.name}`).join('、')}`); process.exit(2); }

const brief = (m) => ({
  code: m.code, name: m.name, nameEn: m.nameEn, kind: m.kind, dir: m.dir, summary: m.summary,
  fitFor: m.fitFor || [], notFor: m.notFor || [],
  looks: (m.looks || []).map((l) => ({ id: l.id, name: l.name, role: l.role || null, aliases: l.aliases || [] })),
  requires: m.requires || {}, platforms: m.platforms || [], invoke: m.invoke, status: m.status,
  exportDefaults: m.exportDefaults || null,
});

if (asJson) { console.log(JSON.stringify(pick.map(brief), null, 2)); process.exit(0); }

for (const m of pick) {
  const b = brief(m);
  const looks = b.looks.map((l) => `${l.id} ${l.name}${l.role === 'default' ? '（默认）' : l.role === 'showcase' ? '（招牌）' : ''}`).join('、');
  const needs = Object.entries(b.requires).filter(([, v]) => v).map(([k]) => ({ wordTimes: '逐字时间（可选，不给就按语速估）', beats: '音乐拍点', tracking: '画面跟踪' }[k] || k));
  console.log(`\n${b.code} ${b.name}（${b.nameEn}）${b.kind === 'interaction' ? '［互动元素］' : ''}  ${b.dir}`);
  console.log(`  ${b.summary}`);
  if (b.fitFor.length) console.log(`  适合：${b.fitFor.join('；')}`);
  if (b.notFor.length) console.log(`  不适合：${b.notFor.map((n) => `${n.case}（换 ${n.use}）`).join('；')}`);
  if (looks) console.log(`  造型：${looks}`);
  if (needs.length) console.log(`  额外输入：${needs.join('、')}`);
  if (b.platforms.length) console.log(`  适合发：${b.platforms.map((p) => `${p.name}${p.basis === 'inferred' ? '（推断）' : '（实测）'}`).join('、')}`);
  if (b.exportDefaults?.bg) console.log(`  默认背景：${b.exportDefaults.bg}`);
  console.log(`  怎么叫：${b.invoke}`);
  if (only) {
    console.log('  参数：');
    for (const p of m.params) {
      const opts = p.options ? `，可选 ${p.options.map((o) => (typeof o === 'string' ? o : o.value)).join('/')}` : '';
      const range = p.min != null ? `，${p.min}–${p.max}` : '';
      console.log(`    --set ${p.key}=…  ${p.label}（默认 ${JSON.stringify(p.default)}${opts}${range}）${p.hint ? '：' + p.hint : ''}`);
    }
    if (m.palettes) console.log(`  配色：${m.palettes.map((c) => `${c.id} ${c.name}`).join('、')}`);
    if (m.rhythms) console.log(`  节奏：${m.rhythms.map((r) => `${r.id} ${r.name}`).join('、')}`);
  }
}
