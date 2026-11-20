#!/usr/bin/env node
// 逐帧一致自检：同一组参数，用「4 路并行＋打乱帧顺序」和「1 路顺序」各渲染 rounds 轮，列出逐帧 sha256 对不上的帧。
// 风格交付前跑一遍；对不上时把命令和帧号发给底座（能复现的例子最有用）。
// 用法：node cli/determinism.mjs --style styles/002-big-poster --text "…" [--set look=V3] [--size 9:16,16:9] [--bg studio] [--rounds 2]
//       拍点、字级时间跟 export 一样：[--beats … | --beats-file …] [--words-file 时间.json] [--words-offset 毫秒]
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { decodePng } from './lib/png.mjs';
import { parseArgs, styleParams, timingArgs } from './lib/args.mjs';
import { exportJob } from './lib/pipeline.mjs';

const args = parseArgs(process.argv.slice(2));
const style = args.style || 'styles/001-variety-outline';
const params = styleParams(args, ['text', 'palette', 'rhythm', 'seed', 'entrance', 'font']);
// 拍点、字级时间：跟 export 同一套解析，逐字时间那条路也要验逐帧一致
let timing;
try { timing = await timingArgs(args); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
const sizes = String(args.size || '9:16').split(',');
const bgs = String(args.bg || 'studio,transparent').split(',');
const rounds = Number(args.rounds || 2);
let bad = 0;
for (const size of sizes) for (const background of bgs) {
  const digests = [];
  let ref = null; let refDir = null;
  for (let r = 0; r < rounds; r++) {
    for (const [workers, order] of [[4, 'shuffle'], [1, 'seq']]) {
      const dir = await mkdtemp(join(tmpdir(), 'hanzifx-det-'));
      let keep = false;
      try {
        const res = await exportJob({ ...timing, style, params, size, background, formats: [], outDir: dir, workers, order, shuffleSeed: 20261119 + r, quiet: true, keepFrames: true });
        const h = res.manifest.frames.sha256;
        if (!ref) { ref = h; refDir = dir; keep = true; }
        const diff = h.map((x, i) => (x !== ref[i] ? i + 1 : null)).filter(Boolean);
        digests.push(`${workers} 路${order === 'shuffle' ? '乱序' : '顺序'}#${r + 1}：${res.manifest.frames.digest.slice(0, 12)}${diff.length ? `（跟第一轮比，${diff.length} 帧不一样：第 ${diff.slice(0, 10).join('、')} 帧）` : ''}`);
        // 对不上的帧：算出差异像素的范围，报给底座时最有用（前 3 帧）
        for (const f of diff.slice(0, 3)) digests.push(`    第 ${f} 帧：${await pixelDiff(join(refDir, 'frames', frameName(f)), join(dir, 'frames', frameName(f)))}`);
        if (diff.length) bad++;
      } finally { if (!keep) await rm(dir, { recursive: true, force: true }); }
    }
  }
  if (refDir) await rm(refDir, { recursive: true, force: true });
  console.log(`${size} ${background}\n  ${digests.join('\n  ')}`);
}

function frameName(f) { return `${String(f).padStart(6, '0')}.png`; }
/** 两帧逐像素比：几个像素不同、最大差几个色阶、范围 [x0,y0,x1,y1] */
async function pixelDiff(a, b) {
  const A = decodePng(await readFile(a)); const B = decodePng(await readFile(b));
  const ch = A.data.length / (A.width * A.height);
  let n = 0; let maxd = 0; let box = null;
  for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
    const k = (y * A.width + x) * ch; let d = 0;
    for (let c = 0; c < ch; c++) d = Math.max(d, Math.abs(A.data[k + c] - B.data[k + c]));
    if (d) { n++; maxd = Math.max(maxd, d); box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]; }
  }
  return `${n} 个像素不同，最大差 ${maxd} 个色阶，范围 [${box ? box.join(', ') : ''}]（x0, y0, x1, y1）`;
}
console.log(bad ? `\n✗ 有 ${bad} 次渲染跟第一轮对不上。常见原因见 docs/写一个新风格.md 的硬规矩第 1、6、7、8 条` : '\n✓ 全部逐帧一致');
process.exit(bad ? 1 : 0);
