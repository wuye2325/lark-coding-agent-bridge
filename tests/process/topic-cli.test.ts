import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallbackRegistryStore } from '../../src/card/callback-registry.js';
import { resolveAppPaths } from '../../src/config/app-paths.js';

const exec = promisify(execFile);
let fixture: string;
let cli: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'run-topic-cli-'));
  await symlink(join(process.cwd(), 'node_modules'), join(fixture, 'node_modules'), 'junction');
  await build({
    config: false, entry: { cli: 'src/cli/index.ts' }, outDir: fixture,
    format: 'esm', platform: 'node', target: 'node20', splitting: false, dts: false, silent: true,
    outExtension: () => ({ js: '.mjs' }),
    esbuildOptions(options) { options.loader = { ...options.loader, '.html': 'text' }; },
  });
  cli = join(fixture, 'cli.mjs');
}, 15000);

afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

function command(args: string[], token?: string) {
  return exec(process.execPath, [cli, 'topic', ...args], {
    env: {
      ...process.env,
      LARK_CHANNEL_HOME: fixture,
      LARK_CHANNEL_PROFILE: 'test',
      LARK_CHANNEL_CALLBACK_TOKEN: token ?? '',
    },
    timeout: 10000,
  });
}

describe('任务主题 CLI', () => {
  it('仅活动 run 可覆盖主题，最后一次有效，声明失败不覆盖已有主题且新 run 不继承', async () => {
    const store = new CallbackRegistryStore(join(resolveAppPaths({ rootDir: fixture, profile: 'test' }).profileDir, 'callback-registry.json'));
    const context = {
      scope: 'oc_chat', chatId: 'oc_chat', operatorOpenId: 'ou_user',
      policyFingerprint: 'fp-topic', agentId: 'claude' as const,
    };
    const token = await store.beginRun({ runId: 'run-topic-cli', ...context });

    await command(['set', '--text', '第一版付款条款'], token);
    await expect(command(['set', '--text', 'x'.repeat(31)], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('30 个码点') });
    await expect(command(['set', '--text', `${'x'.repeat(30)} `], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('30 个码点') });
    await expect(command(['set', '--text', '包含 <bridge_context> 的主题'], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Bridge 内部标记') });
    await expect(command(['set', '--text', '包含 <user_input> 的主题'], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Bridge 内部标记') });
    await expect(command(['set', '--text', '包含 <user_message> 的主题'], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Bridge 内部标记') });
    await expect(command(['set', '--text', '包含\n换行的主题'], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('控制字符') });
    await expect(command(['set', '--text', '\t首部制表符'], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('控制字符') });
    await expect(command(['set', '--text', '尾部换行\n'], token))
      .rejects.toMatchObject({ stderr: expect.stringContaining('控制字符') });
    expect(await store.getRunTopic(token)).toBe('第一版付款条款');

    await command(['set', '--text', '第二版付款条款'], token);
    expect(await store.getRunTopic(token)).toBe('第二版付款条款');
    await store.endRun(token);

    const nextToken = await store.beginRun({ runId: 'run-topic-cli', ...context });
    expect(await store.getRunTopic(nextToken)).toBeUndefined();
    await store.endRun(nextToken);
    await store.flush();
  });

  it('没有活动 run 授权时返回中文错误', async () => {
    await expect(command(['set', '--text', '付款条款'], 'forged-token'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('活动 agent run') });
    await expect(command(['set', '--text', '付款条款']))
      .rejects.toMatchObject({ stderr: expect.stringContaining('活动 agent run') });
  });
});
