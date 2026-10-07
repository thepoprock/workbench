import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TermSession } from '@workbench/shared';
import { hub } from './hub.ts';
import { openHistory, replaceTerminal } from './dock.ts';
import { useSession } from './sessions.ts';
import { accountLabel, mainFolder, useAccounts } from './accounts.ts';

export interface TerminalParams {
  sessionId: string;
}

const SCROLLBACK_LINES = 10_000; // matches the hub's live buffer

const theme = {
  background: '#0f1115',
  foreground: '#e6e8ec',
  cursor: '#6aa8ff',
  selectionBackground: '#2a3b57',
  black: '#1b1e25',
  brightBlack: '#5c6370',
};

const dim = (s: string) => `\r\n\x1b[2m[${s}]\x1b[0m\r\n`;

function endNotice(s: TermSession): string | null {
  if (s.status === 'lost') return dim('session ended — the hub restarted');
  if (s.status === 'exited') return dim(`process exited${s.exitCode !== null ? ` with code ${s.exitCode}` : ''}`);
  return null;
}

// A view onto a hub-owned PTY. Mounting attaches (snapshot, then live stream);
// unmounting only detaches — the process keeps running in the hub.
export function TerminalPane({ params, api, containerApi }: IDockviewPanelProps<TerminalParams>) {
  const host = useRef<HTMLDivElement>(null);
  const session = useSession(params.sessionId);
  const accounts = useAccounts();
  const [moving, setMoving] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const limited = session?.status === 'running' && session.agent?.state === 'limited';
  const current = accounts.harnesses.find((h) => h.id === session?.harness);
  const alternatives = current && !current.config.configDir ? mainFolder(accounts.harnesses).filter((h) => h.id !== current.id) : [];

  const moveTo = async (harnessId: string) => {
    setMoving(harnessId);
    setMoveError(null);
    try {
      const next = await hub.call('agent.move', { sessionId: params.sessionId, harnessId });
      replaceTerminal(containerApi, params.sessionId, next.id, next.title);
    } catch (err) {
      setMoving(null);
      setMoveError((err as Error).message);
    }
  };

  useEffect(() => {
    const sessionId = params.sessionId;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      // DOM renderer fallback
    }

    let disposed = false;
    let live = false; // true once the snapshot for the current attach is written
    let status: TermSession['status'] = 'running';
    let lastSize = '';

    const sendSize = (force = false) => {
      try {
        fit.fit();
      } catch {
        return; // hidden / zero-size
      }
      const size = `${term.cols}x${term.rows}`;
      if (size === lastSize && !force) return;
      lastSize = size;
      if (status === 'running') hub.notify('term.resize', { sessionId, cols: term.cols, rows: term.rows });
    };

    // The hub sends the attach response before any data for this attach, so
    // anything that arrives earlier is stale (already in the snapshot): drop it.
    const offPush = hub.onPush((p) => {
      if (p.event === 'term.data' && p.data.sessionId === sessionId) {
        if (live) term.write(p.data.data);
      } else if (p.event === 'term.update' && p.data.id === sessionId) {
        api.setTitle(p.data.title);
        if (status === 'running' && p.data.status !== 'running') {
          status = p.data.status;
          const notice = endNotice(p.data);
          if (notice) term.write(notice);
        }
      }
    });

    const attach = async () => {
      live = false;
      try {
        const { session, snapshot } = await hub.call('term.attach', { sessionId });
        if (disposed) return;
        term.reset();
        term.write(snapshot);
        status = session.status;
        api.setTitle(session.title);
        live = true;
        const notice = endNotice(session);
        if (notice) term.write(notice);
        sendSize(true);
      } catch (err) {
        if (!disposed) term.write(`\x1b[31m${(err as Error).message}\x1b[0m\r\n`);
      }
    };

    if (hub.status === 'connected') void attach();
    const offStatus = hub.onStatus((s) => {
      if (s === 'connected') void attach();
      else live = false;
    });

    const input = term.onData((data) => {
      if (status === 'running') hub.notify('term.input', { sessionId, data });
    });
    const ro = new ResizeObserver(() => sendSize());
    ro.observe(host.current!);
    const active = api.onDidActiveChange((e) => {
      if (e.isActive) term.focus();
    });
    if (api.isActive) term.focus();

    return () => {
      disposed = true;
      ro.disconnect();
      active.dispose();
      input.dispose();
      offPush();
      offStatus();
      hub.notify('term.detach', { sessionId });
      term.dispose();
    };
  }, [params.sessionId, api]);

  return (
    <div className="term-wrap">
      <div className="term-host" ref={host} />
      {session?.status === 'running' && alternatives.length > 0 && (
        <button
          className="account-chip"
          disabled={!!moving}
          title="Which account this conversation runs (and bills) on — click to continue it on another"
          onClick={() =>
            void window.workbench
              .menu([
                { id: '__now', label: `Running on ${accountLabel(current)}`, enabled: false },
                { type: 'separator' },
                ...alternatives.map((h) => ({
                  id: h.id,
                  label: `Continue on ${accountLabel(h)}${session.agent?.state === 'working' ? ' (interrupts the current reply)' : ''}`,
                })),
              ])
              .then((id) => id && void moveTo(id))
          }
        >
          {moving ? 'Switching…' : `${accountLabel(current)} ▾`}
        </button>
      )}
      {moveError && !limited && <div className="limit-banner"><span className="limit-error">{moveError}</span></div>}
      {limited && (
        <div className="limit-banner">
          <span>
            <b>{accountLabel(current)}</b> hit its usage limit.
            {alternatives.length === 0 && ' Add another account (Harnesses → Add Claude account) to keep going.'}
            {moveError && <span className="limit-error"> {moveError}</span>}
          </span>
          {alternatives.map((h) => (
            <button key={h.id} disabled={!!moving} onClick={() => void moveTo(h.id)}>
              {moving === h.id ? 'Moving…' : `Continue on ${accountLabel(h)}`}
            </button>
          ))}
        </div>
      )}
      <button
        className="earlier"
        title="Browse this session's full saved output"
        onClick={() => openHistory(containerApi, { sessionId: params.sessionId })}
      >
        Earlier output
      </button>
    </div>
  );
}
