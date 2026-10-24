import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withConfigFileLock } from '../config/profile-store';
import { writeFileAtomic } from '../platform/atomic-write';
import { matchesCallbackSchema, parseCallbackSchema, type CallbackSchema } from './callback-schema';
import { validateTerminalAction, type TerminalAction, type TerminalActionDeclaration } from './terminal-actions';
import { validateRunTopic } from './run-topic';

export interface CallbackRunContext {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  policyFingerprint: string;
  agentId: 'claude' | 'codex';
  /** Claude session_id 或 Codex thread_id，由真实 agent 事件更新。 */
  agentSessionId?: string;
}

interface Registration extends CallbackRunContext {
  id: string;
  action: 'agent_callback';
  schema: CallbackSchema;
  expiresAt: number;
  messageId?: string;
  used?: boolean;
}

interface RegistryData {
  version: 1;
  runs: Record<string, CallbackRunContext & { pid: number }>;
  registrations: Record<string, Registration>;
  events: Record<string, number>;
  terminalActions: Record<string, TerminalActionDeclaration>;
  runTopics: Record<string, string>;
}

export interface CallbackExpected extends Omit<CallbackRunContext, 'runId' | 'agentSessionId'> {
  messageId: string;
  agentSessionId: string;
}

export type CallbackConsumeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

export class CallbackRegistryStore {
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  async beginRun(context: CallbackRunContext): Promise<string> {
    return this.transaction((state) => {
      const token = randomBytes(24).toString('base64url');
      state.runs[token] = { ...context, pid: process.pid };
      delete state.terminalActions[context.runId];
      delete state.runTopics[context.runId];
      return token;
    });
  }

  async endRun(token: string): Promise<void> {
    if (this.closed) return;
    await this.transaction((state) => {
      const context = Object.hasOwn(state.runs, token) ? state.runs[token] : undefined;
      delete state.runs[token];
      if (context) {
        delete state.terminalActions[context.runId];
        delete state.runTopics[context.runId];
      }
    });
  }

  async endAllRuns(): Promise<void> {
    await this.transaction((state) => {
      state.runs = {};
      state.terminalActions = {};
      state.runTopics = {};
    });
  }

  async setRunSession(token: string, agentSessionId: string): Promise<void> {
    if (this.closed) return;
    await this.transaction((state) => {
      const context = this.activeRun(state, token);
      context.agentSessionId = agentSessionId;
      for (const registration of Object.values(state.registrations)) {
        if (registration.runId === context.runId) registration.agentSessionId = agentSessionId;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) { await this.serial; return; }
    this.closed = true;
    await this.transaction((state) => {
      state.runs = {};
      state.terminalActions = {};
      state.runTopics = {};
    }, true);
  }

  async addTerminalAction(token: string, input: unknown): Promise<TerminalActionDeclaration> {
    const action = validateTerminalAction(input);
    return this.transaction((state) => {
      const context = this.activeRun(state, token);
      const existing = state.terminalActions[context.runId];
      if (existing && existing.actions.length === 0) {
        throw new Error('本轮已明确声明零动作，不能再添加动作');
      }
      if (existing?.actions.some(({ label }) => label === action.label)) {
        return cloneTerminalActionDeclaration(existing);
      }
      if ((existing?.actions.length ?? 0) >= 3) throw new Error('每轮最多登记 3 个动作');
      const declaration = { actions: [...(existing?.actions ?? []), action] };
      state.terminalActions[context.runId] = declaration;
      return cloneTerminalActionDeclaration(declaration);
    });
  }

  async declareNoTerminalActions(token: string): Promise<TerminalActionDeclaration> {
    return this.transaction((state) => {
      const context = this.activeRun(state, token);
      const declaration = { actions: [] };
      state.terminalActions[context.runId] = declaration;
      return declaration;
    });
  }

  async getTerminalActions(token: string): Promise<TerminalActionDeclaration | undefined> {
    return this.transaction((state) => {
      const context = this.activeRun(state, token);
      const declaration = state.terminalActions[context.runId];
      return declaration ? cloneTerminalActionDeclaration(declaration) : undefined;
    });
  }

  async setRunTopic(token: string, value: unknown): Promise<string> {
    const topic = validateRunTopic(value);
    return this.transaction((state) => {
      const context = this.activeRun(state, token);
      state.runTopics[context.runId] = topic;
      return topic;
    });
  }

  async getRunTopic(token: string): Promise<string | undefined> {
    return this.transaction((state) => {
      const context = this.activeRun(state, token);
      return state.runTopics[context.runId];
    });
  }

  async register(token: string, input: { schema: unknown; action?: string; ttlSeconds?: number }): Promise<Registration> {
    const action = input.action ?? 'agent_callback';
    if (action !== 'agent_callback') throw new Error('只支持 agent_callback action');
    const ttlSeconds = input.ttlSeconds ?? 3600;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
      throw new Error('ttl-seconds 必须是 1 至 86400 的整数');
    }
    const schema = parseCallbackSchema(input.schema);
    if (schema.type !== 'object') throw new Error('回调 schema 的根节点必须为 object');
    return this.transaction((state) => {
      const context = this.activeRun(state, token);
      const registration: Registration = {
        runId: context.runId, scope: context.scope, chatId: context.chatId,
        operatorOpenId: context.operatorOpenId, policyFingerprint: context.policyFingerprint,
        agentId: context.agentId, agentSessionId: context.agentSessionId,
        id: randomUUID(), action, schema, expiresAt: this.now() + ttlSeconds * 1000,
      };
      state.registrations[registration.id] = registration;
      return registration;
    });
  }

  async bind(token: string, id: string, messageId: string): Promise<void> {
    if (!messageId.trim() || messageId.length > 200) throw new Error('message-id 无效');
    await this.transaction((state) => {
      const context = this.activeRun(state, token);
      const registration = Object.hasOwn(state.registrations, id) ? state.registrations[id] : undefined;
      if (!registration || registration.runId !== context.runId || registration.used || registration.expiresAt <= this.now()) {
        throw new Error('登记不存在、已失效或不属于当前 run');
      }
      if (registration.messageId && registration.messageId !== messageId) throw new Error('callback 已绑定其他消息');
      registration.messageId = messageId;
    });
  }

  async consume(id: string, expected: CallbackExpected, data: Record<string, unknown>, eventId?: string): Promise<CallbackConsumeResult> {
    if (!id || id.length > 200) return { ok: false, reason: 'malformed' };
    return this.transaction((state) => {
      const registration = Object.hasOwn(state.registrations, id) ? state.registrations[id] : undefined;
      if (!registration) return { ok: false, reason: 'missing' };
      if (registration.used) return { ok: false, reason: 'used' };
      if (registration.expiresAt <= this.now()) return { ok: false, reason: 'expired' };
      if (!registration.messageId) return { ok: false, reason: 'unbound' };
      if (Object.entries(expected).some(([key, value]) => value !== registration[key as keyof CallbackExpected])) {
        return { ok: false, reason: 'context-mismatch' };
      }
      if (Buffer.byteLength(JSON.stringify(data)) > 16384 || !matchesCallbackSchema(registration.schema, data)) {
        return { ok: false, reason: 'schema-mismatch' };
      }
      const eventKey = eventId ? createHash('sha256').update(eventId).digest('hex') : undefined;
      if (eventKey && state.events[eventKey]) return { ok: false, reason: 'event-replay' };
      registration.used = true;
      if (eventKey) state.events[eventKey] = this.now() + DAY_MS;
      return { ok: true, data };
    });
  }

  async flush(): Promise<void> { await this.serial; }

  private activeRun(state: RegistryData, token: string): CallbackRunContext {
    const context = Object.hasOwn(state.runs, token) ? state.runs[token] : undefined;
    if (!context) throw new Error('该命令仅可在活动 agent run 中执行');
    try { process.kill(context.pid, 0); } catch { throw new Error('来源 Bridge 已退出'); }
    return context;
  }

  private transaction<T>(fn: (state: RegistryData) => T, closing = false): Promise<T> {
    if (this.closed && !closing) return Promise.reject(new Error('callback registry 已关闭'));
    const operation = this.serial.then(() => withConfigFileLock(this.path, async () => {
      let state: RegistryData;
      try {
        state = parseRegistryData(JSON.parse(await readFile(this.path, 'utf8')) as unknown);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        state = { version: 1, runs: {}, registrations: {}, events: {}, terminalActions: {}, runTopics: {} };
      }
      for (const [id, registration] of Object.entries(state.registrations)) {
        if (registration.expiresAt < this.now() - DAY_MS) delete state.registrations[id];
      }
      for (const [id, expiresAt] of Object.entries(state.events)) {
        if (expiresAt <= this.now()) delete state.events[id];
      }
      const result = fn(state);
      // 状态落盘成功后才确认登记或消费，持久化失败不得放行回调。
      await writeFileAtomic(this.path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      return result;
    }));
    this.serial = operation.catch(() => {});
    return operation;
  }
}

function parseRegistryData(value: unknown): RegistryData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.runs) || !isRecord(value.registrations) || !isRecord(value.events)) {
    throw new Error('callback registry 格式无效');
  }
  if (value.terminalActions !== undefined && !isRecord(value.terminalActions)) {
    throw new Error('callback registry 动作声明格式无效');
  }
  if (value.runTopics !== undefined && !isRecord(value.runTopics)) {
    throw new Error('callback registry 任务主题格式无效');
  }
  for (const context of Object.values(value.runs)) {
    if (!validContext(context) || typeof context.pid !== 'number' || !Number.isSafeInteger(context.pid) || context.pid <= 0) {
      throw new Error('callback run 登记损坏');
    }
  }
  for (const [id, registration] of Object.entries(value.registrations)) {
    if (!validContext(registration) || registration.id !== id || registration.action !== 'agent_callback' ||
      typeof registration.expiresAt !== 'number' || !Number.isFinite(registration.expiresAt) ||
      (registration.messageId !== undefined && typeof registration.messageId !== 'string') ||
      (registration.used !== undefined && typeof registration.used !== 'boolean')) {
      throw new Error('callback 登记损坏');
    }
    const schema = parseCallbackSchema(registration.schema);
    if (schema.type !== 'object') throw new Error('callback 登记 schema 损坏');
    registration.schema = schema;
  }
  if (Object.values(value.events).some((time) => typeof time !== 'number' || !Number.isFinite(time))) {
    throw new Error('callback 事件登记损坏');
  }
  const terminalActions: RegistryData['terminalActions'] = {};
  for (const [runId, rawDeclaration] of Object.entries(value.terminalActions ?? {})) {
    if (!isRecord(rawDeclaration) || !Array.isArray(rawDeclaration.actions)) {
      terminalActions[runId] = { actions: [] };
      continue;
    }
    const actions: TerminalAction[] = [];
    for (const rawAction of rawDeclaration.actions) {
      try {
        actions.push(validateTerminalAction(rawAction));
      } catch {
        // 登记文件可能被 CLI 之外的进程修改。保留声明状态并移除非法动作，避免将其渲染成可执行按钮。
      }
      if (actions.length === 3) break;
    }
    terminalActions[runId] = { actions };
  }
  value.terminalActions = terminalActions;
  const runTopics: RegistryData['runTopics'] = {};
  for (const [runId, rawTopic] of Object.entries(value.runTopics ?? {})) {
    try {
      runTopics[runId] = validateRunTopic(rawTopic);
    } catch {
      // 丢弃登记文件外部写入的非法主题，避免把内部标记或控制字符渲染到卡片。
    }
  }
  value.runTopics = runTopics;
  return value as unknown as RegistryData;
}

function cloneTerminalActionDeclaration(declaration: TerminalActionDeclaration): TerminalActionDeclaration {
  return { actions: declaration.actions.map(({ label, prompt }) => ({ label, prompt })) };
}

function validContext(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ['runId', 'scope', 'chatId', 'operatorOpenId', 'policyFingerprint'].every(
    (field) => typeof value[field] === 'string' && Boolean(value[field]),
  ) && (value.agentId === 'claude' || value.agentId === 'codex') &&
    (value.agentSessionId === undefined || (typeof value.agentSessionId === 'string' && Boolean(value.agentSessionId)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
