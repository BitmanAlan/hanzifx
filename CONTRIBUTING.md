# 怎么参与 / Contributing

谢谢你想一起做！先读这几条，能省你和我们很多来回。
Thanks for helping! A few rules first.

## 想要一个新风格 / Request a style

开一个 issue，选「请求一个风格」：贴一张参考截图或者一段视频的链接，说清你想用在哪类视频上。
中文排版不对（词被拆开、标点放错），选「中文排版不对」；命令报错，选「导出或检查出错」。
Open an issue using "Request a style": attach a reference screenshot or link, and say what kind of video it's for.
For a word split across lines or misplaced punctuation, use "Chinese typesetting problem"; for a failing command, use "Export or check fails".

## 自己写一个风格 / Write a style

1. 照 `engine/docs/写一个新风格.md` 写，例子是 `styles/001-variety-outline/`。
2. 风格说明按 `docs/STYLE-TEMPLATE.md` 的 15 节写。
3. 编号：新风格先用 `draft-<英文名>` 当文件夹名，合并的时候由维护者分配正式编号。编号永远不重排。
4. 交之前自己跑通：
   ```bash
   cd engine
   npm run check -- --style styles/<你的风格>
   node cli/determinism.mjs --style styles/<你的风格> --rounds 2
   npm test
   ```
   中文检查不能有 ✗；乱序渲染和顺序渲染必须逐帧一致。
5. 不能用的东西：别人的代码和素材（除非许可证允许并写明出处），平台的图标、品牌色和 logo，没有可再分发许可的字体（字体只用 SIL OFL 这一类，要先在 `engine/fonts/registry.json` 登记）。

## 许可 / License

提交贡献要先同意 `CLA.md`（草稿，正式启用前会请法务审）。CLA 正式启用以前，改动风格说明文档（各风格的 `STYLE.md`、`docs/` 里的文档）的 PR 先不合并，代码的 PR 照常合并。代码按 MIT 发布，风格说明文档按 CC BY-NC 4.0 加做片许可发布，详见 `docs/LICENSING.md`。
Contributions require agreeing to `CLA.md` (draft, pending legal review). Until the CLA takes effect, pull requests that change style docs (`STYLE.md` files and `docs/`) will not be merged; code pull requests are merged as usual. See `docs/LICENSING.md` for how each part is licensed.
