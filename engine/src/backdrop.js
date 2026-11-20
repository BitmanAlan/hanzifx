// 背景：只给预览和不透明导出用，风格本身永远画在透明底上。
// transparent：什么都不画（导出透明底用）；checker：棋盘格（试玩时看透明区域）；
// studio：程序生成的柔和光斑背景（导出 MP4 预览用）；studio-still：同样的背景但光斑不动（做动图用）；
// busy-light：浅色杂乱的底（检查看不看得清）；#RRGGBB：纯色。

import { hash01 } from './lib/rand.js';

export function createBackdrop(root, kind, { width: W, height: H }) {
  const div = document.createElement('div');
  div.dataset.hanzifxBackdrop = kind;
  div.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;`;
  let seek = () => {};
  if (kind === 'checker') {
    const s = Math.round(Math.min(W, H) / 36);
    div.style.background = `repeating-conic-gradient(#d9d9de 0% 25%, #f4f4f6 0% 50%) 0 0 / ${2 * s}px ${2 * s}px`;
  } else if (kind === 'studio' || kind === 'studio-still') {
    div.style.background = 'linear-gradient(160deg, #3a3f8f 0%, #23245a 46%, #120f2e 100%)';
    const spots = [];
    for (let k = 0; k < 16; k++) {
      const d = document.createElement('div');
      const r = (0.08 + hash01(1, 'r', k) * 0.22) * Math.max(W, H);
      const hue = [205, 265, 320, 30][k % 4];
      d.style.cssText = `position:absolute;width:${2 * r}px;height:${2 * r}px;border-radius:50%;` +
        `background:radial-gradient(circle, hsla(${hue},85%,68%,${(0.1 + hash01(1, 'a', k) * 0.16).toFixed(3)}) 0%, hsla(${hue},85%,60%,0) 70%);`;
      div.appendChild(d);
      spots.push({ d, r, x: hash01(1, 'x', k) * W, y: hash01(1, 'y', k) * H, ph: hash01(1, 'p', k) * 6.283 });
    }
    const vignette = document.createElement('div');
    vignette.style.cssText = 'position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.45) 100%);';
    div.appendChild(vignette);
    // studio-still：光斑不漂动（做预览动图用，背景不变，动图才压得小）
    const still = kind === 'studio-still';
    seek = (t0) => {
      const t = still ? 0 : t0;
      for (const s of spots) {
        const dx = Math.sin(t * 0.35 + s.ph) * 0.02 * W;
        const dy = Math.cos(t * 0.27 + s.ph) * 0.015 * H;
        s.d.style.transform = `translate(${(s.x - s.r + dx).toFixed(2)}px, ${(s.y - s.r + dy).toFixed(2)}px)`;
      }
    };
  } else if (kind === 'busy-light') {
    // 浅色杂乱的底：模拟明亮、东西很多的实拍画面（货架、桌面、街景），专门用来检查字在乱背景上看不看得清。
    // 全部用色块程序生成（种子固定），不用任何照片素材；故意混进黄、橙、粉这些跟花字撞色的颜色
    div.style.background = 'linear-gradient(170deg, #f6f1e8 0%, #ece6db 55%, #e4ddd0 100%)';
    const palette = ['#f7c948', '#f29e4c', '#ef6f6c', '#7bc8a4', '#6aa9e9', '#b39ddb', '#ffffff', '#d9d2c5', '#ffe28a', '#ffb3c6', '#8d99ae', '#3d405b'];
    const S = Math.max(W, H);
    for (let k = 0; k < 90; k++) {
      const d = document.createElement('div');
      const w = (0.03 + hash01(2, 'w', k) ** 2 * 0.28) * S;
      const h = (0.02 + hash01(2, 'h', k) ** 2 * 0.22) * S;
      const x = hash01(2, 'x', k) * W - w / 2;
      const y = hash01(2, 'y', k) * H - h / 2;
      const c = palette[Math.floor(hash01(2, 'c', k) * palette.length)];
      const kind2 = hash01(2, 'k', k);
      const rot = (hash01(2, 'r', k) - 0.5) * 30;
      const alpha = (0.45 + hash01(2, 'a', k) * 0.55).toFixed(2);
      let shape = `border-radius:${(hash01(2, 'br', k) * 0.2 * Math.min(w, h)).toFixed(1)}px;`;
      if (kind2 < 0.25) shape = 'border-radius:50%;';
      if (kind2 > 0.85) shape = `background-image:repeating-linear-gradient(45deg, rgba(0,0,0,.18) 0 6px, transparent 6px 14px);`;
      d.style.cssText = `position:absolute;left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;` +
        `background-color:${c};opacity:${alpha};transform:rotate(${rot.toFixed(1)}deg);${shape}` +
        (hash01(2, 'b', k) < 0.3 ? 'box-shadow:0 0 0 3px rgba(40,40,60,.35) inset;' : '');
      div.appendChild(d);
    }
    // 像招牌和标签的细条（深色细线，模拟文字和边缘）
    for (let k = 0; k < 40; k++) {
      const d = document.createElement('div');
      const w = (0.04 + hash01(3, 'w', k) * 0.16) * S;
      d.style.cssText = `position:absolute;left:${(hash01(3, 'x', k) * W).toFixed(1)}px;top:${(hash01(3, 'y', k) * H).toFixed(1)}px;` +
        `width:${w.toFixed(1)}px;height:${(3 + hash01(3, 'h', k) * 9).toFixed(1)}px;background:rgba(40,40,60,${(0.25 + hash01(3, 'a', k) * 0.5).toFixed(2)});` +
        `transform:rotate(${((hash01(3, 'r', k) - 0.5) * 20).toFixed(1)}deg);border-radius:2px;`;
      div.appendChild(d);
    }
  } else if (/^#[0-9a-fA-F]{6}$/.test(kind)) {
    div.style.background = kind;
  } else if (kind !== 'transparent') {
    throw new Error(`未知背景：${kind}（可用 transparent / checker / studio / studio-still / busy-light / #RRGGBB）`);
  }
  root.appendChild(div);
  seek(0);
  return { seek, destroy: () => div.remove() };
}
