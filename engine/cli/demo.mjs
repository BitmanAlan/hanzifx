#!/usr/bin/env node
// 给一个风格出样片（按 meta.json 的 demo 配置：日常默认 default、招牌 showcase）：
// 竖屏 MP4、海报帧（入场完成后的第一帧）、预览动图（宽 720，放 README 第一屏和画廊封面）。
// 用法：node cli/demo.mjs [--style styles/001-variety-outline] [--width 720] [--fps 15] [--max-mb 3] [--only default,showcase,extra1]
// 动图的宽度和帧率：命令行显式给的 > 样片条目里的 gifWidth、gifFps > 默认 720 宽、15 帧。
// 条目里写 gifMaxMB（或命令行 --max-mb）时，出来超过这个大小就按 0.85 倍降宽度和帧率重出，最多降 4 次（不低于 360 宽、10 帧），
// 这样重跑 demo.mjs 不会把调好的小动图盖回大的。
import { mkdir, copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, timingArgs } from './lib/args.mjs';
import { exportJob } from './lib/pipeline.mjs';
import { ENGINE_DIR } from './lib/fonts.mjs';
import { REPO_ROOT } from './lib/server.mjs';
import { run } from './lib/ffmpeg.mjs';
import { resolveTime } from './lib/when.mjs';

const args = parseArgs(process.argv.slice(2));
const STYLE = args.style || 'styles/001-variety-outline';
const gifSettings = (d) => ({
  width: Number(args.width || d.gifWidth || 720),
  fps: Number(args.fps || d.gifFps || 15),
  maxBytes: Number(args['max-mb'] || d.gifMaxMB || 0) * 1048576,
});
/** 两遍调色板、只更新变化的区域；宽 w（横屏也按宽算） */
const encodeGif = (src, dst, w, fps) => run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf',
  `fps=${fps},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
  '-loop', '0', dst]);
const meta = JSON.parse(await readFile(join(REPO_ROOT, STYLE, 'meta.json'), 'utf8'));
const DEMO = join(REPO_ROOT, STYLE, 'demo');
await mkdir(DEMO, { recursive: true });
const out = [];
// demo 条目里凡是 meta.params 认识的键（text、look、palette……）都当参数传。
// 画面尺寸用 canvas（比如 "1920x1080"，不写就是竖屏 1080x1920）：不能叫 size，会跟风格自己的参数撞（006 的按钮直径就叫 size）。
// 海报帧：条目的 posterTime > meta.posterTime > after-intro，写法见 lib/when.mjs（秒数、段名、hold+0.3……）。
// meta.extraDemos 是一个数组，跟 demo 里的条目一样处理（没写 gif 就不出动图）。
// 拍点、字级时间：条目里写 wordsFile、wordsOffset、beatsFile、beats（路径从风格目录算）；条目没写就用命令行的 --words-file 等（跟 export 一样）。
const paramsOf = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => meta.params.some((p) => p.key === k)));
const entries = [...Object.entries(meta.demo || {}), ...(meta.extraDemos || []).map((d, i) => [`extra${i + 1}`, d])];
const only = args.only ? String(args.only).split(',') : null;
for (const [role, d] of entries) {
  if (only && !only.includes(role)) continue;
  const size = d.canvas || '1080x1920';
  // 拍点、字级时间：条目里写了 wordsFile / wordsOffset / beatsFile / beats 就用条目的（路径从风格目录算），没写用命令行的
  const own = ['wordsFile', 'wordsOffset', 'beatsFile', 'beats'].some((k) => d[k] !== undefined);
  const timing = own
    ? await timingArgs({ 'words-file': d.wordsFile, 'words-offset': d.wordsOffset, 'beats-file': d.beatsFile, beats: Array.isArray(d.beats) ? d.beats.join(',') : d.beats }, { base: join(REPO_ROOT, STYLE) })
    : await timingArgs(args);
  const r = await exportJob({
    ...timing, style: STYLE, params: paramsOf(d), size, background: 'studio', formats: ['mp4'], workers: 4,
    outDir: join(ENGINE_DIR, 'out', 'demo', `${meta.id}_${role}`), quiet: true,
  });
  const mp4 = join(REPO_ROOT, STYLE, d.video);
  await copyFile(join(REPO_ROOT, r.manifest.outputs[0].file), mp4);
  const posterSpec = d.posterTime ?? meta.posterTime ?? 'after-intro';
  const posterT = resolveTime(posterSpec, r.timeline);
  const posterFrame = Math.min(Math.ceil(posterT * r.timeline.fps - 1e-6), r.manifest.frames.sha256.length - 1);
  if (d.poster) await run('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-vf', `select=eq(n\\,${posterFrame})`, '-frames:v', '1', '-q:v', '2', join(REPO_ROOT, STYLE, d.poster)]);
  let gifNote = '';
  if (d.gif) {
    // 动图：另导一遍背景不动的（studio-still），宽度、帧率、大小上限见文件开头
    const g = await exportJob({
      style: STYLE, params: paramsOf(d), size, background: 'studio-still', formats: ['mp4'], workers: 4,
      outDir: join(ENGINE_DIR, 'out', 'demo', `${meta.id}_${role}_still`), quiet: true,
    });
    const gs = gifSettings(d);
    const src = join(REPO_ROOT, g.manifest.outputs[0].file), dst = join(REPO_ROOT, STYLE, d.gif);
    let { width: w, fps } = gs;
    await encodeGif(src, dst, w, fps);
    let sz = (await stat(dst)).size;
    let tries = 0;
    while (gs.maxBytes && sz > gs.maxBytes && tries < 4 && (w > 360 || fps > 10)) {
      w = Math.max(360, Math.round((w * 0.85) / 2) * 2); fps = Math.max(10, Math.round(fps * 0.85));
      await encodeGif(src, dst, w, fps);
      sz = (await stat(dst)).size; tries++;
    }
    const over = gs.maxBytes && sz > gs.maxBytes ? `，还是超过上限 ${(gs.maxBytes / 1048576).toFixed(1)} MB` : '';
    gifNote = `，${d.gif}（${(sz / 1048576).toFixed(1)} MB，${w} 宽 ${fps} 帧${tries ? `，超上限降了 ${tries} 次` : ''}${over}）`;
  }
  out.push(`${role}（${d.look || '默认'}，${size}）：${d.video}${gifNote}，${d.poster || '无海报'}（${posterSpec} → ${posterT.toFixed(2)} 秒）；${r.timeline.duration.toFixed(2)} 秒，${r.manifest.layout.lines.join('｜')}，字号 ${r.manifest.layout.fontSize.toFixed(0)} px`);
}
console.log(out.join('\n'));
