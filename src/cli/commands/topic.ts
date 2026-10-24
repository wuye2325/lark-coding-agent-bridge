import { activeRunContext } from './callback';

export async function runTopicSet(opts: { text: string }): Promise<void> {
  const { store, token } = activeRunContext();
  const topic = await store.setRunTopic(token, opts.text);
  process.stdout.write(`${JSON.stringify({ registered: true, topic })}\n`);
}
