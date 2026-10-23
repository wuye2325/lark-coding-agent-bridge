import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCapability, codexCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import {
  recordRunSessionEvent,
  startRunFlow,
  type StartRunFlowInput,
} from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SpawnFailed } from '../../../src/runtime/errors.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { claudeSessionExists } from '../../../src/session/history.js';
import { getRunNoProgressTimeoutMs } from '../../../src/config/schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware run-flow resume', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('预检遵循 Claude 配置目录，仅缺失 transcript 才判失效', async () => {
    const h = await createHarness('claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(h.tmp.profile, 'claude-config'));
    const project = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', h.tmp.workspace.replace(/[^A-Za-z0-9]/g, '-'));
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'existing-session.jsonl'), '{}\n');
    expect(await claudeSessionExists(h.tmp.workspace, 'existing-session')).toBe(true);
    expect(await claudeSessionExists(h.tmp.workspace, 'missing-session')).toBe(false);
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'relative-path');
    expect(await claudeSessionExists(h.tmp.workspace, 'existing-session')).toBe(true);
  });

  it('默认一小时无进展，配置独立于旧 idle timeout 并可持久化', () => {
    expect(getRunNoProgressTimeoutMs({ preferences: {} })).toBe(3600_000);
    const cfg = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } }, preferences: { runNoProgressTimeoutMinutes: 90, runIdleTimeoutMinutes: 120 } });
    expect(getRunNoProgressTimeoutMs({ preferences: cfg.preferences })).toBe(90 * 60_000);
    expect(cfg.preferences.runIdleTimeoutMinutes).toBe(120);
    expect(getRunNoProgressTimeoutMs({ preferences: { runNoProgressTimeoutMinutes: 0 } })).toBe(3600_000);
  });

  it('resumes Claude only when scope, agent, cwd, and policy fingerprint match', async () => {
    const h = await createHarness('claude');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());

    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
      sessionId: 'sess-catalog',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected resumed run');
    expect(second.resumeFrom).toBe('sess-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: 'sess-catalog',
      threadId: undefined,
    });
  });

  it('falls back to legacy Claude sessions when the agent-aware catalog has no match', async () => {
    const h = await createHarness('claude');
    const cwdRealpath = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'legacy-session', cwdRealpath);

    const run = await start(h);

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected resumed legacy run');
    expect(run.resumeFrom).toBe('legacy-session');
    expect(h.agent.runOptions[0]).toMatchObject({
      sessionId: 'legacy-session',
      threadId: undefined,
    });
  });

  it('resumes Codex thread from catalog and ignores legacy Claude SessionStore entries', async () => {
    const h = await createHarness('codex');
    const cwdRealpath = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'legacy-claude-session', cwdRealpath);
    const probe = await start(h);
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error('expected probe run');
    await collect(probe.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: probe.cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint,
      threadId: 'thread-catalog',
      now: 1000,
    });

    const resumed = await start(h);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.resumeFrom).toBe('thread-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: 'thread-catalog',
    });
  });

  it('does not resume when the policy fingerprint changes', async () => {
    const h = await createHarness('claude');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: 'stale-fingerprint',
      sessionId: 'sess-stale',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected fresh run');
    expect(second.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
    });
  });

  it('同步启动失败可见且不会占住后续消息', async () => {
    const h = await createHarness('claude');
    const spawn = vi.spyOn(h.agent, 'run').mockImplementationOnce(() => { throw new Error('启动失败'); });
    const first = await start(h);
    expect(first).toMatchObject({ ok: false, rejectReason: { code: 'agent-spawn-failed', userVisible: expect.stringContaining('代理启动失败') } });
    spawn.mockRestore();
    const next = await start(h);
    if (!next.ok) throw new Error('expected next run');
    await collect(next.execution.subscribe());
  });

  it('磁盘已满时提示具体原因和清理建议，且不泄露底层错误内容', async () => {
    const h = await createHarness('claude');
    const cause = Object.assign(new Error('ENOSPC: private/path secret=unit-test-value'), { code: 'ENOSPC' });
    const spawn = vi.spyOn(h.agent, 'run').mockImplementationOnce(() => { throw cause; });
    const result = await start(h);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected startup failure');
    expect(result.rejectReason.userVisible).toContain('磁盘空间不足');
    expect(result.rejectReason.userVisible).toContain('清理磁盘空间');
    expect(result.rejectReason.userVisible).not.toContain('unit-test-value');
    spawn.mockRestore();
    const next = await start(h);
    if (!next.ok) throw new Error('expected next run');
    await collect(next.execution.subscribe());
  });

  it.each(['EACCES', 'EPERM', 'diagnostic'])('权限错误说明权限不足及修复方向：%s', async (source) => {
    const h = await createHarness('claude');
    const failure = source === 'diagnostic'
      ? new SpawnFailed('prepare failed', undefined, 'agent-prepare-failed', {
          code: 'agent-binary-not-executable', agentId: 'claude', agentName: 'Claude Code',
          command: 'private-command', errno: 'EACCES', stderrExcerpt: 'secret=unit-test-value',
        })
      : Object.assign(new Error('private/path secret=unit-test-value'), { code: source });
    vi.spyOn(h.agent, 'run').mockImplementationOnce(() => { throw failure; });
    const result = await start(h);
    if (result.ok) throw new Error('expected startup failure');
    expect(result.rejectReason.userVisible).toContain('权限不足');
    expect(result.rejectReason.userVisible).toContain('检查文件和目录权限');
    expect(result.rejectReason.userVisible).not.toContain('unit-test-value');
    expect(result.rejectReason.userVisible).not.toContain('private-command');
  });

  it.each(['preflight', 'runtime'])('失效会话同时清理两处记录并通知，保留超时偏好：%s', async (mode) => {
    const h = await createHarness('claude');
    const initial = await start(h);
    if (!initial.ok) throw new Error('expected run');
    await collect(initial.execution.subscribe());
    const identity = { scopeId: 'chat-1', agentId: 'claude' as const, cwdRealpath: initial.cwdRealpath, policyFingerprint: initial.policy.policyFingerprint };
    h.catalog.upsertActive({ ...identity, sessionId: 'expired' });
    h.sessions.set('chat-1', 'expired', initial.cwdRealpath);
    h.sessions.setIdleTimeoutMinutes('chat-1', 120);
    Object.assign(h.agent, { hasSession: async () => mode !== 'preflight' });
    h.agent.setEvents(mode === 'preflight'
      ? [[{ type: 'system', sessionId: 'fresh' }, { type: 'done', terminationReason: 'normal' }]]
      : [[{ type: 'error', message: 'No conversation found with session ID: expired', terminationReason: 'failed' }], [{ type: 'system', sessionId: 'fresh' }, { type: 'done', terminationReason: 'normal' }]]);
    const notice = vi.fn(async () => {});
    const result = await start(h, { onSessionReset: notice });
    if (!result.ok) throw new Error('expected recovery');
    for await (const event of result.execution.subscribe()) {
      if (event.type === 'system') {
        expect(h.catalog.activeFor(identity)).toBeUndefined();
        expect(h.sessions.resumeFor('chat-1', initial.cwdRealpath)).toBeUndefined();
      }
      recordRunSessionEvent({ scopeId: 'chat-1', sessions: h.sessions, sessionCatalog: h.catalog, capability: claudeCapability(h.profileConfig), policy: result.policy, event });
    }
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('关键背景可能需要补充'));
    expect(h.catalog.activeFor(identity)?.sessionId).toBe('fresh');
    expect(h.sessions.resumeFor('chat-1', initial.cwdRealpath)).toBe('fresh');
    expect(h.sessions.getIdleTimeoutMinutes('chat-1')).toBe(120);
  });

  it('records system session identifiers into the agent-aware catalog', async () => {
    const claude = await createHarness('claude');
    const claudeRun = await start(claude);
    expect(claudeRun.ok).toBe(true);
    if (!claudeRun.ok) throw new Error('expected claude run');
    await collect(claudeRun.execution.subscribe());

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: claude.sessions,
      sessionCatalog: claude.catalog,
      capability: claudeCapability(claude.profileConfig),
      policy: claudeRun.policy,
      event: { type: 'system', sessionId: 'sess-recorded', cwd: claudeRun.cwdRealpath },
    });

    expect(
      claude.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: claudeRun.cwdRealpath,
        policyFingerprint: claudeRun.policy.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'sess-recorded' });
    expect(claude.sessions.resumeFor('chat-1', claudeRun.cwdRealpath)).toBe('sess-recorded');

    const codex = await createHarness('codex');
    const codexRun = await start(codex);
    expect(codexRun.ok).toBe(true);
    if (!codexRun.ok) throw new Error('expected codex run');
    await collect(codexRun.execution.subscribe());

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: codex.sessions,
      sessionCatalog: codex.catalog,
      capability: codexCapability(codex.profileConfig),
      policy: codexRun.policy,
      event: { type: 'system', threadId: 'thread-recorded' },
    });

    expect(
      codex.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: codexRun.cwdRealpath,
        policyFingerprint: codexRun.policy.policyFingerprint,
      }),
    ).toMatchObject({ threadId: 'thread-recorded' });
    expect(codex.sessions.getRaw('chat-1')).toBeUndefined();
  });
});

async function createHarness(agentKind: 'claude' | 'codex'): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
  const tmp = await createTmpProfile(`resume-${agentKind}-test-`);
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind,
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor: new RunExecutor({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
      now: () => 1000,
    }),
    sessions,
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: tmp.workspace,
      },
    },
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

async function start(h: Awaited<ReturnType<typeof createHarness>>, overrides: Partial<StartRunFlowInput> = {}) {
  const input = {
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability:
      h.profileConfig.agentKind === 'codex'
        ? codexCapability(h.profileConfig)
        : claudeCapability(h.profileConfig),
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
    ...overrides,
  } satisfies StartRunFlowInput & { sessionCatalog: SessionCatalog };
  return startRunFlow(input);
}
