import { maskEmails } from '../card/mask-email';

export interface RunTopicMessage {
  content: string;
  resources: readonly { fileKey: string }[];
  mentions?: readonly { key?: string; name?: string }[];
}

const DEFAULT_TOPIC_CODE_POINTS = 24;

export function extractRunTopic(messages: readonly RunTopicMessage[]): string | undefined {
  const fileKeys = messages.flatMap((message) => message.resources.map(({ fileKey }) => fileKey));
  for (const message of messages) {
    const withAttachmentsRemoved = stripAttachmentRefs(message.content, fileKeys);
    const withoutMentions = normalizeTopicText(stripMentionRefs(withAttachmentsRemoved, message.mentions));
    const text = normalizeTopicText(withoutMentions ? withAttachmentsRemoved : withoutMentions);
    if (!text) continue;
    const masked = maskEmails(text);
    const points = Array.from(masked);
    if (points.length <= DEFAULT_TOPIC_CODE_POINTS) return masked;
    return `${points.slice(0, DEFAULT_TOPIC_CODE_POINTS - 1).join('')}…`;
  }
  return undefined;
}

function normalizeTopicText(text: string): string {
  return text
    .replace(/\r\n?|\n/g, ' ')
    .trim()
    .replace(/^\p{P}+|\p{P}+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function stripAttachmentRefs(text: string, fileKeys: readonly string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function stripMentionRefs(text: string, mentions: RunTopicMessage['mentions']): string {
  let out = text;
  for (const mention of mentions ?? []) {
    if (mention.key) out = out.split(mention.key).join('');
    if (mention.name) {
      const token = `@${mention.name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(^|[\\s\\p{P}])${token}(?=$|[\\s\\p{P}])`, 'gu'), '$1');
    }
  }
  return out;
}
