import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ChangeEntry, ClaudeTranscript, ProjectInfo, SearchHit, TermSession } from '@workbench/shared';
import { hub } from './hub.ts';
import { openChangelog, openErrors, openHistory, openTerminal } from './dock.ts';
import { putSessions } from './sessions.ts';

// One pane per project with everything that tracks it: what it is (Info), everything that happened
// to it (History: commits, agent sessions, conversations, terminals, notes) and a search over all of it.
export interface ProjectParams {
  projectId: string;
  view?: 'info' | 'history' | 'search';
}
type View = NonNullable<ProjectParams['view']>;
type Kind = 'commit' | 'agent' | 'conversation' | 'terminal' | 'note';
interface Item {
  id: string;
  kind: Kind;
  ts: number;
  title: string;
  meta: string;
  open: () => Promise<void> | void;
}

const VIEWS: { id: View; label: string }[] = [
  { id: 'info', label: 'Info' },
  { id: 'history', label: 'History' },
  { id: 'search', label: 'Search' },
];
const KINDS: { id: Kind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'commit', label: 'Commits' },
  { id: 'agent', label: 'Agent sessions' },
  { id: 'conversation', label: 'Conversations' },
  { id: 'terminal', label: 'Terminals' },
  { id: 'note', label: 'Notes' },
];
const KIND_LABEL: Record<Kind, string> = { commit: 'Commit', agent: 'Agent', conversation: 'Conversation', terminal: 'Terminal', note: 'Note' };
const SOURCE_LABEL: Record<SearchHit['source'], string> = { agent: 'Agent', terminal: 'Terminal', transcript: 'Claude', commit: 'Commit', error: 'Error' };

const when = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (ts: number) => new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const bytes = (n: number) => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

// snippet() marks matches with \u0001…\u0002.
function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\s+/g, ' ').split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <span className="hit-snippet">
      {parts.map((p, i) => (p.startsWith('\u0001') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

export function ProjectPane({ params, containerApi }: IDockviewPanelProps<ProjectParams>) {
  const { projectId } = params;
  const [view, setView] = useState<View>(params.view ?? 'info');
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [entries, setEntries] = useState<ChangeEntry[]>([]);
  const [transcripts, setTranscripts] = useState<ClaudeTranscript[]>([]);
  const [sessions, setSessions] = useState<TermSession[]>([]);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitsFor, setHitsFor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (params.view) setView(params.view);
  }, [params.view]);

  const load = useCallback(async () => {
    try {
      const [i, e, t, s] = await Promise.all([
        hub.call('project.info', { projectId }),
        hub.call('changelog.list', { projectId, limit: 500 }),
        hub.call('agent.history', { projectId }),
        hub.call('term.list', { projectId }),
      ]);
      setInfo(i);
      setEntries(e);
      setTranscripts(t);
      setSessions(s);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return hub.onPush((p) => {
      if ((p.event === 'changelog.update' && p.data.projectId === projectId) || p.event === 'term.update') void load();
    });
  }, [load, projectId]);

  useEffect(() => {
    if (view === 'search') searchBox.current?.focus();
  }, [view]);

  // ---- Search (scoped to this project) ----
  const key = `${projectId}:${query.trim()}`;
  const fresh = hitsFor === key;
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setHitsFor(key);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      hub.call('history.search', { query, projectId }).then(
        (h) => {
          if (cancelled) return;
          setHits(h);
          setHitsFor(key);
        },
        () => {
          if (cancelled) return;
          setHits([]);
          setHitsFor(key);
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSession = useCallback(
    async (sessionId: string, ts?: number) => {
      const live = await hub.call('term.get', { sessionId });
      if (live?.status === 'running') openTerminal(containerApi, live.id, live.title);
      else openHistory(containerApi, { sessionId, ts });
    },
    [containerApi],
  );

  const resume = useCallback(
    async (transcriptId: string) => {
      const s = await hub.call('agent.start', { projectId, resume: transcriptId, cols: 100, rows: 30 });
      putSessions([s]);
      openTerminal(containerApi, s.id, s.title);
    },
    [containerApi, projectId],
  );

  const openHit = async (h: SearchHit) => {
    try {
      if (h.source === 'error') {
        const errs = await hub.call('errors.list', { projectId });
        const occ = await Promise.all(errs.map(async (e) => ({ e, o: await hub.call('errors.occurrences', { id: e.id, limit: 50 }) })));
        const match = occ.find(({ o }) => o.some((x) => x.ts === h.ts))?.e;
        openErrors(containerApi, projectId, match?.id);
      } else if (h.source === 'commit') openChangelog(containerApi, projectId);
      else if (h.source === 'transcript') await resume(h.transcriptId!);
      else if (h.source === 'agent') await openSession(h.sessionId!, h.ts ?? undefined);
      else openHistory(containerApi, { sessionId: h.sessionId!, seq: h.seq ?? undefined });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ---- History: one timeline from every source ----
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const e of entries) {
      if (e.source === 'git') out.push({ id: e.id, kind: 'commit', ts: e.ts, title: e.summary, meta: String(e.refs.sha ?? '').slice(0, 7), open: () => openChangelog(containerApi, projectId) });
      else if (e.source === 'session') out.push({ id: e.id, kind: 'agent', ts: e.ts, title: e.summary, meta: e.refs.running ? 'running' : `${(e.refs.files as unknown[] | undefined)?.length ?? 0} files`, open: () => (e.refs.sessionId ? openSession(String(e.refs.sessionId)) : openChangelog(containerApi, projectId)) });
      else out.push({ id: e.id, kind: 'note', ts: e.ts, title: e.summary, meta: 'note', open: () => openChangelog(containerApi, projectId) });
    }
    for (const t of transcripts) out.push({ id: `t:${t.id}`, kind: 'conversation', ts: t.updatedAt, title: t.title || t.firstPrompt || 'Conversation', meta: `${t.provider === 'openai-codex' ? 'Codex' : 'Claude'} · ${bytes(t.bytes)}`, open: () => resume(t.id) });
    for (const s of sessions) if (s.kind === 'terminal') out.push({ id: `s:${s.id}`, kind: 'terminal', ts: s.startedAt, title: s.title, meta: s.status, open: () => openSession(s.id) });
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }, [entries, transcripts, sessions, containerApi, projectId, openSession, resume]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return items.filter((i) => (kind === 'all' || i.kind === kind) && (!f || `${i.title} ${i.meta}`.toLowerCase().includes(f)));
  }, [items, kind, filter]);

  const name = info?.project.name ?? '';

  return (
    <div className="project-pane">
      <div className="project-bar">
        <strong className="project-bar-name">{name}</strong>
        <div className="scope">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        {view === 'history' && (
          <input className="project-filter" placeholder="Filter the timeline" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        <span className="spacer" />
        <button className="disclosure" onClick={() => void load()} title="Reload">
          Refresh
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {view === 'info' && (
        <div className="project-body">
          {!info ? (
            <p className="muted">Loading…</p>
          ) : (
            <>
              <section className="pi-section">
                <h3>{info.project.name}</h3>
                <p className="muted mono">{info.project.rootPath ?? 'no folder'}</p>
                <p className="muted">
                  Created {day(info.project.createdAt)} · agent harness {info.project.defaultHarnessId ?? 'Claude Code'}
                  {info.version ? ` · version ${info.version}` : ''}
                </p>
              </section>
              <section className="pi-section">
                <h4>Logged by the hub</h4>
                <div className="pi-grid">
                  <div className="pi-card"><b>{info.counts.commits}</b><span>commits seen</span></div>
                  <div className="pi-card"><b>{info.counts.sessionsLogged}</b><span>agent sessions</span></div>
                  <div className="pi-card"><b>{info.counts.conversations}</b><span>conversations</span></div>
                  <div className="pi-card"><b>{info.counts.terminals}</b><span>terminals</span></div>
                  <div className="pi-card"><b>{info.counts.notes}</b><span>notes</span></div>
                  <div className="pi-card"><b>{info.counts.errorsOpen}</b><span>open errors</span></div>
                </div>
              </section>
              <section className="pi-section">
                <h4>Git</h4>
                {!info.git ? (
                  <p className="muted">Not a git repository.</p>
                ) : (
                  <>
                    <p>
                      <span className="mono">{info.git.branch ?? 'detached'}</span> · {info.git.commits.toLocaleString()} commits
                      {info.git.dirty ? ` · ${info.git.dirty} uncommitted` : ' · clean'}
                    </p>
                    {info.git.head && (
                      <p className="muted">
                        HEAD <span className="mono">{info.git.head.sha.slice(0, 7)}</span> {info.git.head.subject} · {when(info.git.head.ts)}
                      </p>
                    )}
                    {info.git.tags.length > 0 && (
                      <ul className="pi-tags">
                        {info.git.tags.map((t) => (
                          <li key={t.name}>
                            <span className="mono">{t.name}</span> <span className="muted">{day(t.ts)}{t.subject ? ` · ${t.subject}` : ''}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
              {info.assets.length > 0 && (
                <section className="pi-section">
                  <h4>Built assets</h4>
                  <ul className="pi-tags">
                    {info.assets.map((a) => (
                      <li key={a.dir}>
                        <span className="mono">{a.dir}/</span> <span className="muted">{a.files} files · {bytes(a.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {info.docs.map((d) => (
                <section className="pi-section" key={d.name}>
                  <h4>{d.name}</h4>
                  <pre className="pi-doc">{d.head}</pre>
                </section>
              ))}
            </>
          )}
        </div>
      )}

      {view === 'history' && (
        <div className="project-body">
          <div className="scope pi-kinds">
            {KINDS.map((k) => (
              <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
          <ul className="pi-timeline">
            {shown.map((i, n) => {
              const d = day(i.ts);
              const prev = n > 0 ? day(shown[n - 1].ts) : null;
              return (
                <li key={i.id}>
                  {d !== prev && <div className="day">{d}</div>}
                  <button className="entry-row" onClick={() => void i.open()}>
                    <span className="entry-time">{new Date(i.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <span className={`badge ${i.kind}`}>{KIND_LABEL[i.kind]}</span>
                    <span className="entry-summary">{i.title}</span>
                    <span className="entry-meta">{i.meta}</span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && <li className="empty">Nothing logged yet.</li>}
          </ul>
        </div>
      )}

      {view === 'search' && (
        <div className="project-body">
          <input
            ref={searchBox}
            className="project-search"
            placeholder={`Search ${name}: terminals, agents, conversations, commits, errors…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className={`hits ${fresh ? '' : 'stale'}`}>
            {hits.map((h) => (
              <li key={`${h.source}:${h.sessionId ?? h.transcriptId}:${h.ts}`}>
                <button onClick={() => void openHit(h)}>
                  <span className="hit-top">
                    <span className={`badge ${h.source}`}>{SOURCE_LABEL[h.source]}</span>
                    <span className="hit-title">{h.title}</span>
                    <span className="hit-meta">{h.where}{h.ts ? ` · ${when(h.ts)}` : ''}</span>
                  </span>
                  <Snippet text={h.snippet} />
                </button>
              </li>
            ))}
            {query.trim() && fresh && hits.length === 0 && <li className="empty">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
