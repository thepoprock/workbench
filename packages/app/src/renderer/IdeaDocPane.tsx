import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { hub } from './hub.ts';

export interface IdeaDocParams {
  ideaId: string;
  file: string;
}

const SAVE_MS = 600;

// One markdown document of an idea. Preview by default for Claude's documents,
// edit for the user's own notes. Autosaves; picks up changes made on disk
// (by Claude) unless there are unsaved local edits.
export function IdeaDocPane({ params }: IDockviewPanelProps<IdeaDocParams>) {
  const { ideaId, file } = params;
  const [text, setText] = useState<string | null>(null);
  const [editing, setEditing] = useState(file === 'IDEA.md');
  const [conflict, setConflict] = useState(false);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef('');

  const load = async (force = false) => {
    const content = await hub.call('idea.read', { id: ideaId, file });
    if (dirty.current && !force) {
      if (content !== latest.current) setConflict(true);
      return;
    }
    dirty.current = false;
    setConflict(false);
    latest.current = content;
    setText(content);
  };

  useEffect(() => {
    void load(true);
    const off = hub.onPush((p) => {
      if (p.event === 'idea.update' && p.data.id === ideaId) void load();
    });
    return () => {
      off();
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (dirty.current) void hub.call('idea.write', { id: ideaId, file, content: latest.current });
      }
    };
  }, [ideaId, file]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (v: string) => {
    setText(v);
    latest.current = v;
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      saveTimer.current = null;
      await hub.call('idea.write', { id: ideaId, file, content: v });
      if (latest.current === v) dirty.current = false;
    }, SAVE_MS);
  };

  const html = useMemo(
    () => (text === null || editing ? '' : DOMPurify.sanitize(marked.parse(text, { async: false }))),
    [text, editing],
  );

  return (
    <div className="doc-pane">
      <div className="doc-bar">
        <span className="doc-name">{file}</span>
        {conflict && (
          <button className="doc-conflict" onClick={() => void load(true)} title="Discard your unsaved edits and load the file">
            Changed on disk — reload
          </button>
        )}
        <div className="scope">
          <button className={editing ? 'on' : ''} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className={!editing ? 'on' : ''} onClick={() => setEditing(false)}>
            Preview
          </button>
        </div>
      </div>
      {text === null ? null : editing ? (
        <textarea className="doc-edit" value={text} spellCheck onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div className="doc-preview" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
