import type { CardActionEvent, CardActionResponse, NormalizedMessage } from '@larksuite/channel';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { commandSessionCatalogIdentity } from '../../../src/bot/session-catalog-identity.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { CallbackRegistryStore } from '../../../src/card/callback-registry.js';
import { TerminalActionAuth } from '../../../src/card/terminal-action-auth.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { canUseGroup } from '../../../src/policy/access.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { createSdkCardIngress } from '../../helpers/sdk-card-ingress.js';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(['group', 'p2p'] as const)('chatMode=%s 时原 run 已结束仍将已绑定卡片的选择送回会话，且不泄漏 callback id', async (chatMode) => {
    const h = await createHarness({ chatMode });
    if (chatMode === 'p2p') h.controls.profileConfig.access.allowedUsers.push('ou_operator');
    const token = await h.registry.beginRun({
      runId: 'run-finished', scope: 'oc_group', chatId: 'oc_group',
      operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session',
    });
    const registration = await h.registry.register(token, {
      schema: { type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'] },
    });
    await h.registry.bind(token, registration.id, 'om_card');
    await h.registry.endRun(token);

    await h.dispatch({ __bridge_cb: true, callback_id: registration.id, choice: 'a' });

    const queued = h.pending.cancel('oc_group');
    expect(queued.map((msg) => msg.content)).toEqual([
      '[card-click] {"choice":"a"}',
    ]);
    expect(queued[0]?.chatType).toBe(chatMode);
    expect(queued[0]?.threadId).toBeUndefined();
  });

  it('校验并转发 SDK 规范化的数值、布尔值和多选表单', async () => {
    const h = await createHarness();
    const id = await registerCallback(h, {
      type: 'object', properties: {
        form_value: { type: 'object', properties: {
          amount: { type: 'number' }, approved: { type: 'boolean' },
          choices: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 2 },
        }, required: ['amount', 'approved', 'choices'] },
      }, required: ['form_value'],
    });
    await h.dispatch({ __bridge_cb: true, callback_id: id }, undefined, {
      action: { tag: 'button', value: { __bridge_cb: true, callback_id: id }, formValue: { amount: 12, approved: true, choices: ['a'] } },
    });
    expect(h.pending.cancel('oc_group')[0]?.content).toBe(
      '[card-click] {"form_value":{"amount":12,"approved":true,"choices":["a"]}}',
    );
  });

  it('多个实例同时收到同一 callback 时，只入队一次，重放仍被拒绝', async () => {
    const h = await createHarness();
    const other = await createHarness({ registryPath: `${h.tmp.profile}/callback-registry.json` });
    const id = await registerCallback(h);
    const payload = { __bridge_cb: true, callback_id: id, choice: 'a' };
    await Promise.all([h.dispatch(payload), other.dispatch(payload)]);
    const queued = [...h.pending.cancel('oc_group'), ...other.pending.cancel('oc_group')];
    expect(queued).toHaveLength(1);
    await h.dispatch(payload);
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('不同 callback 携带重复的平台 event_id 时不会重复入队', async () => {
    const h = await createHarness();
    const first = await registerCallback(h);
    const second = await registerCallback(h);
    const raw = { header: { event_id: 'event-shared' } };
    await h.dispatch({ __bridge_cb: true, callback_id: first, choice: 'a' }, undefined, { raw });
    await h.dispatch({ __bridge_cb: true, callback_id: second, choice: 'b' }, undefined, { raw });
    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual(['[card-click] {"choice":"a"}']);
  });

  it.each([
    { messageId: 'om_copied_card' },
    { chatId: 'oc_other' },
    { operator: { openId: 'ou_other' } },
  ])('拒绝来源消息、chat 或操作者不符的点击：%j', async (evt) => {
    const h = await createHarness();
    const id = await registerCallback(h);
    expect(await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' }, undefined, evt)).toEqual({
      toast: { type: 'warning', content: evt.chatId ? '无权操作此卡片' : '卡片与当前会话或权限不符，请重新发起' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('策略指纹更新后拒绝旧登记', async () => {
    const h = await createHarness({ fingerprint: 'fp-changed' });
    const id = await registerCallback(h);
    expect(await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' })).toEqual({
      toast: { type: 'warning', content: '卡片与当前会话或权限不符，请重新发起' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it.each([{ choice: 'unknown' }, { choice: 1 }, { choice: 'a', extra: true }, { choice: 'a', cmd: 'stop' }])(
    '拒绝不符合 schema 的数据且不消耗合法登记：%j', async (data) => {
      const h = await createHarness();
      const id = await registerCallback(h);
      expect(await h.dispatch({ __bridge_cb: true, callback_id: id, ...data })).toEqual({
        toast: { type: 'warning', content: '提交内容不符合卡片要求，请检查后重试' },
      });
      expect(h.pending.cancel('oc_group')).toEqual([]);
      await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' });
      expect(h.pending.cancel('oc_group')).toHaveLength(1);
    },
  );

  it('未绑定消息和过期的登记都不入队', async () => {
    let now = 1000;
    const h = await createHarness({ now: () => now });
    const token = await h.registry.beginRun({ runId: 'source', scope: 'oc_group', chatId: 'oc_group', operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session' });
    const registration = await h.registry.register(token, { schema: { type: 'object', properties: {} }, ttlSeconds: 1 });
    expect(await h.dispatch({ __bridge_cb: true, callback_id: registration.id })).toEqual({
      toast: { type: 'info', content: '卡片正在准备，请稍后再点' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    await h.registry.bind(token, registration.id, 'om_card');
    now = 2000;
    expect(await h.dispatch({ __bridge_cb: true, callback_id: registration.id })).toEqual({
      toast: { type: 'warning', content: '卡片已过期，请重新发起' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('未绑定时提示等待，绑定后原卡可重试，消费后提示已处理', async () => {
    const h = await createHarness();
    const token = await h.registry.beginRun({ runId: 'source', scope: 'oc_group', chatId: 'oc_group', operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session' });
    const registration = await h.registry.register(token, { schema: { type: 'object', properties: {} } });
    const payload = { __bridge_cb: true, callback_id: registration.id };
    expect(await h.dispatch(payload)).toEqual({ toast: { type: 'info', content: '卡片正在准备，请稍后再点' } });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    await h.registry.bind(token, registration.id, 'om_card');
    await h.dispatch(payload);
    expect(h.pending.cancel('oc_group')).toHaveLength(1);
    expect(await h.dispatch(payload)).toEqual({ toast: { type: 'info', content: '该选择已处理，请勿重复提交' } });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it.each(['esm', 'cjs'] as const)('真实 SDK %s 允许未绑定点击后的新投递重试，并过滤同一投递重放', async (mode) => {
    const h = await createHarness();
    const token = await h.registry.beginRun({ runId: 'source', scope: 'oc_group', chatId: 'oc_group', operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session' });
    const registration = await h.registry.register(token, { schema: { type: 'object', properties: {} } });
    const ingress = await createSdkCardIngress((evt) => h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt), mode);
    cleanups.push(() => ingress.channel.disconnect());
    const click = (eventId: string) => ingress.click({ token: eventId, action: { tag: 'button', value: { __bridge_cb: true, callback_id: registration.id } } });
    expect(await click('first')).toEqual({ toast: { type: 'info', content: '卡片正在准备，请稍后再点' } });
    await h.registry.bind(token, registration.id, 'om_card');
    await click('first');
    expect(h.pending.cancel('oc_group')).toEqual([]);
    await click('second');
    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual(['[card-click] {}']);
    expect(await click('third')).toEqual({ toast: { type: 'info', content: '该选择已处理，请勿重复提交' } });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it.each([
    { chatMode: 'group' as const, scope: 'oc_group', chatType: 'group' as const },
    { chatMode: 'p2p' as const, scope: 'oc_group', chatType: 'p2p' as const },
    { chatMode: 'topic' as const, scope: 'oc_group:th_topic', chatType: 'group' as const },
  ])('真实 SDK 终态提示词动作在 $chatMode scope 入队固定内容并返回 Toast', async ({ chatMode, scope, chatType }) => {
    const h = await createHarness({ chatMode });
    if (chatMode === 'p2p') h.controls.profileConfig.access.allowedUsers.push('ou_operator');
    if (chatMode === 'topic') h.channel.rawThreadIds.set('om_card', 'th_topic');
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    const testAction = {
      action: { tag: 'button', value: { cmd: 'prompt.test', prompt: '执行客户端自由提示词' } },
    };
    expect(await ingress.click({ token: 'same-platform-event', ...testAction })).toEqual({
      toast: { type: 'info', content: '已加入待执行队列' },
    });
    await ingress.click({ token: 'same-platform-event', ...testAction });
    expect(await ingress.click({
      token: 'second-user-click',
      action: { tag: 'button', value: { cmd: 'prompt.diff', prompt: '另一个客户端自由提示词' } },
    })).toEqual({ toast: { type: 'info', content: '已加入待执行队列' } });

    const wrongScope = h.pending.cancel(chatMode === 'topic' ? 'oc_group' : 'oc_group:th_topic');
    expect(wrongScope).toEqual([]);
    const queued = h.pending.cancel(scope);
    expect(queued.map((msg) => msg.content)).toEqual([
      '运行当前项目的单元测试并报告结果',
      '查看 git diff 变更并总结改动要点',
    ]);
    expect(queued.map((msg) => msg.chatType)).toEqual([chatType, chatType]);
    expect(queued.map((msg) => msg.threadId)).toEqual(
      chatMode === 'topic' ? ['th_topic', 'th_topic'] : [undefined, undefined],
    );
  });

  it.each(['group', 'p2p'] as const)('真实 SDK 对无权使用的 %s 终态动作返回拒绝 Toast', async (chatMode) => {
    const h = await createHarness({ chatMode });
    if (chatMode === 'group') h.controls.profileConfig.access.allowedChats = [];
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    expect(await ingress.click({
      token: `${chatMode}-denied`,
      action: { tag: 'button', value: { cmd: 'prompt.test' } },
    })).toEqual({ toast: { type: 'warning', content: '无权操作此卡片' } });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    expect(h.sessions.resumeFor('oc_group', await realpath(h.tmp.workspace))).toBe('callback-session');
  });

  it('真实 SDK 在 Bridge 重启后可重复点击签名动作，新投递入队且平台重放只入队一次', async () => {
    const h = await createHarness({ chatMode: 'p2p' });
    h.controls.profileConfig.access.allowedUsers.push('ou_operator');
    const oldBridgeAuth = new TerminalActionAuth({ secret: 'secret' });
    const prompt = '将 /matter/client@example.com/合同.docx 的违约条款提取到 /matter/条款清单.md';
    const token = oldBridgeAuth.sign({ chatId: 'oc_group', scope: 'oc_group', prompt });
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    const click = (eventId: string) => ingress.click({
      token: eventId,
      action: { tag: 'button', value: { cmd: 'prompt.custom', terminal_action_token: token } },
    });
    expect(await click('platform-delivery-1')).toEqual({
      toast: { type: 'info', content: '已加入待执行队列' },
    });
    await click('platform-delivery-1');
    expect(await click('platform-delivery-2')).toEqual({
      toast: { type: 'info', content: '已加入待执行队列' },
    });

    const queued = h.pending.cancel('oc_group');
    expect(queued.map((msg) => msg.content)).toEqual([prompt, prompt]);
    expect(queued.map((msg) => msg.chatType)).toEqual(['p2p', 'p2p']);
  });

  it('签名不绑定生成者，仍按点击者的当前访问策略拒绝无权用户', async () => {
    const h = await createHarness({ chatMode: 'p2p' });
    h.controls.profileConfig.access.allowedUsers = ['ou_allowed'];
    const token = new TerminalActionAuth({ secret: 'secret' }).sign({
      chatId: 'oc_group', scope: 'oc_group', prompt: '执行经过 Bridge 签名的预设 prompt',
    });

    expect(await h.dispatch({ cmd: 'prompt.custom', terminal_action_token: token })).toEqual({
      toast: { type: 'warning', content: '无权操作此卡片' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('真实 SDK 队列拒绝提示词时返回失败 Toast', async () => {
    const h = await createHarness();
    h.pending.push = () => { throw new Error('queue unavailable'); };
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    expect(await ingress.click({
      token: 'queue-failure',
      action: { tag: 'button', value: { cmd: 'prompt.test' } },
    })).toEqual({ toast: { type: 'warning', content: '加入待执行队列失败，请稍后重试' } });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('真实 SDK 拒绝未签名的终态快捷动作', async () => {
    const h = await createHarness();
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    expect(await ingress.click({
      token: 'unknown-action',
      action: { tag: 'button', value: { cmd: 'prompt.custom', prompt: '客户端自由提示词' } },
    })).toEqual({ toast: { type: 'warning', content: '卡片不可用，请重新打开结果卡片' } });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('真实 SDK 新会话先清空当前话题队列，再中断并归档当前会话，Toast 不等待文本回复', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    const scope = 'oc_group:th_topic';
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    const previousCwd = await realpath(h.tmp.workspace);
    const currentWorkspace = join(h.tmp.workspace, 'current-project');
    await mkdir(currentWorkspace, { recursive: true });
    const currentCwd = await realpath(currentWorkspace);
    const identityInput = {
      msg: normalizedMessage({ threadId: 'th_topic' }),
      scope,
      mode: 'topic' as const,
      workspaces: h.workspaces,
      controls: h.controls,
      access: canUseGroup(h.controls.profileConfig, h.controls, 'oc_group', 'ou_operator'),
    };
    const previousIdentity = await commandSessionCatalogIdentity(identityInput);
    if (!previousIdentity) throw new Error('历史工作区没有有效 session identity');
    h.sessionCatalog.upsertActive({ ...previousIdentity, sessionId: 'previous-topic-session' });
    h.workspaces.setCwd(scope, currentCwd);
    const currentIdentity = await commandSessionCatalogIdentity(identityInput);
    if (!currentIdentity) throw new Error('当前工作区没有有效 session identity');
    h.sessionCatalog.upsertActive({ ...currentIdentity, sessionId: 'current-topic-session' });
    h.sessions.set('oc_group', 'group-session', previousCwd);
    h.sessions.set(scope, 'previous-topic-session', previousCwd);
    const run = h.agent.run({ runId: 'topic-run', prompt: '当前话题任务' }) as FakeAgentRun;
    h.activeRuns.register(scope, run);
    h.pending.push(scope, normalizedMessage({ threadId: 'th_topic', content: '旧的排队消息' }));
    h.pending.push('oc_group', normalizedMessage({ content: '群默认 scope 的输入' }));

    let feedbackStarted = false;
    h.channel.send = async () => {
      feedbackStarted = true;
      return await new Promise<{ messageId: string }>(() => {});
    };
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());
    let timeout!: NodeJS.Timeout;
    const response = await Promise.race([
      ingress.click({
        token: 'new-session-click',
        action: { tag: 'button', value: { cmd: 'session.new' } },
      }),
      new Promise<'feedback-timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('feedback-timeout'), 100);
      }),
    ]);
    clearTimeout(timeout);

    expect(response).toEqual({ toast: { type: 'success', content: '已中断当前任务并开始新会话。' } });
    expect(feedbackStarted).toBe(false);
    expect(h.activeRuns.get(scope)).toBeUndefined();
    expect(run.stopped).toBe(true);
    expect(h.sessions.resumeFor(scope, previousCwd)).toBeUndefined();
    expect(h.sessions.resumeFor('oc_group', previousCwd)).toBe('group-session');
    expect(h.sessionCatalog.activeFor(currentIdentity)).toBeUndefined();
    expect(h.sessionCatalog.activeFor(previousIdentity)?.status).toBe('active');
    expect(h.pending.cancel(scope)).toEqual([]);
    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual(['群默认 scope 的输入']);

    h.pending.push(scope, normalizedMessage({ threadId: 'th_topic', content: '新会话的输入' }));
    expect(h.pending.cancel(scope).map((msg) => msg.content)).toEqual(['新会话的输入']);
  });

  it('真实 SDK 无法反查历史话题卡时拒绝重置群默认会话并显示错误 Toast', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    const cwd = await realpath(h.tmp.workspace);
    h.sessions.set('oc_group', 'group-session', cwd);
    h.sessions.set('oc_group:th_topic', 'topic-session', cwd);
    h.channel.fetchRawMessage = async () => {
      throw new Error('thread lookup unavailable');
    };
    const groupRun = h.agent.run({ runId: 'group-run', prompt: '默认群任务' }) as FakeAgentRun;
    const topicRun = h.agent.run({ runId: 'topic-run', prompt: '话题任务' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', groupRun);
    h.activeRuns.register('oc_group:th_topic', topicRun);
    h.pending.push('oc_group', normalizedMessage({ content: '群默认待处理输入' }));
    h.pending.push('oc_group:th_topic', normalizedMessage({ threadId: 'th_topic', content: '话题待处理输入' }));
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    expect(await ingress.click({
      token: 'topic-lookup-failed',
      action: { tag: 'button', value: { cmd: 'session.new' } },
    })).toEqual({ toast: { type: 'warning', content: '无法确认卡片所属话题，请稍后重试' } });
    expect(h.sessions.resumeFor('oc_group', cwd)).toBe('group-session');
    expect(h.sessions.resumeFor('oc_group:th_topic', cwd)).toBe('topic-session');
    expect(h.activeRuns.get('oc_group')?.run).toBe(groupRun);
    expect(h.activeRuns.get('oc_group:th_topic')?.run).toBe(topicRun);
    expect(groupRun.stopped).toBe(false);
    expect(topicRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual(['群默认待处理输入']);
    expect(h.pending.cancel('oc_group:th_topic').map((msg) => msg.content)).toEqual(['话题待处理输入']);
  });

  it('真实 SDK 反查成功但消息没有 thread_id 时允许终态动作使用群默认 scope', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    h.channel.fetchRawMessage = async (messageId) => [{ message_id: messageId }];
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    expect(await ingress.click({
      token: 'valid-no-thread',
      action: { tag: 'button', value: { cmd: 'prompt.test' } },
    })).toEqual({ toast: { type: 'info', content: '已加入待执行队列' } });
    expect(h.pending.cancel('oc_group:th_topic')).toEqual([]);
    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual([
      '运行当前项目的单元测试并报告结果',
    ]);
  });

  it.each([
    { description: '空数组', response: async () => [] },
    { description: 'carrier 缺少消息 ID', response: async () => [{ thread_id: undefined }] },
    { description: 'carrier 消息 ID 不符', response: async () => [{ message_id: 'om_other' }] },
    { description: 'thread_id 类型异常', response: async () => [{ message_id: 'om_card', thread_id: 42 }] },
  ])('真实 SDK 严格反查遇到$description 时拒绝新会话动作', async ({ response }) => {
    const h = await createHarness({ chatMode: 'topic' });
    const cwd = await realpath(h.tmp.workspace);
    h.sessions.set('oc_group', 'group-session', cwd);
    h.sessions.set('oc_group:th_topic', 'topic-session', cwd);
    h.channel.fetchRawMessage = response;
    const groupRun = h.agent.run({ runId: 'group-run', prompt: '默认群任务' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', groupRun);
    h.pending.push('oc_group', normalizedMessage({ content: '群默认待处理输入' }));
    const ingress = await createSdkCardIngress((evt) =>
      h.dispatch(evt.action.value as Record<string, unknown>, undefined, evt),
    );
    cleanups.push(() => ingress.channel.disconnect());

    expect(await ingress.click({
      token: 'invalid-thread-carrier',
      action: { tag: 'button', value: { cmd: 'session.new' } },
    })).toEqual({ toast: { type: 'warning', content: '无法确认卡片所属话题，请稍后重试' } });
    expect(h.sessions.resumeFor('oc_group', cwd)).toBe('group-session');
    expect(h.sessions.resumeFor('oc_group:th_topic', cwd)).toBe('topic-session');
    expect(h.activeRuns.get('oc_group')?.run).toBe(groupRun);
    expect(groupRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group').map((msg) => msg.content)).toEqual(['群默认待处理输入']);
  });

  it.each(['header', 'event_id', 'token', 'missing'] as const)('真实 SDK 的 %s 投递标识区分新点击与重放', async (shape) => {
    let calls = 0;
    const ingress = await createSdkCardIngress(async () => { calls++; });
    cleanups.push(() => ingress.channel.disconnect());
    const event = (id: string) => ({
      action: { tag: 'button', value: { choice: 'a' } },
      ...(shape === 'header' ? { header: { event_id: id } } : shape === 'missing' ? {} : { [shape]: id }),
    });
    await ingress.click(event('first'));
    await ingress.click(event('first'));
    expect(calls).toBe(shape === 'missing' ? 2 : 1);
    await ingress.click(event('second'));
    expect(calls).toBe(shape === 'missing' ? 3 : 2);
  });

  it('真实 SDK 的并发重复投递只执行一次 handler', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const ingress = await createSdkCardIngress(async () => { calls++; await wait; });
    cleanups.push(() => ingress.channel.disconnect());
    const payload = { token: 'concurrent', action: { tag: 'button', value: { choice: 'a' } } };
    const first = ingress.click(payload);
    await ingress.click(payload);
    expect(calls).toBe(1);
    release();
    await first;
  });

  it('无效 token 和伪造 callback_id 不能触发内置命令', async () => {
    const h = await createHarness();
    const run = h.agent.run({ runId: 'run-active', prompt: '' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', run);
    await h.dispatch({ __bridge_cb: true, callback_id: {}, bridge_token: 'invalid-token', cmd: 'stop' });
    expect(run.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('登记文件损坏时拒绝回调而非放行或重新生成授权', async () => {
    const h = await createHarness();
    const id = await registerCallback(h);
    await writeFile(`${h.tmp.profile}/callback-registry.json`, '{"version":1,"runs":[],"registrations":[],"events":{}}');
    expect(await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' })).toEqual({
      toast: { type: 'warning', content: '暂时无法处理此卡片，请稍后重试' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it.each(['topic', 'group'] as const)('chatMode=%s 时话题卡片在原 run 结束后只进入来源话题的会话', async (chatMode) => {
    const h = await createHarness({ chatMode });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    const token = await h.registry.beginRun({ runId: 'source', scope: 'oc_group:th_topic', chatId: 'oc_group', operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session' });
    const registration = await h.registry.register(token, { schema: { type: 'object', properties: {} } });
    await h.registry.bind(token, registration.id, 'om_card');
    await h.registry.endRun(token);
    await h.dispatch({ __bridge_cb: true, callback_id: registration.id });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {}');
    expect(queued[0]?.threadId).toBe('th_topic');
  });

  it('表单不符合登记 schema 时不消费 id，展示卡不触发回调', async () => {
    const h = await createHarness();
    const id = await registerCallback(h, {
      type: 'object', properties: { form_value: { type: 'object', properties: { note: { type: 'string', maxLength: 20 } }, required: ['note'] } }, required: ['form_value'],
    });
    await h.dispatch({ __bridge_cb: true, callback_id: id }, { note: 1 });
    await h.dispatch({ __bridge_cb: true, callback_id: id }, { note: 'yes', unexpected: 'data' });
    await h.dispatch({ choice: '展示卡' });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    await h.dispatch({ __bridge_cb: true, callback_id: id }, { note: 'yes' });
    expect(h.pending.cancel('oc_group')[0]?.content).toBe('[card-click] {"form_value":{"note":"yes"}}');
  });

  it('清空或切换 session 后，旧卡不能进入新会话', async () => {
    const h = await createHarness();
    const id = await registerCallback(h);
    h.sessions.clear('oc_group');
    expect(await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' })).toEqual({
      toast: { type: 'warning', content: '原会话已不可用，请在当前会话重新发起' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
    h.sessions.set('oc_group', 'different-session', await realpath(h.tmp.workspace));
    expect(await h.dispatch({ __bridge_cb: true, callback_id: id, choice: 'a' })).toEqual({
      toast: { type: 'warning', content: '卡片与当前会话或权限不符，请重新发起' },
    });
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('有效旧 token 的业务 callback_id 字段不会被新 registry 路由拦截', async () => {
    const h = await createHarness();
    h.activeRuns.register('oc_group', h.agent.run({ runId: 'run-active', prompt: 'running' }));
    await h.dispatch({ __bridge_cb: true, bridge_token: h.token('agent_callback'), callback_id: 'business-id', choice: 'a' });
    expect(h.pending.cancel('oc_group')[0]?.content).toBe('[card-click] {"callback_id":"business-id","choice":"a"}');
  });

  it('runs built-in command callbacks only when the bridge token verifies', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop'),
    });

    expect(activeRun.stopped).toBe(true);

    const deniedRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', deniedRun);
    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { operatorOpenId: 'ou_other' }),
    });

    expect(deniedRun.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks without leaking auth fields into the agent payload', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

type Harness = {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  auth: CallbackAuth;
  terminalActionAuth: TerminalActionAuth;
  registry: CallbackRegistryStore;
  dispatch(value: Record<string, unknown>, formValue?: Record<string, unknown>, evt?: Partial<CardActionEvent>): Promise<void | CardActionResponse>;
  token(
    action: string,
    overrides?: { operatorOpenId?: string; nonce?: string; scope?: string },
  ): string;
};

async function createHarness(
  opts: { callbackAuth?: boolean; chatMode?: 'p2p' | 'group' | 'topic'; registryPath?: string; fingerprint?: string; now?: () => number } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('callback-dispatch-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const sessionCatalog = new SessionCatalog(`${tmp.profile}/session-catalog.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const workspaceRealpath = await realpath(tmp.workspace);
  sessions.set('oc_group', 'callback-session', workspaceRealpath);
  sessions.set('oc_group:th_topic', 'callback-session', workspaceRealpath);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const registry = new CallbackRegistryStore(opts.registryPath ?? `${tmp.profile}/callback-registry.json`, opts.now);
  const controls = {
    profile: 'claude',
    profileConfig: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    processId: 'proc-1',
  } satisfies Controls;
  controls.profileConfig.workspaces.default = tmp.workspace;
  let nonce = 'nonce-stop';
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => nonce,
  });
  const terminalActionAuth = new TerminalActionAuth({ secret: 'secret' });
  const chatModeCache = {
    resolve: async () => opts.chatMode ?? 'group',
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush(), store.flush(), registry.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    auth,
    terminalActionAuth,
    registry,
    token: (action, overrides = {}) => {
      nonce = overrides.nonce ?? `nonce-${action}`;
      return auth.sign({
        runId: 'run-active',
        scope: overrides.scope ?? 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: overrides.operatorOpenId ?? 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    dispatch: (value, formValue, evt = {}) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: { ...cardEvent(value, formValue), ...evt },
        sessions,
        sessionCatalog,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        ...(opts.callbackAuth === false ? {} : { callbackAuth: auth }),
        terminalActionAuth,
        callbackRegistry: registry,
        callbackPolicyFingerprint: opts.fingerprint ?? 'fp-1',
      }),
  };
}

async function registerCallback(h: Harness, schema: unknown = {
  type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'],
}): Promise<string> {
  const token = await h.registry.beginRun({
    runId: 'run-source', scope: 'oc_group', chatId: 'oc_group',
    operatorOpenId: 'ou_operator', policyFingerprint: 'fp-1', agentId: 'claude', agentSessionId: 'callback-session',
  });
  const registration = await h.registry.register(token, { schema });
  await h.registry.bind(token, registration.id, 'om_card');
  await h.registry.endRun(token);
  return registration.id;
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}

function normalizedMessage(input: { content?: string; threadId?: string } = {}): NormalizedMessage {
  return {
    messageId: 'om_pending',
    chatId: 'oc_group',
    chatType: 'group',
    threadId: input.threadId,
    senderId: 'ou_operator',
    senderName: 'Operator',
    content: input.content ?? '',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
