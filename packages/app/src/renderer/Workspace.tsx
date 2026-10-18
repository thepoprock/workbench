import { useEffect, useRef } from 'react';
import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import type { Project } from '@workbench/shared';
import { hub } from './hub.ts';
import { HistoryTab, Tab } from './Tab.tsx';
import { HistoryPane } from './HistoryPane.tsx';
import { ChangelogPane } from './ChangelogPane.tsx';
import { ErrorsPane } from './ErrorsPane.tsx';
import { RemotePane } from './RemotePane.tsx';
import { ClaudePane } from './ClaudePane.tsx';
import { bounded } from './Boundary.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { ProjectPane } from './ProjectPane.tsx';
import { RecordingsPane } from './RecordingsPane.tsx';

const components = {
  terminal: bounded('Terminal', TerminalPane),
  history: bounded('History', HistoryPane),
  changelog: bounded('Changelog', ChangelogPane),
  errors: bounded('Errors', ErrorsPane),
  remote: bounded('Remote', RemotePane),
  claude: bounded('Claude files', ClaudePane),
  project: bounded('Project', ProjectPane),
  recordings: bounded('Recordings', RecordingsPane),
};
const tabComponents = { terminal: Tab, history: HistoryTab, plain: HistoryTab };
const SAVE_DEBOUNCE_MS = 400;

type DockJSON = Parameters<DockviewApi['fromJSON']>[0];
type GridNode = { type: 'branch' | 'leaf'; data: unknown };

// A layout saved while the dock was being torn down can list panels that no
// group shows. Restored as-is, such a panel exists but is invisible, and
// opening it again only "activates" it. Drop them so they reopen normally.
function sanitize(saved: DockJSON): DockJSON {
  const shown = new Set<string>();
  const walk = (n: GridNode) => {
    if (n.type === 'leaf') {
      const d = n.data as { views: string[]; activeView?: string };
      d.views.forEach((v) => shown.add(v));
      if (d.activeView && !d.views.includes(d.activeView)) d.activeView = d.views[0];
    } else (n.data as GridNode[]).forEach(walk);
  };
  walk((saved as unknown as { grid: { root: GridNode } }).grid.root);
  const panels = (saved as unknown as { panels: Record<string, unknown> }).panels;
  for (const id of Object.keys(panels)) if (!shown.has(id)) delete panels[id];
  return saved;
}

function Empty() {
  return (
    <div className="placeholder">
      <p>No open terminals.</p>
      <p className="muted">⌘T opens one.</p>
    </div>
  );
}

// One dock per project; mounted with key={project.id}, so switching projects
// unmounts this one (terminals detach, keep running) and loads the next layout.
export function Workspace({
  project,
  onApi,
}: {
  project: Project;
  onApi: (api: DockviewApi | null, projectId: string) => void;
}) {
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dockview can be created twice (React StrictMode remounts in dev); only the
  // newest instance may be handed out — the other is already disposed.
  const readyGen = useRef(0);

  useEffect(() => () => onApi(null, project.id), [onApi, project.id]);
  // Tearing the dock down removes its panels and fires layout changes: none of
  // that may be saved (it would store an empty or half-empty layout).
  useEffect(
    () => () => {
      loaded.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const onReady = async ({ api }: DockviewReadyEvent) => {
    const gen = ++readyGen.current;
    try {
      const saved = await hub.call('layout.get', { projectId: project.id });
      if (gen !== readyGen.current) return;
      if (saved) api.fromJSON(sanitize(saved as DockJSON));
    } catch (err) {
      if (gen !== readyGen.current) return;
      console.error('layout restore failed', err);
      api.clear();
    }
    loaded.current = true;

    api.onDidLayoutChange(() => {
      if (!loaded.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (!loaded.current) return;
        void hub.call('layout.save', { projectId: project.id, dock: api.toJSON() }).catch(() => {});
      }, SAVE_DEBOUNCE_MS);
    });
    onApi(api, project.id);
  };

  return (
    <DockviewReact
      className="dock"
      theme={themeDark}
      components={components}
      tabComponents={tabComponents}
      defaultTabComponent={Tab}
      watermarkComponent={Empty}
      onReady={(e) => void onReady(e)}
    />
  );
}
