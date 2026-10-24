import { useEffect, useRef, useState } from 'react';
import type { VoiceUpdate } from '@workbench/shared';
import { hub } from './hub.ts';
import { basename, keys } from './platform.ts';
import { micError, Recorder } from './voice.ts';

// Per-viewer convenience only; storage may be unavailable.
const MEMO_KEY = 'workbench.voice.memo';
const loadMemo = () => {
  try {
    return localStorage.getItem(MEMO_KEY) === 'on';
  } catch {
    return false;
  }
};
const saveMemo = (v: boolean) => {
  try {
    localStorage.setItem(MEMO_KEY, v ? 'on' : 'off');
  } catch {}
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);
const fileLine = (u: VoiceUpdate) => `[voice memo: ${u.file}${u.transcriptFile ? ` — transcript: ${u.transcriptFile}` : ''}]`;

interface Props {
  paste: (text: string) => void; // typed into the pane
  projectId: string | null; // recordings are filed under the pane's project
  sessionId: string;
  toggle: number; // bumped by the 🎤 button / ⌘⇧V: start, or stop when recording
  registerSubmit: (finish: (() => Promise<void>) | null) => void; // Enter in the pane finishes dictation first
  onClose: () => void;
}

// One toggle: the first press starts recording at once, the next stops.
// Dictation (default): settled words are typed into the pane while you speak,
// and the bar goes away when you stop. Memo mode: nothing is typed until you
// review the whole transcript and insert it (optionally with the saved files).
// Esc cancels a recording.
export function VoiceBar({ paste, projectId, sessionId, toggle, registerSubmit, onClose }: Props) {
  const rec = useRef<Recorder | null>(null);
  rec.current ??= new Recorder();
  const idRef = useRef<string | null>(null);
  const typed = useRef(''); // text already typed (dictation)
  const [u, setU] = useState<VoiceUpdate | null>(null);
  const [memo, setMemoState] = useState(loadMemo);
  const memoRef = useRef(memo);
  memoRef.current = memo;
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const busy = useRef(false); // a start or stop is in flight
  const recording = u?.state === 'starting' || u?.state === 'listening';

  const typeNew = (text: string) => {
    const delta = text.slice(typed.current.length).trim();
    if (!delta) return;
    paste((typed.current ? ' ' : '') + delta);
    typed.current = text;
  };

  useEffect(() => {
    const r = rec.current!;
    r.onLevel = setLevel;
    return () => r.cancel(); // pane closed mid-recording: drop it
  }, []);

  useEffect(
    () =>
      hub.onPush((p) => {
        if (p.event !== 'voice.update' || p.data.id !== idRef.current) return;
        setU(p.data);
        if (!memoRef.current && p.data.state !== 'failed') typeNew(p.data.text);
      }),
    [paste],
  );

  const start = async () => {
    setError(null);
    setDraft('');
    typed.current = '';
    try {
      const first = await rec.current!.start(projectId, sessionId);
      idRef.current = first.id;
      setU(first);
    } catch (err) {
      setError(micError(err));
    }
  };

  const stopping = useRef<Promise<void> | null>(null);
  const stop = () => {
    stopping.current ??= doStop().finally(() => {
      stopping.current = null;
    });
    return stopping.current;
  };
  const doStop = async () => {
    try {
      const r = await rec.current!.stop();
      setU(r);
      if (r.state === 'failed') {
        setDraft(r.text);
        setError(r.error);
        return;
      }
      if (!memoRef.current) {
        typeNew(r.text);
        idRef.current = null;
        onClose(); // dictation done: the words are in the pane
        return;
      }
      setDraft(r.text);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Dictating: Enter in the pane waits for the last words before it is sent.
  const dictating = !memo && (u?.state === 'starting' || u?.state === 'listening' || u?.state === 'finishing');
  useEffect(() => {
    registerSubmit(dictating ? () => (rec.current!.id || stopping.current ? stop() : Promise.resolve()) : null);
  }, [dictating]);

  const cancel = () => {
    rec.current!.cancel();
    idRef.current = null;
    onClose();
  };

  // The button / shortcut: start, or stop.
  useEffect(() => {
    if (busy.current) return;
    busy.current = true;
    const run = rec.current!.id ? stop() : start();
    void run.finally(() => {
      busy.current = false;
    });
  }, [toggle]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  const discard = async () => {
    const id = idRef.current;
    idRef.current = null;
    if (id) await hub.call('voice.discard', { id }).catch(() => {});
    onClose();
  };

  const review = !!u && !recording && u.state !== 'finishing' && (memo || u.state === 'failed');

  return (
    <div className="voice-bar">
      <div className="voice-row">
        {recording ? (
          <button className="voice-rec on" onClick={() => void stop()} title={`Stop (${keys('⌘⇧V')} or 🎤)`}>
            ■ {u?.state === 'starting' ? 'Loading…' : 'Stop'}
          </button>
        ) : u?.state === 'finishing' ? (
          <span className="voice-rec on">Finishing…</span>
        ) : (
          <button className="voice-rec" onClick={() => void start()}>
            ● Record
          </button>
        )}
        {recording && (
          <span className="voice-level" aria-hidden>
            <i style={{ width: `${Math.min(100, level * 400)}%` }} />
          </span>
        )}
        {u && <span className="voice-time">{mmss(u.seconds)}</span>}
        <span className="voice-live-text">
          {recording && memo && (u?.text || u?.partial) ? (
            <>
              {tail(u?.text ?? '', u?.partial ? 70 : 140)}
              {u?.partial && <span className="voice-partial"> {tail(u.partial, 70)}</span>}
            </>
          ) : recording && u?.partial ? (
            <span className="voice-partial">{u.partial}</span>
          ) : recording ? (
            <span className="muted">{memo ? 'recording a memo — review before it goes in' : 'speak — words are typed as they settle'}</span>
          ) : null}
        </span>
        <label className="voice-live" title="Off: words are typed into the pane as you speak. On: review the whole memo, then insert it.">
          <input
            type="checkbox"
            checked={memo}
            disabled={recording}
            onChange={(e) => {
              setMemoState(e.target.checked);
              saveMemo(e.target.checked);
            }}
          />
          Memo
        </label>
        <button className="voice-close" onClick={recording ? cancel : onClose} title={recording ? 'Cancel (Esc)' : 'Close'}>
          ×
        </button>
      </div>
      {review && u && (
        <>
          <textarea
            className="voice-draft"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 110) + 1))}
            spellCheck
          />
          <div className="voice-actions">
            <button
              className="action primary"
              disabled={!draft.trim()}
              onClick={() => {
                paste(draft.trim());
                idRef.current = null;
                onClose();
              }}
            >
              Insert
            </button>
            <button
              className="action"
              disabled={!u.file}
              onClick={() => {
                paste(`${draft.trim()} ${fileLine(u)}`);
                idRef.current = null;
                onClose();
              }}
              title="Also give the agent the paths of the recording and transcript"
            >
              Insert with files
            </button>
            <button className="action" onClick={() => void navigator.clipboard.writeText(draft)}>
              Copy
            </button>
            <button className="action" onClick={() => void discard()} title="Delete the recording and its transcript">
              Discard
            </button>
            {u.file && (
              <span className="voice-file muted small" title={u.file}>
                saved {basename(u.file)}
              </span>
            )}
          </div>
        </>
      )}
      {error && <div className="voice-error">{error}</div>}
      {!error && u?.error && recording && <div className="voice-error">{u.error}</div>}
    </div>
  );
}
