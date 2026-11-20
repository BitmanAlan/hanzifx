// 质感 A「亮面糖果」的配色公式：从一个主色推出各层颜色（纯函数，同一个主色每次结果一样）。
// 提亮(色, k)＝跟白色按 k 混合，压暗(色, k)＝跟黑色按 k 混合，都在 sRGB 上线性插值（lib/color.js 的 mix）。
// 数值照质感 A「亮面糖果」的零件说明：主色照用各元素自己的色板，不加新的颜色角色。
import { mix } from '../lib/color.js';

export const lighten = (c, k) => mix(c, '#FFFFFF', k);
export const darken = (c, k) => mix(c, '#000000', k);

/** 方形键帽、彩色底座块：顶面 160° 渐变、侧壁竖向渐变、按下时的顶面 */
export function keyColors(c) {
  return {
    top: [lighten(c, 0.28), c, darken(c, 0.12)], // 0%、48%、100%
    side: [darken(c, 0.18), darken(c, 0.4)], // 侧壁上 → 下
    pressed: [darken(c, 0.02), darken(c, 0.2)],
    shadow: darken(c, 0.62),
  };
}

/** 圆按钮：顶面径向渐变（中心偏左上）、厚度 */
export function roundColors(c) {
  return {
    face: [lighten(c, 0.3), c, darken(c, 0.28)], // 0%、55%、100%
    side: darken(c, 0.28),
    shadow: darken(c, 0.62),
  };
}

/** 徽章、胶囊标签：面竖向渐变、厚度、投影 */
export function badgeColors(c) {
  return {
    face: [lighten(c, 0.16), darken(c, 0.06)],
    side: darken(c, 0.3),
    shadow: darken(c, 0.62),
  };
}

/** 奶白底座块、胶囊条（说明里的固定色） */
export const CREAM = {
  top: ['#FFFFFF', '#FBF4EF', '#F3E6DD'], // 0%、60%、100%
  side: ['#EBCDBE', '#C99A86'],
  edge: '#D9AE9A',
  shadow: '#784028', // rgba(120,60,40) 的底色，透明度另给
  groove: '#965A3C',
};
