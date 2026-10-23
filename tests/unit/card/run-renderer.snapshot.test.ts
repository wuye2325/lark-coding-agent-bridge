import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('collapses consecutive tools while preserving the latest running tool', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('renders run metadata and full tool counts on an exceptional result card', () => {
    const state: RunState = {
      blocks: [{ kind: 'text', content: '最终答复', streaming: false }],
      reasoning: { content: '', active: false },
      footer: null,
      terminal: 'error',
      errorMsg: 'agent crashed',
    };

    const card = renderCard(state, {
      agentName: '🤖 Codex',
      workspaceName: 'lark-coding-agent-bridge',
      durationMs: 62_000,
      toolStats: { total: 3, succeeded: 1, errors: 1, unfinished: 1 },
    }) as {
      header?: {
        title?: { content?: string };
        subtitle?: { content?: string };
        template?: string;
        text_tag_list?: Array<{ tag?: string; text?: { content?: string }; color?: string }>;
      };
      body?: { elements?: Array<{ tag?: string; content?: string }> };
    };

    expect(card.header?.title?.content).toBe('🤖 Codex');
    expect(card.header?.subtitle?.content).toBe('📁 lark-coding-agent-bridge · ⏱ 处理时长 1 分 02 秒');
    expect(card.header?.template).toBe('red');
    expect(card.header?.text_tag_list?.[0]).toEqual({
      tag: 'text_tag',
      text: { tag: 'plain_text', content: '运行失败' },
      color: 'red',
    });
    expect(JSON.stringify(card.body?.elements)).toContain('工具调用：3 次 · 成功 1 · 错误 1 · 未完成 1');
    expect(JSON.stringify(card.body?.elements)).toContain('agent crashed');
  });

  it('keeps the running card light blue and names the current stage', () => {
    const state = stateFrom([
      { type: 'text', delta: 'progress' },
      { type: 'tool_use', id: 'tool-running', name: 'Bash', input: { command: 'pwd' } },
    ]);
    const card = renderCard(state, {
      agentName: '🤖 Codex',
      workspaceName: 'bridge',
      toolStats: { total: 1, succeeded: 0, errors: 0 },
    }) as {
      header?: {
        template?: string;
        subtitle?: { content?: string };
        text_tag_list?: Array<{ color?: string; text?: { content?: string } }>;
      };
    };

    expect(card.header?.template).toBe('wathet');
    expect(card.header?.subtitle?.content).toBe('📁 bridge · 正在调用工具');
    expect(card.header?.text_tag_list?.[0]).toMatchObject({
      text: { content: '运行中' },
      color: 'wathet',
    });
  });

  it('gives timeout status priority over tool warnings and preserves unfinished counts', () => {
    const timedOut = markIdleTimeout(stateFrom([
      { type: 'tool_use', id: 'tool-pending', name: 'Bash', input: { command: 'secret' } },
    ]), 15);
    const state = { ...timedOut, blocks: [] };
    const card = renderCard(state, {
      agentName: '🤖 Claude Code',
      workspaceName: 'bridge',
      durationMs: 62_000,
      toolStats: { total: 2, succeeded: 0, errors: 1, unfinished: 1 },
    }) as {
      header?: {
        template?: string;
        text_tag_list?: Array<{ color?: string; text?: { content?: string } }>;
      };
      body?: { elements?: Array<{ content?: string }> };
    };

    expect(card.header?.template).toBe('orange');
    expect(card.header?.text_tag_list?.[0]).toMatchObject({
      text: { content: '已超时' },
      color: 'orange',
    });
    expect(JSON.stringify(card.body?.elements)).toContain('工具调用：2 次 · 成功 0 · 错误 1 · 未完成 1');
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('injects signed bridge callback values for managed run controls', () => {
    const card = renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }) as {
      body?: { elements?: Array<{ tag?: string; behaviors?: Array<{ value?: Record<string, unknown> }> }> };
    };
    const button = card.body?.elements?.find((element) => element.tag === 'button');

    expect(button?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'token-for-stop',
    });
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}
