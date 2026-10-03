import { useEffect, useRef, useState } from 'react';
import { DockviewReact, themeDark, type DockviewApi } from 'dockview-react';
import type { Idea, IdeaStage } from '@workbench/shared';
import { hub } from './hub.ts';
import { IdeaDocPane } from './IdeaDocPane.tsx';
import { putIdea } from './ideas.ts';
import { putSessions, statusClass, useSession } from './sessions.ts';
import { Tab } from './Tab.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { HistoryPane } from './HistoryPane.tsx';

const components = { doc: IdeaDocPane, terminal: TerminalPane, history: HistoryPane };
const tabComponents = { terminal: Tab };
const STAGES: { id: IdeaStage; label: string }[] = [
  { id: 'idea', label: 'Idea' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'promoted', label: 'Promoted' },
];

function addDoc(api: DockviewApi, idea: Idea, file: string): void {
  if (api.getPanel(`doc:${file}`)) return;
  const first = api.panels.find((p) => p.id.startsWith('doc:'));
  api.addPanel({
    id: `doc:${file}`,
    component: 'doc',
    title: file.replace(/\.md$/, ''),
    params: { ideaId: idea.id, file },
    ...(first ? { position: { referencePanel: first.id, direction: 'within' as const } } : {}),
    inactive: file !== 'IDEA.md' && !!first,
  });
}

function addAgent(api: DockviewApi, sessionId: string): void {
  const existing = api.getPanel(sessionId);
  if (existing) return existing.api.setActive();
  const doc = api.panels.find((p) => p.id.startsWith('doc:'));
  api.addPanel({
    id: sessionId,
    component: 'terminal',
    tabComponent: 'terminal',
    title: 'Claude',
    params: { sessionId },
    ...(doc ? { position: { referencePanel: doc.id, direction: 'right' as const } } : {}),
  });
}

interface Props {
  idea: Idea;
  onPromote: (idea: Idea) => void;
  onError: (msg: string) => void;
}

// Workspace for one idea: its documents and its Claude session, side by side.
export function IdeaView({ idea, onPromote, onError }: Props) {
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const [title, setTitle] = useState(idea.title);
  const agent = useSession(idea.sessionId ?? '');
  const ideaRef = useRef(idea);
  ideaRef.current = idea;

  useEffect(() => setTitle(idea.title), [idea.title]);

  // New documents (Claude wrote SPEC.md / PLAN.md) open as tabs.
  useEffect(() => {
    if (!dock) return;
    for (const f of idea.files) addDoc(dock, idea, f);
  }, [dock, idea.files.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = async <T,>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const startClaude = async () => {
    const s = await call(() => hub.call('idea.agent', { id: idea.id, cols: 100, rows: 30 }));
    if (s && dock) {
      putSessions([s]);
      addAgent(dock, s.id);
    }
  };

  const setStage = (stage: IdeaStage) =>
    void call(async () => putIdea(await hub.call('idea.update', { id: idea.id, stage })));

  const rename = () => {
    if (title.trim() && title.trim() !== idea.title)
      void call(async () => putIdea(await hub.call('idea.update', { id: idea.id, title })));
    else setTitle(idea.title);
  };

  const running = agent?.status === 'running';

  return (
    <div className="idea-view">
      <div className="idea-head">
        <input
          className="idea-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="scope stages">
          {STAGES.map((s) => (
            <button
              key={s.id}
              className={idea.stage === s.id ? 'on' : ''}
              disabled={s.id === 'promoted'}
              onClick={() => setStage(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button className="action" onClick={() => void startClaude()}>
          {running ? (
            <>
              <span className={`dot ${statusClass(agent)}`} /> Claude
            </>
          ) : idea.sessionId ? (
            'Continue with Claude'
          ) : (
            'Draft with Claude'
          )}
        </button>
        <button className="action primary" disabled={!!idea.projectId} onClick={() => onPromote(idea)}>
          {idea.projectId ? 'Promoted' : 'Promote to project…'}
        </button>
      </div>
      <DockviewReact
        className="dock"
        theme={themeDark}
        components={components}
        tabComponents={tabComponents}
        onReady={({ api }) => {
          for (const f of ideaRef.current.files) addDoc(api, ideaRef.current, f);
          if (ideaRef.current.sessionId) {
            // Reattach a running agent; an ended one is reachable via "Continue".
            hub
              .call('term.get', { sessionId: ideaRef.current.sessionId })
              .then((session) => {
                putSessions([session]);
                if (session.status === 'running') addAgent(api, session.id);
              })
              .catch(() => {});
          }
          setDock(api);
        }}
      />
    </div>
  );
}
