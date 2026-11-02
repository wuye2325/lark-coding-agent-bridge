import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { buildPrompt } from '../../../src/bot/channel';
import type { QuotedContext } from '../../../src/bot/quote';
import type { LocalAttachment } from '../../../src/media/cache';

const BOT = { openId: 'ou_bot' };

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_user',
    content: '/implement 修复登录问题',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
    ...overrides,
  };
}

function quote(): QuotedContext {
  return {
    messageId: 'om_quote',
    senderId: 'ou_quoted',
    createdAt: '2026-01-01T00:00:00.000Z',
    content: '被引用的内容',
    rawContentType: 'text',
  };
}

const attachment = {
  path: '/tmp/file.txt',
  requiredness: 'optional',
  decision: 'accepted',
} as LocalAttachment;

describe('buildPrompt slash command passthrough', () => {
  it('keeps a single slash command verbatim and moves context to the system prompt', () => {
    const bundle = buildPrompt([message()], [], [], [], BOT, undefined, 'claude');

    expect(bundle.prompt).toBe('/implement 修复登录问题');
    expect(bundle.appendSystemPrompt).toContain('bridge_context');
    expect(bundle.appendSystemPrompt).toContain('oc_chat');
    expect(bundle.prompt).not.toContain('bridge_context');
  });

  it('keeps ordinary messages on the structured prompt path', () => {
    const bundle = buildPrompt(
      [message({ content: '看看这个合同' })],
      [],
      [],
      [],
      BOT,
      undefined,
      'claude',
    );

    expect(bundle.appendSystemPrompt).toBeUndefined();
    expect(bundle.prompt).toContain('<bridge_context>');
    expect(bundle.prompt).toContain('<user_input>');
  });

  it.each([
    ['merged batch', () => buildPrompt([message(), message()], [], [], [], BOT, undefined, 'claude')],
    ['quote', () => buildPrompt([message()], [], [quote()], [], BOT, undefined, 'claude')],
    ['attachment', () => buildPrompt([message()], [attachment], [], [], BOT, undefined, 'claude')],
    ['topic context', () => buildPrompt([message()], [], [], [quote()], BOT, undefined, 'claude')],
    [
      'active interactive card',
      () => buildPrompt([message({ rawContentType: 'interactive' })], [], [], [], BOT, undefined, 'claude'),
    ],
    [
      'bot sender',
      () =>
        buildPrompt(
          [message({ raw: { sender: { sender_type: 'app' } } })],
          [],
          [],
          [],
          BOT,
          undefined,
          'claude',
        ),
    ],
    ['codex profile', () => buildPrompt([message()], [], [], [], BOT, undefined, 'codex')],
  ])('does not pass through for %s', (_label, build) => {
    const bundle = build();

    expect(bundle.appendSystemPrompt).toBeUndefined();
    expect(bundle.prompt).toContain('<bridge_context>');
  });

  it('passes commands through for human senders', () => {
    const bundle = buildPrompt(
      [message({ raw: { sender: { sender_type: 'user' } } })],
      [],
      [],
      [],
      BOT,
      undefined,
      'claude',
    );

    expect(bundle.prompt).toBe('/implement 修复登录问题');
  });

  it('does not treat a non-command leading slash as a slash command', () => {
    const bundle = buildPrompt(
      [message({ content: '/ usr/local 是路径' })],
      [],
      [],
      [],
      BOT,
      undefined,
      'claude',
    );

    expect(bundle.appendSystemPrompt).toBeUndefined();
    expect(bundle.prompt).toContain('<user_input>');
  });
});
