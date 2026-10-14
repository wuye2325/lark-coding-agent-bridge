# 消息表情回复实现验证

对应 GitHub Issue #3；最终规则见 `reaction-sticker-alignment.md` 与 issue 正文。

## TDD 证据

1. 先从 `startChannel` 注册的事件入口验证添加输入与回执：测试失败，`handlers.reaction` 为 `undefined`；增加消息反查、自身身份校验、访问策略、队列输入及添加回执后通过。
2. 再验证撤回输入不能追加表情：测试失败，实际多调用一次 `addReaction(target, "Typing")`；让 reaction 触发的运行跳过既有 working reaction 后通过。
3. 扩展验收：12 个 reaction 集成测试通过；与 Bot 身份、话题引用、访问策略回归一起运行，4 个文件共 35 个测试通过。`pnpm typecheck` 与 `git diff --check` 通过。

## 已覆盖行为

- 添加与撤回携带原始 emojiType、动作、操作者 openId、完整目标 messageId；不包含内部回调标记。
- 自身发送者以 bot openId 或 appId 表示均可接受；其他用户、其他 Bot、缺失目标信息、反查失败不入队、不回执。
- 群白名单、私聊操作者策略拒绝不入队、不回执。
- 两个话题恢复各自 session，反查所得 thread_id 优先于暂时返回 group 的会话模式。
- 添加、撤回、重加、换表情在合并批次中按顺序保留；ack 失败仍传递输入。
- 使用真实 SDK 的 normalize、SafetyPipeline 与 EventDispatcher，只替换外部 REST 与 WebSocket 传输：同一次 added 重复投递仅一次输入；撤回与新 actionTime 重加保留；Bot ack 的 app 身份事件不归一化为用户 reaction，不形成回路。
- 仅 added 入队后调用 ack；removed 运行不触发 DONE 或 Typing。

## Ack 键名

采用 `DONE`，依据[飞书官方表情文案说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce.md)中的勾选类表情。2026-10-14 直接读取官方 Markdown，包含 `emoji_done.png | DONE`；大小写按官方原值。

本轮未发送真实飞书消息或修改应用配置；部署前提仍为 issue #3 中的 reaction 读取权限与 created/deleted 两事件订阅。
