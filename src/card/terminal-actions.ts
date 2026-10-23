const ACTIONS = [
  { label: '运行单测', command: 'prompt.test', type: 'primary' },
  { label: '查看 Diff', command: 'prompt.diff', type: 'default' },
  { label: '新会话', command: 'session.new', type: 'default' },
] as const;

export function terminalActionElements(): object[] {
  return [
    {
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: ACTIONS.map(({ label, command, type }) => ({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: label },
          type,
          behaviors: [{ type: 'callback', value: { cmd: command } }],
        }],
      })),
    },
    { tag: 'markdown', content: '💡 快捷按钮将在当前会话中执行', text_size: 'notation' },
  ];
}
