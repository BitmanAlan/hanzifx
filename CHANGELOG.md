# 更新日志 / Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按[语义化版本](https://semver.org/lang/zh-CN/)。风格编号一旦发布就不再改动，新增风格只往后排号。
Format follows Keep a Changelog; versions follow SemVer. Style numbers never change once released; new styles get new numbers.

## [0.1.0] - 2026-11-21

第一次公开发布。 First public release.

### 字效 / Text styles

- 001 综艺花字 · Variety Outline
- 002 大字报 · Big Poster
- 003 书法标题 · Brush Title
- 004 一词一屏字幕 · Word Pop Captions
- 005 竖排诗句 · Vertical Verse
- 007 文字快闪 · Type Flash
- 017 拟声词爆炸字 · Sound Burst
- 018 逐字点亮字幕 · Karaoke Captions
- 019 烫金字 · Gold Foil
- 020 划掉改字 · Strike & Rewrite
- 021 聊天气泡对话 · Chat Bubbles
- 023 杂志封面标题 · Magazine Cover

### 互动元素 / Interactions

- 006 三连引导 · Triple Tap
- 008 账号名片卡 · Profile Card
- 009 评论区告诉我 · Comment Prompt
- 010 评论卡 · Comment Card
- 011 倒计时 · Countdown
- 012 对错判断 · Right or Wrong
- 013 价格标签 · Price Tag
- 014 上滑看下一集 · Swipe Up
- 015 点赞收藏引导 · Single Tap
- 016 二选一投票条 · Vote Bar

每个风格至少有两个造型（日常、招牌）和至少 4 套配色。互动元素默认用亮面糖果质感（有厚度、白亮边、高光，按下去会陷），也可以切回平面（`material=flat`）。
Every style ships at least two looks (everyday and showcase) and at least four palettes. Interactions default to a glossy candy material (thickness, white rim, highlights, press-in); `material=flat` switches back to flat.

### 底座和工具 / Engine and tools

- 一个风格就是一个纯函数，同一份代码在浏览器里试玩，也能导出 MP4，或导出透明底（ProRes 4444 `.mov`、VP9 `.webm`、PNG 序列）。
  A style is a pure function: the same code plays live in the browser and exports MP4 or transparent video (ProRes 4444 `.mov`, VP9 `.webm`, PNG sequence).
- 中文排版检查：词中间断行、行首标点、描边被画面边缘切掉、缺字，加上闪烁检查（按 WCAG 2.3.1）。检查会把分词结果打出来，切错了在原文里用 `|` 标出能断开的位置。
  Chinese typesetting checks: no line breaks inside words, no punctuation at line start, no clipped outlines, no missing glyphs, plus a flash check based on WCAG 2.3.1. The check prints its segmentation; mark break points with `|` to correct it.
- 逐帧一致检查（`npm run determinism`）：乱序渲染和顺序渲染逐帧比对。
  Frame determinism check: out-of-order and in-order renders are compared frame by frame.
- 在线画廊：卡片墙直接跑风格代码，原地改字、切换造型、复制调用句。
  Online gallery: every card runs the real style code; edit the text in place, switch looks, copy the prompt.
- agent skill 和安装脚本；字体按固定地址和 sha256 下载，可以换镜像（`HANZIFX_FONTS_MIRROR`）。
  Agent skill and install script; fonts download from pinned URLs checked by sha256, with a mirror option (`HANZIFX_FONTS_MIRROR`).
