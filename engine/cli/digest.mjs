#!/usr/bin/env node
// 逐帧摘要：把一个风格按几种造型、尺寸、背景各导一遍 PNG 序列，记下每一帧的 sha256。
// 用途：改造风格（比如换上共用零件）之前先存一份，改完再比一次，证明「没打算改的画法」逐帧一个像素都没变。
//   改之前：node cli/digest.mjs --style styles/013-price-tag --save out/digest/013-before.json
//   改之后：node cli/digest.mjs --style styles/013-price-tag --compare out/digest/013-before.json
// 跟 determinism（同一份代码乱序、顺序渲染比一致）不一样：这里比的是改代码前后。两边的命令参数要一样。
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { ENGINE_DIR } from './lib/fonts.mjs';
import { REPO_ROOT } from './lib/server.mjs';

const HELP = `用法：npm run digest -- --style <目录> (--save <文件> | --compare <文件>) [选项]
  --looks V1,V3        比哪几个造型，默认 meta.looks 里全部
  --combos "9:16 studio,9:16 transparent,16:9 transparent"   尺寸和背景的组合，默认就是这三种
  --set key=value      所有组合都加的参数（可写多次），比如 --set material=flat
  --save <文件>        存这次的摘要（JSON）
  --compare <文件>     跟之前存的比；有不一样的帧就列出来，退出码 1
  --keep               保留导出的 PNG（默认比完就删）
导出用 --workers 2 --order seq，一个组合一个组合串行跑（全队渲染排队时算一路）。`;

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h || !args.style || (!args.save && !args.compare)) { console.log(HELP); process.exit(args.style ? 2 : 0); }
const style = String(args.style);
const meta = JSON.parse(await readFile(resolve(REPO_ROOT, style, 'meta.json'), 'utf8'));
const looks = args.looks && args.looks !== true ? String(args.looks).split(',').map((s) => s.trim()).filter(Boolean) : (meta.looks || []).map((l) => l.id);
const combos = (args.combos && args.combos !== true ? String(args.combos) : '9:16 studio,9:16 transparent,16:9 transparent')
  .split(',').map((s) => s.trim().split(/\s+/)).map(([size, bg]) => ({ size, bg }));
const sets = [].concat(args.set ?? []).filter((s) => s !== true).map(String);
const tmpRoot = join(ENGINE_DIR, 'out', '_digest', style.replace(/[^\w-]+/g, '_'));

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
function run(cmd, argv) {
  return new Promise((ok) => {
    const p = spawn(cmd, argv, { cwd: ENGINE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => ok({ code, log }));
  });
}

const result = { style, sets, combos: {} };
for (const look of looks) {
  for (const { size, bg } of combos) {
    const key = `${look} ${size} ${bg}`;
    const out = join(tmpRoot, key.replace(/[^\w-]+/g, '_'));
    await rm(out, { recursive: true, force: true });
    const argv = ['cli/export.mjs', '--style', style, '--set', `look=${look}`, ...sets.flatMap((s) => ['--set', s]), '--size', size, '--bg', bg, '--format', 'png', '--out', out, '--workers', '2', '--order', 'seq'];
    const r = await run(process.execPath, argv);
    if (r.code !== 0) {
      console.error(`✗ ${key}：导出失败\n${r.log.split('\n').slice(-8).join('\n')}`);
      process.exit(2);
    }
    const pngDir = join(out, 'png');
    const files = (await readdir(pngDir)).filter((f) => f.endsWith('.png')).sort();
    const frames = [];
    for (const f of files) frames.push(sha(await readFile(join(pngDir, f))).slice(0, 16));
    const agg = sha(frames.join('\n')).slice(0, 16);
    result.combos[key] = { frames, agg };
    console.log(`${key}：${frames.length} 帧，摘要 ${agg}`);
    if (!args.keep) await rm(out, { recursive: true, force: true });
  }
}

if (args.save && args.save !== true) {
  const file = resolve(ENGINE_DIR, String(args.save));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(result, null, 1) + '\n');
  console.log(`存好了：${file}`);
}
if (args.compare && args.compare !== true) {
  const before = JSON.parse(await readFile(resolve(ENGINE_DIR, String(args.compare)), 'utf8'));
  let bad = 0;
  for (const [key, cur] of Object.entries(result.combos)) {
    const old = before.combos?.[key];
    if (!old) { console.log(`？ ${key}：之前的摘要里没有这一组`); bad++; continue; }
    if (old.agg === cur.agg) { console.log(`✓ ${key}：${cur.frames.length} 帧逐帧一样`); continue; }
    bad++;
    const diff = [];
    const n = Math.max(old.frames.length, cur.frames.length);
    for (let i = 0; i < n; i++) if (old.frames[i] !== cur.frames[i]) diff.push(i);
    console.log(`✗ ${key}：帧数 ${old.frames.length} → ${cur.frames.length}，${diff.length} 帧不一样，头几帧是第 ${diff.slice(0, 8).join('、')} 帧（从 0 数）`);
  }
  for (const key of Object.keys(before.combos || {})) if (!result.combos[key]) console.log(`？ ${key}：这次没跑这一组`);
  if (bad) { console.log(`有 ${bad} 组不一样。用 --keep 留下 PNG，再跟改之前的导出逐帧对着看`); process.exit(1); }
  console.log('全部逐帧一样');
}
