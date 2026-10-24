import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalActionAuth } from '../../../src/card/terminal-action-auth.js';
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

    expect(card.header?.title?.content).toBe('lark-coding-agent-bridge');
    expect(card.header?.subtitle).toBeUndefined();
    expect(card.body?.elements?.at(-1)).toMatchObject({
      tag: 'markdown',
      content: '🤖 Codex · 📁 lark-coding-agent-bridge · ⏱ 处理时长 1 分 02 秒',
      text_size: 'notation',
    });
    expect(card.header?.template).toBe('red');
    expect(card.header?.text_tag_list?.[0]).toEqual({
      tag: 'text_tag',
      text: { tag: 'plain_text', content: '运行失败' },
      color: 'red',
    });
    expect(JSON.stringify(card.body?.elements)).toContain('工具调用：3 次 · 成功 1 · 错误 1 · 未完成 1');
    expect(JSON.stringify(card.body?.elements)).toContain('agent crashed');
  });

  it('uses the task topic as the header and omits duration from running metadata', () => {
    const card = renderCard(initialState, {
      runTopic: '审查付款条款',
      agentName: '🤖 Claude Code',
      workspaceName: '明珠合同',
      durationMs: 12_000,
    }) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ tag?: string; content?: string }> };
    };

    expect(card.header?.title?.content).toBe('审查付款条款');
    expect(card.body?.elements?.at(-1)).toMatchObject({
      tag: 'markdown',
      content: '🤖 Claude Code · 📁 明珠合同',
    });
  });

  it('falls back to the workspace or generic task without showing the Agent name in the header', () => {
    const withWorkspace = renderCard(initialState, {
      agentName: '🤖 Codex',
      workspaceName: '案件目录',
    }) as { header?: { title?: { content?: string } } };
    const withoutWorkspace = renderCard(initialState, {
      agentName: '🤖 Codex',
    }) as { header?: { title?: { content?: string } } };

    expect(withWorkspace.header?.title?.content).toBe('案件目录');
    expect(withoutWorkspace.header?.title?.content).toBe('任务');
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

  it('prioritizes short and long final answers ahead of oversized Agent diagnostics', () => {
    const finalAnswers = [
      { content: 'FINAL_RESULT_SHOULD_REMAIN：这是需要保留的最终答复。', truncated: false },
      { content: `LONG_RESULT_SHOULD_REMAIN ${'长正文内容'.repeat(7_000)}`, truncated: true },
    ];

    for (const answer of finalAnswers) {
      const state: RunState = {
        blocks: [{ kind: 'text', content: answer.content, streaming: false }],
        finalText: answer.content,
        reasoning: { content: '', active: false },
        footer: null,
        terminal: 'error',
        errorMsg: '异常诊断内容'.repeat(650),
      };
      const card = renderCard(state, {
        agentName: '🤖 Claude Code',
        workspaceName: 'demo',
        durationMs: 1_200,
        toolStats: { total: 1, succeeded: 0, errors: 1 },
        firstToolError: {
          id: 'e',
          name: 'Bash',
          input: { command: 'example' },
          status: 'error',
          output: '工具错误'.repeat(400),
        },
        showToolDetails: true,
      }) as {
        header?: { text_tag_list?: Array<{ text?: { content?: string } }> };
        body?: {
          elements?: Array<{
            tag?: string;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value?: { cmd?: string } }> }>;
            }>;
          }>;
        };
      };
      const cardJson = JSON.stringify(card);
      const actionColumnSet = card.body?.elements?.find((element) => element.tag === 'column_set');
      const actionCommands = actionColumnSet?.columns?.flatMap((column) =>
        column.elements?.flatMap((element) => element.behaviors?.map((behavior) => behavior.value?.cmd) ?? []) ?? [],
      );

      expect(Buffer.byteLength(cardJson, 'utf8')).toBeLessThan(15_000);
      expect(cardJson).toContain(answer.truncated ? answer.content.slice(0, 80) : answer.content);
      expect(card.header?.text_tag_list?.[0]?.text?.content).toBe('运行失败');
      expect(cardJson).toContain('工具错误');
      expect(cardJson).toContain('Agent 错误因载荷预算截断');
      if (answer.truncated) expect(cardJson).toContain('正文因载荷预算截断');
      expect(actionCommands).toBeUndefined();
    }
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
    const auth = new TerminalActionAuth({ secret: 'budget-test-secret' });
    const card = renderCard(state, {
      agentName: '🤖 Claude Code',
      workspaceName: 'bridge',
      durationMs: 1_250,
      toolStats: { total: 51, succeeded: 50, errors: 1 },
      terminalActions: {
        actions: [
          { label: '生成摘要', prompt: '将本轮主要结论整理成一段摘要' },
          { label: '提取条款', prompt: '提取本轮审阅材料中的重要条款并标注页码' },
          { label: '生成清单', prompt: '将本轮识别的风险整理成核对清单' },
        ],
      },
      signTerminalAction: (prompt) => auth.sign({ chatId: 'oc_group', scope: 'oc_group', prompt }),
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
    expect(actionCommands).toEqual(['prompt.custom', 'prompt.custom', 'prompt.custom']);
    expect(terminalActionButtonValues(card).map((value) => auth.verify(String(value.terminal_action_token), {
      chatId: 'oc_group', scope: 'oc_group',
    }).ok)).toEqual([true, true, true]);
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
      body?: { elements?: Array<{ tag?: string; content?: string }> };
    };

    expect(card.header?.template).toBe('wathet');
    expect(card.header?.subtitle?.content).toBe('正在调用工具');
    expect(card.body?.elements?.at(-1)).toMatchObject({
      tag: 'markdown',
      content: '🤖 Codex · 📁 bridge',
    });
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

  it('done 卡片只渲染本轮已声明的动作，保留顺序且不混入静态兜底', () => {
    const auth = new TerminalActionAuth({ secret: 'renderer-test-secret' });
    const card = renderCard(stateFrom([
      { type: 'text', delta: '完成' },
      { type: 'done', terminationReason: 'normal' },
    ]), {
      terminalActions: {
        actions: [
          { label: '导出 Word', prompt: '导出 /matter/client@example.com/对比表.docx 并发到当前会话' },
          { label: '版本对比', prompt: '对比 /matter/旧版.docx 与 /matter/新版.docx' },
        ],
      },
      signTerminalAction: (prompt) => auth.sign({ chatId: 'oc_group', scope: 'oc_group', prompt }),
      writtenFiles: ['/matter/新版.docx'],
    });
    const terminal = JSON.stringify(card);
    const actionValues = terminalActionButtonValues(card);

    expect(terminal).toContain('导出 Word');
    expect(terminal).toContain('版本对比');
    expect(terminal.match(/prompt\.custom/g)).toHaveLength(2);
    expect(terminal).not.toContain('client@example.com');
    expect(actionValues.map((value) => value.cmd)).toEqual(['prompt.custom', 'prompt.custom']);
    expect(actionValues.map((value) => auth.verify(String(value.terminal_action_token), {
      chatId: 'oc_group', scope: 'oc_group',
    }))).toEqual([
      { ok: true, prompt: '导出 /matter/client@example.com/对比表.docx 并发到当前会话' },
      { ok: true, prompt: '对比 /matter/旧版.docx 与 /matter/新版.docx' },
    ]);
    expect(terminal).not.toContain('运行单测');
    expect(terminal).not.toContain('查看 Diff');
    expect(terminal).not.toContain('新会话');
  });

  it('三个 500 Unicode 码点动作完整渲染且整卡不超过 14 KiB', () => {
    const auth = new TerminalActionAuth({ secret: 'renderer-test-secret' });
    const card = renderCard(stateFrom([{ type: 'done', terminationReason: 'normal' }]), {
      terminalActions: {
        actions: [
          { label: '动作一', prompt: '😀'.repeat(500) },
          { label: '动作二', prompt: '😀'.repeat(500) },
          { label: '动作三', prompt: '😀'.repeat(500) },
        ],
      },
      signTerminalAction: (prompt) => auth.sign({ chatId: 'oc_group', scope: 'oc_group', prompt }),
    });

    const values = terminalActionButtonValues(card);
    expect(values).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThan(14_000);
    expect(values.map((value) => auth.verify(String(value.terminal_action_token), {
      chatId: 'oc_group', scope: 'oc_group',
    }).ok)).toEqual([true, true, true]);
  });

  it('失败、中断和无进展超时终态不渲染本轮动作', () => {
    const options = {
      terminalActions: { actions: [{ label: '导出 Word', prompt: '导出 /matter/result.md' }] },
      signTerminalAction: (prompt: string) => `签名:${prompt}`,
    };
    const states = [
      stateFrom([{ type: 'error', message: '失败', terminationReason: 'failed' }]),
      markInterrupted(stateFrom([{ type: 'text', delta: '部分结果' }])),
      markIdleTimeout(stateFrom([{ type: 'text', delta: '部分结果' }]), 15),
    ];

    for (const state of states) {
      expect(JSON.stringify(renderCard(state, options))).not.toContain('prompt.custom');
    }
  });

  it('未声明动作时只按测试入口与 Git 写入条件显示静态兜底，明确零动作会关闭兜底', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'terminal-action-git-repo-'));
    const ordinaryDirectory = await mkdtemp(join(tmpdir(), 'terminal-action-ordinary-'));
    const invalidGitDirectory = await mkdtemp(join(tmpdir(), 'terminal-action-invalid-git-'));
    execFileSync('git', ['init', repo], { stdio: 'ignore' });
    await mkdir(join(invalidGitDirectory, '.git'));
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const done = stateFrom([
      { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/repo/result.docx' } },
      { type: 'tool_result', id: 'write-1', output: '写入成功', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const options = {
      signTerminalAction: (prompt: string) => `签名:${prompt}`,
      cwd: repo,
      writtenFiles: ['/repo/result.docx'],
    };

    try {
      const fallback = JSON.stringify(renderCard(done, options));
      expect(fallback).toContain('运行单测');
      expect(fallback).toContain('查看 Diff');
      expect(fallback.match(/prompt\.custom/g)).toHaveLength(2);
      expect(fallback).not.toContain('新会话');

      const explicitZero = JSON.stringify(renderCard(done, { ...options, terminalActions: { actions: [] } }));
      expect(explicitZero).not.toContain('运行单测');
      expect(explicitZero).not.toContain('查看 Diff');

      const disabled = JSON.stringify(renderCard(done, { ...options, terminalActionsMode: 'off' }));
      expect(disabled).not.toContain('运行单测');
      expect(disabled).not.toContain('查看 Diff');

      const ordinary = JSON.stringify(renderCard(done, { ...options, cwd: ordinaryDirectory }));
      expect(ordinary).not.toContain('运行单测');
      expect(ordinary).not.toContain('查看 Diff');

      const staleGitMarker = JSON.stringify(renderCard(done, { ...options, cwd: invalidGitDirectory }));
      expect(staleGitMarker).not.toContain('查看 Diff');
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(ordinaryDirectory, { recursive: true, force: true }),
        rm(invalidGitDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it('运行中仍只展示签名终止动作', () => {
    const running = JSON.stringify(renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }));
    expect(running).toContain('"cmd":"stop"');
    expect(running).not.toContain('prompt.custom');
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

function terminalActionButtonValues(card: object): Array<Record<string, unknown>> {
  type Button = { behaviors?: Array<{ value?: Record<string, unknown> }> };
  type Column = { elements?: Button[] };
  type Element = { tag?: string; columns?: Column[] };
  const body = (card as { body?: { elements?: Element[] } }).body;
  return (body?.elements ?? []).flatMap((element) => element.tag === 'column_set'
    ? (element.columns ?? []).flatMap((column) => (column.elements ?? [])
      .flatMap((button) => button.behaviors?.flatMap((behavior) => behavior.value ? [behavior.value] : []) ?? []))
    : []);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}
