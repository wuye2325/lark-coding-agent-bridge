import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../agent/types';
import type { CallbackRegistryStore, CallbackRunContext } from '../card/callback-registry';
import type { TerminalActionDeclaration } from '../card/terminal-actions';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  callbackRegistry?: CallbackRegistryStore;
  stopReapGraceMs?: number;
  noProgressTimeoutMs?: () => number;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  noProgressTimeoutMs?: number;
  onSessionInvalid?: () => Promise<void>;
  callbackContext?: Pick<CallbackRunContext, 'chatId' | 'operatorOpenId' | 'agentId'>;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  getTerminalActions(): Promise<TerminalActionDeclaration | undefined>;
  getRunTopic(): Promise<string | undefined>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly callbackRegistry?: CallbackRegistryStore;
  private readonly stopReapGraceMs: number;
  private readonly defaultNoProgressTimeoutMs: () => number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.callbackRegistry = deps.callbackRegistry;
    this.stopReapGraceMs = deps.stopReapGraceMs ?? 2000;
    this.defaultNoProgressTimeoutMs = deps.noProgressTimeoutMs ?? (() => 60 * 60_000);
  }

  async hasSession(sessionId: string, cwd: string): Promise<boolean> {
    return this.agent.hasSession?.(sessionId, cwd) ?? true;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions: AgentRunOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    const revokeCallback = async (): Promise<void> => {
      if (!runOptions.callbackToken) return;
      await this.callbackRegistry?.endRun(runOptions.callbackToken).catch((err) => {
        log.fail('callback-registry', err, { step: 'end-run' });
      });
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      if (this.callbackRegistry && input.callbackContext) {
        runOptions.callbackToken = await this.callbackRegistry.beginRun({
          runId, scope: input.scopeId, ...input.callbackContext,
          policyFingerprint: input.policy.policyFingerprint,
          agentSessionId: input.callbackContext.agentId === 'claude' ? input.sessionId : input.threadId,
        });
      }
      if (this.activeRuns.newRunsPaused()) {
        throw new RunRejected('reconnect-in-progress', '登记期间 Bridge 开始重连');
      }
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      await revokeCallback();
      if (err instanceof RunRejected || err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      ...(input.callbackContext?.chatId ? { chatId: input.callbackContext.chatId } : {}),
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let cleaned = false;
    let stopping: Promise<void> | undefined;
    let stopRequested = false;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let forcedTerminal: AgentEvent | undefined;
    let fanout: EventFanout;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      if (progressTimer) clearTimeout(progressTimer);
      this.activeRuns.unregister(input.scopeId, managedRun);
      release();
      await revokeCallback();
      if (waitForExit && !await run.waitForExit(this.postDoneExitGraceMs)) {
        log.warn('run', 'post-done-exit-timeout', dimensions);
        await managedRun.stop();
      }
    };
    const stop = (): Promise<void> => {
      if (stopping) return stopping;
      stopRequested = true;
      if (progressTimer) clearTimeout(progressTimer);
      forcedTerminal ??= {
        type: 'error' as const, message: '运行已被停止', terminationReason: 'interrupted' as const,
      };
      const terminal = forcedTerminal;
      stopping = new Promise<void>((resolve) => {
        let reaped = false;
        const reap = async (): Promise<void> => {
          if (reaped) return;
          reaped = true;
          if (reapTimer) clearTimeout(reapTimer);
          try {
            run.destroy?.();
          } catch (err) {
            log.fail('run', err, dimensions);
          }
          log.warn('run', 'forced-cleanup', dimensions);
          await captureRunTopic();
          await fanout.forceFinish(terminal);
          await cleanup(false);
          resolve();
        };
        reapTimer = setTimeout(() => { void reap(); },
          (input.stopGraceMs ?? 5000) + this.stopReapGraceMs);
        void run.stop().then(async () => {
          await run.waitForExit(this.stopReapGraceMs);
        }).catch((err) => { log.fail('run', err, dimensions); }).finally(() => { void reap(); });
      });
      return stopping;
    };
    // 保留适配器的 getter/原型行为，并让所有停止入口都经过同一清理路径。
    const managedRun = new Proxy(run, {
      get: (_target, key) => {
        if (key === 'stop') return stop;
        const value = Reflect.get(run, key, run);
        return typeof value === 'function' ? value.bind(run) : value;
      },
    });
    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, managedRun);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      await revokeCallback();
      throw new RunRejected('run-already-active', err instanceof Error ? err.message : String(err));
    }
    const noProgressTimeoutMs = input.noProgressTimeoutMs
      ?? (this.agent.id === 'claude' ? this.defaultNoProgressTimeoutMs() : undefined);
    const armProgress = (): void => {
      if (progressTimer) clearTimeout(progressTimer);
      if (cleaned || stopRequested || !noProgressTimeoutMs) return;
      progressTimer = setTimeout(() => {
        forcedTerminal = {
          type: 'error', terminationReason: 'timeout',
          message: '连续无进展，已自动终止',
          timeoutMinutes: noProgressTimeoutMs! / 60_000,
        };
        log.warn('run', 'no-progress-timeout', { ...dimensions, timeoutMs: noProgressTimeoutMs });
        void stop();
      }, noProgressTimeoutMs);
      progressTimer.unref();
    };
    const agent = this.agent;
    let terminalActionsCaptured = false;
    let terminalActionDeclaration: TerminalActionDeclaration | undefined;
    const captureTerminalActions = async (): Promise<void> => {
      if (terminalActionsCaptured) return;
      terminalActionsCaptured = true;
      if (!this.callbackRegistry || !runOptions.callbackToken) return;
      try {
        terminalActionDeclaration = await this.callbackRegistry.getTerminalActions(runOptions.callbackToken);
      } catch (err) {
        log.fail('terminal-action', err, { ...dimensions, step: 'snapshot-run-declaration' });
        terminalActionDeclaration = { actions: [] };
      }
    };
    let runTopicSnapshot: string | undefined;
    let runTopicSnapshotReady: Promise<void> | undefined;
    const captureRunTopic = (): Promise<void> => {
      if (runTopicSnapshotReady) return runTopicSnapshotReady;
      runTopicSnapshotReady = (async () => {
        if (!this.callbackRegistry || !runOptions.callbackToken) return;
        try {
          runTopicSnapshot = await this.callbackRegistry.getRunTopic(runOptions.callbackToken);
        } catch (err) {
          log.fail('run-topic', err, { ...dimensions, step: 'snapshot-run-topic' });
        }
      })();
      return runTopicSnapshotReady;
    };
    const recoveredEvents = async function* (): AsyncGenerator<AgentEvent> {
      let retried = false;
      while (true) {
        let progressed = false;
        let retry = false;
        for await (const event of run.events) {
          if (stopRequested) {
            yield forcedTerminal!;
            return;
          }
          if (event.type === 'error' && input.sessionId && input.onSessionInvalid && !retried && !progressed
            && event.terminationReason === 'failed'
            && /No conversation found with session ID(?::|\s|$)/i.test(event.message)) {
            retry = true;
            break;
          }
          if (isProgressEvent(event) || (event.type === 'thinking' && event.delta.length > 0)) progressed = true;
          yield event;
          if (isTerminalEvent(event)) return;
        }
        if (!retry) {
          yield forcedTerminal ?? { type: 'error', message: '代理事件流结束但未返回结果', terminationReason: 'failed' };
          return;
        }
        retried = true;
        if (!await run.waitForExit(2000)) run.destroy?.();
        if (stopRequested) return;
        await input.onSessionInvalid!();
        if (stopRequested) return;
        log.warn('run', 'session-fallback', dimensions);
        run = agent.run({ ...runOptions, sessionId: undefined });
      }
    };
    const safeEvents = async function* (): AsyncGenerator<AgentEvent> {
      try {
        yield* recoveredEvents();
      } catch (err) {
        yield forcedTerminal ?? {
          type: 'error', terminationReason: 'failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    };
    const observed = observeRunEvents(safeEvents(), {
      dimensions, startedAt, now: this.now,
      onSystem: async (event) => {
        const sessionId = input.callbackContext?.agentId === 'claude' ? event.sessionId : event.threadId;
        if (sessionId && runOptions.callbackToken) {
          await this.callbackRegistry?.setRunSession(runOptions.callbackToken, sessionId);
        }
      },
    });
    const progressEvents = async function* (): AsyncGenerator<AgentEvent> {
      for await (const event of observed) {
        if (event.type === 'done') await captureTerminalActions();
        if (isTerminalEvent(event)) await captureRunTopic();
        if (isProgressEvent(event)) armProgress();
        if (isTerminalEvent(event) && progressTimer) clearTimeout(progressTimer);
        yield event;
      }
    };
    fanout = new EventFanout(progressEvents(), async () => { await cleanup(!stopRequested); }, () => forcedTerminal);
    armProgress();
    return {
      runId, scopeId: input.scopeId, run: managedRun, handle,
      subscribe: () => fanout.subscribe(),
      getTerminalActions: async () => terminalActionDeclaration
        ? { actions: terminalActionDeclaration.actions.map(({ label, prompt }) => ({ label, prompt })) }
        : undefined,
      getRunTopic: async () => runTopicSnapshot,
      stop: async () => {
        handle.interrupted = true;
        await stop();
      },
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
    onSystem?: (event: Extract<AgentEvent, { type: 'system' }>) => Promise<void>;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'system') await opts.onSystem?.(event);
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly terminalOnStop: () => AgentEvent | undefined;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>, terminalOnStop: () => AgentEvent | undefined) {
    this.source = source;
    this.onDone = onDone;
    this.terminalOnStop = terminalOnStop;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async forceFinish(event: AgentEvent): Promise<void> {
    if (this.done && this.buffer.some(isTerminalEvent)) return;
    this.done = true;
    this.error = undefined;
    if (!this.buffer.some(isTerminalEvent)) this.buffer.push(event);
    this.wakeAll();
    await this.onDone();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        if (this.done) break;
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      if (!this.done) {
        this.buffer.push(this.terminalOnStop() ?? {
          type: 'error', terminationReason: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
        this.wakeAll();
      }
    } finally {
      const terminal = this.terminalOnStop();
      if (terminal && !this.buffer.some(isTerminalEvent)) {
        this.buffer.push(terminal);
        this.error = undefined;
      }
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

function isProgressEvent(event: AgentEvent): boolean {
  return event.type === 'tool_use' || event.type === 'tool_result'
    || (event.type === 'text' && event.delta.length > 0)
    || (event.type === 'final_text' && event.content.length > 0);
}
