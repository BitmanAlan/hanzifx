// 导出流水线：参数 → 子集字体 → 浏览器逐帧截图（可多路并行、可乱序）→ ffmpeg 编码 → 核尺寸/alpha → 写清单。
import { mkdir, readFile, writeFile, rm, rename, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { resolveParams, comboCode, allTextParams, fontPlan } from '../../src/lib/params.js';
import { normalizeWords } from '../../src/lib/words.js';
import { charset } from '../../src/lib/text.js';
import { buildSegmentation, plainText } from '../../src/lib/segment.js';
import { loadJieba, JIEBA_VERSION } from './jieba.mjs';
import { ENGINE_DIR, loadRegistry, ensureSource, subset, sha256, unicodesOf, assignGlyphs, fontNames, loadableChars } from './fonts.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { startServer, REPO_ROOT } from './server.mjs';
import { launchBrowser, openRenderPage, probeFonts, extraChromeArgs } from './browser.mjs';
import { encode, probe, versionOf } from './ffmpeg.mjs';
import { decodePng, alphaStats } from './png.mjs';
import { FlashAnalyzer } from './flash.mjs';
import { hash01 } from '../../src/lib/rand.js';

const require = createRequire(import.meta.url);
const PW_VERSION = require('playwright-core/package.json').version;

export const ALPHA_FORMATS = new Set(['mov', 'webm', 'png']);

export function parseSize(s) {
  const map = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
  if (map[s]) return map[s];
  const m = /^(\d+)x(\d+)$/.exec(s || '');
  if (!m) throw new Error(`尺寸写成 1080x1920 或 9:16，收到 ${s}`);
  return [Number(m[1]), Number(m[2])];
}

/** 打乱帧顺序（带种子，结果可复现），用来证明风格是纯函数 */
function shuffled(n, seed) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, 'shuffle', i) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const log = (quiet, ...m) => { if (!quiet) console.log(...m); };

/**
 * @param {object} o
 *  style: 仓库里的风格目录（相对仓库根，如 styles/001-variety-outline）
 *  params: 用户参数（可只给一部分）
 *  size: '1080x1920' | '9:16' ...；fps；background: transparent|studio|#RRGGBB
 *  formats: ['mp4'] / ['mov','webm','png']；outDir
 *  workers：并行几路；order：'seq' | 'shuffle'；keepFrames；chrome；quiet
 */
export async function exportJob(o) {
  const t0 = Date.now();
  const styleRel = o.style.replace(/^\/+|\/+$/g, '');
  const styleDir = resolve(REPO_ROOT, styleRel);
  const meta = JSON.parse(await readFile(join(styleDir, 'meta.json'), 'utf8'));
  const params = resolveParams(meta, o.params || {});
  const [W, H] = parseSize(o.size || '1080x1920');
  const fps = Number(o.fps || meta.fps || 30);
  // 背景：命令行给的 > 风格 meta.exportDefaults.bg（比如互动元素默认透明底）> studio
  const background = o.background || (meta.exportDefaults && meta.exportDefaults.bg) || 'studio';
  const formats = o.formats || (meta.exportDefaults && meta.exportDefaults.formats) || (background === 'transparent' ? ['mov', 'webm'] : ['mp4']);
  const alpha = background === 'transparent';
  for (const f of formats) {
    if (f === 'mp4' && alpha) throw new Error('MP4 不带透明通道。透明底请用 --format mov,webm,png；要 MP4 就换 --bg studio 或 --bg #颜色');
    if (ALPHA_FORMATS.has(f) && f !== 'png' && !alpha) throw new Error(`${f} 是给透明底用的，请加 --bg transparent`);
  }
  const outDir = resolve(o.outDir);
  await mkdir(outDir, { recursive: true });
  const framesDir = join(outDir, 'frames');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  // 1) 字体：按这次实际用到的字做子集。主字体没有的字，按 meta.fontFallback 依次找备用字体（出警告）；
  //    整条链都没有的字直接报错，不让浏览器偷偷换系统字体
  const reg = await loadRegistry();
  const fontId = params.font || meta.fonts[0];
  // 字体分组：默认所有文字参数都用主字体那条链；meta.paramFonts 指定的文字参数（比如印章字）用它自己那款字体的链
  const plan = fontPlan(meta, params, plainText);
  const chain = plan[0].chain; // 主字体链（manifest 里照旧写这一条）
  const allIds = [...new Set(plan.flatMap((g) => g.chain))];
  for (const id of allIds) if (!reg[id]) throw new Error(`没登记的字体：${id}`);
  const entry = reg[fontId];
  // 分词在准备阶段做（第一层作者手标 | → 第二层 jieba+词表），结果当作输入数据传给风格
  const segmentation = buildSegmentation(params.text, { cut: loadJieba(o.extraWords || []) });
  // 子集收所有 text 类型参数的字（署名、印章这类单独的文字参数也算），不只是 text
  const used = charset(plainText(allTextParams(meta, params)) + (meta.extraGlyphs || ''));
  // 字级时间：先在这里校验（出错早、提示清楚），浏览器里宿主会再整理一遍
  const words = normalizeWords(o.words || [], plainText(params.text), { offsetMs: o.wordsOffsetMs || 0 });
  const srcs = new Map(); const coverage = new Map();
  for (const id of allIds) {
    const buf = await readFile(await ensureSource(id, reg[id]));
    srcs.set(id, buf);
    coverage.set(id, unicodesOf(buf));
  }
  // 每组按自己的链分字，再按字体合并（同一款字体出现在两组里只做一个子集）
  const assign = { byFont: new Map(allIds.map((id) => [id, ''])), fallback: [], missing: [] };
  for (const g of plan) {
    const a = assignGlyphs(g.chain, coverage, charset(g.chars));
    for (const [id, chars] of a.byFont) assign.byFont.set(id, assign.byFont.get(id) + chars);
    assign.fallback.push(...a.fallback);
    if (a.missing.length) assign.missing.push({ chars: a.missing, chain: g.chain });
  }
  if (assign.missing.length) {
    const msg = assign.missing.map((m) => `「${m.chars.join('')}」在 ${m.chain.map((id) => reg[id].name).join('、')} 里都没有`).join('；');
    const e = new Error(`缺字：${msg}。换个字或换字体（不会回退成系统字体）。`);
    e.code = 'MISSING_GLYPHS'; e.missing = assign.missing.flatMap((m) => m.chars);
    throw e;
  }
  const groupHeads = new Set(plan.map((g) => g.fontId));
  await mkdir(join(outDir, 'fonts'), { recursive: true });
  const cfgFonts = {}; const fontsUsed = [];
  for (const id of allIds) {
    const chars = charset(assign.byFont.get(id) || '');
    if (!chars && !groupHeads.has(id)) continue;
    const sub = await subset(srcs.get(id), loadableChars(chars, coverage.get(id)), { variation: reg[id].variation });
    const key = sha256(sub.woff2).slice(0, 16);
    const dir = join(ENGINE_DIR, 'out', '.fonts', key);
    await mkdir(dir, { recursive: true });
    // 几个导出可能同时写同一份（内容哈希一样）：先写临时文件再改名，别的导出的浏览器不会读到写了一半的字体
    await writeFileAtomic(join(dir, `${id}.woff2`), sub.woff2);
    await writeFile(join(outDir, 'fonts', `${id}.woff2`), sub.woff2);
    cfgFonts[id] = { family: reg[id].family, url: '/' + relative(REPO_ROOT, join(dir, `${id}.woff2`)).split(sep).join('/') };
    // 浏览器报的字体名来自子集文件自己的 name 表（可变字体固定字重后名字表不跟着改，思源黑体会报成 Thin），所以按实际文件核
    const names = fontNames(sub.sfnt);
    const role = id === fontId ? 'primary' : groupHeads.has(id) ? 'param' : 'fallback';
    const forParams = role === 'param' ? Object.entries(meta.paramFonts || {}).filter(([, v]) => (String(v).startsWith('@') ? params[String(v).slice(1)] : v) === id).map(([k]) => k) : undefined;
    fontsUsed.push({ id, name: reg[id].name, role, ...(forParams ? { forParams } : {}), license: reg[id].license, internalFamily: reg[id].internalFamily, nameTable: names, sourceSha256: reg[id].sha256, subsetSha256: sha256(sub.woff2), subsetBytes: sub.woff2.length, chars: chars || '' });
  }

  // 2) 浏览器
  const server = await startServer();
  const { browser, kind: browserKind, version: browserVersion } = await launchBrowser({ chrome: o.chrome });
  const cfg = {
    style: '/' + styleRel, params: o.params || {}, width: W, height: H, fps, background, beats: o.beats || [], words: o.words || [], wordsOffsetMs: o.wordsOffsetMs || 0, segmentation,
    fonts: cfgFonts,
  };
  const workers = Math.max(1, Number(o.workers || 1));
  const result = { ok: false };
  try {
    const pages = [];
    for (let k = 0; k < workers; k++) pages.push(await openRenderPage(browser, server.url, cfg));
    const info = pages[0].info;
    const duration = info.timeline.duration;
    const N = Math.ceil(duration * fps - 1e-9);
    log(o.quiet, `· ${meta.code} ${meta.name}｜${W}x${H}@${fps}｜${N} 帧（${duration.toFixed(2)} 秒）｜背景 ${background}｜浏览器 ${browserKind} ${browserVersion}｜${workers} 路${o.order === 'shuffle' ? '乱序' : '顺序'}`);
    for (const c of (Array.isArray(info.layout.styleChecks) ? info.layout.styleChecks : [])) if (!c.pass) log(o.quiet, `  ⚠ ${c.id}：${c.message}`);

    if (o.dryRun) {
      for (const p of pages) await p.context.close();
      Object.assign(result, { ok: true, dryRun: true, info });
      return result;
    }

    // 3) 字体实测：停留段中间那一帧，查每个文字节点实际用的字体
    const hold = info.timeline.segments.find((s) => s.name === 'hold');
    await pages[0].page.evaluate((t) => window.hanzifx.seek(t), (hold.start + hold.end) / 2);
    const fontProbe = await probeFonts(pages[0].page);
    const allowed = new Set(fontsUsed.flatMap((f) => [f.internalFamily, f.nameTable.family, f.nameTable.full, f.nameTable.typoFamily].filter(Boolean)));
    const stray = fontProbe.fonts.filter((f) => !f.isCustomFont || !allowed.has(f.familyName));
    if (stray.length) {
      throw new Error(`有字回退成了字体链以外的字体：${stray.map((f) => `${f.familyName}×${f.glyphCount}`).join('，')}`);
    }

    // 3b) 静帧：指定时刻各截一张（对比板、海报帧用）
    const stills = [];
    for (const t of o.stillTimes || []) {
      const tt = typeof t === 'function' ? t(info.timeline) : t;
      await pages[0].page.evaluate((x) => window.hanzifx.seek(x), tt);
      const buf = await pages[0].capture();
      const f = join(outDir, `still_${tt.toFixed(3)}s.png`);
      await writeFile(f, buf);
      stills.push({ t: tt, file: relative(REPO_ROOT, f) });
    }
    if (o.stillsOnly) {
      for (const p of pages) await p.context.close();
      Object.assign(result, { ok: true, stills, info });
      return result;
    }

    // 4) 逐帧截图：每一路按自己的队列跑；帧号决定文件名，跟渲染顺序无关
    const order = o.order === 'shuffle' ? shuffled(N, o.shuffleSeed ?? 20261119) : [...Array(N).keys()];
    const queues = pages.map(() => []);
    order.forEach((f, k) => queues[k % workers].push(f));
    const hashes = new Array(N);
    const tRender = Date.now();
    // 复位帧（实验）：每帧之前先画一次固定的复位时刻，让每一帧的「上一帧」都一样，画面就跟渲染顺序无关
    const resetFrame = o.resetFrame ?? (process.env.HANZIFX_RESET_FRAME === '1' ? 0 : null);
    await Promise.all(pages.map(async ({ page, capture, settle }, w) => {
      for (const f of queues[w]) {
        if (resetFrame != null) await settle(resetFrame);
        await page.evaluate((t) => window.hanzifx.seek(t), f / fps);
        const buf = await capture();
        hashes[f] = sha256(buf);
        await writeFile(join(framesDir, `${String(f + 1).padStart(6, '0')}.png`), buf);
      }
    }));
    const renderMs = Date.now() - tRender;

    // 5) 逐帧解 PNG：透明底查 alpha 和描边贴边；要查闪烁（meta.checks 有 flash-rate 或 o.checkFlash）的，顺便算亮度格子
    const wantFlash = !!o.checkFlash || (meta.checks || []).includes('flash-rate');
    let clip = null;
    const flashRuns = wantFlash ? (alpha
      ? [['叠在黑底上', new FlashAnalyzer({ fps, width: W, height: H, background: [0, 0, 0] })], ['叠在白底上', new FlashAnalyzer({ fps, width: W, height: H, background: [255, 255, 255] })]]
      : [['原画面', new FlashAnalyzer({ fps, width: W, height: H })]]) : [];
    if (alpha || wantFlash) {
      const edgeFrames = [];
      let minA = 255; let maxA = 0; let partial = 0;
      let unionBox = null;
      for (let f = 0; f < N; f++) {
        const img = decodePng(await readFile(join(framesDir, `${String(f + 1).padStart(6, '0')}.png`)));
        for (const [, an] of flashRuns) an.push(img);
        if (!alpha) continue;
        const st = alphaStats(img);
        if (!st.hasAlpha) throw new Error(`第 ${f + 1} 帧截图没有 alpha 通道`);
        minA = Math.min(minA, st.min); maxA = Math.max(maxA, st.max); partial += st.partial;
        if (st.edgeHits > 0) edgeFrames.push(f + 1);
        if (st.bbox) {
          unionBox = unionBox ? [Math.min(unionBox[0], st.bbox[0]), Math.min(unionBox[1], st.bbox[1]),
            Math.max(unionBox[2], st.bbox[2]), Math.max(unionBox[3], st.bbox[3])] : st.bbox;
        }
      }
      if (alpha) {
        const margin = unionBox ? Math.min(unionBox[0], unionBox[1], W - 1 - unionBox[2], H - 1 - unionBox[3]) : null;
        clip = { checkedFrames: N, framesTouchingEdge: edgeFrames, alphaMin: minA, alphaMax: maxA, partialAlphaPixels: partial, inkUnionBox: unionBox, minMarginPx: margin };
      }
    }
    // 5a) 闪烁（WCAG 2.3.1）：超标默认卡住导出；参数 flashMode = strong 时只警告，并写进清单
    let flash = null;
    if (wantFlash) {
      const results = flashRuns.map(([where, an]) => ({ where, ...an.finish() }));
      const worst = results.reduce((a, b) => (Math.max(b.general.maxPerSecond, b.red.maxPerSecond) > Math.max(a.general.maxPerSecond, a.red.maxPerSecond) ? b : a));
      const strong = params.flashMode === 'strong';
      flash = { pass: results.every((r) => r.pass), mode: strong ? 'strong' : 'safe', results, worst: { where: worst.where, general: worst.general, red: worst.red } };
      if (!flash.pass) {
        const g = worst.general; const r = worst.red;
        const pt = results.map((x) => x.pattern).filter(Boolean);
        const pat = pt.flatMap((x) => [x.general, x.red]).filter((x) => !x.pass).sort((a, b) => b.maxAreaFrac - a.maxAreaFrac)[0];
        const msg = `闪烁超标（WCAG 2.3.1）：${worst.where}，普通闪烁最多每秒 ${g.maxPerSecond} 次${g.worst ? `（${g.worst.startS.toFixed(2)}–${g.worst.endS.toFixed(2)} 秒）` : ''}，红色闪烁最多每秒 ${r.maxPerSecond} 次${r.worst ? `（${r.worst.startS.toFixed(2)}–${r.worst.endS.toFixed(2)} 秒）` : ''}` +
          (pat ? `；局部来回闪（图案反色那一类）：约 ${pat.atS.toFixed(2)} 秒时同时在闪的面积占画面 ${(pat.maxAreaFrac * 100).toFixed(1)}%` : '') +
          '；上限：每秒 3 次，同时闪的面积不超过画面 2.5%';
        if (!strong) {
          // 只有风格自己声明了 flashMode 参数，才能让用户「加 flashMode=strong」；没有这个参数的风格照做会报「未知参数」
          const canStrong = (meta.params || []).some((p) => p.key === 'flashMode' && (p.options || []).some((o) => (typeof o === 'string' ? o : o.value) === 'strong'));
          const how = canStrong
            ? '确实要强闪烁，加参数 flashMode=strong（会在清单里记下风险）'
            : '这个风格没有强闪烁模式：把节奏放慢、少做整屏变亮变暗，或者让闪的那一块小一点；风格作者也可以在 meta.json 里加 flashMode 参数（safe／strong）';
          const e = new Error(`${msg}。默认不导出；${how}`);
          e.code = 'FLASH_RISK'; e.flash = flash;
          throw e;
        }
        log(o.quiet, `  ⚠ 强闪烁模式：${msg}。光敏性癫痫风险，发布前请加提示。`);
      }
    }

    // 5b) 安全区：竖屏时看墨迹外框有没有进平台遮挡区（meta.safeArea；没实测前只出提示）
    let safeArea = null;
    if (clip && clip.inkUnionBox && meta.safeArea && H > W) {
      const [x0, y0, x1, y1] = clip.inkUnionBox;
      const intrusions = [];
      if (meta.safeArea.bottom && y1 > H * (1 - meta.safeArea.bottom)) intrusions.push({ zone: '底部文案区', px: Math.round(y1 - H * (1 - meta.safeArea.bottom)) });
      if (meta.safeArea.right && x1 > W * (1 - meta.safeArea.right)) intrusions.push({ zone: '右侧按钮区', px: Math.round(x1 - W * (1 - meta.safeArea.right)) });
      if (meta.safeArea.top && y0 < H * meta.safeArea.top) intrusions.push({ zone: '顶部区', px: Math.round(H * meta.safeArea.top - y0) });
      safeArea = { zones: meta.safeArea, measured: !!meta.safeArea.measured, intrusions };
    }

    // 6) 编码 + ffprobe 核对
    const outputs = [];
    const ffmpegVersion = await versionOf('ffmpeg');
    for (const f of formats) {
      if (f === 'png') continue;
      const file = join(outDir, `${meta.id}_${W}x${H}.${f}`);
      await encode(f, join(framesDir, '%06d.png'), fps, file);
      const pr = await probe(file);
      if (pr.width !== W || pr.height !== H) throw new Error(`${f} 尺寸不对：${pr.width}x${pr.height}，应为 ${W}x${H}`);
      outputs.push({ format: f, file: relative(REPO_ROOT, file), sha256: sha256(await readFile(file)), bytes: Number(pr.format.size), probe: pr });
    }
    if (formats.includes('png')) {
      const pngDir = join(outDir, 'png');
      await rm(pngDir, { recursive: true, force: true });
      if (o.keepFrames) {
        await mkdir(pngDir, { recursive: true });
        for (const name of await readdir(framesDir)) await writeFile(join(pngDir, name), await readFile(join(framesDir, name)));
      } else await rename(framesDir, pngDir);
      outputs.push({ format: 'png', file: relative(REPO_ROOT, pngDir), frames: N });
    }
    if (!o.keepFrames) await rm(framesDir, { recursive: true, force: true });

    const timelineOut = {
      style: meta.id, code: comboCode(meta, params), fps, frames: N, width: W, height: H,
      duration: info.timeline.duration,
      segments: info.timeline.segments.map((s) => ({ ...s, startFrame: Math.round(s.start * fps), endFrame: Math.round(s.end * fps) })),
      beats: info.timeline.beats.map((b) => ({ ...b, frame: Math.round(b.t * fps) })),
      units: info.timeline.units,
    };
    await writeFile(join(outDir, 'timeline.json'), JSON.stringify(timelineOut, null, 2));

    const checks = {
      segmentation: { sources: segmentation.sources, jiebaWasm: JIEBA_VERSION, words: segmentation.paragraphs.map((p) => p.words.map((w) => w.text).join('/')) },
      lineBreaks: info.layout.issues || [],
      icuWarnings: info.layout.warnings || [],
      forcedBreaks: Array.isArray(info.layout.forced) ? info.layout.forced : [], // 约定是数组；写成 false 的按「没有」算
      style: Array.isArray(info.layout.styleChecks) ? info.layout.styleChecks : [], // 风格自己的检查（比如 003 的印章压字）
      glyphs: { missing: assign.missing, fallback: assign.fallback.map((x) => ({ ...x, fontName: reg[x.font].name })) },
      fontProbe,
      clip,
      safeArea,
      flash,
    };
    const manifest = {
      engine: 'hanzifx/engine 0.0.1',
      style: { id: meta.id, code: meta.code, name: meta.name, dir: styleRel },
      combo: comboCode(meta, params),
      input: { params: o.params || {}, size: [W, H], fps, background, formats, beats: info.beats, words: words.length ? { count: words.length, offsetMs: o.wordsOffsetMs || 0 } : null },
      resolvedParams: Object.fromEntries(Object.entries(info.params).filter(([k]) => !k.startsWith('_'))),
      layout: { fontSize: info.layout.fontSize, lines: info.layout.lines },
      font: { id: fontId, name: entry.name, license: entry.license, chars: used, chain, used: fontsUsed },
      env: { browser: browserKind, browserVersion, playwrightCore: PW_VERSION, ffmpeg: ffmpegVersion, node: process.version, platform: `${process.platform}-${process.arch}`, ...(extraChromeArgs().length ? { extraChromeArgs: extraChromeArgs() } : {}), ...(resetFrame != null ? { resetFrame } : {}) },
      render: { workers, order: o.order || 'seq', frames: N, renderMs, totalMs: Date.now() - t0 },
      frames: { sha256: hashes, digest: sha256(hashes.join('\n')) },
      outputs,
      stills,
      checks,
    };
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log(o.quiet, `  ✓ ${N} 帧，截图 ${(renderMs / 1000).toFixed(1)} 秒；逐帧摘要 ${manifest.frames.digest.slice(0, 12)}；输出：${outputs.map((x) => x.file).join('、')}`);
    Object.assign(result, { ok: true, manifest, timeline: timelineOut, outDir });
    for (const p of pages) await p.context.close();
  } finally {
    await browser.close();
    await server.close();
  }
  return result;
}
