import { describe, expect, it } from 'vitest';
import { TerminalActionAuth } from '../../../src/card/terminal-action-auth.js';

describe('终态快捷动作签名', () => {
  it('同一签名密钥重建后仍能验证动作，并恢复脱敏前的完整 prompt', () => {
    const prompt = '读取 /matter/client@example.com/合同.docx 并提取违约条款';
    const beforeRestart = new TerminalActionAuth({ secret: 'stable-app-secret' });
    const token = beforeRestart.sign({ chatId: 'oc_group', scope: 'oc_group:th_topic', prompt });
    const afterRestart = new TerminalActionAuth({ secret: 'stable-app-secret' });

    expect(token).not.toContain('客户@example.com');
    expect(token).not.toContain('client@example.com');
    expect(afterRestart.verify(token, { chatId: 'oc_group', scope: 'oc_group:th_topic' }))
      .toEqual({ ok: true, prompt });
    expect(afterRestart.verify(token, { chatId: 'oc_group', scope: 'oc_group:th_topic' }))
      .toEqual({ ok: true, prompt });
  });

  it('拒绝被修改的 prompt、chat、scope 与签名', () => {
    const auth = new TerminalActionAuth({ secret: 'stable-app-secret' });
    const token = auth.sign({ chatId: 'oc_group', scope: 'oc_group', prompt: '将对比结果保存到 /matter/result.md' });

    expect(auth.verify(token, {
      chatId: 'oc_other', scope: 'oc_group',
    })).toMatchObject({ ok: false });
    expect(auth.verify(token, {
      chatId: 'oc_group', scope: 'oc_group:th_topic',
    })).toMatchObject({ ok: false });
    expect(auth.verify(`${token.slice(0, -1)}x`, {
      chatId: 'oc_group', scope: 'oc_group',
    })).toMatchObject({ ok: false });
  });
});
