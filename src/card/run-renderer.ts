import { deepMaskEmails, maskEmails } from './mask-email';
import { terminalActionElements } from './terminal-actions';
import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;
const CARD_BUDGET_BYTES = 14_000;
const WRITTEN_FILES_BUDGET_BYTES = 2_500;
const WRITTEN_FILE_PATH_MAX = 80;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  agentName?: string;
  workspaceName?: string;
  durationMs?: number;
  toolStats?: RunToolStats;
  writtenFiles?: string[];
  firstToolError?: ToolEntry;
  showToolDetails?: boolean;
}

export interface RunToolStats {
  total: number;
  succeeded: number;
  errors: number;
  unfinished?: number;
}

interface MarkdownElement {
  tag: 'markdown';
  content: string;
  text_size?: string;
}

interface CardBudgetRefs {
  elements: object[];
  toolElements: object[];
  toolCount: number;
  textElements: Array<{ element: MarkdownElement; content: string }>;
  answerElement?: MarkdownElement;
  reasoningElement?: object;
  writtenFilesElement?: object;
  writtenFiles?: string[];
  agentErrorElement?: MarkdownElement;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];
  const toolElements: object[] = [];
  const textElements: Array<{ element: MarkdownElement; content: string }> = [];
  let reasoningElement: object | undefined;
  let writtenFilesElement: object | undefined;
  let agentErrorElement: MarkdownElement | undefined;
  let toolCount = 0;
  const showRunMetadata =
    options.agentName !== undefined ||
    options.workspaceName !== undefined ||
    options.durationMs !== undefined ||
    options.toolStats !== undefined;

  if (options.toolStats) elements.push(noteMd(toolStatsText(options.toolStats)));
  const resultContentStart = elements.length;

  if (state.reasoning.content) {
    reasoningElement = reasoningPanel(state.reasoning.content, state.reasoning.active);
    elements.push(reasoningElement);
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        const element = markdown(group.content);
        textElements.push({ element, content: group.content });
        elements.push(element);
      }
    } else {
      const rendered = renderToolGroup(group.tools, state.terminal !== 'running');
      toolElements.push(...rendered);
      elements.push(...rendered);
      toolCount += group.tools.length;
    }
  }

  const writtenFiles = options.writtenFiles ?? writtenFilesFromState(state);
  if (writtenFiles.length > 0) {
    writtenFilesElement = writtenFilesPanel(writtenFiles);
    elements.push(writtenFilesElement);
  }

  const errorCount = options.toolStats?.errors ?? toolErrorsFromState(state).length;
  const showToolDetails = options.showToolDetails !== false;
  const firstToolError = showToolDetails
    ? options.firstToolError ?? firstToolErrorFromState(state)
    : undefined;
  if (state.terminal !== 'running' && errorCount > 0) {
    elements.push(noteMd(toolErrorWarning(errorCount, firstToolError !== undefined)));
    if (firstToolError) elements.push(toolErrorPanel(firstToolError));
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    agentErrorElement = noteMd(`⚠️ agent 失败：${state.errorMsg}`);
    elements.push(agentErrorElement);
  } else if (state.terminal === 'done' && elements.length === resultContentStart) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton(options));
  } else {
    elements.push(...terminalActionElements());
  }

  // Mask raw emails across every text field so the Feishu tenant audit doesn't
  // reject the (streamed) card with a 400 EMAIL_ADDRESS — see mask-email.ts.
  const card = {
    schema: '2.0',
    ...(showRunMetadata ? { header: runHeader(state, options) } : {}),
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
  const answerElement = findAnswerElement(textElements, state.finalText);
  return fitCardPayload(card, {
    elements,
    toolElements,
    toolCount,
    textElements,
    answerElement,
    ...(reasoningElement ? { reasoningElement } : {}),
    ...(writtenFilesElement && writtenFiles.length > 0 ? { writtenFilesElement, writtenFiles } : {}),
    ...(agentErrorElement ? { agentErrorElement } : {}),
  });
}

export function writtenFilesFromState(state: RunState): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const block of state.blocks) {
    if (block.kind !== 'tool' || block.tool.status !== 'done') continue;
    if (block.tool.name !== 'Edit' && block.tool.name !== 'Write' && block.tool.name !== 'NotebookEdit') {
      continue;
    }
    if (!block.tool.input || typeof block.tool.input !== 'object') continue;
    const input = block.tool.input as { file_path?: unknown; notebook_path?: unknown };
    const targetPaths = block.tool.name === 'NotebookEdit'
      ? [input.notebook_path, input.file_path]
      : [input.file_path, input.notebook_path];
    const path = targetPaths.find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

export function firstToolErrorFromState(state: RunState): ToolEntry | undefined {
  return toolErrorsFromState(state)[0];
}

function toolErrorsFromState(state: RunState): ToolEntry[] {
  return state.blocks.flatMap((block) =>
    block.kind === 'tool' && block.tool.status === 'error' ? [block.tool] : [],
  );
}

function findAnswerElement(
  textElements: Array<{ element: MarkdownElement; content: string }>,
  finalText?: string,
): MarkdownElement | undefined {
  const finalAnswer = finalText?.trim();
  const match = finalAnswer
    ? [...textElements].reverse().find(({ content }) => content.includes(finalAnswer))
    : undefined;
  return match?.element ?? textElements.at(-1)?.element;
}

function fitCardPayload<T extends { body: { elements: object[] }; header?: unknown }>(
  card: T,
  refs: CardBudgetRefs,
): T {
  const measure = (): { masked: T; bytes: number } => {
    const masked = deepMaskEmails(card);
    return { masked, bytes: cardByteLength(masked) };
  };
  let current = measure();
  if (current.bytes < CARD_BUDGET_BYTES) return current.masked;

  if (refs.reasoningElement) {
    replaceElements(
      refs.elements,
      [refs.reasoningElement],
      noteMd('⚠️ 载荷预算有限，已省略 1 段思考内容。'),
    );
    current = measure();
  }

  if (current.bytes >= CARD_BUDGET_BYTES && refs.toolElements.length > 0) {
    replaceElements(
      refs.elements,
      refs.toolElements,
      noteMd(`⚠️ 工具摘要超出载荷预算，已省略 ${refs.toolCount} 项工具调用。`),
    );
    current = measure();
  }

  if (
    current.bytes >= CARD_BUDGET_BYTES &&
    refs.writtenFilesElement &&
    refs.writtenFiles &&
    refs.writtenFiles.length > 0
  ) {
    const compacted = compactWrittenFilesPanel(refs.writtenFiles);
    replaceElements(refs.elements, [refs.writtenFilesElement], compacted);
    current = measure();
  }

  const processTexts = refs.textElements.filter(({ element }) => element !== refs.answerElement);
  if (current.bytes >= CARD_BUDGET_BYTES && processTexts.length > 0) {
    replaceElements(
      refs.elements,
      processTexts.map(({ element }) => element),
      noteMd(`⚠️ 载荷预算有限，已省略 ${processTexts.length} 段过程文本。`),
    );
    current = measure();
  }

  if (current.bytes >= CARD_BUDGET_BYTES && refs.answerElement) {
    fitMarkdownContent(card, refs.answerElement, refs.answerElement.content, '正文');
    current = measure();
  }

  if (current.bytes >= CARD_BUDGET_BYTES && refs.agentErrorElement) {
    fitMarkdownContent(card, refs.agentErrorElement, refs.agentErrorElement.content, 'Agent 错误');
    current = measure();
  }

  if (current.bytes >= CARD_BUDGET_BYTES) {
    compactHeader(card);
    current = measure();
  }

  return current.masked;
}

function cardByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function replaceElements(elements: object[], removed: object[], replacement: object): void {
  const removedSet = new Set(removed);
  const firstIndex = elements.findIndex((element) => removedSet.has(element));
  if (firstIndex < 0) return;
  const retained = elements.filter((element) => !removedSet.has(element));
  retained.splice(Math.min(firstIndex, retained.length), 0, replacement);
  elements.splice(0, elements.length, ...retained);
}

function compactWrittenFilesPanel(files: string[]): object {
  let low = 0;
  let high = files.length;
  let visibleCount = 0;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const panel = writtenFilesPanel(files, candidate, WRITTEN_FILE_PATH_MAX);
    const bytes = cardByteLength(deepMaskEmails(panel));
    if (bytes <= WRITTEN_FILES_BUDGET_BYTES) {
      visibleCount = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return writtenFilesPanel(files, visibleCount, WRITTEN_FILE_PATH_MAX);
}

function fitMarkdownContent<T extends { body: { elements: object[] }; header?: unknown }>(
  card: T,
  element: MarkdownElement,
  original: string,
  label: string,
): void {
  const characters = Array.from(original);
  let low = 0;
  let high = characters.length;
  let best = -1;
  while (low <= high) {
    const visibleCount = Math.floor((low + high) / 2);
    element.content = truncatedText(characters, visibleCount, label);
    if (cardByteLength(deepMaskEmails(card)) < CARD_BUDGET_BYTES) {
      best = visibleCount;
      low = visibleCount + 1;
    } else {
      high = visibleCount - 1;
    }
  }
  element.content = truncatedText(characters, Math.max(0, best), label);
}

function truncatedText(characters: string[], visibleCount: number, label: string): string {
  const omitted = characters.length - visibleCount;
  if (omitted <= 0) return characters.join('');
  const prefix = characters.slice(0, visibleCount).join('');
  const omissionNotice = `⚠️ ${label}因载荷预算截断，另有 ${omitted} 个字符未显示。`;
  return `${prefix}${prefix ? '\n\n' : ''}${omissionNotice}`;
}

function compactHeader<T extends { header?: unknown }>(card: T): void {
  const header = card.header as {
    title?: { content?: string };
    subtitle?: { content?: string };
  } | undefined;
  if (!header) return;
  if (header.title?.content && Array.from(header.title.content).length > 80) {
    header.title.content = truncateCodePoints(header.title.content, 80);
  }
  if (header.subtitle?.content && Array.from(header.subtitle.content).length > 160) {
    header.subtitle.content = truncateCodePoints(header.subtitle.content, 160);
  }
}

function runHeader(state: RunState, options: RunCardRenderOptions): object {
  const stats = options.toolStats;
  const status = runStatus(state, stats);
  const subtitle =
    state.terminal === 'running'
      ? [options.workspaceName ? `📁 ${options.workspaceName}` : '', runningStage(state)]
          .filter(Boolean)
          .join(' · ')
      : [
          options.workspaceName ? `📁 ${options.workspaceName}` : '',
          options.durationMs !== undefined
            ? `⏱ 处理时长 ${formatDuration(options.durationMs)}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ');

  return {
    template: status.template,
    title: { tag: 'plain_text', content: options.agentName ?? '🤖 Agent' },
    ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
    text_tag_list: [
      {
        tag: 'text_tag',
        text: { tag: 'plain_text', content: status.label },
        color: status.color,
      },
    ],
  };
}

function runStatus(
  state: RunState,
  stats?: RunToolStats,
): { label: string; color: string; template: string } {
  if (state.terminal === 'interrupted') {
    return { label: '已中断', color: 'neutral', template: 'grey' };
  }
  if (state.terminal === 'idle_timeout') {
    return { label: '已超时', color: 'orange', template: 'orange' };
  }
  if (state.terminal === 'error') {
    return { label: '运行失败', color: 'red', template: 'red' };
  }
  if (state.terminal === 'done' && stats && stats.errors > 0) {
    return {
      label: `已完成 · ${stats.errors} 次工具错误`,
      color: 'orange',
      template: 'orange',
    };
  }
  if (state.terminal === 'done') return { label: '已完成', color: 'green', template: 'green' };
  return { label: '运行中', color: 'wathet', template: 'wathet' };
}

function runningStage(state: RunState): string {
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '正在思考';
}

function toolStatsText(stats: RunToolStats): string {
  const counts = `🧰 工具调用：${stats.total} 次 · 成功 ${stats.succeeded} · 错误 ${stats.errors}`;
  return stats.unfinished === undefined ? counts : `${counts} · 未完成 ${stats.unfinished}`;
}

function writtenFilesPanel(
  files: string[],
  visibleCount = files.length,
  maxPathCharacters = Number.POSITIVE_INFINITY,
): object {
  const visibleFiles = files.slice(0, visibleCount);
  const truncatedPaths = visibleFiles.filter(
    (file) => Array.from(file).length > maxPathCharacters,
  ).length;
  const lines = visibleFiles.map((file) => `- ${truncateCodePoints(file, maxPathCharacters)}`);
  if (visibleFiles.length < files.length) {
    lines.push(`⚠️ 另有 ${files.length - visibleFiles.length} 个文件未显示。`);
  }
  if (truncatedPaths > 0) lines.push(`⚠️ ${truncatedPaths} 条路径因载荷限制已截断。`);
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(`📝 写入文件清单（${files.length} 个文件）`),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: lines.join('\n'), text_size: 'notation' }],
  };
}

function toolErrorWarning(count: number, detailsVisible: boolean): string {
  return detailsVisible
    ? `⚠️ 本轮记录到 ${count} 次工具错误。首个错误详情如下，其余错误已收拢。`
    : `⚠️ 本轮记录到 ${count} 次工具错误，已按设置隐藏工具详情。`;
}

function toolErrorPanel(tool: ToolEntry): object {
  // 先脱敏再截断，避免 @→[at] 扩长后突破 500 字符上限。
  const output = truncateErrorOutput(maskEmails(tool.output ?? '未返回错误内容'));
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded: true,
    border: 'red',
    body: `**错误输出**\n\`\`\`\n${output}\n\`\`\``,
  });
}

function truncateErrorOutput(output: string): string {
  const characters = Array.from(output);
  return characters.length > 500 ? `${characters.slice(0, 499).join('')}…` : output;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
    : `${seconds} 秒`;
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false, finalized));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true, false));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean, finalized: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body:
      finalized && tool.status === 'error'
        ? '错误详情已收拢，首个工具错误见下方。'
        : toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): MarkdownElement {
  return { tag: 'markdown', content };
}

function noteMd(content: string): MarkdownElement {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function truncateCodePoints(s: string, max: number): string {
  const characters = Array.from(s);
  if (characters.length <= max) return s;
  if (max <= 1) return '…';
  const startCount = Math.ceil((max - 1) / 2);
  const endCount = Math.floor((max - 1) / 2);
  const prefix = characters.slice(0, startCount).join('');
  const suffix = endCount > 0 ? characters.slice(-endCount).join('') : '';
  return `${prefix}…${suffix}`;
}
