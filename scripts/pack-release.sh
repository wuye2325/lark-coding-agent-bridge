#!/usr/bin/env bash
set -euo pipefail

# 把补丁 SDK 及生产依赖放入普通目录布局，避免 npm 打包 pnpm 的内部链接。
if (($# != 1)); then
  printf '用法：%s <产物目录>\n' "$0" >&2
  exit 2
fi
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$1"
output_dir="$(cd "$1" && pwd)"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/bridge-package.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT

cp -R "$repo_dir"/{dist,bin,patches,package.json,pnpm-lock.yaml,README.md,README.zh.md,LICENSE} "$stage_dir/"
pnpm --dir "$stage_dir" install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted >&2
package_file="$(cd "$stage_dir" && npm pack --ignore-scripts --pack-destination "$output_dir")"
printf '%s\n' "$output_dir/$package_file"
