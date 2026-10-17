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

const components = {
  terminal: bounded('Terminal', TerminalPane),
  history: bounded('History', HistoryPane),
  changelog: bounded('Changelog', ChangelogPane),
  errors: bounded('Errors', ErrorsPane),
  remote: bounded('Remote', RemotePane),
  claude: bounded('Claude files', ClaudePane),
  project: bounded('Project', ProjectPane),
};
const tabComponents = { terminal: Tab, history: HistoryTab, plain: HistoryTab };
const SAVE_DEBOUNCE_MS = 400;

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
export function Workspace({ project, onApi }: { project: Project; onApi: (api: DockviewApi | null) => void }) {
  const loaded = useRef(false);

  useEffect(() => () => onApi(null), [onApi]);

  const onReady = async ({ api }: DockviewReadyEvent) => {
    try {
      const saved = await hub.call('layout.get', { projectId: project.id });
      if (saved) api.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0]);
    } catch (err) {
      console.error('layout restore failed', err);
      api.clear();
    }
    loaded.current = true;

    let timer: ReturnType<typeof setTimeout> | null = null;
    api.onDidLayoutChange(() => {
      if (!loaded.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void hub.call('layout.save', { projectId: project.id, dock: api.toJSON() }).catch(() => {});
      }, SAVE_DEBOUNCE_MS);
    });
    onApi(api);
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
