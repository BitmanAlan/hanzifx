#!/usr/bin/env node
// 在线画廊的静态站：把画廊页、底座的浏览器端代码、各风格的 style.js／meta.json／海报、试玩字体拼成一个目录，
// 原样放到 GitHub Pages（或任何静态托管）就能用，不要服务器。
//
//   node cli/site.mjs                               生成到 engine/out/site/
//   node cli/site.mjs --out <目录>
//   node cli/site.mjs --serve [--port 8765] [--base /hanzifx/]
//       生成完在本机起一个静态服务，按子路径提供（模拟 Pages 的「/仓库名/」地址，检查页面里没有写死的绝对路径）
//
// 站里的路径跟仓库一样（styles/…、engine/src/…），风格代码里 import '../../engine/src/…' 不用改。
// 字体：每款两份。
//   演示子集（<id>.demo.woff2，字体名加 -demo）：只含各张卡开场要画的字（每个样片条目的参数按 fontPlan 算，跟导出同一套），
//     首屏只下载这一份，几十 KB；
//   常用字子集（<id>.common.woff2，GB2312 汉字＋ASCII＋空格＋常用标点，0.8–3 MB）：有人改字、改出演示子集没有的字时才下载。
//   生僻字（GB2312 以外）在画廊里会落到系统字体，导出不受影响。
// 海报：卡片挂上真代码之前先显示的那一帧。本机有 ffmpeg 就缩到 480 宽（卡片 2 倍屏也够），没有就原样拷。
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, relative, extname, normalize, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { parseArgs } from './lib/args.mjs';
import { ENGINE_DIR, FONTS_DIR, loadRegistry, ensureSource, subset, commonCharset, sha256 } from './lib/fonts.mjs';
import { REPO_ROOT } from './lib/server.mjs';
import { resolveParams, fontPlan } from '../src/lib/params.js';
import { plainText } from '../src/lib/segment.js';
import { charset } from '../src/lib/text.js';

const args = parseArgs(process.argv.slice(2));
const OUT = resolve(args.out || join(ENGINE_DIR, 'out', 'site'));
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const t0 = Date.now();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 1) 画廊页本身放在站点根目录；门面的宣传片循环动图（docs/media/hero.webp，页面在首屏的卡挂好以后才下载它）
await cp(join(ENGINE_DIR, 'gallery'), OUT, { recursive: true });
const hero = join(REPO_ROOT, 'docs', 'media', 'hero.webp');
if (await exists(hero)) { await mkdir(join(OUT, 'docs', 'media'), { recursive: true }); await cp(hero, join(OUT, 'docs', 'media', 'hero.webp')); }
else console.error('⚠ 没有 docs/media/hero.webp，门面的宣传片位置会空着');
// 2) 底座的浏览器端代码（风格 import 的都在 engine/src 里）；海报帧的时刻写法（when.mjs）画廊也要用
await cp(join(ENGINE_DIR, 'src'), join(OUT, 'engine', 'src'), { recursive: true });
await mkdir(join(OUT, 'engine', 'cli', 'lib'), { recursive: true });
await cp(join(ENGINE_DIR, 'cli', 'lib', 'when.mjs'), join(OUT, 'engine', 'cli', 'lib', 'when.mjs'));

// 3) 风格：只收有 style.js 的目录；拷 meta.json、目录第一层的 .js、demo 里登记的海报
const stylesDir = join(REPO_ROOT, 'styles');
const fontIds = new Set();
const styleDirs = [];
const demoChars = new Map(); // 字体 → 各张卡开场要画的字
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
let posterBytes = 0;
for (const dir of (await readdir(stylesDir)).sort()) {
  const src = join(stylesDir, dir);
  if (dir.startsWith('draft-') || !(await exists(join(src, 'style.js'))) || !(await exists(join(src, 'meta.json')))) continue; // draft- 还没合并
  const meta = JSON.parse(await readFile(join(src, 'meta.json'), 'utf8'));
  const dst = join(OUT, 'styles', dir);
  await mkdir(dst, { recursive: true });
  for (const f of await readdir(src)) if (f === 'meta.json' || f.endsWith('.js')) await cp(join(src, f), join(dst, f));
  const keys = new Set((meta.params || []).map((p) => p.key));
  for (const d of [...Object.values(meta.demo || {}), ...(meta.extraDemos || [])]) {
    if (d.poster && (await exists(join(src, d.poster)))) {
      await mkdir(join(dst, 'demo'), { recursive: true });
      const to = join(dst, d.poster);
      const shrunk = hasFfmpeg && spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', join(src, d.poster), '-vf', 'scale=480:-2', '-q:v', '5', to]).status === 0;
      if (!shrunk) await cp(join(src, d.poster), to);
      posterBytes += (await stat(to)).size;
    }
    // 这个样片条目开场要画的字，按字体记下来（跟宿主 mount 用的 fontPlan 同一套；备用链上的字体也记，缺字时浏览器往后找）
    const params = Object.fromEntries(Object.entries(d).filter(([k]) => keys.has(k)));
    const P = resolveParams(meta, params);
    for (const g of fontPlan(meta, P, plainText)) {
      const ids = [g.fontId, ...((meta.fontFallback || {})[g.fontId] || [])];
      for (const id of ids) demoChars.set(id, (demoChars.get(id) || '') + g.chars);
    }
  }
  // 这个风格可能用到的字体：主字体候选（meta.fonts、字体参数的选项）、备用链、paramFonts
  for (const f of meta.fonts || []) fontIds.add(f);
  for (const [k, list] of Object.entries(meta.fontFallback || {})) { fontIds.add(k); for (const f of list) fontIds.add(f); }
  for (const v of Object.values(meta.paramFonts || {})) if (typeof v === 'string' && !v.startsWith('@')) fontIds.add(v);
  const fontParam = (meta.params || []).find((p) => p.key === 'font');
  for (const o of fontParam?.options || []) fontIds.add(typeof o === 'string' ? o : o.value);
  styleDirs.push(dir);
}

// 4) 卡片数据：跟 README 索引表同一个来源（catalog.mjs）
const cat = spawnSync(process.execPath, [join(ENGINE_DIR, 'cli', 'catalog.mjs'), '--json', join(OUT, 'catalog.json')], { cwd: ENGINE_DIR, encoding: 'utf8' });
if (cat.status !== 0) { console.error(cat.stderr); process.exit(1); }
const catalog = JSON.parse(await readFile(join(OUT, 'catalog.json'), 'utf8'));
catalog.styles = catalog.styles.filter((s) => styleDirs.includes(s.dir.replace(/^styles\//, '')));
catalog.counts = { style: catalog.styles.filter((s) => s.kind === 'style').length, interaction: catalog.styles.filter((s) => s.kind === 'interaction').length };
await writeFile(join(OUT, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

// 5) 字体：每款一个常用字子集。npm run fonts 生成过的直接拷，没生成的（备用字体、拉丁字体）现做
const reg = await loadRegistry();
const fontsOut = join(OUT, 'engine', 'fonts');
await mkdir(fontsOut, { recursive: true });
const chars = commonCharset();
const fontMap = {};
let fontBytes = 0;
let demoBytes = 0;
for (const id of [...fontIds].sort()) {
  const e = reg[id];
  if (!e) { console.error(`⚠ 风格里用到的字体 ${id} 没登记，跳过`); continue; }
  const built = join(FONTS_DIR, 'dist', `${id}.common.woff2`);
  let buf;
  if (await exists(built)) buf = await readFile(built);
  else buf = (await subset(await readFile(await ensureSource(id, e)), chars, { variation: e.variation })).woff2;
  const name = `${id}.common.woff2`;
  await writeFile(join(fontsOut, name), buf);
  fontBytes += buf.length;
  fontMap[id] = { family: e.family, url: `engine/fonts/${name}`, name: e.name, bytes: buf.length, sha256: sha256(buf).slice(0, 16) };
  // 演示子集：开场要画的字（去掉空白，空白不需要字形）
  const dc = charset(demoChars.get(id) || '').replace(/\s/g, '');
  if (dc) {
    const demo = (await subset(await readFile(await ensureSource(id, e)), dc, { variation: e.variation })).woff2;
    const dn = `${id}.demo.woff2`;
    await writeFile(join(fontsOut, dn), demo);
    demoBytes += demo.length;
    fontMap[id].demo = { family: `${e.family}-demo`, url: `engine/fonts/${dn}`, bytes: demo.length, chars: dc };
  }
}
await writeFile(join(fontsOut, 'fonts.json'), JSON.stringify(fontMap, null, 2) + '\n');
// 画廊自己的界面：编号用等宽字体（JetBrains Mono Bold，只要 ASCII）；中文大标题、小标题、卡名用思源黑体 Black，
// 只做界面上会出现的字（画廊页的文案、各风格的名字和用途标签），不拿 0.9 MB 的常用字子集
if (reg['notosc-black']) {
  const uiText = [await readFile(join(ENGINE_DIR, 'gallery', 'gallery.js'), 'utf8'), await readFile(join(ENGINE_DIR, 'gallery', 'index.html'), 'utf8'),
    ...catalog.styles.flatMap((c) => [c.name, ...(c.tags || []), ...(c.aliases || [])])].join('');
  const uiChars = charset(uiText.replace(/[\x00-\x7f]/g, '')).replace(/\s/g, '') + Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
  const uiCn = await subset(await readFile(await ensureSource('notosc-black', reg['notosc-black'])), uiChars, { variation: reg['notosc-black'].variation });
  await writeFile(join(fontsOut, 'ui-cn.woff2'), uiCn.woff2);
  fontBytes += uiCn.woff2.length;
}
if (reg['jbmono-bold']) {
  const ascii = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('') + '·';
  const ui = await subset(await readFile(await ensureSource('jbmono-bold', reg['jbmono-bold'])), ascii, { variation: reg['jbmono-bold'].variation });
  await writeFile(join(fontsOut, 'ui-mono.woff2'), ui.woff2);
  fontBytes += ui.woff2.length;
}

console.error(`✓ 画廊静态站写到 ${relative(process.cwd(), OUT) || '.'}：${catalog.styles.length} 个（字效 ${catalog.counts.style}，互动 ${catalog.counts.interaction}），字体 ${Object.keys(fontMap).length} 款（常用字子集共 ${(fontBytes / 1048576).toFixed(1)} MB、演示子集共 ${(demoBytes / 1024).toFixed(0)} KB），海报共 ${(posterBytes / 1024).toFixed(0)} KB${hasFfmpeg ? '（缩到 480 宽）' : '（没有 ffmpeg，原样拷）'}，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

// ---------- 本机预览：按子路径提供，模拟 Pages ----------
if (args.serve) {
  const base = ('/' + String(args.base || '/hanzifx/').replace(/^\/+|\/+$/g, '') + '/').replace(/\/+/g, '/');
  const port = Number(args.port || 8765);
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === base.slice(0, -1)) { res.writeHead(302, { location: base }); return res.end(); }
    if (!p.startsWith(base)) { res.writeHead(404); return res.end(`not found（只认 ${base} 下面的路径：页面里不能有写死的绝对路径）`); }
    p = p.slice(base.length - 1);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(OUT, p));
    if (!file.startsWith(OUT + sep) || !(await exists(file))) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => console.error(`本机预览：http://127.0.0.1:${port}${base}（Ctrl+C 停）`));
}
