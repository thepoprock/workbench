import { useEffect, useState, type DragEvent } from 'react';
import type { Project } from '@workbench/shared';
import { revealLabel } from './platform.ts';
import { hub } from './hub.ts';

// Recent: last worked in at the top. Manual: the drag-to-sort order. Per viewer.
type SortMode = 'recent' | 'manual';
const SORT_KEY = 'workbench.projectSort';
const loadSort = (): SortMode => {
  try {
    return localStorage.getItem(SORT_KEY) === 'manual' ? 'manual' : 'recent';
  } catch {
    return 'recent';
  }
};
const saveSort = (mode: SortMode) => {
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch {}
};

interface Props {
  onImport: () => void; // add every folder Claude has been used in
  onOrganize: () => void; // file conversations under the project they worked in
  errorCounts: Record<string, number>; // open errors per project
  projects: Project[]; // active and archived
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}

export function Projects({ onImport, onOrganize, errorCounts, projects, selected, onSelect, onChanged, onError }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<SortMode>(loadSort);
  // Drag to sort: the order shown while the hub is told, and the item in flight.
  const [order, setOrder] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  useEffect(() => setOrder(null), [projects]); // the hub's order arrived

  const stored = projects.filter((p) => !p.archived);
  const active =
    sort === 'recent'
      ? [...stored].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      : order
        ? order.map((id) => stored.find((p) => p.id === id)).filter((p): p is Project => !!p)
        : stored;
  const draggable = sort === 'manual';
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
    const harnesses = p.archived ? [] : (await hub.call('harness.list', {})).filter((h) => h.enabled);
    const def = p.defaultHarnessId ?? 'claude-code';
    const choice = await window.workbench.menu(
      p.archived
        ? [{ id: 'unarchive', label: 'Unarchive' }]
        : [
            { id: 'rename', label: 'Rename' },
            { id: 'folder', label: p.rootPath ? 'Change Folder…' : 'Set Folder…' },
            { id: 'reveal', label: revealLabel, enabled: !!p.rootPath },
            { type: 'separator' },
            ...harnesses.map((h) => ({ id: `harness:${h.id}`, label: `${h.id === def ? '✓ ' : '   '}Default agent: ${h.name}` })),
            { type: 'separator' },
            { id: 'archive', label: 'Archive' },
          ],
    );
    if (choice?.startsWith('harness:')) {
      const id = choice.slice('harness:'.length);
      await run(() => hub.call('project.update', { id: p.id, defaultHarnessId: id === 'claude-code' ? null : id }));
      return;
    }
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

  const dragOver = (p: Project, e: DragEvent<HTMLElement>) => {
    if (!drag || drag.id === p.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (drag.over !== p.id || drag.after !== after) setDrag({ ...drag, over: p.id, after });
  };

  const drop = (target: Project, e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (!drag || drag.id === target.id) return setDrag(null);
    const ids = active.map((p) => p.id).filter((id) => id !== drag.id);
    ids.splice(ids.indexOf(target.id) + (drag.after ? 1 : 0), 0, drag.id);
    setDrag(null);
    setOrder(ids);
    void run(() => hub.call('project.reorder', { ids })).finally(() => setOrder(null));
  };

  const item = (p: Project) => (
    <li
      key={p.id}
      className={[drag?.id === p.id ? 'dragging' : '', drag?.over === p.id ? (drag.after ? 'drop-after' : 'drop-before') : ''].join(' ')}
      onDragOver={(e) => draggable && !p.archived && dragOver(p, e)}
      onDrop={(e) => draggable && !p.archived && drop(p, e)}
    >
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
          draggable={draggable && !p.archived}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', p.id);
            e.dataTransfer.effectAllowed = 'move';
            setDrag({ id: p.id, over: null, after: false });
          }}
          onDragEnd={() => setDrag(null)}
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
      <div className="section-label with-action">
        Projects
        <button
          className="sort-toggle"
          onClick={() => {
            const next = sort === 'recent' ? 'manual' : 'recent';
            setSort(next);
            saveSort(next);
          }}
          title={sort === 'recent' ? 'Most recently worked in at the top — click to use your drag order' : 'Your drag order — click to sort by most recent'}
        >
          {sort === 'recent' ? 'Recent' : 'Manual'}
        </button>
      </div>
      <ul className="list">
        {active.map(item)}
        {active.length === 0 && <li className="empty">No projects yet</li>}
      </ul>
      <button className="disclosure" onClick={onImport} title="Create a project for every folder you've used Claude in">
        ⤓ Import from Claude
      </button>
      <button className="disclosure" onClick={onOrganize} title="File conversations under the project they actually worked in">
        ⇄ Organize conversations…
      </button>
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
