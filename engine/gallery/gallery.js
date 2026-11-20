// 在线画廊：每张卡直接跑风格代码（engine/src/host.js 的 mount），不是视频；点卡上的字就地改。
// 路径全部相对，放在任何子路径下（比如 GitHub Pages 的 /仓库名/）都能用。数据来自 catalog.json（catalog.mjs 生成）。
//
// 取景：字效按整屏 9:16 显示；互动元素的卡是 4:5，挂载后自动量：按海报帧那一刻元素的外框居中、定放大倍数，
//   整个循环里的运动范围（比如从下往上的入场）只用来压低放大倍数的上限，不拿来定中心。
//   meta.gallery.crop = [x, y, w, h]（1080×1920 画面里的像素）可以手动指定，覆盖自动量的结果。
// 循环：首次显示从海报帧（meta.posterTime）开始播；循环区间从「画面里第一次有东西」到「出场开始」，
//   两头的空白段不播，任何时刻截图卡里都有字。播到头停一下再从头来。
import { loadStyle, mount } from './engine/src/host.js';
import { resolveParams, fontPlan } from './engine/src/lib/params.js';
import { plainText } from './engine/src/lib/segment.js';
import { resolveTime } from './engine/cli/lib/when.mjs';

const W = 1080, H = 1920; // 一律按竖屏原尺寸挂载，再整体缩放、取景
const FPS = 30;
const PAUSE = 0.9; // 播到头停一下
const SAMPLES = 32; // 量取景和空白段时，整条时间轴取多少个时刻
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const I18N = {
  zh: {
    title: '中文字效库',
    tagline: '给 AI agent 用的中文短视频字效和互动元素。一句话说要什么，出综艺花字、书法标题、逐词字幕、价格标签、投票条……排版守中文的规矩：不在词中间断行，标点不出现在行首，竖排标点放对位置。下面每张卡都是真代码在跑，点字就能改。',
    counts: (s, i) => `字效 <b>${s}</b> · 互动 <b>${i}</b>`,
    promo: '宣传片片段',
    reel: '看完整宣传片',
    all: '全部', style: '字效', interaction: '互动元素',
    secStyle: '字效', secInter: '互动元素',
    secStyleNote: '整屏的字：标题、字幕、海报', secInterNote: '叠在画面上的小部件：引导、投票、价格、倒计时',
    search: '搜编号或名字：13、价格',
    copy: '复制调用句', copied: '已复制', daily: '日常', signature: '招牌',
    editHint: '改字，马上看效果', empty: '没有找到，换个词试试',
    failed: '这张卡没跑起来：', kindLabel: { style: '字效', interaction: '互动' },
    foot: '代码 MIT · 文档 CC-BY-NC-4.0 · 样片 CC-BY-4.0 · 字体都是 OFL。画廊里的字体只带常用字，生僻字会显示成系统字体，导出不受影响。',
  },
  en: {
    title: 'Chinese Text FX',
    tagline: 'Chinese short-video text effects and interactive overlays, built for AI agents. Describe what you want in one sentence and get variety-show captions, calligraphy titles, word-by-word captions, price tags, vote bars and more, with Chinese typesetting done right. Every card below runs the real code. Click the text to edit it.',
    counts: (s, i) => `<b>${s}</b> text effects · <b>${i}</b> interactive overlays`,
    promo: 'Showreel clip',
    reel: 'Watch the full showreel',
    all: 'All', style: 'Text effects', interaction: 'Interactive',
    secStyle: 'Text effects', secInter: 'Interactive overlays',
    secStyleNote: 'Full-screen type: titles, captions, posters', secInterNote: 'Small widgets over your footage: prompts, polls, prices, countdowns',
    search: 'Search: 13, price, vote',
    copy: 'Copy prompt', copied: 'Copied', daily: 'Everyday', signature: 'Signature',
    editHint: 'Edit the text', empty: 'Nothing found. Try another word.',
    failed: 'This card failed to run: ', kindLabel: { style: 'Text FX', interaction: 'Interactive' },
    foot: 'Code MIT · Docs CC-BY-NC-4.0 · Demos CC-BY-4.0 · All fonts OFL. Gallery fonts cover common characters only; rare ones fall back to a system font here (exports are unaffected).',
  },
};

const state = { lang: 'zh', kind: 'all', tag: null, q: '', catalog: null, fonts: null };
const cards = [];
const $ = (id) => document.getElementById(id);
const tr = () => I18N[state.lang];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}
const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// ---------- 启动 ----------
async function main() {
  const [catalog, fonts] = await Promise.all([
    fetch('catalog.json').then((r) => r.json()),
    fetch('engine/fonts/fonts.json').then((r) => r.json()),
  ]);
  state.catalog = catalog;
  state.fonts = fonts;
  // 语言：记住上次选的；没选过就看浏览器语言
  let saved = null;
  try { saved = localStorage.getItem('hanzifx-lang'); } catch { /* 无痕模式拿不到 */ }
  if (saved === 'en' || saved === 'zh') state.lang = saved;
  else if (navigator.language && !navigator.language.toLowerCase().startsWith('zh')) state.lang = 'en';
  for (const c of catalog.styles) cards.push(makeCard(c));
  window.__hanzifx = { cards }; // 排查用：在控制台看每张卡量出来的循环区间和取景框
  $('gridStyle').append(...cards.filter((c) => !c.inter).map((c) => c.el));
  $('gridInter').append(...cards.filter((c) => c.inter).map((c) => c.el));
  $('search').addEventListener('input', (e) => { state.q = e.target.value; applyFilter(); });
  $('langBtn').addEventListener('click', () => { state.lang = state.lang === 'zh' ? 'en' : 'zh'; try { localStorage.setItem('hanzifx-lang', state.lang); } catch { /* 忽略 */ } renderText(); });
  renderText();
  applyFilter();
  new ResizeObserver(() => { for (const c of cards) placeStage(c); }).observe(document.body);
  observeCards();
  if (!reduceMotion) requestAnimationFrame(tick);
}

// ---------- 门面、筛选的文字（中英切换时重画） ----------
function renderText() {
  const t = tr();
  document.documentElement.lang = state.lang === 'zh' ? 'zh-Hans' : 'en';
  $('title').textContent = t.title;
  $('tagline').textContent = t.tagline;
  $('counts').innerHTML = t.counts(state.catalog.counts.style, state.catalog.counts.interaction);
  $('promoText').textContent = t.promo;
  $('promoImg').alt = t.promo;
  $('reelText').textContent = t.reel;
  $('langBtn').textContent = state.lang === 'zh' ? 'EN' : '中文';
  $('search').placeholder = t.search;
  $('empty').textContent = t.empty;
  $('footText').textContent = t.foot;
  $('secStyleTitle').textContent = t.secStyle; $('secStyleNote').textContent = t.secStyleNote;
  $('secInterTitle').textContent = t.secInter; $('secInterNote').textContent = t.secInterNote;
  const kinds = [['all', t.all], ['style', t.style], ['interaction', t.interaction]];
  $('kindChips').replaceChildren(...kinds.map(([k, label]) => el('button', { type: 'button', class: state.kind === k ? 'on' : '', text: label, onclick: () => { state.kind = k; renderText(); applyFilter(); } })));
  // 用途标签：出现两次以上的，按出现次数排，最多 12 个（「互动」跟类别重复，不放）
  const freq = new Map();
  for (const c of state.catalog.styles) for (const g of c.tags || []) if (g !== '互动') freq.set(g, (freq.get(g) || 0) + 1);
  const tags = [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g]) => g);
  $('tagChips').replaceChildren(...tags.map((g) => el('button', { type: 'button', class: state.tag === g ? 'on' : '', text: `#${g}`, onclick: () => { state.tag = state.tag === g ? null : g; renderText(); applyFilter(); } })));
  for (const c of cards) renderCardText(c);
}

// ---------- 搜索和筛选 ----------
function matches(c) {
  if (state.kind !== 'all' && (c.kind || 'style') !== state.kind) return false;
  if (state.tag && !(c.tags || []).includes(state.tag)) return false;
  const q = state.q.trim().toLowerCase().replace(/号$/, '');
  if (!q) return true;
  if (/^\d{1,3}$/.test(q)) return Number(q) === Number(c.code); // 「13」「013」「13号」都认
  const hay = [c.code, c.id, c.name, c.nameEn, ...(c.aliases || []), ...(c.tags || [])].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
function applyFilter() {
  let shown = 0;
  const per = { style: 0, inter: 0 };
  for (const card of cards) {
    const on = matches(card.c);
    card.el.hidden = !on;
    if (on) { shown++; per[card.inter ? 'inter' : 'style']++; }
  }
  $('secStyle').hidden = per.style === 0;
  $('secInter').hidden = per.inter === 0;
  $('empty').hidden = shown > 0;
}

// ---------- 卡片 ----------
function makeCard(c) {
  const card = { c, inter: c.kind === 'interaction', look: c.looks.showcase ? 'showcase' : 'default', text: null, inst: null, style: null, visible: false, mounting: false, t0: 0, frame: -1, gen: 0, loop: null, crop: null };
  const poster = el('img', { class: 'poster', alt: '', loading: 'lazy', decoding: 'async' });
  const stage = el('div', { class: 'stage' });
  const frame = el('div', { class: 'frame' }, poster, stage, el('span', { class: 'num', text: c.code }), el('span', { class: `kind ${c.kind}` }));
  const name = el('span', { class: 'name' }); const sub = el('span', { class: 'sub' });
  const sum = el('p', { class: 'sum' });
  const edit = el('textarea', { class: 'edit', rows: '1', spellcheck: 'false' });
  const looks = el('div', { class: 'looks', role: 'group' });
  const copy = el('button', { class: 'copy', type: 'button', html: `${COPY_ICON}<span class="label"></span>` });
  const info = el('div', { class: 'info' }, el('h3', {}, name, sub), sum, edit, el('div', { class: 'row' }, looks, copy));
  card.el = el('article', { class: `card${card.inter ? ' inter' : ''}`, 'data-code': c.code }, frame, info);
  Object.assign(card, { poster, stage, frameEl: frame, nameEl: name, subEl: sub, sumEl: sum, edit, looksEl: looks, copyEl: copy });
  setPoster(card);
  frame.addEventListener('click', () => { edit.focus(); edit.select(); }); // 点画面＝改字
  let timer = 0;
  edit.addEventListener('input', () => {
    autoGrow(edit);
    clearTimeout(timer);
    timer = setTimeout(() => { card.text = edit.value.replace(/\r/g, ''); remount(card); }, 350);
  });
  copy.addEventListener('click', async () => {
    const label = copy.querySelector('.label');
    try { await navigator.clipboard.writeText(invokeText(card)); copy.classList.add('done'); label.textContent = tr().copied; setTimeout(() => { copy.classList.remove('done'); label.textContent = tr().copy; }, 1200); }
    catch { window.prompt(tr().copy, invokeText(card)); }
  });
  return card;
}

function renderCardText(card) {
  const { c } = card; const t = tr();
  const zh = state.lang === 'zh';
  card.nameEl.textContent = zh ? c.name : c.nameEn || c.name;
  card.subEl.textContent = zh ? c.nameEn : c.name;
  card.sumEl.textContent = zh ? c.summary : c.summaryEn || c.summary;
  card.frameEl.querySelector('.kind').textContent = t.kindLabel[c.kind] || c.kind;
  card.edit.placeholder = t.editHint;
  card.edit.title = t.editHint;
  card.copyEl.querySelector('.label').textContent = t.copy;
  card.copyEl.setAttribute('aria-label', t.copy);
  card.copyEl.title = t.copy;
  const roles = [['default', t.daily], ['showcase', t.signature]].filter(([r]) => c.looks[r]);
  card.looksEl.replaceChildren(...roles.map(([r, label]) => el('button', { type: 'button', class: card.look === r ? 'on' : '', text: label, onclick: () => { if (card.look === r) return; card.look = r; renderCardText(card); setPoster(card); remount(card); } })));
}

function setPoster(card) {
  const d = card.c.demo[card.look] || card.c.demo.default || {};
  const p = d.poster && d.poster.exists !== false ? d.poster.path : null;
  if (p) card.poster.src = p; else card.poster.removeAttribute('src');
}

function autoGrow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 96)}px`; }

/** demo 条目里凡是 meta.params 认识的键都当参数（跟 cli/demo.mjs 一样） */
function demoParams(meta, role) {
  const d = (meta.demo || {})[role] || (meta.demo || {}).default || {};
  const keys = new Set((meta.params || []).map((p) => p.key));
  const out = {};
  for (const [k, v] of Object.entries(d)) if (keys.has(k)) out[k] = v;
  return out;
}
function paramsOf(card) {
  const p = demoParams(card.style.meta, card.look);
  if (card.text !== null) p.text = card.text;
  return p;
}

/**
 * 这张卡要的字体：按 fontPlan 每组的字体链。演示子集（只含各张卡开场要画的字，几十 KB）装得下这张卡现在要画的所有字，
 * 就用演示子集；有人改字、改出了演示子集没有的字，这款字体就换成常用字子集（0.8–3 MB，这时才下载）。两份字体名不一样，不会混用。
 */
function fontsFor(meta, params) {
  const P = resolveParams(meta, params);
  const need = new Map();
  for (const g of fontPlan(meta, P, plainText)) {
    for (const id of g.chain) need.set(id, (need.get(id) || '') + g.chars);
  }
  const out = {};
  for (const [id, chars] of need) {
    const f = state.fonts[id];
    if (!f) continue;
    const covered = f.demo && Array.from(chars).every((ch) => /\s/.test(ch) || f.demo.chars.includes(ch));
    out[id] = covered ? { family: f.demo.family, url: f.demo.url } : { family: f.family, url: f.url };
  }
  return out;
}

// ---------- 量画面：这一刻画了哪些东西、占哪一块 ----------
const SHAPES = 'text, path, rect, circle, ellipse, line, polyline, polygon, image, use';
/** 当前这一刻画面里看得见的图形的外框（1080×1920 画面里的像素），什么都没有就返回 null */
function visibleBox(stage) {
  const sr = stage.getBoundingClientRect();
  const k = sr.width / W || 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of stage.querySelectorAll(SHAPES)) {
    if (e.closest('defs, clipPath, mask, pattern, marker, symbol')) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility !== 'visible' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    x0 = Math.min(x0, (r.left - sr.left) / k); y0 = Math.min(y0, (r.top - sr.top) / k);
    x1 = Math.max(x1, (r.right - sr.left) / k); y1 = Math.max(y1, (r.bottom - sr.top) / k);
  }
  if (!Number.isFinite(x0)) return null;
  return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W, x1), y1: Math.min(H, y1) };
}

/** 整条时间轴取样：循环区间（第一次有东西 → 出场开始）和取景框 */
function analyze(card) {
  const { inst, style } = card;
  const tl = inst.timeline;
  const dur = tl.duration;
  const outro = (tl.segments || []).find((s) => s.name === 'outro');
  const hits = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = (i / SAMPLES) * dur;
    inst.seek(t);
    const b = visibleBox(card.stage);
    if (b) hits.push({ t, b });
  }
  let poster = 0;
  try { poster = resolveTime(style.meta.posterTime ?? 'after-intro', tl); } catch { poster = dur * 0.5; }
  if (!hits.length) return { loop: { a: 0, b: dur, poster }, crop: null };
  let a = hits[0].t;
  let b = outro ? Math.min(outro.start, dur) : hits[hits.length - 1].t;
  if (b - a < 0.6) { a = 0; b = dur; } // 太短就整条播
  poster = Math.min(Math.max(poster, a), b);
  // 运动范围：循环区间里所有时刻的外框合起来
  let motion = null;
  for (const h of hits) {
    if (h.t < a - 1e-6 || h.t > b + 1e-6) continue;
    motion = motion ? { x0: Math.min(motion.x0, h.b.x0), y0: Math.min(motion.y0, h.b.y0), x1: Math.max(motion.x1, h.b.x1), y1: Math.max(motion.y1, h.b.y1) } : { ...h.b };
  }
  // 主体：海报帧那一刻的外框（量不到就退回运动范围）
  inst.seek(poster);
  const main = visibleBox(card.stage) || motion;
  return { loop: { a, b, poster }, crop: main && { ...main, motion } };
}

/** 把舞台缩放、平移到卡片里：字效整屏铺满宽度；互动元素按取景框放大，最多 2.6 倍，不露出画面外 */
function placeStage(card) {
  const fw = card.frameEl.clientWidth, fh = card.frameEl.clientHeight;
  if (!fw || !fh) return;
  const fitW = fw / W;
  let k = fitW, tx = 0, ty = 0;
  const manual = card.style?.meta?.gallery?.crop;
  const crop = manual ? { x0: manual[0], y0: manual[1], x1: manual[0] + manual[2], y1: manual[1] + manual[3] } : card.crop;
  if (card.inter && crop) {
    const pad = 0.2;
    const cx = (crop.x0 + crop.x1) / 2, cy = (crop.y0 + crop.y1) / 2;
    const bw = (crop.x1 - crop.x0) * (1 + pad), bh = (crop.y1 - crop.y0) * (1 + pad);
    k = Math.min(fw / Math.max(bw, 1), fh / Math.max(bh, 1), fitW * 2.6);
    // 运动范围压上限：以主体中心为准，运动最远的地方最多出卡片边 15%
    const m = crop.motion;
    if (m) {
      const halfW = Math.max(cx - m.x0, m.x1 - cx), halfH = Math.max(cy - m.y0, m.y1 - cy);
      k = Math.min(k, (fw * 0.5 * 1.15) / Math.max(halfW, 1), (fh * 0.5 * 1.15) / Math.max(halfH, 1));
    }
    k = Math.max(k, fitW); // 至少铺满宽度：画面左右不露出舞台外
    tx = fw / 2 - k * cx; ty = fh / 2 - k * cy;
    tx = Math.min(0, Math.max(fw - k * W, tx)); // 左右夹在舞台范围里
    // 上下不夹：互动元素常放在画面下部，按它居中会露出舞台底边以下，那一块由卡片自己的同色底垫着（见 gallery.css）
  } else if (card.inter) {
    ty = (fh - k * H) / 2; // 还没量出来：先按画面中间取
  }
  card.stage.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${k.toFixed(5)})`;
}

// 挂载排队：一次只挂一张，免得首屏十几张同时解析字体、建 SVG 卡住
let queue = Promise.resolve();

// 宣传片循环动图（2 MB 多）：等首屏的卡挂好、浏览器空下来再下载，不跟首屏抢带宽；窄屏（这一块藏着）和减少动效时不下载
function startHero() {
  const box = $('promo'), img = $('promoImg');
  if (!img || img.src || reduceMotion || getComputedStyle(box).display === 'none') return;
  img.addEventListener('load', () => box.classList.add('loaded'), { once: true });
  img.src = img.dataset.src;
}
window.addEventListener('load', () => {
  // 等首屏看得见的卡都挂好（最多等 5 秒），再等浏览器空下来
  const t0 = performance.now();
  const wait = () => {
    const pending = cards.some((c) => c.visible && !c.inst);
    if (pending && performance.now() - t0 < 5000) { setTimeout(wait, 200); return; }
    queue.then(() => (window.requestIdleCallback || ((f) => setTimeout(f, 800)))(startHero, { timeout: 2500 }));
  };
  setTimeout(wait, 300);
});
function remount(card) {
  const gen = ++card.gen;
  queue = queue.then(() => doMount(card, gen)).catch(() => {});
  return queue;
}
async function doMount(card, gen) {
  if (gen !== card.gen) return; // 排队期间又改了字，只挂最新的
  try {
    // 动态 import 按 host.js 自己的位置解析相对路径，所以先按页面地址算成绝对网址
    if (!card.style) card.style = await loadStyle(new URL(`${card.c.dir}/`, document.baseURI).href);
    const params = paramsOf(card);
    if (card.text === null) { card.edit.value = String(params.text ?? resolveParams(card.style.meta, params).text ?? ''); autoGrow(card.edit); }
    placeStage(card);
    const prev = card.inst;
    // 互动元素是透明底的叠加件：卡片里用透明底挂载，背景由卡片自己的 CSS 画，取景超出舞台也不会有接缝
    const background = card.inter ? 'transparent' : 'studio';
    const inst = await mount(card.stage, { style: card.style, params, width: W, height: H, background, fonts: fontsFor(card.style.meta, params) });
    if (gen !== card.gen) { inst.destroy(); return; }
    if (prev && prev !== inst) try { prev.destroy(); } catch { /* mount 已经清掉了旧的 DOM */ }
    card.inst = inst;
    const { loop, crop } = analyze(card);
    card.loop = loop; card.crop = crop;
    placeStage(card);
    // 第一次从海报帧开始播；改字、换造型以后也从海报帧开始，马上看到结果
    card.t0 = performance.now() - (loop.poster - loop.a) * 1000;
    card.frame = -1;
    inst.seek(loop.poster);
    card.frameEl.classList.add('live');
    card.frameEl.querySelector('.err')?.remove();
  } catch (e) {
    console.warn(card.c.code, e);
    card.frameEl.classList.remove('live');
    card.frameEl.querySelector('.err')?.remove();
    card.frameEl.append(el('div', { class: 'err', text: tr().failed + (e.message || e) }));
  }
}

function observeCards() {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const card = cards.find((c) => c.el === en.target);
      if (!card) continue;
      card.visible = en.isIntersecting;
      if (card.visible && !card.inst && !card.mounting) { card.mounting = true; remount(card); }
    }
  }, { rootMargin: '400px 0px' });
  for (const c of cards) io.observe(c.el);
}

// ---------- 播放：只播看得见的卡，30 帧每秒；只在循环区间里播，到头停一下 ----------
function tick(now) {
  requestAnimationFrame(tick);
  for (const card of cards) {
    if (!card.inst || !card.loop || !card.visible || card.el.hidden) continue;
    const { a, b } = card.loop;
    const len = b - a;
    const u = ((now - card.t0) / 1000) % (len + PAUSE);
    const t = a + Math.min(u, len);
    const f = Math.round(t * FPS);
    if (f === card.frame) continue;
    card.frame = f;
    card.inst.seek(f / FPS);
  }
}

// ---------- 复制调用句：按当前造型和文字填进 invokeTemplate ----------
function invokeText(card) {
  const { c } = card;
  if (!card.style || (card.text === null && card.look === 'default')) return c.invoke;
  const meta = card.style.meta;
  const P = resolveParams(meta, paramsOf(card));
  const look = (meta.looks || []).find((l) => l.id === P.look);
  const values = { ...P, code: c.code, name: c.name, text: plainText(String(P.text ?? '')).replace(/\n/g, '｜'), look: look ? `${look.id} ${look.name}` : P.look, palette: P.palette };
  const tpl = c.invokeTemplate || c.invoke;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (values[k] === undefined || values[k] === null ? '' : String(values[k])));
}

main().catch((e) => {
  console.error(e);
  $('gridStyle').textContent = `画廊没加载起来：${e.message || e}`;
});
