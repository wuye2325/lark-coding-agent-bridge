import type { LarkChannel, CardActionEvent, CardActionResponse } from '@larksuite/channel';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';

// 只替换外部 WebSocket 传输；保留真实 SDK 的解析、事件分派及 safety 管线。
const requireBridge = createRequire(process.env.BRIDGE_TEST_PACKAGE_DIR
  ? join(process.env.BRIDGE_TEST_PACKAGE_DIR, 'package.json') : import.meta.url);
const sdkEntry = requireBridge.resolve('@larksuite/channel');
const requireSdk = createRequire(sdkEntry);
const sdk = requireSdk('@larksuiteoapi/node-sdk') as {
  WSClient: { prototype: { start(options: { eventDispatcher: Dispatcher }): void } };
};
type Dispatcher = { invoke(data: unknown, options: { needCheck: boolean }): Promise<unknown> };

export async function createSdkCardIngress(
  handler: (evt: CardActionEvent) => Promise<void | CardActionResponse>, mode: 'esm' | 'cjs' = 'cjs',
) {
  const { LarkChannel: Channel } = (mode === 'esm'
    ? await import(/* @vite-ignore */ pathToFileURL(join(dirname(sdkEntry), 'index.mjs')).href)
    : requireBridge('@larksuite/channel')) as { LarkChannel: typeof LarkChannel };
  let dispatcher: Dispatcher;
  const start = vi.spyOn(sdk.WSClient.prototype, 'start').mockImplementation(function (this: { onReady(): void }, options) {
    dispatcher = options.eventDispatcher;
    this.onReady();
  });
  const channel = new Channel({
    appId: 'cli_card_test', appSecret: 'test-secret', includeRawEvent: true,
    safety: { chatQueue: { enabled: false } },
    cache: { get: async () => undefined, set: async () => true },
  });
  vi.spyOn(channel.rawClient, 'request').mockResolvedValue({ bot: { open_id: 'ou_bot', app_name: '测试' } });
  channel.on('cardAction', handler);
  try { await channel.connect(); } finally { start.mockRestore(); }
  return {
    channel,
    click: (payload: Record<string, unknown>) => dispatcher.invoke({
      schema: '2.0', header: { event_type: 'card.action.trigger', ...payload.header as object },
      event: { context: { open_message_id: 'om_card', open_chat_id: 'oc_group' }, operator: { open_id: 'ou_operator' }, ...payload },
    }, { needCheck: false }),
  };
}
