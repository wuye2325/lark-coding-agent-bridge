import type { CardActionEvent, CardActionResponse, NormalizedMessage } from '@larksuite/channel';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types.js';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import type { FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { CallbackRegistryStore } from '../../../src/card/callback-registry.js';
import { TerminalActionAuth } from '../../../src/card/terminal-action-auth.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
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
  message?: (msg: NormalizedMessage) => Promise<void> | void;
  cardAction?: (evt: CardActionEvent) => Promise<void | CardActionResponse> | void | CardActionResponse;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  recalled: string[];
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
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<unknown>;
  recallMessage(messageId: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type SendFn = FakeLarkChannel['send'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('CardKit 会话续接', () => {
  it.each([
    { kind: 'claude', resetQueued: false }, { kind: 'codex', resetQueued: false },
    { kind: 'claude', resetQueued: true }, { kind: 'codex', resetQueued: true },
  ] as const)('登记卡片续接或拒绝排队期间的会话重置：$kind reset=$resetQueued', async ({ kind, resetQueued }) => {
    const h = await createHarness({ messageReply: 'text', agentKind: kind });
    h.profileConfig.access.allowedChats.push('oc_dm');
    const finish = deferred<void>();
    const runOptions: Parameters<AgentAdapter['run']>[0][] = [];
    const agent: AgentAdapter = {
      id: kind, displayName: kind, isAvailable: async () => true,
      run(opts) {
        runOptions.push(opts);
        const first = runOptions.length === 1;
        return {
          runId: opts.runId, stop: async () => { finish.resolve(); }, waitForExit: async () => true,
          events: (async function* (): AsyncIterable<AgentEvent> {
            yield { type: 'system', sessionId: 'callback-session', threadId: 'callback-thread' };
            if (first) await finish.promise;
            yield { type: 'done', terminationReason: 'normal' };
          })(),
        };
      },
    };
    await startTestBridge(h, agent, true);
    await h.channel.handlers.message?.(message('om_source', '给我一张选择卡'));
    await waitFor(() => runOptions.length === 1);
    const token = runOptions[0]!.callbackToken!;
    const registry = new CallbackRegistryStore(join(h.tmp.profile, 'callback-registry.json'));
    const registration = await registry.register(token, {
      schema: { type: 'object', properties: { choice: { type: 'string', enum: ['a'] } }, required: ['choice'] },
    });
    expect(await h.channel.handlers.cardAction?.({
      messageId: 'om_choice_card', chatId: 'oc_dm', operator: { openId: 'ou_user' },
      action: { value: { __bridge_cb: true, callback_id: registration.id, choice: 'a' }, tag: 'button' },
    })).toEqual({ toast: { type: 'info', content: '卡片正在准备，请稍后再点' } });
    await registry.bind(token, registration.id, 'om_choice_card');
    finish.resolve();
    await waitFor(async () => {
      try { await registry.register(token, { schema: { type: 'object', properties: {} } }); return false; }
      catch { return true; }
    });

    const evt = {
      messageId: 'om_choice_card', chatId: 'oc_dm', operator: { openId: 'ou_user' },
      action: { value: { __bridge_cb: true, callback_id: registration.id, choice: 'a' }, tag: 'button' },
      raw: { header: { event_id: 'event-choice' } },
    } satisfies CardActionEvent;
    const previousAccess = h.profileConfig.permissions.defaultAccess;
    h.profileConfig.permissions.defaultAccess = 'read-only';
    await h.channel.handlers.cardAction?.(evt);
    expect(runOptions).toHaveLength(1);
    h.profileConfig.permissions.defaultAccess = previousAccess;
    await h.channel.handlers.cardAction?.(evt);
    if (resetQueued) {
      await h.channel.handlers.message?.(message('om_reset', '/new'));
      await h.channel.handlers.message?.(message('om_fresh', '新问题'));
      await waitFor(() => runOptions.length === 2);
      expect(runOptions[1]?.sessionId).toBeUndefined();
      expect(runOptions[1]?.threadId).toBeUndefined();
      expect(runOptions[1]?.prompt).toContain('新问题');
      expect(runOptions[1]?.prompt).not.toContain('[card-click]');
      await waitForRunEnd();
      return;
    }
    await waitFor(() => runOptions.length === 2);
    expect(runOptions[1]).toMatchObject(kind === 'claude' ? { sessionId: 'callback-session' } : { threadId: 'callback-thread' });
    const userInput = runOptions[1]!.prompt.match(/<user_input>\s*([\s\S]*?)\s*<\/user_input>/)![1]!;
    expect(JSON.parse(userInput).text).toBe('[card-click] {"choice":"a"}');
    expect(runOptions[1]!.prompt).not.toContain(registration.id);
    await waitForRunEnd();

    async function waitForRunEnd(): Promise<void> {
      await waitFor(async () => {
        try { await registry.register(runOptions[1]!.callbackToken!, { schema: { type: 'object', properties: {} } }); return false; }
        catch { return true; }
      });
    }
  });
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    const sentCards = JSON.stringify(h.channel.sent.map((entry) => entry.content));
    expect(sentCards).toContain('agent 失败');
    expect(sentCards).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(JSON.stringify(h.channel.sent.map((entry) => entry.content))).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      // The first run has to stream something, or no progress stream is opened
      // at all and there is no late failure to log.
      events: [
        [
          { type: 'text', delta: 'progress update' },
          {
            type: 'error',
            message: 'codex exited with code 1: Error loading config.toml',
            terminationReason: 'failed',
          },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('sends one dedicated non-streaming final reply after progress completes', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((markdown) => markdown.includes('progress update'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastCard(h.channel)).toContain('FINAL_SENTINEL');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_final' });
  });

  it('sends only the successful Claude result through the text-mode channel', async () => {
    const binary = await createFakeBinary([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'assistant process should stay hidden' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '第一段最终答案\n\n第二段最终答案',
        session_id: 'sess-channel-result',
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    ]);
    cleanups.push(binary.cleanup);
    const h = await createHarness({ agentKind: 'claude', messageReply: 'text' });
    // 未设置持久化迁移标记时，`text` 会被兼容逻辑转换为 markdown。
    h.controls.cfg.preferences.messageReplyMigrated = true;
    await startTestBridge(h, new ClaudeAdapter({ binary: binary.path }));

    await h.channel.handlers.message?.(message('om_channel_result', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    const content = h.channel.sent[0]?.content as { markdown?: string } | undefined;
    expect(content?.markdown).toBe('第一段最终答案\n\n第二段最终答案');
  });

  it.each([
    { name: 'completes a CoT bubble', createFails: false },
    { name: 'falls back when CoT creation fails', createFails: true },
  ])('sends only the final result when it $name', async ({ createFails }) => {
    const cotUrls = mockCotApi(createFails);
    const binary = await createFakeBinary([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '过程文本不应进入最终消息' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-cot', name: 'Bash', input: { command: 'true' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-cot', content: 'ok' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '末条 assistant 草稿也不应进入最终消息' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'CoT 路径最终答案',
        session_id: 'sess-cot-result',
      }),
    ]);
    cleanups.push(binary.cleanup);
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'text',
      cotMessages: 'brief',
    });
    h.controls.cfg.preferences.messageReplyMigrated = true;
    await startTestBridge(h, new ClaudeAdapter({ binary: binary.path }));

    await h.channel.handlers.message?.(message('om_cot_result', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    const content = h.channel.sent[0]?.content as { markdown?: string } | undefined;
    expect(content?.markdown).toBe('CoT 路径最终答案');
    expect(cotUrls.some((url) => url.includes('/open-apis/im/v1/message_cot'))).toBe(true);
    expect(cotUrls.some((url) => url.includes('/complete/'))).toBe(!createFails);
  });

  it('opens no progress stream for a final-only round', async () => {
    // The regression this guards: Codex answering without any commentary. The
    // SDK sends its streaming card as soon as `stream()` is called and finishes
    // an empty one with "(no content)", so the user saw that placeholder for a
    // few seconds, watched it get recalled, and only then got the answer.
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_ONLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_only', 'run'));
    await waitFor(() => h.channel.sent.length === 1);
    // give a stray stream / recall a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(streamCalls).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastCard(h.channel)).toContain('FINAL_ONLY_SENTINEL');
  });

  it('does not repeat streamed text in the result card when Codex held nothing back', async () => {
    // Codex only reserves its *last* message as `final_text`; an abnormal turn
    // end (turn.failed, or the process dying before turn.completed) flushes it
    // as a text block instead. Those blocks are already on screen, so the
    // dedicated final reply must not post the same words a second time.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: '这是答案' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_final', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('这是答案')));
    // 留出时间让终态结果卡片送达，再执行断言。
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(1);
    expect(lastCard(h.channel)).not.toContain('这是答案');
    expect(lastCard(h.channel)).toContain('未返回内容');
  });

  it('waits for a slow-opening progress stream instead of replying alongside it', async () => {
    // Opening a streaming card costs two API round trips. When the run finishes
    // first, replying right away duplicates the answer verbatim — once as text,
    // once as the card that lands a moment later.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_slow_stream', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('ANSWER_ONCE')));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(1);
    expect(lastCard(h.channel)).not.toContain('ANSWER_ONCE');
  });

  it('renders nothing in a progress stream it already gave up on', async () => {
    // If the stream is still not producing after the grace window we do reply
    // without it — but the stream must then stay empty, or the answer shows up
    // twice as soon as it catches up.
    const gate = deferred<void>();
    const setContent = vi.fn(async () => {});
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await gate.promise;
        await producer?.({ setContent });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stuck_stream', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 6000);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(lastCard(h.channel)).toContain('ANSWER_ONCE');
    expect(h.channel.sent).toHaveLength(1);
    expect(setContent).not.toHaveBeenCalled();
  }, 15_000);

  it('still sends the final reply when the progress stream fails at completion', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_AFTER_STREAM_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        throw new Error('progress stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastCard(h.channel)).toContain('FINAL_AFTER_STREAM_FAILURE');
    expect(
      fail.mock.calls.some(
        (call) =>
          call[0] === 'stream' &&
          call[1] instanceof Error &&
          call[1].message === 'progress stream failed' &&
          (call[2] as { step?: string } | undefined)?.step === 'progress-stream',
      ),
    ).toBe(true);
  });

  it('does not record delivery when the final send has no message receipt', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_WITHOUT_RECEIPT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_receipt', 'run'));
    await waitFor(() =>
      fail.mock.calls.some(
        (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
      ),
    );

    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent'),
    ).toBe(false);
  });

  it('sends one dedicated final reply card after progress completes in card mode', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            progressCards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    // Intermediate agent messages stream as progress; the final answer never
    // leaks into the progress card (it is held back for the dedicated reply).
    const progressJson = JSON.stringify(progressCards);
    expect(progressJson).toContain('progress update');
    expect(progressJson).not.toContain('FINAL_SENTINEL');

    // The terminal answer arrives as exactly one non-streaming card send.
    expect(h.channel.sent).toHaveLength(1);
    const finalJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(finalJson).toContain('FINAL_SENTINEL');
    expect(finalJson).not.toContain('progress update');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_card_final' });
  });
});

describe('CoT 与最终结果卡片联动', () => {
  it('实际 channel run 在 markdown+隐藏工具+简略 CoT 下发出已签名动作，并遵守零动作与关闭偏好', async () => {
    const cotUrls = mockCotApi(false);
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'brief',
    });
    const registry = new CallbackRegistryStore(join(h.tmp.profile, 'callback-registry.json'));
    cleanups.push(() => registry.close());
    const actionPrompt = `提取 ${join(h.tmp.workspace, '版本对比表.md')} 中的差异并发到当前会话`;
    const firstRunStarted = deferred<void>();
    const finishFirstRun = deferred<void>();
    let runNumber = 0;
    const agent: AgentAdapter = {
      id: 'claude',
      displayName: 'Claude Code',
      isAvailable: async () => true,
      run(opts) {
        const thisRun = ++runNumber;
        return {
          runId: opts.runId,
          stop: async () => {},
          waitForExit: async () => true,
          events: (async function* (): AsyncIterable<AgentEvent> {
            const token = opts.callbackToken;
            if (!token) throw new Error('测试运行未获签名 token');
            if (thisRun === 3) await registry.declareNoTerminalActions(token);
            else await registry.addTerminalAction(token, { label: '提取差异', prompt: actionPrompt });
            if (thisRun === 1) {
              yield { type: 'text', delta: '正在整理材料' };
              firstRunStarted.resolve(undefined);
              await finishFirstRun.promise;
            }
            yield { type: 'final_text', content: `最终答复 ${thisRun}` };
            yield { type: 'tool_use', id: `hidden-${thisRun}`, name: 'Bash', input: { command: 'secret command' } };
            yield { type: 'tool_result', id: `hidden-${thisRun}`, output: 'secret output', isError: false };
            yield { type: 'done', terminationReason: 'normal' };
          })(),
        };
      },
    };
    await startTestBridge(h, agent, true);

    const readSentCard = async (index: number): Promise<{ card: unknown; json: string }> => {
      await waitFor(() => h.channel.sent.length >= index);
      const content = h.channel.sent[index - 1]?.content as { card?: unknown } | undefined;
      expect(content?.card).toBeDefined();
      return { card: content?.card, json: JSON.stringify(content?.card) };
    };
    await h.channel.handlers.message?.(message('om_action_dynamic', '制作版本对比表'));
    await firstRunStarted.promise;
    h.controls.cfg.preferences = { ...(h.controls.cfg.preferences ?? {}), terminalActions: 'off' };
    finishFirstRun.resolve(undefined);
    await waitFor(() => h.channel.sent.length >= 1);
    const first = await readSentCard(1);
    expect(first.json).toContain('最终答复 1');
    expect(first.json).not.toContain('secret command');
    expect(first.json).not.toContain('secret output');
    const firstValues = terminalActionButtonValues(first.card);
    expect(firstValues.map((value) => value.cmd)).toEqual(['prompt.custom']);
    expect(new TerminalActionAuth({ secret: 'secret' }).verify(
      String(firstValues[0]?.terminal_action_token), { chatId: 'oc_dm', scope: 'oc_dm' },
    )).toEqual({ ok: true, prompt: actionPrompt });

    await h.channel.handlers.message?.(message('om_action_off', '关闭后续动作'));
    await waitFor(() => h.channel.sent.length >= 2);
    const second = await readSentCard(2);
    expect(second.json).toContain('最终答复 2');
    expect(second.json).not.toContain('prompt.custom');

    h.controls.cfg.preferences = { ...(h.controls.cfg.preferences ?? {}), terminalActions: 'auto' };
    await h.channel.handlers.message?.(message('om_action_none', '无需后续动作'));
    await waitFor(() => h.channel.sent.length >= 3);
    const third = await readSentCard(3);
    expect(third.json).toContain('最终答复 3');
    expect(third.json).not.toContain('prompt.custom');
    expect(cotUrls.some((url) => url.includes('/open-apis/im/v1/message_cot'))).toBe(true);
  });

  it.each([
    { replyMode: 'markdown' as const, agentKind: 'codex' as const },
    { replyMode: 'markdown' as const, agentKind: 'claude' as const },
    { replyMode: 'card' as const, agentKind: 'codex' as const },
    { replyMode: 'card' as const, agentKind: 'claude' as const },
  ])('保留 $replyMode 配置入口并发送一张增强结果卡片', async ({ replyMode, agentKind }) => {
    const cotUrls = mockCotApi(false);
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      agentKind,
      messageReply: replyMode,
      showToolCalls: false,
      cotMessages: 'brief',
      events: [
        { type: 'text', delta: '过程只应出现在 CoT 中' },
        { type: 'tool_use', id: 'hidden-tool', name: 'Bash', input: { command: 'hidden command' } },
        { type: 'tool_result', id: 'hidden-tool', output: 'hidden output', isError: true },
        { type: 'final_text', content: '最终答复只应出现在结果卡片中' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_result_card', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(cotUrls.some((url) => url.includes('/open-apis/im/v1/message_cot'))).toBe(true);
    expect(streamCalls).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    const content = h.channel.sent[0]?.content as { card?: unknown; markdown?: string } | undefined;
    expect(content?.card).toBeDefined();
    expect(content?.markdown).toBeUndefined();
    const result = content?.card as {
      header?: {
        title?: { content?: string };
        subtitle?: { content?: string };
        text_tag_list?: Array<{ text?: { content?: string }; color?: string }>;
      };
      body?: { elements?: Array<{ tag?: string; content?: string }> };
    };
    const resultJson = JSON.stringify(result);
    expect(resultJson).toContain('最终答复只应出现在结果卡片中');
    expect(resultJson).not.toContain('过程只应出现在 CoT 中');
    expect(resultJson).not.toMatch(/Bash|hidden command|hidden output/);
    expect(result?.header?.title?.content).toBe(agentKind === 'claude' ? '🤖 Claude Code' : '🤖 Codex');
    expect(result?.body?.elements?.at(-1)?.content).toContain('处理时长');
    expect(result?.header?.text_tag_list?.[0]).toMatchObject({
      text: { content: '已完成 · 1 次工具错误' },
      color: 'orange',
    });
    expect(resultJson).toContain('工具调用：1 次 · 成功 0 · 错误 1');
  });

  const cotModes = ['off', 'brief', 'detailed'] as const;
  const toolVisibilityModes = [false, true] as const;
  const replyModes = ['card', 'markdown', 'text'] as const;
  const displayCombinations = cotModes.flatMap((cotMessages) =>
    toolVisibilityModes.flatMap((showToolCalls) =>
      replyModes.map((messageReply) => ({ cotMessages, showToolCalls, messageReply })),
    ),
  );

  it.each(displayCombinations)(
    'covers the message entry matrix: CoT=$cotMessages tools=$showToolCalls reply=$messageReply',
    async ({ cotMessages, showToolCalls, messageReply }) => {
      const cotBodies: string[] = [];
      const cotUrls = mockCotApi(false, false, cotBodies);
      const streamCalls: unknown[] = [];
      const progressContent: string[] = [];
      const h = await createHarness({
        agentKind: 'codex',
        messageReply,
        showToolCalls,
        cotMessages,
        events: [
          { type: 'text', delta: 'MATRIX_PROCESS_TEXT' },
          { type: 'tool_use', id: 'matrix-error', name: 'Bash', input: { command: 'matrix-error-command' } },
          { type: 'tool_result', id: 'matrix-error', output: 'MATRIX_ERROR_OUTPUT', isError: true },
          { type: 'tool_use', id: 'matrix-success', name: 'Read', input: { file_path: 'matrix-file.ts' } },
          { type: 'tool_result', id: 'matrix-success', output: 'MATRIX_SUCCESS_OUTPUT', isError: false },
          { type: 'final_text', content: 'MATRIX_FINAL_ANSWER' },
          { type: 'done', terminationReason: 'normal' },
        ],
        stream: async (_chatId, input) => {
          streamCalls.push(input);
          const cardProducer = (input as {
            card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
          }).card?.producer;
          const markdownProducer = (input as {
            markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
          }).markdown;
          await cardProducer?.({
            update: async (next) => { progressContent.push(JSON.stringify(next)); },
          });
          await markdownProducer?.({
            setContent: async (content) => { progressContent.push(content); },
          });
          return { messageId: 'om_matrix_progress' };
        },
      });
      if (messageReply === 'text') h.controls.cfg.preferences.messageReplyMigrated = true;
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_matrix_${cotMessages}_${showToolCalls}_${messageReply}`, 'run'));
      await waitFor(() => h.channel.sent.length === 1);

      const sent = h.channel.sent[0];
      expect(h.channel.sent).toHaveLength(1);
      expect(sent?.options).toMatchObject({ replyTo: `om_matrix_${cotMessages}_${showToolCalls}_${messageReply}` });
      const finalContent = sent?.content as { card?: unknown; markdown?: string };
      const finalJson = JSON.stringify(finalContent);
      expect(finalJson.split('MATRIX_FINAL_ANSWER').length - 1).toBe(1);
      expect(finalJson).not.toContain('MATRIX_PROCESS_TEXT');

      if (messageReply === 'text') {
        expect(finalContent.card).toBeUndefined();
        expect(finalContent.markdown).toContain('MATRIX_FINAL_ANSWER');
      } else {
        expect(finalContent.card).toBeDefined();
        expect(finalContent.markdown).toBeUndefined();
        expect(finalJson).toContain('工具调用：2 次 · 成功 1 · 错误 1');
        expect(finalJson).toContain('已完成 · 1 次工具错误');
        if (showToolCalls) expect(finalJson).toContain('MATRIX_ERROR_OUTPUT');
        else expect(finalJson).not.toContain('MATRIX_ERROR_OUTPUT');
      }

      if (cotMessages === 'off') {
        expect(cotUrls.some((url) => url.includes('/open-apis/im/v1/message_cot'))).toBe(false);
        if (messageReply === 'text') {
          expect(streamCalls).toHaveLength(0);
        } else {
          expect(streamCalls).toHaveLength(1);
          if (showToolCalls) expect(progressContent.join('\n')).toContain('Bash');
          else expect(progressContent.join('\n')).not.toMatch(/Bash|matrix-error-command|MATRIX_ERROR_OUTPUT/);
        }
      } else {
        expect(streamCalls).toHaveLength(0);
        expect(cotUrls.some((url) => url.includes('/open-apis/im/v1/message_cot'))).toBe(true);
        const cotContent = cotBodies.join('\n');
        if (!showToolCalls) {
          expect(cotContent).not.toMatch(/Bash|Read|matrix-error-command|matrix-file\.ts|MATRIX_ERROR_OUTPUT|MATRIX_SUCCESS_OUTPUT/);
        } else {
          expect(cotContent).toContain('Bash');
          expect(cotContent).toContain('matrix-error-command');
          if (cotMessages === 'brief') {
            expect(cotContent).not.toContain('TOOL_CALL_ARGS');
            expect(cotContent).not.toContain('MATRIX_ERROR_OUTPUT');
            expect(cotContent).not.toContain('MATRIX_SUCCESS_OUTPUT');
          } else {
            expect(cotContent).toContain('TOOL_CALL_ARGS');
            expect(cotContent).toContain('MATRIX_ERROR_OUTPUT');
            expect(cotContent).toContain('MATRIX_SUCCESS_OUTPUT');
          }
        }
      }
    },
  );

  it('在 CoT 工具隐藏后仍从完整运行记录展示写入清单，并隐藏失败详情', async () => {
    const cotBodies: string[] = [];
    mockCotApi(false, false, cotBodies);
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'brief',
      events: [
        { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'src/写入文件.ts' } },
        { type: 'tool_result', id: 'edit', output: 'updated', isError: false },
        { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'src/写入文件.ts' } },
        { type: 'tool_result', id: 'write', output: 'written', isError: false },
        {
          type: 'tool_use',
          id: 'notebook',
          name: 'NotebookEdit',
          input: { notebook_path: 'analysis/book.ipynb' },
        },
        { type: 'tool_result', id: 'notebook', output: 'updated', isError: false },
        { type: 'tool_use', id: 'failed-edit', name: 'Edit', input: { file_path: 'private/failed.ts' } },
        { type: 'tool_result', id: 'failed-edit', output: 'CONFIDENTIAL_ERROR_DETAIL', isError: true },
        { type: 'final_text', content: '清单入口最终答复' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_hidden_manifest', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    const resultJson = lastCard(h.channel);
    expect(resultJson).toContain('清单入口最终答复');
    expect(resultJson).toContain('📝 写入文件清单（2 个文件）');
    expect(resultJson).toContain('src/写入文件.ts');
    expect(resultJson).toContain('analysis/book.ipynb');
    expect(resultJson).toContain('工具调用：4 次 · 成功 3 · 错误 1');
    expect(resultJson).toContain('已完成 · 1 次工具错误');
    expect(resultJson).not.toMatch(/private\/failed\.ts|CONFIDENTIAL_ERROR_DETAIL|Edit|Write|NotebookEdit/);
    expect(cotBodies.join('\n')).not.toMatch(
      /private\/failed\.ts|CONFIDENTIAL_ERROR_DETAIL|Edit|Write|NotebookEdit/,
    );
  });

  it('长答复与长写入路径从消息入口投影后仍满足整卡 UTF-8 预算', async () => {
    const cotBodies: string[] = [];
    mockCotApi(false, false, cotBodies);
    const finalAnswer = `FINAL_ANSWER_START ${'关键答复'.repeat(7_000)} user@example.com`;
    const events: AgentEvent[] = [
      { type: 'tool_use', id: 'budget-error', name: 'Bash', input: { command: 'verify' } },
      { type: 'tool_result', id: 'budget-error', output: 'HIDDEN_BUDGET_ERROR', isError: true },
    ];
    for (let index = 0; index < 20; index += 1) {
      const id = `budget-write-${index}`;
      events.push({
        type: 'tool_use',
        id,
        name: 'Write',
        input: { file_path: `user${index}@example.com/${'长路径'.repeat(100)}` },
      });
      events.push({ type: 'tool_result', id, output: 'written', isError: false });
    }
    events.push(
      { type: 'final_text', content: finalAnswer },
      { type: 'done', terminationReason: 'normal' },
    );
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'brief',
      events,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_budget', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    const resultJson = lastCard(h.channel);
    const resultCard = JSON.parse(resultJson) as {
      body?: {
        elements?: Array<{
          tag?: string;
          columns?: Array<{
            elements?: Array<{ behaviors?: Array<{ value?: Record<string, unknown> }> }>;
          }>;
        }>;
      };
    };
    const actionColumnSet = resultCard.body?.elements?.find((element) => element.tag === 'column_set');
    const actionCommands = actionColumnSet?.columns?.flatMap((column) =>
      column.elements?.flatMap((element) => element.behaviors?.map((behavior) => behavior.value?.cmd) ?? []) ?? [],
    );

    expect(Buffer.byteLength(resultJson, 'utf8')).toBeLessThan(15_000);
    expect(resultJson).toContain('FINAL_ANSWER_START');
    expect(resultJson).toContain('已完成 · 1 次工具错误');
    expect(resultJson).toContain('📝 写入文件清单（20 个文件）');
    expect(resultJson).toContain('另有');
    expect(resultJson).not.toMatch(/HIDDEN_BUDGET_ERROR|@example\.com/);
    expect(resultJson).toContain('[at]example.com');
    expect(actionCommands).toBeUndefined();
    expect(cotBodies.join('\n')).not.toMatch(/HIDDEN_BUDGET_ERROR|user\d+@example\.com/);
  });

  it('正常结束但没有正文时仍发送状态与摘要卡片', async () => {
    const cotUrls = mockCotApi(false);
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'brief',
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_empty_answer', 'run'));
    await waitFor(() => cotUrls.some((url) => url.includes('/complete/')));

    expect(h.channel.sent).toHaveLength(1);
    const resultJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(resultJson).toContain('已完成');
    expect(resultJson).toContain('工具调用：0 次 · 成功 0 · 错误 0');
    expect(resultJson).toContain('未返回内容');
    const card = h.channel.sent[0]?.content as { card?: { header?: {
      template?: string;
      text_tag_list?: Array<{ color?: string }>;
    } } };
    expect(card.card?.header?.template).toBe('green');
    expect(card.card?.header?.text_tag_list?.[0]?.color).toBe('green');
  });

  it('没有最终正文的中断仍优先显示终态并列出未完成调用', async () => {
    const cotUrls = mockCotApi(false);
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'brief',
      events: [
        { type: 'text', delta: '中断前的过程文本不应复制进结果卡片' },
        { type: 'tool_use', id: 'failed-tool', name: 'Bash', input: { command: 'hidden failure' } },
        { type: 'tool_result', id: 'failed-tool', output: 'hidden error', isError: true },
        { type: 'tool_use', id: 'unfinished-tool', name: 'Read', input: { file_path: 'hidden path' } },
        { type: 'done', terminationReason: 'interrupted' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_interrupted_empty', 'run'));
    await waitFor(() => cotUrls.some((url) => url.includes('/complete/')));

    expect(h.channel.sent).toHaveLength(1);
    const card = h.channel.sent[0]?.content as {
      card?: {
        header?: {
          template?: string;
          text_tag_list?: Array<{ text?: { content?: string }; color?: string }>;
        };
      };
    };
    expect(card.card?.header?.template).toBe('grey');
    expect(card.card?.header?.text_tag_list?.[0]).toMatchObject({
      text: { content: '已中断' },
      color: 'neutral',
    });
    const resultJson = JSON.stringify(card.card);
    expect(resultJson).toContain('工具调用：2 次 · 成功 0 · 错误 1 · 未完成 1');
    expect(resultJson).not.toMatch(/中断前的过程文本|Bash|Read|hidden failure|hidden error|hidden path/);
  });

  it('CoT 关闭时保留 markdown 过程流并以结果卡片收尾', async () => {
    const cotUrls = mockCotApi(false);
    const streamInputs: unknown[] = [];
    const streamedContent: string[] = [];
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'off',
      events: [
        { type: 'text', delta: '旧模式的过程消息' },
        { type: 'tool_use', id: 'hidden-off-tool', name: 'Bash', input: { command: 'hidden off command' } },
        { type: 'tool_result', id: 'hidden-off-tool', output: 'hidden off output', isError: false },
        { type: 'final_text', content: '旧模式的最终答复' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamInputs.push(input);
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: async (markdown) => { streamedContent.push(markdown); } });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_off_keeps_markdown', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(cotUrls.some((url) => url.includes('/open-apis/im/v1/message_cot'))).toBe(false);
    expect(streamInputs).toHaveLength(1);
    expect(streamedContent.some((content) => content.includes('旧模式的过程消息'))).toBe(true);
    expect(JSON.stringify(streamedContent)).not.toMatch(/Bash|hidden off command|hidden off output/);
    const result = h.channel.sent[0]?.content as { card?: unknown; markdown?: string };
    expect(result.card).toBeDefined();
    expect(result.markdown).toBeUndefined();
    expect(JSON.stringify(result.card)).toContain('旧模式的最终答复');
    expect(JSON.stringify(result.card)).not.toContain('旧模式的过程消息');
  });

  it.each([
    { cotMessages: 'off' as const, createFails: false },
    { cotMessages: 'brief' as const, createFails: true },
  ])('markdown 过程流结束后用结果卡片收尾，并撤回重复答案载体：$cotMessages', async ({ cotMessages, createFails }) => {
    const cotUrls = mockCotApi(createFails);
    const streamedContent: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages,
      events: [
        { type: 'text', delta: '先检查现状。' },
        { type: 'text', delta: '这是最终答复。' },
        { type: 'final_text', content: '这是最终答复。' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: async (markdown) => { streamedContent.push(markdown); } });
        return {
          messageId: 'om_progress_with_answer',
          chunkIds: ['om_progress_chunk_1', 'om_progress_chunk_2'],
        };
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_markdown_final_card', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(streamedContent.some((content) => content.includes('这是最终答复。'))).toBe(true);
    expect(h.channel.recalled).toEqual([
      'om_progress_chunk_1',
      'om_progress_chunk_2',
      'om_progress_with_answer',
    ]);
    expect(h.channel.sent).toHaveLength(1);
    const content = h.channel.sent[0]?.content as { card?: unknown; markdown?: string };
    expect(content.card).toBeDefined();
    expect(content.markdown).toBeUndefined();
    expect(JSON.stringify(content.card)).toContain('这是最终答复。');
    expect(JSON.stringify(content.card)).not.toContain('先检查现状。');
    expect(cotMessages === 'off' || cotUrls.some((url) => url.includes('/open-apis/im/v1/message_cot'))).toBe(true);
  });

  it('结果卡发送失败时不撤回仍可见的 markdown 最终答案', async () => {
    const streamedContent: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'off',
      events: [
        { type: 'text', delta: '流式最终答复不能被提前撤回' },
        { type: 'final_text', content: '流式最终答复不能被提前撤回' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: async (markdown) => { streamedContent.push(markdown); } });
        return { messageId: 'om_stream_kept_after_card_failure' };
      },
      send: async (_chatId, content) => {
        if ((content as { card?: unknown }).card) throw new Error('result card send failed');
        return { messageId: 'sent_fallback' };
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_send_failure', 'run'));
    await waitFor(() => h.channel.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(streamedContent.join('\n')).toContain('流式最终答复不能被提前撤回');
    expect(h.channel.recalled).toEqual([]);
  });

  it('CoT 更新失败时保留降级提示并只发送一次最终答案', async () => {
    mockCotApi(false, true);
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'markdown',
      showToolCalls: false,
      cotMessages: 'brief',
      events: [
        { type: 'text', delta: 'CoT 更新失败时的过程文本' },
        { type: 'final_text', content: '更新失败仍要保留最终答案' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => { streamCalls.push(input); },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_cot_update_fallback', 'run'));
    await waitFor(() => h.channel.sent.length === 2);

    expect(streamCalls).toHaveLength(0);
    const markdowns = h.channel.sent.flatMap((entry) => {
      const content = entry.content as { markdown?: string };
      return content.markdown ? [content.markdown] : [];
    });
    expect(markdowns).toEqual(['COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。']);
    const cards = h.channel.sent.flatMap((entry) => {
      const content = entry.content as { card?: unknown };
      return content.card ? [JSON.stringify(content.card)] : [];
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('更新失败仍要保留最终答案');
    expect(cards[0]).not.toContain('CoT 更新失败时的过程文本');
  });

  it('CoT 关闭且工具隐藏时保留交互卡片流程并显示完整统计', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'card',
      showToolCalls: false,
      cotMessages: 'off',
      events: [
        { type: 'text', delta: '交互卡片的过程内容' },
        { type: 'tool_use', id: 'hidden-card-tool', name: 'Bash', input: { command: 'hidden card command' } },
        { type: 'tool_result', id: 'hidden-card-tool', output: 'hidden card output', isError: false },
        { type: 'final_text', content: '交互卡片最终答复' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({ update: async (next) => { progressCards.push(next); } });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_hidden_tools', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(JSON.stringify(progressCards)).toContain('交互卡片的过程内容');
    expect(JSON.stringify(progressCards)).not.toMatch(/Bash|hidden card command|hidden card output/);
    expect(h.channel.sent).toHaveLength(1);
    const resultJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(resultJson).toContain('交互卡片最终答复');
    expect(resultJson).toContain('工具调用：1 次 · 成功 1 · 错误 0');
    expect(resultJson).not.toMatch(/Bash|hidden card command|hidden card output/);
  });

  it('Claude card 回退在正文为空时仍发送终态与工具错误统计', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      showToolCalls: false,
      cotMessages: 'off',
      events: [
        { type: 'tool_use', id: 'hidden-failed-tool', name: 'Bash', input: { command: 'hidden command' } },
        { type: 'tool_result', id: 'hidden-failed-tool', output: 'hidden output', isError: true },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_empty_card', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_claude_empty_card' });
    const resultJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(resultJson).toContain('已完成 · 1 次工具错误');
    expect(resultJson).toContain('工具调用：1 次 · 成功 0 · 错误 1');
    expect(resultJson).not.toMatch(/Bash|hidden command|hidden output/);
  });

  it('Claude card 回退缺少消息回执时不记录已送达', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      showToolCalls: false,
      cotMessages: 'off',
      events: [
        { type: 'tool_use', id: 'hidden-failed-tool', name: 'Bash', input: { command: 'hidden command' } },
        { type: 'tool_result', id: 'hidden-failed-tool', output: 'hidden output', isError: true },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_card_no_receipt', 'run'));
    await waitFor(() => fail.mock.calls.some(
      (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
    ));

    expect(info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent')).toBe(false);
  });

  it('纯文本模式下隐藏工具细节并保留文字最终答复', async () => {
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'text',
      showToolCalls: false,
      cotMessages: 'off',
      events: [
        { type: 'tool_use', id: 'hidden-text-tool', name: 'Bash', input: { command: 'hidden text command' } },
        { type: 'tool_result', id: 'hidden-text-tool', output: 'hidden text output', isError: false },
        { type: 'final_text', content: '纯文本最终答复' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    h.controls.cfg.preferences.messageReplyMigrated = true;
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_text_hidden_tools', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    const content = h.channel.sent[0]?.content as { markdown?: string; card?: unknown };
    expect(content.markdown).toBe('纯文本最终答复');
    expect(content.card).toBeUndefined();
    expect(JSON.stringify(content)).not.toMatch(/Bash|hidden text command|hidden text output/);
  });

  it.each([
    {
      name: 'agent error',
      finalText: 'agent error final answer',
      terminalEvent: { type: 'error', message: 'agent failed', terminationReason: 'failed' } as AgentEvent,
      label: '运行失败',
      template: 'red',
      color: 'red',
    },
    {
      name: 'interrupt',
      finalText: 'interrupted final answer',
      terminalEvent: { type: 'done', terminationReason: 'interrupted' } as AgentEvent,
      label: '已中断',
      template: 'grey',
      color: 'neutral',
    },
    {
      name: 'timeout',
      finalText: 'timeout final answer',
      terminalEvent: {
        type: 'error', message: 'agent timed out', terminationReason: 'timeout', timeoutMinutes: 15,
      } as AgentEvent,
      label: '已超时',
      template: 'orange',
      color: 'orange',
    },
    {
      name: 'clean finish without answer',
      finalText: undefined,
      terminalEvent: { type: 'done', terminationReason: 'normal' } as AgentEvent,
      label: '已完成',
      template: 'green',
      color: 'green',
    },
  ])('CoT 关闭的 Codex/card 终态保留真实状态：$name', async ({
    finalText,
    terminalEvent,
    label,
    template,
    color,
  }) => {
    const progressCards: unknown[] = [];
    const events: AgentEvent[] = [
      { type: 'text', delta: '只在进展卡展示的过程' },
      { type: 'tool_use', id: 'tool-unfinished', name: 'Bash', input: { command: 'hidden command' } },
      ...(finalText ? [{ type: 'final_text' as const, content: finalText }] : []),
      terminalEvent,
    ];
    const h = await createHarness({
      agentKind: 'codex',
      messageReply: 'card',
      showToolCalls: false,
      cotMessages: 'off',
      events,
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({ update: async (next) => { progressCards.push(next); } });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message(`om_card_terminal_${label}`, 'run'));
    await waitFor(() => JSON.stringify(progressCards).includes(label));
    if (finalText) await waitFor(() => h.channel.sent.length === 1);
    else expect(h.channel.sent).toHaveLength(0);

    const result = JSON.parse(finalText
      ? JSON.stringify(h.channel.sent[0]?.content)
      : JSON.stringify(progressCards.at(-1))) as {
        card?: { header?: unknown };
        header?: {
          template?: string;
          text_tag_list?: Array<{ color?: string; text?: { content?: string } }>;
        };
        body?: { elements?: unknown[] };
    };
    const resultJson = JSON.stringify(result.card ?? result);
    const header = ((result.card as { header?: typeof result.header } | undefined)?.header ?? result.header);
    expect(header?.template).toBe(template);
    expect(header?.text_tag_list?.[0]).toMatchObject({
      text: { content: label },
      color,
    });
    expect(resultJson).toContain(finalText
      ? '工具调用：1 次 · 成功 0 · 错误 0 · 未完成 1'
      : '工具调用：1 次 · 成功 0 · 错误 0');
    expect(resultJson).not.toMatch(/Bash|hidden command/);
    if (finalText) {
      expect(resultJson).toContain(finalText);
      expect(resultJson).not.toContain('只在进展卡展示的过程');
    } else {
      expect(resultJson).toContain('只在进展卡展示的过程');
    }
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  /** One run's events, or one array per run. */
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  cotMessages?: 'off' | 'brief' | 'detailed';
  showToolCalls?: boolean;
  /** Codex holds its answer back for a dedicated final reply; Claude streams it. */
  agentKind?: 'claude' | 'codex';
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
    preferences: {
      ...(options.messageReply ? { messageReply: options.messageReply } : {}),
      showToolCalls: options.showToolCalls ?? true,
      cotMessages: options.cotMessages ?? 'off',
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
    id: 'codex',
    displayName: 'Codex',
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
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

async function startTestBridge(
  h: {
    profileConfig: ReturnType<typeof createDefaultProfileConfig>;
    agent: FakeAgentAdapter;
    sessions: SessionStore;
    workspaces: WorkspaceStore;
    controls: ReturnType<typeof createControls>;
    tmp?: TmpProfile;
  },
  agent: AgentAdapter = h.agent,
  callbacks = false,
): Promise<void> {
  const sessionCatalog = callbacks && h.tmp ? new SessionCatalog(join(h.tmp.profile, 'session-catalog.json')) : undefined;
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    sessionCatalog,
    ...(callbacks && h.tmp ? { appPaths: {
      mediaDir: join(h.tmp.profile, 'media'),
      secretsFile: join(h.tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(h.tmp.profile, '.keystore.salt'),
    } } : {}),
  });
  cleanups.push(() => bridge.disconnect());
}

async function createFakeBinary(lines: string[]): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-channel-result-test-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(lines)};`,
      'for (const line of lines) console.log(line);',
      'process.exit(0);',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function mockCotApi(createFails: boolean, updateFails = false, updateBodies?: string[]): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    urls.push(url);
    const method = String(init?.method ?? 'GET');
    if (url.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }));
    }
    if (url.includes('/complete/')) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    if (method === 'POST' && url.includes('receive_id_type=chat_id')) {
      return createFails
        ? new Response(JSON.stringify({ code: 10002, msg: 'COT creation rejected' }))
        : new Response(JSON.stringify({ code: 0, data: { cot_id: 'cot_test', message_id: 'om_cot_test' } }));
    }
    if (method === 'PUT' && url.includes('/open-apis/im/v1/message_cot')) {
      updateBodies?.push(String(init?.body ?? ''));
      return updateFails
        ? new Response(JSON.stringify({ code: 10002, msg: 'COT update rejected' }))
        : new Response(JSON.stringify({ code: 0 }));
    }
    throw new Error(`unexpected COT request: ${method} ${url}`);
  });
  return urls;
}

function createFakeLarkChannel(harnessOptions: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const recalled: FakeLarkChannel['recalled'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    recalled,
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
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(harnessOptions.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
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
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      if (harnessOptions.send) return harnessOptions.send(chatId, content, options);
      return { messageId: `sent_${sent.length}` };
    },
    stream: harnessOptions.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async recallMessage(messageId) {
      recalled.push(messageId);
    },
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
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

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastCard(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { card?: unknown } | undefined;
  expect(content?.card).toBeDefined();
  return JSON.stringify(content?.card);
}

function terminalActionButtonValues(card: unknown): Array<Record<string, unknown>> {
  type Button = { behaviors?: Array<{ value?: Record<string, unknown> }> };
  type Column = { elements?: Button[] };
  type Element = { tag?: string; columns?: Column[] };
  const elements = (card as { body?: { elements?: Element[] } } | undefined)?.body?.elements ?? [];
  return elements.flatMap((element) => element.tag === 'column_set'
    ? (element.columns ?? []).flatMap((column) => (column.elements ?? [])
      .flatMap((button) => button.behaviors?.flatMap((behavior) => behavior.value ? [behavior.value] : []) ?? []))
    : []);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
