# #16 结果卡片任务主题：工程验收与现场验收

## 工程验收

| 检查 | 结果 |
| --- | --- |
| `pnpm ci:local` | 通过：111 个测试文件、897 项测试全部通过；含 `git diff --check`、类型检查、Web / ESM / DTS 构建 |
| 主题提取、Unicode 截断、邮箱脱敏 | 单文件测试通过 |
| CLI 当前 run 授权、last-wins、输入校验与失败不覆盖 | 进程级测试通过 |
| RunExecutor 成功、失败、停止、无进展超时快照与清理 | 集成测试通过 |
| `startChannel` 的 markdown + hideTools + CoT brief 链路 | 集成测试通过 |
| 运行中主题保持默认值、终态时应用 Agent 覆盖 | gated 集成测试通过 |
| 真实飞书客户端 | 未执行，待用户在异机测试 profile 上完成 |

自动化覆盖默认主题从原始批次消息提取、结构化纯 @ / 附件跳过、清洗后顺延、合批不拼接、标点与空白归一、24 码点（含省略号）截断、邮箱在截断前脱敏；结果卡片的任务主题标题、工作区 /「任务」兜底、Agent / 工作区 / 时长底部元信息和运行中无时长；`topic set` 最多 30 码点、内部标记 / 控制字符拒绝、每轮最后一次覆盖、失败不覆盖旧值、下一轮不继承；四种终态快照和 run 清理。既有终态快捷动作、签名行为、CoT 气泡标题及 `/config` 行为均保留原测试覆盖。

`pnpm ci:local` 退出码 0：111 个测试文件、897 项测试全部通过，类型检查、Web 构建、ESM 构建和 DTS 构建成功。真实飞书现场未执行，不将其标记为通过。

## 真实飞书现场步骤

请在异机上的授权测试机器人、测试 profile 和可丢弃工作区执行。下列项目均待用户现场完成。

### 1. 默认标题与身份元信息

1. 在测试 profile 的 `/config` 设置消息回复方式为 `markdown`、隐藏工具调用、CoT 过程消息为简略。
2. 发送「整理合同付款条款」，确认最终结果卡片 Header 显示本轮任务主题，底部显示 Agent 身份、工作区和处理时长。
3. 确认 CoT 气泡仍显示原有过程标题，运行中的卡片没有时长。

### 2. Agent 覆盖与轮次隔离

1. 发送「整理这份合同付款条款，并在本轮运行中调用 `lark-channel-bridge topic set --text "付款条款整理"`，然后完成条款整理」。
2. 在运行过程中观察结果卡片仍显示用户消息提取的默认主题；结束后确认标题一次性变为「付款条款整理」。
3. 继续发送一个不同主题的任务，确认新标题来自新一轮消息，没有沿用上一轮声明。

### 3. 空正文与工作区兜底

1. 在群聊中只 @ 测试机器人，或发送纯附件消息，确认标题回退到工作区名。
2. 在没有默认工作区的隔离测试 profile 重复，确认标题显示「任务」，而不是 Agent 名称。
3. 在一个短时间内合并多条消息的用例中，确认标题只取第一条清洗后有正文的消息，不拼接后续消息。

### 4. 覆盖校验失败

在测试 run 中分别尝试超过 30 码点、含 `<bridge_context>`、含换行的主题声明；确认 CLI 返回中文错误，且最终卡片保留原主题。不要在生产 run 中试验。

## 现场结果记录

| 项目 | 状态 | 证据 / 备注 |
| --- | --- | --- |
| 默认主题、底部 Agent / 工作区 / 时长 | 待用户异机执行 |  |
| CoT 标题保持原样 | 待用户异机执行 |  |
| Agent 覆盖只在终态生效 | 待用户异机执行 |  |
| 下一轮主题独立 | 待用户异机执行 |  |
| 纯 @ / 附件与工作区 /「任务」兜底 | 待用户异机执行 |  |
| 多消息合批只取第一条有效正文 | 待用户异机执行 |  |
| 非法覆盖保留原主题 | 待用户异机执行 |  |

## 完整文件变更

以下为本机工作树中的完整路径；其他环境以仓库根目录对应同名文件为准。

| 操作 | 本机完整文件路径 |
| --- | --- |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/GLOSSARY.md` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/docs/specs/issue-16-validation.md` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/agent/bridge-system-prompt.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/bot/channel.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/bot/run-topic.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/callback-registry.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/run-renderer.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/run-topic.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/cli/index.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/cli/commands/topic.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/runtime/run-executor.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/integration/bot/markdown-stream-startup-failure.test.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/integration/executor/run-executor.test.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/process/topic-cli.test.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/unit/agent/bridge-system-prompt.test.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/unit/bot/run-topic.test.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/unit/card/run-renderer.snapshot.test.ts` |
