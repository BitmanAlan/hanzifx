#!/usr/bin/env node
// npm run doctor：开工前自检。缺什么、怎么补，一条条说清楚。
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { versionOf, encoders } from './lib/ffmpeg.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { FONTS_DIR, loadRegistry, fontsNeedingCommon } from './lib/fonts.mjs';

const rows = [];
const add = (ok, name, detail, fix) => rows.push({ ok, name, detail, fix });
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const [major] = process.versions.node.split('.').map(Number);
add(major >= 20, 'Node.js', `v${process.versions.node}`, '装 Node 20 或更新的版本（playwright-core 1.64 要求 20 以上）：https://nodejs.org');
add(typeof Intl.Segmenter === 'function', '中文分词（Intl.Segmenter）', typeof Intl.Segmenter === 'function' ? '可用' : '不可用', '换带完整 ICU 的 Node（官方安装包默认就带）');

const ff = await versionOf('ffmpeg');
const fp = await versionOf('ffprobe');
add(!!ff, 'ffmpeg', ff || '没找到', 'macOS：brew install ffmpeg；Windows：winget install ffmpeg；Linux：apt install ffmpeg');
add(!!fp, 'ffprobe', fp || '没找到', '跟 ffmpeg 一起装');
if (ff) {
  const enc = await encoders();
  add(enc.libx264, 'H.264 编码器 libx264（导出 MP4）', enc.libx264 ? '有' : '没有', '换一个带 libx264 的 ffmpeg（brew 版自带）');
  add(enc.prores_ks, 'ProRes 编码器 prores_ks（导出透明 .mov）', enc.prores_ks ? '有' : '没有', '换官方完整版 ffmpeg');
  add(enc.libvpx_vp9, 'VP9 编码器 libvpx-vp9（导出透明 .webm）', enc.libvpx_vp9 ? '有' : '没有', '换带 libvpx 的 ffmpeg');
}

try {
  const b = await launchBrowser();
  add(true, '浏览器', `${b.kind} ${b.version}` + (b.kind === 'chrome' ? '（用本机 Chrome 能导出；想要逐帧结果最稳，再装锁定版本的 headless-shell）' : ''), '');
  await b.browser.close();
} catch (e) {
  add(false, '浏览器', '没找到能用的', '装 Google Chrome，或者运行：npx playwright-core install --only-shell chromium');
}

const reg = await loadRegistry();
const needCommon = await fontsNeedingCommon(reg);
for (const [id, e] of Object.entries(reg)) {
  const src = await exists(join(FONTS_DIR, e.file));
  // 备用字体（role: fallback）和拉丁字体（latin）按设计不做试玩用的常用字子集：要用时现做子集，所以只查源文件
  if (!needCommon.has(id)) { const kind = e.role === 'latin' ? '拉丁字体' : '备用'; add(src, `字体 ${e.name}（${kind}）`, src ? `源文件在（${kind}不做试玩字库，按需现做子集）` : '源文件没下载', 'npm run fonts'); continue; }
  const common = await exists(join(FONTS_DIR, 'dist', `${id}.common.woff2`));
  add(src && common, `字体 ${e.name}`, src ? (common ? '源文件和试玩字库都在' : '源文件在，试玩字库没生成') : '源文件没下载', 'npm run fonts');
}

for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.name}：${r.detail}${r.ok || !r.fix ? '' : `\n    → ${r.fix}`}`);
const bad = rows.filter((r) => !r.ok);
console.log(bad.length ? `\n还差 ${bad.length} 项，按上面的箭头补上再试。` : '\n都齐了，可以开始：npm run dev（试玩）或 npm run export（导出）。');
process.exit(bad.length ? 1 : 0);
