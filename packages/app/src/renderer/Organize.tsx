import { useEffect, useState } from 'react';
import type { OrganizeGroup } from '@workbench/shared';
import { hub } from './hub.ts';

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

// Review Workbench's guess of which project each conversation belongs to
// (from the files it touched) and file the ones you tick.
export function Organize({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [groups, setGroups] = useState<OrganizeGroup[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void hub.call('claude.organize', {}).then((g) => {
      setGroups(g);
      setPicked(new Set(g.filter((x) => x.isRepo).map((x) => x.root))); // repos ticked; plain folders are a weaker guess
    });
  }, []);

  const apply = async () => {
    if (!groups) return;
    setBusy(true);
    const chosen = groups.filter((g) => picked.has(g.root)).map((g) => ({ root: g.root, transcriptIds: g.conversations.map((c) => c.id) }));
    const r = await hub.call('claude.organizeApply', { groups: chosen });
    onDone(`Filed ${r.moved} conversation${r.moved === 1 ? '' : 's'}${r.created ? `, ${r.created} new project${r.created === 1 ? '' : 's'}` : ''}.`);
    onClose();
  };

  const toggle = (root: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(root)) n.delete(root);
      else n.add(root);
      return n;
    });

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search harness-manager" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hm-head">
          <h2>Organize conversations</h2>
          <span className="muted small">Grouped by where each conversation actually worked (the repo or folder whose files it touched most).</span>
          <button className="hm-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {groups === null && <p className="placeholder-text">Reading your conversations…</p>}
        {groups?.length === 0 && <p className="placeholder-text">Everything is already where it worked.</p>}
        <ul className="hm-list">
          {groups?.map((g) => (
            <li key={g.root} className="org-group">
              <input type="checkbox" checked={picked.has(g.root)} onChange={() => toggle(g.root)} />
              <div className="hm-text">
                <span className="hm-name">
                  {short(g.root)} <span className="muted small">{g.projectId ? '→ existing project' : '→ new project'}{g.isRepo ? '' : ' · folder, not a repo'}</span>
                </span>
                <button className="link org-titles" onClick={() => setOpen(open === g.root ? null : g.root)}>
                  {g.conversations.length} conversation{g.conversations.length === 1 ? '' : 's'}: {g.conversations.slice(0, 3).map((c) => c.title).join(' · ')}
                  {g.conversations.length > 3 ? ' …' : ''}
                </button>
                {open === g.root && (
                  <ul className="org-list">
                    {g.conversations.map((c) => (
                      <li key={c.id}>
                        {c.title} <span className="muted small">started in {short(c.startedIn)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
        {groups && groups.length > 0 && (
          <div className="hm-row hm-actions">
            <button className="action primary" disabled={busy || picked.size === 0} onClick={() => void apply()}>
              File {picked.size} group{picked.size === 1 ? '' : 's'}
            </button>
            <span className="muted small">Conversations still resume in the folder they were started in. Undo any one with right-click → Move to project.</span>
          </div>
        )}
      </div>
    </div>
  );
}
