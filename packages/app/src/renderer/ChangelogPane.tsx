import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ChangeEntry, ChangeSource } from '@workbench/shared';
import { hub } from './hub.ts';
import { openHistory, openTerminal } from './dock.ts';
import { putSessions } from './sessions.ts';

export interface ChangelogParams {
  projectId: string;
}

const PAGE = 200;
const FILTERS: { id: ChangeSource | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'git', label: 'Commits' },
  { id: 'session', label: 'Sessions' },
  { id: 'manual', label: 'Notes' },
];
const BADGE: Record<ChangeSource, string> = { git: 'Commit', session: 'Agent', manual: 'Note' };

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ChangelogPane({ params, containerApi }: IDockviewPanelProps<ChangelogParams>) {
  const { projectId } = params;
  const [entries, setEntries] = useState<ChangeEntry[]>([]);
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState<ChangeSource | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const list = await hub.call('changelog.list', { projectId, limit: PAGE });
    setEntries(list);
    setMore(list.length === PAGE);
  }, [projectId]);

  useEffect(() => {
    void load();
    return hub.onPush((p) => {
      if (p.event === 'changelog.update' && p.data.projectId === projectId) void load();
    });
  }, [load, projectId]);

  const older = async () => {
    const last = entries.at(-1);
    if (!last) return;
    const list = await hub.call('changelog.list', { projectId, before: last.ts, limit: PAGE });
    setEntries((e) => [...e, ...list]);
    setMore(list.length === PAGE);
  };

  const toggle = async (e: ChangeEntry) => {
    const next = open === e.id ? null : e.id;
    setOpen(next);
    if (next && e.source === 'git' && !detail[e.id]) {
      const text = await hub.call('changelog.commit', { projectId, sha: String(e.refs.sha) }).catch((err) => String(err.message));
      setDetail((d) => ({ ...d, [e.id]: text }));
    }
  };

  const openSession = async (e: ChangeEntry) => {
    const sessionId = String(e.refs.sessionId);
    const s = await hub.call('term.get', { sessionId });
    putSessions([s]);
    if (s.status === 'running') openTerminal(containerApi, s.id, s.title);
    else openHistory(containerApi, { sessionId });
  };

  const resume = async (e: ChangeEntry) => {
    const s = await hub.call('agent.start', { projectId, resume: String(e.refs.externalId), cols: 100, rows: 30 });
    putSessions([s]);
    openTerminal(containerApi, s.id, s.title);
  };

  const addNote = async () => {
    if (!note.trim()) return;
    await hub.call('changelog.note', { projectId, text: note });
    setNote('');
  };

  const shown = entries.filter((e) => filter === 'all' || e.source === filter);
  let lastDay = '';

  return (
    <div className="changelog">
      <div className="changelog-bar">
        <div className="scope">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="note-input"
          placeholder="Add a note (Enter)…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addNote()}
        />
      </div>
      <div className="changelog-list">
        {shown.length === 0 && (
          <p className="placeholder-text">
            Nothing yet. Commits appear when the project folder is a git repo; agent sessions after their first turn.
          </p>
        )}
        {shown.map((e) => {
          const day = dayLabel(e.ts);
          const header = day !== lastDay ? <h3 className="day">{day}</h3> : null;
          lastDay = day;
          const r = e.refs;
          return (
            <div key={e.id}>
              {header}
              <div className={`entry ${open === e.id ? 'open' : ''}`}>
                <button className="entry-row" onClick={() => void toggle(e)}>
                  <span className="entry-time">{clock(e.ts)}</span>
                  <span className={`badge ${e.source}`}>{BADGE[e.source]}</span>
                  <span className="entry-summary">{e.summary}</span>
                  <span className="entry-meta">
                    {e.source === 'git' &&
                      `${String(r.sha).slice(0, 7)} · ${r.author}${r.branch ? ` · ${r.branch}` : ''} · +${r.insertions} −${r.deletions}`}
                    {e.source === 'session' &&
                      `${r.prompts} prompt${r.prompts === 1 ? '' : 's'} · ${(r.files as string[]).length} file${(r.files as string[]).length === 1 ? '' : 's'} · ${r.commands} cmd${r.running ? ' · running' : ''}`}
                  </span>
                </button>
                {open === e.id && (
                  <div className="entry-detail">
                    {e.source === 'git' && <pre>{detail[e.id] ?? 'Loading…'}</pre>}
                    {e.source === 'session' && (
                      <>
                        {r.final ? <p className="final">{String(r.final)}</p> : null}
                        {(r.files as string[]).length > 0 && (
                          <ul className="files">
                            {(r.files as string[]).map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                        )}
                        <div className="entry-actions">
                          <button onClick={() => void openSession(e)}>{r.running ? 'Open session' : 'View output'}</button>
                          {!r.running && r.externalId ? (
                            <button onClick={() => void resume(e)}>Resume conversation</button>
                          ) : null}
                        </div>
                      </>
                    )}
                    {e.source === 'manual' && (
                      <div className="entry-actions">
                        <button onClick={() => void hub.call('changelog.delete', { id: e.id })}>Delete note</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {more && (
          <button className="older" onClick={() => void older()}>
            Load older
          </button>
        )}
      </div>
    </div>
  );
}
