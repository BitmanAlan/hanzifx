# 字体清单（engine）

规矩：只用可以免费商用、允许再分发的字体（OFL 等）；每款都要有许可证原文、钉死的下载地址和 sha256；按实际用字做子集，本地加载，不联网拉字体；缺字报出来，不许悄悄回退到系统字体。

登记表是 `fonts/registry.json`（程序读它），许可证原文在 `fonts/LICENSES/`。完整字体文件体积大，不进仓库，`npm run fonts` 按下面的地址下载并校验 sha256。

## 站酷快乐体 ZCOOL KuaiLe（001 主字体）

| 项 | 值 |
|---|---|
| 登记名 | `kuaile`（网页里的字体名 `hanzifx-kuaile`） |
| 许可证 | SIL Open Font License 1.1，原文 `fonts/LICENSES/ZCOOLKuaiLe-OFL.txt` |
| 许可证出处 | https://raw.githubusercontent.com/google/fonts/6d49995f5d8f1c7d476760a580ffb89ce1e52c5d/ofl/zcoolkuaile/OFL.txt |
| 版权行 | Copyright 2018 The ZCOOL KuaiLe Project Authors (https://github.com/googlefonts/zcool-kuaile) |
| 保留字体名 | 无（版权行后面没有声明 Reserved Font Name，子集后保留原名合规） |
| 字体文件 | `ZCOOLKuaiLe-Regular.ttf`，1,514,968 字节 |
| 下载地址 | https://raw.githubusercontent.com/google/fonts/6d49995f5d8f1c7d476760a580ffb89ce1e52c5d/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf |
| sha256 | `812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d` |
| 上游源码 | https://github.com/googlefonts/zcool-kuaile |
| 覆盖 | cmap 7053 个码位；GB2312 一二级汉字 6763 个全有；常用中文标点全有；缺「①②③…⑩」；实测缺「喆堃垚」（GB2312 以外） |
| 嵌入许可 fsType | 0（可安装嵌入，没有限制） |
| 竖排特性 | 有 vert，没有 vrt2 |

## 站酷庆科黄油体 ZCOOL QingKe HuangYou（001 可选主字体）

| 项 | 值 |
|---|---|
| 登记名 | `huangyou`（`hanzifx-huangyou`） |
| 许可证 | SIL Open Font License 1.1，原文 `fonts/LICENSES/ZCOOLQingKeHuangYou-OFL.txt` |
| 许可证出处 | https://raw.githubusercontent.com/google/fonts/7f1b83ecdae8ccb7507fa6e06396e57bc0a5665d/ofl/zcoolqingkehuangyou/OFL.txt |
| 版权行 | Copyright 2018 The ZCOOL QingKe HuangYou Project Authors (https://www.github.com/googlefonts/zcool-qingke-huangyou) |
| 保留字体名 | 无 |
| 字体文件 | `ZCOOLQingKeHuangYou-Regular.ttf`，8,328,684 字节 |
| 下载地址 | https://raw.githubusercontent.com/google/fonts/7f1b83ecdae8ccb7507fa6e06396e57bc0a5665d/ofl/zcoolqingkehuangyou/ZCOOLQingKeHuangYou-Regular.ttf |
| sha256 | `54f0c0df4308cd74cd0f2fd3494ae054dbc4a1fd6fa7d71f4807eb4cdd8b4136` |
| 上游源码 | https://github.com/googlefonts/zcool-qingke-huangyou |
| 覆盖 | cmap 9429 个码位；GB2312 汉字全有；**缺间隔号「·」**；有「喆堃」，缺「垚」 |
| 嵌入许可 fsType | 0 |
| 竖排特性 | 没有 vert，也没有 vrt2（不要拿它做竖排） |

## 思源黑体 Noto Sans SC（备用字体，固定成 wght 900）

| 项 | 值 |
|---|---|
| 登记名 | `notosc-black`（`hanzifx-notosc-black`），`role: fallback` |
| 许可证 | SIL Open Font License 1.1，原文 `fonts/LICENSES/NotoSansSC-OFL.txt` |
| 许可证出处 | https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/OFL.txt |
| 版权行 | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' |
| 保留字体名 | **「Source」**。改过的版本（子集、固定字重都算修改）不能叫带「Source」的名字。这款字体自己的名字是 Noto Sans SC，不含「Source」，子集保留原名合规；我们网页里用的别名是 `hanzifx-notosc-black`，也不含 |
| 字体文件 | `NotoSansSC[wght].ttf`（可变字体，字重轴 100–900），17,772,300 字节 |
| 下载地址 | https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf |
| sha256 | `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da` |
| 上游源码 | https://github.com/notofonts/noto-cjk |
| 覆盖 | cmap 30890 个码位；GB2312 全有；「喆堃垚·」和「𰻞」都有 |
| 嵌入许可 fsType | 0 |
| 竖排特性 | vert 和 vrt2 都有。实测我们的子集流程会把它们和替换字形一起保留（「「，（」都有竖排字形）；破折号「—」没有竖排替换 |
| 坑 | 固定字重以后 name 表不跟着改，浏览器报的名字是「Noto Sans SC Thin」，字形实际是 900。核对字体时按子集文件自己的 name 表认，不按名字猜 |

**同一个文件另登记一档 Bold**（2026-11-19，给 006 按钮下的小字用）：登记名 `notosc-bold`（`hanzifx-notosc-bold`），`role: primary`，`variation` 取 wght 700。文件、下载地址、sha256、许可证都跟上面一样，没有新下载任何东西。

## 思源宋体 Noto Serif SC（005 竖排诗句用，登记两档：600 正文、900 印章）

| 项 | 值 |
|---|---|
| 登记名 | `notoserif-semibold`（wght 600，`hanzifx-notoserif-semibold`）、`notoserif-black`（wght 900，`hanzifx-notoserif-black`），同一个文件 |
| 许可证 | SIL Open Font License 1.1，原文 `fonts/LICENSES/NotoSerifSC-OFL.txt` |
| 许可证出处 | https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoserifsc/OFL.txt |
| 版权行 | Copyright 2012 Google Inc. All Rights Reserved. |
| 保留字体名 | 无 |
| 字体文件 | `NotoSerifSC[wght].ttf`（可变字体，字重轴 200–900），25,125,512 字节 |
| 下载地址 | https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf |
| sha256 | `050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9` |
| 覆盖 | cmap 30928 个码位；GB2312 全有；「喆堃垚·」都有；竖排标点（U+FE10–FE19、U+FE30–FE44）31 个全有 |
| 竖排特性 | vert、vrt2、vmtx 都有 |
| 嵌入许可 fsType | 0 |
| 坑 | 跟思源黑体一样，固定字重以后 name 表还是默认实例的名字（ExtraLight），按子集文件自己的 name 表认 |

## 三款书法字体（003 书法标题用）

钟齐志莽行书（默认）、马善政楷书（好认）、刘建毛草（最狂）。三款是同一批（2018 年 Google Fonts 收的中文书法字），许可证、覆盖、坑都一样，合在一节写。

| 项 | 钟齐志莽行书 Zhi Mang Xing | 马善政楷书 Ma Shan Zheng | 刘建毛草 Liu Jian Mao Cao |
|---|---|---|---|
| 登记名 | `zhimangxing`（`hanzifx-zhimangxing`） | `mashanzheng`（`hanzifx-mashanzheng`） | `liujianmaocao`（`hanzifx-liujianmaocao`） |
| 许可证 | OFL-1.1，`fonts/LICENSES/ZhiMangXing-OFL.txt` | OFL-1.1，`fonts/LICENSES/MaShanZheng-OFL.txt` | OFL-1.1，`fonts/LICENSES/LiuJianMaoCao-OFL.txt` |
| 许可证出处 | https://raw.githubusercontent.com/google/fonts/187e2123ad2710ad8c2fa9955332fe9073e834b1/ofl/zhimangxing/OFL.txt | https://raw.githubusercontent.com/google/fonts/406197b91ff39a93061c2c2eeaee67ddf2ae1f0d/ofl/mashanzheng/OFL.txt | https://raw.githubusercontent.com/google/fonts/1658caeec10ae203e8c3a46e7b4abbe6f129828a/ofl/liujianmaocao/OFL.txt |
| 版权行 | Copyright 2018 The Zhi Mang Xing Project Authors (https://github.com/googlefonts/zhimangxing) | Copyright 2018 The Ma Shan Zheng Project Authors (https://github.com/googlefonts/mashanzheng) | Copyright 2018 The Liu Jian Mao Cao Project Authors (https://www.github.com/googlefonts/liujianmaocao) |
| 保留字体名 | 无 | 无 | 无 |
| 字体文件 | `ZhiMangXing-Regular.ttf`，4,063,532 字节 | `MaShanZheng-Regular.ttf`，5,857,936 字节 | `LiuJianMaoCao-Regular.ttf`，4,951,804 字节 |
| 下载地址 | https://raw.githubusercontent.com/google/fonts/187e2123ad2710ad8c2fa9955332fe9073e834b1/ofl/zhimangxing/ZhiMangXing-Regular.ttf | https://raw.githubusercontent.com/google/fonts/406197b91ff39a93061c2c2eeaee67ddf2ae1f0d/ofl/mashanzheng/MaShanZheng-Regular.ttf | https://raw.githubusercontent.com/google/fonts/1658caeec10ae203e8c3a46e7b4abbe6f129828a/ofl/liujianmaocao/LiuJianMaoCao-Regular.ttf |
| sha256 | `644e0cae9b40f0b10ab729a01bd32032e3973bac22be3dccae01bf6ae7fde969` | `6d2546bb189c732a8ca29af9e22457b152387d158aa459e4ac2ce1e51788b7fb` | `cab396b91a5b7c0b4005a35891180d06e6751f5ac261fe680aec65c1ae209033` |
| 上游源码 | https://github.com/googlefonts/zhimangxing | https://github.com/googlefonts/mashanzheng | https://github.com/googlefonts/liujianmaocao |

- **覆盖**（2026-11-20 用 harfbuzz 读字符表，`cli/lib/fonts.mjs` 的 `unicodesOf`）：三款都是 cmap 7015 个码位，GB2312 一二级汉字 6763 个全有；**缺「喆堃垚」和间隔号「·」**，跟另外用 fontTools 查的结果一致。常用中文标点都有。
- **嵌入许可 fsType**：三款都是 0。
- **竖排**：三款都没有 `vert`/`vrt2`，也没有 `vmtx`（马善政只有一个 `fwid`）。竖排题字不放标点，或者标点从思源宋体借。
- 名字表就是上面的英文名，不含任何保留字体名，子集保留原名合规。

## JetBrains Mono（等宽拉丁字体，登记两档：500、700）

宣传片的 HUD 外框用；没有中文，不给风格当中文主字体。role 是 `latin`：不做试玩用的常用字子集，要用时按需做子集。

| 项 | 值 |
|---|---|
| 登记名 | `jbmono-medium`（`hanzifx-jbmono-medium`，wght 500）、`jbmono-bold`（`hanzifx-jbmono-bold`，wght 700），同一个可变字体文件 |
| 许可证 | SIL Open Font License 1.1，原文 `fonts/LICENSES/JetBrainsMono-OFL.txt` |
| 许可证出处 | https://raw.githubusercontent.com/google/fonts/6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/OFL.txt |
| 版权行 | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| 保留字体名 | 无（版权行后面没有声明 Reserved Font Name，子集后保留原名合规） |
| 字体文件 | `JetBrainsMono[wght].ttf`，187,208 字节（可变字体，wght 100–800） |
| 下载地址 | https://raw.githubusercontent.com/google/fonts/6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf |
| sha256 | `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda` |
| 上游源码 | https://github.com/JetBrains/JetBrainsMono |
| 覆盖 | cmap 976 个码位；拉丁字母、数字全有；「· ◆ ◇ • / : ' — →」都有；没有中文 |
| 嵌入许可 fsType | 0 |

## 得意黑 Smiley Sans（还没登记）

许可证是 OFL-1.1，但版权行写了**保留字体名 `Smiley` 和 `得意黑`**（原文：https://raw.githubusercontent.com/atelier-anchor/smiley-sans/67e3821f4b06cbd7155fa6fa69daff4b6f311b76/LICENSE ，v2.0.1）。按 OFL 第 3 条，改过的版本不能用保留字体名；我们按用字做子集就是改过的版本，而 harfbuzz 子集会原样保留 name 表（「Smiley Sans Oblique」）。所以要先在子集流程里加一步：给有保留字体名的字体改写 name 表（比如改成 hanzifx-deyihei），改完再登记。下载地址和 sha256 先记在这里：release v2.0.1 `smiley-sans-v2.0.1.zip`（sha256 `299c0be6c960ae37361762eca76f7d0cd516615435bb96c0d4b98a1e70178a07`），里面 `SmileySans-Oblique.ttf` 2,629,764 字节，sha256 `b447d7e781f08bc95c4c9f23ba71ed2b8ebb639aa7184485c71c4ca5afcd25c4`；GB2312 全有，竖排标点 30 个，fsType 8。

## 子集怎么做

- 工具：subset-font（harfbuzz 的 hb-subset，经 harfbuzzjs 跑在 Node 里），输出 woff2。默认保留全部 OpenType 排版特性，并做替换字形的闭包（竖排、标点替换的字形会一起带上）。
- 导出：按这次实际用到的字做子集（7 个字的子集约 1.2 KB），放在 `out/.fonts/<hash>/`，同时拷一份到每次导出的 `fonts/` 目录。
- 试玩台：主字体用常用字子集 `fonts/dist/<id>.common.woff2`（GB2312 汉字 6763 个 + ASCII + 常用中文标点；快乐体 835 KB，黄油体 1672 KB）。主字体没有的字，走本地服务的 `/__hanzifx/subset` 按需给备用字体做子集。
- 做完子集再用 harfbuzz 读一遍子集的字符表，确认要的字都在（`cli/lib/fonts.mjs` 的 `subset()`）。
- 可变字体按 registry 里的 `variation` 固定字重（思源黑体固定 wght 900）。

## 怎么核「没回退成系统字体」

导出时停在停留段中间那一帧，用 Chrome 开发者协议 `CSS.getPlatformFontsForNode` 逐个文字节点查实际用的字体和字形数。只允许出现我们这次下发的子集文件（按子集文件自己的 name 表认）；出现别的字体，或者 `isCustomFont=false` 的系统字体，直接报错退出。结果写在每次导出的 `manifest.json` → `checks.fontProbe`。

## 下载不下来怎么办

`npm run fonts` 默认从 GitHub（raw.githubusercontent.com）按登记的提交下载，国内网络可能连不上。两个办法，下载以后都照样核 sha256，对不上的文件不会用：

1. **换下载地址**：设环境变量 `HANZIFX_FONTS_MIRROR`，先试它，不行再回官方地址。可以写前缀，也可以写模板：
   ```bash
   # 前缀：接上 <owner>/<repo>/<ref>/<path>
   HANZIFX_FONTS_MIRROR=https://你的镜像/raw npm run fonts
   # 模板：{owner} {repo} {ref} {path} 换成对应的部分。比如 jsDelivr：
   HANZIFX_FONTS_MIRROR='https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}' npm run fonts
   ```
   2026-11-21 实测 jsDelivr：JetBrains Mono、站酷快乐体都下下来了，sha256 也对；思源宋体（24 MB）返回 403，jsDelivr 不提供 20 MB 以上的文件，这一款要用第 2 个办法，或者换别的镜像。
2. **自己下载放进去**：照本页每款字体的「下载地址」下载（浏览器、别的下载工具都行），按 registry 里的 `file` 放到 `engine/fonts/src/`，文件名一字不差。再跑 `npm run fonts`，sha256 对得上就直接用，不再联网。

## 加一款新字体

1. 先看许可证原文：要允许再分发和修改（OFL、Apache-2.0 这类）。「免费商用」但不许再分发、不许修改的不要（阿里巴巴普惠体、优设标题黑、庞门正道这类，用之前要单独核条款，现在都没收）。
2. 看版权行后面有没有 Reserved Font Name，有的话记下来，别名里不能用。
3. 下载地址钉到具体提交，记 sha256 和字节数，写进 `fonts/registry.json`，许可证原文放进 `fonts/LICENSES/`，这份文件补一节。
4. 用 fontTools 或 harfbuzz 读字符表，记下 GB2312 覆盖、常用标点、已知缺字、fsType、vert/vrt2。
5. `npm run fonts` 生成试玩用的子集；`node cli/notice.mjs` 重新生成 NOTICE。
