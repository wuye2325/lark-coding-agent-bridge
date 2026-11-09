import { describe, expect, it, vi } from 'vitest';
import {
  tryHandleCommand,
  tryHandleUnsupportedCodexSlashCommand,
  type CommandContext,
} from '../../../src/commands';

function commandContext(
  content: string,
  agentKind: 'claude' | 'codex',
  rawSenderType?: string,
) {
  const send = vi.fn().mockResolvedValue({ messageId: 'om_reply' });
  const ctx = {
    channel: { send },
    msg: {
      content,
      chatId: 'oc_chat',
      messageId: 'om_command',
      senderId: 'ou_user',
      rawContentType: 'text',
      ...(rawSenderType ? { raw: { sender: { sender_type: rawSenderType } } } : {}),
    },
    chatMode: 'p2p',
    agent: { displayName: agentKind === 'codex' ? 'Codex CLI' : 'Claude Code' },
    controls: { profileConfig: { agentKind } },
  } as unknown as CommandContext;
  return { ctx, send };
}

describe('tryHandleCommand unknown slash commands', () => {
  it('gives Codex users an explicit skill invocation path without treating the hint as a control command', async () => {
    const { ctx, send } = commandContext('/retro', 'codex');

    expect(await tryHandleCommand(ctx)).toBe(false);
    expect(await tryHandleUnsupportedCodexSlashCommand(ctx)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toEqual({
      markdown: expect.stringContaining('把前缀改成 `$` 后重发（如 `$retro`）'),
    });
    expect(send.mock.calls[0]?.[2]).toEqual({ replyTo: 'om_command' });
  });

  it('leaves unknown slash commands available to Claude CLI', async () => {
    const { ctx, send } = commandContext('/implement 修复登录问题', 'claude');

    expect(await tryHandleCommand(ctx)).toBe(false);
    expect(await tryHandleUnsupportedCodexSlashCommand(ctx)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves slash-prefixed paths alone in a Codex profile', async () => {
    const { ctx, send } = commandContext('/Users/wuye/project', 'codex');

    expect(await tryHandleUnsupportedCodexSlashCommand(ctx)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not interpret a bot-authored slash message as a Codex command', async () => {
    const { ctx, send } = commandContext('/retro', 'codex', 'app');

    expect(await tryHandleUnsupportedCodexSlashCommand(ctx)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows Codex skill syntax in the help card', async () => {
    const { ctx, send } = commandContext('/help', 'codex');

    expect(await tryHandleCommand(ctx)).toBe(true);
    expect(JSON.stringify(send.mock.calls[0]?.[1])).toContain('$skill-name');
    expect(JSON.stringify(send.mock.calls[0]?.[1])).toContain('/skills');
  });
});
