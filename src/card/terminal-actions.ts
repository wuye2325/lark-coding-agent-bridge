import { hasSharedBridgeInternalTag } from './bridge-internal-markers';

export interface TerminalAction {
  label: string;
  prompt: string;
}

export interface TerminalActionDeclaration {
  actions: TerminalAction[];
}

const ACTION_ONLY_INTERNAL_MARKERS = /\b__bridge_[a-z0-9_]+\b|\bbridge_token\b/i;

export function validateTerminalAction(value: unknown): TerminalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('动作数据格式无效');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.label !== 'string' || !input.label.trim()) {
    throw new Error('动作名称不能为空');
  }
  const label = input.label.trim();
  if (Array.from(label).length > 12) throw new Error('动作名称不得超过 12 个字符');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    throw new Error('动作 prompt 不能为空');
  }
  const prompt = input.prompt.trim();
  if (Array.from(prompt).length > 500) throw new Error('动作 prompt 不得超过 500 个字符');
  if (hasSharedBridgeInternalTag(prompt) || ACTION_ONLY_INTERNAL_MARKERS.test(prompt)) {
    throw new Error('动作 prompt 不得包含 Bridge 内部标记');
  }
  return { label, prompt };
}

export function terminalActionElements(
  declaration: TerminalActionDeclaration | undefined,
  signTerminalAction: ((prompt: string) => string) | undefined,
): object[] {
  if (!declaration || declaration.actions.length === 0 || !signTerminalAction) return [];

  const seenLabels = new Set<string>();
  const actions = declaration.actions.flatMap((untrusted) => {
    let action: TerminalAction;
    try {
      action = validateTerminalAction(untrusted);
    } catch {
      return [];
    }
    if (seenLabels.has(action.label)) return [];
    seenLabels.add(action.label);
    return [action];
  }).slice(0, 3);
  if (actions.length === 0) return [];

  return [
    {
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: actions.map(({ label, prompt }) => ({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: label },
          type: 'default',
          behaviors: [{
            type: 'callback',
            value: {
              cmd: 'prompt.custom',
              terminal_action_token: signTerminalAction(prompt),
            },
          }],
        }],
      })),
    },
    { tag: 'markdown', content: '💡 快捷按钮将在当前会话与工作区继续执行', text_size: 'notation' },
  ];
}
