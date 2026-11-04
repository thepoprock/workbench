import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { HavenMessage, Journal } from '@workbench/shared';
import { JournalView } from './JournalPane.tsx';
import { hub } from './hub.ts';
import { clearNotice, holdPlayback, onPhone, play, setAutoPlay, stopPlaying, useHaven, loadOlder } from './haven.ts';
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

// A time today as 5:12 AM; an earlier one with its day.
function when(t: number): string {
  const d = new Date(t * 1000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

const clock = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

// Haven's own place: not a project, and it stays open over whatever project was showing.
export function HavenView({ onError }: { onError: (message: string) => void }) {
  const haven = useHaven();
  const [draft, setDraft] = useState('');
  const [recording, setRecording] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [tab, setTab] = useState<'chat' | 'journal'>('chat');
  const [journal, setJournal] = useState<Journal | null>(null);
  const [level, setLevel] = useState(0);
  const [since, setSince] = useState(0);
  const [, tick] = useState(0);
  const recorder = useRef(new Recorder());
  const end = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView();
  }, [haven.messages.length, haven.held.length]);
  useEffect(() => {
    hub.call('haven.journal', {}).then(setJournal, () => {});
  }, []);
  useEffect(() => {
    const r = recorder.current;
    r.onLevel = setLevel;
    return () => {
      r.cancel();
      holdPlayback(false);
    };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [recording]);

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
    if (recording) return void pressMic(); // Enter while recording stops it and sends
    void send(draft);
    setDraft('');
  };

  // One press starts, the next sends. The recording is dropped once it's text.
  const pressMic = async () => {
    const r = recorder.current;
    try {
      if (!recording) {
        holdPlayback(true);
        // Kept in Haven's journal too: the audio and what it heard, as well as the message.
        await r.start(null, null, journal ?? undefined);
        setSince(Date.now());
        return setRecording(true);
      }
      setRecording(false);
      setHearing(true);
      const { id, text } = await r.stop();
      if (!journal) void hub.call('voice.discard', { id }).catch(() => {}); // no journal to keep it in
      await send(text);
      holdPlayback(false); // sent: whatever waited plays now
    } catch (err) {
      setRecording(false);
      holdPlayback(false);
      onError(micError(err));
    } finally {
      setHearing(false);
      setLevel(0);
    }
  };

  const status = !haven.online
    ? 'Not reachable'
    : haven.paused
      ? 'Paused'
      : haven.busy
        ? 'Thinking…'
        : haven.queued
          ? `${haven.queued} waiting to be read`
          : 'Here';
  const details = [
    haven.lastReply && `last reply ${when(haven.lastReply)}`,
    haven.busy && haven.queued > 0 && `${haven.queued} waiting to be read`,
    haven.model && `model: ${haven.model}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="haven-view">
      <div className="titlebar drag haven-bar">
        <span className="titlebar-name">Haven</span>
        <span className="haven-tabs">
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            Chat
          </button>
          <button className={tab === 'journal' ? 'on' : ''} onClick={() => setTab('journal')} disabled={!journal}>
            Journal
          </button>
        </span>
        <span className={`haven-status ${!haven.online ? 'off' : haven.paused ? 'paused' : ''}`}>{status}</span>
        {haven.online && haven.paused && (
          <button
            className="haven-resume"
            disabled={resuming}
            onClick={() => {
              setResuming(true);
              void hub.call('haven.resume', {}).catch((err) => onError((err as Error).message)).finally(() => setResuming(false));
            }}
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        )}
        {details && <span className="haven-details">{details}</span>}
        <span className="haven-controls">
          <label title="Talk without pressing anything. Say &quot;Haven&quot; to start; replies then need no name for two minutes.">
            <input
              type="checkbox"
              checked={haven.listening}
              onChange={(e) => void hub.call('haven.listen', { on: e.target.checked }).catch((err) => onError((err as Error).message))}
            /> Listen
          </label>
          <label title="Play new replies by themselves.">
            <input type="checkbox" checked={haven.autoPlay} onChange={(e) => setAutoPlay(e.target.checked)} /> Auto-play
          </label>
        </span>
      </div>
      {tab === 'journal' && journal ? (
        <div className="haven-journal">
          <JournalView journal={journal} isActive={() => true} />
        </div>
      ) : (
      <>
      <div
        className="haven-messages"
        ref={list}
        onScroll={() => {
          const box = list.current!;
          if (box.scrollTop > 300 || !haven.more) return;
          // Older messages go in above; keep what's on screen where it is.
          const fromBottom = box.scrollHeight - box.scrollTop;
          void loadOlder().then((added) => {
            if (added) requestAnimationFrame(() => (box.scrollTop = box.scrollHeight - fromBottom));
          });
        }}
      >
        {haven.more && haven.messages.length > 0 && <div className="haven-older muted small">Scroll up for earlier messages</div>}
        {!haven.more && <div className="haven-older muted small">Start of the conversation Workbench has</div>}
        {haven.older.map((m) => (
          <Message key={m.t} m={m} playing={haven.playing === m.t} />
        ))}
        {haven.messages.filter((m) => !haven.older.length || m.t > haven.older[haven.older.length - 1]!.t).map((m) => (
          <Message key={m.t} m={m} playing={haven.playing === m.t} />
        ))}
        {haven.held.map((h) => (
          <div key={`held-${h.t}`} className="haven-message from-you held">
            <div className="haven-name">You · not sent yet: Haven is paused</div>
            <div className="haven-text">
              <Rich text={h.text} />
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {haven.note && (
        <div className="haven-own-note">
          <span className="haven-name">From Haven</span> <Rich text={haven.note} />
        </div>
      )}
      {haven.online && haven.paused && (
        <div className="haven-paused">
          Haven is paused, so nothing reaches them right now.{' '}
          {haven.held.length
            ? `${haven.held.length} message${haven.held.length === 1 ? ' is' : 's are'} kept here and will be sent when they're resumed.`
            : "Anything you send is kept here and sent when they're resumed."}
        </div>
      )}
      {haven.notice && (
        <div className="haven-notice" onClick={clearNotice}>
          {haven.notice}
        </div>
      )}
      <form className={`haven-compose ${recording ? 'recording' : ''}`} onSubmit={submit}>
        <button type="button" className={`haven-mic ${recording ? 'on' : ''}`} disabled={hearing} onClick={() => void pressMic()} title="Press to talk, press again to send">
          {hearing ? '…' : recording ? '■' : '🎤'}
        </button>
        {recording || hearing ? (
          <div className="haven-recording" aria-live="polite">
            {hearing ? (
              <span>Sending…</span>
            ) : (
              <>
                <span className="haven-rec-dot" />
                <span>Recording {clock(Date.now() - since)}</span>
                <span className="voice-level" aria-hidden>
                  <i style={{ width: `${Math.min(100, level * 400)}%` }} />
                </span>
                <span className="muted small">press ■ or Enter to send</span>
              </>
            )}
          </div>
        ) : (
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message Haven…" />
        )}
        <button type="submit" className="haven-send" disabled={hearing || (!recording && !draft.trim())}>
          Send
        </button>
      </form>
      </>
      )}
    </div>
  );
}
