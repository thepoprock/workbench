import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { HubInfo, Project, TermSession } from '@workbench/shared';
import { Agents } from './Agents.tsx';
import { putSessions, statusClass, useProjectSessions } from './sessions.ts';
import { hub } from './hub.ts';
import { Projects } from './Projects.tsx';
import { openTerminal, Workspace } from './Workspace.tsx';

function useHubStatus() {
  return useSyncExternalStore(
    (cb) => hub.onStatus(cb),
    () => hub.status,
  );
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

// Per-viewer convenience only; storage may be unavailable.
const SELECTED_KEY = 'workbench.selectedProject';
const loadSelected = () => {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
};
const saveSelected = (id: string | null) => {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {}
};

export function App() {
  const status = useHubStatus();
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelectedState] = useState<string | null>(loadSelected);
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const setSelected = useCallback((id: string | null) => {
    setSelectedState(id);
    saveSelected(id);
  }, []);

  const current = projects.find((p) => p.id === selected && !p.archived) ?? null;

  const refresh = useCallback(async () => {
    try {
      setInfo(await hub.call('hub.info', {}));
      setProjects(await hub.call('project.list', { includeArchived: true }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  // Sessions for the selected project; the store follows term.update pushes.
  const sessions = useProjectSessions(current?.id ?? null);
  useEffect(() => {
    if (!current || status !== 'connected') return;
    hub.call('term.list', { projectId: current.id }).then(putSessions, (err) => setError((err as Error).message));
  }, [current?.id, status]);

  const newTerminal = useCallback(async () => {
    if (!current || !dock) return;
    try {
      const s = await hub.call('term.create', { projectId: current.id, cols: 80, rows: 24 });
      putSessions([s]);
      openTerminal(dock, s.id, s.title);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [current, dock]);

  // New Claude session, or resume one by its Claude session id.
  const startAgent = useCallback(
    async (resume?: string) => {
      if (!current || !dock) return;
      try {
        const s = await hub.call('agent.start', { projectId: current.id, resume, cols: 100, rows: 30 });
        putSessions([s]);
        openTerminal(dock, s.id, s.title);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [current, dock],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (!e.shiftKey && k === 't') {
        e.preventDefault();
        void newTerminal();
      } else if (e.shiftKey && k === 'a') {
        e.preventDefault();
        void startAgent();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [newTerminal, startAgent]);

  const create = async (rootPath?: string) => {
    const projectName = name.trim() || (rootPath ? basename(rootPath) : '');
    try {
      const p = await hub.call('project.create', { name: projectName, rootPath });
      setName('');
      setError(null);
      await refresh();
      setSelected(p.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void create();
  };

  const pickFolder = async () => {
    const dir = await window.workbench.pickFolder();
    if (dir) void create(dir);
  };

  const terminals = sessions.filter((s) => s.kind === 'terminal');
  const agents = sessions.filter((s) => s.kind === 'agent');
  const running = terminals.filter((s) => s.status === 'running');
  const ended = terminals.filter((s) => s.status !== 'running');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="titlebar-spacer" />
        <div className="section-label">Projects</div>
        <Projects
          projects={projects}
          selected={selected}
          onSelect={setSelected}
          onChanged={refresh}
          onError={setError}
        />
        <form className="new-project" onSubmit={onSubmit}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project…"
            disabled={status !== 'connected'}
          />
          <button type="button" onClick={() => void pickFolder()} disabled={status !== 'connected'} title="Add a project folder">
            📁
          </button>
        </form>

        {current && (
          <Agents
            project={current}
            sessions={agents}
            canOpen={!!dock && status === 'connected'}
            onOpen={(s) => dock && openTerminal(dock, s.id, s.title)}
            onStart={(resume) => void startAgent(resume)}
          />
        )}

        {current && (
          <>
            <div className="section-label with-action">
              Terminals
              <button onClick={() => void newTerminal()} title="New terminal (⌘T)" disabled={!dock}>
                +
              </button>
            </div>
            <ul className="list">
              {running.map((s) => (
                <li key={s.id}>
                  <button onClick={() => dock && openTerminal(dock, s.id, s.title)} title={s.cwd}>
                    <span className={`dot ${statusClass(s)}`} /> {s.title}
                  </button>
                </li>
              ))}
              {ended.map((s) => (
                <li key={s.id}>
                  <button className="ended" onClick={() => dock && openTerminal(dock, s.id, s.title)} title={s.cwd}>
                    <span className="dot ended" /> {s.title}
                  </button>
                </li>
              ))}
              {terminals.length === 0 && <li className="empty">None</li>}
            </ul>
          </>
        )}

        {error && (
          <div className="error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <div className="spacer" />
        <HubBadge status={status} info={info} />
      </aside>

      <main className="workspace">
        <div className="titlebar drag">
          <span className="titlebar-name">{current?.name ?? 'Workbench'}</span>
          {current?.rootPath && <span className="muted titlebar-path">— {current.rootPath}</span>}
        </div>
        {current ? (
          <Workspace key={current.id} project={current} onApi={setDock} />
        ) : (
          <div className="placeholder">
            <h1>Workbench</h1>
            <p>Create or select a project.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function HubBadge({ status, info }: { status: string; info: HubInfo | null }) {
  return (
    <div className="hub-badge" title={info ? `db: ${info.dbPath}` : (hub.lastError ?? '')}>
      <span className={`dot ${status}`} />
      <span>hub {status}</span>
      {info && status === 'connected' && (
        <span className="muted">
          {' '}
          · v{info.version} · schema {info.schemaVersion} · pid {info.pid}
        </span>
      )}
    </div>
  );
}
