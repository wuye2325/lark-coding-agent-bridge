#!/usr/bin/env bash
set -euo pipefail

# 下班后手动执行：构建并安装当前 develop，再重启全部机器人后台服务。
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
restart_script="/Users/wuye/Downloads/legal-fde/scripts/restart-all-bots.sh"
dry_run=false

case "${1:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  *) printf '用法：%s [--dry-run]\n' "$0" >&2; exit 2 ;;
esac
if (($# > 1)); then
  printf '用法：%s [--dry-run]\n' "$0" >&2
  exit 2
fi

cd "$repo_dir"
for command_name in git pnpm npm lark-channel-bridge; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '错误：找不到命令 %s\n' "$command_name" >&2
    exit 127
  fi
done
if [[ ! -f "$restart_script" ]]; then
  printf '错误：找不到机器人重启脚本 %s\n' "$restart_script" >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != develop ]]; then
  printf '错误：请在 develop 分支执行上线。\n' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  printf '错误：工作区有未提交修改，请先提交再上线。\n' >&2
  exit 1
fi

if "$dry_run"; then
  printf '%s\n' \
    '仅预览，不执行构建、安装或重启：' \
    '1. pnpm typecheck' \
    '2. pnpm build' \
    '3. npm pack --ignore-scripts（打包到临时目录）' \
    '4. npm install --global --ignore-scripts <生成的 tgz>' \
    "5. bash $restart_script"
  exit 0
fi

release_dir="$(mktemp -d "${TMPDIR:-/tmp}/bridge-release.XXXXXX")"
trap 'rm -rf "$release_dir"' EXIT

printf '\n检查并构建 develop：\n'
pnpm typecheck
pnpm build

# 安装打包产物，避免全局 CLI 链接到工作区；跳过重复构建的生命周期脚本。
printf '\n打包并更新全局 Bridge：\n'
package_file="$(npm pack --ignore-scripts --pack-destination "$release_dir")"
npm install --global --ignore-scripts "$release_dir/$package_file"

printf '\n重启机器人后台服务：\n'
bash "$restart_script"
printf '\n上线完成。\n'
