import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ErrorGroup, ErrorOccurrence, ErrorRule, ErrorStatus } from '@workbench/shared';
import { hub } from './hub.ts';
import { openHistory } from './dock.ts';

export interface ErrorsParams {
  projectId: string;
  errorId?: string; // expand this one
}

const SOURCE: Record<ErrorGroup['source'], string> = {
  terminal: 'Terminal',
  logfile: 'Log file',
  'agent-tool': 'Agent tool',
  'agent-exit': 'Agent crash',
};
const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function ErrorsPane({ params, containerApi }: IDockviewPanelProps<ErrorsParams>) {
  const { projectId } = params;
  const [status, setStatus] = useState<ErrorStatus>('open');
  const [errors, setErrors] = useState<ErrorGroup[]>([]);
  const [open, setOpen] = useState<string | null>(params.errorId ?? null);
  const [occ, setOcc] = useState<ErrorOccurrence[]>([]);
  const [showRules, setShowRules] = useState(false);

  const load = useCallback(async () => setErrors(await hub.call('errors.list', { projectId, status })), [projectId, status]);

  useEffect(() => {
    void load();
    return hub.onPush((p) => {
      if (p.event === 'errors.update' && p.data.error.projectId === projectId) void load();
    });
  }, [load, projectId]);

  // A search hit can retarget this pane at a specific error.
  useEffect(() => {
    if (!params.errorId) return;
    setOpen(params.errorId);
    void hub.call('errors.list', { projectId }).then((all) => {
      const e = all.find((x) => x.id === params.errorId);
      if (e) setStatus(e.status);
    });
  }, [params.errorId, projectId]);

  useEffect(() => {
    if (!open) return setOcc([]);
    void hub.call('errors.occurrences', { id: open, limit: 10 }).then(setOcc);
  }, [open, errors]);

  const set = async (id: string, s: ErrorStatus) => {
    await hub.call('errors.setStatus', { id, status: s });
    await load();
  };

  return (
    <div className="errors">
      <div className="changelog-bar">
        <div className="scope">
          {(['open', 'resolved', 'ignored'] as const).map((s) => (
            <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className={`rules-toggle ${showRules ? 'on' : ''}`} onClick={() => setShowRules((v) => !v)}>
          Detection rules
        </button>
      </div>
      {showRules && <Rules projectId={projectId} />}
      <div className="changelog-list">
        {errors.length === 0 && (
          <p className="placeholder-text">
            {status === 'open'
              ? 'No open errors. Terminal output, tailed log files and agent tool failures are checked against the detection rules.'
              : `No ${status} errors.`}
          </p>
        )}
        {errors.map((e) => (
          <div key={e.id} className={`entry ${open === e.id ? 'open' : ''}`}>
            <button className="entry-row" onClick={() => setOpen(open === e.id ? null : e.id)}>
              <span className={`badge err-${e.source}`}>{SOURCE[e.source]}</span>
              <span className="entry-summary mono">{e.title}</span>
              <span className="entry-meta">
                ×{e.count} · {ago(e.lastSeen)}
              </span>
            </button>
            {open === e.id && (
              <div className="entry-detail">
                <p className="err-meta">
                  <code>{e.shortId}</code> · first seen {new Date(e.firstSeen).toLocaleString()} ·{' '}
                  {e.fixCommit ? (
                    <>fixed by {e.fixCommit.slice(0, 7)}</>
                  ) : (
                    <>
                      commit with “fixes {e.shortId}” to resolve it automatically
                    </>
                  )}
                </p>
                {occ.map((o, i) => (
                  <div key={i} className="occurrence">
                    <div className="occ-head">
                      <span>{new Date(o.ts).toLocaleString()}</span>
                      {o.sessionId && (
                        <button onClick={() => openHistory(containerApi, { sessionId: o.sessionId!, ts: o.ts })}>
                          Open in session output
                        </button>
                      )}
                    </div>
                    <pre>{o.text}</pre>
                  </div>
                ))}
                <div className="entry-actions">
                  {e.status !== 'resolved' && <button onClick={() => void set(e.id, 'resolved')}>Resolve</button>}
                  {e.status !== 'ignored' && <button onClick={() => void set(e.id, 'ignored')}>Ignore</button>}
                  {e.status !== 'open' && <button onClick={() => void set(e.id, 'open')}>Reopen</button>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const BLANK = { kind: 'output' as 'output' | 'logfile', label: '', pattern: '', path: '', scope: 'project' as 'project' | 'all' };

function Rules({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<ErrorRule[]>([]);
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setRules(await hub.call('rules.list', { projectId })), [projectId]);
  useEffect(() => void load(), [load]);

  const save = async (rule: Omit<ErrorRule, 'id'> & { id?: string }) => {
    try {
      await hub.call('rules.save', { rule });
      setError(null);
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const add = async () => {
    const ok = await save({
      projectId: draft.scope === 'all' ? null : projectId,
      kind: draft.kind,
      label: draft.label,
      pattern: draft.pattern,
      path: draft.kind === 'logfile' ? draft.path : null,
      enabled: true,
      notify: true,
    });
    if (ok) setDraft(BLANK);
  };

  return (
    <div className="rules">
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>Pattern</th>
            <th>Scope</th>
            <th title="Record matches">Record</th>
            <th title="Notify on new errors">Alert</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>
                {r.label}
                {r.kind === 'logfile' && <div className="muted mono small">{r.path}</div>}
              </td>
              <td className="mono small">{r.pattern}</td>
              <td className="muted">{r.projectId ? 'This project' : 'All projects'}</td>
              <td>
                <input type="checkbox" checked={r.enabled} onChange={(e) => void save({ ...r, enabled: e.target.checked })} />
              </td>
              <td>
                <input type="checkbox" checked={r.notify} onChange={(e) => void save({ ...r, notify: e.target.checked })} />
              </td>
              <td>
                <button className="link" onClick={() => void hub.call('rules.delete', { id: r.id }).then(load)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rule-add">
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'output' | 'logfile' })}>
          <option value="output">Terminal output</option>
          <option value="logfile">Log file</option>
        </select>
        <input placeholder="Label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <input
          className="mono"
          placeholder="Regex, e.g. ^ERROR"
          value={draft.pattern}
          onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
        />
        {draft.kind === 'logfile' && (
          <input
            className="mono"
            placeholder="/path/to/file.log"
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          />
        )}
        <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as 'project' | 'all' })}>
          <option value="project">This project</option>
          <option value="all">All projects</option>
        </select>
        <button onClick={() => void add()}>Add rule</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
