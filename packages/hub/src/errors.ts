import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync, unwatchFile, watchFile } from 'node:fs';
import type { ErrorGroup, ErrorOccurrence, ErrorRule, ErrorSource, ErrorStatus } from '@workbench/shared';
import type { DB } from './db/index.ts';
import { stripAnsi } from './text.ts';

// Error tracking: rules turn output lines into occurrences, occurrences are
// fingerprinted into groups, groups carry a status and alert at most once per
// ALERT_EVERY_MS. Every occurrence is also an 'error' event (searchable).

const CONTEXT_BEFORE = 3; // lines kept before a match
const CAPTURE_AFTER_MS = 400; // keep collecting following lines (stack traces) this long
const CAPTURE_AFTER_MAX = 25;
const EVENT_EVERY_MS = 10_000; // store at most one occurrence per error per window (count always increments)
const ALERT_EVERY_MS = 10 * 60_000;
const TAIL_POLL_MS = 2_000;
const MAX_TAIL_READ = 1024 * 1024;
const FIX_RE = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(err-[0-9a-f]{6})\b/gi;

// Conservative defaults, all projects. Each matches the line that names the error.
const DEFAULT_RULES: { label: string; pattern: string }[] = [
  { label: 'Go panic / fatal', pattern: '^(panic: |fatal error: )' },
  { label: 'Python exception', pattern: '^[A-Z][A-Za-z]*(Error|Exception): ' },
  { label: 'TypeScript error', pattern: 'error TS\\d+:' },
  { label: 'npm error', pattern: '^npm ERR! ' },
  { label: 'Rust error', pattern: '^error(\\[E\\d+\\])?: ' },
  { label: 'Structured log ERROR/FATAL', pattern: '\\blevel=(ERROR|FATAL)\\b' },
];

interface Compiled {
  rule: ErrorRule;
  re: RegExp;
}

interface Stream {
  partial: string;
  recent: string[];
  capture: { eventId: number; lines: string[]; until: number } | null;
}

interface GroupRow {
  id: string;
  project_id: string;
  fingerprint: string;
  title: string;
  source: ErrorSource;
  status: ErrorStatus;
  first_seen: number;
  last_seen: number;
  count: number;
  fix_commit: string | null;
  notified_at: number | null;
  notify: number;
}

interface RuleRow {
  id: string;
  project_id: string | null;
  kind: 'output' | 'logfile';
  label: string;
  pattern: string;
  path: string | null;
  enabled: number;
  notify: number;
}

const toRule = (r: RuleRow): ErrorRule => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  label: r.label,
  pattern: r.pattern,
  path: r.path,
  enabled: r.enabled === 1,
  notify: r.notify === 1,
});

const toGroup = (r: GroupRow): ErrorGroup => ({
  id: r.id,
  shortId: `err-${r.id.replace(/-/g, '').slice(0, 6)}`,
  projectId: r.project_id,
  title: r.title,
  source: r.source,
  status: r.status,
  count: r.count,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  fixCommit: r.fix_commit,
});

// Strip what varies between occurrences of the same error.
export function normalize(line: string): string {
  return line
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export class Errors {
  private compiled = new Map<string, Compiled[]>(); // `${projectId}:${kind}` → rules
  private streams = new Map<string, Stream>();
  private tails = new Map<string, { path: string; offset: number }>(); // rule id → tail state

  constructor(
    private db: DB,
    private push: (error: ErrorGroup, alert: boolean) => void,
  ) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM error_rules').get() as { n: number }).n;
    if (n === 0) {
      for (const d of DEFAULT_RULES) {
        db.prepare(
          "INSERT INTO error_rules (id, project_id, kind, label, pattern, enabled, notify, created_at) VALUES (?, NULL, 'output', ?, ?, 1, 1, ?)",
        ).run(randomUUID(), d.label, d.pattern, Date.now());
      }
    }
    this.syncTails();
  }

  // ---- rules ----

  rules(projectId: string): ErrorRule[] {
    return (
      this.db
        .prepare('SELECT * FROM error_rules WHERE project_id IS NULL OR project_id = ? ORDER BY project_id IS NOT NULL, created_at')
        .all(projectId) as unknown as RuleRow[]
    ).map(toRule);
  }

  saveRule(rule: Omit<ErrorRule, 'id'> & { id?: string }): ErrorRule {
    if (!rule.label.trim()) throw new Error('rule needs a label');
    try {
      new RegExp(rule.pattern);
    } catch (err) {
      throw new Error(`invalid pattern: ${(err as Error).message}`);
    }
    if (rule.kind === 'logfile' && !rule.path) throw new Error('a log file rule needs a path');
    const id = rule.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO error_rules (id, project_id, kind, label, pattern, path, enabled, notify, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind, label = excluded.label,
           pattern = excluded.pattern, path = excluded.path, enabled = excluded.enabled, notify = excluded.notify`,
      )
      .run(id, rule.projectId, rule.kind, rule.label.trim(), rule.pattern, rule.path, rule.enabled ? 1 : 0, rule.notify ? 1 : 0, Date.now());
    this.compiled.clear();
    this.syncTails();
    return toRule(this.db.prepare('SELECT * FROM error_rules WHERE id = ?').get(id) as unknown as RuleRow);
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM error_rules WHERE id = ?').run(id);
    this.compiled.clear();
    this.syncTails();
  }

  private rulesFor(projectId: string | null, kind: 'output'): Compiled[] {
    const key = `${projectId}:${kind}`;
    let c = this.compiled.get(key);
    if (!c) {
      const rows = this.db
        .prepare('SELECT * FROM error_rules WHERE enabled = 1 AND kind = ? AND (project_id IS NULL OR project_id = ?)')
        .all(kind, projectId) as unknown as RuleRow[];
      c = rows.map((r) => ({ rule: toRule(r), re: new RegExp(r.pattern) }));
      this.compiled.set(key, c);
    }
    return c;
  }

  // ---- input ----

  // Raw PTY output for a session (or new bytes of a tailed file).
  feed(streamKey: string, projectId: string | null, sessionId: string | null, raw: string, only?: Compiled): void {
    if (!projectId) return;
    let st = this.streams.get(streamKey);
    if (!st) {
      st = { partial: '', recent: [], capture: null };
      this.streams.set(streamKey, st);
    }
    const lines = (st.partial + stripAnsi(raw)).split('\n');
    st.partial = lines.pop() ?? '';
    if (st.partial.length > 4096) st.partial = st.partial.slice(-4096);
    const rules = only ? [only] : this.rulesFor(projectId, 'output');

    for (const line of lines) {
      const now = Date.now();
      if (st.capture) {
        if (now <= st.capture.until && st.capture.lines.length < CAPTURE_AFTER_MAX) st.capture.lines.push(line);
        else this.finishCapture(st);
      }
      const hit = line.trim() && rules.find((c) => c.re.test(line));
      if (hit) {
        this.finishCapture(st);
        const text = [...st.recent, line].join('\n');
        const eventId = this.record(projectId, only ? 'logfile' : 'terminal', line.trim(), text, sessionId, hit.rule.notify);
        if (eventId) st.capture = { eventId, lines: [], until: now + CAPTURE_AFTER_MS };
      }
      st.recent.push(line);
      if (st.recent.length > CONTEXT_BEFORE) st.recent.shift();
    }
  }

  endStream(streamKey: string): void {
    const st = this.streams.get(streamKey);
    if (st) this.finishCapture(st);
    this.streams.delete(streamKey);
  }

  agentToolFailure(projectId: string | null, sessionId: string, hook: Record<string, unknown>): void {
    if (!projectId || hook.is_interrupt) return;
    const err = String(hook.error ?? '').trim();
    if (!err) return;
    const tool = String(hook.tool_name ?? 'tool');
    // "Exit code 1\ncat: x: No such file" → title from the first real message line.
    const lines = err.split('\n').filter((l) => l.trim() && !/^Exit code \d+$/.test(l.trim()));
    const title = `${tool}: ${(lines[0] ?? err).trim()}`.slice(0, 300);
    const input = hook.tool_input as Record<string, unknown> | undefined;
    const cmd = typeof input?.command === 'string' ? `$ ${input.command}\n` : '';
    this.record(projectId, 'agent-tool', title, cmd + err, sessionId, false);
  }

  agentExit(projectId: string | null, sessionId: string, exitCode: number): void {
    if (!projectId) return;
    this.record(projectId, 'agent-exit', `Agent exited with code ${exitCode}`, `exit code ${exitCode}`, sessionId, true);
  }

  // A commit saying "fixes err-ab12cd" resolves that error.
  commit(projectId: string, sha: string, message: string): void {
    for (const m of message.matchAll(FIX_RE)) {
      const prefix = m[1].slice(4);
      const rows = this.db.prepare('SELECT * FROM errors WHERE project_id = ?').all(projectId) as unknown as GroupRow[];
      const r = rows.find((x) => x.id.replace(/-/g, '').startsWith(prefix));
      if (!r) continue;
      this.db.prepare("UPDATE errors SET status = 'resolved', fix_commit = ? WHERE id = ?").run(sha, r.id);
      this.push(toGroup({ ...r, status: 'resolved', fix_commit: sha }), false);
    }
  }

  // ---- queries ----

  list(projectId: string, status?: ErrorStatus): ErrorGroup[] {
    return (
      this.db
        .prepare(`SELECT * FROM errors WHERE project_id = ? ${status ? 'AND status = ?' : ''} ORDER BY last_seen DESC LIMIT 500`)
        .all(...(status ? [projectId, status] : [projectId])) as unknown as GroupRow[]
    ).map(toGroup);
  }

  occurrences(id: string, limit = 20): ErrorOccurrence[] {
    return (
      this.db
        .prepare(
          `SELECT e.ts, e.text, e.session_id FROM error_events x JOIN events e ON e.id = x.event_id
           WHERE x.error_id = ? ORDER BY e.id DESC LIMIT ?`,
        )
        .all(id, limit) as { ts: number; text: string; session_id: string | null }[]
    ).map((r) => ({ ts: r.ts, text: r.text, sessionId: r.session_id }));
  }

  setStatus(id: string, status: ErrorStatus): ErrorGroup {
    const r = this.db.prepare('SELECT * FROM errors WHERE id = ?').get(id) as GroupRow | undefined;
    if (!r) throw new Error('unknown error');
    this.db.prepare('UPDATE errors SET status = ? WHERE id = ?').run(status, id);
    const g = toGroup({ ...r, status });
    this.push(g, false);
    return g;
  }

  counts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT project_id, COUNT(*) AS n FROM errors WHERE status = 'open' GROUP BY project_id")
      .all() as { project_id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.project_id, r.n]));
  }

  shutdown(): void {
    for (const t of this.tails.values()) unwatchFile(t.path);
  }

  // ---- internals ----

  // Returns the stored event id, or null when rate-limited.
  private record(
    projectId: string,
    source: ErrorSource,
    title: string,
    text: string,
    sessionId: string | null,
    ruleNotify: boolean,
  ): number | null {
    const now = Date.now();
    const fingerprint = createHash('sha1').update(`${source}\n${normalize(title)}`).digest('hex');
    let r = this.db.prepare('SELECT * FROM errors WHERE project_id = ? AND fingerprint = ?').get(projectId, fingerprint) as
      | GroupRow
      | undefined;
    let fresh = false;
    let regressed = false;
    if (!r) {
      fresh = true;
      r = {
        id: randomUUID(),
        project_id: projectId,
        fingerprint,
        title,
        source,
        status: 'open',
        first_seen: now,
        last_seen: now,
        count: 1,
        fix_commit: null,
        notified_at: null,
        notify: ruleNotify ? 1 : 0,
      };
      this.db
        .prepare(
          `INSERT INTO errors (id, project_id, fingerprint, title, source, status, first_seen, last_seen, count, notify)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?)`,
        )
        .run(r.id, projectId, fingerprint, title, source, now, now, r.notify);
    } else {
      regressed = r.status === 'resolved';
      if (regressed) fresh = true;
      r = { ...r, status: regressed ? 'open' : r.status, last_seen: now, count: r.count + 1 };
      this.db
        .prepare('UPDATE errors SET status = ?, last_seen = ?, count = ? WHERE id = ?')
        .run(r.status, now, r.count, r.id);
    }

    const lastEvent = this.db
      .prepare('SELECT MAX(e.ts) AS ts FROM error_events x JOIN events e ON e.id = x.event_id WHERE x.error_id = ?')
      .get(r.id) as { ts: number | null };
    let eventId: number | null = null;
    if (!lastEvent.ts || now - lastEvent.ts >= EVENT_EVERY_MS) {
      const ins = this.db
        .prepare("INSERT INTO events (ts, project_id, session_id, kind, payload, text) VALUES (?, ?, ?, 'error', ?, ?)")
        .run(now, projectId, sessionId, JSON.stringify({ errorId: r.id, source }), text);
      eventId = Number(ins.lastInsertRowid);
      this.db.prepare('INSERT INTO error_events (error_id, event_id) VALUES (?, ?)').run(r.id, eventId);
    }

    // New errors alert at most once per window; a resolved error coming back always does.
    const alert =
      fresh && r.status === 'open' && r.notify === 1 && (regressed || !r.notified_at || now - r.notified_at >= ALERT_EVERY_MS);
    if (alert) this.db.prepare('UPDATE errors SET notified_at = ? WHERE id = ?').run(now, r.id);
    this.push(toGroup(r), alert);
    return eventId;
  }

  private finishCapture(st: Stream): void {
    const c = st.capture;
    st.capture = null;
    if (!c?.lines.length) return;
    const row = this.db.prepare('SELECT text FROM events WHERE id = ?').get(c.eventId) as { text: string } | undefined;
    if (row) this.db.prepare('UPDATE events SET text = ? WHERE id = ?').run(`${row.text}\n${c.lines.join('\n')}`, c.eventId);
  }

  // Poll-based tail (survives rotation/truncation); one per enabled logfile rule.
  private syncTails(): void {
    const rows = (
      this.db.prepare("SELECT * FROM error_rules WHERE kind = 'logfile' AND enabled = 1").all() as unknown as RuleRow[]
    ).filter((r) => r.path && r.project_id);
    const want = new Set(rows.map((r) => r.id));
    for (const [id, t] of this.tails) {
      if (!want.has(id)) {
        unwatchFile(t.path);
        this.tails.delete(id);
        this.endStream(`file:${id}`);
      }
    }
    for (const r of rows) {
      if (this.tails.has(r.id)) continue;
      const path = r.path!;
      const t = { path, offset: existsSync(path) ? statSync(path).size : 0 }; // start at the end: new lines only
      this.tails.set(r.id, t);
      const compiled: Compiled = { rule: toRule(r), re: new RegExp(r.pattern) };
      watchFile(path, { interval: TAIL_POLL_MS }, (cur) => {
        if (cur.size < t.offset) t.offset = 0; // truncated or rotated
        if (cur.size === t.offset) return;
        const len = Math.min(cur.size - t.offset, MAX_TAIL_READ);
        const buf = Buffer.alloc(len);
        const fd = openSync(path, 'r');
        try {
          readSync(fd, buf, 0, len, cur.size - len);
        } finally {
          closeSync(fd);
        }
        t.offset = cur.size;
        this.feed(`file:${r.id}`, r.project_id, null, buf.toString('utf8'), compiled);
      });
    }
  }
}
