import { activeRunContext } from './callback';

export async function runActionAdd(opts: { label: string; prompt: string }): Promise<void> {
  const { store, token } = activeRunContext();
  const declaration = await store.addTerminalAction(token, opts);
  process.stdout.write(`${JSON.stringify({ registered: true, count: declaration.actions.length })}\n`);
}

export async function runActionNone(): Promise<void> {
  const { store, token } = activeRunContext();
  await store.declareNoTerminalActions(token);
  process.stdout.write(`${JSON.stringify({ declared: true, actions: [] })}\n`);
}
