import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ScrollbackChunk, TermSession } from '@workbench/shared';
import { hub } from './hub.ts';

export interface HistoryParams {
  sessionId: string;
  seq?: number; // open at this chunk
  ts?: number; // …or at the chunk covering this time
}

const theme = { background: '#0f1115', foreground: '#c9ccd3', cursor: '#0f1115', selectionBackground: '#2a3b57' };
const time = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function pick(chunks: ScrollbackChunk[], p: HistoryParams): number {
  if (p.seq !== undefined && chunks.some((c) => c.seq === p.seq)) return p.seq;
  if (p.ts !== undefined) {
    const c = chunks.find((c) => p.ts! <= c.tsEnd) ?? chunks.at(-1);
    if (c) return c.seq;
  }
  return chunks.at(-1)?.seq ?? 0;
}

// Read-only view of a session's full saved output, one chunk (~256KB) at a time.
// This is how earlier output is reached: xterm can't insert lines above a live screen.
export function HistoryPane({ params, api }: IDockviewPanelProps<HistoryParams>) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [session, setSession] = useState<TermSession | null>(null);
  const [chunks, setChunks] = useState<ScrollbackChunk[]>([]);
  const [seq, setSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new Terminal({
      scrollback: 100_000,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      theme,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    term.current = t;
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(host.current!);
    return () => {
      ro.disconnect();
      t.dispose();
      term.current = null;
    };
  }, []);

  // (Re)load the chunk list whenever the target changes (search results reuse this panel).
  useEffect(() => {
    let cancelled = false;
    hub.call('scrollback.chunks', { sessionId: params.sessionId }).then(
      (r) => {
        if (cancelled) return;
        setSession(r.session);
        setChunks(r.chunks);
        setSeq(pick(r.chunks, params));
        api.setTitle(`History · ${r.session.title}`);
      },
      (err) => !cancelled && setError((err as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [params.sessionId, params.seq, params.ts, api]);

  useEffect(() => {
    if (seq === null) return;
    let cancelled = false;
    hub.call('scrollback.read', { sessionId: params.sessionId, seq }).then(
      (data) => {
        const t = term.current;
        if (cancelled || !t) return;
        t.reset();
        t.write(data, () => t.scrollToBottom());
      },
      (err) => !cancelled && setError((err as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [params.sessionId, seq]);

  const idx = chunks.findIndex((c) => c.seq === seq);
  const cur = chunks[idx];

  return (
    <div className="history-pane">
      <div className="history-bar">
        <button disabled={idx <= 0} onClick={() => setSeq(chunks[idx - 1].seq)}>
          ◀ Earlier
        </button>
        <span className="history-pos">
          {chunks.length === 0
            ? error ?? 'No saved output'
            : `Part ${idx + 1} of ${chunks.length} · ${time(cur.tsStart)} – ${time(cur.tsEnd)}`}
        </span>
        <button disabled={idx < 0 || idx >= chunks.length - 1} onClick={() => setSeq(chunks[idx + 1].seq)}>
          Later ▶
        </button>
        <span className="history-status">{session?.status === 'running' ? 'live session' : session?.status}</span>
      </div>
      <div className="term-host history-term" ref={host} />
    </div>
  );
}
