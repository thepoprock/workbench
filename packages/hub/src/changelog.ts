import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { promisify } from 'node:util';
import type { ChangeEntry, ChangeSource } from '@workbench/shared';
import type { DB } from './db/index.ts';

const run = promisify(execFile);
const POLL_MS = 20_000;
const FIRST_IMPORT = 100; // commits imported the first time a repo is seen
const LATER_IMPORT = 50; // commits checked when HEAD moves
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface Row {
  id: string;
  project_id: string;
  ts: number;
  source: ChangeSource;
  summary: string;
  refs: string;
}

const toEntry = (r: Row): ChangeEntry => ({
  id: r.id,
  projectId: r.project_id,
  ts: r.ts,
  source: r.source,
  summary: r.summary,
  refs: JSON.parse(r.refs),
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Changelog = git commits (imported by a poller), one entry per agent session
// (rebuilt from its hook events after each turn), and manual notes.
export class Changelog {
  private heads = new Map<string, string>(); // project id → last seen HEAD

  constructor(
    private db: DB,
    private push: (projectId: string) => void,
  ) {
    setInterval(() => void this.pollAll(), POLL_MS).unref();
    void this.pollAll();
  }

  list(projectId: string, before?: number, limit = 200): ChangeEntry[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM change_entries WHERE project_id = ? ${before ? 'AND ts < ?' : ''} ORDER BY ts DESC, rowid ASC LIMIT ?`,
        )
        .all(...(before ? [projectId, before, limit] : [projectId, limit])) as unknown as Row[]
    ).map(toEntry);
  }

  note(projectId: string, text: string): ChangeEntry {
    const t = text.trim();
    if (!t) throw new Error('note is empty');
    const e = this.upsert(projectId, `note:${randomUUID()}`, Date.now(), 'manual', t, {});
    this.push(projectId);
    return e;
  }

  deleteNote(id: string): void {
    const r = this.db.prepare('SELECT project_id, source FROM change_entries WHERE id = ?').get(id) as
      | { project_id: string; source: ChangeSource }
      | undefined;
    if (!r) throw new Error('unknown entry');
    if (r.source !== 'manual') throw new Error('only notes can be deleted');
    this.db.prepare('DELETE FROM change_entries WHERE id = ?').run(id);
    this.push(r.project_id);
  }

  async commit(projectId: string, sha: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('bad sha');
    const root = this.root(projectId);
    if (!root) throw new Error('project has no folder');
    return git(root, ['show', '--stat', '--format=%H%n%an <%ae>%n%ad%n%n%B', sha]);
  }

  // Rebuild a session's entry from its events (called after each Claude turn and at exit).
  session(sessionId: string): void {
    const s = this.db
      .prepare('SELECT project_id, cwd, external_id, status, started_at FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { project_id: string | null; cwd: string; external_id: string | null; status: string; started_at: number }
      | undefined;
    if (!s?.project_id) return; // idea sessions have no project changelog
    const events = this.db
      .prepare("SELECT ts, kind, payload FROM events WHERE session_id = ? AND kind LIKE 'agent.%' ORDER BY id")
      .all(sessionId) as { ts: number; kind: string; payload: string }[];

    const prompts: string[] = [];
    const files = new Set<string>();
    let commands = 0;
    let final = '';
    let last = s.started_at;
    for (const e of events) {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      const input = (p.tool_input ?? {}) as Record<string, unknown>;
      if (e.kind === 'agent.UserPromptSubmit' && typeof p.prompt === 'string') prompts.push(p.prompt);
      if (e.kind === 'agent.PreToolUse') {
        if (p.tool_name === 'Bash') commands++;
        if (EDIT_TOOLS.has(String(p.tool_name)) && typeof input.file_path === 'string') {
          const rel = relative(s.cwd, input.file_path);
          files.add(rel.startsWith('..') ? input.file_path : rel);
        }
      }
      if (e.kind === 'agent.Stop' && typeof p.last_assistant_message === 'string') final = p.last_assistant_message;
      last = e.ts;
    }
    if (prompts.length === 0) return; // opened and closed without doing anything

    const summary = prompts[0].replace(/\s+/g, ' ').trim().slice(0, 160);
    this.upsert(s.project_id, `session:${sessionId}`, last, 'session', summary, {
      sessionId,
      externalId: s.external_id,
      prompts: prompts.length,
      files: [...files],
      commands,
      final: final.slice(0, 1200),
      running: s.status === 'running',
    });
    this.push(s.project_id);
  }

  private root(projectId: string): string | null {
    return (
      (this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null } | undefined)
        ?.root_path ?? null
    );
  }

  private async pollAll(): Promise<void> {
    const projects = this.db
      .prepare('SELECT id, root_path FROM projects WHERE archived = 0 AND root_path IS NOT NULL')
      .all() as { id: string; root_path: string }[];
    for (const p of projects) {
      try {
        await this.pollProject(p.id, p.root_path);
      } catch {
        // not a git repo, git missing, or repo mid-operation: try again next tick
      }
    }
  }

  private async pollProject(projectId: string, root: string): Promise<void> {
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const seen = this.heads.get(projectId);
    if (seen === head) return;
    const known = this.db
      .prepare("SELECT COUNT(*) AS n FROM change_entries WHERE project_id = ? AND source = 'git'")
      .get(projectId) as { n: number };
    const n = known.n === 0 ? FIRST_IMPORT : LATER_IMPORT;
    const out = await git(root, ['log', `-n${n}`, '--format=%x1e%H%x1f%an%x1f%at%x1f%s%x1f%D', '--shortstat']);

    let added = 0;
    for (const rec of out.split('\x1e').slice(1)) {
      const [line, ...rest] = rec.split('\n');
      const [sha, author, at, subject, decor] = line.split('\x1f');
      if (!sha) continue;
      const stat = rest.join(' ');
      const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
      const branch = /HEAD -> ([^,]+)/.exec(decor ?? '')?.[1] ?? null;
      const exists = this.db
        .prepare('SELECT 1 FROM change_entries WHERE project_id = ? AND ref_key = ?')
        .get(projectId, `git:${sha}`);
      if (exists) continue;
      this.upsert(projectId, `git:${sha}`, Number(at) * 1000, 'git', subject, {
        sha,
        author,
        branch,
        files: num(/(\d+) files? changed/),
        insertions: num(/(\d+) insertions?/),
        deletions: num(/(\d+) deletions?/),
      });
      // Commit messages are searchable alongside everything else.
      this.db
        .prepare("INSERT INTO events (ts, project_id, kind, payload, text) VALUES (?, ?, 'git.commit', ?, ?)")
        .run(Number(at) * 1000, projectId, JSON.stringify({ sha, author }), subject);
      added++;
    }
    this.heads.set(projectId, head);
    if (added) this.push(projectId);
  }

  private upsert(
    projectId: string,
    key: string,
    ts: number,
    source: ChangeSource,
    summary: string,
    refs: Record<string, unknown>,
  ): ChangeEntry {
    const existing = this.db
      .prepare('SELECT id FROM change_entries WHERE project_id = ? AND ref_key = ?')
      .get(projectId, key) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO change_entries (id, project_id, ts, source, summary, refs, ref_key) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, ref_key) DO UPDATE SET ts = excluded.ts, summary = excluded.summary, refs = excluded.refs`,
      )
      .run(id, projectId, ts, source, summary, JSON.stringify(refs), key);
    return { id, projectId, ts, source, summary, refs };
  }
}
