import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { HubInfo, Idea, Project, SearchHit, TermSession } from '@workbench/shared';
import { IdeasList } from './IdeasList.tsx';
import { IdeaView } from './IdeaView.tsx';
import { loadIdeas, useIdeas } from './ideas.ts';
import { Agents } from './Agents.tsx';
import { HarnessManager } from './HarnessManager.tsx';
import { putSessions, statusClass, useProjectSessions } from './sessions.ts';
import { hub } from './hub.ts';
import { Projects } from './Projects.tsx';
import { openChangelog, openErrors, openHistory, openRemote, openTerminal } from './dock.ts';
import { Elsewhere } from './Elsewhere.tsx';
import { Search } from './Search.tsx';
import { Workspace } from './Workspace.tsx';

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
// Which main view is showing: a project's workspace or an idea.
const IDEA_KEY = 'workbench.selectedIdea';
const loadIdeaSel = () => {
  try {
    return localStorage.getItem(IDEA_KEY);
  } catch {
    return null;
  }
};
const saveIdeaSel = (id: string | null) => {
  try {
    if (id) localStorage.setItem(IDEA_KEY, id);
    else localStorage.removeItem(IDEA_KEY);
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
  const [searching, setSearching] = useState(false);
  const [managingHarnesses, setManagingHarnesses] = useState(false);
  const [errorCounts, setErrorCounts] = useState<Record<string, number>>({});
  // An action waiting for a given project's dock (opening a search hit in another project).
  const [pending, setPending] = useState<{ projectId: string; run: (dock: DockviewApi) => void } | null>(null);

  const [ideaSel, setIdeaSelState] = useState<string | null>(loadIdeaSel);
  const ideas = useIdeas();
  const setIdeaSel = useCallback((id: string | null) => {
    setIdeaSelState(id);
    saveIdeaSel(id);
  }, []);
  const setSelected = useCallback(
    (id: string | null) => {
      setSelectedState(id);
      saveSelected(id);
      if (id) setIdeaSel(null); // a project takes over the main view
    },
    [setIdeaSel],
  );

  const currentIdea = ideas.find((i) => i.id === ideaSel) ?? null;
  // While an idea is open, project-specific UI is hidden (but the selection is kept).
  const current = currentIdea ? null : (projects.find((p) => p.id === selected && !p.archived) ?? null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await hub.call('hub.info', {}));
      setProjects(await hub.call('project.list', { includeArchived: true }));
      await loadIdeas();
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
    async (resume?: string, harnessId?: string) => {
      if (!current || !dock) return;
      try {
        const s = await hub.call('agent.start', { projectId: current.id, harnessId, resume, cols: 100, rows: 30 });
        putSessions([s]);
        openTerminal(dock, s.id, s.title);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [current, dock],
  );

  // Open-error counts: sidebar badges, title bar, dock badge; alerts become notifications.
  useEffect(() => {
    if (status !== 'connected') return;
    const refreshCounts = () =>
      hub.call('errors.counts', {}).then((c) => {
        setErrorCounts(c);
        window.workbench.setBadge(Object.values(c).reduce((a, b) => a + b, 0));
      });
    void refreshCounts();
    return hub.onPush((p) => {
      if (p.event !== 'errors.update') return;
      void refreshCounts();
      if (p.data.alert) {
        const name = projects.find((x) => x.id === p.data.error.projectId)?.name ?? 'Workbench';
        window.workbench.notify(`${name}: new error`, p.data.error.title);
      }
    });
  }, [status, projects]);

  useEffect(() => {
    if (pending && dock && current?.id === pending.projectId) {
      pending.run(dock);
      setPending(null);
    }
  }, [pending, dock, current?.id]);

  const openHit = useCallback(
    (h: SearchHit) => {
      if (!h.projectId) {
        setError(`Add ${h.where} as a project to resume that conversation.`);
        return;
      }
      const run = async (d: DockviewApi) => {
        try {
          if (h.source === 'error') {
            const errs = await hub.call('errors.list', { projectId: h.projectId! });
            const occ = await Promise.all(errs.map(async (e) => ({ e, o: await hub.call('errors.occurrences', { id: e.id, limit: 50 }) })));
            const match = occ.find(({ o }) => o.some((x) => x.ts === h.ts))?.e;
            openErrors(d, h.projectId!, match?.id);
          } else if (h.source === 'commit') {
            openChangelog(d, h.projectId!);
          } else if (h.source === 'transcript') {
            const s = await hub.call('agent.start', { projectId: h.projectId!, resume: h.transcriptId!, cols: 100, rows: 30 });
            putSessions([s]);
            openTerminal(d, s.id, s.title);
          } else if (h.source === 'agent') {
            const live = (await hub.call('term.list', { projectId: h.projectId! })).find((s) => s.id === h.sessionId);
            if (live?.status === 'running') openTerminal(d, live.id, live.title);
            else openHistory(d, { sessionId: h.sessionId!, ts: h.ts ?? undefined });
          } else {
            openHistory(d, { sessionId: h.sessionId!, seq: h.seq ?? undefined });
          }
        } catch (err) {
          setError((err as Error).message);
        }
      };
      if (h.projectId !== current?.id) setSelected(h.projectId);
      setPending({ projectId: h.projectId, run: (d) => void run(d) });
    },
    [current?.id, setSelected],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === 'f') {
        e.preventDefault();
        setSearching(true);
        return;
      }
      if (e.shiftKey && k === 'e') {
        e.preventDefault();
        if (dock && current) openErrors(dock, current.id);
        return;
      }
      if (e.shiftKey && k === 'l') {
        e.preventDefault();
        if (dock && current) openChangelog(dock, current.id);
        return;
      }
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
  }, [newTerminal, startAgent, dock, current]);

  const promote = async (idea: Idea) => {
    const dir = await window.workbench.pickFolder();
    if (!dir) return;
    try {
      const { project, skipped } = await hub.call('idea.promote', { id: idea.id, rootPath: dir });
      await refresh();
      setSelected(project.id);
      setError(skipped.length ? `Promoted. Kept existing ${skipped.join(', ')} in ${dir} (not overwritten).` : null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

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
        <IdeasList ideas={ideas} selected={ideaSel} onSelect={setIdeaSel} onError={setError} />

        <div className="section-label spaced">Projects</div>
        <Projects
          errorCounts={errorCounts}
          projects={projects}
          selected={currentIdea ? null : selected}
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
            onRemote={(url) => dock && openRemote(dock, url)}
            project={current}
            sessions={agents}
            canOpen={!!dock && status === 'connected'}
            onOpen={(s) => dock && openTerminal(dock, s.id, s.title)}
            onStart={(resume, harnessId) => void startAgent(resume, harnessId)}
          />
        )}

        {current && (
          <Elsewhere
            project={current}
            onAttached={(id, title) => {
              if (!dock) return;
              void hub.call('term.get', { sessionId: id }).then((s) => putSessions([s]));
              openTerminal(dock, id, title);
            }}
            onOpenRemote={() => dock && openRemote(dock)}
            onError={setError}
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
        <button className="footer-link" onClick={() => setManagingHarnesses(true)} disabled={status !== 'connected'}>
          Harnesses…
        </button>
        <HubBadge status={status} info={info} />
      </aside>

      <main className="workspace">
        <div className="titlebar drag">
          <span className="titlebar-name">{currentIdea ? 'Idea' : (current?.name ?? 'Workbench')}</span>
          {current?.rootPath && <span className="muted titlebar-path">— {current.rootPath}</span>}
          {current && (
            <button
              className={`search-button ${errorCounts[current.id] ? 'has-errors' : ''}`}
              onClick={() => dock && openErrors(dock, current.id)}
              disabled={!dock}
            >
              Errors{errorCounts[current.id] ? ` (${errorCounts[current.id]})` : ''} <kbd>⌘⇧E</kbd>
            </button>
          )}
          {current && (
            <button className="search-button" onClick={() => dock && openChangelog(dock, current.id)} disabled={!dock}>
              Changelog <kbd>⌘⇧L</kbd>
            </button>
          )}
          <button className="search-button" onClick={() => setSearching(true)} disabled={status !== 'connected'}>
            Search history <kbd>⌘⇧F</kbd>
          </button>
        </div>
        {currentIdea ? (
          <IdeaView key={currentIdea.id} idea={currentIdea} onPromote={(i) => void promote(i)} onError={setError} />
        ) : current ? (
          <Workspace key={current.id} project={current} onApi={setDock} />
        ) : (
          <div className="placeholder">
            <h1>Workbench</h1>
            <p>Create or select a project.</p>
          </div>
        )}
      </main>
      {managingHarnesses && (
        <HarnessManager
          onClose={() => setManagingHarnesses(false)}
          onTokenPane={(harnessId) => {
            if (!current || !dock) return setError('Open a project first — the token setup runs in one of its panes.');
            void hub.call('account.tokenPane', { harnessId, projectId: current.id, cols: 100, rows: 30 }).then(
              (s) => {
                putSessions([s]);
                openTerminal(dock, s.id, s.title);
                setManagingHarnesses(false);
              },
              (err) => setError((err as Error).message),
            );
          }}
          onLogin={(harnessId) => {
            if (!current || !dock) return setError('Open a project first — the sign-in runs in one of its panes.');
            void hub.call('account.login', { harnessId, projectId: current.id, cols: 100, rows: 30 }).then(
              (s) => {
                putSessions([s]);
                openTerminal(dock, s.id, s.title);
                setManagingHarnesses(false);
              },
              (err) => setError((err as Error).message),
            );
          }}
        />
      )}
      {searching && <Search project={current} onOpen={openHit} onClose={() => setSearching(false)} />}
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
