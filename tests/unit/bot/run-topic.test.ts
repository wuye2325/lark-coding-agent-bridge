import { describe, expect, it } from 'vitest';
import { extractRunTopic } from '../../../src/bot/run-topic.js';

describe('任务主题提取', () => {
  it('跳过纯 @ 与附件消息，清洗下一条有正文的消息且不拼接后续批次', () => {
    expect(extractRunTopic([
      {
        content: "@_user_1 <file key='file-a'>",
        mentions: [{ key: '@_user_1', name: 'Bridge' }],
        resources: [{ fileKey: 'file-a' }],
      },
      {
        content: '  ，。\r\n审查   XX 合同付款条款！  ',
        mentions: [],
        resources: [],
      },
      {
        content: '这条合并消息不能追加到标题',
        mentions: [],
        resources: [],
      },
    ])).toBe('审查 XX 合同付款条款');
  });

  it('先脱敏再按 Unicode 码点截断，避免邮箱被切成未识别的 @ 片段', () => {
    expect(extractRunTopic([{
      content: `${'前'.repeat(16)}foo@example.com`,
      mentions: [],
      resources: [],
    }])).toBe(`${'前'.repeat(16)}foo[at]…`);
    const emojiTopic = extractRunTopic([{ content: `${'😀'.repeat(24)}尾`, mentions: [], resources: [] }]);
    expect(emojiTopic).toBe(`${'😀'.repeat(23)}…`);
    expect(Array.from(emojiTopic ?? '')).toHaveLength(24);
  });

  it('有正文时保留结构化的人类 @ 对象，纯 @ 消息才跳过', () => {
    expect(extractRunTopic([
      { content: '@_user_1', mentions: [{ key: '@_user_1', name: 'Alice' }], resources: [] },
      { content: '请 @Alice 复核合同', mentions: [{ key: '@_user_2', name: 'Alice' }], resources: [] },
    ])).toBe('请 @Alice 复核合同');
    expect(extractRunTopic([{
      content: 'x@y.com @Alice 复核',
      mentions: [{ key: '@_user_3', name: 'Alice' }],
      resources: [],
    }])).toBe('x[at]y.com @Alice 复核');
  });
});
