// 颜色小工具。全库统一 8 个颜色角色（docs/STYLE-TEMPLATE.md）：
// fill 字的主色、fill2 渐变另一端、inner 内描边、outer 外描边、shadow 投影和厚度、accent 强调和装饰、bg 背景或底框、sub 小字。
// 风格要更多档的颜色时，从这 8 个角色推出来（用 mix），不在配色里另起名字，这样配色可以跨风格换用。

export const COLOR_ROLES = ['fill', 'fill2', 'inner', 'outer', 'shadow', 'accent', 'bg', 'sub'];

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`颜色要写成 #RRGGBB，收到 ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  const c = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** a 和 b 按 t 混合（t=0 是 a，t=1 是 b），在 sRGB 里直接插值 */
export function mix(a, b, t) {
  const x = hexToRgb(a); const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
}
