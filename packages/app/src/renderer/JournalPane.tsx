import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { JournalRef, VoiceRecording, VoiceUpdate } from '@workbench/shared';
import { hub } from './hub.ts';
import { openJournal } from './dock.ts';
import { keys } from './platform.ts';
import { day, Recording } from './RecordingsPane.tsx';
import { micError, Recorder } from './voice.ts';

export type JournalParams = JournalRef;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// One journal: record into it, and read, play or edit what it holds. Entries are
// this tab's alone. Nothing is typed into a terminal, and stopping or closing the
// tab always keeps what was said; an entry is removed only by deleting it.
export function JournalPane({ params, api, containerApi }: IDockviewPanelProps<JournalParams>) {
  return (
    <JournalView
      journal={params}
      isActive={() => api.isActive}
      onTitle={(t) => api.setTitle(t)}
      onNew={async () => openJournal(containerApi, await hub.call('journal.create', { projectId: params.projectId }))}
    />
  );
}

// The journal itself, for a tab of its own or inside Haven's panel. Without onNew there
// is no "+ New journal" (Haven has one journal).
export function JournalView({
  journal,
  isActive,
  onTitle = () => {},
  onNew,
}: {
  journal: JournalRef;
  isActive: () => boolean;
  onTitle?: (title: string) => void;
  onNew?: () => Promise<void>;
}) {
  const ref: JournalRef = { projectId: journal.projectId, journalId: journal.journalId };
  const [name, setName] = useState('');
  const [entries, setEntries] = useState<VoiceRecording[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [u, setU] = useState<VoiceUpdate | null>(null);
  const [level, setLevel] = useState(0);
  const rec = useRef<Recorder | null>(null);
  rec.current ??= new Recorder();
  const idRef = useRef<string | null>(null);
  const busy = useRef(false); // a start or stop is in flight
  const recording = u?.state === 'starting' || u?.state === 'listening';

  const load = useCallback(async () => {
    try {
      const [journals, list] = await Promise.all([hub.call('journal.list', { projectId: ref.projectId }), hub.call('journal.entries', ref)]);
      const j = journals.find((x) => x.journalId === ref.journalId);
      if (j) {
        setName(j.name);
        onTitle(j.name);
      }
      setEntries(list);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [ref.projectId, ref.journalId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => void load(), [load]);

  useEffect(() => {
    const r = rec.current!;
    r.onLevel = setLevel;
    return () => {
      if (r.id) void r.stop().catch(() => {}); // tab closed mid-entry: keep it
    };
  }, []);

  useEffect(
    () =>
      hub.onPush((p) => {
        if (p.event !== 'voice.update' || p.data.id !== idRef.current) return;
        setU(p.data);
      }),
    [],
  );

  const toggle = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      if (rec.current!.id) {
        const done = await rec.current!.stop();
        idRef.current = null;
        setU(null);
        if (done.state === 'failed') setError(`Audio saved, but it couldn't be transcribed: ${done.error}`);
        await load();
      } else {
        const first = await rec.current!.start(ref.projectId, null, ref);
        idRef.current = first.id;
        setU(first);
      }
    } catch (err) {
      setError(micError(err));
    } finally {
      busy.current = false;
    }
  }, [ref.projectId, ref.journalId, load]);

  // ⌘⇧V (App) starts and stops an entry when this tab is the active one.
  useEffect(() => {
    const press = () => {
      if (isActive()) void toggle();
    };
    window.addEventListener('workbench:voice', press);
    return () => window.removeEventListener('workbench:voice', press);
  }, [isActive, toggle]);

  const rename = async () => {
    if (!name.trim()) return load();
    try {
      const j = await hub.call('journal.rename', { ...ref, name });
      onTitle(j.name);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const newJournal = async () => {
    try {
      await onNew?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = (entries ?? []).filter((r) => !q || r.text.toLowerCase().includes(q));
  const days = new Map<string, VoiceRecording[]>();
  for (const r of shown) days.set(day(r.createdAt), [...(days.get(day(r.createdAt)) ?? []), r]);

  return (
    <div className="changelog recordings">
      <div className="changelog-bar">
        <input className="note-input journal-name" aria-label="Journal name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} />
        <button className={`voice-rec ${recording ? 'on' : ''}`} onClick={() => void toggle()} disabled={u?.state === 'finishing'} title={`Start or stop an entry (${keys('⌘⇧V')})`}>
          {u?.state === 'finishing' ? 'Finishing…' : recording ? `■ ${u?.state === 'starting' ? 'Loading…' : 'Stop'}` : '● Record'}
        </button>
        {recording && (
          <span className="voice-level" aria-hidden>
            <i style={{ width: `${Math.min(100, level * 400)}%` }} />
          </span>
        )}
        {u && <span className="voice-time">{mmss(u.seconds)}</span>}
        <input className="note-input" placeholder="Search this journal…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted small">{entries ? `${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}` : ''}</span>
        {onNew && (
          <button className="link" onClick={() => void newJournal()} title="A separate journal in its own tab">
            + New journal
          </button>
        )}
      </div>
      {u && (u.text || u.partial) && (
        <div className="journal-live">
          {u.text}
          {u.partial && <span className="voice-partial"> {u.partial}</span>}
        </div>
      )}
      <div className="changelog-list">
        {error && <div className="error">{error}</div>}
        {!error && u?.error && <div className="error">{u.error}</div>}
        {entries && shown.length === 0 && <div className="placeholder-text">{q ? 'No transcript matches.' : 'Nothing here yet. Press Record to start an entry.'}</div>}
        {[...days].map(([d, rs]) => (
          <section key={d}>
            <div className="day">{d}</div>
            {rs.map((r) => (
              <Recording key={r.id} r={r} projects={[]} journal={ref} onChanged={() => void load()} onError={setError} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
