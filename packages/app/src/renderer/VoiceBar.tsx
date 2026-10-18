import { useEffect, useRef, useState } from 'react';
import type { VoiceEngine, VoiceUpdate } from '@workbench/shared';
import { hub } from './hub.ts';
import { micError, Recorder } from './voice.ts';

// Per-viewer convenience only; storage may be unavailable.
const LIVE_KEY = 'workbench.voice.live';
const loadLive = () => {
  try {
    return localStorage.getItem(LIVE_KEY) !== 'off';
  } catch {
    return true;
  }
};
const saveLive = (v: boolean) => {
  try {
    localStorage.setItem(LIVE_KEY, v ? 'on' : 'off');
  } catch {}
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const basename = (p: string) => p.split('/').pop() ?? p;
const fileLine = (u: VoiceUpdate) => `[voice memo: ${u.file}${u.transcriptFile ? ` — transcript: ${u.transcriptFile}` : ''}]`;

interface Props {
  paste: (text: string) => void; // into the pane, as a paste
  onClose: () => void;
}

// Speak into the pane. "Type as I speak": settled text lands in the pane while
// you talk (dictation). Otherwise the recording becomes a memo you review and
// insert afterwards, with or without the saved file paths for the agent to read.
export function VoiceBar({ paste, onClose }: Props) {
  const rec = useRef<Recorder | null>(null);
  rec.current ??= new Recorder();
  const idRef = useRef<string | null>(null); // the recording this bar is showing
  const typed = useRef(''); // final text already pasted (live mode)
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const [u, setU] = useState<VoiceUpdate | null>(null);
  const [live, setLiveState] = useState(loadLive);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [inserted, setInserted] = useState(false);
  const recording = u?.state === 'starting' || u?.state === 'listening';
  const finishing = u?.state === 'finishing';
  const finished = u?.state === 'done' || u?.state === 'failed';

  useEffect(() => {
    hub.call('voice.engine', {}).then(setEngine, (err) => setError((err as Error).message));
  }, []);
  useEffect(() => {
    rec.current!.onLevel = setLevel;
    const r = rec.current!;
    return () => r.cancel(); // closed while recording: the recording is dropped
  }, []);

  // Newly settled text is pasted at once in live mode.
  const typeNew = (text: string) => {
    const delta = text.slice(typed.current.length);
    if (!delta) return;
    paste((typed.current ? ' ' : '') + delta);
    typed.current = text;
    setInserted(true);
  };

  useEffect(
    () =>
      hub.onPush((p) => {
        if (p.event !== 'voice.update' || p.data.id !== idRef.current) return;
        setU(p.data);
        if (live && p.data.state !== 'failed') typeNew(p.data.text);
        if (p.data.state === 'done' || p.data.state === 'failed') setDraft(p.data.text);
      }),
    [live, paste],
  );

  const start = async () => {
    setError(null);
    setInserted(false);
    setDraft('');
    typed.current = '';
    try {
      const first = await rec.current!.start();
      idRef.current = first.id;
      setU(first);
    } catch (err) {
      setError(micError(err));
    }
  };

  const stop = async () => {
    try {
      const r = await rec.current!.stop();
      setU(r);
      setDraft(r.text);
      if (live && r.state !== 'failed') typeNew(r.text);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const cancel = () => {
    rec.current!.cancel();
    idRef.current = null;
    setU(null);
  };

  const discard = async () => {
    const id = idRef.current;
    idRef.current = null;
    setU(null);
    setDraft('');
    setInserted(false);
    if (id) await hub.call('voice.discard', { id }).catch((err) => setError((err as Error).message));
  };

  const status = !engine
    ? 'checking the speech engine…'
    : !engine.server
      ? 'whisper-server is not installed (brew install whisper-cpp)'
      : !engine.model
        ? 'no speech model found — see Voice in the README'
        : !u
          ? engine.ready
            ? 'ready'
            : 'ready (the model loads on the first recording)'
          : u.state === 'starting'
            ? 'loading the model…'
            : u.state === 'listening'
              ? live
                ? 'listening — settled text goes into the pane'
                : 'listening'
              : u.state === 'finishing'
                ? 'finishing…'
                : u.state === 'done'
                  ? inserted
                    ? 'inserted'
                    : 'review, then insert'
                  : 'recognition failed — the recording was saved';
  const canRecord = !!engine?.server && !!engine?.model;

  return (
    <div className="voice-bar">
      <div className="voice-row">
        {recording || finishing ? (
          <button className="voice-rec on" onClick={() => void stop()} disabled={finishing}>
            {finishing ? 'Finishing…' : '■ Stop'}
          </button>
        ) : (
          <button className="voice-rec" onClick={() => void start()} disabled={!canRecord}>
            ● Record
          </button>
        )}
        {recording && (
          <span className="voice-level" aria-hidden>
            <i style={{ width: `${Math.min(100, level * 400)}%` }} />
          </span>
        )}
        {u && <span className="voice-time">{mmss(u.seconds)}</span>}
        <label className="voice-live" title="Settled text is typed into the pane while you speak. Off: review the whole memo first.">
          <input
            type="checkbox"
            checked={live}
            disabled={recording || finishing}
            onChange={(e) => {
              setLiveState(e.target.checked);
              saveLive(e.target.checked);
            }}
          />
          Type as I speak
        </label>
        <span className="voice-status muted">{status}</span>
        {recording && (
          <button className="link" onClick={cancel}>
            Cancel
          </button>
        )}
        <button
          className="voice-close"
          onClick={() => {
            if (recording) cancel();
            onClose();
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      {(recording || finishing) && u && (u.text || u.partial) && (
        <div className="voice-text">
          <span>{u.text}</span>
          {u.partial && <span className="voice-partial"> {u.partial}</span>}
        </div>
      )}
      {finished && u && (
        <>
          <textarea
            className="voice-draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 110) + 1))}
            spellCheck
          />
          <div className="voice-actions">
            <button
              className="action primary"
              disabled={!draft.trim() || (inserted && draft === u.text)}
              onClick={() => {
                paste(draft);
                setInserted(true);
              }}
              title={inserted ? 'Insert the edited text again' : 'Type the transcript into the pane'}
            >
              {inserted ? 'Insert again' : 'Insert'}
            </button>
            <button
              className="action"
              disabled={!u.file}
              onClick={() => {
                paste(inserted ? fileLine(u) : `${draft.trim()}\n\n${fileLine(u)}`);
                setInserted(true);
              }}
              title="Also give the agent the paths of the recording and transcript"
            >
              {inserted ? 'Insert file paths' : 'Insert with files'}
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
      {(error || u?.error) && <div className="voice-error">{error ?? u?.error}</div>}
    </div>
  );
}
