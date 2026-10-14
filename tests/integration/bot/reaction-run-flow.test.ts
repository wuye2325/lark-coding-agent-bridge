import type { LarkChannelOptions, ReactionEvent } from '@larksuite/channel';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn((_opts: LarkChannelOptions) => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  reaction?: (evt: ReactionEvent) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  addReaction: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('消息表情回复进入 Agent 会话', () => {
  it('SDK 重复投递仅接受一次，真实重加保留且 Bot ack 不形成回路', async () => {
    const h = await createHarness();
    const req = createRequire(import.meta.url);
    const sdkPath = createRequire(req.resolve('@larksuite/channel')).resolve('@larksuiteoapi/node-sdk');
    const sdk = await import(sdkPath);
    let dispatcher: { invoke(data: unknown, params: { needCheck: boolean }): Promise<unknown> };
    const start = vi.spyOn(sdk.WSClient.prototype, 'start').mockImplementation(function (
      this: unknown, input: unknown,
    ) {
      dispatcher = (input as { eventDispatcher: typeof dispatcher }).eventDispatcher;
      (this as { onReady(): void }).onReady();
    });
    const actual = await vi.importActual<typeof import('@larksuite/channel')>('@larksuite/channel');
    sdkMock.createLarkChannel.mockImplementationOnce(opts => {
      const channel = actual.createLarkChannel(opts);
      vi.spyOn(channel.rawClient, 'request').mockResolvedValue({ bot: { open_id: 'ou_bot', app_name: 'Bridge' } });
      vi.spyOn(channel.rawClient.im.v1.message, 'get').mockResolvedValue({ code: 0, data: { items: [{ chat_id: 'oc_chat', message_id: 'om_bot_message_full_id', sender: { id: 'ou_bot', id_type: 'open_id', sender_type: 'app' } }] } });
      vi.spyOn(channel, 'getChatMode').mockResolvedValue('group');
      vi.spyOn(channel, 'getAppInfo').mockResolvedValue({ ownerId: 'ou_owner' });
      vi.spyOn(channel, 'listChats').mockResolvedValue([]);
      vi.spyOn(channel, 'stream').mockResolvedValue({ messageId: 'om_reply' });
      vi.spyOn(channel, 'addReaction').mockImplementation(async () => {
        await dispatcher.invoke(rawEvent('im.message.reaction.created_v1', 5, false), { needCheck: false });
        return 'ack';
      });
      return channel as unknown as FakeLarkChannel;
    });
    try {
      await startTestBridge(h);
      const added = rawEvent('im.message.reaction.created_v1', 1);
      await dispatcher!.invoke(added, { needCheck: false });
      await dispatcher!.invoke(added, { needCheck: false });
      await dispatcher!.invoke(rawEvent('im.message.reaction.deleted_v1', 2), { needCheck: false });
      await dispatcher!.invoke(rawEvent('im.message.reaction.created_v1', 3), { needCheck: false });
      await waitFor(() => h.agent.runOptions.length === 1);
      const input = readSection(h.agent.runOptions[0]!.prompt, 'user_input') as { text: string };
      expect(input.text.match(/\[reaction\]/g)).toHaveLength(3);
      expect(input.text.match(/"action":"added"/g)).toHaveLength(2);
      expect(input.text.match(/"action":"removed"/g)).toHaveLength(1);
      expect(input.text).not.toContain('DONE');
    } finally {
      start.mockRestore();
    }
  });

  it.each(['他人消息', '其他 Bot 消息', '无 sender', '无 chatId', '反查失败', '拒绝群聊', '拒绝私聊'])('%s 不入队也不 ack', async (scenario) => {
    const h = await createHarness();
    const get = h.channel.rawClient.im.v1.message.get;
    if (scenario === '他人消息') get.mockResolvedValue({ data: { items: [{ chat_id: 'oc_chat', sender: { id: 'ou_other', sender_type: 'user' } }] } });
    if (scenario === '其他 Bot 消息') get.mockResolvedValue({ data: { items: [{ chat_id: 'oc_chat', sender: { id: 'cli_other' } }] } });
    if (scenario === '无 sender') get.mockResolvedValue({ data: { items: [{ chat_id: 'oc_chat' }] } });
    if (scenario === '无 chatId') get.mockResolvedValue({ data: { items: [{ message_id: 'om_bot_message_full_id', sender: { id: 'ou_bot', id_type: 'open_id', sender_type: 'app' } }] } });
    if (scenario === '反查失败') get.mockRejectedValue(new Error('没有消息读取权限'));
    if (scenario === '拒绝群聊') h.profileConfig.access.allowedChats = [];
    if (scenario === '拒绝私聊') { h.profileConfig.access.allowedUsers = []; vi.spyOn(h.channel, 'getChatMode').mockResolvedValue('p2p'); }
    await startTestBridge(h);
    await h.channel.handlers.reaction!(reaction());
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.addReaction).not.toHaveBeenCalled();
  });

  it('真实添加、撤回、重加与换表情按顺序保留，ack 失败不丢输入', async () => {
    const h = await createHarness();
    h.channel.addReaction.mockRejectedValue(new Error('重复表情'));
    await startTestBridge(h);
    await h.channel.handlers.reaction!(reaction());
    await h.channel.handlers.reaction!(reaction({ action: 'removed', actionTime: 1760000002000 }));
    await h.channel.handlers.reaction!(reaction({ actionTime: 1760000003000 }));
    await h.channel.handlers.reaction!(reaction({ emojiType: 'No', actionTime: 1760000004000 }));
    await waitFor(() => h.agent.runOptions.length === 1);
    const input = readSection(h.agent.runOptions[0]!.prompt, 'user_input') as { text: string };
    const events = input.text.split('\n\n').map(part => JSON.parse(part.slice(part.indexOf('[reaction] ') + 11)));
    expect(events).toEqual([
      { action: 'added', emojiType: 'OK', operatorOpenId: 'ou_user', messageId: 'om_bot_message_full_id' },
      { action: 'removed', emojiType: 'OK', operatorOpenId: 'ou_user', messageId: 'om_bot_message_full_id' },
      { action: 'added', emojiType: 'OK', operatorOpenId: 'ou_user', messageId: 'om_bot_message_full_id' },
      { action: 'added', emojiType: 'No', operatorOpenId: 'ou_user', messageId: 'om_bot_message_full_id' },
    ]);
    expect(h.channel.addReaction).toHaveBeenCalledTimes(3);
  });

  it('话题目标保持会话隔离并恢复对应 session，支持 appId 发送者', async () => {
    const h = await createHarness();
    h.sessions.set('oc_chat:omt_first', 'session_first', h.profileConfig.workspaces.default!);
    h.sessions.set('oc_chat:omt_second', 'session_second', h.profileConfig.workspaces.default!);
    h.channel.rawClient.im.v1.message.get
      .mockResolvedValueOnce({ data: { items: [{ chat_id: 'oc_chat', thread_id: 'omt_first', sender: { id: 'cli_test' } }] } })
      .mockResolvedValueOnce({ data: { items: [{ chat_id: 'oc_chat', thread_id: 'omt_second', sender: { id: 'cli_test' } }] } });
    await startTestBridge(h);
    await h.channel.handlers.reaction!(reaction());
    await h.channel.handlers.reaction!(reaction({ messageId: 'om_second' }));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions.map(r => r.sessionId).sort()).toEqual(['session_first', 'session_second']);
    expect(h.agent.runOptions.map(r => readSection(r.prompt, 'bridge_context'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: 'omt_first' }),
        expect.objectContaining({ threadId: 'omt_second' }),
      ]),
    );
  });

  it('撤回事件进入 Agent 且不追加任何表情回执', async () => {
    const h = await createHarness();
    h.profileConfig.preferences.messageReply = 'text';
    h.profileConfig.preferences.messageReplyMigrated = true;
    await startTestBridge(h);
    await h.channel.handlers.reaction!(reaction({ action: 'removed' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]!.prompt).toContain('removed');
    expect(h.channel.addReaction).not.toHaveBeenCalled();
  });
  it('接受本 Bot 消息的添加事件并携带完整上下文与回执', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    expect(h.channel.handlers.reaction).toBeTypeOf('function');
    await h.channel.handlers.reaction?.(reaction());
    await waitFor(() => h.agent.runOptions.length === 1);
    const prompt = h.agent.runOptions[0]!.prompt;
    expect(prompt).toContain('added');
    expect(prompt).toContain('OK');
    expect(prompt).toContain('ou_user');
    expect(prompt).toContain('om_bot_message_full_id');
    expect(prompt).not.toContain('__bridge_cb');
    expect(h.channel.addReaction).toHaveBeenCalledWith('om_bot_message_full_id', 'DONE');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('bot-at-bot-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    addReaction: vi.fn(async () => 'reaction_ack'),
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [{ chat_id: 'oc_chat', sender: { id: 'ou_bot', sender_type: 'app' } }] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function reaction(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
  return { messageId: 'om_bot_message_full_id', operator: { openId: 'ou_user' },
    emojiType: 'OK', action: 'added', actionTime: 1760000001000, ...overrides };
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

function rawEvent(eventType: string, time: number, user = true): unknown {
  return {
    schema: '2.0',
    header: { event_id: `reaction-${time}`, event_type: eventType, create_time: '1760000001000' },
    event: { message_id: 'om_bot_message_full_id', action_time: String(time),
      operator_type: user ? 'user' : 'app',
      ...(user ? { user_id: { open_id: 'ou_user' } } : {}),
      reaction_type: { emoji_type: user ? 'OK' : 'DONE' } },
  };
}
