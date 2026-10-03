import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { TermSession, TermStatus } from '@workbench/shared';
import type { DB } from './db/index.ts';
import { scrollbackDir } from './paths.ts';
import type { Client } from './server.ts';

const SCROLLBACK_LINES = 10_000; // live buffer, mirrored by the app's xterm
const CHUNK_BYTES = 256 * 1024; // scrollback_chunks granularity on disk
const DISK_TAIL_BYTES = 512 * 1024; // snapshot for sessions from a previous hub run
const FLUSH_MS = 4; // batch PTY output before pushing

interface SessionRow {
  id: string;
  project_id: string;
  title: string | null;
  cwd: string;
  status: TermStatus;
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
}

interface Live {
  info: TermSession;
  proc: pty.IPty | null; // null once exited
  screen: headless.Terminal;
  serializer: serialize.SerializeAddon;
  subscribers: Set<Client>;
  holding: Map<Client, string[]>; // clients mid-attach: output queued until their snapshot is sent
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  logFd: number;
  logBytes: number;
  chunk: { seq: number; start: number; tsStart: number };
}

const logPath = (id: string) => join(scrollbackDir, `${id}.log`);

// Shell env: the hub's env minus what leaks in from Electron/npm dev launches.
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ELECTRON_') || k.startsWith('npm_') || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Workbench';
  return env;
}

export class Terminals {
  private live = new Map<string, Live>();

  constructor(
    private db: DB,
    private broadcast: (session: TermSession) => void,
  ) {
    // PTYs die with the hub; anything still marked running is from a previous run.
    db.prepare(
      "UPDATE sessions SET status = 'lost', ended_at = ? WHERE kind = 'terminal' AND status = 'running'",
    ).run(Date.now());
  }

  create(projectId: string, cwd: string | undefined, cols: number, rows: number): TermSession {
    const project = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as
      | { root_path: string | null }
      | undefined;
    if (!project) throw new Error('unknown project');
    const dir = cwd ?? project.root_path ?? homedir();
    if (!existsSync(dir)) throw new Error(`directory does not exist: ${dir}`);

    const shell = process.env.SHELL || '/bin/zsh';
    const proc = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: dir, env: shellEnv() });

    const info: TermSession = {
      id: randomUUID(),
      projectId,
      title: shell.split('/').pop() ?? 'shell',
      cwd: dir,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, kind, status, cwd, title, started_at) VALUES (?, ?, 'terminal', 'running', ?, ?, ?)",
      )
      .run(info.id, projectId, dir, info.title, info.startedAt);
    this.event(info, 'session.start', { shell, cwd: dir, pid: proc.pid });

    const screen = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon();
    screen.loadAddon(serializer as never);

    const s: Live = {
      info,
      proc,
      screen,
      serializer,
      subscribers: new Set(),
      holding: new Map(),
      pending: '',
      flushTimer: null,
      logFd: openSync(logPath(info.id), 'a', 0o600),
      logBytes: 0,
      chunk: { seq: 0, start: 0, tsStart: info.startedAt },
    };
    this.live.set(info.id, s);

    screen.onTitleChange((title) => {
      if (!title || title === s.info.title) return;
      s.info.title = title;
      this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, info.id);
      this.broadcast(s.info);
    });
    proc.onData((data) => this.output(s, data));
    proc.onExit(({ exitCode }) => this.exited(s, exitCode));
    return info;
  }

  list(projectId: string): TermSession[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, title, cwd, status, exit_code, started_at, ended_at FROM sessions
         WHERE kind = 'terminal' AND project_id = ? AND (status = 'running' OR ended_at > ?)
         ORDER BY started_at`,
      )
      .all(projectId, Date.now() - 24 * 3600_000) as unknown as SessionRow[];
    return rows.map((r) => this.live.get(r.id)?.info ?? toSession(r));
  }

  // Snapshot + subscribe, with no gap or duplicate between them:
  //  1. flush batched output to current subscribers (it's already in `screen`)
  //  2. hold new output for this client
  //  3. once the parser has drained, serialize; the caller sends the snapshot,
  //     then release() delivers what was held.
  async attach(sessionId: string, client: Client): Promise<{ session: TermSession; snapshot: string; release: () => void }> {
    const s = this.live.get(sessionId);
    if (!s) {
      const row = this.db
        .prepare(
          "SELECT id, project_id, title, cwd, status, exit_code, started_at, ended_at FROM sessions WHERE id = ? AND kind = 'terminal'",
        )
        .get(sessionId) as SessionRow | undefined;
      if (!row) throw new Error('unknown session');
      return { session: toSession(row), snapshot: readTail(logPath(sessionId)), release: () => {} };
    }

    this.flush(s);
    s.subscribers.delete(client);
    s.holding.set(client, []);
    await new Promise<void>((r) => s.screen.write('', r));
    const snapshot = s.serializer.serialize();
    return {
      session: s.info,
      snapshot,
      release: () => {
        const held = s.holding.get(client);
        s.holding.delete(client);
        if (!held) return; // detached meanwhile
        if (held.length) client.push({ event: 'term.data', data: { sessionId, data: held.join('') } });
        s.subscribers.add(client);
      },
    };
  }

  detach(sessionId: string, client: Client): void {
    const s = this.live.get(sessionId);
    s?.subscribers.delete(client);
    s?.holding.delete(client);
  }

  dropClient(client: Client): void {
    for (const s of this.live.values()) {
      s.subscribers.delete(client);
      s.holding.delete(client);
    }
  }

  input(sessionId: string, data: string): void {
    this.live.get(sessionId)?.proc?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.live.get(sessionId);
    if (!s?.proc || cols < 1 || rows < 1) return;
    if (s.screen.cols === cols && s.screen.rows === rows) return;
    s.proc.resize(cols, rows);
    s.screen.resize(cols, rows);
  }

  kill(sessionId: string): void {
    this.live.get(sessionId)?.proc?.kill();
  }

  shutdown(): void {
    for (const s of this.live.values()) s.proc?.kill();
  }

  private output(s: Live, data: string): void {
    s.screen.write(data);
    const bytes = Buffer.from(data);
    writeSync(s.logFd, bytes);
    s.logBytes += bytes.length;
    if (s.logBytes - s.chunk.start >= CHUNK_BYTES) this.closeChunk(s);

    for (const held of s.holding.values()) held.push(data);
    s.pending += data;
    s.flushTimer ??= setTimeout(() => this.flush(s), FLUSH_MS);
  }

  private flush(s: Live): void {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    if (!s.pending) return;
    const push = { event: 'term.data' as const, data: { sessionId: s.info.id, data: s.pending } };
    s.pending = '';
    for (const c of s.subscribers) c.push(push);
  }

  private closeChunk(s: Live): void {
    if (s.logBytes === s.chunk.start) return;
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO scrollback_chunks (session_id, seq, file, byte_start, byte_end, ts_start, ts_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(s.info.id, s.chunk.seq, `${s.info.id}.log`, s.chunk.start, s.logBytes, s.chunk.tsStart, now);
    s.chunk = { seq: s.chunk.seq + 1, start: s.logBytes, tsStart: now };
  }

  private exited(s: Live, exitCode: number): void {
    this.flush(s);
    this.closeChunk(s);
    closeSync(s.logFd);
    s.proc = null;
    s.info.status = 'exited';
    s.info.exitCode = exitCode;
    s.info.endedAt = Date.now();
    this.db
      .prepare("UPDATE sessions SET status = 'exited', exit_code = ?, ended_at = ? WHERE id = ?")
      .run(exitCode, s.info.endedAt, s.info.id);
    this.event(s.info, 'session.end', { exitCode });
    this.broadcast(s.info);
  }

  private event(info: TermSession, kind: string, payload: object): void {
    this.db
      .prepare('INSERT INTO events (ts, project_id, session_id, kind, payload) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), info.projectId, info.id, kind, JSON.stringify(payload));
  }
}

function toSession(r: SessionRow): TermSession {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title ?? 'shell',
    cwd: r.cwd,
    status: r.status,
    exitCode: r.exit_code,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

// Last bytes of a session log, for sessions whose screen is no longer in memory.
function readTail(path: string): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const len = Math.min(size, DISK_TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}
