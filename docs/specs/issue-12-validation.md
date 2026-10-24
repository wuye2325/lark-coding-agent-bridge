# #12 结果卡片后续动作：工程验收与现场验收

> 2026-10-24 行为修订：取消“运行单测”和“查看 Diff”的全部静态兜底，只显示 Agent 本轮明确登记的动作。以下早期工程验收结果保留为历史记录；现场步骤已按当前规则更新。

本次修订工程验证：`pnpm ci:local` 通过，111 个测试文件、908 项测试全部通过，类型检查及 Web / ESM / DTS 构建成功。回归覆盖有测试入口的 Git 仓库中的问答、文件写入、未声明及明确零动作，均无自动按钮或快捷按钮提示；明确登记动作与关闭偏好继续通过。尚未部署或进行真实飞书客户端验收。

## 工程验收

| 检查 | 结果 |
| --- | --- |
| `pnpm ci:local` | 通过：109 个测试文件、883 项测试全部通过；含 `git diff --check`、`pnpm typecheck` 和 `pnpm build` |
| 单独复跑 `pnpm build` | 通过：Web、ESM、DTS 构建成功 |
| 真实飞书客户端 | 未执行，待用户在授权的测试 profile 上完成 |

自动化覆盖包含：`action add` / `action none` 的 run 级登记、边界校验和清理；HMAC 动作跨重启验证、邮箱 prompt 完整恢复及重复点击；真实 SDK 投递重放去重和当前点击者权限；RunExecutor 成功、失败、中断路径的动作快照与清理；真实 `startChannel` → RunExecutor → 最终结果卡片接线；未声明、明确零动作、Git/Test fallback、`off` 偏好；三条 500 Unicode 码点动作的整卡预算。

## 集成与主代理独立验收

- 集成分支：`codex/issue-12-dynamic-actions`；审查基线：`67557bd`。
- 最终功能提交：`57016f8`；独立工程验收对应集成提交：`2256280`。
- 实施、合并与双轴审查子代理使用 `gpt-6-luna` / `max`；主代理独立复核并运行工程验收。
- 主代理在最终集成代码上运行 `pnpm ci:local`，退出码 0：109 个测试文件、883 项测试全部通过，类型检查、Web / ESM / DTS 构建通过。
- 实际构建的 CLI 验证通过：`action add/none` 帮助入口存在；无活动 run 授权时，两者均非零退出并返回中文原因。
- 独立运行 Git 检测的四种场景通过：普通目录、残留空 `.git` 目录均为非 Git 工作区；正常仓库、使用 `.git` 文件的真实 worktree 均正确识别。

| 审查轴 | 初审发现与修复 | 复核未解决项 |
| --- | --- | --- |
| Standards | 0 项硬标准违例；1 项判断性重复：动态与旧式 prompt 分支重复构造队列消息和 Toast。已提取共用入队 helper，保留权限、错误日志和 Toast 语义 | 0 |
| Spec | 1 项 P2：运行中修改配置会提前影响本轮结果卡。已在本轮选择通路时固定动作模式；高层回归验证本轮保留原设置、下一轮采用新设置 | 0 |

主代理早期独立检查还修正了空 `.git` 标记造成的误判，并确认按钮仅携带包含原始 prompt 的签名 token，以保留邮箱/路径原文并满足三条最大长度动作的整卡预算。

## 真实飞书现场步骤

请使用授权的测试机器人、测试 profile 和可丢弃的工作区执行；每个步骤完成后记录卡片、Toast 和后续消息结果。当前没有在真实飞书环境运行这些步骤。

### 1. 配置入口与默认行为

1. 在测试会话发送 `/config`，先使用主要验收组合：消息回复方式＝消息卡片、工具调用显示＝隐藏、CoT 过程消息＝简略；确认“卡片后续动作”可选“自动”或“关闭”。
2. 选择“自动”并提交，确认保存卡片显示“自动”；新消息从自动模式开始。

### 2. 律师三种后续动作

每个用例先让 Agent 在测试工作区生成有明确路径的产物，再点击终态卡片上的对应按钮。

| 用例 | 预置产物与按钮 | 预期 |
| --- | --- | --- |
| 版本对比表 | 准备旧版、新版材料；让 Agent 生成差异表，并登记“版本对比表”动作，prompt 写明两份材料的绝对路径 | 点击后 Toast 显示已入队；当前会话收到逐条版本差异表 |
| 提取条款清单 | 准备审阅材料；登记“提取条款清单”动作，prompt 写明绝对路径、条款范围和原文定位要求 | 点击后当前会话收到条款、页码或原文位置 |
| 导出 Word | 先生成可定位的 `.md` 版本对比表；登记“导出 Word”动作，prompt 写明该 `.md` 绝对路径、转换成 `.docx`，并使用当前 profile 的 `lark-cli` bot 身份上传和发送 | 点击后当前会话收到 `.docx` 附件 |

### 3. 声明状态与总开关

1. 在普通非 Git 案件目录（没有测试入口）完成一轮，明确要求不调用 `action add` 或 `action none`（保持未声明），确认结果卡没有动作按钮。
2. 在有测试入口的 Git 仓库分别完成普通问答和文件写入，明确要求不调用 `action add` 或 `action none`，确认两种结果卡均无动作按钮，也无快捷按钮提示。
3. 在有写入文件的 Git 测试仓库，让 Agent 先登记动作，再在本轮调用 `lark-channel-bridge action none`，确认终态卡不显示任何动作。
4. 触发 `failed`、中断和无进展超时结束，确认终态卡都没有后续动作。
5. `/config` 切为“关闭”，再生成一张含明确动作声明的 `done` 卡，确认按钮不显示；切回“自动”。另在一轮运行期间切换此配置，确认当前轮沿用开始时的设置，下一条消息才使用新设置。

### 4. 历史卡片、权限与重复点击

1. 生成带动态动作的结果卡片，在同一聊天/话题切换会话或工作区，再重启测试 Bridge 并点击旧卡；确认按钮仍有效，Toast 成功，后续运行使用当前会话与工作区，不恢复原运行。
2. 用当前策略不允许的点击者操作该卡，确认收到“无权操作此卡片”，没有新运行入队。
3. 真实再次点击同一按钮，确认允许按普通消息规则再次入队、排队或合批，按钮不会因第一次成功而被一次性作废。相同平台投递事件的去重由真实 SDK 自动化用例覆盖。

## 现场结果记录

| 项目 | 状态 | 证据 / 备注 |
| --- | --- | --- |
| 配置自动 / 关闭 | 待用户执行 |  |
| 导出 Word 收到 `.docx` | 待用户执行 |  |
| 版本对比表 | 待用户执行 |  |
| 条款清单 | 待用户执行 |  |
| 无声明 / 明确零动作 / 无静态兜底 | 待用户执行 |  |
| 失败 / 中断 / 超时 | 待用户执行 |  |
| 重启后历史卡片 | 待用户执行 |  |
| 当前点击者权限 / 平台重投 / 再次点击 | 待用户执行 |  |

## 完整文件变更

以下为本机审阅路径；其他环境以仓库根目录对应同名文件。

| 操作 | 本机完整文件路径 |
| --- | --- |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/GLOSSARY.md` |
| 新增 | `/Users/wuye/Downloads/lark-coding-agent-bridge/docs/specs/issue-12-validation.md` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/agent/bridge-system-prompt.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/bot/channel.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/card/callback-registry.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/card/config-card.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/card/dispatcher.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/card/run-renderer.ts` |
| 新增 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/card/terminal-action-auth.ts` |
| 新增 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/card/terminal-action-context.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/card/terminal-actions.ts` |
| 新增 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/cli/commands/action.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/cli/commands/callback.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/cli/index.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/commands/index.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/config/schema.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/src/runtime/run-executor.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/integration/bot/markdown-stream-startup-failure.test.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/integration/card/callback-dispatch.test.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/integration/commands/profile-config-command.test.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/integration/executor/run-executor.test.ts` |
| 新增 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/process/action-cli.test.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/unit/agent/bridge-system-prompt.test.ts` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap` |
| 修改 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/unit/card/run-renderer.snapshot.test.ts` |
| 新增 | `/Users/wuye/Downloads/lark-coding-agent-bridge/tests/unit/card/terminal-action-auth.test.ts` |
