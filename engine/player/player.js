// 试玩台：拖时间轴、改字、换配色/节奏/种子；参数控件全部从 meta.json 生成。
// 这里只是宿主，画面全部由风格的纯函数 seek(t) 决定；播放用的真实时钟只在这个文件里。
import { loadStyle, mount } from '../src/host.js';
import { resolveParams, comboCode, fontPlan } from '../src/lib/params.js';
import { charset } from '../src/lib/text.js';
import { plainText } from '../src/lib/segment.js';
import { loadJiebaBrowser } from '../src/jieba-browser.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_STYLE = 'styles/001-variety-outline';
const qs = new URLSearchParams(location.search);

const state = {
  styleDir: qs.get('style') || DEFAULT_STYLE,
  style: null,
  meta: null,
  overrides: {},
  size: [1080, 1920],
  bg: 'checker',
  t: 0,
  playing: qs.get('autoplay') !== '0',
  inst: null,
  registry: null,
  chars: {},
  mountToken: 0,
  mounting: null,
  cut: null, // 第二层分词（jieba）；用户第一次改字时才加载
  words: [], // 字级时间（导入的 JSON），给要卡字的风格用
  jiebaState: 'idle',
};

function ensureJieba() {
  if (state.jiebaState !== 'idle') return;
  state.jiebaState = 'loading';
  loadJiebaBrowser().then((cut) => { state.cut = cut; state.jiebaState = 'ready'; remount(); },
    (e) => { state.jiebaState = 'failed'; console.warn('jieba 加载失败，继续用浏览器自带分词', e); remount(); });
}

// ---------- 启动 ----------
async function boot() {
  state.registry = await (await fetch('/engine/fonts/registry.json')).json();
  let styles = [];
  try { styles = await (await fetch('/__hanzifx/styles.json')).json(); } catch { /* 静态部署时没有这个接口 */ }
  if (!styles.some((s) => s.dir === state.styleDir)) styles.unshift({ dir: state.styleDir, code: '?', name: state.styleDir });
  const pick = $('stylePick');
  pick.innerHTML = styles.map((s) => `<option value="${s.dir}">${s.code} ${s.name}</option>`).join('');
  pick.value = state.styleDir;
  pick.onchange = () => { location.search = `?style=${encodeURIComponent(pick.value)}`; };
  bindSeg('aspectSeg', (v) => { state.size = v.split('x').map(Number); remount(); });
  bindSeg('bgSeg', (v) => { state.bg = v; remount(); });
  bindTransport();
  await loadCurrentStyle();
  requestAnimationFrame(tick);
}

async function loadCurrentStyle() {
  state.style = await loadStyle('/' + state.styleDir);
  state.meta = state.style.meta;
  $('comboName').textContent = [state.meta.name, state.meta.category || (state.meta.tags || []).join('、'), state.meta.summary].filter(Boolean).join(' · ');
  buildControls();
  await remount();
}

/** 这次要加载的字体：按 fontPlan 分组（主字体一组，meta.paramFonts 指定的文字参数各按自己的字体一组）；
 *  每组的字体用常用字子集；这款字体整个都没有的字，按 meta.fontFallback 找备用字体，
 *  通过本地服务按需做子集（静态部署没有这个接口时，这些字会被标成缺字） */
async function fontsFor() {
  const P = current();
  const out = {}; const fbChars = new Map(); // 备用字体要的字：几组都落到同一款备用字体时合在一起
  for (const g of fontPlan(state.meta, P, plainText)) {
    const head = g.fontId;
    if (!state.registry[head]) continue;
    if (!out[head]) out[head] = { family: state.registry[head].family, url: `/engine/fonts/dist/${head}.common.woff2` };
    const all = await charList(head, 'all');
    let remaining = [...charset(g.chars)].filter((c) => !all.has(c));
    for (const fb of g.chain.slice(1)) {
      if (!remaining.length) break;
      const cover = await charList(fb, 'all');
      const take = remaining.filter((c) => cover.has(c));
      if (take.length) fbChars.set(fb, charset((fbChars.get(fb) || '') + take.join('')));
      remaining = remaining.filter((c) => !cover.has(c));
    }
  }
  for (const [fb, chars] of fbChars) {
    if (out[fb]) continue; // 它本身就是某一组的主字体，已经整份常用字子集加载了
    // 每组字一个独立的字体名，避免同名字体互相顶掉
    const tag = [...chars].map((c) => c.codePointAt(0).toString(36)).join('');
    out[fb] = { family: `${state.registry[fb].family}-${tag}`, url: `/__hanzifx/subset?font=${fb}&text=${encodeURIComponent(chars)}` };
  }
  return out;
}

async function charList(id, kind) {
  const key = `${id}.${kind}`;
  if (!state.chars[key]) {
    const txt = await (await fetch(`/engine/fonts/dist/${id}.${kind}.chars.txt`)).text();
    state.chars[key] = new Set([...txt]);
  }
  return state.chars[key];
}

// ---------- 挂载（参数一变就重建；t 保留） ----------
let remountTimer = null;
function remount() {
  clearTimeout(remountTimer);
  return new Promise((ok) => { remountTimer = setTimeout(() => doRemount().then(ok, ok), 60); });
}

async function doRemount() {
  const token = ++state.mountToken;
  const [W, H] = state.size;
  const stage = $('stage');
  let inst;
  const work = (async () => {
    try {
      inst = await mount(stage, {
        style: state.style, params: state.overrides, width: W, height: H,
        background: state.bg, fonts: await fontsFor(), cut: state.cut, words: state.words,
      });
    } catch (e) {
      showStatus('出错了：' + e.message);
      throw e;
    }
  })();
  state.mounting = work;
  await work;
  if (token !== state.mountToken) return; // 期间又改了参数，以最新那次为准
  state.inst = inst;
  state.t = Math.min(state.t, inst.timeline.duration);
  showStatus('');
  fit();
  drawTimeline();
  try { await renderChecks(); } catch (e) { console.error('检查面板出错', e); showStatus('检查面板出错：' + e.message); }
  updateCombo();
  inst.seek(state.t);
  updateClock();
}

function fit() {
  const [W, H] = state.size;
  const vp = $('viewport').getBoundingClientRect();
  const s = Math.min((vp.width - 24) / W, (vp.height - 24) / H);
  const frame = $('frame');
  frame.style.width = `${W * s}px`;
  frame.style.height = `${H * s}px`;
  $('stage').style.transform = `scale(${s})`;
}
window.addEventListener('resize', fit);

// ---------- 播放 ----------
let last = null;
function tick(now) {
  if (last == null) last = now;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (state.inst && state.playing && !scrubbing) {
    const D = state.inst.timeline.duration;
    state.t += dt;
    if (state.t > D + 0.4) state.t = 0; // 播完停半拍再循环
    state.inst.seek(Math.min(state.t, D));
    updateClock();
  }
  requestAnimationFrame(tick);
}

function setT(t) {
  if (!state.inst) return;
  const D = state.inst.timeline.duration;
  state.t = Math.max(0, Math.min(D, t));
  state.inst.seek(state.t);
  updateClock();
}

function setPlaying(p) {
  state.playing = p;
  $('playBtn').textContent = p ? '❚❚' : '▶';
}

let scrubbing = false;
function bindTransport() {
  setPlaying(state.playing);
  $('playBtn').onclick = () => setPlaying(!state.playing);
  const sc = $('scrub');
  const toT = (ev) => {
    const r = sc.getBoundingClientRect();
    return ((ev.clientX - r.left) / r.width) * (state.inst?.timeline.duration || 0);
  };
  sc.addEventListener('pointerdown', (ev) => {
    scrubbing = true; setPlaying(false); sc.setPointerCapture(ev.pointerId); setT(toT(ev));
  });
  sc.addEventListener('pointermove', (ev) => { if (scrubbing) setT(toT(ev)); });
  const end = () => { scrubbing = false; };
  sc.addEventListener('pointerup', end);
  sc.addEventListener('pointercancel', end);
  const fps = () => state.meta?.fps || 30;
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest('textarea, input, select')) return;
    if (ev.code === 'Space') { ev.preventDefault(); setPlaying(!state.playing); }
    if (ev.code === 'ArrowRight') { setPlaying(false); setT(Math.round(state.t * fps() + 1) / fps()); }
    if (ev.code === 'ArrowLeft') { setPlaying(false); setT(Math.round(state.t * fps() - 1) / fps()); }
    if (ev.code === 'Home') setT(0);
    if (ev.code === 'End') setT(state.inst?.timeline.duration || 0);
  });
}

function updateClock() {
  if (!state.inst) return;
  const D = state.inst.timeline.duration;
  const fps = state.meta.fps || 30;
  const total = Math.ceil(D * fps - 1e-9);
  const frame = Math.min(total, Math.floor(state.t * fps + 1e-9) + 1);
  $('clock').textContent = `${state.t.toFixed(2)} / ${D.toFixed(2)} s · 第 ${frame}/${total} 帧`;
  $('head').style.left = `${(state.t / D) * 100}%`;
  const sc = $('scrub');
  sc.setAttribute('aria-valuemax', D.toFixed(2));
  sc.setAttribute('aria-valuenow', state.t.toFixed(2));
}

function drawTimeline() {
  const tl = state.inst.timeline;
  const D = tl.duration;
  $('bands').innerHTML = tl.segments.map((s) =>
    `<div class="band ${s.name}" style="left:${(s.start / D) * 100}%;width:${((s.end - s.start) / D) * 100}%" title="${s.label} ${s.start.toFixed(2)}–${s.end.toFixed(2)} s"></div>`).join('');
  $('beats').innerHTML = tl.beats.filter((b) => b.name === 'land' || b.name === 'land-all').map((b) =>
    `<div class="beat ${b.name === 'land-all' ? 'all' : ''}" style="left:${(b.t / D) * 100}%" title="${b.label} ${b.t.toFixed(2)} s"></div>`).join('');
  $('legend').innerHTML = tl.segments.map((s) =>
    `<span><i style="background:var(--${s.name})"></i>${s.label} ${s.start.toFixed(2)}–${s.end.toFixed(2)} s</span>`).join('') +
    '<span>白色短线＝每个字落地的节拍（导出时写进 timeline.json）</span>';
}

// ---------- 参数控件（从 meta.json 生成） ----------
function current() { return resolveParams(state.meta, state.overrides); }
function setParam(k, v) {
  if (v === '' || v === null || v === undefined) delete state.overrides[k];
  else state.overrides[k] = v;
  remount();
}

function buildControls() {
  const box = $('controls');
  box.innerHTML = '';
  const P = current();
  for (const def of state.meta.params) {
    const wrap = document.createElement('div');
    wrap.className = 'ctl';
    wrap.dataset.key = def.key;
    const lab = document.createElement('div');
    lab.className = 'lab';
    lab.innerHTML = `<span>${def.label}</span><span class="val"></span>`;
    wrap.appendChild(lab);
    const val = lab.querySelector('.val');
    if (def.type === 'text') {
      const ta = document.createElement('textarea');
      ta.value = P[def.key];
      if (def.maxLength) ta.maxLength = def.maxLength;
      ta.oninput = () => { ensureJieba(); setParam(def.key, ta.value); };
      wrap.appendChild(ta);
      if (def.hint) wrap.insertAdjacentHTML('beforeend', `<div class="hint">${def.hint}</div>`);
    } else if (def.type === 'select') {
      const chips = document.createElement('div');
      chips.className = 'chips';
      const opts = def.options.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
      for (const o of opts) {
        const b = document.createElement('button');
        b.className = 'chip' + (P[def.key] === o.value ? ' on' : '');
        b.dataset.v = o.value;
        let inner = o.label;
        if (def.key === 'palette') {
          const pal = state.meta.palettes.find((p) => p.id === o.value);
          inner = `<span class="sw"><b style="background:${pal.colors.mid}"></b><b style="background:${pal.colors.deep}"></b><b style="background:${pal.colors.outer}"></b></span>${pal.id} ${pal.name}`;
        } else if (def.key === 'rhythm') {
          const r = state.meta.rhythms.find((x) => x.id === o.value);
          inner = `${r.id} ${r.name}`;
        }
        b.innerHTML = inner;
        b.onclick = () => {
          chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
          setParam(def.key, o.value === def.default ? '' : o.value);
          if (def.key === 'palette') refreshColorInputs();
        };
        chips.appendChild(b);
      }
      wrap.appendChild(chips);
    } else if (def.type === 'range') {
      const r = document.createElement('input');
      r.type = 'range'; r.min = def.min; r.max = def.max; r.step = def.step || 0.01;
      // 默认值是空的参数（比如垂直位置）表示「自动」，滑块放中间，读数写「自动」
      r.value = P[def.key] ?? (def.min + def.max) / 2;
      val.textContent = P[def.key] == null ? '自动' : Number(P[def.key]).toFixed(2);
      r.oninput = () => { val.textContent = Number(r.value).toFixed(2); setParam(def.key, Number(r.value)); };
      wrap.appendChild(r);
    } else if (def.type === 'bool') {
      wrap.innerHTML = `<label class="toggle"><input type="checkbox" ${P[def.key] ? 'checked' : ''}> ${def.label}</label>`;
      wrap.querySelector('input').onchange = (e) => setParam(def.key, e.target.checked);
    } else if (def.type === 'number') {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.1'; inp.min = def.min ?? ''; inp.max = def.max ?? '';
      inp.placeholder = '跟节奏走';
      inp.value = state.overrides[def.key] ?? '';
      inp.onchange = () => setParam(def.key, inp.value === '' ? '' : Number(inp.value));
      wrap.appendChild(inp);
    } else if (def.type === 'int') {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<input type="number" step="1" value="${P[def.key]}"><button class="mini">换一个</button>`;
      const inp = row.querySelector('input');
      inp.onchange = () => setParam(def.key, Math.round(Number(inp.value)));
      row.querySelector('button').onclick = () => {
        inp.value = String(1 + Math.floor(Math.random() * 9999)); // 只是界面上换个数，风格本身不碰随机
        setParam(def.key, Number(inp.value));
      };
      wrap.appendChild(row);
    } else if (def.type === 'color') {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<input type="color"><button class="mini">跟配色</button><span class="hint"></span>';
      const inp = row.querySelector('input');
      inp.dataset.overrides = def.overrides;
      inp.dataset.key = def.key;
      inp.oninput = () => setParam(def.key, inp.value.toUpperCase());
      row.querySelector('button').onclick = () => { setParam(def.key, ''); setTimeout(refreshColorInputs, 0); };
      wrap.appendChild(row);
    }
    box.appendChild(wrap);
  }
  refreshColorInputs();
}

function refreshColorInputs() {
  const P = current();
  document.querySelectorAll('input[type=color]').forEach((inp) => {
    const k = inp.dataset.key;
    inp.value = (state.overrides[k] || P._palette.colors[inp.dataset.overrides]).toLowerCase();
    inp.parentElement.querySelector('.hint').textContent = state.overrides[k] ? '已单独改' : `跟 ${P.palette}`;
  });
}

// ---------- 检查结果、编号、命令 ----------
async function renderChecks() {
  const P = state.inst.params;
  const used = charset(plainText(P.text));
  const common = await charList(P.font, 'common');
  const all = await charList(P.font, 'all');
  const chain = state.inst.fontChain;
  const fbChars = [];
  const notInChain = [];
  for (const c of used) {
    if (all.has(c)) continue;
    let hit = null;
    for (const fb of chain.slice(1)) if ((await charList(fb, 'all')).has(c)) { hit = fb; break; }
    if (hit) fbChars.push([c, hit]); else notInChain.push(c);
  }
  const notCommon = [...used].filter((c) => all.has(c) && !common.has(c));
  const L = state.inst.layout;
  const rows = [];
  rows.push(`<div class="t">中文检查</div>`);
  const src = state.inst.segmentation.sources;
  const segName = { author: '你用 | 标的切分', 'jieba+lexicon': 'jieba + 词表', 'icu+lexicon': state.jiebaState === 'loading' ? '浏览器自带分词 + 词表（jieba 加载中）' : '浏览器自带分词 + 词表' };
  rows.push(`<div class="hint">分词：${src.map((x) => segName[x] || x).join('，')}｜${state.inst.segmentation.paragraphs.map((p) => p.words.map((w) => w.text).join('/')).join(' ‖ ')}</div>`);
  rows.push(L.issues.length
    ? `<div class="bad">✗ 断行：${L.issues.map((x) => x.detail).join('；')}</div>`
    : `<div class="ok">✓ 断行在词边上，行首没有标点（${L.lines.map((x) => `「${x}」`).join(' ')}）</div>`);
  for (const w of L.warnings || []) rows.push(`<div class="hint">提示：${w.detail}</div>`);
  if (L.forced.length) rows.push(`<div class="warn">⚠ 词太长被迫拆开：${L.forced.join('、')}</div>`);
  if (notInChain.length) rows.push(`<div class="bad">✗ 缺字：「${notInChain.join('')}」在主字体和备用字体里都没有，导出会报错，换个字或换字体</div>`);
  if (fbChars.length) rows.push(`<div class="warn">⚠ 用了备用字体：「${fbChars.map((x) => x[0]).join('')}」主字体没有，改用${[...new Set(fbChars.map((x) => state.registry[x[1]].name))].join('、')}，看起来会跟别的字不太一样</div>`);
  if (notCommon.length) rows.push(`<div class="warn">⚠ 「${notCommon.join('')}」不在试玩用的常用字库里，这里会显示成别的字体；导出时按实际用字重新做子集，不受影响</div>`);
  if (!notInChain.length && !fbChars.length && !notCommon.length) rows.push('<div class="ok">✓ 不缺字，全部用主字体</div>');
  rows.push('<div class="hint">描边是否被画面边缘切掉，导出时逐帧查（看导出清单 checks.clip）</div>');
  $('checks').innerHTML = rows.join('');
}

function nonDefault() {
  const out = {};
  for (const def of state.meta.params) {
    const v = state.overrides[def.key];
    if (v !== undefined && v !== '' && v !== def.default) out[def.key] = v;
  }
  return out;
}

function exportCommand() {
  const nd = nonDefault();
  const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1').replace(/\n/g, '\\n')}"`;
  const parts = ['npm run export --', `--style ${state.styleDir}`];
  const text = nd.text ?? current().text;
  parts.push(`--text ${q(text)}`);
  for (const k of ['palette', 'rhythm', 'seed', 'entrance', 'font']) if (nd[k] !== undefined) parts.push(`--${k} ${nd[k]}`);
  for (const [k, v] of Object.entries(nd)) {
    if (['text', 'palette', 'rhythm', 'seed', 'entrance', 'font'].includes(k)) continue;
    parts.push(`--set ${k}=${typeof v === 'string' ? q(v) : v}`);
  }
  const [W, H] = state.size;
  parts.push(`--size ${W}x${H}`);
  if (state.bg === 'checker') parts.push('--bg transparent --format mov,webm,png');
  else parts.push(`--bg ${state.bg === 'studio' ? 'studio' : `"${state.bg}"`} --format mp4`);
  return `cd engine && ${parts.join(' ')}`;
}

function updateCombo() {
  $('comboCode').textContent = comboCode(state.meta, current());
  $('cmdPreview').textContent = exportCommand();
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(copy.timer); copy.timer = setTimeout(() => { t.hidden = true; }, 1400);
}
$('copyCmd').onclick = () => copy(exportCommand(), '已复制导出命令');
$('copyParams').onclick = () => copy(JSON.stringify({ style: state.styleDir, combo: comboCode(state.meta, current()), params: nonDefault() }, null, 2), '已复制参数');
$('copySource').onclick = async () => copy(await (await fetch(`/${state.styleDir}/style.js`)).text(), '已复制风格源码');

$('wordsFile').onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    state.words = Array.isArray(j) ? j : j.words || [];
    $('clearWords').hidden = false;
    await remount();
    copyToast(`已导入字级时间：${state.words.length} 项`);
  } catch (e) { showStatus('字级时间读不了：' + e.message); }
  ev.target.value = '';
};
$('clearWords').onclick = async () => { state.words = []; $('clearWords').hidden = true; await remount(); };
function copyToast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(copy.timer); copy.timer = setTimeout(() => { t.hidden = true; }, 1600); }

function showStatus(msg) { const s = $('status'); s.hidden = !msg; s.textContent = msg; }

function bindSeg(id, fn) {
  const seg = $(id);
  seg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); fn(b.dataset.v); };
  });
}

// 给自动化测试用的口子
window.__player = {
  state,
  ready: () => state.mounting,
  setT,
  setPlaying,
  exportCommand,
};

boot().catch((e) => showStatus('启动失败：' + e.message));
