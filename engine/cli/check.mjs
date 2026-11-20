#!/usr/bin/env node
// npm run check -- --text "…"：中文专项检查，四样——词中间断行、标点出现在行首、描边被画面边缘切掉、缺字。
// 拍点、字级时间跟 export 一样传：--beats / --beats-file、--words-file 时间.json、--words-offset 毫秒（004、018 按真实逐字时间检查）。
// 做法：用透明底逐帧渲染一遍（不编码），断行用独立重新分词核对，缺字查字体 cmap 再用浏览器查实际用的字体，裁切逐帧看 alpha 贴不贴边。
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, styleParams, timingArgs } from './lib/args.mjs';
import { exportJob } from './lib/pipeline.mjs';

const args = parseArgs(process.argv.slice(2));
const style = args.style || 'styles/001-variety-outline';
const sizes = String(args.size || '9:16,16:9').split(',');
const params = styleParams(args, ['text', 'palette', 'rhythm', 'seed', 'entrance', 'font']);
// 拍点、字级时间：跟 export 同一套解析（004、018 按真实逐字时间检查要用）
let timing;
try { timing = await timingArgs(args); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
let failed = 0;
for (const size of sizes) {
  const dir = await mkdtemp(join(tmpdir(), 'hanzifx-check-'));
  try {
    const r = await exportJob({ ...timing, style, params, size, background: 'transparent', formats: [], outDir: dir, workers: 4, quiet: true, checkFlash: true });
    const c = r.manifest.checks;
    const lines = r.manifest.layout.lines;
    const out = [];
    const mid = c.lineBreaks.filter((x) => x.type === 'mid-word');
    const punct = c.lineBreaks.filter((x) => x.type !== 'mid-word');
    out.push([!mid.length && !c.forcedBreaks.length, '词中间断行', mid.length ? mid.map((x) => x.detail).join('；') : c.forcedBreaks.length ? `词太长被迫拆开：${c.forcedBreaks.join('、')}` : `没有（${lines.map((l) => `「${l}」`).join(' ')}）`]);
    out.push([!punct.length, '标点出现在行首/开引号在行尾', punct.length ? punct.map((x) => x.detail).join('；') : '没有']);
    const edge = c.clip.framesTouchingEdge;
    out.push([!edge.length, '描边被画面边缘切掉', edge.length ? `${edge.length} 帧贴边：第 ${edge.slice(0, 8).join('、')} 帧…` : `没有（${c.clip.checkedFrames} 帧逐帧查过，离边最近 ${c.clip.minMarginPx}px）`]);
    if (c.icuWarnings.length) out.push([true, '提示（不卡发布）', c.icuWarnings.map((x) => x.detail).join('；')]);
    out.unshift([true, '分词（请看一眼切得对不对）', `${c.segmentation.sources.join(' + ')}：${c.segmentation.words.join(' ‖ ')}\n      → 切错了就在原文里用 | 标出能断开的位置，比如「这也太|好笑了吧」，再重新导出；*关键词* 可以标出要突出的字`]);
    // 显示登记名（带实际字重），不显示字体文件内部的名字：可变字体固定字重以后内部名字不变（思源黑体会显示成 Thin），容易误会
    const byName = new Map();
    for (const u of r.manifest.font.used) for (const nm of [u.internalFamily, u.nameTable?.family, u.nameTable?.full, u.nameTable?.typoFamily]) if (nm) byName.set(`${nm}|${u.role}`, u.name);
    const nameOf = (f) => byName.get(`${f.familyName}|primary`) || byName.get(`${f.familyName}|fallback`) || f.familyName;
    const fonts = c.fontProbe.fonts.map((f) => `${nameOf(f)}${f.isCustomFont ? '' : '（系统字体）'}×${f.glyphCount}`).join('，');
    const fb = c.glyphs.fallback;
    out.push([true, '缺字', fb.length ? `不缺，但「${fb.map((x) => x.char).join('')}」主字体没有，用了备用字体 ${[...new Set(fb.map((x) => x.fontName))].join('、')}（警告，风格会变味）；浏览器实际用到：${fonts}` : `不缺；浏览器实际用到的字体：${fonts}`]);
    const fl = r.manifest.checks.flash;
    if (fl) out.push([fl.pass || fl.mode === 'strong', '闪烁（WCAG 2.3.1）', fl.pass ? `没超标（普通闪烁最多每秒 ${fl.worst.general.maxPerSecond} 次，红色 ${fl.worst.red.maxPerSecond} 次；透明底叠黑底、白底各查一遍）` : `超标：${fl.worst.where} 普通每秒 ${fl.worst.general.maxPerSecond} 次、红色 ${fl.worst.red.maxPerSecond} 次${fl.mode === 'strong' ? '（强闪烁模式，只警告）' : ''}`]);
    if (r.manifest.checks.safeArea) {
      const sa = r.manifest.checks.safeArea;
      out.push([true, '安全区（提示）', sa.intrusions.length ? `进了 ${sa.intrusions.map((z) => `${z.zone}${z.px}px`).join('、')}${sa.measured ? '' : '（区域是经验值，未实测，只出提示）'}` : '没进平台遮挡区']);
    }
    console.log(`\n${size}  ${r.manifest.combo}`);
    for (const [ok, name, detail] of out) { console.log(`  ${ok ? '✓' : '✗'} ${name}：${detail}`); if (!ok) failed++; }
  } catch (e) {
    console.log(`\n${size}\n  ✗ ${e.code === 'MISSING_GLYPHS' ? '缺字' : e.code === 'FLASH_RISK' ? '闪烁超标' : '出错'}：${e.message}`);
    failed++;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
