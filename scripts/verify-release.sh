#!/usr/bin/env bash
set -euo pipefail

# 验证已经构建的产物；只安装到临时目录，不更新全局 CLI 或重启机器人。
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_dir="$(mktemp -d "${TMPDIR:-/tmp}/bridge-verify.XXXXXX")"
trap 'rm -rf "$release_dir"' EXIT
package_path="$(bash "$repo_dir/scripts/pack-release.sh" "$release_dir")"
npm install --prefix "$release_dir/install" --ignore-scripts --no-audit --no-fund "$package_path"
installed_package="$release_dir/install/node_modules/lark-channel-bridge"
cd "$repo_dir"
BRIDGE_TEST_PACKAGE_DIR="$installed_package" pnpm exec vitest run \
  "$repo_dir/tests/integration/card/callback-dispatch.test.ts" -t '真实 SDK'
node "$installed_package/bin/lark-channel-bridge.mjs" --version
printf '\n安装产物中的 SDK 回调回归和 CLI 启动验证通过。\n'
