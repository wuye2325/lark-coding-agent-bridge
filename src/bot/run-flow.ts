import { log } from '../core/logger';
import { getRunNoProgressTimeoutMs } from '../config/schema';
import type { AgentCapability } from '../agent/capability';
import { resolveModelArg, resolveReasoningEffort } from '../agent/models';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import { RunRejected, SpawnFailed, type RunRejectedCode, type SpawnFailedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface StartRunFlowInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  now: number;
  stopGraceMs?: number;
  onSessionReset?: (message: string) => Promise<void>;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode
  | SpawnFailedCode;

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  let resumeFrom: string | undefined;
  let sessionId: string | undefined;
  let threadId: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    if (catalogEntry?.agentId === 'claude') {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.agentId === 'codex') {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (!resumeFrom && input.capability.agentId === 'claude') {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }

  const resetSession = async (): Promise<void> => {
    input.sessionCatalog?.archiveActive({
      scopeId: input.scopeId, agentId: 'claude',
      cwdRealpath: workspace.cwdRealpath, policyFingerprint: policy.policyFingerprint,
    });
    input.sessions.clear(input.scopeId);
    log.warn('session', 'fallback', {
      scope: input.scopeId, chatId: input.scope.chatId, reason: 'transcript-unavailable',
    });
    await Promise.all([input.sessions.flush(), input.sessionCatalog?.flush()]);
    await input.onSessionReset?.('旧会话已失效，已开启新会话；关键背景可能需要补充。').catch((err) => {
      log.fail('session', err, { scope: input.scopeId, step: 'fallback-notice' });
    });
  };
  if (sessionId && !await input.executor.hasSession(sessionId, workspace.cwdRealpath)) {
    await resetSession();
    sessionId = undefined;
    resumeFrom = undefined;
  }

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy,
      sessionId,
      threadId,
      ...(input.capability.agentId === 'claude' ? {
        onSessionInvalid: resetSession,
        noProgressTimeoutMs: getRunNoProgressTimeoutMs({ preferences: input.profileConfig.preferences }),
      } : {}),
      model: resolveModelArg(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.model,
      ),
      reasoningEffort: resolveReasoningEffort(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.reasoningEffort,
      ),
      images:
        input.capability.agentId === 'codex'
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      ...((input.scope.source === 'im' || input.scope.source === 'card') && input.scope.chatId ? {
        callbackContext: { chatId: input.scope.chatId, operatorOpenId: input.scope.actorId, agentId: input.capability.agentId },
      } : {}),
      observability: input.observability,
    });
  } catch (err) {
    if (err instanceof SpawnFailed) {
      log.fail('run-flow', err, { scope: input.scopeId, step: 'spawn' });
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible: spawnFailureMessage(err),
        },
        workspace,
      };
    }
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  if (input.capability.agentId === 'claude' && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'claude',
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
  if (input.capability.agentId === 'codex' && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'codex',
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}

function spawnFailureMessage(err: SpawnFailed): string {
  const causeCode = err.cause && typeof err.cause === 'object' && 'code' in err.cause
    ? err.cause.code : undefined;
  const code = err.diagnostic?.errno ?? causeCode;
  // 仅展示已知错误的解释，避免把底层命令、路径或凭证发送到群聊。
  const hint = code === 'ENOSPC'
    ? '磁盘空间不足，请清理磁盘空间后重发。'
    : code === 'EACCES' || code === 'EPERM'
      ? '权限不足，请检查文件和目录权限，以及代理可执行权限后重发。'
      : '请联系维护者查看启动日志，处理后重发。';
  return `代理启动失败（${err.code}），本轮已结束。${hint}后续消息可继续处理。`;
}
