import { useEffect, useState, type DragEvent } from 'react';
import type { Project, SharedWorkbench } from '@workbench/shared';
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

// How many projects show before "Show all", and whether the list is folded away. Per viewer.
const LIMIT_KEY = 'workbench.projectLimit';
const FOLDED_KEY = 'workbench.projectsFolded';
const LIMITS = [5, 10, 15, 20, 0]; // 0: all
const load = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
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
  const [folded, setFolded] = useState(() => load(FOLDED_KEY, 'no') === 'yes');
  const [limit, setLimit] = useState(() => Number(load(LIMIT_KEY, '5')) || 0);
  const [showAll, setShowAll] = useState(false);

  const stored = projects.filter((p) => !p.archived);
  const active =
    sort === 'recent'
      ? [...stored].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      : order
        ? order.map((id) => stored.find((p) => p.id === id)).filter((p): p is Project => !!p)
        : stored;
  const draggable = sort === 'manual';
  const archived = projects.filter((p) => p.archived);
  // The first `limit`, plus the open project if it is further down.
  const cut = limit && !showAll && active.length > limit;
  const shown = cut ? active.filter((p, i) => i < limit || p.id === selected) : active;

  const pickLimit = async () => {
    const choice = await window.workbench.menu(
      LIMITS.map((n) => ({ id: String(n), label: `${n === limit ? '✓ ' : '   '}${n ? `Show ${n}` : 'Show all'}` })),
    );
    if (choice === null || choice === undefined) return;
    setLimit(Number(choice));
    save(LIMIT_KEY, choice);
    setShowAll(false);
  };

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
        <span
          className="fold"
          role="button"
          onClick={() => {
            setFolded(!folded);
            save(FOLDED_KEY, folded ? 'no' : 'yes');
          }}
          title={folded ? 'Show projects' : 'Fold projects away'}
        >
          {folded ? '▸' : '▾'} Projects
        </span>
        <span className="section-actions">
        <button className="sort-toggle" onClick={() => void pickLimit()} title="How many projects to show before “Show all”">
          {limit ? limit : 'All'}
        </button>
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
        </span>
      </div>
      {!folded && (
        <ul className="list">
          {shown.map(item)}
          {active.length === 0 && <li className="empty">No projects yet</li>}
        </ul>
      )}
      {!folded && limit > 0 && active.length > limit && (
        <button className="disclosure" onClick={() => setShowAll(!showAll)}>
          {showAll ? '▴ Show fewer' : `▾ Show all (${active.length - shown.length} more)`}
        </button>
      )}
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

// Other accounts' Workbenches on this Mac (Haven's), read-only: what they have started,
// kept apart from your own projects. Each has its own section, folded like Projects.
const SHARED_POLL_MS = 10_000;
const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function SharedProjects() {
  const [others, setOthers] = useState<SharedWorkbench[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let stop = false;
    const poll = () =>
      void hub.call('shared.workbenches', {}).then(
        (w) => !stop && setOthers(w),
        () => {},
      );
    poll();
    const timer = setInterval(poll, SHARED_POLL_MS);
    const offStatus = hub.onStatus((s) => s === 'connected' && poll()); // the first poll can beat the connection
    return () => {
      stop = true;
      clearInterval(timer);
      offStatus();
    };
  }, []);

  return (
    <>
      {others.map((w) => {
        const folded = load(`workbench.sharedFolded.${w.owner}`, 'no') === 'yes' && !open[w.owner];
        const projects = [...w.projects].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        return (
          <div key={w.owner}>
            <div className="section-label with-action">
              <span
                className="fold"
                role="button"
                onClick={() => {
                  save(`workbench.sharedFolded.${w.owner}`, folded ? 'no' : 'yes');
                  setOpen({ ...open, [w.owner]: folded });
                }}
                title={`${w.owner}'s own Workbench, read-only. ${w.running ? 'Running' : 'Not running'}; updated ${ago(w.updatedAt)}.`}
              >
                {folded ? '▸' : '▾'} {w.owner}'s projects
              </span>
              {!w.running && <span className="muted small">offline</span>}
            </div>
            {!folded && (
              <ul className="list shared">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      className="ended"
                      title={[p.rootPath ?? 'no folder', `last worked in ${ago(p.lastActiveAt)}`, ...p.running.map((r) => `${r.title}${r.state ? ` (${r.state})` : ''}`)].join('\n')}
                    >
                      {p.running.length > 0 && <span className={`dot ${p.running.some((r) => r.state === 'working') ? 'agent-working' : 'agent-idle'}`} />}
                      <span className="idea-name">{p.name}</span>
                    </button>
                  </li>
                ))}
                {projects.length === 0 && <li className="empty">No projects yet</li>}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
}
