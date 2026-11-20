// 缓动和弹簧。全部是解析式的纯函数：只看输入 t，不积分、不记状态，
// 所以可以跳到任意时间点，算出来的结果永远一样。

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const progress = (t, start, dur) => clamp((t - start) / dur);

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInBack = (t, s = 1.70158) => t * t * ((s + 1) * t - s);
export const easeOutBack = (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * 欠阻尼弹簧从 0 走到 1 的解析解（初速度为 0）。
 * freq：振荡频率（Hz）；damping：阻尼比 0~1，越小越弹。
 * t<=0 时返回 0。
 */
export function spring(t, { freq = 2.2, damping = 0.4 } = {}) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq;
  const z = Math.min(Math.max(damping, 0.01), 0.999);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

/** 弹簧第一次冲到 1 的时刻（用来算「落地」节拍） */
export function springFirstCross({ freq = 2.2, damping = 0.4 } = {}) {
  const w = 2 * Math.PI * freq;
  const z = Math.min(Math.max(damping, 0.01), 0.999);
  const wd = w * Math.sqrt(1 - z * z);
  // x(t)=1 ⇔ cos(wd t) + (zw/wd) sin(wd t) = 0 ⇔ tan(wd t) = -wd/(zw)
  return (Math.PI - Math.atan(wd / (z * w))) / wd;
}

/** 衰减的一次冲击：0 → 振一下 → 回 0，用来做落地「咚」一下 */
export function impulse(t, { freq = 3, decay = 6 } = {}) {
  if (t <= 0) return 0;
  return Math.exp(-decay * t) * Math.sin(2 * Math.PI * freq * t);
}
