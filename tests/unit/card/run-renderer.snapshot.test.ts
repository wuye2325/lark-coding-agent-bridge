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

  it('shows a deduplicated manifest of successful Edit, Write, and NotebookEdit targets', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'src/shared.ts' } },
      { type: 'tool_result', id: 'edit', output: 'updated', isError: false },
      { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'src/shared.ts' } },
      { type: 'tool_result', id: 'write', output: 'written', isError: false },
      {
        type: 'tool_use',
        id: 'notebook',
        name: 'NotebookEdit',
        input: { file_path: 'notebooks/scratch.ipynb', notebook_path: 'notebooks/analysis.ipynb' },
      },
      { type: 'tool_result', id: 'notebook', output: 'updated', isError: false },
      { type: 'tool_use', id: 'failed', name: 'Edit', input: { file_path: 'src/failed.ts' } },
      { type: 'tool_result', id: 'failed', output: 'write rejected', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = renderCard(state) as {
      body?: {
        elements?: Array<{
          tag?: string;
          header?: { title?: { content?: string } };
          elements?: Array<{ content?: string }>;
        }>;
      };
    };
    const manifest = card.body?.elements?.find((element) =>
      element.header?.title?.content?.includes('📝 写入文件清单'),
    );
    const manifestJson = JSON.stringify(manifest);

    expect(manifest?.header?.title?.content).toBe('📝 写入文件清单（2 个文件）');
    expect(manifestJson.match(/src\/shared\.ts/g)).toHaveLength(1);
    expect(manifestJson).toContain('notebooks/analysis.ipynb');
    expect(manifestJson).not.toContain('notebooks/scratch.ipynb');
    expect(manifestJson).not.toContain('src/failed.ts');
  });

  it('shows details for only the first failed tool across the full run', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'first-error', name: 'Bash', input: { command: 'first command' } },
      { type: 'tool_result', id: 'first-error', output: 'FIRST_ERROR_EVIDENCE', isError: true },
      { type: 'text', delta: 'between error groups' },
      { type: 'tool_use', id: 'second-error', name: 'Write', input: { file_path: 'second-error.txt' } },
      { type: 'tool_result', id: 'second-error', output: 'SECOND_ERROR_EVIDENCE', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = renderCard(state) as {
      body?: { elements?: Array<{ tag?: string; expanded?: boolean }> };
    };
    const cardJson = JSON.stringify(card);
    const expandedPanels = card.body?.elements?.filter(
      (element) => element.tag === 'collapsible_panel' && element.expanded === true,
    );

    expect(cardJson).toContain('FIRST_ERROR_EVIDENCE');
    expect(cardJson).not.toContain('SECOND_ERROR_EVIDENCE');
    expect(expandedPanels).toHaveLength(1);
  });

  it('limits first-error output to 500 characters', () => {
    const addresses = Array.from({ length: 50 }, (_, index) => `user${index}@example.com`);
    const longOutput = `${addresses.join('\n')}\nTAIL_MARKER`;
    const state = stateFrom([
      { type: 'tool_use', id: 'long-error', name: 'Bash', input: { command: 'long output' } },
      { type: 'tool_result', id: 'long-error', output: longOutput, isError: true },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = renderCard(state) as {
      body?: {
        elements?: Array<{ expanded?: boolean; elements?: Array<{ content?: string }> }>;
      };
    };
    const evidencePanel = card.body?.elements?.find((element) => element.expanded === true);
    const content = evidencePanel?.elements?.[0]?.content ?? '';
    const displayedOutput = content.split('**错误输出**\n```\n')[1]?.split('\n```')[0] ?? '';

    expect(Array.from(displayedOutput)).toHaveLength(500);
    expect(displayedOutput).not.toContain('@example.com');
    expect(displayedOutput).not.toContain('TAIL_MARKER');
  });

  it('keeps the complete result card below 15 KB while retaining the answer, status, and key error', () => {
    const finalAnswer = `PRIMARY_ANSWER ${'结果'.repeat(7_000)} user@example.com`;
    const events: AgentEvent[] = [
      { type: 'tool_use', id: 'critical-error', name: 'Bash', input: { command: 'verify' } },
      { type: 'tool_result', id: 'critical-error', output: 'KEY_ERROR_EVIDENCE', isError: true },
    ];
    for (let index = 0; index < 50; index += 1) {
      const id = `write-${index}`;
      events.push({
        type: 'tool_use',
        id,
        name: 'Write',
        input: { file_path: `user${index}@example.com/${'长路径'.repeat(100)}` },
      });
      events.push({ type: 'tool_result', id, output: 'written', isError: false });
    }
    events.push(
      { type: 'text', delta: finalAnswer },
      { type: 'final_text', content: finalAnswer },
      { type: 'done', terminationReason: 'normal' },
    );

    const state = stateFrom(events);
    const card = renderCard(state, {
      agentName: '🤖 Claude Code',
      workspaceName: 'bridge',
      durationMs: 1_250,
      toolStats: { total: 51, succeeded: 50, errors: 1 },
    }) as {
      header?: { template?: string; text_tag_list?: Array<{ text?: { content?: string } }> };
      body?: {
        elements?: Array<{
          tag?: string;
          columns?: Array<{
            elements?: Array<{
              tag?: string;
              behaviors?: Array<{ value?: Record<string, unknown> }>;
            }>;
          }>;
        }>;
      };
    };
    const cardJson = JSON.stringify(card);
    const actionColumnSet = card.body?.elements?.find((element) => element.tag === 'column_set');
    const actionCommands = actionColumnSet?.columns?.flatMap((column) =>
      column.elements?.flatMap((element) => element.behaviors?.map((behavior) => behavior.value?.cmd) ?? []) ?? [],
    );

    expect(Buffer.byteLength(cardJson, 'utf8')).toBeLessThan(14_000);
    expect(card.header?.template).toBe('orange');
    expect(card.header?.text_tag_list?.[0]?.text?.content).toContain('已完成 · 1 次工具错误');
    expect(cardJson).toContain('PRIMARY_ANSWER');
    expect(cardJson).toContain('KEY_ERROR_EVIDENCE');
    expect(cardJson).toContain('📝 写入文件清单（50 个文件）');
    expect(cardJson).toContain('另有');
    expect(actionCommands).toEqual(['prompt.test', 'prompt.diff', 'session.new']);
    expect(cardJson).not.toContain('@example.com');
    expect(cardJson).toContain('[at]example.com');
  });

  it('keeps the running stop callback and status when reducing an oversized card', () => {
    const events: AgentEvent[] = [{ type: 'text', delta: `运行中进展 ${'过程'.repeat(7_000)}` }];
    for (let index = 0; index < 200; index += 1) {
      const id = `tool-${index}`;
      events.push({ type: 'tool_use', id, name: 'Bash', input: { command: `command-${index}` } });
      events.push({ type: 'tool_result', id, output: 'done', isError: false });
    }
    events.push({
      type: 'tool_use',
      id: 'active-tool',
      name: 'Bash',
      input: { command: 'CURRENT_COMMAND' },
    });

    const card = renderCard(stateFrom(events), {
      agentName: '🤖 Codex',
      workspaceName: 'bridge',
      toolStats: { total: 201, succeeded: 200, errors: 0 },
      signCallback: (action) => `signed-${action}`,
    }) as {
      header?: { template?: string; text_tag_list?: Array<{ text?: { content?: string } }> };
      body?: {
        elements?: Array<{
          tag?: string;
          text?: { content?: string };
          behaviors?: Array<{ value?: Record<string, unknown> }>;
        }>;
      };
    };
    const cardJson = JSON.stringify(card);
    const stopButton = card.body?.elements?.find((element) => element.tag === 'button');

    expect(Buffer.byteLength(cardJson, 'utf8')).toBeLessThan(15_000);
    expect(card.header?.template).toBe('wathet');
    expect(card.header?.text_tag_list?.[0]?.text?.content).toBe('运行中');
    expect(stopButton?.text?.content).toBe('⏹ 终止');
    expect(stopButton?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'signed-stop',
    });
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

  it('终态卡片提供固定快捷动作，运行中仍只展示签名终止动作', () => {
    const terminal = JSON.stringify(renderCard(stateFrom([
      { type: 'text', delta: '完成' },
      { type: 'done', terminationReason: 'normal' },
    ])));
    expect(terminal).toContain('运行单测');
    expect(terminal).toContain('查看 Diff');
    expect(terminal).toContain('新会话');
    expect(terminal).toContain('💡 快捷按钮将在当前会话中执行');
    expect(terminal).toContain('"cmd":"prompt.test"');
    expect(terminal).toContain('"cmd":"prompt.diff"');
    expect(terminal).toContain('"cmd":"session.new"');
    expect(terminal).not.toContain('__bridge_cb');
    expect(terminal).not.toContain('bridge_token');

    const running = JSON.stringify(renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }));
    expect(running).toContain('"cmd":"stop"');
    expect(running).not.toContain('prompt.test');
    expect(running).not.toContain('prompt.diff');
    expect(running).not.toContain('session.new');
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
