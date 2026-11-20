// 试玩页实测：真鼠标拖时间轴、真键盘打字、点配色/种子/比例，逐项核对画面真的变了。
// 用法：node test/e2e/player.mjs [截图目录]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startServer } from '../../cli/lib/server.mjs';
import { launchBrowser } from '../../cli/lib/browser.mjs';

export async function runPlayerE2E(shotDir) {
  await mkdir(shotDir, { recursive: true });
  const server = await startServer();
  const { browser, kind, version } = await launchBrowser();
  const results = [];
  const errors = [];
  const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${server.url}/engine/player/?autoplay=0`);
    await page.waitForFunction(() => window.__player?.state.inst);
    const D = await page.evaluate(() => window.__player.state.inst.timeline.duration);
    const firstFill = () => page.evaluate(() => document.querySelector('#stage [data-layer=fill] text')?.getAttribute('transform'));
    await page.screenshot({ path: join(shotDir, 'player-1-打开.png') });

    // 1) 真鼠标拖时间轴：从 10% 拖到 55%
    const box = await page.locator('#scrub').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.1, y);
    await page.mouse.down();
    const tA = await page.evaluate(() => window.__player.state.t);
    const trA = await firstFill();
    await page.mouse.move(box.x + box.width * 0.55, y, { steps: 12 });
    await page.mouse.up();
    const tB = await page.evaluate(() => window.__player.state.t);
    const trB = await firstFill();
    const clock = await page.textContent('#clock');
    ok('拖时间轴：鼠标按下的位置', Math.abs(tA - 0.1 * D) < 0.03 * D, `t=${tA.toFixed(3)}，期望≈${(0.1 * D).toFixed(3)}`);
    ok('拖时间轴：拖到 55%', Math.abs(tB - 0.55 * D) < 0.03 * D, `t=${tB.toFixed(3)}，期望≈${(0.55 * D).toFixed(3)}；读数「${clock}」`);
    ok('拖动后画面跟着变', trA !== trB && trB, `第一个字 transform：${trA} → ${trB}`);
    await page.screenshot({ path: join(shotDir, 'player-2-拖到55%.png') });

    // 2) 真键盘改字
    await page.locator('[data-key=text] textarea').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('家人们谁懂啊');
    await page.waitForFunction(() => window.__player.state.inst?.params.text === '家人们谁懂啊');
    await page.evaluate(() => window.__player.ready());
    const after = await page.evaluate(() => ({
      n: document.querySelectorAll('#stage [data-layer=fill] text').length,
      chars: [...document.querySelectorAll('#stage [data-layer=fill] text')].map((t) => t.textContent).join(''),
      lines: window.__player.state.inst.layout.lines,
    }));
    ok('改字：画面上的字换了', after.chars === '家人们谁懂啊' && after.n === 6, `字：${after.chars}，断行：${after.lines.join(' | ')}`);
    await page.waitForFunction(() => window.__player.state.jiebaState === 'ready' && window.__player.state.inst?.segmentation.sources.includes('jieba+lexicon'), null, { timeout: 15000 });
    const seg = await page.evaluate(() => window.__player.state.inst.segmentation.paragraphs.map((p) => p.words.map((w) => w.text).join('/')).join(' ‖ '));
    ok('改字后浏览器里加载 jieba，切词跟 Node 端一致', seg === '家人们/谁懂啊', `浏览器切词：${seg}（Node 端：家人们/谁懂啊）`);
    await page.evaluate(() => window.__player.setT(window.__player.state.inst.timeline.segments[1].start + 0.3));
    await page.screenshot({ path: join(shotDir, 'player-3-改字.png') });

    // 3) 点配色 C3
    await page.locator('[data-key=palette] .chip[data-v=C3]').click();
    await page.waitForFunction(() => window.__player.state.inst?.params.palette === 'C3');
    await page.evaluate(() => window.__player.ready());
    const stop = await page.evaluate(() => document.querySelectorAll('#stage linearGradient stop')[1].getAttribute('stop-color'));
    ok('换配色 C3：渐变主色变成薄荷青', stop === '#90F2DE', `stop-color=${stop}`);

    // 4) 换种子
    const seedBefore = await page.evaluate(() => window.__player.state.inst.params.seed);
    await page.evaluate(() => window.__player.setT(window.__player.state.inst.timeline.segments[1].start + 0.3));
    const trS1 = await firstFill();
    await page.locator('[data-key=seed] button').click();
    await page.waitForFunction((s) => window.__player.state.inst?.params.seed !== s, seedBefore);
    await page.evaluate(() => window.__player.ready());
    const trS2 = await firstFill();
    const seedAfter = await page.evaluate(() => window.__player.state.inst.params.seed);
    ok('换种子：每个字的歪斜跟着变', trS1 !== trS2, `种子 ${seedBefore} → ${seedAfter}`);
    await page.screenshot({ path: join(shotDir, 'player-4-换配色和种子.png') });

    // 5) 切横屏
    await page.locator('#aspectSeg button[data-v="1920x1080"]').click();
    await page.waitForFunction(() => document.querySelector('#stage svg')?.getAttribute('width') === '1920');
    ok('切横屏：舞台变成 1920×1080', true, '');
    await page.evaluate(() => window.__player.ready());
    await page.evaluate(() => window.__player.setT(window.__player.state.inst.timeline.segments[1].start + 0.3));
    await page.screenshot({ path: join(shotDir, 'player-5-横屏.png') });

    // 6) 输入字体里没有的字：要明确报缺字
    await page.locator('[data-key=text] textarea').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('笑死😂');
    await page.waitForFunction(() => window.__player.state.inst?.params.text === '笑死😂');
    await page.evaluate(() => window.__player.ready());
    await page.waitForFunction(() => document.querySelector('#checks')?.textContent.includes('缺字'));
    const checks = await page.textContent('#checks');
    ok('缺字会明确报出来（主字体和备用字体都没有）', /缺字：「😂」在主字体和备用字体里都没有/.test(checks), checks.replace(/\s+/g, ' ').slice(0, 160));
    await page.locator('[data-key=text] textarea').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('王喆和李堃垚');
    await page.waitForFunction(() => window.__player.state.inst?.params.text === '王喆和李堃垚');
    await page.evaluate(() => window.__player.ready());
    await page.waitForFunction(() => document.querySelector('#checks')?.textContent.includes('备用字体'));
    const fbInfo = await page.evaluate(() => ({ chain: window.__player.state.inst.fontChain, checks: document.querySelector('#checks').textContent }));
    ok('主字体缺的字改用备用字体，并出警告', fbInfo.chain.includes('notosc-black') && /用了备用字体：「[喆堃垚]{3}」/.test(fbInfo.checks), `字体链 ${fbInfo.chain.join(' → ')}；${fbInfo.checks.replace(/\s+/g, ' ').slice(0, 140)}`);
    await page.evaluate(() => window.__player.setT(window.__player.state.inst.timeline.segments[1].start + 0.3));
    await page.screenshot({ path: join(shotDir, 'player-7-备用字体.png') });
    await page.screenshot({ path: join(shotDir, 'player-6-缺字提示.png') });

    // 7) 播放：空格开始播，时间往前走
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => window.__player.setT(0));
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
    const tPlay = await page.evaluate(() => window.__player.state.t);
    ok('空格播放：时间在走', tPlay > 0.3, `0.7 秒后 t=${tPlay.toFixed(2)}`);
    const cmd = await page.evaluate(() => window.__player.exportCommand());
    ok('复制导出命令：命令里带上了当前参数', cmd.includes('--palette C3') && cmd.includes('1920x1080'), cmd);
    ok('页面没有报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } finally {
    await browser.close();
    await server.close();
  }
  return { browser: `${kind} ${version}`, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.argv[2] || 'reports/player');
  const r = await runPlayerE2E(dir);
  for (const x of r.results) console.log(`${x.pass ? '✓' : '✗'} ${x.name}  ${x.detail || ''}`);
  await writeFile(join(dir, 'player-e2e.json'), JSON.stringify(r, null, 2));
  process.exit(r.results.every((x) => x.pass) ? 0 : 1);
}
