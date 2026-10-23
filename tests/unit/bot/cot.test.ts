import { describe, expect, it } from 'vitest';
import { consumeCotEvents, CotClient, CotPublisher, cotBriefToolTitle, finalAnswerOnlyState } from '../../../src/bot/cot.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunState } from '../../../src/card/run-state.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';

describe('COT event mapping', () => {
  it('publishes assistant progress text and brief tool summaries', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-1',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'draw a bear',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: '我会先生成图片。' },
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'echo bear' } },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'text', delta: '图片已经生成。' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    const eventTypes = client.events.map((event) => event.event_type);
    expect(eventTypes).toContain('TEXT_MESSAGE_START');
    expect(eventTypes).toContain('TEXT_MESSAGE_CONTENT');
    expect(eventTypes).toContain('TEXT_MESSAGE_END');
    expect(eventTypes).toContain('TOOL_CALL_START');
    expect(eventTypes).toContain('TOOL_CALL_RESULT');
    expect(eventTypes).not.toContain('TOOL_CALL_ARGS');

    const textDeltas = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => JSON.parse(event.content).delta);
    expect(textDeltas).toEqual(['我会先生成图片。', '图片已经生成。']);

    const toolResult = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(toolResult?.content ?? '{}').content).toContain('command_execution');
    expect(client.completed).toEqual(['done']);
  });

  it('includes tool args and output only in detailed mode', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-2',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: 'workspace', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    expect(client.events.map((event) => event.event_type)).toContain('TOOL_CALL_ARGS');
    const result = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(result?.content ?? '{}').content).toBe('workspace');
  });

  it('suppresses all tool details from native CoT while tool display is hidden', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-hidden-tools',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-secret', name: 'Bash', input: { command: 'private command' } },
      { type: 'tool_result', id: 'tool-secret', output: 'private output', isError: true },
      { type: 'text', delta: '仍展示安全的过程文本' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed', showTools: () => false });

    expect(client.events.map((event) => event.event_type)).not.toContain('TOOL_CALL_START');
    expect(client.events.map((event) => event.event_type)).not.toContain('TOOL_CALL_ARGS');
    expect(client.events.map((event) => event.event_type)).not.toContain('TOOL_CALL_RESULT');
    expect(JSON.stringify(client.events)).not.toMatch(/Bash|private command|private output/);
    expect(JSON.stringify(client.events)).toContain('仍展示安全的过程文本');
  });

  it('advances through generalized stages with hidden tools without publishing the final answer', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-hidden-stage-progress',
      scope: 'oc_chat',
      inputPreview: 'run',
      showTools: () => false,
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-secret', name: 'Bash', input: { command: 'private command' } },
      { type: 'tool_result', id: 'tool-secret', output: 'private output', isError: false },
      { type: 'final_text', content: 'FINAL_ANSWER_STAYS_OUT_OF_COT' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief', showTools: () => false });

    const started = client.events
      .filter((event) => event.event_type === 'STEP_STARTED')
      .map((event) => JSON.parse(event.content));
    const finished = client.events
      .filter((event) => event.event_type === 'STEP_FINISHED')
      .map((event) => JSON.parse(event.content));
    expect(started.map((step) => step.stepName)).toEqual([
      '理解用户问题',
      '处理任务',
      '整理结果',
    ]);
    expect(finished.map((step) => step.stepId)).toEqual(started.map((step) => step.stepId));
    expect(JSON.stringify(client.events)).not.toMatch(/Bash|private command|private output|FINAL_ANSWER_STAYS_OUT_OF_COT/);
    expect(client.events.map((event) => event.event_type)).not.toContain('TOOL_CALL_START');
    expect(client.events.find((event) => event.event_type === 'RUN_FINISHED')?.content)
      .toContain('"status":"done"');
    expect(client.completed).toEqual(['done']);
  });

  it('keeps preceding process text but omits Claude assistant text repeated as final_text', async () => {
    const finalAnswers = [
      'CLAUDE_FINAL_RESULT_SHOULD_STAY_OUT_OF_COT',
      `CLAUDE_LONG_FINAL_RESULT_SHOULD_STAY_OUT_OF_COT ${'长答复内容'.repeat(500)}`,
    ];

    for (const finalAnswer of finalAnswers) {
      const client = new FakeCotClient();
      const publisher = new CotPublisher({
        client,
        chatId: 'oc_chat',
        originMessageId: 'om_origin',
        runId: 'run-claude-final-text-dedup',
        scope: 'oc_chat',
        inputPreview: 'run',
      });
      await publisher.start();
      const rawEvents = [
        { type: 'assistant', message: { content: [{ type: 'text', text: '先前的真实过程进度。' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: finalAnswer }] } },
        { type: 'result', subtype: 'success', result: finalAnswer },
      ];
      const events = (async function* (): AsyncIterable<AgentEvent> {
        for (const raw of rawEvents) yield* translateEvent(raw);
      })();

      await consumeCotEvents(events, publisher, { detail: 'brief' });

      const publishedText = client.events
        .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
        .map((event) => JSON.parse(event.content).delta)
        .join('');
      const started = client.events
        .filter((event) => event.event_type === 'STEP_STARTED')
        .map((event) => JSON.parse(event.content));
      const finished = client.events
        .filter((event) => event.event_type === 'STEP_FINISHED')
        .map((event) => JSON.parse(event.content));

      expect(publishedText).toContain('先前的真实过程进度。');
      expect(publishedText).not.toContain(finalAnswer.slice(0, 20));
      expect(finished.map((step) => step.stepId)).toEqual(started.map((step) => step.stepId));
      expect(client.completed).toEqual(['done']);
    }
  });

  it('flushes and closes buffered process text when the Claude event stream throws', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-claude-stream-error',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield* translateEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '在终态前已经产生的过程文本。' }] },
      });
      throw new Error('stream stopped');
    })();

    await consumeCotEvents(events, publisher, { detail: 'brief' });

    const eventTypes = client.events.map((event) => event.event_type);
    const started = client.events
      .filter((event) => event.event_type === 'STEP_STARTED')
      .map((event) => JSON.parse(event.content));
    const finished = client.events
      .filter((event) => event.event_type === 'STEP_FINISHED')
      .map((event) => JSON.parse(event.content));
    const text = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => JSON.parse(event.content).delta)
      .join('');

    expect(text).toBe('在终态前已经产生的过程文本。');
    expect(eventTypes).toContain('TEXT_MESSAGE_START');
    expect(eventTypes).toContain('TEXT_MESSAGE_END');
    expect(finished.map((step) => step.stepId)).toEqual(started.map((step) => step.stepId));
    expect(client.completed).toEqual(['error']);
  });

  it('preserves the Agent error message and terminal reason while tools are hidden', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-hidden-tool-error',
      scope: 'oc_chat',
      inputPreview: 'run',
      showTools: () => false,
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-secret', name: 'Bash', input: { command: 'private command' } },
      {
        type: 'error',
        message: 'Agent run timed out while waiting for a response',
        terminationReason: 'timeout',
      },
    ]), publisher, { detail: 'brief', showTools: () => false });

    const started = client.events
      .filter((event) => event.event_type === 'STEP_STARTED')
      .map((event) => JSON.parse(event.content));
    const finished = client.events
      .filter((event) => event.event_type === 'STEP_FINISHED')
      .map((event) => JSON.parse(event.content));
    const error = client.events.find((event) => event.event_type === 'RUN_ERROR');
    expect(finished.map((step) => step.stepId)).toEqual(started.map((step) => step.stepId));
    expect(JSON.parse(error?.content ?? '{}')).toMatchObject({
      code: 'timeout',
      message: 'Agent run timed out while waiting for a response',
    });
    expect(client.events.map((event) => event.event_type)).not.toContain('TOOL_CALL_START');
    expect(client.events.some((event) => event.event_type === 'RUN_FINISHED')).toBe(false);
    expect(client.completed).toEqual(['error']);
  });

  it('closes stages for interruption, timeout, and stream EOF', async () => {
    const scenarios: Array<{
      runId: string;
      events: AgentEvent[];
      finishedStatus?: string;
      completedReason: string;
    }> = [
      {
        runId: 'run-interrupted-stage',
        events: [
          { type: 'tool_use', id: 'tool-hidden', name: 'Bash', input: { command: 'private command' } },
          { type: 'done', terminationReason: 'interrupted' },
        ],
        finishedStatus: 'interrupted',
        completedReason: 'error',
      },
      {
        runId: 'run-timeout-stage',
        events: [
          { type: 'tool_use', id: 'tool-hidden', name: 'Bash', input: { command: 'private command' } },
          { type: 'done', terminationReason: 'timeout' },
        ],
        finishedStatus: 'timeout',
        completedReason: 'error',
      },
      {
        runId: 'run-ended-without-terminal',
        events: [
          { type: 'tool_use', id: 'tool-hidden', name: 'Bash', input: { command: 'private command' } },
        ],
        completedReason: 'done',
      },
    ];

    for (const scenario of scenarios) {
      const client = new FakeCotClient();
      const publisher = new CotPublisher({
        client,
        chatId: 'oc_chat',
        originMessageId: 'om_origin',
        runId: scenario.runId,
        scope: 'oc_chat',
        inputPreview: 'run',
        showTools: () => false,
      });
      await publisher.start();
      await consumeCotEvents(iterate(scenario.events), publisher, {
        detail: 'brief',
        showTools: () => false,
      });

      const started = client.events
        .filter((event) => event.event_type === 'STEP_STARTED')
        .map((event) => JSON.parse(event.content));
      const finished = client.events
        .filter((event) => event.event_type === 'STEP_FINISHED')
        .map((event) => JSON.parse(event.content));
      expect(finished.map((step) => step.stepId)).toEqual(started.map((step) => step.stepId));
      expect(JSON.stringify(client.events)).not.toMatch(/Bash|private command/);
      if (scenario.finishedStatus) {
        const finishedRun = client.events.find((event) => event.event_type === 'RUN_FINISHED');
        expect(JSON.parse(finishedRun?.content ?? '{}').status).toBe(scenario.finishedStatus);
        expect(client.completed).toEqual([scenario.completedReason]);
      } else {
        expect(client.events.some((event) => event.event_type === 'RUN_FINISHED')).toBe(false);
        expect(client.events.some((event) => event.event_type === 'RUN_ERROR')).toBe(false);
        expect(client.completed).toEqual([scenario.completedReason]);
      }
    }
  });

  it('applies tool visibility changes to the next CoT tool event', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-hot-tool-visibility',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();
    const visibility = { showTools: false };
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'tool_use', id: 'tool-hidden', name: 'Bash', input: { command: 'hidden command' } };
      visibility.showTools = true;
      yield { type: 'tool_result', id: 'tool-hidden', output: 'hidden output', isError: false };
      yield { type: 'tool_use', id: 'tool-visible', name: 'Read', input: { file_path: 'visible.ts' } };
      yield { type: 'tool_result', id: 'tool-visible', output: 'visible output', isError: false };
      yield { type: 'done', terminationReason: 'normal' };
    })();

    await consumeCotEvents(events, publisher, {
      detail: 'detailed',
      showTools: () => visibility.showTools,
    });

    const payload = JSON.stringify(client.events);
    expect(payload).toContain('Read');
    expect(payload).toContain('visible.ts');
    expect(payload).toContain('visible output');
    expect(payload).not.toMatch(/Bash|hidden command|hidden output/);
    expect(client.events.some((event) =>
      event.event_type === 'TOOL_CALL_RESULT' &&
      JSON.parse(event.content).toolCallId === 'tool-hidden',
    )).toBe(false);
  });

  it('drops queued tool details when hiding them before the CoT update is sent', async () => {
    const client = new FakeCotClient();
    const visibility = { showTools: true };
    const showTools = () => visibility.showTools;
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-hidden-before-flush',
      scope: 'oc_chat',
      inputPreview: 'run',
      showTools,
    });
    await publisher.start();
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'tool_use', id: 'tool-pending', name: 'Bash', input: { command: 'queued secret' } };
      visibility.showTools = false;
      yield { type: 'done', terminationReason: 'normal' };
    })();

    await consumeCotEvents(events, publisher, { detail: 'detailed', showTools });

    expect(client.events.filter((event) => event.event_type.startsWith('TOOL_CALL_'))).toEqual([]);
    expect(JSON.stringify(client.events)).not.toMatch(/Bash|queued secret/);
    expect(client.completed).toEqual(['done']);
  });

  it('does not publish a result for a tool start dropped at the update boundary', async () => {
    const client = new FakeCotClient();
    const visibility = { showTools: true };
    const showTools = () => visibility.showTools;
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-dropped-tool-start',
      scope: 'oc_chat',
      inputPreview: 'run',
      showTools,
    });
    await publisher.start();
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'tool_use', id: 'tool-dropped', name: 'Bash', input: { command: 'queued command' } };
      visibility.showTools = false;
      await new Promise((resolve) => setTimeout(resolve, 750));
      visibility.showTools = true;
      yield { type: 'tool_result', id: 'tool-dropped', output: 'late result', isError: false };
      yield { type: 'done', terminationReason: 'normal' };
    })();

    await consumeCotEvents(events, publisher, { detail: 'brief', showTools });

    const toolEvents = client.events.filter((event) => event.event_type.startsWith('TOOL_CALL_'));
    expect(toolEvents).toEqual([]);
    expect(JSON.stringify(client.events)).not.toMatch(/Bash|queued command|late result/);
    expect(client.completed).toEqual(['done']);
  });

  it('derives final answer state from text blocks only', () => {
    const state: RunState = {
      blocks: [
        { kind: 'tool', tool: { id: 'tool', name: 'command_execution', input: {}, status: 'done' } },
        { kind: 'text', content: 'final', streaming: false },
      ],
      reasoning: { content: 'hidden', active: true },
      footer: 'streaming',
      terminal: 'done',
    };

    expect(finalAnswerOnlyState(state)).toMatchObject({
      blocks: [{ kind: 'text', content: 'final' }],
      reasoning: { content: '', active: false },
      footer: null,
    });
  });

  it('uses the legacy tool header format for brief COT titles', () => {
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('✅ command_execution');
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('echo hello');
  });

  it('creates the CoT bubble once, addressed to the origin message in a topic', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      // In a topic the trigger message is itself in-topic, so the bubble
      // inherits its thread. No thread_id is passed — message_cot rejects it.
      originMessageId: 'om_in_topic',
      runId: 'run-topic',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    // Exactly one create — never a second (that would render a duplicate).
    expect(client.createCalls).toEqual([
      { chatId: 'oc_chat', originMessageId: 'om_in_topic' },
    ]);
    expect(publisher.disabled).toBe(false);
  });

  it('disables the publisher when the create is rejected and never retries', async () => {
    const client = new FakeCotClient();
    client.failCreate = new Error('COT API failed: code=10002 msg=Bot/User can NOT be out of the chat.');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-rejected',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('disables the publisher when the create returns unusable ids and never retries', async () => {
    const client = new FakeCotClient();
    // code=0 response missing cot_id/message_id: the bubble may exist
    // server-side, so a second create would render a duplicate.
    client.createResult = { unexpected: 'shape' };
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-missing-ids',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('addresses CoT create to the chat with the origin message id', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    // Intercept the HTTP layer so we assert only how create() shapes the request.
    (client as unknown as { request: CotClient['request'] }).request = async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return { cot_id: 'cot_x', message_id: 'om_x' };
    };

    await client.create('oc_chat', 'om_origin');
    expect(calls[0]?.path).toContain('receive_id_type=chat_id');
    // thread_id is never a valid receive type for message_cot.
    expect(calls[0]?.path).not.toContain('thread_id');
    expect(calls[0]?.body).toMatchObject({ receive_id: 'oc_chat', origin_message_id: 'om_origin' });
  });

  it('marks the publisher degraded when COT updates fail', async () => {
    const client = new FakeCotClient();
    client.failUpdate = new Error('field validation failed');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-degraded',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'working' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toBe('field validation failed');
    expect(client.completed).toEqual([]);
  });
});

class FakeCotClient {
  events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  completed: string[] = [];
  createCalls: Array<{ chatId: string; originMessageId?: string }> = [];
  failUpdate: Error | undefined;
  failCreate: Error | undefined;
  createResult: Record<string, unknown> | undefined;

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    this.createCalls.push({ chatId, originMessageId });
    if (this.failCreate) throw this.failCreate;
    return this.createResult ?? { cot_id: 'cot_fake', message_id: 'om_cot_fake' };
  }

  async update(_ref: unknown, events: readonly { event_type: string; content: string; timestamp: number }[]): Promise<void> {
    if (this.failUpdate) throw this.failUpdate;
    this.events.push(...events);
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    this.completed.push(reason);
  }
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}
