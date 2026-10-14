# 卡片回调重试验证（#7）

## 行为

卡片尚未绑定时返回“卡片正在准备，请稍后再点”；绑定后用户可再次点击原按钮。平台重复投递由 SDK 过滤，成功后的业务重复提交由 Bridge 原子消费拒绝。失效、已处理、上下文不符、表单不符或存储失败均有用户可见反馈，不包含内部标识或凭证。

SDK 按 event_id（含原始 header 形态）或 token 识别投递；无有效标识时用独立随机键进入原队列，不猜测按钮级去重。这个降级无法识别无标识的平台重放；登记回调仍受 Bridge 一次性消费保护。

## 证据

- 新测试先失败：直接派发未绑定点击没有 toast；真实 SDK 在首次拒绝后吞掉新的点击；Bridge 事件入口丢弃返回值。
- 修复后真实 SDK 的 ESM/CJS 入口均允许原卡重试；header/event_id/token、无标识及并发重复投递用例通过。
- Claude/Codex 会话续接测试验证等待 toast 经 Bridge 入口返回，绑定后恢复原会话；排队期间重置会话仍拒绝旧卡。
- 隔离目录的 `pnpm ci:local`：107 个文件、774 项测试通过，类型检查和构建通过。
- SDK 上游基线：58 个文件、599 项测试通过，类型检查和构建通过。
- 安装产物：在工作区以外的临时目录安装 npm 包，7 项真实 SDK 回归通过，CLI `--version` 正常。未修改全局安装或重启生产机器人。
- 线上绑定窗口的人工验收待部署后执行；不能用自动化测试代替该项。

## 发布与复验

SDK 补丁通过 pnpm patchedDependencies 固定。修改补丁时使用 `npm_config_ignore_scripts=true pnpm patch-commit <临时目录>`，避免触发根项目 prepare 构建。

直接从 pnpm 的默认隔离布局运行 npm pack，可能把内部链接布局带入捆绑包。发布脚本会将构建产物、lockfile 和补丁复制到临时目录，使用 hoisted 布局安装生产依赖并应用补丁，再捆绑 SDK 及其依赖打包；不改变项目日常依赖布局。

已构建产物可运行 `bash scripts/verify-release.sh`：临时打包、安装并执行真实 SDK 回归，最后验证 CLI 启动。该脚本不构建、不修改全局安装、不重启机器人。

生产上线仍通过 `scripts/deploy-local.sh` 手动执行；它在检查并构建后调用同一打包流程，安装全局 CLI，最后调用已有的六机器人重启脚本。不要在律师使用期间执行。

上游发布等价 SDK 修复后，核对真实点击与重放语义，再移除 pnpm 补丁。

## 审查与上游

- Standards：SDK 测试命名遗留已修正，复审 0 项发现。
- Spec：各拒绝原因的 toast 断言已补齐，复审 0 项发现。
- SDK 上游 PR：https://github.com/larksuite/channel-sdk-node/pull/22 。
