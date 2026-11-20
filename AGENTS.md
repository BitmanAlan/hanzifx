# AGENTS.md

给在这个仓库里干活的 AI agent 看的地图。只是想**用**这个库做视频，读 `skills/hanzifx/SKILL.md` 就够了；要**改**这个库（写新风格、修底座、改文档），先读这一份。
A map for AI agents working on this repo. To **use** the library, read `skills/hanzifx/SKILL.md`. To **change** it, read this first.

## 仓库结构 / Layout

| 路径 | 是什么 |
|---|---|
| `styles/<编号>-<slug>/` | 一个风格一个文件夹：`style.js`（代码）、`meta.json`（参数的唯一来源）、`STYLE.md`（风格说明，15 节）、`demo/`（海报、动图） |
| `engine/src/` | 浏览器里跑的部分：宿主、排版、分词接口、共用动作、种子随机数。风格只能 import 这里的模块 |
| `engine/cli/` | 命令行：导出、检查、逐帧一致、字体、自检、索引表 |
| `engine/fonts/registry.json` | 字体登记表：每款字体的下载地址、sha256、许可证。字体文件不进仓库，用 `npm run fonts` 下载 |
| `engine/docs/写一个新风格.md` | 风格代码的契约和硬规矩，写风格前必读 |
| `docs/STYLE-TEMPLATE.md` | STYLE.md 的 15 节结构 |
| `skills/hanzifx/` | 给 agent 装的 skill，`scripts/list-styles.mjs` 列出全部风格 |
| `scripts/` | 安装脚本、发布自检 |

## 常用命令 / Commands

都在 `engine/` 目录下跑（Node 20 以上，要 ffmpeg）：

```bash
npm install && npm run fonts && npm run doctor   # 装依赖、下载字体并核对 sha256、自检
npm run check -- --style styles/<风格>           # 中文排版检查：词中间断行、标点在行首、缺字、描边被裁
npm run determinism -- --style styles/<风格>     # 乱序渲染和顺序渲染是否逐帧一致
npm test                                         # 单元测试，包括每个风格的 meta 字段
npm run dev                                      # 本机试玩台
```

导出：`node cli/export.mjs --style styles/<风格> --text "要显示的字" --out <目录>`，透明底加 `--bg transparent`。参数以 `node cli/export.mjs --help` 为准。

## 改动时守的规矩 / Rules

1. **逐帧一致**：`seek(t)` 只看 t；不用真实时钟和 `Math.random()`，随机全走 `engine/src/lib/rand.js` 的种子；不给整组做透明度动画；倾斜的东西不带模糊滤镜；文字不做非等比缩放。细节和原因在 `engine/docs/写一个新风格.md` 第 3 节。
2. **中文排版**：断行只断在词边界上（用宿主给的 `ctx.segment`），标点不在行首，不缺字。`npm run check` 不能有 ✗。
3. **原创**：图形和图标自己画，不仿任何平台的界面和 logo；不拷第三方代码和素材；字体只用登记表里可再分发的（SIL OFL 一类）。
4. **编号永不重排**：新风格先用 `draft-<slug>` 当文件夹名，合并时由维护者分配编号。
5. **数字不手改**：README 里的风格数和索引表由 `node engine/cli/catalog.mjs` 从 meta 生成。
6. 提交前跑 `node scripts/release-audit.mjs`：不能有本机路径、密钥、别人的视频链接。

## 交付给用户时 / When delivering to a user

照实说：用了哪个风格、哪些参数、分词怎么切的、检查有没有提示项；透明底说清导出的是什么格式（ProRes 4444 的 .mov、VP9 的 .webm、PNG 序列），不替用户保证某个剪辑软件一定认。
