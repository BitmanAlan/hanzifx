// 字体工具（Node）：下载并校验源字体、查覆盖、按用字做子集。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';
import * as hb from 'harfbuzzjs';
import { writeFileAtomic } from './atomic.mjs';

export const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FONTS_DIR = join(ENGINE_DIR, 'fonts');

export async function loadRegistry() {
  return JSON.parse(await readFile(join(FONTS_DIR, 'registry.json'), 'utf8'));
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 哪些字体要做试玩用的常用字子集：主字体（role: primary）都要；备用字体（fallback）和没有中文的拉丁字体（latin），
 * 只要被哪个风格当主字体（meta.fonts）或参数字体（meta.paramFonts）用了，也要做（比如 007 拿思源黑体 Black 当主字体）。
 */
export async function fontsNeedingCommon(reg) {
  const { readdir } = await import('node:fs/promises');
  const stylesDir = join(ENGINE_DIR, '..', 'styles');
  const used = new Set();
  for (const d of await readdir(stylesDir).catch(() => [])) {
    try {
      const m = JSON.parse(readFileSync(join(stylesDir, d, 'meta.json'), 'utf8'));
      for (const f of m.fonts || []) used.add(f);
      for (const v of Object.values(m.paramFonts || {})) if (typeof v === 'string' && !v.startsWith('@')) used.add(v);
    } catch { /* 不是风格目录 */ }
  }
  const onDemand = new Set(['fallback', 'latin']);
  return new Set(Object.entries(reg).filter(([id, e]) => !onDemand.has(e.role) || used.has(id)).map(([id]) => id));
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** 源字体在不在、sha256 对不对；不在就按 registry 里的地址下载 */
export async function ensureSource(id, entry, { download = true } = {}) {
  const p = join(FONTS_DIR, entry.file);
  if (await exists(p)) {
    const h = sha256(await readFile(p));
    if (h !== entry.sha256) throw new Error(`字体 ${id} 的 sha256 对不上：本地 ${h}，应为 ${entry.sha256}。删掉 ${p} 重新下载。`);
    return p;
  }
  if (!download) throw new Error(`缺字体文件 ${p}，先运行 npm run fonts`);
  const tried = [];
  for (const url of fontUrls(entry.url)) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const h = sha256(buf);
      if (h !== entry.sha256) throw new Error(`sha256 不对：${h}，应为 ${entry.sha256}`);
      await mkdir(dirname(p), { recursive: true });
      await writeFileAtomic(p, buf);
      return p;
    } catch (e) {
      tried.push(`${url}（${e.message}）`);
      if (tried.length < fontUrls(entry.url).length) console.error(`⚠ 字体 ${id} 从 ${url} 没下下来（${e.message}），换下一个地址`);
    }
  }
  throw new Error(`下载字体 ${id} 失败：${tried.join('；')}。网络连不上 GitHub 的话，可以设环境变量 HANZIFX_FONTS_MIRROR 换下载地址，`
    + `或者自己把文件下载下来放到 ${p}（sha256 对得上就直接用），见 engine/FONTS.md「下载不下来怎么办」`);
}

/**
 * 字体的下载地址。registry 里写的是 GitHub raw 地址（钉在某个提交上）；设了 HANZIFX_FONTS_MIRROR 就先试镜像，再试官方地址。
 *   前缀写法：HANZIFX_FONTS_MIRROR=https://镜像/gh → https://镜像/gh/<owner>/<repo>/<ref>/<path>
 *   模板写法：HANZIFX_FONTS_MIRROR='https://cdn.example.com/gh/{owner}/{repo}@{ref}/{path}'
 * 不管从哪儿下，都照样核 sha256，镜像给错文件会被拒。
 */
export function fontUrls(url, mirror = process.env.HANZIFX_FONTS_MIRROR || '') {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  if (!mirror || !m) return [url];
  const [, owner, repo, ref, path] = m;
  const alt = mirror.includes('{')
    ? mirror.replaceAll('{owner}', owner).replaceAll('{repo}', repo).replaceAll('{ref}', ref).replaceAll('{path}', path)
    : `${mirror.replace(/\/+$/, '')}/${owner}/${repo}/${ref}/${path}`;
  return alt === url ? [url] : [alt, url];
}

/** 字体里有哪些码位（harfbuzz 读 cmap）。只吃 TTF/OTF。 */
export function unicodesOf(sfntBuf) {
  const blob = new hb.Blob(sfntBuf);
  const face = new hb.Face(blob, 0);
  const set = new Set(face.collectUnicodes());
  face.destroy?.();
  blob.destroy?.();
  return set;
}

/** 这些字里哪些字体没有 */
export function missingChars(unicodes, chars) {
  return [...chars].filter((c) => !unicodes.has(c.codePointAt(0)));
}

/** 做子集：返回 { woff2, sfnt, missing }。missing 非空时调用方应当报错，不要静默回退 */
export async function subset(srcBuf, chars, { variation } = {}) {
  const all = unicodesOf(srcBuf);
  const missing = missingChars(all, chars);
  const keep = [...chars].filter((c) => all.has(c.codePointAt(0))).join('');
  // 可变字体（比如思源黑体）按 registry 里的 variation 固定成一个字重；竖排用的 vert/vrt2 等排版特性默认全保留
  const opt = variation ? { variationAxes: variation } : {};
  const sfnt = await subsetFont(srcBuf, keep, { targetFormat: 'sfnt', ...opt });
  const woff2 = await subsetFont(srcBuf, keep, { targetFormat: 'woff2', ...opt });
  // 子集做完再核一遍：子集里真的有这些字
  const got = unicodesOf(sfnt);
  const lost = missingChars(got, keep);
  if (lost.length) throw new Error(`子集丢字：${lost.join('')}`);
  return { woff2, sfnt, missing, kept: keep };
}

/** GB2312 一二级汉字（6763 个），用 Node 自带的 GBK 解码表生成，不用下载字表 */
export function gb2312Hanzi() {
  const dec = new TextDecoder('gbk', { fatal: false });
  const out = [];
  for (let b1 = 0xb0; b1 <= 0xf7; b1++) {
    for (let b2 = 0xa1; b2 <= 0xfe; b2++) {
      const ch = dec.decode(Uint8Array.from([b1, b2]));
      const cp = ch.codePointAt(0);
      if (ch.length === 1 && cp >= 0x4e00 && cp <= 0x9fff) out.push(ch);
    }
  }
  return out;
}

/**
 * 文字里夹的空格要用我们自己字体的空格字形：半角空格、不换行空格、全角空格。
 * 缺字检查用的 charset() 不收空白；子集里要是没有空格字形，浏览器就拿系统字体（苹方）的空格补上，
 * 导出时字体实测报「回退成了字体链以外的字体」，空格的宽度也跟试玩台对不上。所以每个子集都带上这三个（字体里有的话）。
 */
export const SPACE_GLYPHS = ' \u00A0\u3000';

/** 给子集字符补上字体里有的空格字形（已经有的不重复加） */
export function withSpaceGlyphs(chars, cov) {
  let out = chars;
  for (const ch of SPACE_GLYPHS) if (cov.has(ch.codePointAt(0)) && !out.includes(ch)) out += ch;
  return out;
}

/**
 * 真正拿去做子集的字符：补上空格字形，并且保证至少有一个带轮廓的字形。
 * 只有空白（或什么都没有）的子集 glyf 表长度是 0，浏览器的字体校验（OTS）会拒收，页面就加载不了字体。
 */
export function loadableChars(chars, cov) {
  let out = withSpaceGlyphs(chars, cov);
  if (!/\S/.test(out)) {
    const ch = ['口', '0', 'A', '.', '一'].find((c) => cov.has(c.codePointAt(0)))
      ?? [...cov].map((cp) => String.fromCodePoint(cp)).find((c) => /\S/.test(c));
    if (ch) out = ch + out;
  }
  return out;
}

/** 试玩页用的「常用字」子集字符：GB2312 汉字 + ASCII（含空格）+ 不换行空格、全角空格 + 常用中文标点和符号 */
export function commonCharset() {
  const ascii = [...SPACE_GLYPHS];
  for (let c = 0x21; c <= 0x7e; c++) ascii.push(String.fromCharCode(c));
  const punct = [...'，。、；：？！…—～·“”‘’（）《》〈〉「」『』【】〔〕〖〗％＋－×÷＝＃＆＊＠¥￥①②③④⑤⑥⑦⑧⑨⑩'];
  return [...new Set([...ascii, ...punct, ...gb2312Hanzi()])].join('');
}

/**
 * 按字体链给每个字找字体：主字体有就用主字体，没有就依次找备用字体，都没有就记成完全缺字。
 * 返回 { byFont: Map(fontId → 字符串), fallback: [{char, font}], missing: [字] }
 */
export function assignGlyphs(chain, coverage, chars) {
  const byFont = new Map(chain.map((id) => [id, '']));
  const fallback = []; const missing = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    const id = chain.find((f) => coverage.get(f).has(cp));
    if (!id) missing.push(ch);
    else {
      byFont.set(id, byFont.get(id) + ch);
      if (id !== chain[0]) fallback.push({ char: ch, font: id });
    }
  }
  return { byFont, fallback, missing };
}

/** 读 sfnt 的 name 表，返回 { family(1), subfamily(2), full(4), postscript(6), typoFamily(16) }，只取 Windows Unicode 那份 */
export function fontNames(sfnt) {
  const n = sfnt.readUInt16BE(4);
  let nameOff = -1;
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    if (sfnt.toString('latin1', rec, rec + 4) === 'name') nameOff = sfnt.readUInt32BE(rec + 8);
  }
  if (nameOff < 0) return {};
  const count = sfnt.readUInt16BE(nameOff + 2);
  const strOff = nameOff + sfnt.readUInt16BE(nameOff + 4);
  const out = {};
  const want = { 1: 'family', 2: 'subfamily', 4: 'full', 6: 'postscript', 16: 'typoFamily' };
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    const platform = sfnt.readUInt16BE(r); const lang = sfnt.readUInt16BE(r + 4); const id = sfnt.readUInt16BE(r + 6);
    const len = sfnt.readUInt16BE(r + 8); const off = sfnt.readUInt16BE(r + 10);
    if (platform !== 3 || !want[id] || (lang !== 0x409 && out[want[id]])) continue;
    const b = sfnt.subarray(strOff + off, strOff + off + len);
    let str = '';
    for (let k = 0; k + 1 < b.length; k += 2) str += String.fromCharCode(b.readUInt16BE(k));
    out[want[id]] = str;
  }
  return out;
}
