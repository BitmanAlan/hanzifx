# 安全 / Security

## 报告漏洞 / Reporting a vulnerability

发现安全问题，请**不要**开公开 issue。用 GitHub 的私密漏洞报告：仓库页面 → Security → Report a vulnerability。写清楚影响哪个文件或命令、怎么复现、你看到了什么。我们会在 7 天内回复。
Please do **not** open a public issue. Use GitHub's private vulnerability reporting (Security → Report a vulnerability) with the affected file or command, steps to reproduce, and what you observed. We aim to reply within 7 days.

## 这个库会做什么 / What the code does

- 导出时在本机起一个只监听 127.0.0.1 的临时静态服务，用无头浏览器逐帧截图，再调用本机的 ffmpeg 合成。导出结束服务就关掉。
- 只有下载这三样东西时联网：`npm install` 装依赖；`npm run fonts` 按 `engine/fonts/registry.json` 里写死的地址下载字体（设了 `HANZIFX_FONTS_MIRROR` 就先试镜像地址），不管从哪里下的，每个文件都核对 sha256，对不上就拒绝使用（导出时发现缺字体，也会照同样的地址和校验补下载）；`scripts/install_skill.sh` 还会用 Playwright 下载一个版本锁死的无头浏览器（加 `NO_BROWSER=1` 就不下载，改用本机的 Chrome）。
- 风格代码不联网、不读本机文件、不用真实时钟。用户给的字级时间文件只在导出时读一次。
- 没有遥测，不上传任何数据。

- Export starts a temporary static server bound to 127.0.0.1, captures frames with a headless browser, and encodes them with your local ffmpeg. The server stops when the export finishes.
- The code goes online only to download three things: dependencies (`npm install`); fonts (`npm run fonts`), from the pinned URLs in `engine/fonts/registry.json`, or the `HANZIFX_FONTS_MIRROR` mirror first if set, with every file's sha256 checked and rejected on mismatch wherever it came from (an export that finds a font missing downloads it the same way); and a version-pinned headless browser (`scripts/install_skill.sh`, through Playwright; skip it with `NO_BROWSER=1` to use your installed Chrome).
- Style code never touches the network, the local file system or the real clock. No telemetry.

## 支持的版本 / Supported versions

只修最新发布的版本。
Only the latest release receives fixes.
