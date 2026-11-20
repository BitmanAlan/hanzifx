// 闪烁检查 flash-rate（WCAG 2.2 成功准则 2.3.1 Three Flashes or Below Threshold）。
// 原文定义（https://www.w3.org/TR/WCAG22/ 「general flash and red flash thresholds」）：
//   - 普通闪烁：一组方向相反的相对亮度变化，每次变化 ≥ 0.1（最大相对亮度是 1.0），且较暗的那一态 < 0.80；
//   - 红色闪烁：一组方向相反的转变，其中一次是变到或变自 R/(R+G+B) ≥ 0.8 的状态，
//     且两态在 CIE 1976 UCS 色度图（u′v′）上相差 > 0.2（WCAG 2.2 注 3，引 ISO 9241-391）；
//   - 任意一秒内普通闪烁或红色闪烁超过 3 次，并且同时闪的面积超过任意 10° 视野的 25%，就算超标。
// 面积口径（docs/STYLE-TEMPLATE.md 第 5 条）：任取一个宽、高各为画面 1/3 的窗口，
// 窗口里同时在变的像素不超过整个画面面积的 2.5%（25% 的 10° 视野约合画面 2.8%，留了余量）。
//
// 做法：
//   1) 每帧缩成 2×2 像素一格（默认），算每格的线性 RGB 平均，得到相对亮度和 u′v′ 色度；
//   2) 每格单独跟踪亮度的峰和谷（滞后阈值 0.1），相邻峰谷之间算一次「转变」，记下完成的帧号和方向；
//      红色另外跟踪：跟上一个锚点状态的 u′v′ 距离 > 0.2，且两态之一是饱和红，就记一次红色转变；
//   3) 每帧统计「这一帧完成转变」的格子，用 1/3 窗口滑动，算窗口里变亮面积减变暗面积的净值（运动会互相抵消，
//      整块闪才留得下来），净面积超过阈值就记一次大面积转变，方向取净值的正负；
//   4) 一对方向相反的大面积转变算一次闪烁：任意 1 秒窗口里的转变次数 ÷ 2 就是这一秒的闪烁次数；
//   5) 第二道判据「每格来回跳」（2026-11-19 补）：1 秒里来回变超过 3 次的格子，在同一帧正好在变的那些算「同时闪」，
//      去掉细线以后按 1/3 窗口汇总面积，超过阈值也算超标。专门抓棋盘格、条纹整体反色（净面积是 0，第一道判据看不出来）。
// 细密图案：WCAG 豁免「方格小于 0.1° 的细密图案」（1080 像素画面里约 5 像素）。第二道判据只认 3×3 邻域里成片在闪的格子，
// 细于约 6 像素的细线、细边不算；但整片都是 2–5 像素的细密图案整体反色时仍会被拦下（比 WCAG 严）。

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 一帧缩成格子：返回 { cols, rows, Y, u, v, red }（都是 Float64Array，长度 cols*rows） */
export function cellsOf(img, { cell = 2, background = [0, 0, 0] } = {}) {
  const { width: w, height: h, channels: ch, data } = img;
  const cols = Math.ceil(w / cell); const rows = Math.ceil(h / cell);
  const n = cols * rows;
  const R = new Float64Array(n); const G = new Float64Array(n); const B = new Float64Array(n); const cnt = new Float64Array(n);
  const bg = background.map((v) => LIN[v]);
  for (let y = 0; y < h; y++) {
    const ry = Math.floor(y / cell) * cols;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      let r = LIN[data[i]]; let g = LIN[data[i + 1]]; let b = LIN[data[i + 2]];
      if (ch === 4) { // 透明底：叠到给定背景上再看
        const a = data[i + 3] / 255;
        r = r * a + bg[0] * (1 - a); g = g * a + bg[1] * (1 - a); b = b * a + bg[2] * (1 - a);
      }
      const k = ry + Math.floor(x / cell);
      R[k] += r; G[k] += g; B[k] += b; cnt[k]++;
    }
  }
  const Y = new Float64Array(n); const u = new Float64Array(n); const v = new Float64Array(n); const red = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const r = R[k] / cnt[k]; const g = G[k] / cnt[k]; const b = B[k] / cnt[k];
    Y[k] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const d = X + 15 * Y[k] + 3 * Z;
    u[k] = d > 1e-9 ? (4 * X) / d : 0.2009; // 黑色时取 D65 白点的色度，避免除零
    v[k] = d > 1e-9 ? (9 * Y[k]) / d : 0.4610;
    const s = r + g + b;
    red[k] = s > 1e-6 && r / s >= 0.8 ? 1 : 0;
  }
  return { cols, rows, cell, Y, u, v, red, cellArea: cnt };
}

/**
 * 流式分析：逐帧 push 解码后的图（或 cellsOf 的结果），最后 finish() 拿结果。只保留每格的状态，不存整串帧。
 * cell：格子边长（像素）。默认 2：抖动、描边挪 1–2 个像素这种小变化，面积按实际算，不会被一整格放大。
 */
export class FlashAnalyzer {
  constructor({ fps, width, height, cell = 2, areaFrac = 0.025, window = 1 / 3, background = [0, 0, 0] }) {
    Object.assign(this, { fps, width, height, cell, areaFrac, window, background });
    this.f = 0;
    this.genAt = []; this.redAt = [];
  }

  push(imgOrCells) {
    const c = imgOrCells.Y ? imgOrCells : cellsOf(imgOrCells, { cell: this.cell, background: this.background });
    const n = c.cols * c.rows;
    const f = this.f++;
    this.genAt.push([]); this.redAt.push([]);
    if (f === 0) {
      this.cols = c.cols; this.rows = c.rows; this.cellArea = c.cellArea;
      this.ext = Float32Array.from(c.Y); this.base = Float32Array.from(c.Y);
      this.extF = new Int32Array(n); this.dir = new Int8Array(n);
      this.au = Float32Array.from(c.u); this.av = Float32Array.from(c.v); this.ared = Uint8Array.from(c.red); this.flip = new Int8Array(n).fill(1);
      return;
    }
    const { ext, base, extF, dir, au, av, ared, flip } = this;
    const gen = this.genAt; const red = this.redAt[f];
    for (let k = 0; k < n; k++) {
      // 亮度峰谷（滞后 0.1）：相邻峰谷之间的变化 ≥ 0.1、较暗一态 < 0.8，算一次转变，记在峰或谷所在的帧
      const y = c.Y[k];
      if (dir[k] >= 0 && y > ext[k]) { ext[k] = y; extF[k] = f; }
      if (dir[k] <= 0 && y < ext[k]) { ext[k] = y; extF[k] = f; }
      if (dir[k] === 0) {
        if (y - base[k] >= 0.1) dir[k] = 1; else if (base[k] - y >= 0.1) dir[k] = -1;
      } else if (dir[k] === 1 && ext[k] - y >= 0.1) {
        if (ext[k] - base[k] >= 0.1 && Math.min(ext[k], base[k]) < 0.8) gen[extF[k]].push(k, 1);
        base[k] = ext[k]; ext[k] = y; extF[k] = f; dir[k] = -1;
      } else if (dir[k] === -1 && y - ext[k] >= 0.1) {
        if (base[k] - ext[k] >= 0.1 && Math.min(ext[k], base[k]) < 0.8) gen[extF[k]].push(k, -1);
        base[k] = ext[k]; ext[k] = y; extF[k] = f; dir[k] = 1;
      }
      // 红色：跟锚点状态比 u′v′，距离 > 0.2 且两态之一是饱和红，算一次红色转变
      const d = Math.hypot(c.u[k] - au[k], c.v[k] - av[k]);
      if (d > 0.2) {
        if (ared[k] || c.red[k]) { red.push(k, flip[k]); flip[k] = -flip[k]; }
        au[k] = c.u[k]; av[k] = c.v[k]; ared[k] = c.red[k];
      }
    }
  }

  finish() {
    const N = this.f;
    if (!N) return { pass: true, general: { maxPerSecond: 0 }, red: { maxPerSecond: 0 } };
    const { ext, base, dir, extF } = this;
    for (let k = 0; k < this.cols * this.rows; k++) {
      if (dir[k] !== 0 && Math.abs(ext[k] - base[k]) >= 0.1 && Math.min(ext[k], base[k]) < 0.8) this.genAt[extF[k]].push(k, dir[k]);
    }
    const { cols, rows, cell, fps, width, height, areaFrac, window } = this;
    const thresholdPx = areaFrac * width * height;
    const winC = Math.max(1, Math.round((width * window) / cell)); const winR = Math.max(1, Math.round((height * window) / cell));
    const stepC = Math.max(1, Math.round(winC / 4)); const stepR = Math.max(1, Math.round(winR / 4));
    const W1 = cols + 1;
    const area = new Float64Array(W1 * (rows + 1)); const sgn = new Float64Array(W1 * (rows + 1));
    const bigEvents = (at) => {
      const out = [];
      for (let f = 0; f < N; f++) {
        // 「同时」按 WCAG 原文严格取同一帧：这一帧完成转变的格子（tolerance 帧以内也算，默认 0）
        const active = new Map();
        const tol = this.tolerance ?? 0;
        for (let dg = 0; dg <= tol * 2; dg++) {
          const g = f + (dg % 2 ? -(dg + 1) / 2 : dg / 2);
          if (g < 0 || g >= N) continue;
          const L = at[g];
          for (let i = 0; i < L.length; i += 2) if (!active.has(L[i])) active.set(L[i], L[i + 1]);
        }
        if (!active.size) continue;
        let up = 0; let dn = 0;
        for (const [k, d] of active) { if (d > 0) up += this.cellArea[k]; else dn += this.cellArea[k]; }
        if (up <= thresholdPx && dn <= thresholdPx) continue; // 单一方向加起来都不够，任何窗口的净面积都不会超
        area.fill(0); sgn.fill(0);
        for (const [k, d] of active) {
          const x = k % cols; const y = (k - x) / cols;
          const a = this.cellArea[k];
          area[(y + 1) * W1 + (x + 1)] += a; sgn[(y + 1) * W1 + (x + 1)] += a * d;
        }
        for (let y = 1; y <= rows; y++) for (let x = 1; x <= cols; x++) {
          const i = y * W1 + x;
          area[i] += area[i - 1] + area[i - W1] - area[i - W1 - 1];
          sgn[i] += sgn[i - 1] + sgn[i - W1] - sgn[i - W1 - 1];
        }
        const sum = (A, x0, y0, x1, y1) => A[y1 * W1 + x1] - A[y0 * W1 + x1] - A[y1 * W1 + x0] + A[y0 * W1 + x0];
        let best = 0; let bestSign = 0;
        for (let y0 = 0; y0 <= Math.max(0, rows - winR); y0 += stepR) {
          for (let x0 = 0; x0 <= Math.max(0, cols - winC); x0 += stepC) {
            const x1 = Math.min(cols, x0 + winC); const y1 = Math.min(rows, y0 + winR);
            // 净面积：同一窗口里变亮的面积减去变暗的面积。整块一亮一暗，净面积就是整块；
            // 东西挪了位置（一边变暗、一边变亮），两边大体抵消，不算闪
            const net = sum(sgn, x0, y0, x1, y1);
            if (Math.abs(net) > best) { best = Math.abs(net); bestSign = Math.sign(net) || 1; }
          }
        }
        if (best > thresholdPx) out.push({ f, dir: bestSign, areaFrac: best / (width * height) });
      }
      const merged = [];
      for (const e of out) {
        const last = merged[merged.length - 1];
        if (last && e.f - last.fEnd <= 2 && e.dir === last.dir) { last.fEnd = e.f; last.areaFrac = Math.max(last.areaFrac, e.areaFrac); } else merged.push({ ...e, fEnd: e.f });
      }
      return merged;
    };
    const countFlashes = (trans) => {
      // 只留方向交替的转变；一次闪烁 = 一对方向相反的转变，任意 1 秒里的闪烁次数 = 转变次数 ÷ 2（向下取整）
      const alt = [];
      for (const t of trans) if (!alt.length || alt[alt.length - 1].dir !== t.dir) alt.push(t);
      let max = 0; let worst = null;
      for (let i = 0; i < alt.length; i++) {
        let j = i;
        while (j + 1 < alt.length && alt[j + 1].f - alt[i].f < fps) j++;
        const flashes = Math.floor((j - i + 1) / 2);
        if (flashes > max) { max = flashes; worst = { startFrame: alt[i].f, endFrame: alt[j].f, startS: alt[i].f / fps, endS: alt[j].f / fps, transitions: j - i + 1, maxAreaFrac: Math.max(...alt.slice(i, j + 1).map((t) => t.areaFrac)) }; }
      }
      return { flashes: Math.floor(alt.length / 2), maxPerSecond: max, worst, transitions: trans.length };
    };
    // 第二道判据「每格来回跳」：同一格在任意 1 秒里来回变超过 3 次（转变 ≥ 8 次），算这一格在闪；
    // 这 1 秒里在闪的格子，按 1/3 窗口汇总面积，超过阈值就超标。专门抓图案反色（棋盘格、条纹整体反色）——
    // 那种情况每个窗口一半变亮一半变暗，第一道判据的净面积是 0。运动时一格通常只是从一个状态变到另一个状态，不会来回跳很多次
    const perCell = (at) => {
      const trans = new Map(); // 格子 → 完成转变的帧号（升序）
      for (let f = 0; f < N; f++) { const L = at[f]; for (let i = 0; i < L.length; i += 2) { const k = L[i]; if (!trans.has(k)) trans.set(k, []); trans.get(k).push(f); } }
      const minTrans = 8; // ≥ 8 次转变 = 1 秒里 4 次闪烁 > 3
      let bestArea = 0; let bestF = -1; let hotCells = 0;
      const step = Math.max(1, Math.round(fps / 6));
      const grid = new Uint8Array(cols * rows);
      for (let s0 = 0; s0 < N; s0 += step) {
        const hot = new Set();
        for (const [k, fr] of trans) {
          if (fr.length < minTrans) continue;
          let c = 0;
          for (const f of fr) if (f >= s0 && f < s0 + fps) c++;
          if (c >= minTrans) hot.add(k);
        }
        if (!hot.size) continue;
        hotCells = Math.max(hotCells, hot.size);
        // 「同时」：这一秒里来回跳的格子，在同一帧正好在变的那些才算一起闪
        for (let f = s0; f < Math.min(N, s0 + fps); f++) {
          const L = at[f]; const act = [];
          for (let i = 0; i < L.length; i += 2) if (hot.has(L[i])) act.push(L[i]);
          if (!act.length) continue;
          let tot0 = 0; for (const k of act) tot0 += this.cellArea[k];
          if (tot0 <= thresholdPx) continue;
          // 只认成片在闪的格子：3×3 邻域里至少 7 格同时在闪。细于约 6 像素的细线、细边（字和框的边缘在抖、在回弹）去掉——
          // WCAG 原文豁免「方格小于 0.1° 视角的细密图案」，1080 像素画面里 0.1° 约 5 像素
          for (const k of act) grid[k] = 1;
          const solid = [];
          for (const k of act) {
            const x = k % cols; const y = (k - x) / cols; let c = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < cols && yy < rows && grid[yy * cols + xx]) c++;
            }
            if (c >= 7) solid.push(k);
          }
          for (const k of act) grid[k] = 0;
          let tot = 0; for (const k of solid) tot += this.cellArea[k];
          if (tot <= thresholdPx) { if (tot > bestArea) { bestArea = tot; bestF = f; } continue; }
          area.fill(0);
          for (const k of solid) { const x = k % cols; const y = (k - x) / cols; area[(y + 1) * W1 + (x + 1)] += this.cellArea[k]; }
          for (let y = 1; y <= rows; y++) for (let x = 1; x <= cols; x++) { const i = y * W1 + x; area[i] += area[i - 1] + area[i - W1] - area[i - W1 - 1]; }
          const sum = (x0, y0, x1, y1) => area[y1 * W1 + x1] - area[y0 * W1 + x1] - area[y1 * W1 + x0] + area[y0 * W1 + x0];
          for (let y0 = 0; y0 <= Math.max(0, rows - winR); y0 += stepR) {
            for (let x0 = 0; x0 <= Math.max(0, cols - winC); x0 += stepC) {
              const a = sum(x0, y0, Math.min(cols, x0 + winC), Math.min(rows, y0 + winR));
              if (a > bestArea) { bestArea = a; bestF = f; }
            }
          }
        }
      }
      return { pass: bestArea <= thresholdPx, maxAreaFrac: bestArea / (width * height), atS: bestF >= 0 ? bestF / fps : null, hotCells };
    };
    const general = countFlashes(bigEvents(this.genAt));
    const red = countFlashes(bigEvents(this.redAt));
    const pattern = { general: perCell(this.genAt), red: perCell(this.redAt) };
    return {
      pass: general.maxPerSecond <= 3 && red.maxPerSecond <= 3 && pattern.general.pass && pattern.red.pass,
      general, red, pattern,
      thresholds: { areaFrac, window: `${(window * 100).toFixed(1)}% × ${(window * 100).toFixed(1)}%`, cellPx: cell, luminanceDelta: 0.1, darkerBelow: 0.8, redRatio: 0.8, redUvDelta: 0.2, perSecond: 3 },
    };
  }
}

/** 一次性分析（测试用）：frames 是解码后的图 */
export function analyzeFlashes(frames, opts) {
  const a = new FlashAnalyzer(opts);
  for (const fr of frames) a.push(fr);
  return a.finish();
}
