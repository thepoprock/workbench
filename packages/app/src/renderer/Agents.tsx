import { useEffect, useState } from 'react';
import type { ClaudeTranscript, Project, TermSession } from '@workbench/shared';
import { hub } from './hub.ts';
import { statusClass } from './sessions.ts';

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const STATE_LABEL: Record<string, string> = {
  starting: 'Starting…',
  idle: 'Ready',
  working: 'Working',
  waiting: 'Needs you',
};

interface Props {
  onRemote: (url: string) => void;
  project: Project;
  sessions: TermSession[]; // this project's agent sessions
  canOpen: boolean;
  onOpen: (s: TermSession) => void;
  onStart: (resume?: string, harnessId?: string) => void;
}

export function Agents({ onRemote, project, sessions, canOpen, onOpen, onStart }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ClaudeTranscript[] | null>(null);
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});
  const endedCount = sessions.filter((s) => s.status !== 'running').length;

  // Reload when opened, and when an agent ends (its transcript just changed).
  useEffect(() => {
    if (!showHistory) return;
    let cancelled = false;
    // Label conversations by account when there is more than one.
    hub.call('harness.list', {}).then((hs) => {
      const claude = hs.filter((h) => h.type === 'claude-code');
      if (!cancelled && claude.length > 1)
        setAccountNames(Object.fromEntries(claude.map((h) => [h.id, h.name.replace(/^Claude Code( · )?/, '') || 'Main'])));
    });
    hub.call('agent.history', { projectId: project.id }).then(
      (h) => !cancelled && setHistory(h),
      () => !cancelled && setHistory([]),
    );
    return () => {
      cancelled = true;
    };
  }, [showHistory, project.id, project.rootPath, endedCount]);

  // One enabled harness: start it. Several: let the user pick (default first).
  const pickHarness = async () => {
    const enabled = (await hub.call('harness.list', {})).filter((h) => h.enabled);
    if (enabled.length <= 1) return onStart(undefined, enabled[0]?.id);
    const def = project.defaultHarnessId ?? 'claude-code';
    enabled.sort((a, b) => Number(b.id === def) - Number(a.id === def));
    const choice = await window.workbench.menu(
      enabled.map((h) => ({ id: h.id, label: `${h.name}${h.id === def ? '  (default)' : ''}` })),
    );
    if (choice) onStart(undefined, choice);
  };

  const openIds = new Set(sessions.filter((s) => s.status === 'running').map((s) => s.agent?.externalId));

  return (
    <>
      <div className="section-label with-action">
        Agents
        <button onClick={() => void pickHarness()} title="New agent session (⌘⇧A starts the project default)" disabled={!canOpen}>
          +
        </button>
      </div>
      <ul className="list">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              className={`agent-row ${s.status !== 'running' ? 'ended' : ''}`}
              onClick={() => onOpen(s)}
              onContextMenu={(e) => {
                e.preventDefault();
                const url = s.agent?.remoteUrl;
                if (!url) return;
                void window.workbench
                  .menu([
                    { id: 'here', label: 'Open on claude.ai (in Workbench)' },
                    { id: 'browser', label: 'Open in browser' },
                    { id: 'copy', label: 'Copy Remote Control link' },
                  ])
                  .then((c) => {
                    if (c === 'here') onRemote(url);
                    if (c === 'browser') window.open(url); // main process hands it to the browser
                    if (c === 'copy') void navigator.clipboard.writeText(url);
                  });
              }}
              title={s.agent?.remoteUrl ? `Remote Control on — right-click for the claude.ai link` : (s.agent?.activity ?? s.cwd)}
            >
              <span className={`dot ${statusClass(s)}`} />
              <span className="agent-text">
                <span className="agent-title">
                  {s.title}
                  {s.status === 'running' && s.agent?.remoteUrl && <span className="rc-chip">RC</span>}
                </span>
                <span className="agent-activity">
                  {s.status === 'running'
                    ? (s.agent?.activity ?? STATE_LABEL[s.agent?.state ?? 'idle'])
                    : s.status === 'lost'
                      ? 'Ended (hub restarted)'
                      : 'Ended'}
                </span>
              </span>
            </button>
          </li>
        ))}
        {sessions.length === 0 && <li className="empty">None</li>}
      </ul>

      <button className="disclosure" onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? '▾' : '▸'} Claude history
      </button>
      {showHistory && (
        <ul className="list history">
          {!project.rootPath && <li className="empty">Set a project folder to see its Claude history.</li>}
          {project.rootPath && history === null && <li className="empty">Loading…</li>}
          {project.rootPath && history?.length === 0 && <li className="empty">No past sessions in this folder.</li>}
          {history?.map((h) => (
            <li key={h.id}>
              <button onClick={() => onStart(h.id)} disabled={!canOpen} title={h.firstPrompt ?? h.title}>
                <span className="agent-text">
                  <span className="agent-title">
                    {openIds.has(h.id) && <span className="dot agent-idle" />} {h.title}
                  </span>
                  <span className="agent-activity">
                    {ago(h.updatedAt)}
                    {accountNames[h.harnessId] ? ` · ${accountNames[h.harnessId]}` : ''} · resume
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
