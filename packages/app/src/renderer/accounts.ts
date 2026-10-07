import { useSyncExternalStore } from 'react';
import type { Harness } from '@workbench/shared';
import { hub } from './hub.ts';

// Claude accounts + which one new sessions bill to, kept current by pushes.
interface State {
  harnesses: Harness[];
  usage: string;
}
let state: State = { harnesses: [], usage: 'claude-code' };
const listeners = new Set<() => void>();

export async function loadAccounts(): Promise<void> {
  const [harnesses, usage] = await Promise.all([hub.call('harness.list', {}), hub.call('account.usage', {})]);
  state = { harnesses, usage: usage.harnessId };
  listeners.forEach((l) => l());
}

hub.onPush((p) => {
  if (p.event === 'account.update') void loadAccounts();
});

export function useAccounts(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// "Main" for the built-in login, else the name after "Claude Code · ".
export function accountLabel(h: Harness | undefined): string {
  if (!h || h.id === 'claude-code') return 'Main';
  return h.name.replace(/^Claude Code · /, '');
}
