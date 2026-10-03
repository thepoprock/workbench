import type { DockviewApi } from 'dockview-react';
import type { HistoryParams } from './HistoryPane.tsx';

export function openTerminal(api: DockviewApi, sessionId: string, title: string): void {
  const existing = api.getPanel(sessionId);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: sessionId,
    component: 'terminal',
    tabComponent: 'terminal',
    title,
    params: { sessionId },
  });
}

// One viewer per session; reopening retargets it (e.g. a different search hit).
export function openHistory(api: DockviewApi, params: HistoryParams): void {
  const id = `history:${params.sessionId}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.updateParameters(params);
    existing.api.setActive();
    return;
  }
  api.addPanel({ id, component: 'history', tabComponent: 'history', title: 'History', params });
}

export function openChangelog(api: DockviewApi, projectId: string): void {
  const existing = api.getPanel('changelog');
  if (existing) return existing.api.setActive();
  api.addPanel({ id: 'changelog', component: 'changelog', tabComponent: 'plain', title: 'Changelog', params: { projectId } });
}

export function openErrors(api: DockviewApi, projectId: string, errorId?: string): void {
  const existing = api.getPanel('errors');
  if (existing) {
    existing.api.updateParameters({ projectId, errorId });
    return existing.api.setActive();
  }
  api.addPanel({ id: 'errors', component: 'errors', tabComponent: 'plain', title: 'Errors', params: { projectId, errorId } });
}
