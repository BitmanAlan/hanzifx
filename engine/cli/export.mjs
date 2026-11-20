#!/usr/bin/env node
// 导出：node cli/export.mjs --style styles/001-variety-outline --text "这也太好笑了吧" --size 9:16 --format mp4
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs, styleParams, timingArgs } from './lib/args.mjs';
import { exportJob } from './lib/pipeline.mjs';
import { ENGINE_DIR } from './lib/fonts.mjs';
import { copyFile } from 'node:fs/promises';
import { resolveTime } from './lib/when.mjs';
import { REPO_ROOT } from './lib/server.mjs';

const HELP = `用法：npm run export -- [选项]
  --style <目录>      风格目录，默认 styles/001-variety-outline
  --text <文字>       要做的字，\\n 换行
  --palette C1..C5    配色      --rhythm R1..R3  节奏      --seed <整数> 种子
  --set key=value     改任意参数（可写多次，参数名见风格的 meta.json）
  --size 9:16|16:9|1:1|1080x1920   画面尺寸，默认 9:16
  --fps 30            帧率
  --bg studio|transparent|#RRGGBB  背景；不给就用风格 meta.exportDefaults.bg，再没有就是 studio
  --format mp4 | mov,webm,png      输出格式；不给时透明底是 mov,webm，其他是 mp4
  --out <目录>        输出目录，默认 engine/out/<风格>_<尺寸>_<背景>
  --workers <n>       并行几路截图，默认 2
  --order seq|shuffle 截图顺序（shuffle 用来证明是纯函数）
  --beats 0.5,1.0,…   外部拍点（秒），给要卡音乐节拍的风格用；也可以 --beats-file 拍点.json
  --words-file 时间.json   字级时间：[{"text":"普通人","start":0.12,"end":0.55}, …]（秒，升序）
  --words-offset 毫秒      字级时间整体偏移，默认 0（转写工具常常整体偏 50–150 毫秒）
  --poster            截一张海报 PNG（按风格 meta.posterTime；没写就是入场刚结束那一刻），存成 poster.png
  --still <时刻>      截任意时刻的 PNG，可以逗号分开写几个。时刻的写法：秒数（2.3）、after-intro、
                      段名（hold＝停留段开头）、段名.end / 段名.mid、段名+秒数（hold+0.3）
                      只给 --poster / --still、不给 --format 时只截图，不渲染整片（快）；方形、3:4 照常用 --size
  --keep-frames       保留逐帧 PNG
  --chrome <路径>     指定浏览器可执行文件`;

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) { console.log(HELP); process.exit(0); }
const style = args.style || 'styles/001-variety-outline';
const bg = args.bg && args.bg !== true ? args.bg : undefined; // 不给就用风格 meta.exportDefaults.bg，再没有就是 studio
const size = args.size || '9:16';
const formats = args.format && args.format !== true ? String(args.format).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const params = styleParams(args, ['text', 'palette', 'rhythm', 'seed', 'entrance', 'font']);
const tag = `${style.split('/').filter(Boolean).pop()}_${size.replace(':', 'x')}_${(bg || 'default').replace('#', '')}`;
const outDir = resolve(args.out || join(ENGINE_DIR, 'out', tag));
let timing;
try { timing = await timingArgs(args); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
const { beats, words, wordsOffsetMs } = timing;
// 截图：--poster 按 meta.posterTime，--still 按给的时刻
const stillSpecs = [];
if (args.poster) {
  const meta = JSON.parse(await readFile(join(REPO_ROOT, style, 'meta.json'), 'utf8'));
  stillSpecs.push({ spec: meta.posterTime ?? 'after-intro', poster: true });
}
if (args.still && args.still !== true) for (const x of String(args.still).split(',').map((v) => v.trim()).filter(Boolean)) stillSpecs.push({ spec: x });
const stillsOnly = stillSpecs.length > 0 && !formats;
try {
  const r = await exportJob({ beats, words, wordsOffsetMs, style, params, size, fps: args.fps, background: bg, formats: stillsOnly ? [] : formats, outDir, workers: args.workers || 2, order: args.order, keepFrames: !!args['keep-frames'], chrome: args.chrome,
    stillTimes: stillSpecs.map((x) => (tl) => resolveTime(x.spec, tl)), stillsOnly });
  for (const [i, x] of stillSpecs.entries()) {
    const st = r.stills[i];
    const src = join(REPO_ROOT, st.file);
    if (x.poster) { await copyFile(src, join(outDir, 'poster.png')); console.log(`  海报：${join(outDir, 'poster.png')}（${x.spec} → ${st.t.toFixed(2)} 秒）`); } else console.log(`  截图：${src}（${x.spec} → ${st.t.toFixed(2)} 秒）`);
  }
  if (stillsOnly) process.exit(0);
  const c = r.manifest.checks;
  if (c.lineBreaks.length) console.log('  ⚠ 断行问题：' + c.lineBreaks.map((x) => x.detail).join('；'));
  if (c.clip && c.clip.framesTouchingEdge.length) console.log(`  ⚠ 有 ${c.clip.framesTouchingEdge.length} 帧描边碰到画面边缘，可能被切掉`);
  console.log(`  清单：${join(outDir, 'manifest.json')}\n  表演数据：${join(outDir, 'timeline.json')}`);
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(e.code === 'MISSING_GLYPHS' ? 3 : 1);
}
