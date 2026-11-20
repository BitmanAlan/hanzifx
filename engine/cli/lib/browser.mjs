// 找浏览器、开页面、挂载风格、查实际用到的字体。
// 浏览器顺序：--chrome / HANZIFX_CHROME 指定的 → 已下载的 chrome-headless-shell（版本跟着 playwright-core 锁死，逐帧结果最稳）
//            → 本机装的 Google Chrome（用户不用另外下载，但 Chrome 自动升级后逐帧 hash 可能变）。
// 只用逐帧截图，不用录屏（新版无头 Chrome 录屏会裁掉画面边缘，也不认 deviceScaleFactor）。
import { chromium } from 'playwright-core';

export const CHROME_ARGS = [
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // 关掉「局部重新栅格化」：开着时浏览器只重画上一帧以来变了的那一块、叠在旧的图块上，
  // 几乎缩成一点的图形（入场刚开始、缩放接近 0）抗锯齿结果会跟这个页面前面画过什么有关，
  // 同一个页面顺序渲染和乱序渲染能差 1 个像素（2026-11-20 在 006 V3 竖排透明底复现，18634a0）。
  // 关掉以后每次整块重画，同一个复现跑 4 轮×两种比例×两种背景全部一致。
  '--disable-partial-raster',
];

export const extraChromeArgs = () => String(process.env.HANZIFX_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);

export async function launchBrowser({ chrome } = {}) {
  const explicit = chrome || process.env.HANZIFX_CHROME;
  // 排查用：HANZIFX_EXTRA_ARGS="--a --b" 临时加启动参数；加了的会写进 manifest.json 的 env.extraChromeArgs
  if (process.env.HANZIFX_EXTRA_ARGS) CHROME_ARGS.push(...extraChromeArgs().filter((a) => !CHROME_ARGS.includes(a)));
  const errors = [];
  if (explicit) {
    const browser = await chromium.launch({ executablePath: explicit, headless: true, args: CHROME_ARGS });
    return { browser, kind: 'custom', path: explicit, version: browser.version() };
  }
  try {
    const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    return { browser, kind: 'chrome-headless-shell', version: browser.version() };
  } catch (e) { errors.push(`chrome-headless-shell：${e.message.split('\n')[0]}`); }
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
    return { browser, kind: 'chrome', version: browser.version() };
  } catch (e) { errors.push(`本机 Chrome：${e.message.split('\n')[0]}`); }
  const err = new Error('找不到能用的浏览器。装 Google Chrome，或者运行：npx playwright-core install --only-shell chromium\n' + errors.join('\n'));
  err.code = 'NO_BROWSER';
  throw err;
}

/** 开一个渲染页并挂载风格。cfg 直接传给页面里的 hanzifx.boot */
export async function openRenderPage(browser, baseUrl, cfg) {
  const context = await browser.newContext({
    viewport: { width: cfg.width, height: cfg.height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${baseUrl}/engine/render/index.html`);
  await page.waitForFunction(() => window.hanzifxReady === true);
  let info;
  try {
    info = await page.evaluate((c) => window.hanzifx.boot(c), cfg);
  } catch (e) {
    throw new Error(`页面挂载失败：${e.message}\n${logs.join('\n')}`);
  }
  if (info.dpr !== 1 || info.viewport[0] !== cfg.width || info.viewport[1] !== cfg.height) {
    throw new Error(`视口不对：dpr=${info.dpr} viewport=${info.viewport}，应为 1 和 ${cfg.width}x${cfg.height}`);
  }
  // 截图两条路：
  // - 不透明底：直接走 CDP，开 optimizeForSpeed（PNG 压缩快很多，仍然无损、结果确定）；
  // - 透明底：走 Playwright 的 omitBackground。实测 CDP 直接截图在整帧全透明时会丢掉 alpha 通道，
  //   存成不透明的 RGB（第一帧还没出字时就是这样），Playwright 这条路空帧也保留 alpha。
  // 两条路都核对 PNG 的颜色类型，不对就直接报错，不让错的帧混进成片。
  const cdp = await context.newCDPSession(page);
  const alpha = cfg.background === 'transparent';
  const capture = async () => {
    let buf;
    if (alpha) {
      buf = await page.screenshot({ type: 'png', omitBackground: true, caret: 'hide', scale: 'css' });
    } else {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png', optimizeForSpeed: true, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: cfg.width, height: cfg.height, scale: 1 },
      });
      buf = Buffer.from(data, 'base64');
    }
    const colorType = buf[25]; // IHDR 里的颜色类型：2=RGB，6=RGBA
    if (alpha && colorType !== 6) throw new Error(`透明底截图丢了 alpha 通道（PNG 颜色类型 ${colorType}）`);
    if (buf.readUInt32BE(16) !== cfg.width || buf.readUInt32BE(20) !== cfg.height) {
      throw new Error(`截图尺寸不对：${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}，应为 ${cfg.width}x${cfg.height}`);
    }
    return buf;
  };
  // 复位帧：先 seek 到固定时刻，截一个 1×1 的小图逼浏览器真画一帧（只为了让「上一帧画的是什么」每次都一样）。
  // 用法：每截一帧之前调一次，画面就跟渲染顺序无关。实验开关，见 pipeline 的 resetFrame。
  const settle = async (t) => {
    await page.evaluate((x) => window.hanzifx.seek(x), t);
    await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  };
  return { context, page, info, logs, capture, settle };
}

/**
 * 用 Chrome 开发者协议 CSS.getPlatformFontsForNode 查每个文字节点实际用了哪款字体、画了多少个字形。
 * 有回退到系统字体的话，这里会多出一个 isCustomFont=false 的条目。
 */
export async function probeFonts(page, selector = 'svg text') {
  // 先等两帧，保证排版和绘制都做完；不等的话 getPlatformFontsForNode 会返回空
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  const agg = new Map();
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    for (const f of fonts) {
      const key = `${f.familyName}|${f.postScriptName || ''}|${f.isCustomFont}`;
      const cur = agg.get(key) || { familyName: f.familyName, postScriptName: f.postScriptName, isCustomFont: f.isCustomFont, glyphCount: 0 };
      cur.glyphCount += f.glyphCount;
      agg.set(key, cur);
    }
  }
  await cdp.detach();
  return { nodes: nodeIds.length, fonts: [...agg.values()] };
}
