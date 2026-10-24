import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ClaudeFile } from '@workbench/shared';
import { hub } from './hub.ts';

export interface ClaudeParams {
  projectId: string;
}

const GROUPS: { id: ClaudeFile['group']; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'project', label: 'This project' },
  { id: 'memory', label: 'Memory' },
  { id: 'agents', label: 'Agents, commands & skills' },
];
const SAVE_MS = 700;

// What Claude Code keeps for you: instructions, settings, agents, skills and
// this project's memory. Edits save straight to those files (JSON is checked first).
export function ClaudePane({ params }: IDockviewPanelProps<ClaudeParams>) {
  const [files, setFiles] = useState<ClaudeFile[]>([]);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<ClaudeFile | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void hub.call('claude.files', { projectId: params.projectId }).then((f) => {
      setFiles(f);
      setOpen((o) => o ?? f.find((x) => x.label === 'MEMORY.md') ?? f[0] ?? null);
    });
  }, [params.projectId]);

  useEffect(() => {
    if (!open) return;
    setText(null);
    setStatus('');
    setEditing(!open.path.endsWith('.md'));
    void hub.call('claude.read', { path: open.path }).then(setText, (err) => setStatus((err as Error).message));
  }, [open]);

  const onChange = (v: string) => {
    setText(v);
    setStatus('editing…');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await hub.call('claude.write', { path: open!.path, content: v });
        setStatus('saved');
      } catch (err) {
        setStatus(`not saved: ${(err as Error).message}`);
      }
    }, SAVE_MS);
  };

  const shown = files.filter((f) => !filter || f.label.toLowerCase().includes(filter.toLowerCase()));
  const html = useMemo(
    () => (text === null || editing || !open?.path.endsWith('.md') ? '' : DOMPurify.sanitize(marked.parse(text, { async: false }))),
    [text, editing, open],
  );

  return (
    <div className="claude-pane">
      <div className="claude-files">
        <input className="note-input" placeholder={`Filter ${files.length} files…`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="claude-list">
          {GROUPS.map((g) => {
            const list = shown.filter((f) => f.group === g.id);
            if (!list.length) return null;
            return (
              <div key={g.id}>
                <div className="section-label">
                  {g.label} <span className="muted">{list.length}</span>
                </div>
                {list.map((f) => (
                  <button key={f.path} className={open?.path === f.path ? 'active' : ''} onClick={() => setOpen(f)} title={f.path}>
                    {f.label}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div className="doc-pane">
        <div className="doc-bar">
          <span className="doc-name mono" title={open?.path}>
            {open?.path.replace(/^\/Users\/[^/]+/, '~') ?? ''}
          </span>
          <span className="muted small">{status}</span>
          {open?.path.endsWith('.md') && (
            <div className="scope">
              <button className={editing ? 'on' : ''} onClick={() => setEditing(true)}>
                Edit
              </button>
              <button className={!editing ? 'on' : ''} onClick={() => setEditing(false)}>
                Preview
              </button>
            </div>
          )}
        </div>
        {text === null ? null : editing ? (
          <textarea className="doc-edit" value={text} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <div
            className="doc-preview"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={(e) => {
              // Relative links (MEMORY.md → feedback_x.md) open the file here.
              const a = (e.target as HTMLElement).closest('a');
              const href = a?.getAttribute('href');
              if (!href || /^[a-z]+:/i.test(href) || href.startsWith('#')) return;
              e.preventDefault();
              const dir = open!.path.slice(0, Math.max(open!.path.lastIndexOf('/'), open!.path.lastIndexOf('\\')));
              const target = new URL(decodeURIComponent(href.split('#')[0]), `file://${dir}/`).pathname;
              const f = files.find((x) => x.path === target);
              if (f) setOpen(f);
              else setStatus(`not one of these files: ${href}`);
            }}
          />
        )}
      </div>
    </div>
  );
}
