import type { NormalizedMessage } from '@larksuite/channel';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdk = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  sdk.channel = undefined;
});

describe('表情消息 Agent 输入', () => {
  it.each(['claude', 'codex'] as const)('%s 收到表情图片附件，Codex 同时收到图片参数', async (kind) => {
    const h = await createHarness(kind);
    await h.deliver('om_sticker', '<sticker key="sticker_key"/>', [
      { type: 'sticker', fileKey: 'sticker_key' },
    ]);
    await vi.waitFor(() => expect(h.agent.runOptions).toHaveLength(1));

    const input = h.agent.runOptions[0]!;
    const attachmentBlock = JSON.parse(input.prompt.split('<user_input>')[1]!.split('</user_input>')[0]!);
    expect(attachmentBlock.attachments).toEqual([
      expect.objectContaining({ kind: 'image', mime: 'image/webp', decision: 'accepted' }),
    ]);
    const path = attachmentBlock.attachments[0].path as string;
    expect(await readFile(path, 'utf8')).toBe('sticker-image');
    expect(input.images ?? []).toEqual(kind === 'codex' ? [path] : []);
  });

  it.each(['claude', 'codex'] as const)('%s 在表情下载失败时保留原文并继续同批次其他输入与图片', async (kind) => {
    const h = await createHarness(kind, { failSticker: true });
    await h.deliver('om_sticker', '<sticker key="sticker_key"/>', [
      { type: 'sticker', fileKey: 'sticker_key' },
    ]);
    await h.deliver('om_image', '继续看这张图片 <image key="image_key"/>', [
      { type: 'image', fileKey: 'image_key' },
    ]);
    await vi.waitFor(() => expect(h.agent.runOptions).toHaveLength(1));

    const input = h.agent.runOptions[0]!;
    const userInput = JSON.parse(input.prompt.split('<user_input>')[1]!.split('</user_input>')[0]!);
    expect(userInput.text).toContain('<sticker key="sticker_key"/>');
    expect(userInput.text).toContain('继续看这张图片');
    expect(userInput.attachments).toEqual([
      expect.objectContaining({ kind: 'image', decision: 'accepted', sourceMessageId: 'om_image' }),
    ]);
    expect(input.images ?? []).toEqual(kind === 'codex' ? [userInput.attachments[0].path] : []);
  });
});

async function createHarness(kind: 'claude' | 'codex', options: { failSticker?: boolean } = {}) {
  const tmp = await createTmpProfile('sticker-input-');
  const base = createDefaultProfileConfig({
    agentKind: kind,
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], allowedChats: ['oc_chat'] },
    ...(kind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const cfg = { ...base, workspaces: { ...base.workspaces, default: tmp.workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: kind, events: [{ type: 'done', terminationReason: 'normal' }] });
  const handlers: { message?: (message: NormalizedMessage) => Promise<void> | void } = {};
  sdk.channel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    on(next: typeof handlers) { Object.assign(handlers, next); },
    async connect() {},
    async disconnect() {},
    async getChatMode() { return 'group'; },
    async getAppInfo() { return { ownerId: 'ou_owner' }; },
    async listChats() { return []; },
    async send() { return { messageId: 'om_sent' }; },
    async addReaction() { return 'reaction_1'; },
    async removeReaction() {},
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: { v1: { messageReaction: {
        create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
        delete: vi.fn(async () => ({})),
      } } },
    },
    async downloadResourceToFile(_messageId: string, key: string, _type: string, dest: string) {
      if (options.failSticker && key === 'sticker_key') throw new Error('下载失败');
      await writeFile(dest, key === 'sticker_key' ? 'sticker-image' : 'ordinary-image');
      return { contentType: 'image/webp' };
    },
  };
  const bridge = await startChannel({
    cfg, agent, sessions, workspaces,
    appPaths: {
      mediaDir: join(tmp.profile, 'media'),
      secretsFile: join(tmp.profile, 'secrets.json'),
      keystoreSaltFile: join(tmp.profile, 'keystore-salt'),
    },
    controls: {
      profile: 'test', profileConfig: cfg, cfg, ownerRefreshState: 'unknown',
      async refreshOwner() {}, async restart() {}, async exit() {},
      configPath: join(tmp.profile, 'config.json'), processId: 'test',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    agent,
    async deliver(messageId: string, content: string, resources: Array<{ type: string; fileKey: string }>) {
      await handlers.message?.({
        messageId, content, resources, chatId: 'oc_chat', chatType: 'p2p',
        senderId: 'ou_user', senderName: 'User', rawContentType: 'sticker',
        mentions: [], mentionedBot: false, mentionAll: false, createTime: Date.now(),
      } as unknown as NormalizedMessage);
    },
  };
}
