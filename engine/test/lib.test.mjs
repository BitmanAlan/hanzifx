// 单元测试：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashStr, mulberry32, hash01, noise1, stepNoise } from '../src/lib/rand.js';
import { spring, springFirstCross, clamp } from '../src/lib/ease.js';
import { graphemes, charset, breakText, checkLineBreaks, segmentWords, icuBoundaries, wordBoundaries } from '../src/lib/text.js';
import { fontPlan, resolveParams, comboCode } from '../src/lib/params.js';
import { bounceIn, popOut, shake, beatAt, combine } from '../src/motions/index.js';
import { normalizeBeats } from '../src/host.js';
import { decodePng, alphaStats } from '../cli/lib/png.mjs';
import { commonCharset, SPACE_GLYPHS, withSpaceGlyphs, loadableChars, fontUrls } from '../cli/lib/fonts.mjs';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const META = JSON.parse(await readFile(new URL('../../styles/001-variety-outline/meta.json', import.meta.url), 'utf8'));

test('随机数：同样的种子和键永远同一个数，换种子就变', () => {
  assert.equal(hash01(7, 'rot', 3), hash01(7, 'rot', 3));
  assert.notEqual(hash01(7, 'rot', 3), hash01(8, 'rot', 3));
  const a = mulberry32(hashStr('x')); const b = mulberry32(hashStr('x'));
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  for (let i = 0; i < 1000; i++) { const v = hash01(1, i); assert.ok(v >= 0 && v < 1); }
  assert.equal(noise1(3, 2.5), noise1(3, 2.5));
  assert.equal(stepNoise(1, 0.01, 12, 'a'), stepNoise(1, 0.08, 12, 'a'), '同一个 1/12 秒里保持不变');
});

test('弹簧：从 0 出发、会冲过 1、最后停在 1；第一次过 1 的时刻算对', () => {
  const o = { freq: 2.3, damping: 0.42 };
  assert.equal(spring(0, o), 0);
  const tc = springFirstCross(o);
  assert.ok(Math.abs(spring(tc, o) - 1) < 1e-9);
  let max = 0; for (let t = 0; t < 2; t += 0.001) max = Math.max(max, spring(t, o));
  assert.ok(max > 1.1 && max < 1.4, `过冲 ${max}`);
  assert.ok(Math.abs(spring(5, o) - 1) < 1e-4);
});

test('动作是纯函数：乱序调用结果一样', () => {
  const ts = [0.9, 0.1, 0.5, 0.1, 0.9];
  const r = ts.map((t) => JSON.stringify(bounceIn(t, { fs: 100 })));
  assert.equal(r[0], r[4]); assert.equal(r[1], r[3]);
  assert.equal(JSON.stringify(shake(0.2, { start: 0.1, seed: 2 })), JSON.stringify(shake(0.2, { start: 0.1, seed: 2 })));
  assert.deepEqual(popOut(0), { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, visible: true });
  assert.equal(popOut(1).sx, 0);
  assert.deepEqual(combine({ dx: 1, sx: 2 }, { dx: 2, sx: 3 }), { dx: 3, dy: 0, rot: 0, sx: 6, sy: 1, visible: true });
});

test('拍点：整理和查当前第几拍', () => {
  assert.deepEqual(normalizeBeats('1.5, 0.5,0.5,-1,x'), [0.5, 1.5]);
  const b = [0.5, 1, 1.5];
  assert.deepEqual(beatAt(0.2, b), { index: -1, since: 0.2, next: 0.5 });
  assert.equal(beatAt(1.2, b).index, 1);
  assert.ok(Math.abs(beatAt(1.2, b).since - 0.2) < 1e-9);
  assert.equal(beatAt(9, b).next, null);
});

test('拆字和字符集：emoji 不拆坏，去空白去重', () => {
  assert.deepEqual(graphemes('笑😂ab'), ['笑', '😂', 'a', 'b']);
  assert.equal(charset('好 好\n笑'), '好笑');
});

test('空格字形：字体子集和试玩字库都带空格，不让浏览器去借系统字体的空格', () => {
  // 「第 2 集」这种字中间夹空格：charset() 不收空白（缺字检查用），以前子集里就没有空格字形，
  // 浏览器拿系统字体（苹方）的空格补上，导出时字体实测报「回退成了字体链以外的字体」，空格宽度也跟着变。
  assert.equal(SPACE_GLYPHS, '  　');
  const cov = new Set([0x20, 0x3000, 0x7B2C, 0x96C6]); // 有半角空格、全角空格，没有不换行空格
  assert.equal(withSpaceGlyphs('第集', cov), '第集 　');
  assert.equal(withSpaceGlyphs('第 集', cov), '第 集　', '已经有的不重复加');
  assert.equal(withSpaceGlyphs('', new Set([0x96C6])), '', '字体里没有空格字形就不加');
  const common = commonCharset();
  for (const ch of SPACE_GLYPHS) assert.ok(common.includes(ch), `试玩字库要有 U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
});

test('分词：补充词表修正 ICU 的错切', () => {
  const icu = icuBoundaries('这也太好笑了吧');
  assert.ok(icu.has(4), 'ICU 自己会在「好|笑」之间切（实测），这条断言失败说明 ICU 变了，词表可以重新评估');
  assert.ok(!wordBoundaries('这也太好笑了吧').has(4));
  assert.deepEqual(segmentWords('今天也要元气满满').map((s) => s.text), ['今天', '也要', '元气满满']);
});

test('断行：按词断、行宽拉平、标点不出现在行首', () => {
  const w = (a) => [...a].length; // 每个字宽 1
  const r = breakText('这也太好笑了吧', w, 4.5);
  assert.deepEqual(r.lines.map((l) => l.text), ['这也太', '好笑了吧']);
  const p = breakText('真的吗？太好了！', w, 4.5);
  for (const l of p.lines.slice(1)) assert.ok(!/^[，。！？]/.test(l.text), l.text);
  assert.deepEqual(checkLineBreaks(p.lines, '真的吗？太好了！'), []);
  const keep = breakText('点赞ABC123关注', w, 6);
  assert.ok(keep.lines.some((l) => l.text.includes('ABC123')), '拉丁和数字连写不拆');
  const tooLong = breakText('点赞ABC123关注', w, 4);
  assert.deepEqual(tooLong.forced, ['ABC123'], '一个词比一行还宽时才拆，并且报出来');
});

test('检查器能抓到坏断行（独立重新分词，不信排版函数）', () => {
  const bad = [{ text: '这也太好', paragraph: 0 }, { text: '笑了吧', paragraph: 0 }];
  assert.equal(checkLineBreaks(bad, '这也太好笑了吧')[0].type, 'mid-word');
  const punct = [{ text: '真的吗', paragraph: 0 }, { text: '？太好了', paragraph: 0 }];
  assert.ok(checkLineBreaks(punct, '真的吗？太好了').some((x) => x.type === 'line-start-punct'));
  const open = [{ text: '他说“', paragraph: 0 }, { text: '好”', paragraph: 0 }];
  assert.ok(checkLineBreaks(open, '他说“好”').some((x) => x.type === 'line-end-punct'));
});

test('参数：默认值、预设展开、单独改色、非法值报错', () => {
  const p = resolveParams(META, { palette: 'C2', fill: '#123456' });
  assert.equal(p._palette.colors.fill, '#123456');
  assert.equal(p._palette.colors.outer, META.palettes[1].colors.outer);
  assert.equal(p._rhythm.id, 'R1');
  assert.equal(comboCode(META, p), '001·V1·C2·R1', '默认造型是 V1');
  assert.equal(resolveParams(META, { look: '综艺' }).look, 'V3', '造型别名');
  assert.equal(resolveParams(META, { look: 'showcase' }).burst, 'boom');
  const v3 = resolveParams(META, { look: 'V3', depth: 0.5 });
  assert.equal(v3.burst, 'boom', '造型预设展开');
  assert.equal(v3.depth, 0.5, '用户自己给的参数盖过造型预设');
  assert.equal(resolveParams(META, { size: 99 }).size, 0.24, '超范围会夹住');
  assert.throws(() => resolveParams(META, { palette: 'C9' }));
  assert.throws(() => resolveParams(META, { nope: 1 }));
});

test('PNG 解码和 alpha 统计', () => {
  // 手工造一张 3x2 RGBA：左上角透明，其余不透明
  const w = 3; const h = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const r = [0];
    for (let x = 0; x < w; x++) r.push(255, 0, 0, x === 0 && y === 0 ? 0 : 255);
    rows.push(Buffer.from(r));
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  const img = decodePng(png);
  const st = alphaStats(img, { edge: 1 });
  assert.equal(st.min, 0); assert.equal(st.max, 255);
  assert.equal(st.edgeHits, 5);
});

import { bestBreak, fitText, icuBreakWarnings } from '../src/lib/text.js';
import { buildSegmentation, plainText, segmenterFrom } from '../src/lib/segment.js';
import { loadJieba } from '../cli/lib/jieba.mjs';

test('最佳断法：优先断在句末标点后面', () => {
  const w = (a) => [...a].length;
  const r = bestBreak('真的吗？我不信！', w, 5);
  assert.deepEqual(r.lines.map((l) => l.text), ['真的吗？', '我不信！']);
  assert.equal(bestBreak('一二三四五六七八九十', w, 3), null, '三行放不下返回 null');
});

test('自动字号：放不下就缩，缩小有代价', () => {
  const r = fitText('今天也要元气满满', { fs0: 10, measureAt: (px) => (a) => [...a].length * px, maxWidthAt: () => 60, maxLines: 3 });
  assert.ok(r.lines.length >= 1 && r.lines.every((l) => [...l.text].length * r.fs <= 60 + 1e-9));
});

test('分词三层：作者手标优先，其次 jieba+词表，最后兜底', () => {
  const a = buildSegmentation('这也太|好笑了吧');
  assert.deepEqual(a.sources, ['author']);
  assert.deepEqual(a.paragraphs[0].words.map((x) => x.text), ['这也太', '好笑了吧']);
  assert.equal(plainText('这也太|好笑了吧'), '这也太好笑了吧');
  const cut = loadJieba();
  const j = buildSegmentation('家人们谁懂啊', { cut });
  assert.deepEqual(j.sources, ['jieba+lexicon']);
  assert.deepEqual(j.paragraphs[0].words.map((x) => x.text), ['家人们', '谁懂啊']);
  const fb = buildSegmentation('家人们谁懂啊');
  assert.deepEqual(fb.sources, ['icu+lexicon']);
  const seg = segmenterFrom(j);
  assert.deepEqual(seg('家人们谁懂啊').map((x) => x.text), ['家人们', '谁懂啊']);
  const mixed = buildSegmentation('这也太|好笑了吧\n家人们谁懂啊', { cut });
  assert.deepEqual(mixed.sources, ['author', 'jieba+lexicon']);
});

test('ICU 独立核对：不一致只出提示', () => {
  const lines = [{ text: '这也太', paragraph: 0 }, { text: '好笑了吧', paragraph: 0 }];
  const w = icuBreakWarnings(lines, '这也太好笑了吧');
  assert.equal(w.length, 1);
  assert.equal(w[0].type, 'icu-disagree');
});

import { COLOR_ROLES, mix } from '../src/lib/color.js';

import { readdirSync, readFileSync, existsSync } from 'node:fs';
const STYLES_DIR = new URL('../../styles/', import.meta.url);
const ALL_META = readdirSync(STYLES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.') && existsSync(new URL(`${d.name}/meta.json`, STYLES_DIR)))
  .map((d) => ({ dir: d.name, meta: JSON.parse(readFileSync(new URL(`${d.name}/meta.json`, STYLES_DIR), 'utf8')) }));

test('styles/ 下每个风格的 meta.json 都符合风格模板（必填字段、8 个颜色角色、文件夹名＝编号-slug、预设里的参数都存在）', () => {
  assert.ok(ALL_META.length >= 1);
  for (const { dir, meta } of ALL_META) checkMeta(dir, meta);
});

test('draft- 开头的文件夹（还没分配编号的新风格）：只跳过编号那几条，别的照查', () => {
  const draft = structuredClone(ALL_META[0].meta);
  draft.id = 'my-effect';
  delete draft.code; // 编号合并时才给
  assert.doesNotThrow(() => checkMeta('draft-my-effect', draft, { files: false }));
  assert.throws(() => checkMeta('draft-other-name', draft, { files: false }), /draft-<英文 slug>/);
  const noName = structuredClone(draft);
  delete noName.name;
  assert.throws(() => checkMeta('draft-my-effect', noName, { files: false }), /缺字段 name/);
  // 已经分配了编号的照旧要求「编号-slug」
  assert.throws(() => checkMeta('my-effect', { ...draft, code: '099' }, { files: false }), /编号-slug/);
});

/** 风格目录的 meta.json 检查。draft-<slug> 文件夹是还没分配编号的新风格（见 CONTRIBUTING）：不要求 code，文件夹名要是 draft-<id> */
function checkMeta(dir, META, { files = true } = {}) {
  const draft = dir.startsWith('draft-');
  const required = ['schema', 'code', 'id', 'name', 'nameEn', 'aliases', 'kind', 'tags', 'status', 'version', 'summary', 'invoke', 'invokeTemplate',
    'fitFor', 'sizes', 'fps', 'durationHint', 'timelineSegments', 'posterTime', 'safeArea', 'requires', 'fonts', 'typography', 'params', 'palettes',
    'exports', 'checks', 'demo', 'credits', 'license'].filter((k) => !(draft && k === 'code'));
  assert.equal(META.tier ?? 'open', 'open');
  for (const k of required) assert.ok(k in META, `${dir}：缺字段 ${k}`);
  if (draft) assert.equal(dir, `draft-${META.id}`, `${dir}：还没分配编号的新风格，文件夹名要是「draft-<英文 slug>」，跟 meta.json 的 id 一致`);
  else assert.equal(dir, `${META.code}-${META.id}`, `${dir}：文件夹名要是「编号-slug」`);
  for (const pal of META.palettes) {
    assert.deepEqual(Object.keys(pal.colors).sort(), [...COLOR_ROLES].sort(), `${dir} ${pal.id} 的颜色角色不对`);
  }
  for (const look of META.looks || []) resolveParams(META, { look: look.id }); // 预设里的参数名和取值都要合法
  for (const key of ['text', 'palette', 'font', 'seed']) assert.ok(META.params.some((p) => p.key === key), `${dir}：params 里要有 ${key}`);
  if (files) assert.ok(existsSync(new URL(`${dir}/style.js`, STYLES_DIR)), `${dir}：缺 style.js`);
}

test('颜色混合', () => {
  assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
});

import { applyRules as rules2 } from '../src/lib/segment.js';

test('规则层（通用规则，例句是自己编的，不来自留出集）', () => {
  const cut = loadJieba();
  const seg = (s) => rules2(cut(s)).join('/');
  assert.equal(seg('双十一前必看'), '双十一/前/必看', '汉字数字写的促销日');
  assert.equal(seg('99元包邮到家'), '99元/包邮/到家', '单位表多吞了字要往回缩');
  assert.equal(seg('涨粉1000+'), '涨粉/1000+');
  assert.equal(seg('好家伙，一下子就卖光了'), '好家伙/，/一下子/就/卖光/了', '已经是一整块的不要切开');
  assert.equal(seg('等了半个小时'), '等/了/半个小时', '汉字数字加两层单位');
  assert.equal(seg('一年四季都好看'), '一年四季/都/好看', '成语不许被数字规则切开');
  assert.equal(seg('把房间收拾好'), '把/房间/收拾好', '两个字的动词加补语');
  assert.equal(seg('衣服洗干净了'), '衣服/洗干净/了', '两个字的补语');
  assert.equal(seg('这款口红'), '这款/口红', '代词加量词');
  assert.ok(seg('iPhone 17 Pro Max 到货').startsWith('iPhone 17 Pro Max/'), '带空格的英文产品名整体');
  assert.equal(seg('早上5:30起床'), '早上/5:30/起床');
});

test('规则层 v0.4：叠词、可能补语、趋向补语、X点半、前几天（例句自己编的）', () => {
  const cut = loadJieba();
  const seg = (s) => rules2(cut(s)).join('/');
  assert.ok(seg('你先试试这个').includes('试试'), 'AA 叠词');
  assert.ok(seg('讲得清清楚楚的').includes('清清楚楚'), 'AABB 叠词');
  assert.ok(seg('一遍遍地看').startsWith('一遍遍'), '数量词重叠');
  assert.ok(!seg('一个一个出来').startsWith('一个一个/'), '「一个一个」不按 ABAB 粘起来');
  assert.ok(seg('字太小看不全').includes('看不全'), '可能补语');
  assert.ok(seg('慢慢站起来').includes('站起来'), '趋向补语');
  assert.ok(seg('三点半见').startsWith('三点半'), 'X点半');
  assert.ok(seg('前几天刚买的').startsWith('前几天'), '前＋几＋天');
  assert.equal(seg('导航到公司').split('/')[0], '导航', '两字动词加「到」不合并');
});

import { analyzeFlashes } from '../cli/lib/flash.mjs';

function solidImg(w, h, fill, rect) {
  // fill: [r,g,b]；rect: 只在这块里填 fill，其余是黑
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inR = !rect || (x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3]);
    const c = inR ? fill : [0, 0, 0];
    data.set(c, (y * w + x) * 3);
  }
  return { width: w, height: h, channels: 3, data };
}
const run = (frames, fps = 30) => analyzeFlashes(frames, { fps, width: frames[0].width, height: frames[0].height, cell: 4 });

test('闪烁检查：全屏黑白每秒 10 次交替要判超标', () => {
  const W = 96; const H = 160; const frames = [];
  for (let f = 0; f < 60; f++) frames.push(solidImg(W, H, Math.floor(f / 3) % 2 ? [255, 255, 255] : [0, 0, 0]));
  const r = run(frames);
  assert.equal(r.pass, false);
  assert.ok(r.general.maxPerSecond > 3, `每秒 ${r.general.maxPerSecond} 次`);
});

test('闪烁检查：每秒 2 次（低于 3 次）不算超标', () => {
  const W = 96; const H = 160; const frames = [];
  for (let f = 0; f < 90; f++) frames.push(solidImg(W, H, Math.floor(f / 8) % 2 ? [255, 255, 255] : [0, 0, 0]));
  const r = run(frames);
  assert.ok(r.general.maxPerSecond <= 3, `每秒 ${r.general.maxPerSecond} 次`);
});

test('闪烁检查：面积不到画面 2.5% 的局部快闪不算', () => {
  const W = 192; const H = 320; const frames = [];
  // 24×32 的一块 = 1.25% 画面
  for (let f = 0; f < 60; f++) frames.push(solidImg(W, H, Math.floor(f / 3) % 2 ? [255, 255, 255] : [0, 0, 0], [80, 120, 24, 32]));
  assert.equal(run(frames).pass, true);
  // 同样的频率，块放大到 64×96 = 10% 画面，就超标
  const big = [];
  for (let f = 0; f < 60; f++) big.push(solidImg(W, H, Math.floor(f / 3) % 2 ? [255, 255, 255] : [0, 0, 0], [60, 100, 64, 96]));
  assert.equal(run(big).pass, false);
});

test('闪烁检查：饱和红和蓝快速交替（亮度变化小）要判红色闪烁', () => {
  const W = 96; const H = 160; const frames = [];
  for (let f = 0; f < 60; f++) frames.push(solidImg(W, H, Math.floor(f / 3) % 2 ? [230, 0, 0] : [0, 0, 255]));
  const r = run(frames);
  assert.ok(r.red.maxPerSecond > 3, `红色每秒 ${r.red.maxPerSecond} 次`);
  assert.equal(r.pass, false);
});

test('闪烁检查：慢慢淡入淡出（一次来回 2 秒）不算闪烁超标', () => {
  const W = 96; const H = 160; const frames = [];
  for (let f = 0; f < 120; f++) { const v = Math.round(255 * (0.5 - 0.5 * Math.cos((2 * Math.PI * f) / 60))); frames.push(solidImg(W, H, [v, v, v])); }
  assert.equal(run(frames).pass, true);
});

test('闪烁检查边界：每秒 3 次放行、每秒 4 次拦下', () => {
  const W = 96; const H = 160;
  const mk = (every) => { const fr = []; for (let f = 0; f < 90; f++) fr.push(solidImg(W, H, Math.floor(f / every) % 2 ? [255, 255, 255] : [0, 0, 0])); return fr; };
  const r3 = run(mk(5)); // 每 5 帧翻一次＝每秒 6 次转变＝3 次闪烁
  const r4 = run(mk(4)); // 每 4 帧翻一次＝每秒 7.5 次转变，某些 1 秒窗口里有 8 次＝4 次闪烁
  assert.equal(r3.general.maxPerSecond, 3); assert.equal(r3.pass, true);
  assert.equal(r4.general.maxPerSecond, 4); assert.equal(r4.pass, false);
});

test('闪烁检查：大块白条平滑移动（运动不是闪烁）不算；同一块白条每帧乱跳要算', () => {
  const W = 192; const H = 320;
  const smooth = []; const jumpy = [];
  for (let f = 0; f < 60; f++) {
    smooth.push(solidImg(W, H, [255, 255, 255], [Math.round(f * 1.8), 100, 80, 120])); // 匀速横移，每帧约 2 像素
    jumpy.push(solidImg(W, H, [255, 255, 255], [(f * 37) % (W - 80), 100, 80, 120])); // 每帧跳到别处：对某块区域就是一亮一暗
  }
  assert.equal(run(smooth).pass, true);
  assert.equal(run(jumpy).pass, false);
});

function checker(w, h, sq, phase, shift = 0) {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const on = ((Math.floor((x + shift) / sq) + Math.floor(y / sq) + phase) % 2) === 0;
    data.fill(on ? 255 : 0, (y * w + x) * 3, (y * w + x) * 3 + 3);
  }
  return { width: w, height: h, channels: 3, data };
}

test('闪烁检查：全屏棋盘格每秒反色 10 次要拦下（窗口净面积是 0，靠「每格来回跳」判据）', () => {
  const W = 192; const H = 320; const frames = [];
  for (let f = 0; f < 60; f++) frames.push(checker(W, H, 16, Math.floor(f / 3) % 2));
  const r = run(frames);
  assert.equal(r.general.maxPerSecond <= 3, true, '第一道判据（净面积）本来就看不出来');
  assert.equal(r.pattern.general.pass, false);
  assert.equal(r.pass, false);
});

test('闪烁检查：同样的棋盘格只是平移、不反色，要放行', () => {
  const W = 192; const H = 320; const frames = [];
  for (let f = 0; f < 60; f++) frames.push(checker(W, H, 16, 0, f * 2)); // 每帧右移 2 像素
  const r = run(frames);
  assert.equal(r.pass, true, JSON.stringify(r.pattern.general));
});

import { normalizeWords } from '../src/lib/words.js';
import { allTextParams } from '../src/lib/params.js';

test('bounceIn / popOut 的 minScale：缩放太小的帧给 visible:false，默认不隐藏', () => {
  const ts = [0.005, 0.01, 0.02, 0.05, 0.1, 0.3];
  for (const t of ts) assert.equal(bounceIn(t).visible, true, '默认 minScale=0，tau>0 都显示');
  const hidden = ts.filter((t) => !bounceIn(t, { minScale: 0.2 }).visible);
  assert.ok(hidden.length >= 1, '刚开始那几帧隐藏');
  for (const t of hidden) assert.ok(bounceIn(t).sx < 0.2 * 1.2, '隐藏的都是缩放很小的');
  assert.equal(bounceIn(0.3, { minScale: 0.2 }).visible, true);
  assert.equal(bounceIn(0.003, { mode: 'drop', minScale: 0.2 }).visible, false);
  assert.equal(popOut(0.99, { minScale: 0.2 }).visible, false, '出场快缩没了隐藏');
  assert.equal(popOut(0.2, { minScale: 0.2 }).visible, true);
  assert.equal(popOut(1).visible, false, '缩到 0 就隐藏');
  assert.equal(combine(bounceIn(0.3), popOut(1)).visible, false, 'combine 里任何一个隐藏就隐藏');
  assert.equal(combine(bounceIn(0.3), { dx: 1 }).visible, true);
});

test('参数：空字符串默认当没填，声明了 allowEmpty 的才当成值', () => {
  const meta = { params: [{ key: 'text', type: 'text', default: '你好' }, { key: 'seal', type: 'text', default: '吉祥', allowEmpty: true }], palettes: [{ id: 'C1', colors: {} }] };
  assert.equal(resolveParams(meta, { text: '' }).text, '你好');
  assert.equal(resolveParams(meta, { seal: '' }).seal, '');
  assert.equal(resolveParams(meta, {}).seal, '吉祥');
});

test('fontPlan：文字参数默认用主字体链，paramFonts 指定的参数用自己那款字体（也能写 @参数名）', () => {
  const meta = { fonts: ['a'], fontFallback: { a: ['fb'], b: ['fb'] }, extraGlyphs: '·', paramFonts: { seal: 'b', sign: '@signFont' },
    params: [{ key: 'text', type: 'text' }, { key: 'seal', type: 'text' }, { key: 'sign', type: 'text' }, { key: 'signFont', type: 'select' }] };
  const plan = fontPlan(meta, { text: '*春风*|得意', seal: '吉祥', sign: '李', signFont: 'c', font: 'a' }, plainText);
  assert.deepEqual(plan.map((g) => g.fontId), ['a', 'b', 'c']);
  assert.deepEqual(plan[0].chain, ['a', 'fb']);
  assert.equal(charset(plan[0].chars), charset('·春风得意'), '主字体组：正文去掉标记，加上 extraGlyphs');
  assert.equal(charset(plan[1].chars), charset('吉祥'));
  assert.deepEqual(plan[2].chain, ['c'], '没写备用的字体链只有它自己');
  const plain = fontPlan({ fonts: ['a'], params: [{ key: 'text', type: 'text' }, { key: 'by', type: 'text' }] }, { text: '你好', by: '署名', font: 'a' });
  assert.equal(plain.length, 1, '没有 paramFonts 时只有主字体一组');
  assert.equal(charset(plain[0].chars), charset('你好署名'));
});

test('fontPlan：paramFonts 那几项全留空（或只有空白）时，那一组字体不出现，不做子集也不加载', () => {
  // 023 杂志封面：en、kicker、sub、side 都走另一款字体，四项全空时那一组一个字都没有，
  // 以前照样做子集，只剩空白字形的子集 glyf 表长度是 0，浏览器拒收（OTS：glyf: zero-length table），导出挂载失败
  const meta = { fonts: ['a'], paramFonts: { en: 'b', kicker: 'b', side: '@sideFont' },
    params: [{ key: 'text', type: 'text' }, { key: 'en', type: 'text', allowEmpty: true }, { key: 'kicker', type: 'text', allowEmpty: true },
      { key: 'side', type: 'text', allowEmpty: true }, { key: 'sideFont', type: 'select' }] };
  const ids = (p) => fontPlan(meta, { font: 'a', sideFont: 'c', text: '标题', ...p }, plainText).map((g) => g.fontId);
  assert.deepEqual(ids({ en: '', kicker: '', side: '' }), ['a'], '全空：只剩主字体');
  assert.deepEqual(ids({ en: ' ', kicker: '\n', side: '　' }), ['a'], '只有空白也算空');
  assert.deepEqual(ids({ en: 'VOGUE', kicker: '', side: '' }), ['a', 'b'], '有一项有字就留着这一组');
  assert.deepEqual(ids({ en: '', kicker: '', side: '侧' }), ['a', 'c']);
  assert.deepEqual(fontPlan(meta, { font: 'a', text: '' }, plainText).map((g) => g.fontId), ['a'], '主字体组哪怕是空的也一直在（风格要用它的字体名）');
});

test('子集字符：至少有一个带轮廓的字形，只有空白的子集浏览器会拒收', () => {
  const cov = new Set([0x20, 0x3000, 0x53E3, 0x30, 0x41]); // 空格、全角空格、口、0、A
  const out = loadableChars('', cov);
  assert.ok(/\S/.test(out), `空字符串要补一个看得见的字，实际是 ${JSON.stringify(out)}`);
  assert.ok(out.includes(' ') && out.includes('\u3000'), '空格字形照样带上');
  assert.equal(loadableChars('好', new Set([0x597D, 0x20])), '好 ', '已经有看得见的字就不另加');
  assert.ok(/\S/.test(loadableChars('', new Set([0x41]))), '字体里没有「口」就退到 0、A 之类');
});

test('字体下载地址：HANZIFX_FONTS_MIRROR 写前缀或模板，镜像在前、官方地址兜底', () => {
  const url = 'https://raw.githubusercontent.com/google/fonts/6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf';
  assert.deepEqual(fontUrls(url, ''), [url], '没设镜像就只有官方地址');
  assert.deepEqual(fontUrls(url, 'https://mirror.example.com/gh'), ['https://mirror.example.com/gh/google/fonts/6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf', url], '前缀：接上 owner/repo/ref/path');
  assert.deepEqual(fontUrls(url, 'https://cdn.example.com/gh/{owner}/{repo}@{ref}/{path}')[0], 'https://cdn.example.com/gh/google/fonts@6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf', '模板：按占位符填');
  assert.deepEqual(fontUrls('https://example.com/a.ttf', 'https://mirror.example.com/'), ['https://example.com/a.ttf'], '不是 GitHub raw 的地址不改');
});

test('字级时间：校验、整体偏移、对不上时指出第几个字', () => {
  const w = [{ text: '这也太', start: 0.1, end: 0.5 }, { text: '好笑', start: 0.5, end: 0.9 }, { text: '了吧！', start: 0.9, end: 1.2 }];
  const r = normalizeWords(w, '这也太*好笑*了吧', { offsetMs: -150 });
  assert.equal(r[0].start, 0, '偏移后小于 0 夹到 0');
  assert.ok(Math.abs(r[1].start - 0.35) < 1e-9);
  assert.throws(() => normalizeWords([{ text: '这也太好哭了吧', start: 0, end: 1 }], '这也太好笑了吧'), /第 5 个字开始不一样/);
  assert.throws(() => normalizeWords([{ text: '好笑', start: 1, end: 2 }, { text: '这也太', start: 0, end: 1 }], '好笑这也太'), /升序/);
  assert.deepEqual(normalizeWords([], '随便'), []);
});

test('字体子集收所有 text 类型的参数', () => {
  const meta = { params: [{ key: 'text', type: 'text' }, { key: 'author', type: 'text' }, { key: 'size', type: 'range' }] };
  assert.equal(allTextParams(meta, { text: '床前明月光', author: '唐·李白', size: 1 }), '床前明月光\n唐·李白');
});

import { shineSweep, shineStops, countUp, formatNumber, odometer, wipe, wipeRect, wipeStops, inkSpread } from '../src/motions/index.js';

test('共用动作：高光扫过', () => {
  assert.equal(shineSweep(0.1, { start: 0.2 }).visible, false);
  const m = shineSweep(0.5, { start: 0.2, duration: 0.6 });
  assert.ok(m.visible && m.u > 0.3 && m.u < 0.7);
  const st = shineStops(0.5);
  assert.equal(st[0][0], 0); assert.equal(st.at(-1)[0], 1);
  for (let i = 1; i < st.length; i++) assert.ok(st[i][0] >= st[i - 1][0], '色标 offset 要递增');
  assert.deepEqual(shineSweep(0.5, { start: 0.2 }), shineSweep(0.5, { start: 0.2 }), '纯函数');
});

test('共用动作：数字滚动和排版', () => {
  assert.equal(countUp(0, { from: 0, to: 100 }).text, '0');
  assert.equal(countUp(5, { from: 0, to: 100 }).text, '100');
  assert.equal(formatNumber(12345, { unit: '万' }), '1.2万');
  assert.equal(formatNumber(10000, { unit: '万' }), '1万');
  assert.equal(formatNumber(230000000, { unit: '万' }), '2.3亿');
  assert.equal(formatNumber(1234567, { sep: ',' }), '1,234,567');
  assert.equal(formatNumber(3.14159, { decimals: 2 }), '3.14');
  const o = odometer(129.5, { digits: 3 });
  assert.deepEqual(o.map((x) => x.digit), [1, 2, 9]);
  assert.ok(Math.abs(o[2].frac - 0.5) < 1e-9, '个位滚了一半');
  assert.ok(Math.abs(o[1].frac - 0.5) < 1e-9, '十位跟着个位从 9 往上滚');
  assert.equal(o[0].frac, 0, '百位没动');
});

test('共用动作：遮罩扫出', () => {
  assert.equal(wipe(0, { start: 0.5 }), 0); assert.equal(wipe(9, { start: 0.5 }), 1);
  assert.deepEqual(wipeRect(0.5, { x: 0, y: 0, w: 100, h: 50 }, 'left'), { x: 0, y: 0, w: 50, h: 50 });
  assert.deepEqual(wipeRect(0.5, { x: 0, y: 0, w: 100, h: 50 }, 'right'), { x: 50, y: 0, w: 50, h: 50 });
  assert.deepEqual(wipeRect(0.25, { x: 0, y: 0, w: 100, h: 40 }, 'up'), { x: 0, y: 30, w: 100, h: 10 });
  const st = wipeStops(0.5);
  for (let i = 1; i < st.length; i++) assert.ok(st[i][0] >= st[i - 1][0]);
});

test('共用动作：墨迹晕开（纯函数、随时间长大、边缘不规则）', () => {
  const pts = [{ x: 100, y: 100 }, { x: 200, y: 120 }];
  const a = inkSpread(0.3, { seed: 3, points: pts, maxR: 80 });
  const b = inkSpread(0.3, { seed: 3, points: pts, maxR: 80 });
  assert.deepEqual(a, b, '同样的输入同样的路径');
  assert.equal(inkSpread(0, { points: pts })[0].d, '', '还没开始');
  assert.ok(inkSpread(0.6, { seed: 3, points: pts, maxR: 80 })[0].r > a[0].r, '越来越大');
  assert.notEqual(inkSpread(0.3, { seed: 4, points: pts, maxR: 80 })[0].d, a[0].d, '换种子形状就变');
});
