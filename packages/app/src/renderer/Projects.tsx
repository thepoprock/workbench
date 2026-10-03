import { useState } from 'react';
import type { Project } from '@workbench/shared';
import { hub } from './hub.ts';

interface Props {
  errorCounts: Record<string, number>; // open errors per project
  projects: Project[]; // active and archived
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}

export function Projects({ errorCounts, projects, selected, onSelect, onChanged, onError }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const startRename = (p: Project) => {
    setEditing(p.id);
    setDraft(p.name);
  };

  const commitRename = (p: Project) => {
    setEditing(null);
    if (draft.trim() && draft.trim() !== p.name) void run(() => hub.call('project.update', { id: p.id, name: draft }));
  };

  const contextMenu = async (p: Project) => {
    const choice = await window.workbench.menu(
      p.archived
        ? [{ id: 'unarchive', label: 'Unarchive' }]
        : [
            { id: 'rename', label: 'Rename' },
            { id: 'folder', label: p.rootPath ? 'Change Folder…' : 'Set Folder…' },
            { id: 'reveal', label: 'Show in Finder', enabled: !!p.rootPath },
            { type: 'separator' },
            { id: 'archive', label: 'Archive' },
          ],
    );
    switch (choice) {
      case 'rename':
        return startRename(p);
      case 'folder': {
        const dir = await window.workbench.pickFolder(p.rootPath ?? undefined);
        if (dir) await run(() => hub.call('project.update', { id: p.id, rootPath: dir }));
        return;
      }
      case 'reveal':
        if (p.rootPath) await window.workbench.reveal(p.rootPath);
        return;
      case 'archive':
        await run(async () => {
          await hub.call('project.archive', { id: p.id, archived: true });
          if (selected === p.id) onSelect(null);
        });
        return;
      case 'unarchive':
        await run(() => hub.call('project.archive', { id: p.id, archived: false }));
        return;
    }
  };

  const item = (p: Project) => (
    <li key={p.id}>
      {editing === p.id ? (
        <input
          className="rename"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => commitRename(p)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(p);
            if (e.key === 'Escape') setEditing(null);
          }}
        />
      ) : (
        <button
          className={[p.id === selected ? 'active' : '', p.archived ? 'ended' : ''].join(' ')}
          onClick={() => !p.archived && onSelect(p.id)}
          onDoubleClick={() => !p.archived && startRename(p)}
          onContextMenu={(e) => {
            e.preventDefault();
            void contextMenu(p);
          }}
          title={p.rootPath ?? 'No folder — right-click to set one'}
        >
          <span className="idea-name">{p.name}</span>
          {!p.archived && errorCounts[p.id] ? <span className="err-count">{errorCounts[p.id]}</span> : null}
        </button>
      )}
    </li>
  );

  return (
    <>
      <ul className="list">
        {active.map(item)}
        {active.length === 0 && <li className="empty">No projects yet</li>}
      </ul>
      {archived.length > 0 && (
        <>
          <button className="disclosure" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '▾' : '▸'} Archived ({archived.length})
          </button>
          {showArchived && <ul className="list">{archived.map(item)}</ul>}
        </>
      )}
    </>
  );
}
