// 共用动作：各个风格直接调，不要每个风格自己写一遍。全部是纯函数：给时间，返回这一刻的位移、旋转、缩放。
// 单位约定：位移用 px（调用方传字号 fs 进来按比例算）、旋转用度、缩放是倍数。
// 已有：bounceIn 弹跳入场、popOut 缩小飞出、wave 波浪晃动、jitter 阶梯抖动、shake 震屏、beatAt 拍点、
// shineSweep/shineStops 高光扫过、countUp/formatNumber/odometer 数字滚动、wipe/wipeRect/wipeStops 遮罩扫出、inkSpread 墨迹晕开。

import { clamp, spring, springFirstCross, impulse, smoothstep, easeOutCubic, easeInCubic, easeInBack } from '../lib/ease.js';
import { stepNoise, hash01, noise1 } from '../lib/rand.js';

export const IDENTITY = Object.freeze({ dx: 0, dy: 0, rot: 0, sx: 1, sy: 1 });

// 尾巴死区：衰减到静止的动作（震动、弹簧、衰减冲击）最后一点点直接落到正好的静止值。
// 几乎没动的帧（只挪零点零几像素）会让后面停住的画面随机出两种画法，见 ADR-001「逐帧一致的几类坑」。
// 门槛：位移不到 0.05 像素、转角不到 0.02 度、缩放差乘上字号不到 0.05 像素。
export const DEAD_PX = 0.05;
export const DEAD_DEG = 0.02;
const deadPx = (v) => (Math.abs(v) < DEAD_PX ? 0 : v);
const deadDeg = (v) => (Math.abs(v) < DEAD_DEG ? 0 : v);
const deadScale = (v, fs) => (Math.abs(v - 1) * Math.max(fs, 1) < DEAD_PX ? 1 : v);

/** 把几个动作的结果叠起来：位移、旋转相加，缩放相乘 */
export function combine(...parts) {
  const o = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, visible: true };
  for (const p of parts) {
    if (!p) continue;
    o.dx += p.dx || 0; o.dy += p.dy || 0; o.rot += p.rot || 0;
    o.sx *= p.sx ?? 1; o.sy *= p.sy ?? 1;
    if (p.visible === false) o.visible = false; // 任何一个说要隐藏就隐藏
  }
  return o;
}

/**
 * 弹跳入场。tau = 从这个元素开始入场算起的秒数。
 * mode 'pop'：从 0 弹出，带一点拉伸和回弹；'drop'：从上面掉下来，落地压扁一下。
 * 返回 { dx, dy, rot, sx, sy, visible, landAt }（landAt：第一次落到位的时刻，用来卡点）
 */
// minScale：缩放小于它的那几帧给 visible: false（几乎缩成一点的图形只有几个像素，抗锯齿结果最不稳，见《写一个新风格》第 3 节的建议）。
// 默认 0 = 不隐藏，跟原来一样；要更保险就传 0.2，风格里用返回的 visible 决定显示还是隐藏。
export function bounceIn(tau, { mode = 'pop', freq = 2.3, damping = 0.42, fs = 100, sign = 1, rise = 0.35, spin = 28, fall = 1.3, stretch: stretchAmp = 0.16, minScale = 0 } = {}) {
  if (mode === 'drop') {
    const sp = { freq: freq * 0.9, damping: Math.max(0.22, damping - 0.12) };
    const landAt = springFirstCross(sp);
    if (tau <= 0) return { ...IDENTITY, sx: 0, sy: 0, visible: false, landAt };
    const p = spring(tau, sp);
    const appear = easeOutCubic(clamp(tau / 0.1));
    const squash = 0.24 * impulse(tau - landAt, { freq: 2.8, decay: 7 });
    return {
      dx: 0, dy: deadPx(-(1 - p) * fall * fs), rot: deadDeg((1 - clamp(p)) * sign * 10),
      sx: deadScale(appear * (1 + squash), fs), sy: deadScale(appear * (1 - squash), fs), visible: appear >= minScale, landAt,
    };
  }
  const sp = { freq, damping };
  const landAt = springFirstCross(sp);
  if (tau <= 0) return { ...IDENTITY, sx: 0, sy: 0, visible: false, landAt };
  const p = spring(tau, sp);
  const stretch = stretchAmp * impulse(tau, { freq, decay: 4.5 });
  return {
    dx: 0, dy: deadPx((1 - p) * rise * fs), rot: deadDeg((1 - p) * sign * spin),
    sx: deadScale(p * (1 - stretch), fs), sy: deadScale(p * (1 + stretch), fs), visible: p >= minScale, landAt,
  };
}

/** bounceIn 的时间参数（不用算画面就能知道什么时候落地、什么时候算稳住） */
export function bounceTiming({ mode = 'pop', freq = 2.3, damping = 0.42 } = {}) {
  const sp = mode === 'drop' ? { freq: freq * 0.9, damping: Math.max(0.22, damping - 0.12) } : { freq, damping };
  return { landAt: springFirstCross(sp), settle: Math.min(4 / (sp.damping * 2 * Math.PI * sp.freq), 0.75) };
}

/** 缩小飞出：先鼓一下，再缩到 0 往上飞。u = 出场进度 0~1；minScale 同 bounceIn */
export function popOut(u, { fs = 100, sign = 1, lift = 0.45, spin = 22, minScale = 0 } = {}) {
  if (u <= 0) return { ...IDENTITY, visible: true };
  const k1 = clamp(u / 0.3);
  const k2 = clamp((u - 0.3) / 0.7);
  const s = (1 + 0.14 * easeOutCubic(k1)) * Math.max(0, 1 - easeInBack(k2, 1.4));
  return { dx: 0, dy: -easeInCubic(k2) * lift * fs, rot: sign * spin * easeInCubic(k2), sx: s, sy: s, visible: s > 0 && s >= minScale };
}

/** 波浪晃动：第 i 个字相位错开，整行像在跳舞。amount 0~2 */
export function wave(t, i, { fs = 100, amount = 1, amp = 0.032, freq = 1.15, rotAmp = 2.4, rotFreq = 0.85 } = {}) {
  return {
    dx: 0,
    dy: amount * amp * fs * Math.sin(2 * Math.PI * freq * t - i * 0.75),
    rot: amount * rotAmp * Math.sin(2 * Math.PI * rotFreq * t - i * 0.9 + 0.5),
    sx: 1, sy: 1,
  };
}

/** 阶梯抖动：每秒变 rate 次，中间停住，像手绘动画的抖线。amount 0~2 */
export function jitter(seed, t, i, { fs = 100, amount = 1, rate = 12, move = 0.02, turn = 2.2 } = {}) {
  return {
    dx: (stepNoise(seed, t, rate, 'jx', i) - 0.5) * move * fs * amount,
    dy: (stepNoise(seed, t, rate, 'jy', i) - 0.5) * move * fs * amount,
    rot: (stepNoise(seed, t, rate, 'jr', i) - 0.5) * turn * amount,
    sx: 1, sy: 1,
  };
}

/** 停留段的权重：落地后 0.45 秒渐入，出场前渐出。用来把 wave/jitter 只放在停留段 */
export function holdWeight(t, landAt, exitAt) {
  return smoothstep(landAt, landAt + 0.45, t) * (1 - smoothstep(exitAt - 0.1, exitAt + 0.05, t));
}

/** 按权重缩放一个动作（位移旋转乘权重，缩放往 1 靠） */
export function scaleBy(m, w) {
  return { dx: m.dx * w, dy: m.dy * w, rot: m.rot * w, sx: 1 + (m.sx - 1) * w, sy: 1 + (m.sy - 1) * w };
}

/** 震屏：在 start 时刻猛震一下然后衰减。给整块或整个画面用 */
export function shake(t, { start = 0, amplitude = 24, duration = 0.45, freq = 18, seed = 1, rotate = 1.5 } = {}) {
  const tau = t - start;
  if (tau < 0 || tau > duration) return IDENTITY;
  const decay = Math.pow(1 - tau / duration, 2);
  const k = Math.floor(tau * freq);
  const f = tau * freq - k;
  const n = (key) => {
    const a = hash01(seed, key, k) * 2 - 1;
    const b = hash01(seed, key, k + 1) * 2 - 1;
    return a + (b - a) * (f * f * (3 - 2 * f));
  };
  return { dx: deadPx(n('x') * amplitude * decay), dy: deadPx(n('y') * amplitude * decay), rot: deadDeg(n('r') * rotate * decay), sx: 1, sy: 1 };
}

/**
 * 拍点工具：beats 是外部传进来的升序秒数数组（ctx.beats）。
 * 返回 { index: 当前是第几拍（-1 表示第一拍之前）, since: 距离这一拍过了几秒, next: 下一拍时刻或 null }
 */
export function beatAt(t, beats) {
  let lo = 0; let hi = beats.length - 1; let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t + 1e-9) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return { index: idx, since: idx >= 0 ? t - beats[idx] : t, next: idx + 1 < beats.length ? beats[idx + 1] : null };
}

// ---------- 高光扫过 ----------
/**
 * 一道斜亮带扫过。返回 { u, visible }：u 是亮带中心在 [-width, 1+width] 里走到的位置（0＝左边，1＝右边）。
 * 用法：给一个 linearGradient（x1..x2 覆盖文字宽度），色标用 shineStops(u) 生成，叠在字上（fill 用这个渐变，跟字同形）。
 */
export function shineSweep(t, { start = 0, duration = 0.6, width = 0.18, ease = (x) => x } = {}) {
  const p = (t - start) / duration;
  if (p <= 0 || p >= 1) return { u: -1, visible: false, p: clamp(p) };
  return { u: -width + (1 + 2 * width) * ease(p), visible: true, p };
}

/** 亮带的渐变色标：[[offset 0~1, opacity]]，中心 u、半宽 width、边缘柔和度 softness、最亮 peak */
export function shineStops(u, { width = 0.18, softness = 0.5, peak = 0.85 } = {}) {
  const a = u - width; const b = u + width; const core = width * (1 - softness);
  const pts = [[0, 0], [a, 0], [u - core, peak], [u + core, peak], [b, 0], [1, 0]];
  return pts.map(([o, op]) => [clamp(o), op]).filter((x, i, arr) => i === 0 || x[0] >= arr[i - 1][0]);
}

// ---------- 数字滚动 ----------
/** 数字从 from 滚到 to。返回 { value, text }；text 按 formatNumber 的规则排 */
export function countUp(t, { from = 0, to = 100, start = 0, duration = 1.2, ease = easeOutCubic, ...fmt } = {}) {
  const p = clamp((t - start) / duration);
  const value = from + (to - from) * ease(p);
  return { value, text: formatNumber(value, fmt), p };
}

/**
 * 数字排版：decimals 位小数；sep 千分位（默认不加，中文短视频里少见）；
 * unit：'none' 原样、'万' 满一万写「x.x万」满一亿写「x.x亿」、'k' 写 k/M。
 */
export function formatNumber(v, { decimals = 0, sep = '', unit = 'none', unitDecimals = 1 } = {}) {
  let n = v; let suffix = '';
  if (unit === '万') { if (Math.abs(n) >= 1e8) { n /= 1e8; suffix = '亿'; } else if (Math.abs(n) >= 1e4) { n /= 1e4; suffix = '万'; } }
  if (unit === 'k') { if (Math.abs(n) >= 1e6) { n /= 1e6; suffix = 'M'; } else if (Math.abs(n) >= 1e3) { n /= 1e3; suffix = 'k'; } }
  const d = suffix ? unitDecimals : decimals;
  let s = (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);
  if (suffix && d > 0) s = s.replace(/\.?0+$/, ''); // 1.0万 → 1万
  if (sep) { const [i, f] = s.split('.'); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, sep) + (f ? `.${f}` : ''); }
  return s + suffix;
}

/**
 * 里程表式：把一个数拆成 digits 位，每位给出 { digit, frac }——frac 是这一位往下一个数字滚了多少（0~1），
 * 低位转一圈带高位进一，跟机械计数器一样。用法：每位画一条 0–9 的竖条，按 digit+frac 往上平移。
 */
export function odometer(value, { digits = 4 } = {}) {
  const v = Math.max(0, value);
  const out = [];
  for (let k = digits - 1; k >= 0; k--) {
    const place = 10 ** k;
    const whole = Math.floor(v / place);
    const digit = whole % 10;
    // 只有在低位全是 9 往上滚的那一下，这一位才跟着转
    const below = v - whole * place; // 0 ≤ below < place
    const carry = place === 1 ? below : clamp((below - (place - 1)) / 1);
    out.push({ place, digit, frac: place === 1 ? v - Math.floor(v) : carry });
  }
  return out;
}

// ---------- 遮罩扫出 ----------
/** 扫出进度 0~1（按 ease）。direction：left 从左往右、right 从右往左、up 从下往上、down 从上往下 */
export function wipe(t, { start = 0, duration = 0.5, ease = easeOutCubic } = {}) {
  return ease(clamp((t - start) / duration));
}

/** 硬边扫出：给 bbox {x,y,w,h} 和进度 p，返回露出来的矩形（给 clipPath 用） */
export function wipeRect(p, box, direction = 'left') {
  const { x, y, w, h } = box;
  if (direction === 'right') return { x: x + w * (1 - p), y, w: w * p, h };
  if (direction === 'up') return { x, y: y + h * (1 - p), w, h: h * p };
  if (direction === 'down') return { x, y, w, h: h * p };
  return { x, y, w: w * p, h };
}

/** 羽化扫出：给渐变遮罩用的色标 [[offset, opacity]]，feather 是羽化宽度（占整段的比例）。渐变方向按 direction 摆 */
export function wipeStops(p, { feather = 0.15 } = {}) {
  const edge = -feather + (1 + feather) * p; // 羽化带的前沿从 -feather 走到 1
  return [[0, 1], [clamp(edge), 1], [clamp(edge + feather), 0], [1, 0]].filter((x, i, arr) => i === 0 || x[0] >= arr[i - 1][0]);
}

// ---------- 墨迹晕开 ----------
/**
 * 几团墨从种子点晕开：返回 [{ d, r, cx, cy }]，d 是边缘不规则的闭合路径（给 mask 或 clipPath 用，墨迹盖到哪字就露到哪）。
 * 边缘用带种子的一维噪声扰动半径，所以每团墨的形状固定、随时间长大，不靠 feTurbulence 这类滤镜（滤镜加变换会让乱序渲染对不上）。
 * points：晕开的起点 [{x,y}]（比如每个字的中心，或笔画起笔处）；maxR：长到多大；stagger：各团错开多少秒。
 */
export function inkSpread(t, { seed = 1, points = [], start = 0, duration = 0.9, stagger = 0.08, maxR = 100, roughness = 0.22, segments = 36, ease = easeOutCubic } = {}) {
  return points.map((pt, i) => {
    const p = ease(clamp((t - start - i * stagger) / duration));
    const r = maxR * p * (0.85 + 0.3 * hash01(seed, 'ink-r', i));
    if (r <= 0.01) return { d: '', r: 0, cx: pt.x, cy: pt.y };
    let d = '';
    for (let k = 0; k <= segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      // 噪声沿圆周取，首尾对上；边缘随长大慢慢「洇」开（噪声位置随 p 微移）
      const nz = noise1(seed, (k % segments) * 0.45 + i * 13.7 + p * 0.6, `ink${i}`) - 0.5;
      const rr = r * (1 + roughness * 2 * nz);
      d += `${k ? 'L' : 'M'}${(pt.x + Math.cos(a) * rr).toFixed(2)},${(pt.y + Math.sin(a) * rr).toFixed(2)}`;
    }
    return { d: d + 'Z', r, cx: pt.x, cy: pt.y };
  });
}

const f3 = (n) => (Math.abs(n) < 1e-6 ? '0' : n.toFixed(3));
/** 变成 SVG transform 字符串（先平移到 (x,y)，再绕自身中心转和缩放） */
export function toSvgTransform(x, y, m) {
  return `translate(${f3(x + m.dx)},${f3(y + m.dy)}) rotate(${f3(m.rot)}) scale(${f3(m.sx)},${f3(m.sy)})`;
}
export { f3 };
