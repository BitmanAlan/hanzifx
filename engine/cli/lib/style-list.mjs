// 列出要公开的风格：按目录名排（目录名以三位编号开头，所以就是按编号排），跳过 draft- 开头的草稿目录和没有 meta.json 的目录；
// kind 没写的当成 style（字效）。
// README 的索引表、拼贴下面的名单（engine/cli/catalog.mjs）和宣传片的拼贴、作品墙（promo/style-names.mjs）都用这一份规则，
// 个数、顺序、分组两边一样，加了风格不会一边多一边少。
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 分组的先后：先字效，后互动元素 */
export const KINDS = ['style', 'interaction'];

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/**
 * listStyles(stylesDir) → [{ dir, code, kind, meta }]，按目录名排好
 * - dir：目录名，比如 002-big-poster
 * - code：meta.code，没写就取目录名前三位
 * - kind：meta.kind，没写当成 'style'
 */
export async function listStyles(stylesDir) {
  const out = [];
  for (const dir of (await readdir(stylesDir)).sort()) {
    if (dir.startsWith('draft-')) continue; // 草稿还没分配编号、没合并
    const metaPath = join(stylesDir, dir, 'meta.json');
    if (!(await exists(metaPath))) continue;
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    out.push({ dir, code: meta.code || dir.slice(0, 3), kind: meta.kind || 'style', meta });
  }
  return out;
}

/** 按 kind 分组：{ style: [...], interaction: [...] }，组内顺序跟 listStyles 一样；不认识的 kind 另放一组 */
export function groupByKind(list) {
  const groups = Object.fromEntries(KINDS.map((k) => [k, []]));
  for (const s of list) (groups[s.kind] ||= []).push(s);
  return groups;
}
