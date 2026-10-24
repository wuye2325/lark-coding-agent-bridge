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

## 主代理独立审查与工程验收

- 审查基线：`6c7c445`；功能提交：`d972f27`；审查修复提交：`78131fe`。
- 实施及双轴审查子代理使用 `gpt-6-luna` / `max`，主代理独立检查并运行工程验收。
- 主代理在最终功能代码上独立运行 `pnpm ci:local`，退出码 0：111 个测试文件、897 项测试通过，类型检查及 Web / ESM / DTS 构建通过。
- 实际构建的 `topic set` CLI 帮助入口通过；无活动 run 授权时非零退出，并返回中文原因。
- 独立运行生产主题提取、校验和渲染模块，验证人类姓名保留、纯 @ 跳过、首个正文、Unicode 截断、邮箱边界、控制字符、30/31 码点、内部标记、标题及底部元信息顺序、运行中无时长和两级兜底。
- 相对 #12 基线独立对照 18 个正常、边界及内部标记输入：动作校验的接受 / 拒绝结果与中文原因均一致。

| 审查轴 | 发现与处理 | 未解决项 |
| --- | --- | --- |
| Standards | 0 项硬标准违例；1 项 P3 判断性重复：主题与动作内部标记匹配重复。已提取公共 tag 检测，专属规则各自保留，旧动作策略不变 | 0 |
| Spec | 初审及修复复核均未发现可确认的功能缺陷或范围扩张 | 0 |

默认主题的最终长度按验收标准控制在 24 个码点以内（含省略号）；Agent 声明按原始输入不超过 30 个码点校验。主题与 #12 动作分别登记、快照与清理，现场验收仍由用户在异机执行。

## 真实飞书现场步骤

请在异机上的授权测试机器人、测试 profile 和可丢弃工作区执行。下列项目均待用户现场完成。

### 1. 默认标题与身份元信息

1. 在测试 profile 的 `/config` 设置消息回复方式为“消息卡片”、工具调用显示为“隐藏”、CoT 过程消息为“简略”。
2. 发送「整理合同付款条款」，确认最终结果卡片 Header 显示本轮任务主题，底部显示 Agent 身份、工作区和处理时长。
3. 确认 CoT 气泡仍显示原有过程标题。此主要配置运行中显示 CoT 过程气泡，结束后才发送结果卡片。

### 2. Agent 覆盖与轮次隔离

1. 发送「整理这份合同付款条款，并在本轮运行中调用 `lark-channel-bridge topic set --text "付款条款整理"`，然后完成条款整理」。
2. 在主要 CoT 配置下，确认过程气泡标题保持原样，结束后的结果卡片标题为「付款条款整理」。旧版 `card` 流式通路的“运行中保持默认主题、终态才替换”已由 gated 集成测试验证。
3. 继续发送一个不同主题的任务，确认新标题来自新一轮消息，没有沿用上一轮声明。

### 3. 空正文与工作区兜底

1. 在群聊中只 @ 测试机器人，或发送纯附件消息，确认标题回退到工作区名。
2. 无工作区时显示「任务」而非 Agent 名称的渲染兜底，已由自动化组件检查验证；现场保留正常工作区配置。
3. 在一个短时间内合并多条消息的用例中，确认标题只取第一条清洗后有正文的消息，不拼接后续消息。

### 4. 覆盖校验失败

在测试 run 中分别尝试超过 30 码点、含 `<bridge_context>`、含换行的主题声明；确认 CLI 返回中文错误，且最终卡片保留原主题。

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
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/bridge-internal-markers.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/callback-registry.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/run-renderer.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/run-topic.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/card/terminal-actions.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/cli/commands/topic.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/cli/index.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/src/runtime/run-executor.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/integration/bot/markdown-stream-startup-failure.test.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/integration/executor/run-executor.test.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/process/topic-cli.test.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/unit/agent/bridge-system-prompt.test.ts` |
| 新增 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/unit/bot/run-topic.test.ts` |
| 修改 | `/Users/wuye/.codex/worktrees/issue-12-implementation/lark-coding-agent-bridge/tests/unit/card/run-renderer.snapshot.test.ts` |
