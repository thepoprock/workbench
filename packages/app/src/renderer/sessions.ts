import { useSyncExternalStore } from 'react';
import type { TermSession } from '@workbench/shared';
import { hub } from './hub.ts';

// Renderer-wide view of sessions, kept current by term.update pushes, so the
// sidebar and dock tabs (which live outside App's tree) agree.
const sessions = new Map<string, TermSession>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  for (const l of listeners) l();
};

export function putSessions(list: TermSession[]): void {
  for (const s of list) sessions.set(s.id, s);
  emit();
}

hub.onPush((p) => {
  if (p.event !== 'term.update') return;
  sessions.set(p.data.id, p.data);
  emit();
});

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useSession(id: string): TermSession | undefined {
  useSyncExternalStore(subscribe, () => version);
  return sessions.get(id);
}

export function useProjectSessions(projectId: string | null): TermSession[] {
  useSyncExternalStore(subscribe, () => version);
  if (!projectId) return [];
  return [...sessions.values()].filter((s) => s.projectId === projectId).sort((a, b) => a.startedAt - b.startedAt);
}

// Dot class for a session: agent state while running, else ended.
export function statusClass(s: TermSession | undefined): string {
  if (!s || s.status !== 'running') return 'ended';
  if (s.kind === 'agent' && s.agent) return `agent-${s.agent.state}`;
  return 'connected';
}
