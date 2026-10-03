import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { AgentInfo, ScrollbackChunk, SessionKind, TermSession, TermStatus } from '@workbench/shared';
import type { DB } from './db/index.ts';
import { scrollbackDir } from './paths.ts';
import type { Client } from './server.ts';
import { stripAnsi } from './text.ts';

const SCROLLBACK_LINES = 10_000; // live buffer, mirrored by the app's xterm
const CHUNK_BYTES = 256 * 1024; // scrollback_chunks granularity on disk
const DISK_TAIL_BYTES = 512 * 1024; // snapshot for sessions from a previous hub run
const FLUSH_MS = 4; // batch PTY output before pushing
const CHUNK_IDLE_MS = 30_000; // close (and index) a partial chunk after this long

// What to run in the PTY. Default (no spec) is the user's login shell.
export interface SpawnSpec {
  kind: SessionKind;
  harness: string | null;
  file: string;
  args: string[];
  env?: Record<string, string>;
  title: string;
  agent?: AgentInfo;
}

interface SessionRow {
  id: string;
  project_id: string;
  kind: SessionKind;
  harness_id: string | null;
  external_id: string | null;
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
const SESSION_COLS = 'id, project_id, kind, harness_id, external_id, title, cwd, status, exit_code, started_at, ended_at';

// Runtime markers a parent Claude Code session sets. If inherited, a claude
// started in our PTY believes it is a child session and stops saving its
// transcript (seen live: "Transcript saving is off — inherited
// CLAUDE_CODE_CHILD_SESSION marker"). User config vars are left alone.
const CLAUDE_MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_.*|MESSAGING_.*|CHILD_.*))$/;

// Shell env: the hub's env minus what leaks in from Electron/npm dev launches
// and from a parent Claude Code session.
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ELECTRON_') || k.startsWith('npm_') || k === 'NODE_OPTIONS') continue;
    if (CLAUDE_MARKERS.test(k)) continue;
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
    db.prepare("UPDATE sessions SET status = 'lost', ended_at = ? WHERE status = 'running'").run(Date.now());
    this.backfillIndex();
    // Make quiet sessions' recent output searchable without waiting for 256KB.
    setInterval(() => {
      const now = Date.now();
      for (const s of this.live.values()) {
        if (s.proc && s.logBytes > s.chunk.start && now - s.chunk.tsStart >= CHUNK_IDLE_MS) this.closeChunk(s);
      }
    }, CHUNK_IDLE_MS / 2).unref();
  }

  // Chunk list for the viewer; a live session's growing tail is the last entry.
  chunks(sessionId: string): ScrollbackChunk[] {
    const rows = this.db
      .prepare(
        'SELECT seq, byte_start, byte_end, ts_start, ts_end FROM scrollback_chunks WHERE session_id = ? ORDER BY seq',
      )
      .all(sessionId) as { seq: number; byte_start: number; byte_end: number; ts_start: number; ts_end: number }[];
    const out = rows.map((r) => ({
      seq: r.seq,
      byteStart: r.byte_start,
      byteEnd: r.byte_end,
      tsStart: r.ts_start,
      tsEnd: r.ts_end,
    }));
    const s = this.live.get(sessionId);
    if (s && s.logBytes > s.chunk.start) {
      out.push({ seq: s.chunk.seq, byteStart: s.chunk.start, byteEnd: s.logBytes, tsStart: s.chunk.tsStart, tsEnd: Date.now() });
    }
    return out;
  }

  readChunk(sessionId: string, seq: number): string {
    const c = this.chunks(sessionId).find((x) => x.seq === seq);
    if (!c) throw new Error('unknown chunk');
    return readRange(logPath(sessionId), c.byteStart, c.byteEnd);
  }

  // Index chunks closed before this table existed (or before a crash).
  private backfillIndex(): void {
    const missing = this.db
      .prepare(
        `SELECT c.session_id, c.seq, c.byte_start, c.byte_end FROM scrollback_chunks c
         WHERE NOT EXISTS (SELECT 1 FROM scrollback_fts f WHERE f.session_id = c.session_id AND f.seq = c.seq)`,
      )
      .all() as { session_id: string; seq: number; byte_start: number; byte_end: number }[];
    for (const c of missing) {
      if (!existsSync(logPath(c.session_id))) continue;
      this.indexChunk(c.session_id, c.seq, readRange(logPath(c.session_id), c.byte_start, c.byte_end));
    }
  }

  private indexChunk(sessionId: string, seq: number, raw: string): void {
    const text = stripAnsi(raw).trim();
    if (text) this.db.prepare('INSERT INTO scrollback_fts (text, session_id, seq) VALUES (?, ?, ?)').run(text, sessionId, seq);
  }

  // The session id is chosen by the caller when it must be known before spawn
  // (agents bake it into their hook URL).
  create(
    projectId: string,
    cwd: string | undefined,
    cols: number,
    rows: number,
    spec?: SpawnSpec,
    id: string = randomUUID(),
  ): TermSession {
    const project = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as
      | { root_path: string | null }
      | undefined;
    if (!project) throw new Error('unknown project');
    const dir = cwd ?? project.root_path ?? homedir();
    if (!existsSync(dir)) throw new Error(`directory does not exist: ${dir}`);

    const shell = process.env.SHELL || '/bin/zsh';
    const run: SpawnSpec = spec ?? {
      kind: 'terminal',
      harness: null,
      file: shell,
      args: ['-l'],
      title: shell.split('/').pop() ?? 'shell',
    };
    const proc = pty.spawn(run.file, run.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: dir,
      env: { ...shellEnv(), ...run.env },
    });

    const info: TermSession = {
      id,
      projectId,
      kind: run.kind,
      harness: run.harness,
      agent: run.agent ?? null,
      title: run.title,
      cwd: dir,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, harness_id, kind, status, cwd, title, external_id, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
      )
      .run(info.id, projectId, run.harness, run.kind, dir, info.title, info.agent?.externalId ?? null, info.startedAt);
    this.event(info, 'session.start', { file: run.file, args: run.args, cwd: dir, pid: proc.pid });

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

  get(sessionId: string): TermSession | null {
    return this.live.get(sessionId)?.info ?? null;
  }

  // Live or ended.
  info(sessionId: string): TermSession {
    const live = this.live.get(sessionId);
    if (live) return live.info;
    const row = this.db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(sessionId) as SessionRow | undefined;
    if (!row) throw new Error('unknown session');
    return toSession(row);
  }

  // Merge into a live agent's state and tell clients. Persists the harness id.
  updateAgent(sessionId: string, patch: Partial<AgentInfo>): void {
    const s = this.live.get(sessionId);
    if (!s?.info.agent) return;
    const before = JSON.stringify(s.info.agent);
    Object.assign(s.info.agent, patch);
    if (JSON.stringify(s.info.agent) === before) return;
    if (patch.externalId) {
      this.db.prepare('UPDATE sessions SET external_id = ? WHERE id = ?').run(patch.externalId, sessionId);
    }
    this.broadcast(s.info);
  }

  recordEvent(sessionId: string, kind: string, payload: object, text?: string): void {
    const info = this.live.get(sessionId)?.info;
    if (info) this.event(info, kind, payload, text);
  }

  list(projectId: string): TermSession[] {
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_COLS} FROM sessions
         WHERE project_id = ? AND (status = 'running' OR ended_at > ?)
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
    if (!s) return { session: this.info(sessionId), snapshot: readTail(logPath(sessionId)), release: () => {} };

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
    this.indexChunk(s.info.id, s.chunk.seq, readRange(logPath(s.info.id), s.chunk.start, s.logBytes));
    s.chunk = { seq: s.chunk.seq + 1, start: s.logBytes, tsStart: now };
  }

  private exited(s: Live, exitCode: number): void {
    this.flush(s);
    this.closeChunk(s);
    closeSync(s.logFd);
    s.proc = null;
    s.info.status = 'exited';
    s.info.exitCode = exitCode;
    if (s.info.agent) s.info.agent.activity = null;
    s.info.endedAt = Date.now();
    this.db
      .prepare("UPDATE sessions SET status = 'exited', exit_code = ?, ended_at = ? WHERE id = ?")
      .run(exitCode, s.info.endedAt, s.info.id);
    this.event(s.info, 'session.end', { exitCode });
    this.broadcast(s.info);
  }

  private event(info: TermSession, kind: string, payload: object, text?: string): void {
    this.db
      .prepare('INSERT INTO events (ts, project_id, session_id, kind, payload, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), info.projectId, info.id, kind, JSON.stringify(payload), text ?? null);
  }
}

function toSession(r: SessionRow): TermSession {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    harness: r.harness_id,
    agent: r.kind === 'agent' ? { state: 'idle', activity: null, externalId: r.external_id } : null,
    title: r.title ?? 'shell',
    cwd: r.cwd,
    status: r.status,
    exitCode: r.exit_code,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function readRange(path: string, start: number, end: number): string {
  const len = Math.max(0, end - start);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

// Last bytes of a session log, for sessions whose screen is no longer in memory.
function readTail(path: string): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  return readRange(path, size - Math.min(size, DISK_TAIL_BYTES), size);
}
