#!/usr/bin/env bash
# ============================================================================
# release.sh — SellerKit 一键打包 + 可选发布到 GitHub Releases
#
# 用途：一次产出（架构由 electron-builder.yml 控制）
#   - macOS  arm64 (Apple Silicon) + x64 (Intel)  -> dmg + zip（zip 供自动更新）
#   - Windows x64                                 -> nsis 安装包 + portable 免安装版
#
# 依赖说明：
#   - 在 macOS 上交叉构建 Windows(NSIS) 无需 Wine：
#     electron-builder(>=26) 使用 NSIS 官方跨平台工具集，自带 macOS 原生 makensis。
#   - 打包原生依赖（better-sqlite3）时需联网下载目标平台的 prebuild /
#     本地编译；若某个目标架构编译失败，改用该平台真实环境或 CI 构建。
#
# 用法：
#   bash scripts/release.sh                      # 默认产出 mac + win（不上传）
#   bash scripts/release.sh --mac                # 仅 macOS 双架构
#   bash scripts/release.sh --win                # 仅 Windows
#   bash scripts/release.sh --publish always     # 打包并发布到 GitHub Releases
#   MODULE_IDS=quick-note bash scripts/release.sh  # 配合模块裁剪（可选）
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PLATFORMS="${PLATFORMS:-mac,win}"
PUBLISH="never"

usage() {
  cat <<'EOF'
用法: bash scripts/release.sh [选项]

  --mac                仅打包 macOS（arm64 + x64）
  --win                仅打包 Windows（x64）
  --platforms LIST     平台集合，逗号分隔（默认 mac,win）
  --publish MODE       发布到 GitHub Releases: never | always | onTagOrDraft（默认 never）
                       always = 上传并（如有版本 tag）更新 Release
  -h, --help           显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mac) PLATFORMS="mac" ;;
    --win) PLATFORMS="win" ;;
    --platforms)
      [[ $# -ge 2 ]] || { echo "缺少 --platforms 参数值"; usage; exit 1; }
      PLATFORMS="$2"; shift
      ;;
    --publish)
      [[ $# -ge 2 ]] || { echo "缺少 --publish 参数值"; usage; exit 1; }
      PUBLISH="$2"; shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
  shift
done

# --- 宿主平台判断 ---------------------------------------------------------
case "$(uname -s)" in
  Darwin) HOST_OS="mac" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="win" ;;
  Linux) HOST_OS="linux" ;;
  *) HOST_OS="unknown" ;;
esac
echo "==> 宿主平台: $HOST_OS | 目标平台: $PLATFORMS | 发布模式: $PUBLISH"

# --- 发布前置检查 ---------------------------------------------------------
if [[ "$PUBLISH" != "never" ]]; then
  if [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
    echo "错误: 发布模式需要 GH_TOKEN 或 GITHUB_TOKEN 环境变量。" >&2
    echo "  参考: echo 'export GH_TOKEN=ghp_xxx' >> ~/.zshrc && source ~/.zshrc" >&2
    exit 1
  fi
fi

# --- 渲染层 + 主进程构建 --------------------------------------------------
echo "==> npm run build"
npm run build

# --- electron-builder 多平台打包（单次 run，平台间并行）--------------------
ARGS=()
[[ ",$PLATFORMS," == *,mac,* ]] && ARGS+=(--mac)
[[ ",$PLATFORMS," == *,win,* ]] && ARGS+=(--win)
ARGS+=(--publish "$PUBLISH")

echo "==> electron-builder ${ARGS[*]}"
npx electron-builder "${ARGS[@]}"

# --- 恢复本机原生模块架构 --------------------------------------------------
# 多架构打包会把 node_modules 里的原生依赖就地 rebuild 成目标架构，
# 最后留下的可能是非本机架构（如 x64），导致后续 npm run dev 加载失败。
# 默认打包后自动 npm run rebuild 恢复本机 Electron ABI；REBUILD_AFTER=0 可跳过。
if [[ "${REBUILD_AFTER:-1}" == "1" ]]; then
  echo "==> 恢复本机原生模块架构（npm run rebuild，REBUILD_AFTER=0 可跳过）"
  npm run rebuild
fi

# --- 产物清单 ---------------------------------------------------------------
echo ""
echo "==> 产物目录 release/:"
ls -1 release/ | grep -Ev '\.(yml|yaml|blockmap)$' || true

if [[ "$PUBLISH" != "never" ]]; then
  # electron-builder 在本地没有对应 git tag 时会创建 draft（草稿）Release，
  # 而 electron-updater 只认 published Release → 调用独立脚本自动转正。
  echo ""
  echo "==> 执行草稿 Release 转正（electron-updater 只认 published）"
  node "$ROOT/scripts/publish-finalize.js"
fi
