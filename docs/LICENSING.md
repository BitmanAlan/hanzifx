# 许可证说明 / Licensing

根目录的 `LICENSE` 是 MIT 原文，管的是代码。仓库里还有不是代码的东西（风格说明文档、样片），它们各自的许可证以这份说明和每份文件里写的为准。
The root `LICENSE` is the MIT text and covers the code. The non-code parts (style docs, demos) are licensed as described here and in each file.

这个仓库里不同的东西用不同的许可证。一句话：**代码随便用；你用它做出来的片子归你，可以商用；风格说明文档不能拿去卖。**
Different parts of this repository use different licenses. In short: **use the code freely; the videos you make with it are yours, including commercially; don't sell the style docs.**

| 部分 / Part | 许可证 / License | 原文 / Text |
|---|---|---|
| 代码：`engine/`（连同里面的说明文档 `README.md`、`docs/`、`FONTS.md`、ADR）、`scripts/`、`skills/` 里的脚本、每个风格的 `style.js` 和 `meta.json`、风格自己画的图标 / Code: `engine/` (including its own docs: `README.md`, `docs/`, `FONTS.md`, the ADR), `scripts/`, scripts under `skills/`, each style's `style.js` and `meta.json`, icons drawn for the styles | MIT | `LICENSES/MIT.txt` |
| 风格说明文档：每个风格的 `STYLE.md`、`docs/` 里的文档（`docs/media/` 除外，见下一行）、skill 的说明 `SKILL.md` / Style docs (`STYLE.md`), `docs/` (except `docs/media/`, see next row), `SKILL.md` | CC BY-NC 4.0，另加下面的「做片许可」/ plus the film-making permission below | `LICENSES/CC-BY-NC-4.0.txt` |
| 样片、海报、动图（`styles/*/demo/`、`docs/media/` 和发布页里的） / Demo videos, posters and animations (`styles/*/demo/`, `docs/media/` and release assets) | CC BY 4.0 | `LICENSES/CC-BY-4.0.txt` |
| 字体 / Fonts | 各自的许可证，都是 SIL OFL 1.1；字体文件不在仓库里，由 `npm run fonts` 从官方仓库下载 / Each font's own license (all SIL OFL 1.1), downloaded by `npm run fonts` | `engine/fonts/LICENSES/`、`engine/FONTS.md` |
| 第三方代码和数据 / Third-party code and data | 各自的许可证 / Their own licenses | `NOTICE.md` |

## 你用本库做出来的视频 / Videos you make with this library

归你，可以商用，不用署名（写一句「用 hanzifx 做的」我们会很高兴）。你在视频里用到的第三方素材，照它们自己的许可证。
They are yours, including for commercial use, and no credit is required (a "made with hanzifx" is always welcome). Third-party material you put in your videos keeps its own license.

## 做片许可（加在 CC BY-NC 4.0 之上）/ Film-making permission (on top of CC BY-NC 4.0)

在 CC BY-NC 4.0 之外，我们另外许可你和跟你一起做片的人（员工、外包、客户），在全世界范围内、免费、非独占、不可撤销地阅读、照着做、复制和改编这些风格说明文档，用来做你们自己的视频，包括商业片和给客户做的片子；也可以把它们（或者你改过的版本）放进这部视频交付的工程文件里。
In addition to CC BY-NC 4.0, we grant you and the people working with you on a video (staff, contractors, clients) a worldwide, royalty-free, non-exclusive, irrevocable permission to read, follow, copy and adapt the style docs to make your own videos, commercial and client videos included, and to include them, or versions you adapted, in the project files you deliver for that video.

这条额外许可**不包括**：把风格说明文档（整份、部分或者改过的版本）拿去卖，或者放进以营利为目的的产品或服务里，不管收不收费。这类用法要另外拿商业授权：发邮件到 alan@sightvc.com，或者加微信 mingxuali。
This extra permission does **not** cover selling the style docs (whole, in part or adapted), or putting them into a product or service run for commercial advantage, paid or not. That needs a commercial license: email alan@sightvc.com, or add WeChat ID mingxuali.
