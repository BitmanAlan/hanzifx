# engine：中文字效渲染底座

一个风格就是一个纯函数：给文字、参数和时间 t，画出这一刻的画面。同一份风格代码可以在浏览器里拖着试玩，也可以导出竖屏或横屏的 MP4，或者导出透明底素材（ProRes 4444 的 mov、VP9 的 webm、PNG 序列）叠到别的视频上。

选型和理由见 `ADR-001-渲染路径.md`，字体见 `FONTS.md`，写新风格见 `docs/写一个新风格.md`，底座的整套验收结果见 `reports/P0-验收.md`。

## 开始之前

要装三样东西：

1. **Node 20 或更新的版本**（playwright-core 1.64 要求 20 以上）。
2. **ffmpeg**（带 ffprobe）。macOS 上运行 `brew install ffmpeg`，Windows 上运行 `winget install ffmpeg`，Linux 上运行 `apt install ffmpeg`。
3. **一个浏览器**。用仓库根目录的 `scripts/install_skill.sh` 安装的话，它会自动下载一个版本锁死的无头浏览器（约 100 MB），逐帧结果最稳（保证范围见下面「已知边界」）；不想下载就加 `NO_BROWSER=1`，改用本机的 Google Chrome。不用安装脚本就自己装：`npx playwright-core install --only-shell chromium`。两个都在的话，优先用锁死版本的那个。

```bash
cd engine
npm install
npm run fonts     # 下载字体并校验 sha256，生成试玩用的常用字子集（连不上 GitHub 见 FONTS.md「下载不下来怎么办」）
npm run doctor    # 自检：缺 ffmpeg、缺编码器、缺浏览器、缺字体，都会告诉你怎么补
```

## 常用命令

| 命令 | 干什么 |
|---|---|
| `npm run dev` | 起试玩台，打开 http://127.0.0.1:5180/engine/player/ |
| `npm run export -- --text "这也太好笑了吧"` | 导出竖屏 MP4（默认演播室背景） |
| `npm run export -- --text "…" --size 16:9` | 导出横屏 |
| `npm run export -- --text "…" --bg transparent` | 导出透明底（ProRes 4444 `.mov` 和 VP9 `.webm`；加 `--format mov,webm,png` 还有 PNG 序列） |
| `npm run export -- --text "这也太\|好笑了吧"` | 用 `\|` 自己指定在哪里可以断行（显示时会去掉） |
| `npm run export -- --palette C2 --rhythm R2 --seed 42 --set tilt=-8` | 换配色、节奏、种子，或改任意参数（参数名见风格的 `meta.json`） |
| `npm run export -- --beats 0.5,1.0,1.5` | 传入外部拍点（秒），给要卡音乐节拍的风格用 |
| `npm run export -- --style styles/002-big-poster --text "…" --poster --size 1080x1440` | 只截一张海报 PNG（按风格 `meta.posterTime`，不渲染整片）；`--still hold.mid,2.3` 截任意时刻（秒数、段名、`hold+0.3` 这类写法） |
| `npm run check -- --text "…"` | 中文专项检查：词中间断行、标点出现在行首、描边被画面边缘切掉、缺字（区分完全缺字和用了备用字体）、安全区。拍点、逐字时间跟 export 一样传（`--beats-file`、`--words-file`、`--words-offset`） |
| `npm test` | 单元测试 |
| `npm run test:e2e` | 试玩台实测（真鼠标拖时间轴、真键盘改字） |
| `npm run verify` | 底座的整套验收（逐帧一致、透明底、字体、检查工具），生成 `reports/P0-验收.md` |
| `node cli/demo.mjs --style styles/001-variety-outline` | 按 meta.json 的 demo 配置出样片（日常默认＋招牌，再加 `extraDemos` 里的）：MP4、720 宽动图、海报帧；条目里 `canvas` 指定画面尺寸（默认竖屏），`posterTime` 指定海报截哪一刻 |
| `node cli/catalog.mjs --template <模板> --readme <README>` | 从各风格的 meta.json 生成 README 的风格索引表（`--json` 出画廊卡片数据，`--check` 只核对是不是最新）；顺带检查 platforms、looks.role、样片文件齐不齐 |
| `npm run determinism -- --style styles/<风格> --set look=V3` | 逐帧一致自检：4 路乱序和 1 路顺序各渲染几轮，列出对不上的帧（写风格时的规矩见 `docs/写一个新风格.md` 第 3 节）。也收 `--beats-file`、`--words-file`、`--words-offset` |
| `node cli/board.mjs` | 审美对比板：几个造型变体并排，深色底和浅色杂乱底各一套，出对比图和对比片 |
| `node cli/seg-eval.mjs` | 分词评测（只读开发集） |
| `node cli/lexicon-build.mjs` | 从几份词表源文件生成 `src/lib/lexicon.js` |

每次导出的目录里有：成片、`manifest.json`（输入参数、环境版本、字体、逐帧 sha256、输出文件 sha256、全部检查结果）、`timeline.json`（入场、停留、出场的时间段和每个字落地的节拍，带帧号，别的程序可以拿来卡点）、`fonts/`（这次用的字体子集）。

## 目录

```
engine/
├── src/                 浏览器端（试玩台和导出页共用），零依赖
│   ├── host.js          加载风格、字体链、分词结果，挂载，按 t 渲染
│   ├── backdrop.js      预览背景（透明、棋盘格、演播室、纯色）
│   ├── jieba-browser.js 试玩台现场打字时才加载的分词器
│   ├── lib/             rand 种子随机数｜ease 缓动和弹簧｜text 断行和检查｜segment 分词三层｜lexicon 补充词表｜params 参数解析｜color 颜色角色｜words 字级时间
│   ├── motions/         共用动作：弹跳入场、缩小飞出、波浪晃动、阶梯抖动、震屏（带尾巴死区）、拍点查询、高光扫过、数字滚动、遮罩扫出、墨迹晕开
│   └── parts/           共用零件：底座块、按键、徽章、胶囊条，平面和亮面糖果两种质感（互动元素用）
├── render/              导出页（被无头浏览器逐帧截图）
├── player/              试玩台
├── cli/                 Node 端：export、check、doctor、fonts、verify、notice、serve
├── fonts/               registry.json、LICENSES/（字体源文件和子集不进仓库）
├── test/                单元测试和试玩台实测
└── reports/             验收报告
```

## 已知边界

- **逐帧一致有三个条件：同一台机器、同一个浏览器版本、底座默认的启动参数**（换了目录重跑也逐字节一致）。换机器、换操作系统、换浏览器版本还没测；用 `HANZIFX_EXTRA_ARGS` 临时改了启动参数的导出，清单 `manifest.json` 的 `env.extraChromeArgs` 会记下来，不算在保证范围里。
