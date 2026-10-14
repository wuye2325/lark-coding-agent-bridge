# Sticker 实现验证

对应 GitHub Issue #4，日期：2026-10-14。

## Red → green

1. 在 `MediaCache.resolve` seam 添加“表情消息经 file 资源下载后作为图片附件提供”。
   - Red：`pnpm exec vitest run tests/integration/media/attachment-resolver.test.ts`，1 failed / 5 passed；sticker 被跳过，返回 `undefined`，不满足 accepted image。
   - Green：将 sticker 下载结果归一化为 image 后，相同命令 6 passed。
2. 更新既有附件策略回归断言，要求 sticker 接受为 image，音视频保持跳过。
   - Red：`pnpm exec vitest run tests/unit/media/attachment.test.ts`，1 failed / 3 passed；原结果为 `sticker/skipped/sticker`。
   - Green：附件归一化统一图片策略后，resolver 与附件策略测试合计 10 passed。

## 验收回归

`pnpm exec vitest run tests/unit/media tests/integration/media tests/integration/bot/sticker-input.test.ts tests/integration/bot/attachment-run-flow.test.ts`：4 files / 21 tests passed。

- 外部 Lark SDK 与 Agent 进程边界使用 fake；媒体缓存、策略、消息入队、prompt 与执行链路使用真实模块。
- Claude 收到 accepted image 的本地附件 prompt；Codex 同时收到对应 images 参数。
- 下载失败时两种 Agent 的最终 prompt 都保留原始 sticker 标签，同批次其他输入与图片继续处理。
- sticker 沿用图片 MIME、单文件大小、图片大小、总大小与数量限制。
- 普通 image/file 继续接受，audio/video 继续跳过。
- `pnpm typecheck` 与 `git diff --check` 通过。

未调用真实飞书服务或 Agent CLI；本轮证据验证 Bridge 的边界契约与内部传递。
