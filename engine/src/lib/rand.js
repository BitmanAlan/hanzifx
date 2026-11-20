// 带种子的随机数。风格里不许用 Math.random()，一律走这里：
// 同样的 (seed, 键) 永远得到同样的数，任意时间点都能独立算出来。

/** FNV-1a 32 位字符串哈希 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：给一个 32 位种子，返回一个顺序取数的生成器 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按种子和若干键建一个生成器，比如 rng(seed, 'char', 3) */
export function rng(seed, ...keys) {
  return mulberry32(hashStr([seed, ...keys].join('|')));
}

/** 无状态取数：同样的参数直接返回 [0,1) 里的同一个数，不依赖调用顺序 */
export function hash01(seed, ...keys) {
  return mulberry32(hashStr([seed, ...keys].join('|')))();
}

/** 一维平滑噪声（值噪声 + smoothstep 插值），x 为任意实数 */
export function noise1(seed, x, key = 'n') {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(seed, key, i);
  const b = hash01(seed, key, i + 1);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** 阶梯噪声：每秒变 rate 次，中间保持不动（手绘动画「抖线」的感觉） */
export function stepNoise(seed, t, rate, ...keys) {
  return hash01(seed, ...keys, Math.floor(t * rate));
}
