import type { DockviewApi } from 'dockview-react';
import type { HistoryParams } from './HistoryPane.tsx';
import type { ProjectParams } from './ProjectPane.tsx';

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

// Swap a pane's session for its successor in the same place (moving a
// conversation to another account). Closing via the API only detaches.
export function replaceTerminal(api: DockviewApi, oldId: string, sessionId: string, title: string): void {
  const old = api.getPanel(oldId);
  if (!old) return openTerminal(api, sessionId, title);
  if (api.getPanel(sessionId)) {
    old.api.close();
    return api.getPanel(sessionId)!.api.setActive();
  }
  api.addPanel({
    id: sessionId,
    component: 'terminal',
    tabComponent: 'terminal',
    title,
    params: { sessionId },
    position: { referencePanel: oldId, direction: 'within' },
  });
  old.api.close();
}

export function openClaudeFiles(api: DockviewApi, projectId: string): void {
  const existing = api.getPanel('claude-files');
  if (existing) return existing.api.setActive();
  api.addPanel({ id: 'claude-files', component: 'claude', tabComponent: 'plain', title: 'Claude files', params: { projectId } });
}

// One Remote pane per project; reopening points it at a new URL.
export function openRemote(api: DockviewApi, url = 'https://claude.ai/code'): void {
  const existing = api.getPanel('remote');
  if (existing) {
    existing.api.updateParameters({ url });
    return existing.api.setActive();
  }
  api.addPanel({ id: 'remote', component: 'remote', tabComponent: 'plain', title: 'Remote', params: { url } });
}

export function openRecordings(api: DockviewApi, projectId: string): void {
  const existing = api.getPanel('recordings');
  if (existing) {
    existing.api.updateParameters({ projectId });
    return existing.api.setActive();
  }
  api.addPanel({ id: 'recordings', component: 'recordings', tabComponent: 'plain', title: 'Recordings', params: { projectId } });
}

export function openJobMail(api: DockviewApi): void {
  const existing = api.getPanel('jobmail');
  if (existing) return existing.api.setActive();
  api.addPanel({ id: 'jobmail', component: 'jobmail', tabComponent: 'plain', title: 'Job inbox', params: {} });
}

// One Project pane per project (info, history, search); reopening can switch its view.
export function openProject(api: DockviewApi, projectId: string, view?: ProjectParams['view']): void {
  const existing = api.getPanel('project');
  if (existing) {
    existing.api.updateParameters({ projectId, view });
    return existing.api.setActive();
  }
  api.addPanel({ id: 'project', component: 'project', tabComponent: 'plain', title: 'Project', params: { projectId, view } });
}
