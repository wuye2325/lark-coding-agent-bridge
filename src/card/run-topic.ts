import { hasSharedBridgeInternalTag } from './bridge-internal-markers';

const MAX_DECLARED_TOPIC_CODE_POINTS = 30;
const TOPIC_ONLY_INTERNAL_MARKERS = /<\s*\/?\s*(?:quoted_messages|forwarded_messages|interactive_cards|comment_context|user_input|topic_context)\b/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export function validateRunTopic(value: unknown): string {
  if (typeof value !== 'string') throw new Error('任务主题不能为空');
  if (CONTROL_CHARACTER.test(value)) throw new Error('任务主题不得包含控制字符');
  if (Array.from(value).length > MAX_DECLARED_TOPIC_CODE_POINTS) {
    throw new Error('任务主题不得超过 30 个码点');
  }
  if (!value.trim()) throw new Error('任务主题不能为空');
  const topic = value.trim();
  if (hasSharedBridgeInternalTag(topic) || TOPIC_ONLY_INTERNAL_MARKERS.test(topic)) {
    throw new Error('任务主题不得包含 Bridge 内部标记');
  }
  return topic;
}
