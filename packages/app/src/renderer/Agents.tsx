import { useEffect, useState } from 'react';
import type { ClaudeTranscript, Project, TermSession } from '@workbench/shared';
import { hub } from './hub.ts';
import { statusClass } from './sessions.ts';
import { keys } from './platform.ts';
import { accountLabel, mainFolder, useAccounts } from './accounts.ts';

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
  projects: Project[]; // for Move to project
  onClaudeFiles: () => void;
  onRemote: (url: string) => void;
  onMove: (s: TermSession, harnessId: string) => void;
  project: Project;
  sessions: TermSession[]; // this project's agent sessions
  canOpen: boolean;
  onOpen: (s: TermSession) => void;
  onStart: (resume?: string, harnessId?: string) => void;
}

export function Agents({ projects, onClaudeFiles, onRemote, onMove, project, sessions, canOpen, onOpen, onStart }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const accounts = useAccounts();
  const multiAccount = accounts.harnesses.filter((h) => h.type === 'claude-code').length > 1;
  const accountOf = (harnessId: string | null) => accounts.harnesses.find((h) => h.id === harnessId);
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
    // Token accounts aren't listed: the Credits switch decides which account "Claude Code" uses.
    const enabled = (await hub.call('harness.list', {})).filter((h) => h.enabled && h.config.mode !== 'token');
    if (enabled.length <= 1) return onStart(undefined, enabled[0]?.id);
    const def = project.defaultHarnessId ?? 'claude-code';
    enabled.sort((a, b) => Number(b.id === def) - Number(a.id === def));
    const choice = await window.workbench.menu(
      enabled.map((h) => ({
        id: h.id,
        label: `${h.name}${h.id === 'claude-code' ? ` (credits: ${accountLabel(accounts.harnesses.find((x) => x.id === accounts.usage))})` : ''}${h.id === def ? '  (default)' : ''}`,
      })),
    );
    if (choice) onStart(undefined, choice);
  };

  const openIds = new Set(sessions.filter((s) => s.status === 'running').map((s) => s.agent?.externalId));

  return (
    <>
      <div className="section-label with-action">
        Agents
        <button onClick={() => void pickHarness()} title={`New agent session (${keys('⌘⇧A')} starts the project default)`} disabled={!canOpen}>
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
                const url = s.status === 'running' ? s.agent?.remoteUrl : null;
                const cur = accountOf(s.harness);
                // Conversations in the main folder can continue on any account that shares it.
                const moves =
                  cur?.type === 'claude-code' && !cur.config.configDir && s.agent?.externalId
                    ? mainFolder(accounts.harnesses).filter((h) => h.id !== cur.id)
                    : [];
                const items = [
                  ...(url
                    ? [
                        { id: 'here', label: 'Open on claude.ai (in Workbench)' },
                        { id: 'browser', label: 'Open in browser' },
                        { id: 'copy', label: 'Copy Remote Control link' },
                      ]
                    : []),
                  ...(url && moves.length ? [{ type: 'separator' as const }] : []),
                  ...moves.map((h) => ({ id: `move:${h.id}`, label: `Continue on ${accountLabel(h)}` })),
                ];
                if (!items.length) return;
                void window.workbench.menu(items).then((c) => {
                  if (c === 'here' && url) onRemote(url);
                  if (c === 'browser' && url) window.open(url); // main process hands it to the browser
                  if (c === 'copy' && url) void navigator.clipboard.writeText(url);
                  if (c?.startsWith('move:')) onMove(s, c.slice(5));
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
                  {multiAccount && s.harness && accountOf(s.harness)?.type === 'claude-code' ? `${accountLabel(accountOf(s.harness))} · ` : ''}
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

      <button className="disclosure" onClick={onClaudeFiles} title="Instructions, settings, agents, skills and this project's memory">
        ▸ Claude files
      </button>
      <button className="disclosure" onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? '▾' : '▸'} Conversation history
      </button>
      {showHistory && (
        <ul className="list history">
          {!project.rootPath && <li className="empty">Set a project folder to see its conversation history.</li>}
          {project.rootPath && history === null && <li className="empty">Loading…</li>}
          {project.rootPath && history?.length === 0 && <li className="empty">No past sessions in this folder.</li>}
          {history?.map((h) => (
            <li key={h.id}>
              <button
                onClick={() => onStart(h.id, h.harnessId)}
                disabled={!canOpen}
                title={h.firstPrompt ?? h.title}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (h.provider === 'openai-codex') return;
                  void window.workbench
                    .menu([
                      ...projects
                        .filter((p) => p.id !== project.id)
                        .map((p) => ({ id: p.id, label: `Move to ${p.name}` })),
                      ...(h.movedHere ? [{ type: 'separator' as const }, { id: '__back', label: 'Back to the folder it was started in' }] : []),
                    ])
                    .then(async (id) => {
                      if (!id) return;
                      await hub.call('claude.assign', { transcriptId: h.id, projectId: id === '__back' ? null : id });
                      setHistory((list) => list?.filter((x) => x.id !== h.id) ?? null);
                    });
                }}
              >
                <span className="agent-text">
                  <span className="agent-title">
                    {openIds.has(h.id) && <span className="dot agent-idle" />} {h.title}
                    {h.movedHere && <span className="muted" title="Filed here; started in another folder"> ↪</span>}
                  </span>
                  <span className="agent-activity">
                    {ago(h.updatedAt)}
                    {h.provider === 'openai-codex' ? ' · OpenAI Codex' : accountNames[h.harnessId] ? ` · ${accountNames[h.harnessId]}` : ''} · resume
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
