import type { CardActionEvent, CardActionResponse, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { CallbackAuth } from './callback-auth';
import type { CallbackExpected, CallbackRegistryStore } from './callback-registry';
import type { TerminalActionAuth } from './terminal-action-auth';
import type { AccessDecision } from '../policy/access';
import { resetCurrentSession, runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { canUseDm, canUseGroup } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { lookupMessageThreadId, lookupMessageThreadIdOrThrow } from '../bot/thread-id';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  terminalActionAuth?: TerminalActionAuth;
  callbackRegistry?: CallbackRegistryStore;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void | CardActionResponse> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') {
    return callbackToast('未知卡片操作，请重新打开结果卡片');
  }
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;
  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = deps.evt.action.formValue ?? raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const resolvedScope = await resolveScope(deps, isTerminalAction(cmd));
  if ('error' in resolvedScope) {
    return callbackToast('无法确认卡片所属话题，请稍后重试');
  }
  const { scope, threadId, mode } = resolvedScope;

  const accessDecision =
    mode === 'p2p'
      ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId)
      : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId);
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return callbackToast('无权操作此卡片');
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  const hasLegacyToken = typeof payload.bridge_token === 'string' && Boolean(payload.bridge_token);
  if ('callback_id' in payload && !hasLegacyToken) {
    if (payload.__bridge_cb !== true || typeof payload.callback_id !== 'string' || !deps.callbackRegistry) {
      log.warn('callback', 'denied', { scope, reason: 'invalid-registry-callback' });
      return callbackToast('卡片不可用，请重新发起');
    }
    const expected = await registryCallbackContext(deps, scope, threadId, mode, accessDecision);
    if (!expected) {
      log.warn('callback', 'denied', { scope, reason: 'session-or-policy-unavailable' });
      return callbackToast('原会话已不可用，请在当前会话重新发起');
    }
    const { __bridge_cb: _marker, callback_id: _id, bridge_token: _token, ...data } = payload;
    try {
      const result = await deps.callbackRegistry.consume(payload.callback_id, expected,
        formValue ? { ...data, form_value: formValue } : data, callbackEventId(deps.evt));
      if (!result.ok) {
        log.warn('callback', 'denied', { scope, action: 'agent_callback', reason: result.reason });
        return callbackDeniedToast(result.reason);
      }
      // 消费落盘期间 /new 或策略命令可能已经执行，入队前再核对来源会话。
      const current = await registryCallbackContext(deps, scope, threadId, mode, accessDecision);
      if (!current || Object.entries(expected).some(([key, value]) => current[key as keyof CallbackExpected] !== value)) {
        log.warn('callback', 'denied', { scope, reason: 'context-changed' });
        return callbackToast('会话状态已变化，请重新发起');
      }
      forwardToAgent(deps, result.data, undefined, scope, threadId, mode);
    } catch (err) {
      log.fail('callback-registry', err, { step: 'consume' });
      log.warn('callback', 'denied', { scope, reason: 'storage-unavailable' });
      return callbackToast('暂时无法处理此卡片，请稍后重试');
    }
    return;
  }

  if (cmd === 'prompt.custom') {
    const token = typeof payload.terminal_action_token === 'string' ? payload.terminal_action_token : '';
    const result = deps.terminalActionAuth?.verify(token, { chatId, scope });
    if (!result?.ok) {
      log.warn('terminal-action', 'denied', { scope, reason: result?.reason ?? 'missing-token-or-auth' });
      return callbackToast('卡片不可用，请重新打开结果卡片');
    }
    try {
      deps.pending.push(scope, {
        messageId: deps.evt.messageId,
        chatId,
        chatType: mode === 'p2p' ? 'p2p' : 'group',
        threadId,
        senderId: operatorId,
        senderName: deps.evt.operator.name,
        content: result.prompt,
        rawContentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      });
      return callbackToast('已加入待执行队列', 'info');
    } catch (err) {
      log.fail('cardAction', err, { cmd, scope, step: 'queue-terminal-prompt' });
      return callbackToast('加入待执行队列失败，请稍后重试');
    }
  }

  if (cmd === 'prompt.test' || cmd === 'prompt.diff') {
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    const prompt = cmd === 'prompt.test'
      ? '运行当前项目的单元测试并报告结果'
      : '查看 git diff 变更并总结改动要点';
    try {
      deps.pending.push(scope, {
        messageId: deps.evt.messageId,
        chatId,
        chatType: mode === 'p2p' ? 'p2p' : 'group',
        threadId,
        senderId: operatorId,
        senderName: deps.evt.operator.name,
        content: prompt,
        rawContentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      });
      return callbackToast('已加入待执行队列', 'info');
    } catch (err) {
      log.fail('cardAction', err, { cmd, scope, step: 'queue-terminal-prompt' });
      return callbackToast('加入待执行队列失败，请稍后重试');
    }
  }

  if (cmd) {
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId);
    if (cmd === 'session.new') deps.pending.cancel(scope);

    let sessionCatalogIdentity: CommandContext['sessionCatalogIdentity'];
    try {
      sessionCatalogIdentity = await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      });
    } catch (err) {
      log.fail('cardAction', err, { cmd, scope, step: 'session-context' });
      if (cmd === 'session.new') return callbackToast('新会话失败，请稍后重试');
      return callbackToast('此卡片操作暂时失败，请稍后重试');
    }

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      sessionCatalogIdentity,
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      fromCardAction: true,
    };

    if (cmd === 'session.new') {
      try {
        const wasRunning = resetCurrentSession(ctx);
        return callbackToast(
          wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。',
          'success',
        );
      } catch (err) {
        log.fail('cardAction', err, { cmd, scope, step: 'reset-session' });
        return callbackToast('新会话失败，请稍后重试');
      }
    }

    const [name, ...rest] = cmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) {
        log.warn('cardAction', 'unknown', { cmd });
        return callbackToast('未知快捷操作，请重新打开结果卡片');
      }
    } catch (err) {
      log.fail('cardAction', err, { cmd });
      return callbackToast('此卡片操作失败，请稍后重试');
    }
    return;
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback')) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, mode);
    return;
  }

  return callbackToast('未知卡片操作，请重新打开结果卡片');
}

function isTerminalAction(cmd: string): boolean {
  return cmd === 'prompt.test' || cmd === 'prompt.diff' || cmd === 'prompt.custom' || cmd === 'session.new';
}

function callbackToast(content: string, type = 'warning'): CardActionResponse {
  return { toast: { type, content } };
}

function callbackDeniedToast(reason: string): CardActionResponse {
  switch (reason) {
    case 'unbound': return callbackToast('卡片正在准备，请稍后再点', 'info');
    case 'used': return callbackToast('该选择已处理，请勿重复提交', 'info');
    case 'event-replay': return callbackToast('该点击已收到，请勿重复提交', 'info');
    case 'expired': return callbackToast('卡片已过期，请重新发起');
    case 'schema-mismatch': return callbackToast('提交内容不符合卡片要求，请检查后重试');
    case 'context-mismatch': return callbackToast('卡片与当前会话或权限不符，请重新发起');
    default: return callbackToast('卡片不可用，请重新发起');
  }
}

function callbackEventId(evt: CardActionEvent): string | undefined {
  // SDK 版本可能只保留事件 body，使用平台 token 作为无 header 时的投递标识。
  const raw = evt.raw as { event_id?: unknown; header?: { event_id?: unknown }; token?: unknown } | undefined;
  const id = raw?.header?.event_id ?? raw?.event_id ?? raw?.token;
  return typeof id === 'string' && id.length <= 200 ? id : undefined;
}

async function registryCallbackContext(
  deps: CardDispatchDeps, scope: string, threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic', access: AccessDecision,
): Promise<CallbackExpected | undefined> {
  const identity = await commandSessionCatalogIdentity({
    msg: makeFakeMsg(deps.evt, threadId), scope, mode,
    workspaces: deps.workspaces, controls: deps.controls, access,
  });
  if (!identity) return undefined;
  const entry = deps.sessionCatalog?.activeFor(identity);
  const agentSessionId = identity.agentId === 'claude'
    ? entry?.sessionId ?? deps.sessions.resumeFor(scope, identity.cwdRealpath)
    : entry?.threadId;
  if (!agentSessionId) return undefined;
  return {
    scope, chatId: deps.evt.chatId, operatorOpenId: deps.evt.operator.openId,
    policyFingerprint: deps.callbackPolicyFingerprint ?? identity.policyFingerprint,
    messageId: deps.evt.messageId, agentId: identity.agentId, agentSessionId,
  };
}

async function resolveScope(
  deps: CardDispatchDeps,
  requireReliableThread = false,
): Promise<
  | { scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }
  | { error: 'thread-lookup-failed' }
> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode === 'p2p') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // 与消息管线一致：群聊以卡片消息的 thread_id 为准，chat_mode 可能仍为 group。
  let threadId: string | undefined;
  if (requireReliableThread) {
    try {
      threadId = await lookupMessageThreadIdOrThrow(deps.channel, deps.evt.messageId);
    } catch (err) {
      log.warn('thread', 'thread-id-lookup-failed', {
        messageId: deps.evt.messageId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { error: 'thread-lookup-failed' };
    }
  } else {
    threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  }
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode: 'topic' };
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): void {
  // Strip the marker so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return false;
  }
  return true;
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
