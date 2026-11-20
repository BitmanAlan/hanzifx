<!-- README.md 由 docs/README.template.md 生成。要改内容就改模板，再在 engine 目录跑：
     node cli/catalog.mjs --template ../docs/README.template.md --readme ../README.md
     字效数、互动元素数和「全部风格」那张表，都是脚本从各风格的 meta.json 数出来、生成的，别在 README.md 里手改。 -->

# hanzifx · 中文字效库

<p align="center"><img src="docs/media/hero.webp" width="100%" alt="hanzifx 的字效快切：大字报、一词一屏字幕、竖排诗句、文字快闪、拟声词爆炸字、逐字点亮字幕、划掉改字，最后朱红印章按下一排糖果按钮，三连引导的点赞、投币、收藏一起亮起来"></p>
<p align="center"><a href="https://bitmanalan.github.io/hanzifx/">在线画廊（直接改字试玩）</a> · <a href="https://github.com/BitmanAlan/hanzifx/releases/tag/v0.1.0">完整宣传片和全部样片</a></p>

**给 AI agent 用的中文短视频字效库：{{风格数}} 个字效、{{互动数}} 个互动元素，说一句话，就能做出综艺花字、大字报封面、口播字幕、竖排诗句和片尾互动动画。**

让 agent 做出排对了的中文花字：不在词中间断行，标点不跑到行首，竖排的标点也放对。

<p align="center"><img src="docs/media/collage-fx.webp" width="100%" alt="{{风格数}} 个字效的招牌造型：{{字效名单}}"></p>
<p align="center"><sub>字效：{{字效名单}}</sub></p>

<p align="center"><img src="docs/media/collage-interactive.webp" width="100%" alt="{{互动数}} 个互动元素的招牌造型：{{互动名单}}"></p>
<p align="center"><sub>互动元素（按元素外框裁出来放大，叠在视频上用）：{{互动名单}}</sub></p>

每一格都是对应风格的招牌造型，由本库代码直接导出，只做了拼版和裁切，没有别的后期。

`代码 MIT` · `风格说明 CC BY-NC 4.0` · `风格代码零依赖` · `中文专项检查` · `逐帧一致`

[English](README.en.md) · [为什么给 agent 用](#为什么给-agent-用) · [一句话开工](#一句话开工) · [怎么叫](#怎么叫) · [全部风格](#全部风格) · [导出什么](#导出什么) · [开始之前](#开始之前) · [更新和卸载](#更新和卸载) · [做你自己的风格](#做你自己的风格) · [限制](#限制) · [常见问题](#常见问题) · [负责任地用](#负责任地用)

---

## 为什么给 agent 用

这个库是写给 agent 用的。你用中文说要什么，剩下的 agent 自己做：

- **一句话装好**。把仓库地址发给 agent，说「帮我装好 hanzifx」。它会装依赖、下载字体并核对 sha256、跑自检，再把 skill 链接到本机的 agent 目录里。
- **agent 自己挑风格**。每个风格都写清了适合做什么、不适合做什么、不适合的时候换哪个。你没说编号，agent 会挑一个，告诉你挑了哪个、为什么，然后直接做。
- **先检查分词，再导出**。中文没有空格，断行断在哪里，要先分词才知道。检查会把分词结果一行打出来，agent 看到切错的地方，就用 `|` 标出能断开的位置再导出。词中间断行、标点在行首、描边被画面边缘切掉、缺字，检查都会报出来，不会悄悄出片。
- **结果可以核对**。每次导出都带一份 `manifest.json`（输入参数、浏览器版本、字体、逐帧 sha256、全部检查结果）和一份 `timeline.json`（入场、停留、出场的时间段，每个字落地的时刻，带帧号）。agent 拿它核对结果，也能拿来卡音乐和音效。
- **同样的输入，每一帧都一样**。随机效果全部走种子；4 路乱序截图和 1 路顺序截图逐帧比对一致（范围见[限制](#限制)）。

实测：用下面[怎么叫](#怎么叫)那 5 句话，各开一个全新的 Claude Code 会话，只给一句话。5 句全部做对，平均每条 1.17 美元（0.94 到 1.47），一般 2.5 分钟左右；带 30 秒真实口播对齐的那条用了 7.5 分钟，大部分时间在导出视频。明细见 [`skills/hanzifx/tests/RESULTS.md`](skills/hanzifx/tests/RESULTS.md)。只在 Claude Code 上测过，别的 agent 没测。

---

## 一句话开工

把这句话发给你的 agent：

> 帮我装好 hanzifx（https://github.com/BitmanAlan/hanzifx），然后用 005 把「床前明月光，疑是地上霜。举头望明月，低头思故乡。」做成竖排诗句，署名「唐·李白」。

agent 会克隆仓库，运行 `bash scripts/install_skill.sh` 装依赖、下载字体、跑自检、链接 skill，再检查、导出一条竖屏 mp4。

想自己装：

```bash
git clone https://github.com/BitmanAlan/hanzifx hanzifx
cd hanzifx
bash scripts/install_skill.sh     # 装依赖、下载字体并核对 sha256、自检，再链接 skill；可以重复运行
```

`install_skill.sh` 会把 skill 链接到本机已经有的这几个目录：`~/.claude/skills`（Claude Code）、`~/.codex/skills`（Codex）、`~/.agents/skills`、`~/.dsh/skills`（DeepSeek Harness）。只想装依赖和字体、不链接 skill，用 `NO_LINK=1 bash scripts/install_skill.sh`。Codex 和 DeepSeek Harness 的目录是照它们的公开文档写的，还没实测。

不用 agent，自己跑：

```bash
cd engine
npm run check  -- --style styles/005-vertical-verse --text "床前明月光，疑是地上霜。举头望明月，低头思故乡。"
npm run export -- --style styles/005-vertical-verse --text "床前明月光，疑是地上霜。举头望明月，低头思故乡。" --set author="唐·李白"
```

---

## 怎么叫

### 拿来就能用的说法

每句都能直接复制给 agent。`*…*` 标出的是要突出的关键词。这 5 句也是 skill 的测试用例。

1. 用 002 把「普通人用AI最大的误区，是把它当*搜索引擎*」做成大字报，要封面效果。
2. 用 005 把「春眠不觉晓，处处闻啼鸟。夜来风雨声，*花落*知多少。」做成竖排诗句，署名「唐·孟浩然」，水墨卷轴。
3. 用 001 把「这也太*好笑*了吧」做成综艺花字，透明底，我要叠在视频上。
4. 用 004 给这段口播配一词一屏字幕，这是逐字时间文件（没有的话按语速估）。
5. 用 006 做一个三连引导，横排，透明底，放在片尾。

### 没想好用哪个

不用记编号，直接说要做什么：

> 我要给一条讲理财的口播做个开头，前 2 秒抓眼球。

agent 会照每个风格写的「适合」「不适合（换哪个）」挑一个，比如 002 大字报的招牌造型：一段话排满画面，关键词那行最大，适合观点口播的开头。要是你想整条都配字幕，它会告诉你换 004。

### 两个造型

每个风格都有**默认**造型（日常用）和**招牌**造型（更夸张，适合封面、开头、样片）。说「要封面效果」「要夸张一点」，agent 就用招牌造型。配色、节奏、种子也都能换，参数写在每个风格的 `meta.json` 里。

---

## 全部风格

字效 {{风格数}} 个，互动元素 {{互动数}} 个。每个风格一个目录，`STYLE.md` 写了它的做法、参数、坑和检查结果，`demo/` 里有海报和动图。「适合发哪」标了「（推断）」的，是我们没在那个平台量过、按用途推断的。「状态」一列里的「原型可用」是说：能用，检查都过了，参数和画法以后还可能调整。

<!-- hanzifx:styles-index:start -->
<!-- hanzifx:styles-index:end -->

---

## 导出什么

- **成片**：MP4，竖屏 9:16、横屏 16:9、方形 1:1 都行。字效默认带一个演播室背景，方便直接看效果。
- **透明底素材**：ProRes 4444 的 `.mov` 和 VP9 的 `.webm`，都带透明通道；也可以导出 PNG 序列。互动元素默认就导出透明底，叠在你自己的视频上用。
- **只要一张图**：按风格设定的海报时刻截一张 PNG，或者截任意时刻（`--poster`、`--still`）。
- **每次导出都带**：`manifest.json`、`timeline.json`，还有这次用到的字体子集。

---

## 开始之前

要装三样东西：

1. **Node 20 或更新的版本**。
2. **ffmpeg**（带 ffprobe）。macOS 运行 `brew install ffmpeg`，Windows 运行 `winget install ffmpeg`，Linux 运行 `apt install ffmpeg`。导出 mp4 要 libx264，导出透明底要 ProRes 和 VP9 编码器。
3. **一个浏览器**。`install_skill.sh` 会自动下载一个版本锁死的无头浏览器（约 100 MB），逐帧结果最稳，没装 Chrome 的机器也能导出。不想下载就用 `NO_BROWSER=1 bash scripts/install_skill.sh`，改用本机的 Google Chrome；Chrome 自动升级以后，逐帧结果可能跟别人的对不上。不用安装脚本的话，自己装：`cd engine && npx playwright-core install --only-shell chromium`。两个都在的话优先用无头浏览器。

出问题先跑 `cd engine && npm run doctor`，它会一条条列出缺什么、怎么补。

- **字体**：`npm run fonts` 从 Google Fonts 的官方仓库下载，并核对 sha256。全部是 OFL 许可，可以商用。导出时只把这次用到的字做成子集，打包进去。
- **要多久**：在我们的开发机上（Apple M5 Pro、48 GB 内存、macOS 26.5），一条 3 到 4 秒的竖屏互动元素，4 路并行截图 5 到 7 秒，再加上编码。
- **哪些风格要额外的输入**：
  - 004 一词一屏字幕：想卡准时间，要给逐字时间。SRT 字幕、whisper 的结果都能转成逐字时间，工具是 `styles/004-word-pop-captions/tools/to-words.mjs`；不给就按语速估。
  - 007 文字快闪：要卡音乐节拍，就用 `--beats` 传入拍点（秒）。
  - 其他风格只要一句文字。
- **试玩**：`cd engine && npm run dev`，打开 http://127.0.0.1:5180/engine/player/，可以拖时间轴、改字、换配色和造型，再复制导出命令。

---

## 更新和卸载

- **更新**：在仓库目录里 `git pull`，再跑一遍 `bash scripts/install_skill.sh`。它会按新代码补上依赖、字体和无头浏览器，再把 skill 链接重新指一遍，可以重复运行。
- **卸载**：
  1. 删掉 skill 链接。安装脚本在下面这几个目录里各建了一个叫 `hanzifx` 的链接（只建在你机器上已经有的目录里）：`~/.claude/skills/hanzifx`、`~/.codex/skills/hanzifx`、`~/.agents/skills/hanzifx`、`~/.dsh/skills/hanzifx`。比如 `rm ~/.claude/skills/hanzifx`。它们只是链接，删掉不会动到仓库。
  2. 删掉仓库目录。依赖、字体、导出的中间文件都在仓库目录里，一起删掉。
  3. 无头浏览器在 Playwright 的公共缓存目录里（macOS 是 `~/Library/Caches/ms-playwright`，Linux 是 `~/.cache/ms-playwright`）。别的项目可能也在用，确定没用了再删。

---

## 做你自己的风格

一个风格就是一个目录：`style.js` 画画面，`meta.json` 写参数、配色、节奏和造型，`STYLE.md` 写做法和检查结果。

- 模板：[`docs/STYLE-TEMPLATE.md`](docs/STYLE-TEMPLATE.md)。
- 写法和硬规矩：[`engine/docs/写一个新风格.md`](engine/docs/写一个新风格.md)。比如透明度只设在单个图形上，文字不做非等比缩放；不守这些，乱序渲染会对不上。
- 交之前跑三样：`npm run check`（中文专项检查）、`npm run determinism`（逐帧一致）、`node cli/catalog.mjs`（字段齐不齐）。
- 怎么提交：[`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## 限制

- **逐帧一致有三个条件**：同一台机器、同一个浏览器版本、底座默认的启动参数。换机器、换操作系统、换浏览器版本还没测。
- **分词还会切错**：分词靠词表加规则。我们拿一批全新的句子测过（写词表的人事先没看过）：109 句里整句切对的占 56.0%，有 43 处切在了词中间；浏览器自带的分词是 12.8%、144 处。最容易切错的是新出的品牌名和网络热词。检查会把分词结果打出来，看到切错就用 `|` 标出能断开的位置。
- **「适合发哪」大多是推断**：我们只量过两轮抖音成片，标了「（推断）」的都没在那个平台量过。
- **安全区是经验值**：底部 20%、右侧 15% 留给平台的按钮和文字，没有官方规范。
- **头像只能是字**：008 账号名片卡、010 评论卡的头像，现在只能用名字的第一个字，还不能换成图片。

---

## 常见问题

**字体为什么要另外下载？**
字体文件大，又各有自己的许可证，所以不放进仓库。`npm run fonts`（安装脚本会自动跑）从官方仓库下载，逐个核对 sha256；全部是 OFL 1.1，可以商用。导出时只把这次用到的字做成子集。国内下载慢，可以用 `HANZIFX_FONTS_MIRROR` 换镜像地址，写法见 [`engine/FONTS.md`](engine/FONTS.md)。

**做出来的视频能商用吗？**
能。你用本库做出来的视频归你，可以商用，不用署名；代码是 MIT。不能拿去卖的是风格说明文档本身。完整条款见 [`docs/LICENSING.md`](docs/LICENSING.md)。

**「逐帧一致」是什么意思？**
同样的文字和参数，用 4 路乱序截图和 1 路顺序截图，导出来每一帧的 sha256 都一样；随机效果全部走种子。所以同一句话重出一遍，得到的是同一条片子，agent 也能拿 `manifest.json` 里的逐帧 sha256 核对。前提是同一台机器、同一个浏览器版本、底座默认的启动参数（见[限制](#限制)）。

**分词切错了怎么办？**
看检查打出来的「分词」那一行，在原文里用 `|` 标出能断开的位置，比如 `这也太|好笑了吧`，再检查一遍；也可以把这个词用 `*…*` 标住，标成关键词。

**要什么环境？**
Node 20 或更新、ffmpeg、一个浏览器。安装脚本会自动下载版本锁死的无头浏览器，也可以用本机的 Google Chrome（见[开始之前](#开始之前)）。开发和实测都在 macOS 上做；GitHub 上的自动测试在 Ubuntu 上跑单元测试和各项检查，没在 Linux 上导出过成片；Windows 没测过。

---

## 负责任地用

- 007 文字快闪默认按 WCAG 2.3.1 限制闪烁（任意 1 秒内不超过 3 次），超标就不导出。要强闪烁，得显式写 `flashMode=strong`，导出时会提示光敏风险，并记进 `manifest.json`。
- 互动元素（点赞、关注、评论卡这些）的图标和版式是本项目自己画的，不仿任何平台的界面。别拿它们冒充平台的官方界面或数据，比如伪造粉丝数、点赞数的截图。
- 字体照各自的许可证用，都是 SIL OFL 1.1。

---

## 许可证

一句话：**代码随便用；你用它做出来的片子归你，可以商用；风格说明文档不能拿去卖。** 条款以 [`docs/LICENSING.md`](docs/LICENSING.md) 为准；根目录的 `LICENSE` 是 MIT 原文，只管代码。

- **代码**：`engine/`、`scripts/`、`skills/` 里的脚本，每个风格的 `style.js` 和 `meta.json`，风格自己画的图标，都是 MIT。
- **风格说明文档**：每个风格的 `STYLE.md`、`docs/` 里的文档、skill 的 `SKILL.md`，是 CC BY-NC 4.0，另外加一条做片许可：你和一起做片的人可以照着做、改编，用来做自己的视频，商业片和给客户做的片子都行。拿去卖，或者放进营利的产品和服务里，要另外拿商业授权，联系方式写在 [`docs/LICENSING.md`](docs/LICENSING.md) 里。
- **样片、海报、动图**：CC BY 4.0。
- **字体**：都是 SIL OFL 1.1，字体文件不在仓库里，由 `npm run fonts` 从官方仓库下载；许可证在 `engine/fonts/LICENSES/`。
- **你用本库做出来的视频**：归你，可以商用，不用署名。

---

觉得有用的话，点个 Star，能让更多做中文短视频的人看到它。

[![Star History](https://api.star-history.com/svg?repos=BitmanAlan/hanzifx&type=Date)](https://star-history.com/#BitmanAlan/hanzifx&Date)
