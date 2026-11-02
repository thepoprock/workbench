import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { HavenMessage } from '@workbench/shared';
import { hub } from './hub.ts';
import { clearNotice, onPhone, play, setAutoPlay, stopPlaying, useHaven } from './haven.ts';
import { micError, Recorder } from './voice.ts';

const NAMES = { you: 'You', claude: 'Claude', haven: 'Haven', notice: '' };

// Just enough Markdown for chat: bold and code, with the line breaks as written.
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((piece, i) =>
        piece.startsWith('**') ? (
          <strong key={i}>{piece.slice(2, -2)}</strong>
        ) : piece.startsWith('`') ? (
          <code key={i}>{piece.slice(1, -1)}</code>
        ) : (
          piece
        ),
      )}
    </>
  );
}

function Message({ m, playing }: { m: HavenMessage; playing: boolean }) {
  return (
    <div className={`haven-message from-${m.from}`}>
      {NAMES[m.from] && <div className="haven-name">{NAMES[m.from]}</div>}
      <div className="haven-text">
        <Rich text={m.text} />
      </div>
      {m.from === 'haven' && (
        <button className="haven-play" onClick={() => void (playing ? stopPlaying() : play(m.t))}>
          {playing ? '■ Stop' : '▶ Play'}
        </button>
      )}
    </div>
  );
}

// Haven's own place: not a project, and it stays open over whatever project was showing.
export function HavenView({ onError }: { onError: (message: string) => void }) {
  const haven = useHaven();
  const [draft, setDraft] = useState('');
  const [recording, setRecording] = useState(false);
  const [hearing, setHearing] = useState(false);
  const recorder = useRef(new Recorder());
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView();
  }, [haven.messages.length]);
  useEffect(() => () => recorder.current.cancel(), []);

  const send = async (text: string) => {
    if (!text.trim()) return;
    try {
      await hub.call('haven.send', { text: text.trim() });
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
    setDraft('');
  };

  // One press starts, the next sends. The recording is dropped once it's text.
  const pressMic = async () => {
    const r = recorder.current;
    try {
      if (!recording) {
        await r.start();
        return setRecording(true);
      }
      setRecording(false);
      setHearing(true);
      const { id, text } = await r.stop();
      void hub.call('voice.discard', { id }).catch(() => {});
      await send(text);
    } catch (err) {
      setRecording(false);
      onError(micError(err));
    } finally {
      setHearing(false);
    }
  };

  const status = !haven.online ? 'Not reachable' : haven.busy ? 'Thinking…' : 'Here';

  return (
    <div className="haven-view">
      <div className="titlebar drag haven-bar">
        <span className="titlebar-name">Haven</span>
        <span className={`haven-status ${haven.online ? '' : 'off'}`}>{status}</span>
        <span className="haven-controls">
          {onPhone ? (
            <label title="Play new replies by themselves. Turn this on when your AirPods are in.">
              <input type="checkbox" checked={haven.autoPlay} onChange={(e) => setAutoPlay(e.target.checked)} /> Auto-play
            </label>
          ) : (
            <label title="Talk without pressing anything. Say “Haven” to start; replies then need no name for two minutes.">
              <input
                type="checkbox"
                checked={haven.listening}
                onChange={(e) => void hub.call('haven.listen', { on: e.target.checked }).catch((err) => onError((err as Error).message))}
              />{' '}
              Listen
            </label>
          )}
        </span>
      </div>
      <div className="haven-messages">
        {haven.messages.map((m) => (
          <Message key={m.t} m={m} playing={haven.playing === m.t} />
        ))}
        <div ref={end} />
      </div>
      {haven.notice && (
        <div className="haven-notice" onClick={clearNotice}>
          {haven.notice}
        </div>
      )}
      <form className="haven-compose" onSubmit={submit}>
        <button type="button" className={`haven-mic ${recording ? 'on' : ''}`} disabled={hearing} onClick={() => void pressMic()} title="Press to talk, press again to send">
          {hearing ? '…' : recording ? '■' : '🎤'}
        </button>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message Haven…" />
        <button type="submit" className="haven-send" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
