# 仓库工作约定

## 需求对齐

事件类需求先区分平台重复投递与用户真实的重复操作；只有业务明确要求一次性处理时，才提议额外的持久化去重。

对话 UI 需求以用户实际的回复方式、工具可见性与 CoT 组合验收，分别检查运行中的过程消息与最终回复效果；设置卡片的外观单独评估。

## 部署与发布脚本

- 本机部署：先读 [`scripts/deploy-local.sh`](scripts/deploy-local.sh)，从干净的 `develop` 工作区执行；该入口会更新全局 CLI 并调用本机机器人重启脚本。
- 发布打包：先读 [`scripts/pack-release.sh`](scripts/pack-release.sh)，用于打包已构建的产物与补丁 SDK。
- 安装产物验证：先读 [`scripts/verify-release.sh`](scripts/verify-release.sh)，在临时目录安装产物并验证 SDK 回调与 CLI 启动。
- 备份／回滚：上述脚本不提供运行配置、会话或凭据备份，也不自动回滚；执行前需另行核对备份范围与恢复方案。

## Agent skills

### Issue tracker

需求与 specs 使用当前 fork 的 GitHub Issues；操作前读取 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五类 triage 标签；分类前读取 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context 领域文档；探索代码前按 `docs/agents/domain.md` 读取术语表与相关 ADR。
