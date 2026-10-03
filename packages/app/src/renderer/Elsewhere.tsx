import { useEffect, useState } from 'react';
import type { LocalClaudeSession, Project } from '@workbench/shared';
import { hub } from './hub.ts';

const POLL_MS = 15_000;
const DOT: Record<string, string> = { busy: 'agent-working', blocked: 'agent-waiting', idle: 'agent-idle' };

interface Props {
  project: Project;
  onAttached: (sessionId: string, title: string) => void;
  onOpenRemote: () => void;
  onError: (msg: string) => void;
}

// Claude sessions outside Workbench: other terminals on this Mac (status only —
// their terminal owns them) and background agents (attach / stop). Sessions on
// other machines are reached through Remote Control in the Remote pane.
export function Elsewhere({ project, onAttached, onOpenRemote, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<LocalClaudeSession[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      hub.call('local.sessions', {}).then(
        (s) => alive && setSessions(s.filter((x) => !x.ours)),
        (err) => alive && onError((err as Error).message),
      );
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, onError]);

  const attach = async (s: LocalClaudeSession) => {
    try {
      const t = await hub.call('local.attach', { id: s.id!, projectId: project.id, cols: 100, rows: 30 });
      onAttached(t.id, t.title);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const menu = async (s: LocalClaudeSession) => {
    if (s.kind !== 'background') return;
    const choice = await window.workbench.menu([
      { id: 'attach', label: 'Attach in a pane' },
      { type: 'separator' },
      { id: 'stop', label: 'Stop (conversation is kept)' },
    ]);
    if (choice === 'attach') await attach(s);
    if (choice === 'stop')
      await hub.call('local.stop', { id: s.id! }).then(
        () => setSessions((list) => list?.filter((x) => x !== s) ?? null),
        (err) => onError((err as Error).message),
      );
  };

  return (
    <>
      <button className="disclosure" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Elsewhere
      </button>
      {open && (
        <ul className="list history">
          <li>
            <button onClick={onOpenRemote} title="Drive Remote Control sessions on any machine through claude.ai">
              <span className="agent-text">
                <span className="agent-title">🌐 Remote sessions</span>
                <span className="agent-activity">other machines, via Remote Control</span>
              </span>
            </button>
          </li>
          {sessions === null && <li className="empty">Loading…</li>}
          {sessions?.map((s) => (
            <li key={`${s.kind}:${s.id ?? s.pid}`}>
              <button
                className="agent-row"
                onClick={() => (s.kind === 'background' ? void attach(s) : undefined)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void menu(s);
                }}
                title={s.kind === 'background' ? `${s.cwd} — click to attach` : `${s.cwd} — running in another terminal (pid ${s.pid})`}
              >
                <span className={`dot ${DOT[s.state] ?? 'agent-starting'}`} />
                <span className="agent-text">
                  <span className="agent-title">{s.name}</span>
                  <span className="agent-activity">
                    {s.kind === 'background' ? 'background' : 'other terminal'} · {s.state}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {sessions?.length === 0 && <li className="empty">No other Claude sessions on this Mac.</li>}
        </ul>
      )}
    </>
  );
}
