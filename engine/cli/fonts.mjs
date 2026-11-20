#!/usr/bin/env node
// npm run fonts：下载并校验源字体，生成试玩页用的常用字子集（fonts/dist/<id>.common.woff2）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FONTS_DIR, loadRegistry, ensureSource, subset, commonCharset, sha256, unicodesOf, fontsNeedingCommon } from './lib/fonts.mjs';

const reg = await loadRegistry();
const chars = commonCharset();
await mkdir(join(FONTS_DIR, 'dist'), { recursive: true });
const summary = {};
const needCommon = await fontsNeedingCommon(reg);
for (const [id, entry] of Object.entries(reg)) {
  const p = await ensureSource(id, entry);
  const src = await readFile(p);
  const all = [...unicodesOf(src)].sort((a, b) => a - b).map((c) => String.fromCodePoint(c)).join('');
  await writeFile(join(FONTS_DIR, 'dist', `${id}.all.chars.txt`), all);
  if (!needCommon.has(id)) {
    // 只当备用字体用的不做常用字子集：只给主字体缺的那几个字用，导出时按需做子集，试玩台走本地服务按需做
    summary[id] = { name: entry.name, family: entry.family, role: entry.role || 'fallback', chars: [...all].length };
    console.log(`✓ ${entry.name}：源文件 sha256 校验通过；${entry.role === 'latin' ? '拉丁字体' : '备用字体'}，覆盖 ${[...all].length} 个码位，按需做子集`);
    continue;
  }
  const r = await subset(src, chars, { variation: entry.variation });
  const out = join(FONTS_DIR, 'dist', `${id}.common.woff2`);
  await writeFile(out, r.woff2);
  await writeFile(join(FONTS_DIR, 'dist', `${id}.common.chars.txt`), r.kept);
  summary[id] = { name: entry.name, family: entry.family, file: `dist/${id}.common.woff2`, bytes: r.woff2.length, sha256: sha256(r.woff2), chars: [...r.kept].length, notInFont: r.missing.join('') };
  console.log(`✓ ${entry.name}：源文件 sha256 校验通过；常用字子集 ${[...r.kept].length} 字，${(r.woff2.length / 1024).toFixed(0)} KB` + (r.missing.length ? `；字体里没有：${r.missing.join('')}` : ''));
}
await writeFile(join(FONTS_DIR, 'dist', 'common.json'), JSON.stringify(summary, null, 2));
