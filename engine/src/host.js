// 浏览器端宿主：加载风格、加载字体、挂载、按 t 渲染。试玩页和导出页用的是同一份。

import { resolveParams, allTextParams, fontPlan } from './lib/params.js';
import { normalizeWords } from './lib/words.js';
import { charset } from './lib/text.js';
import { buildSegmentation, plainText, segmenterFrom, emphasisFrom } from './lib/segment.js';
import { createBackdrop } from './backdrop.js';

const loadedFaces = new Map();
let mountCount = 0;

/** 加载一款字体（本地 woff2），等它真的加载完；失败直接抛错，不静默回退 */
export async function loadFont({ family, url }) {
  const key = `${family}|${url}`;
  // 记的是「正在加载」的那个 Promise：几张卡同时要同一款字体时只下载一次（画廊里实测过同一个文件下了两遍）
  if (!loadedFaces.has(key)) {
    const p = (async () => {
      const face = new FontFace(family, `url(${JSON.stringify(url)}) format("woff2")`, { display: 'block' });
      await face.load();
      document.fonts.add(face);
      return face;
    })();
    p.catch(() => loadedFaces.delete(key)); // 失败了下次重来，错误照样抛给调用的地方
    loadedFaces.set(key, p);
  }
  return loadedFaces.get(key);
}

/** 拍点整理成升序、去重、非负的秒数数组 */
export function normalizeBeats(beats) {
  if (!beats) return [];
  const arr = (Array.isArray(beats) ? beats : String(beats).split(/[,\s]+/)).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
  return [...new Set(arr.map((x) => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b);
}

export async function loadStyle(styleBase) {
  const base = styleBase.replace(/\/$/, '');
  const meta = await (await fetch(`${base}/meta.json`)).json();
  const mod = await import(`${base}/style.js`);
  return { meta, mod, base };
}

/**
 * 挂载一个风格实例。
 * opts: { style:{meta,mod}, params, width, height, background, fonts:{ [fontId]: {family,url} } }
 * 返回 { params, timeline, layout, seek(t), destroy() }
 */
export async function mount(root, opts) {
  const { style, width, height } = opts;
  const params = resolveParams(style.meta, opts.params || {});
  // 字体链：主字体在前，备用字体在后（meta.fontFallback）。浏览器按字往后找，所以主字体缺的字会落到备用字体上；
  // 链里只放拿到了地址的字体，链外的系统字体一概不许出现（导出时用开发者协议逐个文字节点核对）。
  const chainOf = (id) => [id, ...((style.meta.fontFallback || {})[id] || [])].filter((f) => opts.fonts[f]);
  const chain = chainOf(params.font);
  if (!chain.length || chain[0] !== params.font) throw new Error(`没有字体 ${params.font} 的地址`);
  // meta.paramFonts 指定了别的字体的文字参数（比如印章字），那款字体的链也要加载
  const plan = fontPlan(style.meta, params, plainText);
  for (const g of plan) if (!opts.fonts[g.fontId]) throw new Error(`没有字体 ${g.fontId} 的地址（${g.fontId === params.font ? '主字体' : 'meta.paramFonts 里指定的'}）`);
  const loadIds = [...new Set(plan.flatMap((g) => chainOf(g.fontId)))];
  await Promise.all(loadIds.map((id) => loadFont(opts.fonts[id])));
  await document.fonts.ready;
  const familyList = (id) => chainOf(id).map((f) => `"${opts.fonts[f].family}"`).join(', ');
  const fontInfo = opts.fonts[params.font];
  // 分词：预先算好的（导出时 Node 端用 jieba 算）> 传进来的切词函数（试玩台加载了 jieba）> 兜底
  const segmentation = opts.segmentation || buildSegmentation(params.text, { cut: opts.cut || null });
  const text = plainText(params.text);
  const used = charset(plainText(allTextParams(style.meta, params)) + (style.meta.extraGlyphs || ''));
  // 字级时间：外部给的（--words-file 或试玩台导入），校验后传给风格
  const words = normalizeWords(opts.words || [], text, { offsetMs: opts.wordsOffsetMs || 0 });
  for (const g of plan) {
    const chars = charset(g.chars);
    if (chars && !document.fonts.check(`32px ${familyList(g.fontId)}`, chars)) throw new Error(`字体 ${familyList(g.fontId)} 没加载好`);
  }
  root.innerHTML = '';
  root.style.position = 'relative';
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
  root.style.overflow = 'hidden';
  const bg = createBackdrop(root, opts.background || 'transparent', { width, height });
  const layer = document.createElement('div');
  layer.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;`;
  root.appendChild(layer);
  // 外部拍点：一串秒数（比如 rea-video 量出来的音乐节拍，或用户自己给的）。底座不做节拍检测，只负责传给风格
  const beats = normalizeBeats(opts.beats);
  const inst = style.mod.create(layer, {
    params, width, height, beats, words, text, segmentation, segment: segmenterFrom(segmentation),
    // 帧率：导出时是这次导出的帧率，试玩台、画廊用风格 meta.fps，都没有就是 30
    fps: Number(opts.fps) || Number(style.meta.fps) || 30,
    // 每次挂载唯一的前缀：SVG 里的渐变、滤镜、遮罩 id 都加上它，一页放几个预览（画廊）时才不会互相撞。
    // 按挂载顺序编号，导出时每页只挂一次，所以结果可复现
    uid: `hanzifx${style.meta.code || ''}m${++mountCount}`,
    // 背景模式：透明底（导出透明素材、试玩台的棋盘格）时 transparent=true，自己画整屏底色的风格这时要改成透明画法
    background: opts.background || 'transparent',
    transparent: !opts.background || opts.background === 'transparent' || opts.background === 'checker',
    isEmphasis: emphasisFrom(segmentation), // (段号, 段内下标) → 是不是 *关键词*
    fontFamily: (id) => familyList(opts.fonts[id] ? id : params.font), // 返回整条字体链的 CSS 写法
  });
  const seek = (t) => {
    const tt = Math.max(0, Math.min(t, inst.timeline.duration));
    bg.seek(tt);
    inst.seek(tt);
  };
  seek(0);
  return {
    params,
    charset: used,
    font: fontInfo,
    fontChain: chain,
    timeline: inst.timeline,
    layout: inst.layout,
    beats,
    words,
    text,
    segmentation,
    seek,
    destroy() { inst.destroy(); bg.destroy(); layer.remove(); },
  };
}
