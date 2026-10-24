import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { Project, VoiceRecording } from '@workbench/shared';
import { keys, revealLabel } from './platform.ts';
import { hub } from './hub.ts';

export interface RecordingsParams {
  projectId: string;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const when = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

// Every voice recording with its transcript: this project's, or all of them
// grouped by project. Play, copy, edit the transcript, file under another
// project, show in Finder, delete.
export function RecordingsPane({ params }: IDockviewPanelProps<RecordingsParams>) {
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [items, setItems] = useState<VoiceRecording[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, ps] = await Promise.all([
        hub.call('voice.list', scope === 'project' ? { projectId: params.projectId } : {}),
        hub.call('project.list', { includeArchived: true }),
      ]);
      setItems(list);
      setProjects(ps);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [scope, params.projectId]);

  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      hub.onPush((p) => {
        if (p.event === 'voice.update' && (p.data.state === 'done' || p.data.state === 'failed')) void load();
      }),
    [load],
  );

  const name = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.name ?? 'Unknown project') : 'Not filed');
  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter((r) => !q || r.text.toLowerCase().includes(q));

  // Group: by project (all) or by day (this project).
  const groups = new Map<string, VoiceRecording[]>();
  for (const r of shown) {
    const key = scope === 'all' ? name(r.projectId) : day(r.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return (
    <div className="changelog recordings">
      <div className="changelog-bar">
        <div className="scope">
          <button className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>
            This project
          </button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            All projects
          </button>
        </div>
        <input className="note-input" placeholder="Search transcripts…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted small">{items ? `${shown.length} recording${shown.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="changelog-list">
        {error && <div className="error">{error}</div>}
        {items && shown.length === 0 && (
          <div className="placeholder-text">
            {q ? 'No transcript matches.' : `No recordings yet. Press 🎤 on a pane (${keys('⌘⇧V')}) to record one.`}
          </div>
        )}
        {[...groups].map(([g, rs]) => (
          <section key={g}>
            <div className="day">{g}</div>
            {rs.map((r) => (
              <Recording key={r.id} r={r} projects={projects} onChanged={load} onError={setError} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function Recording({
  r,
  projects,
  onChanged,
  onError,
}: {
  r: VoiceRecording;
  projects: Project[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.text);
  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);

  const play = async () => {
    try {
      const b64 = await hub.call('voice.audio', { id: r.id });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      setSrc(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })));
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const more = async () => {
    const choice = await window.workbench.menu([
      { id: 'reveal', label: revealLabel },
      { id: 'copypath', label: 'Copy file paths' },
      { type: 'separator' },
      ...projects
        .filter((p) => !p.archived && p.id !== r.projectId)
        .map((p) => ({ id: `file:${p.id}`, label: `Move to ${p.name}` })),
      { type: 'separator' },
      { id: 'delete', label: 'Delete recording…' },
    ]);
    try {
      if (choice === 'reveal') await window.workbench.reveal(r.file);
      else if (choice === 'copypath') await navigator.clipboard.writeText([r.file, r.transcriptFile].filter(Boolean).join('\n'));
      else if (choice?.startsWith('file:')) {
        await hub.call('voice.file', { id: r.id, projectId: choice.slice(5) });
        onChanged();
      } else if (choice === 'delete') {
        const sure = await window.workbench.menu([
          { id: 'yes', label: 'Delete the recording and its transcript' },
          { id: 'no', label: 'Keep it' },
        ]);
        if (sure === 'yes') {
          await hub.call('voice.delete', { id: r.id });
          onChanged();
        }
      }
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="rec-item">
      <div className="rec-head">
        <span className="entry-time">{when(r.createdAt)}</span>
        <span className="badge session">{mmss(r.seconds)}</span>
        <span className="rec-spacer" />
        {src ? (
          <audio className="rec-audio" src={src} controls autoPlay />
        ) : (
          <button className="link" onClick={() => void play()}>
            ▶ Play
          </button>
        )}
        <button className="link" onClick={() => void navigator.clipboard.writeText(r.text)} disabled={!r.text}>
          Copy
        </button>
        <button className="link" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Cancel' : 'Edit'}
        </button>
        <button className="link" onClick={() => void more()}>
          More ▾
        </button>
      </div>
      {editing ? (
        <div className="rec-edit">
          <textarea className="voice-draft" value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, Math.max(3, Math.ceil(draft.length / 110) + 1))} />
          <button
            className="action primary"
            onClick={() =>
              void hub.call('voice.saveText', { id: r.id, text: draft }).then(
                () => {
                  setEditing(false);
                  onChanged();
                },
                (err) => onError((err as Error).message),
              )
            }
          >
            Save transcript
          </button>
        </div>
      ) : (
        <div className="rec-text">{r.text || <span className="muted">(no speech recognised)</span>}</div>
      )}
    </div>
  );
}
