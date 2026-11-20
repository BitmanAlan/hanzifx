#!/usr/bin/env node
// 审美对比板：同一句话、同一套配色，几个造型变体并排，各出一张停留段静帧和一条固定时长的竖屏小片，
// 分别放在深色底和浅色杂乱底上，再拼成带标签的 2×2 对比图和对比片。给人圈选用。
// 用法：node cli/board.mjs [--text "这也太*好笑*了吧"] [--seconds 3] [--out out/审美对比]
import { mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { exportJob } from './lib/pipeline.mjs';
import { ENGINE_DIR, loadRegistry, ensureSource, subset } from './lib/fonts.mjs';
import { startServer, REPO_ROOT } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { run } from './lib/ffmpeg.mjs';
import { readFile } from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const STYLE = args.style || 'styles/001-variety-outline';
const TEXT = (args.text && args.text !== true ? args.text : '这也太*好笑*了吧');
const SECONDS = Number(args.seconds || 3);
const OUT = join(ENGINE_DIR, args.out || join('out', '审美对比'));
const meta = JSON.parse(await readFile(join(REPO_ROOT, STYLE, 'meta.json'), 'utf8'));
const VARIANTS = [
  { id: 'V4', name: '轻', note: '一层深色描边加柔和投影，没有厚度和高光（抖音网感 vlog 那一路，实测多数是这样）' },
  { id: 'V0', name: '现在的样子', note: '原型的四层描边加薄厚度，作对照' },
  { id: 'V1', name: '跳字', note: '每个字大小、角度、高低按种子起伏；*好笑* 放大 1.3 倍、换强调色' },
  { id: 'V2', name: '立体', note: '往右下挤出 12 层厚度、颜色逐层加深；字上半部一道高光，左上角一圈亮边' },
  { id: 'V3', name: '综艺夸张', note: 'V1 ＋ V2 ＋ 自己画的爆炸框陪衬，入场弹性更大；字号缩到 0.14 让框包住字' },
];
const BGS = [
  { id: 'studio', name: '深色底' },
  { id: 'busy-light', name: '浅色杂乱底' },
];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const jobs = join(OUT, '_jobs');
const results = {};
for (const v of VARIANTS) {
  for (const bg of BGS) {
    const base = { style: STYLE, params: { text: TEXT, look: v.id }, size: '9:16', background: bg.id, quiet: true };
    // 先空跑一遍拿时间轴，把停留时长调到整条正好 SECONDS 秒
    const dry = await exportJob({ ...base, formats: [], outDir: join(jobs, `${v.id}_${bg.id}_dry`), dryRun: true });
    const tl = dry.info.timeline;
    const hold0 = tl.segments.find((s) => s.name === 'hold');
    const hold = Math.max(0.3, (hold0.end - hold0.start) + (SECONDS - tl.duration));
    const r = await exportJob({
      ...base, params: { ...base.params, hold: Number(hold.toFixed(4)) }, formats: ['mp4'], workers: 4,
      outDir: join(jobs, `${v.id}_${bg.id}`),
      stillTimes: [(t) => { const h = t.segments.find((s) => s.name === 'hold'); return h.start + Math.min(0.35, (h.end - h.start) / 2); }],
    });
    const name = `${v.id}_${v.name}_${bg.name}`;
    // 透明底再跑一遍，逐帧查描边有没有碰到画面边缘（背景不影响这一项，所以每个变体只查一次）
    if (bg.id === 'studio') {
      const c = await exportJob({ ...base, params: { ...base.params, hold: Number(hold.toFixed(4)) }, background: 'transparent', formats: [], workers: 4, outDir: join(jobs, `${v.id}_clip`) });
      results[`${v.id}|clip`] = c.manifest.checks;
    }
    await copyFile(join(REPO_ROOT, r.manifest.outputs[0].file), join(OUT, `${name}.mp4`));
    await copyFile(join(REPO_ROOT, r.manifest.stills[0].file), join(OUT, `${name}_静帧.png`));
    results[`${v.id}|${bg.id}`] = { name, duration: r.timeline.duration, frames: r.timeline.frames, still: `${name}_静帧.png`, video: `${name}.mp4`, combo: r.manifest.combo, lines: r.manifest.layout.lines, clip: r.manifest.checks.clip };
    console.log(`✓ ${name}：${r.timeline.duration.toFixed(2)} 秒，${r.manifest.layout.lines.join('｜')}`);
  }
}

// 标签字体：思源黑体，按标签用到的字做子集
const reg = await loadRegistry();
const labelText = VARIANTS.map((v) => `${v.id}${v.name}${v.note}`).join('') + BGS.map((b) => b.name).join('') + `${TEXT}001综艺花字审美对比配色节奏种子调用秒深浅色杂乱底·｜，、：（）→＋${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')}`;
const noto = await subset(await readFile(await ensureSource('notosc-black', reg['notosc-black'])), [...new Set(labelText)].join(''), { variation: { wght: 500 } });
const notoBold = await subset(await readFile(await ensureSource('notosc-black', reg['notosc-black'])), [...new Set(labelText)].join(''), { variation: { wght: 800 } });
await writeFile(join(OUT, '_label.woff2'), noto.woff2);
await writeFile(join(OUT, '_label_bold.woff2'), notoBold.woff2);

const P = meta.palettes[0];
const footer = `文字「${TEXT}」｜配色 ${P.id} ${P.name}｜节奏 R1｜种子 7｜竖屏 1080×1920，每条 ${SECONDS} 秒｜画格是停留段静帧`;
const cellHtml = (v, imgs, w, h) => `
  <div class="cell" style="width:${imgs.length * w + (imgs.length - 1) * 8}px">
    <div class="head"><b>${v.id}</b><span class="nm">${v.name}</span></div>
    <div class="note">${v.note}</div>
    <div class="imgs">${imgs.map((src) => `<img src="${src}" style="width:${w}px;height:${h}px">`).join('')}</div>
  </div>`;
const page = (title, cells, cols, sub) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: L; src: url(_label.woff2) format("woff2"); }
  @font-face { font-family: LB; src: url(_label_bold.woff2) format("woff2"); }
  html,body{margin:0;background:#101014;color:#eee;font-family:L}
  .wrap{padding:28px 32px 22px;display:inline-block}
  h1{font-family:LB;font-size:34px;margin:0 0 4px} .sub{color:#aaa;font-size:18px;margin-bottom:18px}
  .grid{display:grid;grid-template-columns:repeat(${cols},auto);gap:22px 26px}
  .head{display:flex;align-items:baseline;gap:12px} .head b{font-family:LB;font-size:40px;color:#ffd84a} .nm{font-family:LB;font-size:30px}
  .note{font-size:17px;color:#bbb;margin:4px 0 10px;max-width:100%} .imgs{display:flex;gap:8px}
  img{display:block;border-radius:8px} .foot{color:#888;font-size:16px;margin-top:18px}
  .tag{font-size:15px;color:#999;margin-top:6px;display:flex;gap:8px}
  </style></head><body><div class="wrap"><h1>${title}</h1><div class="sub">${sub}</div><div class="grid">${cells}</div><div class="foot">${footer}</div></div></body></html>`;

const server = await startServer();
const { browser } = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const shoot = async (htmlName, html, png) => {
  await writeFile(join(OUT, htmlName), html);
  const pg = await ctx.newPage();
  await pg.goto(`${server.url}/${relative(REPO_ROOT, join(OUT, htmlName)).split(sep).join('/')}`);
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await pg.locator('.wrap').screenshot({ path: join(OUT, png) });
  await pg.close();
};
const infoCell = (w) => `<div class="cell info" style="width:${w}px"><div class="head"><span class="nm">从轻到重</span></div>
  <div class="note" style="font-size:19px;line-height:1.7;color:#ccc">V4 轻 → V0 现在的样子 → V1 跳字 → V2 立体 → V3 综艺夸张<br><br>
  都是参数和预设，可以混着用，比如 V4 加上跳字：<br><span style="color:#ffd84a">--set look=V4 --set jump=1 --set emph=accent</span><br><br>
  5 个变体统一用了实测默认值：竖屏垂直位置 0.38、短句停留 1.2 秒（抖音实测：花字中心中位在画面高度 33.5%，4 个字以内的短句停得更短）。小片为了对齐都调成 3 秒。</div></div>`;
for (const bg of BGS) {
  const cells = VARIANTS.map((v) => cellHtml(v, [results[`${v.id}|${bg.id}`].still], 480, 853)).join('') + infoCell(480);
  await shoot(`_board_${bg.id}.html`, page(`001 综艺花字 · 审美对比（${bg.name}）`, cells, 3, '同一句话、同一套配色，5 个造型变体，从轻到重'), `对比图_${bg.name}.png`);
}
const both = VARIANTS.map((v) => cellHtml(v, BGS.map((bg) => results[`${v.id}|${bg.id}`].still), 330, 587)).join('') + infoCell(668);
await shoot('_board_both.html', page('001 综艺花字 · 审美对比', both, 3, '每格左边深色底、右边浅色杂乱底（检查看不看得清）；从轻到重'), '对比图.png');

// 对比片：4 条小片拼成 2×2，标签单独画成透明图盖上去
const labelHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: LB; src: url(_label_bold.woff2) format("woff2"); }
  html,body{margin:0;background:transparent} .g{display:grid;grid-template-columns:480px 480px 480px;grid-template-rows:853px 853px;width:1440px;height:1706px}
  .info{font-family:LB;color:#ddd;font-size:30px;padding:40px;line-height:1.6}
  .c{position:relative} .t{position:absolute;left:18px;top:16px;font-family:LB;font-size:40px;color:#fff;background:rgba(0,0,0,.55);padding:4px 14px;border-radius:10px}
  .t b{color:#ffd84a;margin-right:8px}
  </style></head><body><div class="g">${VARIANTS.map((v) => `<div class="c"><div class="t"><b>${v.id}</b>${v.name}</div></div>`).join('')}<div class="c info">001 综艺花字<br>审美对比<br>从轻到重</div></div></body></html>`;
await writeFile(join(OUT, '_labels.html'), labelHtml);
{
  const pg = await (await browser.newContext({ viewport: { width: 1440, height: 1706 }, deviceScaleFactor: 1 })).newPage();
  await pg.goto(`${server.url}/${relative(REPO_ROOT, join(OUT, '_labels.html')).split(sep).join('/')}`);
  await pg.evaluate(() => document.fonts.ready);
  await pg.screenshot({ path: join(OUT, '_labels.png'), omitBackground: true });
}
await browser.close();
await server.close();
for (const bg of BGS) {
  const ins = VARIANTS.flatMap((v) => ['-i', join(OUT, results[`${v.id}|${bg.id}`].video)]);
  await run('ffmpeg', ['-y', '-v', 'error', ...ins, '-f', 'lavfi', '-i', `color=c=0x101014:s=480x854:r=30:d=${SECONDS}`, '-i', join(OUT, '_labels.png'), '-filter_complex',
    '[0]scale=480:854[a];[1]scale=480:854[b];[2]scale=480:854[c];[3]scale=480:854[d];[4]scale=480:854[e];[5]setsar=1[f];[a][b][c][d][e][f]xstack=inputs=6:layout=0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0[g];[g][6]overlay=0:0,format=yuv420p',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', join(OUT, `对比片_${bg.name}.mp4`)]);
}
await rm(jobs, { recursive: true, force: true });
for (const f of ['_labels.html', '_board_studio.html', '_board_busy-light.html', '_board_both.html']) await rm(join(OUT, f), { force: true });

const lines = [
  '# 001 综艺花字 · 审美对比', '',
  `生成命令：cd engine && node cli/board.mjs（文字「${TEXT}」，每条 ${SECONDS} 秒）`, '',
  '## 看哪几个文件', '',
  '- 对比图.png：3×2 一张，5 个变体从轻到重，每格左边深色底、右边浅色杂乱底，最适合圈选',
  '- 对比图_深色底.png、对比图_浅色杂乱底.png：单一背景，图更大',
  '- 对比片_深色底.mp4、对比片_浅色杂乱底.mp4：5 条小片拼在一起同时播，看动起来的感觉',
  '- 每个变体单独的小片和静帧：V*_*.mp4、V*_*_静帧.png', '',
  '## 5 个变体（都是参数和预设，不是一次性效果），从轻到重', '',
  '| 变体 | 怎么调出来的 | 断行 | 描边离画面边最近 |', '|---|---|---|---|',
  ...VARIANTS.map((v) => {
    const look = meta.looks.find((l) => l.id === v.id);
    const r = results[`${v.id}|studio`];
    const c = results[`${v.id}|clip`];
    return `| ${v.id} ${v.name} | ${Object.entries(look.params).map(([k, val]) => `${k}=${val}`).join('，')} | ${r.lines.join('｜')} | ${c.clip.framesTouchingEdge.length ? `✗ ${c.clip.framesTouchingEdge.length} 帧贴边` : `${c.clip.minMarginPx} 像素（${c.clip.checkedFrames} 帧逐帧查）`}；断行检查 ${c.lineBreaks.length ? '✗' : '✓'} |`;
  }),
  '',
  '单独调：npm run export -- --text "这也太*好笑*了吧" --set look=V3 --set depth=0.6（预设之上还能改单项）。',
  '关键词用 *…* 标；作者断行用 |；两个可以一起用，比如「这也太|*好笑*了吧」。', '',
  '## 背景', '',
  '- 深色底：程序生成的光斑背景（原型就有）。',
  '- 浅色杂乱底：程序生成的色块和细条，模拟明亮、东西很多的实拍画面，故意混进黄、橙、粉这些跟花字撞色的颜色。没有用任何照片素材。',
];
await writeFile(join(OUT, '说明.md'), lines.join('\n') + '\n');
console.log(`\n对比板：${OUT}`);
