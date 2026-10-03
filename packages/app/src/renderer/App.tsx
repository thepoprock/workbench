import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { HubInfo, Project, TermSession } from '@workbench/shared';
import { hub } from './hub.ts';
import { openTerminal, Workspace } from './Workspace.tsx';

function useHubStatus() {
  return useSyncExternalStore(
    (cb) => hub.onStatus(cb),
    () => hub.status,
  );
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

export function App() {
  const status = useHubStatus();
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sessions, setSessions] = useState<TermSession[]>([]);
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const current = projects.find((p) => p.id === selected) ?? null;

  const refresh = useCallback(async () => {
    try {
      setInfo(await hub.call('hub.info', {}));
      setProjects(await hub.call('project.list', {}));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  // Sessions for the selected project: load, then follow term.update pushes.
  useEffect(() => {
    if (!current || status !== 'connected') return setSessions([]);
    let cancelled = false;
    hub.call('term.list', { projectId: current.id }).then(
      (list) => !cancelled && setSessions(list),
      (err) => setError((err as Error).message),
    );
    const off = hub.onPush((p) => {
      if (p.event !== 'term.update' || p.data.projectId !== current.id) return;
      const s = p.data;
      setSessions((prev) => (prev.some((x) => x.id === s.id) ? prev.map((x) => (x.id === s.id ? s : x)) : [...prev, s]));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [current?.id, status]);

  const newTerminal = useCallback(async () => {
    if (!current || !dock) return;
    try {
      const s = await hub.call('term.create', { projectId: current.id, cols: 80, rows: 24 });
      setSessions((prev) => [...prev, s]);
      openTerminal(dock, s.id, s.title);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [current, dock]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key === 't') {
        e.preventDefault();
        void newTerminal();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [newTerminal]);

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

  const running = sessions.filter((s) => s.status === 'running');
  const ended = sessions.filter((s) => s.status !== 'running');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="titlebar-spacer" />
        <div className="section-label">Projects</div>
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id}>
              <button className={p.id === selected ? 'active' : ''} onClick={() => setSelected(p.id)} title={p.rootPath ?? ''}>
                {p.name}
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="empty">No projects yet</li>}
        </ul>
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
                    <span className="dot connected" /> {s.title}
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
              {sessions.length === 0 && <li className="empty">None</li>}
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
          {current?.rootPath && <span className="muted"> — {current.rootPath}</span>}
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
