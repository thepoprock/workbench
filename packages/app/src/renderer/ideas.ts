import { useSyncExternalStore } from 'react';
import type { Idea } from '@workbench/shared';
import { hub } from './hub.ts';

// Renderer-wide ideas list, kept current by idea.update pushes.
let ideas: Idea[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export async function loadIdeas(): Promise<void> {
  ideas = await hub.call('idea.list', { includeArchived: true });
  emit();
}

export function putIdea(idea: Idea): void {
  ideas = ideas.some((i) => i.id === idea.id) ? ideas.map((i) => (i.id === idea.id ? idea : i)) : [idea, ...ideas];
  emit();
}

hub.onPush((p) => {
  if (p.event === 'idea.update') putIdea(p.data);
});

export function useIdeas(): Idea[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ideas,
  );
}
