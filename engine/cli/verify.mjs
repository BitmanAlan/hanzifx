#!/usr/bin/env node
// npm run verify：底座的整套验收，全部真跑，结果写进 reports/P0-验收.md 和 reports/P0-验收.json。
// 不做任何「看起来对」的判断：每一条都落到具体的 hash、ffprobe 字段、像素值或浏览器返回的数据上。
import { mkdir, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { exportJob } from './lib/pipeline.mjs';
import { ENGINE_DIR } from './lib/fonts.mjs';
import { REPO_ROOT, startServer } from './lib/server.mjs';
import { framemd5, extractRgba, probe, run } from './lib/ffmpeg.mjs';
import { decodePng, alphaStats, pixel } from './lib/png.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { loadJieba } from './lib/jieba.mjs';
import { runPlayerE2E } from '../test/e2e/player.mjs';

const OUT = join(ENGINE_DIR, 'out', 'verify');
const REPORTS = join(ENGINE_DIR, 'reports');
const STYLE = 'styles/001-variety-outline';
const TEXT = '这也太好笑了吧';
const rel = (p) => relative(REPO_ROOT, p);
const items = [];
const add = (group, name, pass, evidence) => {
  items.push({ group, name, pass: !!pass, evidence });
  console.log(`${pass ? '✓' : '✗'} [${group}] ${name}\n    ${evidence}`);
};
const t0 = Date.now();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await mkdir(REPORTS, { recursive: true });
const job = (name, o) => exportJob({ style: STYLE, params: { text: TEXT }, quiet: false, outDir: join(OUT, name), ...o });

// ---------- 1. 两次导出逐帧一致；乱序并行也一致 ----------
const a1 = await job('A1-竖屏mp4', { size: '9:16', background: 'studio', formats: ['mp4'], workers: 2 });
const a2 = await job('A2-竖屏mp4-再导一次', { size: '9:16', background: 'studio', formats: ['mp4'], workers: 2 });
const a3 = await job('A3-竖屏mp4-4路乱序', { size: '9:16', background: 'studio', formats: ['mp4'], workers: 4, order: 'shuffle' });
const h1 = a1.manifest.frames.sha256; const h2 = a2.manifest.frames.sha256; const h3 = a3.manifest.frames.sha256;
const same12 = h1.length === h2.length && h1.every((h, i) => h === h2[i]);
add('确定性', '同样参数导出两次，截图逐帧 sha256 一致', same12, `${h1.length} 帧；逐帧摘要 ${a1.manifest.frames.digest.slice(0, 16)} vs ${a2.manifest.frames.digest.slice(0, 16)}`);
const mp4a = join(REPO_ROOT, a1.manifest.outputs[0].file); const mp4b = join(REPO_ROOT, a2.manifest.outputs[0].file);
const fm1 = await framemd5(mp4a); const fm2 = await framemd5(mp4b);
add('确定性', '两次导出的 MP4 解码后逐帧 md5 一致（ffmpeg framemd5）', fm1.length === fm2.length && fm1.every((h, i) => h === fm2[i]), `${fm1.length} 帧；第 1 帧 ${fm1[0]}，最后一帧 ${fm1.at(-1)}`);
add('确定性', '两次导出的 MP4 文件逐字节一致', a1.manifest.outputs[0].sha256 === a2.manifest.outputs[0].sha256, `sha256 ${a1.manifest.outputs[0].sha256.slice(0, 16)}… / ${a2.manifest.outputs[0].sha256.slice(0, 16)}…`);
const same13 = h1.length === h3.length && h1.every((h, i) => h === h3[i]);
add('纯函数', '4 路并行、打乱帧顺序渲染，跟顺序渲染逐帧一致', same13, `乱序摘要 ${a3.manifest.frames.digest.slice(0, 16)}，顺序摘要 ${a1.manifest.frames.digest.slice(0, 16)}`);

// ---------- 2. 透明底 ----------
const c1 = await job('C1-竖屏透明', { size: '9:16', background: 'transparent', formats: ['mov', 'webm', 'png'], workers: 4 });
const c2 = await job('C2-竖屏透明-再导一次', { size: '9:16', background: 'transparent', formats: ['mov'], workers: 4, order: 'shuffle' });
add('确定性', '透明底导出两次（第二次乱序），截图逐帧一致', c1.manifest.frames.digest === c2.manifest.frames.digest, `摘要 ${c1.manifest.frames.digest.slice(0, 16)} / ${c2.manifest.frames.digest.slice(0, 16)}`);
const holdMid = (() => { const s = c1.timeline.segments.find((x) => x.name === 'hold'); return Math.round(((s.start + s.end) / 2) * c1.timeline.fps); })();
for (const fmt of ['mov', 'webm']) {
  const o = c1.manifest.outputs.find((x) => x.format === fmt);
  const file = join(REPO_ROOT, o.file);
  const pr = o.probe;
  const pixOk = fmt === 'mov' ? /^yuva/.test(pr.pix_fmt) : (pr.tags?.alpha_mode === '1' || pr.tags?.ALPHA_MODE === '1');
  add('透明底', `${fmt} 的 ffprobe 显示带 alpha`, pixOk, `codec=${pr.codec_name} profile=${pr.profile ?? '-'} pix_fmt=${pr.pix_fmt} alpha_mode=${pr.tags?.alpha_mode ?? pr.tags?.ALPHA_MODE ?? '-'} ${pr.width}x${pr.height}`);
  const img = decodePng(await extractRgba(file, holdMid));
  const st = alphaStats(img);
  const corner = pixel(img, 0, 0)[3];
  add('透明底', `${fmt} 解码出第 ${holdMid + 1} 帧：角上全透明、字上不透明、边缘有半透明过渡`, st.hasAlpha && corner === 0 && st.max === 255 && st.partial > 0,
    `角上 alpha=${corner}，最大 ${st.max}，半透明像素 ${st.partial} 个，不透明区域 ${JSON.stringify(st.bbox)}`);
}
const firstPng = decodePng(await readFile(join(REPO_ROOT, c1.manifest.outputs.find((x) => x.format === 'png').file, '000001.png')));
add('透明底', 'PNG 序列第 1 帧（还没出字）也是 RGBA、整帧全透明', firstPng.channels === 4 && alphaStats(firstPng).max === 0, `通道数 ${firstPng.channels}，最大 alpha ${alphaStats(firstPng).max}（CDP 直接截图在这里会丢 alpha，所以透明底走 Playwright 截图）`);

// ---------- 3. 竖横两种都能导 ----------
const d1 = await job('D1-横屏mp4', { size: '16:9', background: 'studio', formats: ['mp4'], workers: 4 });
const d2 = await job('D2-横屏透明', { size: '16:9', background: 'transparent', formats: ['mov'], workers: 4 });
for (const [label, r, W, H] of [['竖屏 MP4', a1, 1080, 1920], ['竖屏透明 MOV', c1, 1080, 1920], ['横屏 MP4', d1, 1920, 1080], ['横屏透明 MOV', d2, 1920, 1080]]) {
  const o = r.manifest.outputs.find((x) => x.format !== 'png');
  const pr = await probe(join(REPO_ROOT, o.file));
  add('尺寸', `${label} 正好 ${W}×${H}`, pr.width === W && pr.height === H, `ffprobe：${pr.width}x${pr.height}，${pr.codec_name}/${pr.pix_fmt}，${pr.r_frame_rate}，${pr.nb_frames ?? '?'} 帧，${o.file}`);
}

// ---------- 4. 中文：不缺字、没回退系统字体、断行 ----------
for (const [label, r] of [['竖屏', a1], ['横屏', d1]]) {
  const fp = r.manifest.checks.fontProbe;
  const allCustom = fp.fonts.length > 0 && fp.fonts.every((f) => f.isCustomFont && f.familyName === 'ZCOOL KuaiLe');
  add('字体', `${label}：浏览器实际用的字体全是站酷快乐体（CSS.getPlatformFontsForNode）`, allCustom, `${fp.nodes} 个文字节点：${fp.fonts.map((f) => `${f.familyName}/${f.postScriptName} 自定义=${f.isCustomFont} 字形 ${f.glyphCount}`).join('；')}`);
}
add('字体', '用到的字全在主字体子集里', a1.manifest.checks.glyphs.missing.length === 0 && a1.manifest.checks.glyphs.fallback.length === 0, `用字「${a1.manifest.font.chars}」，子集 ${a1.manifest.font.used[0].subsetBytes} 字节，sha256 ${a1.manifest.font.used[0].subsetSha256.slice(0, 16)}…`);
{
  const r = await job('F0-备用字体', { size: '9:16', background: 'studio', formats: ['mp4'], params: { text: '王喆和李堃垚' } });
  const g = r.manifest.checks.glyphs;
  const fp = r.manifest.checks.fontProbe.fonts;
  add('字体', '主字体缺的字（喆堃垚）落到备用字体思源黑体上，并出警告', g.missing.length === 0 && [...g.fallback.map((x) => x.char)].sort().join('') === [...'喆堃垚'].sort().join('') && fp.some((f) => f.familyName === r.manifest.font.used.find((u) => u.id === 'notosc-black').nameTable.family) && fp.every((f) => f.isCustomFont),
    `备用：${g.fallback.map((x) => `${x.char}→${x.fontName}`).join('，')}；浏览器实际用到：${fp.map((f) => `${f.familyName}×${f.glyphCount}`).join('，')}（思源黑体固定字重后 name 表还写着 Thin，按子集文件的 name 表认）`);
}
try {
  await job('F-缺字', { size: '9:16', background: 'studio', formats: ['mp4'], params: { text: '笑死😂' } });
  // 😂 在主字体和备用字体里都没有
  add('字体', '字体里没有的字会直接报错（不静默换系统字体）', false, '居然导出成功了');
} catch (e) {
  add('字体', '字体里没有的字会直接报错（不静默换系统字体）', e.code === 'MISSING_GLYPHS', e.message);
}

// 中文专项检查（H2）：几句典型的
const cases = ['这也太好笑了吧', '真的吗？我不信！今天也要元气满满', '家人们谁懂啊', '一键三连走起！', '这也太|好笑了吧'];
for (const text of cases) {
  for (const size of ['9:16', '16:9']) {
    const r = await exportJob({ style: STYLE, params: { text }, size, background: 'transparent', formats: [], outDir: join(OUT, 'H2', `${size.replace(':', 'x')}_${text.replace(/[|？！]/g, '_')}`), workers: 4, quiet: true });
    const c = r.manifest.checks;
    const pass = c.lineBreaks.length === 0 && c.forcedBreaks.length === 0 && c.clip.framesTouchingEdge.length === 0 && c.glyphs.missing.length === 0;
    add('中文检查', `「${text}」${size}：不断词、行首无标点、描边不贴边、不缺字`, pass,
      `分词 ${c.segmentation.sources.join('+')}：${c.segmentation.words.join(' ‖ ')}；断行 ${r.manifest.layout.lines.map((l) => `「${l}」`).join('')}；离边最近 ${c.clip.minMarginPx}px` + (c.icuWarnings.length ? `；提示：${c.icuWarnings.map((x) => x.detail).join('；')}` : '') + (c.safeArea?.intrusions.length ? `；安全区提示：进了${c.safeArea.intrusions.map((z) => `${z.zone}${z.px}px`).join('、')}（经验值未实测）` : ''));
  }
}

// ---------- 5. 分词：Node 端和浏览器端切出来一样 ----------
{
  const sentences = ['这也太好笑了吧', '家人们谁懂啊', '今天也要元气满满', '笑死我了哈哈哈', '宝子们冲鸭', '人工智能改变世界', '这是一个误区', '一键三连走起！', '点赞关注不迷路', '真的吗？我不信！'];
  const cut = loadJieba();
  const nodeCuts = sentences.map((s) => cut(s).join('/'));
  const server = await startServer();
  const { browser } = await launchBrowser();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.url}/engine/render/index.html`);
  const browserCuts = await page.evaluate(async (ss) => {
    const { loadJiebaBrowser } = await import('/engine/src/jieba-browser.js');
    const c = await loadJiebaBrowser();
    return ss.map((s) => c(s).join('/'));
  }, sentences);
  await browser.close(); await server.close();
  const diff = sentences.filter((s, i) => nodeCuts[i] !== browserCuts[i]);
  add('分词', `jieba-wasm：Node 端和浏览器端 ${sentences.length} 句切词完全一致`, diff.length === 0, nodeCuts.join(' ｜ '));
}

// ---------- 6. 试玩页：真鼠标拖、真键盘改 ----------
{
  const r = await runPlayerE2E(join(REPORTS, 'player'));
  for (const x of r.results) add('试玩页', x.name, x.pass, x.detail || '—');
}

// ---------- 7. 单元测试 ----------
{
  const res = await new Promise((ok) => {
    const p = spawn(process.execPath, ['--test', ...['lib.test.mjs'].map((f) => join(ENGINE_DIR, 'test', f))], { cwd: ENGINE_DIR });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => ok({ code, out }));
  });
  const m = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(res.out);
  add('单元测试', 'node --test 全部通过', res.code === 0, m ? `通过 ${m[1]}，失败 ${m[2]}` : res.out.slice(-300));
}

// ---------- 样片 ----------
const SHOW = join(ENGINE_DIR, 'out', '样片');
await rm(SHOW, { recursive: true, force: true });
await mkdir(SHOW, { recursive: true });
const shows = [
  ['001_C1R1_弹出_竖屏', { text: '这也太好笑了吧' }, '9:16'],
  ['001_C2R1_掉落_竖屏', { text: '家人们谁懂啊', palette: 'C2', entrance: 'drop' }, '9:16'],
  ['001_C3R2_快闪_横屏', { text: '前方高能预警', palette: 'C3', rhythm: 'R2' }, '16:9'],
  ['001_C5R3_慢悠_竖屏', { text: '真的吗？我不信！\n今天也要元气满满', palette: 'C5', rhythm: 'R3' }, '9:16'],
  ['001_C4R1_黄油体_横屏', { text: '一键三连走起！', palette: 'C4', font: 'huangyou' }, '16:9'],
];
for (const [name, params, size] of shows) {
  const r = await exportJob({ style: STYLE, params, size, background: 'studio', formats: ['mp4'], outDir: join(OUT, 'show', name), workers: 4, quiet: true });
  await copyFile(join(REPO_ROOT, r.manifest.outputs[0].file), join(SHOW, `${name}.mp4`));
}
// 首屏动图（竖屏 C1）
await run('ffmpeg', ['-y', '-v', 'error', '-i', join(SHOW, '001_C1R1_弹出_竖屏.mp4'), '-vf', 'fps=20,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', join(SHOW, '001_首屏动图.gif')]);
// 风格自己的 demo/（日常默认＋招牌两套样片、动图、海报帧）由 cli/demo.mjs 生成，不在验收里重出

// ---------- 报告 ----------
const pass = items.filter((x) => x.pass).length;
const env = a1.manifest.env;
const json = { date: new Date().toISOString(), env, pass, total: items.length, totalSec: Math.round((Date.now() - t0) / 1000), items };
await writeFile(join(REPORTS, 'P0-验收.json'), JSON.stringify(json, null, 2));
const groups = [...new Set(items.map((x) => x.group))];
const md = [
  '# 底座验收报告（自动生成）',
  '',
  `生成命令：\`cd engine && npm run verify\`。全部真跑，共 ${items.length} 项，通过 ${pass} 项，用时 ${json.totalSec} 秒。`,
  '',
  `环境：${env.platform}，Node ${env.node}，浏览器 ${env.browser} ${env.browserVersion}，playwright-core ${env.playwrightCore}，${env.ffmpeg}。`,
  '',
  ...groups.flatMap((g) => [`## ${g}`, '', '| 结果 | 项目 | 证据 |', '|---|---|---|',
    ...items.filter((x) => x.group === g).map((x) => `| ${x.pass ? '✓' : '✗ 未通过'} | ${x.name} | ${String(x.evidence).replace(/\|/g, '｜').replace(/\n/g, ' ')} |`), '']),
  '## 产物位置',
  '',
  `- 样片：\`${rel(SHOW)}/\`（5 条 MP4＋首屏动图）；风格自己的 \`demo/\` 用 \`node cli/demo.mjs\` 生成`,
  `- 每次导出的清单和表演数据：\`${rel(OUT)}/*/manifest.json\`、\`timeline.json\``,
  `- 试玩页截图：\`${rel(join(REPORTS, 'player'))}/\``,
  '',
].join('\n');
await writeFile(join(REPORTS, 'P0-验收.md'), md);
console.log(`\n通过 ${pass}/${items.length}，报告：${join(REPORTS, 'P0-验收.md')}`);
process.exit(pass === items.length ? 0 : 1);
