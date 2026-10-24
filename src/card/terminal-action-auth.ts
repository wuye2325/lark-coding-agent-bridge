import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateTerminalAction } from './terminal-actions';

export interface TerminalActionAuthOptions {
  secret: string;
}

export interface TerminalActionSignInput {
  chatId: string;
  scope: string;
  prompt: string;
}

export interface TerminalActionVerifyExpected {
  chatId: string;
  scope: string;
}

export type TerminalActionVerifyResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'context-mismatch' };

interface TerminalActionPayload {
  v: 1;
  c: string;
  s: string;
  p: string;
}

const PREFIX = 'bridge_action.v1';
const MAX_TOKEN_LENGTH = 8192;

export class TerminalActionAuth {
  private readonly secret: string;

  constructor(options: TerminalActionAuthOptions) {
    if (!options.secret) throw new Error('终态快捷动作签名密钥不能为空');
    this.secret = options.secret;
  }

  sign(input: TerminalActionSignInput): string {
    if (!input.chatId || !input.scope) throw new Error('终态快捷动作签名上下文无效');
    const { prompt } = validateTerminalAction({ label: '动作', prompt: input.prompt });
    const payload: TerminalActionPayload = { v: 1, c: input.chatId, s: input.scope, p: prompt };
    const encoded = encodeJson(payload);
    return `${PREFIX}.${encoded}.${sign(encoded, this.secret)}`;
  }

  verify(token: string, expected: TerminalActionVerifyExpected): TerminalActionVerifyResult {
    if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      return { ok: false, reason: 'malformed' };
    }
    const encoded = parts[2];
    const signature = parts[3];
    if (!encoded || !signature || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
      return { ok: false, reason: 'malformed' };
    }
    const payload = decodePayload(encoded);
    if (!payload) return { ok: false, reason: 'malformed' };
    if (!signatureMatches(signature, sign(encoded, this.secret))) {
      return { ok: false, reason: 'bad-signature' };
    }
    try {
      const normalized = validateTerminalAction({ label: '动作', prompt: payload.p }).prompt;
      if (normalized !== payload.p) return { ok: false, reason: 'malformed' };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (
      payload.c !== expected.chatId ||
      payload.s !== expected.scope
    ) {
      return { ok: false, reason: 'context-mismatch' };
    }
    return { ok: true, prompt: payload.p };
  }
}

function encodeJson(payload: TerminalActionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(encoded: string): TerminalActionPayload | undefined {
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return undefined;
    const raw = JSON.parse(bytes.toString('utf8')) as Partial<TerminalActionPayload>;
    if (raw.v !== 1 || typeof raw.c !== 'string' || !raw.c || typeof raw.s !== 'string' || !raw.s || typeof raw.p !== 'string') {
      return undefined;
    }
    return { v: 1, c: raw.c, s: raw.s, p: raw.p };
  } catch {
    return undefined;
  }
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${PREFIX}.${encodedPayload}`).digest('base64url');
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
