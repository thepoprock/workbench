import { useState } from 'react';
import type { Idea } from '@workbench/shared';
import { hub } from './hub.ts';
import { revealLabel } from './platform.ts';
import { putIdea } from './ideas.ts';

interface Props {
  ideas: Idea[];
  selected: string | null;
  onSelect: (id: string) => void;
  onError: (msg: string) => void;
}

export function IdeasList({ ideas, selected, onSelect, onError }: Props) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const active = ideas.filter((i) => !i.archived);
  const archived = ideas.filter((i) => i.archived);

  const create = async () => {
    setAdding(false);
    if (!draft.trim()) return;
    try {
      const idea = await hub.call('idea.create', { title: draft });
      putIdea(idea);
      onSelect(idea.id);
    } catch (err) {
      onError((err as Error).message);
    }
    setDraft('');
  };

  const menu = async (i: Idea) => {
    const choice = await window.workbench.menu([
      { id: 'reveal', label: revealLabel },
      { type: 'separator' },
      i.archived ? { id: 'unarchive', label: 'Unarchive' } : { id: 'archive', label: 'Archive' },
    ]);
    try {
      if (choice === 'reveal') await window.workbench.reveal(i.folder);
      if (choice === 'archive' || choice === 'unarchive')
        putIdea(await hub.call('idea.update', { id: i.id, archived: choice === 'archive' }));
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const item = (i: Idea) => (
    <li key={i.id}>
      <button
        className={[i.id === selected ? 'active' : '', i.archived ? 'ended' : ''].join(' ')}
        onClick={() => onSelect(i.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          void menu(i);
        }}
      >
        <span className="idea-name">{i.title}</span>
        <span className={`stage-chip ${i.stage}`}>{i.stage}</span>
      </button>
    </li>
  );

  return (
    <>
      <div className="section-label with-action">
        Ideas
        <button onClick={() => setAdding(true)} title="New idea">
          +
        </button>
      </div>
      <ul className="list">
        {adding && (
          <li>
            <input
              className="rename"
              autoFocus
              placeholder="What's the idea?"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void create()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
                if (e.key === 'Escape') {
                  setDraft('');
                  setAdding(false);
                }
              }}
            />
          </li>
        )}
        {active.map(item)}
        {active.length === 0 && !adding && <li className="empty">None yet</li>}
      </ul>
      {archived.length > 0 && (
        <>
          <button className="disclosure" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '▾' : '▸'} Archived ideas ({archived.length})
          </button>
          {showArchived && <ul className="list">{archived.map(item)}</ul>}
        </>
      )}
    </>
  );
}
