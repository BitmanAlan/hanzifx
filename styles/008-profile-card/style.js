// 008 账号名片卡（Profile Card）· 互动元素
// 片尾的账号名片：圆头像跨在卡片左边缘上，卡片里是账号名、一句简介和「关注」按钮；手指一点，按钮翻一下变成「已关注」并打勾。
// 也能只要头像加关注按钮（layout=compact）。默认透明底。
// 参数（见 meta.json）：text 账号名、bio 简介（*词* 标成关键词）、avatar 头像上的字（空着用账号名第一个字）、layout、
//   followText、followedText、look、palette、rhythm、font、hand、card、size、flair、particles、material、x、y、seed。
// 质感：material=flat 平面是原来的画法，一个元素、一个属性都没改；默认 candy 亮面糖果，卡片、头像、关注按钮换成底座的共用零件
//   （底座块、圆按钮、方键帽），有厚度、白亮边、镜面高光，手按下去按钮往下陷，变成已关注时弹一下、扫过一道高光。
// 规矩：seek(t) 是纯函数，每个属性每次都重新设；随机全走 hash01(seed, …)；透明度只设在单个图形上；不用模糊滤镜；
//   整张卡的滑动、倾斜、缩放写进每个图形自己的 transform，不挪整组；版式自己设计，不照任何平台个人页的样子做。
import { hash01 } from '../../engine/src/lib/rand.js';
import { clamp, lerp, spring, easeOutCubic, easeInCubic, easeOutBack, easeInOutCubic } from '../../engine/src/lib/ease.js';
import { graphemes, checkLineBreaks, icuBreakWarnings, FULLWIDTH_PUNCT } from '../../engine/src/lib/text.js';
import { f3, shineSweep } from '../../engine/src/motions/index.js';
import { createParts, SWEEP_WIDTH } from '../../engine/src/parts/index.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? f3(v) : String(v)); };
const vis = (e, on) => e.setAttribute('visibility', on ? 'visible' : 'hidden');
function mix(a, b, t) {
  const p = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const A = p(a); const B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// 手：食指朝上的简笔画，指尖在 (44,6)；跟 006、015 同一套画法
const HAND = 'M36 13 C36 4.5 52 4.5 52 13 L52 44 C54.5 39.5 62.5 39.5 64 45.5 C66 40.5 74.5 41 75.5 47.5 C77.5 43.5 85 45 85 51.5 L85 70 C85 84.5 74.5 94.5 60 94.5 L50.5 94.5 C40.5 94.5 33.5 88.5 30 80 L21.5 62 C19.5 56.5 25.5 52.5 30.5 57 L36 63.5 Z';
const HAND_TIP = { x: 44, y: 6 };
// 没有名字也没填头像字时，头像里画一个简笔人像（100 格，中心 50,50）
const PERSON = 'M50 22 C60 22 67 30 67 40 C67 50 60 58 50 58 C40 58 33 50 33 40 C33 30 40 22 50 22 Z M22 84 C24 70 35 62 50 62 C65 62 76 70 78 84 Z';
/** 把 100 格的路径（只有 M、L、C、Z 和绝对坐标）直接换算到画面坐标：中心放到 (cx, cy)、一格 s 像素。
 *  糖果零件每帧会改写里面每个图形自己的 transform，所以图形本身不能再带 transform */
function placePath(d, cx, cy, s) {
  let i = 0;
  return d.replace(/-?\d+(\.\d+)?/g, (n) => f3(i++ % 2 === 0 ? cx + (Number(n) - 50) * s : cy + (Number(n) - 50) * s));
}

const OPEN_P = new Set([...'（《「『【〔〈〖“‘']);
const CLOSE_P = new Set([...'，。、；：）》」』】〕〉〗”’']);
/** 要读的字只在三处挤（模板第 6 节）：行尾的收尾标点、行首的开引号开括号、两个标点连用。问号感叹号、句中单个的逗号句号都不挤 */
function squeezeAt(gs, i) {
  const ch = gs[i];
  if (CLOSE_P.has(ch)) return i === gs.length - 1 || FULLWIDTH_PUNCT.has(gs[i + 1]);
  if (OPEN_P.has(ch)) return i === 0 || FULLWIDTH_PUNCT.has(gs[i - 1]);
  return false;
}
/** 简介里的「*词*」标成关键词：去掉星号，记下哪些字是关键词 */
function parseMarks(s) {
  const out = []; let on = false;
  for (const ch of graphemes(s)) { if (ch === '*') { on = !on; continue; } out.push({ ch, emph: on }); }
  return out;
}

export function create(root, ctx) {
  const { params: P, width: W, height: H } = ctx;
  const K = P._palette.colors;
  const R = P._rhythm;
  const seed = P.seed;
  const short = Math.min(W, H);
  const vertical = H > W;
  const flair = clamp(P.flair ?? 0);
  const k = R.speed ?? 1;
  const h = (...a) => hash01(seed, ...a);
  const compact = P.layout === 'compact';
  const hasCard = P.card !== false && P.palette !== 'C3';
  const candy = P.material === 'candy';
  const kuaile = P.font === 'kuaile';
  const famName = ctx.fontFamily(kuaile ? 'kuaile' : 'notosc-black');
  const famBody = ctx.fontFamily(kuaile ? 'kuaile' : 'notosc-bold');
  const name = String(ctx.text || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const bioMarks = compact ? [] : parseMarks(String(P.bio ?? '').replace(/\s+/g, ' ').trim());
  // 头像字、按钮上的字去掉空白：底座做字体子集时不收空白，一个文字节点里夹着空格会回退到系统字体
  const noSpace = (v) => String(v ?? '').replace(/\s+/g, '');
  const avatarStr = noSpace(P.avatar) ? graphemes(noSpace(P.avatar)).slice(0, 2).join('') : graphemes(noSpace(name)).slice(0, 1).join('');
  const followText = noSpace(P.followText ?? '关注') || '关注';
  const followedText = noSpace(P.followedText ?? '已关注') || '已关注';
  const tint = mix(K.accent, '#FFFFFF', 0.45);

  // ---------- 量字：要挤的标点（见 squeezeAt）按墨迹挤窄，用画布量出墨迹位置，不按固定量挪 ----------
  const cv = document.createElement('canvas').getContext('2d');
  const measurer = (fam) => (ch, sq) => {
    cv.font = `100px ${fam}`; cv.textAlign = 'center';
    const mm = cv.measureText(ch);
    if (sq) { const L = -mm.actualBoundingBoxLeft / 100; const Rr = mm.actualBoundingBoxRight / 100; return { adv: Math.max(0.5, Rr - L + 0.16), off: 0.08 - L }; }
    return { adv: mm.width / 100, off: mm.width / 200 };
  };
  const wordEm = (fam, str) => { cv.font = `100px ${fam}`; return cv.measureText(str).width / 100; };
  const measName = measurer(famName); const measBody = measurer(famBody);
  const nameGs = graphemes(name);
  const nameChars = compact ? [] : nameGs.map((ch, i) => ({ ch, ...measName(ch, squeezeAt(nameGs, i)) }));
  const bioGs = bioMarks.map((c) => c.ch);
  const bioChars = bioMarks.map((c, i) => ({ ch: c.ch, emph: c.emph, ...measBody(c.ch, squeezeAt(bioGs, i)) }));
  const nameEm = nameChars.reduce((s, c) => s + c.adv, 0);
  const bioEm = bioChars.reduce((s, c) => s + c.adv, 0);

  // ---------- 版式 ----------
  // 圆头像跨在卡片左边缘上（头像中心＝卡片左边），卡片往右伸；里面左边是名字和简介，右边是关注按钮。
  // 尺寸全按「卡片宽度 cw」算：头像直径 0.24cw，卡片高 0.84 个头像。头像外圈（V3 是转动的光环）比头像多出去 decoF 个头像直径。
  // 按钮放在名字那一行的右边，简介在下面占满卡片宽度：简介要读得清，至少是名字的 0.6 倍大
  const m = 0.05 * short; // 离画面边缘至少留这么多
  const decoF = flair > 0 ? 0.16 : 0.1;
  let cw = clamp(P.size ?? 0.84, 0.5, 0.92) * short;
  cw = Math.min(cw, (W - 2 * m) / (1 + 0.24 * decoF + 0.05 * flair));
  const A = 0.24 * cw; const cardH = 0.84 * A;
  const btnH = 0.4 * cardH; const btnFs = 0.44 * btnH;
  const iconW = 0.42 * btnH; const iconGap = 0.16 * btnH; const btnPadX = 0.42 * btnH;
  const txtWA = wordEm(famBody, followText) * btnFs; const txtWB = wordEm(famBody, followedText) * btnFs;
  const btnW = 2 * btnPadX + iconW + iconGap + Math.max(txtWA, txtWB);
  const pad = 0.17 * cardH;
  const totalW = compact ? A + 0.1 * A + btnW + pad : cw; // 从头像左边到卡片右边
  const extra = 0.05 * flair * totalW; // V3 弹进来时会放大一点，两边多留这么多
  const cx = (P.x ?? 0.5) * W;
  const x0 = clamp(cx - totalW / 2, m + decoF * A + extra, W - m - totalW - extra); // 头像左边
  const ax = x0 + A / 2;
  const cy = clamp((P.y ?? (vertical ? 0.66 : 0.7)) * H, m + A * (0.5 + decoF) + extra, H - m - A * (0.5 + decoF) - extra);
  const cardX = ax; const cardW = x0 + totalW - ax;
  const hasBio = bioChars.length > 0;
  const nameY = hasBio ? cy - 0.17 * cardH : cy;
  const bioY = cy + 0.22 * cardH;
  const bx = x0 + totalW - pad - btnW / 2; const by = hasBio ? nameY : cy; // 按钮中心：有简介时跟名字一行
  const tx0 = ax + A / 2 + 0.05 * cw; // 名字、简介的左边
  const colW = Math.max(1, bx - btnW / 2 - 0.04 * cw - tx0); // 名字那一行，右边让给按钮
  const bioW = Math.max(1, x0 + totalW - pad - tx0); // 简介那一行占满
  const nameFs = nameEm > 0 ? Math.min(0.34 * cardH, colW / nameEm) : 0.34 * cardH;
  const bioFs = bioEm > 0 ? Math.min(0.21 * cardH, bioW / bioEm) : 0.21 * cardH;
  { let acc = 0; for (const c of nameChars) { c.x = tx0 + (acc + c.off) * nameFs; acc += c.adv; } }
  { let acc = 0; for (const c of bioChars) { c.x = tx0 + (acc + c.off) * bioFs; acc += c.adv; } }
  const nameW = nameEm * nameFs;
  const gc = { x: x0 + totalW / 2, y: cy }; // 整张卡的中心：滑动、倾斜、缩放都绕它
  const handH = 1.05 * cardH; const handS = handH / 100;

  // ---------- 时间轴 ----------
  const tAv = 0.08 * k; const tRing = 0.18 * k; const tName = 0.22 * k; const tBtn = 0.3 * k;
  const tMark = tName + nameChars.length * 0.035 * k + 0.12 * k;
  const tBio = 0.36 * k;
  const tHandIn = 0.6 * k; const tPress = 0.95 * k; const tFollow = tPress + 0.1 * k; const tHandOut = tFollow + 0.25 * k;
  const holdEnd = tFollow + 1.6 + (R.holdExtra ?? 0);
  const outDur = 0.35;
  const outroEnd = holdEnd + outDur;
  const duration = outroEnd + 0.1;
  const timeline = {
    duration,
    segments: [
      { name: 'intro', label: '滑进来', start: 0, end: tHandIn },
      { name: 'follow', label: '点关注', start: tHandIn, end: tFollow + 0.3 },
      { name: 'hold', label: '停留', start: tFollow + 0.3, end: holdEnd },
      { name: 'outro', label: '出场', start: holdEnd, end: outroEnd },
    ],
    beats: [{ t: tPress, name: 'press', label: '按下' }, { t: tFollow, name: 'follow', label: '变成已关注' }],
    units: [
      ...nameChars.map((c, i) => ({ i, char: c.ch, enter: tName + i * 0.035 * k, exitStart: holdEnd, exitEnd: outroEnd })),
      ...bioChars.map((c, i) => ({ i: nameChars.length + i, char: c.ch, enter: tBio + i * 0.025 * k, exitStart: holdEnd, exitEnd: outroEnd })),
    ],
  };

  // ---------- 搭 SVG ----------
  // 五层：最下面是 V3 光环和粒子、彩纸（从卡片后面迸出来，不压字）；然后是卡片底；荧光划线；名字、简介、头像、按钮；手在最上面。
  // 这几个 <g> 只当容器，不加透明度也不加变换
  const svg = el('svg', { xmlns: SVGNS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  root.appendChild(svg);
  const back = el('g', {}, svg); const cardL = el('g', {}, svg); const markL = el('g', {}, svg); const content = el('g', {}, svg); const front = el('g', {}, svg);
  const halo = flair > 0 ? el('circle', { cx: 0, cy: 0, r: f3(0.63 * A), fill: 'none', stroke: K.accent, 'stroke-width': f3(0.024 * A), 'stroke-linecap': 'round', 'stroke-dasharray': `${f3(0.1 * A)} ${f3(0.08 * A)}` }, back) : null;
  // 粒子（V1 小圆点；V3 多一半是彩纸片，往下掉）
  const nP = Math.round(P.particles ?? 8);
  const colors = [K.accent, tint, K.accent, K.sub, K.inner];
  const parts = [...Array(nP).keys()].map((i) => {
    const ang = -Math.PI / 2 + (h('pa', i) - 0.5) * Math.PI * 1.35;
    const paper = flair > 0 && h('pp', i) < 0.65;
    const sz = lerp(0.7, 1.3, h('ps', i)) * (paper ? 0.14 : 0.1) * btnH;
    const fall = paper ? flair * lerp(0.4, 0.8, h('pf', i)) * cardH : 0;
    // 最远飞到哪：不出画面（留边距和粒子自身大小），往下掉的那段也算进去
    const margin = m + 2.5 * sz;
    const dx = Math.cos(ang); const dy = Math.sin(ang);
    const roomX = dx > 1e-6 ? (W - margin - bx) / dx : dx < -1e-6 ? (margin - bx) / dx : Infinity;
    const roomY = dy < -1e-6 ? (margin - by) / dy : dy > 1e-6 ? (H - margin - by - fall) / dy : Infinity;
    const dist = Math.max(0.2 * cardH, Math.min(lerp(0.75, 1.35, h('pd', i)) * cardH * (1 + 0.4 * flair), roomX, roomY));
    const fill = colors[Math.floor(h('pc', i) * colors.length) % colors.length];
    const e = paper
      ? el('rect', { x: f3(-sz * 1.1), y: f3(-sz * 0.55), width: f3(sz * 2.2), height: f3(sz * 1.1), rx: f3(sz * 0.2), fill }, back)
      : el('circle', { cx: 0, cy: 0, r: f3(sz), fill }, back);
    return { e, dx, dy, dist, fall, paper, at: tFollow + h('pt', i) * 0.05, spin: (h('pr', i) - 0.5) * 720, life: paper ? 1.0 : 0.7 };
  });
  // 卡片底和硬投影（不模糊）
  const shadow = candy ? null : el('rect', { x: 0, y: f3(-cardH / 2), width: f3(cardW), height: f3(cardH), rx: f3(compact ? cardH / 2 : 0.3 * cardH), fill: K.shadow }, cardL);
  // 深色卡片叠在深色画面上看不清边，给它一圈细灰边
  const lum = (hex) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const edge = lum(K.bg) < 0.3 ? { stroke: K.fill2, 'stroke-width': f3(0.012 * cardH), 'stroke-opacity': 0.8 } : {};
  const card = candy ? null : el('rect', { x: 0, y: f3(-cardH / 2), width: f3(cardW), height: f3(cardH), rx: f3(compact ? cardH / 2 : 0.3 * cardH), fill: K.bg, ...edge }, cardL);
  // 糖果：卡片换成底座块（有厚度、白亮边；V3 会晃，影子用往右下错开的投影）。卡片层、内容层各用一套零件，id 前缀分开
  const uid = ctx.uid || 'pc' + Math.floor(h('uid', W, H) * 1e9).toString(36);
  const kitCard = candy ? createParts(svg, { uid: `${uid}-pc`, material: 'candy', parent: cardL }) : null;
  const kitTop = candy ? createParts(svg, { uid: `${uid}-pk`, material: 'candy', parent: content }) : null;
  const slabCard = kitCard && hasCard
    ? kitCard.slab({ x: cardX, y: cy - cardH / 2, w: cardW, h: cardH, radius: compact ? cardH / 2 : 0.3 * cardH, color: K.bg, depth: 0.14 * cardH,
      ...(lum(K.bg) < 0.3 ? { edge: K.fill2, edgeWidth: 0.012 * cardH } : {}), shadowStyle: flair > 0 ? 'drop' : 'soft', shadowOffset: [0.03 * cardH, 0.02 * cardH] })
    : null;
  // 名字下面的荧光划线：名字是这张卡的关键词
  const mark = nameChars.length ? el('rect', { x: 0, y: 0, width: f3(nameW + 0.08 * nameFs), height: f3(0.36 * nameFs), rx: f3(0.12 * nameFs), fill: K.accent }, markL) : null;
  // 简介、名字
  const textStroke = (fs, f) => (hasCard ? {} : { stroke: K.outer, 'stroke-width': f3(f * fs), 'stroke-linejoin': 'round', 'paint-order': 'stroke' });
  for (const c of bioChars) {
    c.t = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famBody, 'font-size': f3(bioFs), fill: c.emph ? K.accent : K.sub, ...textStroke(bioFs, 0.18) }, content);
    c.t.textContent = c.ch;
  }
  for (const c of nameChars) {
    c.t = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famName, 'font-size': f3(nameFs), fill: K.fill, ...textStroke(nameFs, 0.14) }, content);
    c.t.textContent = c.ch;
  }
  // 头像：外圈一笔画上，圆里是名字第一个字（或者 avatar 填的字）
  const ringR = 0.56 * A; const ringC = 2 * Math.PI * ringR;
  const ring = el('circle', { cx: 0, cy: 0, r: f3(ringR), fill: 'none', stroke: K.accent, 'stroke-width': f3(0.045 * A), 'stroke-linecap': 'round', 'stroke-dasharray': `${f3(ringC)} ${f3(ringC)}` }, content);
  const disc = candy ? null : el('circle', { cx: 0, cy: 0, r: f3(A / 2), fill: K.accent, stroke: hasCard ? K.bg : K.outer, 'stroke-width': f3(0.06 * A) }, content);
  let avText = null; let avIcon = null; let avKey = null;
  let avBack = null;
  if (candy) {
    // 糖果：头像是一颗圆按钮（不按，也不发光），字或简笔人像画在顶面上。
    // 底下垫一圈卡片色（没有卡片时用 outer）：头像左半边伸出卡片，不垫的话头像和外圈之间会露出一道画面底色（平面画法靠头像的描边填上）
    avBack = el('circle', { cx: 0, cy: 0, r: f3(0.545 * A), fill: hasCard ? K.bg : K.outer }, content);
    avKey = kitTop.key({ shape: 'circle', cx: ax, cy, r: A / 2, color: K.accent, depth: 0.07 * A, glow: false,
      draw: (par, { cx: X, cy: Y }) => {
        if (avatarStr) {
          const t = el('text', { x: f3(X), y: f3(Y), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famName, 'font-size': f3((graphemes(avatarStr).length > 1 ? 0.36 : 0.5) * A), fill: K.inner }, par);
          t.textContent = avatarStr;
          return [t];
        }
        return [el('path', { d: placePath(PERSON, X, Y, (0.62 * A) / 100), fill: K.inner }, par)];
      } });
  } else if (avatarStr) {
    avText = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famName, 'font-size': f3((graphemes(avatarStr).length > 1 ? 0.36 : 0.5) * A), fill: K.inner }, content);
    avText.textContent = avatarStr;
  } else {
    const g = el('g', {}, content);
    const inner = el('g', { transform: `scale(${f3((0.62 * A) / 100)}) translate(-50,-50)` }, g);
    avIcon = { g, path: el('path', { d: PERSON, fill: K.inner }, inner) };
  }
  // 关注按钮：圆角条，里面是「＋ 关注」，点了以后变成「✓ 已关注」。加号和勾都是自己画的线，不用字
  const btn = candy ? null : el('rect', { x: f3(-btnW / 2), y: f3(-btnH / 2), width: f3(btnW), height: f3(btnH), rx: f3(btnH / 2) }, content);
  const sIcon = 0.5 * iconW;
  const plus = candy ? null : el('path', { d: `M${f3(-sIcon * 0.8)} 0 L${f3(sIcon * 0.8)} 0 M0 ${f3(-sIcon * 0.8)} L0 ${f3(sIcon * 0.8)}`, fill: 'none', stroke: K.inner, 'stroke-width': f3(0.12 * btnH), 'stroke-linecap': 'round' }, content);
  const sC = 0.85 * iconW; // 勾比加号大一点、线细一点，不然小字号下会糊成一团
  const checkLen = 1.3029 * sC;
  const check = candy ? null : el('path', { d: `M${f3(-0.42 * sC)} ${f3(0.02 * sC)} L${f3(-0.1 * sC)} ${f3(0.34 * sC)} L${f3(0.46 * sC)} ${f3(-0.3 * sC)}`, fill: 'none', stroke: K.fill2, 'stroke-width': f3(0.09 * btnH), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': `${f3(checkLen)} ${f3(checkLen)}` }, content);
  const txtA = candy ? null : el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famBody, 'font-size': f3(btnFs), fill: K.inner }, content);
  if (txtA) txtA.textContent = followText;
  const txtB = candy ? null : el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famBody, 'font-size': f3(btnFs), fill: K.fill2 }, content);
  if (txtB) txtB.textContent = followedText;
  const lay = (tw) => { const w = iconW + iconGap + tw; return { icon: -w / 2 + iconW / 2, text: -w / 2 + iconW + iconGap + tw / 2 }; };
  const layA = lay(txtWA); const layB = lay(txtWB);
  // 糖果：「＋关注」和「✓已关注」是两颗键帽，同一个位置。关注前是强调色；变成已关注时换成压暗的灰键帽，字和勾用 sub 色。
  // 加号、勾、字都直接画在画面坐标上（零件每帧改写它们的 transform），勾的描线动画只改 dasharray、dashoffset
  let keyA = null; let keyB = null; let checkC = null;
  if (candy) {
    const offColor = hasCard ? mix(K.bg, K.fill2, lum(K.bg) > 0.5 ? 0.22 : 0.35) : mix('#000000', K.fill2, 0.4);
    const label = (par, dx, str, fill) => { const t = el('text', { x: f3(bx + dx), y: f3(by), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': famBody, 'font-size': f3(btnFs), fill }, par); t.textContent = str; return t; };
    keyA = kitTop.key({ cx: bx, cy: by, w: btnW, h: btnH, radius: btnH / 2, color: K.accent,
      draw: (par) => {
        const x = bx + layA.icon; const a = sIcon * 0.8;
        const pl = el('path', { d: `M${f3(x - a)} ${f3(by)} L${f3(x + a)} ${f3(by)} M${f3(x)} ${f3(by - a)} L${f3(x)} ${f3(by + a)}`, fill: 'none', stroke: K.inner, 'stroke-width': f3(0.12 * btnH), 'stroke-linecap': 'round' }, par);
        return [pl, label(par, layA.text, followText, K.inner)];
      } });
    keyB = kitTop.key({ cx: bx, cy: by, w: btnW, h: btnH, radius: btnH / 2, color: offColor,
      draw: (par) => {
        const x = bx + layB.icon;
        checkC = el('path', { d: `M${f3(x - 0.42 * sC)} ${f3(by + 0.02 * sC)} L${f3(x - 0.1 * sC)} ${f3(by + 0.34 * sC)} L${f3(x + 0.46 * sC)} ${f3(by - 0.3 * sC)}`, fill: 'none', stroke: K.sub, 'stroke-width': f3(0.09 * btnH), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': `${f3(checkLen)} ${f3(checkLen)}` }, par);
        return [checkC, label(par, layB.text, followedText, K.sub)];
      } });
  }
  // 手
  const handG = P.hand !== false ? el('g', {}, front) : null;
  let handPath = null;
  if (handG) {
    const inner = el('g', { transform: `scale(${f3(handS)}) translate(${-HAND_TIP.x},${-HAND_TIP.y})` }, handG);
    handPath = el('path', { d: HAND, fill: '#FFFFFF', stroke: '#1E1E1E', 'stroke-width': 5.5, 'stroke-linejoin': 'round' }, inner);
  }
  const tiltSign = h('tilt') < 0.5 ? -1 : 1;

  // ---------- 每一帧 ----------
  function seek(time) {
    const t = clamp(time, 0, duration);
    // 整张卡：从下面滑进来；V3 弹进来时放大一点、歪一下再摆正；出场缩小、往下落
    // 「几乎没动」的帧（整张卡只挪零点几个像素、只歪零点零几度）直接当成没动：开发时出场第一帧整张卡只往下挪了 0.007 像素，
    // 头像外圈的边缘抗锯齿时有两种画法，乱序和顺序渲染对不上；V3 卡片还剩 0.056 度倾斜的那一帧，卡片右端的边也对不上过。
    // 所以进场的尾巴、出场的开头都留一小段死区，之后连续接上；整张卡的倾斜、弹性放大，按最远那条边挪多少像素来定门槛
    const dead = (q) => clamp((q - 0.01) / 0.99);
    const inP = 1 - dead(1 - easeOutCubic(clamp(t / (0.4 * k))));
    const pop = flair > 0 ? spring(t, { freq: 2.2 / k, damping: 0.42 }) : inP;
    const qOut = dead(easeInCubic(clamp((t - holdEnd) / outDur)));
    const outS = Math.max(1 - qOut, 0.001);
    const popS = Math.abs(1 - pop) < 0.02 ? 1 : pop; // 放大偏差不到 0.3%，当成没动
    const sc = Math.max(lerp(0.85, 1, flair > 0 ? popS : inP) * outS, 0.001);
    const slide = (1 - inP) * 0.1 * short + qOut * 0.06 * short;
    const tilt0 = tiltSign * 7 * flair * Math.exp((-t * 5) / k) * Math.cos((t * 13) / k);
    const tilt = Math.abs(tilt0) < 0.3 ? 0 : tilt0; // 0.3 度以下归零：这时卡片两端也就差两个像素左右，看不出跳变
    const op = clamp(t / (0.15 * k)) * (1 - qOut);
    const on = op > 0.002;
    const G = `translate(${f3(gc.x)},${f3(gc.y + slide)}) rotate(${f3(tilt)}) scale(${f3(sc)}) translate(${f3(-gc.x)},${f3(-gc.y)})`;
    const followed = t >= tFollow;
    const fu = t - tFollow;

    // 卡片底
    if (!candy) {
      vis(card, on && hasCard); vis(shadow, on && hasCard);
      set(card, { transform: `${G} translate(${f3(cardX)},${f3(cy)})`, opacity: f3(op) });
      set(shadow, { transform: `${G} translate(${f3(cardX)},${f3(cy + 0.06 * cardH)})`, opacity: f3(0.22 * op) });
    } else if (slabCard) slabCard.set({ visible: on, transform: G, opacity: op });
    // 荧光划线：名字落定以后从左往右一笔
    if (mark) {
      const p = easeOutCubic(clamp((t - tMark) / (0.3 * k)));
      vis(mark, on && p > 0.002);
      set(mark, { transform: `${G} translate(${f3(tx0 - 0.04 * nameFs)},${f3(nameY + 0.06 * nameFs)}) scale(${f3(Math.max(p, 0.001))},1)`, opacity: f3((hasCard ? 0.3 + 0.12 * flair : 0.55) * op) });
    }
    // 名字：逐字跳进来，带一点随机歪斜，落定；变成已关注时依次跳一下
    for (const [i, c] of nameChars.entries()) {
      const u = (t - (tName + i * 0.035 * k)) / (0.26 * k);
      const cOn = on && u > 0;
      vis(c.t, cOn);
      if (!cOn) continue;
      const e = easeOutCubic(clamp(u));
      const s = lerp(0.4, 1, easeOutBack(clamp(u)));
      const rise = (1 - e) * 0.35 * nameFs;
      const rot = (1 - e) * (h('nr', i) - 0.5) * 26 * (1 + flair);
      const hop = followed ? Math.max(0, Math.sin(Math.PI * clamp((fu - i * 0.03) / 0.3))) * (0.12 + 0.08 * flair) * nameFs : 0;
      set(c.t, { transform: `${G} translate(${f3(c.x)},${f3(nameY + rise - hop)}) rotate(${f3(rot)}) scale(${f3(Math.max(s, 0.001))})`, opacity: f3(clamp(u * 3) * op) });
    }
    // 简介：逐字打出来；关键词弹一下
    for (const [i, c] of bioChars.entries()) {
      const u = (t - (tBio + i * 0.025 * k)) / (0.14 * k);
      const cOn = on && u > 0;
      vis(c.t, cOn);
      if (!cOn) continue;
      const e = easeOutCubic(clamp(u));
      const s = c.emph ? 1 + 0.25 * Math.max(0, Math.sin(Math.PI * clamp(u / 2))) : 1;
      set(c.t, { transform: `${G} translate(${f3(c.x - (1 - e) * 0.2 * bioFs)},${f3(bioY)}) scale(${f3(s)})`, opacity: f3(clamp(u) * op) });
    }
    // 头像：弹出来，外圈一笔画上；变成已关注时再弹一下
    const au = (t - tAv) / (0.35 * k);
    const aOn = on && au > 0;
    let as = easeOutBack(clamp(au));
    if (followed) { const wob = (0.08 + 0.06 * flair) * Math.exp(-fu * 6) * Math.sin(fu * 18); if (Math.abs(wob) > 0.006) as *= 1 + wob; }
    const AT = `${G} translate(${f3(ax)},${f3(cy)}) scale(${f3(Math.max(as, 0.001))})`;
    if (!candy) {
      vis(disc, aOn);
      set(disc, { transform: AT, opacity: f3(op) });
    } else {
      vis(avBack, aOn); set(avBack, { transform: AT, opacity: f3(op) });
      avKey.set({ visible: aOn, transform: `${AT} translate(${f3(-ax)},${f3(-cy)})`, opacity: op });
    }
    if (avText) { vis(avText, aOn); set(avText, { transform: AT, opacity: f3(op) }); }
    if (avIcon) { vis(avIcon.g, aOn); set(avIcon.g, { transform: AT }); avIcon.path.setAttribute('opacity', f3(op)); }
    const rp = easeOutCubic(clamp((t - tRing) / (0.4 * k)));
    vis(ring, aOn && rp > 0.002);
    // 画完以后去掉虚线，变回普通圆环：虚线挂着时，Chrome 偶尔把边缘抗锯齿画得不一样，乱序和顺序渲染会对不上一两个像素
    set(ring, { transform: `${G} translate(${f3(ax)},${f3(cy)}) rotate(-90)`, 'stroke-dasharray': rp >= 1 ? 'none' : `${f3(ringC)} ${f3(ringC)}`, 'stroke-dashoffset': f3(rp >= 1 ? 0 : ringC * (1 - rp)), opacity: f3(op) });
    if (halo) {
      const hp = clamp((t - tRing) / 0.3);
      vis(halo, on && hp > 0.002);
      set(halo, { transform: `${G} translate(${f3(ax)},${f3(cy)}) rotate(${f3(-90 + 55 * t)}) scale(${f3(lerp(0.85, 1, easeOutCubic(hp)))})`, opacity: f3(0.85 * flair * hp * op) });
    }
    // 按钮：弹出来；按下压扁一点；翻一下（上下压成一条线再弹开）变成已关注
    const bu = (t - tBtn) / (0.3 * k);
    const bOn = on && bu > 0;
    let bs = easeOutBack(clamp(bu));
    if (t >= tPress && t < tFollow) bs *= 1 - 0.08 * easeOutCubic(clamp((t - tPress) / 0.06));
    const flipStart = tFollow - 0.07;
    const sy = t < flipStart ? 1 : t < tFollow ? 1 - (t - flipStart) / 0.07 : easeOutBack(clamp(fu / 0.22));
    if (candy) {
      // 糖果：不压扁也不翻面（键帽上的字只能等比缩放）。手按下去键帽往下陷；到点换成已关注的键帽，从按下的状态弹起来、轻轻放大一下，扫过一道高光。
      // 「＋关注」快落定时扫一道高光，提醒这里能点；赶在手按下去之前扫完（不然高光把按钮上的字冲淡）
      const bsC = Math.max(easeOutBack(clamp(bu)), 0.001);
      const KT = (sc) => `${G} translate(${f3(bx)},${f3(by)}) scale(${f3(Math.max(sc, 0.001))}) translate(${f3(-bx)},${f3(-by)})`;
      const pressA = t >= tPress ? easeOutCubic(clamp((t - tPress) / 0.06)) : 0;
      keyA.set({ visible: bOn && !followed, transform: KT(bsC), opacity: op, press: pressA,
        sweep: shineSweep(t, { start: tBtn + 0.2 * k, duration: 0.42 * k, width: SWEEP_WIDTH, ease: easeInOutCubic }) });
      const popB = followed ? 1 + (0.1 + 0.05 * flair) * Math.sin(Math.PI * clamp(fu / 0.3)) : 1;
      const popBs = Math.abs(popB - 1) < 0.003 ? 1 : popB; // 放大偏差不到 0.3%，当成没动
      keyB.set({ visible: bOn && followed, transform: KT(bsC * popBs), opacity: op, press: followed ? 1 - easeOutCubic(clamp(fu / 0.18)) : 0,
        sweep: shineSweep(t, { start: tFollow + 0.14, duration: 0.6, width: SWEEP_WIDTH, ease: easeInOutCubic }) });
      if (followed) {
        const cp = easeOutCubic(clamp((fu - 0.05) / 0.25));
        set(checkC, { 'stroke-dasharray': cp >= 1 ? 'none' : `${f3(checkLen)} ${f3(checkLen)}`, 'stroke-dashoffset': f3(cp >= 1 ? 0 : checkLen * (1 - cp)) });
      }
    }
    const BT = `${G} translate(${f3(bx)},${f3(by)}) scale(${f3(Math.max(bs, 0.001))},${f3(Math.max(bs * sy, 0.001))})`;
    // 按钮上的字不跟着压扁：文字不做非等比缩放（底座硬规矩第 8 条），翻面时字等比缩小再弹开，位置按按钮的横向缩放算
    const TT = (dx) => `${G} translate(${f3(bx + dx * bs)},${f3(by)}) scale(${f3(Math.max(bs * sy, 0.001))})`;
    if (!candy) {
      vis(btn, bOn);
      set(btn, { transform: BT, opacity: f3(op) });
      if (!followed) set(btn, { fill: K.accent, 'fill-opacity': 1, stroke: 'none', 'stroke-width': 0 });
      else set(btn, { fill: hasCard ? K.bg : K.shadow, 'fill-opacity': hasCard ? 1 : 0.45, stroke: K.fill2, 'stroke-width': f3(0.06 * btnH) });
      vis(plus, bOn && !followed); vis(txtA, bOn && !followed);
      vis(check, bOn && followed); vis(txtB, bOn && followed);
      if (!followed) {
        set(plus, { transform: `${BT} translate(${f3(layA.icon)},0)`, opacity: f3(op) });
        set(txtA, { transform: TT(layA.text), opacity: f3(op) });
      } else {
        const cp = easeOutCubic(clamp((fu - 0.05) / 0.25));
        set(check, { transform: `${BT} translate(${f3(layB.icon)},0)`, 'stroke-dasharray': cp >= 1 ? 'none' : `${f3(checkLen)} ${f3(checkLen)}`, 'stroke-dashoffset': f3(cp >= 1 ? 0 : checkLen * (1 - cp)), opacity: f3(op) });
        set(txtB, { transform: TT(layB.text), opacity: f3(op) });
      }
    }
    // 粒子、彩纸：从按钮后面迸出来（在卡片底下一层）
    for (const p of parts) {
      const u = (t - p.at) / p.life;
      const pOn = u > 0 && u < 1 && outS > 0.002;
      vis(p.e, pOn);
      if (!pOn) continue;
      const d = p.dist * easeOutCubic(u);
      const px = bx + p.dx * d; const py = by + p.dy * d + p.fall * u * u;
      set(p.e, { transform: `translate(${f3(px)},${f3(py)}) rotate(${f3(p.spin * u)}) scale(${f3(Math.max(p.paper ? 1 : 1 - 0.5 * u, 0.001))})`, opacity: f3(clamp((1 - u) / 0.35)) });
    }
    // 手：从右下伸进来，按一下关注，再收回去
    if (handG) {
      const target = { x: bx + 0.12 * btnW, y: by + 0.2 * btnH };
      // 起点收在画面里（手的右边、下边都不出画面），伸进来、收回去时淡入淡出
      const fromX = Math.min(target.x + 0.7 * cardH, W - m - 0.45 * handH);
      const fromY = Math.min(target.y + 1.0 * cardH, H - m - 0.95 * handH);
      const from = { x: Math.max(fromX, target.x), y: Math.max(fromY, target.y) };
      const hin = easeOutCubic(clamp((t - tHandIn) / (0.3 * k)));
      const hout = easeInCubic(clamp((t - tHandOut) / (0.3 * k)));
      const press = Math.max(0, Math.sin(Math.PI * clamp((t - tPress + 0.06) / 0.16)));
      const p = hin * (1 - hout);
      const hOn = p > 0.002 && outS > 0.002;
      vis(handG, hOn);
      if (hOn) set(handG, { transform: `translate(${f3(lerp(from.x, target.x, p))},${f3(lerp(from.y, target.y, p) + press * 0.08 * btnH)}) rotate(${f3(-14 * (1 - p))}) scale(${f3(1 - 0.06 * press)})` });
      // 淡入淡出写在手那条路径上，不写在整组上（底座硬规矩第 6 条）
      if (hOn) handPath.setAttribute('opacity', f3(clamp(p * 2.5) * outS));
    }
  }

  const lines = []; const issues = []; const warnings = [];
  if (nameChars.length) {
    const ln = [{ text: name, index: 0, paragraph: 0 }];
    issues.push(...checkLineBreaks(ln, name, { segment: ctx.segment }));
    warnings.push(...icuBreakWarnings(ln, name));
    lines.push(name);
  }
  if (hasBio) {
    const bio = bioChars.map((c) => c.ch).join('');
    const ln = [{ text: bio, index: 0, paragraph: 0 }];
    issues.push(...checkLineBreaks(ln, bio, { segment: ctx.segment }));
    lines.push(bio);
  }
  if (!compact && nameFs < 0.22 * cardH) warnings.push({ type: 'too-long', detail: `账号名 ${nameChars.length} 个字，放不下，字号缩到了卡片高度的 ${Math.round((nameFs / cardH) * 100)}%` });
  if (hasBio && bioFs < 0.15 * cardH) warnings.push({ type: 'too-long', detail: `简介 ${bioChars.length} 个字，放不下，字号缩到了卡片高度的 ${Math.round((bioFs / cardH) * 100)}%` });
  seek(0);
  return {
    timeline,
    layout: { fontSize: nameFs, lines, forced: [], issues, warnings, segmentation: ctx.segmentation ? ctx.segmentation.sources : [], units: nameChars.length + bioChars.length, cardWidth: cw, compact },
    seek,
    destroy() { svg.remove(); },
  };
}
