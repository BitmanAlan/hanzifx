#!/usr/bin/env bash
# 装好中文字效库：装依赖、下载字体并核对 sha256、自检，再把 skill 链接到本机已经装了的 agent 目录。可以重复运行。
#   bash scripts/install_skill.sh            # 全部做
#   NO_LINK=1 bash scripts/install_skill.sh  # 只装依赖和字体，不链接 skill
#   NO_BROWSER=1 bash scripts/install_skill.sh  # 不下载锁定版本的无头浏览器，用本机 Chrome
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v node >/dev/null 2>&1 || { echo "✗ 没找到 Node.js，要 20 或更新的版本：https://nodejs.org" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "✗ Node.js 版本太老（$(node -v)），要 20 或更新" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || echo "⚠ 没找到 ffmpeg，导出成片要用它。macOS: brew install ffmpeg；Ubuntu: sudo apt install ffmpeg" >&2

cd "$ROOT/engine"
npm install --no-audit --no-fund
# 锁定版本的无头浏览器：版本跟着 playwright-core 走，逐帧结果最稳；没装 Chrome 的机器也能导出。约 100 MB
if [ "${NO_BROWSER:-}" != "1" ]; then
  node node_modules/playwright-core/cli.js install chromium-headless-shell \
    || echo "⚠ 无头浏览器没下载成功，导出时会改用本机的 Google Chrome（Chrome 自动升级后，逐帧结果可能跟别人的对不上）" >&2
fi
npm run fonts
npm run doctor || echo "⚠ 自检有没过的项，照上面的提示补上再用" >&2

if [ "${NO_LINK:-}" != "1" ]; then
  targets=()
  # ~/.dsh 是 DeepSeek Harness（它也扫 ~/.agents/skills，但不扫 ~/.claude/skills）；装法按公开文档写的，还没实测
  for home in "$HOME/.claude" "$HOME/.codex" "$HOME/.agents" "$HOME/.dsh"; do
    [ -d "$home" ] && targets+=("$home/skills")
  done
  [ ${#targets[@]} -eq 0 ] && targets=("$HOME/.claude/skills")
  for dir in "${targets[@]}"; do
    mkdir -p "$dir"
    dest="$dir/hanzifx"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      echo "⚠ $dest 是一个真实目录（以前手动拷的？），跳过。删掉或改名后再跑一次。" >&2
      continue
    fi
    ln -sfn "$ROOT/skills/hanzifx" "$dest"
    echo "已链接 $dest"
  done
fi
echo "好了。试试对你的 agent 说：用 001 把「这也太*好笑*了吧」做成综艺花字"
