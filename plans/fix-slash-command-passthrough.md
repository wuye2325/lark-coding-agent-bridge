# 飞书斜杠命令直通

## Context

飞书消息里的 `/技能名`（如 `/implement`）在桥接中不会被 CLI 展开：bridge 先拦截自己的内置命令，未命中的文本进入 batch，被包装成以 `<bridge_context>` 开头的 prompt，经 stdin 交给 `claude -p`。CLI 只在输入首字符为 `/` 时展开自定义斜杠命令；实测该规则在 `--resume` 下同样成立，且 `--append-system-prompt-file` 不会干扰展开、其内容也不会进入技能的 `$ARGUMENTS`。目标是让单条斜杠命令以原文作为 user prompt，会话元数据改由 system prompt 注入。

## Approach

### 1. 新增斜杠命令 prompt 构造 — `src/agent/prompt.ts`（modify）

新增两个导出，不改 `buildAgentPrompt`，普通消息零回归：

```ts
export interface AgentPromptBundle {
  prompt: string;
  appendSystemPrompt?: string;
}

export function buildSlashCommandPrompt(input: {
  command: string;
  context: BuildAgentPromptInput['context'];
  instructions?: string[];
}): AgentPromptBundle
```

`prompt` 为 `command.trim()`；`appendSystemPrompt` 由一段中文说明加 `promptSection('bridge_context', context)`、`promptSection('bridge_instructions', instructions)` 组成。说明需写明：本轮消息以斜杠命令开头，CLI 已展开该命令，以下仅为会话元数据。

### 2. 在 batch 构造处识别并直通 — `src/bot/channel.ts`（modify）

`buildPrompt`（2043 行）改成返回 `AgentPromptBundle`，新增 `agentKind` 参数，2049 行 `!first` 的 `return ''` 改为 `{ prompt: '' }`。直通判定全部满足才生效：

- `agentKind === 'claude'`（Codex 若直通会丢失 context 且仍不展开，必须排除）
- `first.senderIsBot !== true`（防止对端 bot 在群里触发技能；卡片终态动作是人工点击，不至于误伤）
- `batch.length === 1`
- `attachments.length === 0`
- `quotes.length === 0`
- `topicContext.length === 0`
- 该消息无 interactive card
- 文本匹配 `/^\/[A-Za-z0-9][\w:-]*(?:\s|$)/`

文本直接取 `stripAttachmentRefs(m.content, fileKeys).trim()`；SDK 默认 `stripBotMentions: true`，bot 的 mention 占位已在归一化阶段删除并 trim，无需再剥离 mention，也不可复用 `stripMentionRefs`（它会误删参数里的人名 `@张三`）。

命中时调用 `buildSlashCommandPrompt`；否则走原 `buildAgentPrompt`。日志增加 `mode: 'slash-command' | 'text'`。调用点（1010 行）解构 bundle，`startRunFlow`（1055 行）传 `appendSystemPrompt`。

多消息合并时第一段会带 `[名字 (user|bot)]:` 前缀，天然不命中；附件、引用、话题上下文存在时不直通。话题群首次拉入且带历史消息时 `topicContext` 非空，本轮不直通，作为已知取舍保留。

### 3. 透传字段 — `src/bot/run-flow.ts`、`src/runtime/run-executor.ts`、`src/agent/types.ts`（modify）

`StartRunFlowInput`、`SubmitRunInput`、`AgentRunOptions` 各加可选 `appendSystemPrompt?: string`。`run-flow.ts` 原样传给 `executor.submit`，`run-executor.ts` 写入 `runOptions`；会话失效重试（`run-executor.ts:333`）用 `{ ...runOptions }` 自动保留。会议与卡片路径不传该字段，保持 undefined。

### 4. Claude 适配器与系统提示文案 — `src/agent/claude/adapter.ts`、`src/agent/bridge-system-prompt.ts`（modify）

system prompt 文件内容改为 `buildBridgeSystemPrompt(this.botIdentity)` 加可选 `opts.appendSystemPrompt`（空行分隔）；为空时必须与原值逐字相同，现有精确相等断言不能被破坏。`bridge-system-prompt.ts` 第 9 行的"每条 user message 顶部会带 `<bridge_context>`"改为说明：普通消息在 user message 顶部，斜杠命令直通时改由 system prompt 提供。

Codex 适配器不改：它用 `prefixBridgeSystemPrompt` 把系统提示塞进 stdin 开头，没有独立通道，且 Codex 的斜杠机制需单独验证。

### 5. 测试与文档 — `tests/`、`README.zh.md`（add / modify）

- 新增 `tests/unit/agent/slash-command-prompt.test.ts`：断言直通 bundle 的 prompt、system prompt 内容，以及普通路径输出不变。（实际并入 `tests/unit/agent/prompt-builder.test.ts`，复用既有 `readSection` 辅助。）
- `tests/process/claude-adapter.test.ts`：新增用例，断言 `appendSystemPrompt` 出现在 systemPrompt 文件、stdin 仍为原文；保留空值时的精确相等断言。
- 新增 `tests/unit/bot/channel-prompt.test.ts`：直接调用导出的 `buildPrompt`，断言直通 bundle 的 `prompt` 首字符为 `/`、`appendSystemPrompt` 含 `bridge_context`。覆盖 batch>1、带引用、带附件、话题上下文、interactive card、bot 发送者、codex profile 七类不直通用例。
- `README.zh.md` 斜杠命令章节补一段：用户自定义技能命令会原样交给本地 CLI，可能触发技能内的写操作与 git 提交；未知的 `/Users` 这类路径会被当作未知命令处理；访问控制仍在 run-flow 生效，未被绕过，但任何能 @bot 的群成员都能触发。

## Key Files

| File | Change | Notes |
|------|--------|-------|
| `src/agent/prompt.ts` | modify | 新增 `AgentPromptBundle` 与 `buildSlashCommandPrompt` |
| `src/bot/channel.ts` | modify | `buildPrompt` 返回 bundle，加入直通判定与日志 |
| `src/bot/run-flow.ts` | modify | 透传 `appendSystemPrompt` |
| `src/runtime/run-executor.ts` | modify | 透传 `appendSystemPrompt` |
| `src/agent/types.ts` | modify | `AgentRunOptions` 新增可选字段 |
| `src/agent/claude/adapter.ts` | modify | 拼接 system prompt 文件 |
| `src/agent/bridge-system-prompt.ts` | modify | 修正 `<bridge_context>` 位置说明 |
| `tests/unit/agent/prompt-builder.test.ts` | modify | 新增 `buildSlashCommandPrompt` 用例 |
| `tests/unit/bot/channel-prompt.test.ts` | add | `buildPrompt` 直通与不直通用例 |
| `README.zh.md` | modify | 说明命令直通、风险与访问控制 |

## Verification

1. `pnpm typecheck`
2. `pnpm test:unit && pnpm test:process && pnpm test:integration`
3. 在 `legal-fde` 目录用真实 CLI 复现：`printf '/implement 写一个注释' | claude -p --output-format json` 应触发技能展开（用 `num_turns` 与输出判断）。
4. 飞书私聊发 `/implement <任务>`，确认桥接日志出现 `promptMode: 'slash-command'`，且结果卡片走技能流程；分别检查过程消息与最终回复（AGENTS.md 的对话 UI 验收要求）。再发普通消息，确认 prompt 仍含 `<bridge_context>` 且行为不变。
