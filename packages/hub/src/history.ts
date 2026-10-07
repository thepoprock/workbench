import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SearchHit } from '@workbench/shared';
import type { DB } from './db/index.ts';

const REFRESH_MIN_MS = 15_000; // a search re-scans transcripts at most this often
const READ_SLICE = 16 * 1024 * 1024; // bytes read per step when catching up on a file
const PER_SOURCE = 300; // FTS rows fetched per source before de-duplicating

// Search syntax is plain words: each becomes a quoted prefix term, all must match.
// (Raw FTS5 syntax from a search box would throw on stray quotes or operators.)
export function toFtsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words.map((w) => `"${w}"*`).join(' ');
}

interface FileRow {
  path: string;
  transcript_id: string;
  cwd: string | null;
  title: string | null;
  offset: number;
}

function messageText(content: unknown): string {
  const parts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''))
        : [];
  // Injected wrappers (<system-reminder>, <command-name>, tool results) aren't conversation.
  return parts
    .filter((p) => p && !p.trimStart().startsWith('<'))
    .join('\n')
    .trim();
}

export class History {
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;

  // roots(): every Claude account's projects folder.
  constructor(
    private db: DB,
    private roots: () => string[],
  ) {}

  // Catch up on every transcript under ~/.claude/projects (append-only files,
  // so we resume each from the byte offset where we stopped).
  refresh(): Promise<void> {
    this.refreshing ??= this.scan().finally(() => {
      this.lastRefresh = Date.now();
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async scan(): Promise<void> {
    for (const root of this.roots()) {
      if (existsSync(root)) await this.scanRoot(root);
    }
  }

  private async scanRoot(root: string): Promise<void> {
    for (const dir of readdirSync(root)) {
      const full = join(root, dir);
      let names: string[];
      try {
        names = readdirSync(full).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue; // not a directory
      }
      for (const name of names) {
        this.indexFile(join(full, name));
        await new Promise((r) => setImmediate(r)); // keep the hub responsive
      }
    }
  }

  private indexFile(path: string): void {
    const size = statSync(path).size;
    let row = this.db.prepare('SELECT * FROM transcript_files WHERE path = ?').get(path) as FileRow | undefined;
    const id = basename(path, '.jsonl');
    if (row && size < row.offset) {
      // Rewritten or truncated: start over.
      this.db.prepare('DELETE FROM transcript_fts WHERE transcript_id = ?').run(id);
      this.db.prepare('DELETE FROM transcript_files WHERE path = ?').run(path);
      row = undefined;
    }
    let offset = row?.offset ?? 0;
    if (offset >= size) return;

    let cwd = row?.cwd ?? null;
    let title = row?.title ?? null;
    const insert = this.db.prepare('INSERT INTO transcript_fts (text, transcript_id, role, ts) VALUES (?, ?, ?, ?)');
    const fd = openSync(path, 'r');
    try {
      while (offset < size) {
        const len = Math.min(READ_SLICE, size - offset);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, offset);
        const end = buf.lastIndexOf(0x0a); // only consume complete lines
        if (end < 0) break;
        const lines = buf.subarray(0, end).toString('utf8').split('\n');
        this.db.exec('BEGIN');
        try {
          for (const line of lines) {
            const isMsg = line.includes('"type":"user"') || line.includes('"type":"assistant"');
            const isTitle = line.includes('"type":"ai-title"');
            if (!isMsg && !isTitle && cwd) continue;
            let d: Record<string, unknown>;
            try {
              d = JSON.parse(line);
            } catch {
              continue;
            }
            if (!cwd && typeof d.cwd === 'string') cwd = d.cwd;
            if (isTitle && typeof d.aiTitle === 'string') title = d.aiTitle;
            if (!isMsg || d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue;
            const text = messageText((d.message as { content?: unknown } | undefined)?.content);
            if (!text) continue;
            const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) || null : null;
            insert.run(text, id, d.type as string, ts);
          }
          offset += end + 1;
          this.db
            .prepare(
              `INSERT INTO transcript_files (path, transcript_id, cwd, title, offset, updated_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET cwd = excluded.cwd, title = excluded.title, offset = excluded.offset, updated_at = excluded.updated_at`,
            )
            .run(path, id, cwd, title, offset, Date.now());
          this.db.exec('COMMIT');
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  async search(query: string, projectId: string | undefined, limit = 60): Promise<SearchHit[]> {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    if (Date.now() - this.lastRefresh > REFRESH_MIN_MS) await this.refresh();

    const root = projectId
      ? ((this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null })
          ?.root_path ?? null)
      : null;
    const SNIP = (table: string) => `snippet(${table}, 0, char(1), char(2), '…', 14)`;
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const add = (key: string, hit: SearchHit) => {
      if (seen.has(key)) return; // one hit per session / conversation (newest first)
      seen.add(key);
      hits.push(hit);
    };

    // Agent events: prompts, tools, replies, notifications.
    const agentRows = this.db
      .prepare(
        `SELECT e.id, e.ts, e.kind, e.payload, e.session_id, e.project_id, s.title, p.name AS project, ${SNIP('events_fts')} AS snip
         FROM events_fts JOIN events e ON e.id = events_fts.rowid
         LEFT JOIN sessions s ON s.id = e.session_id LEFT JOIN projects p ON p.id = e.project_id
         WHERE events_fts MATCH ? ${projectId ? 'AND e.project_id = ?' : ''}
         ORDER BY e.ts DESC LIMIT ${PER_SOURCE}`,
      )
      .all(...(projectId ? [fts, projectId] : [fts])) as {
      id: number;
      ts: number;
      kind: string;
      payload: string;
      session_id: string | null;
      project_id: string;
      title: string | null;
      project: string | null;
      snip: string;
    }[];
    for (const r of agentRows) {
      if (r.kind === 'error') {
        add(`e:${(JSON.parse(r.payload) as { errorId?: string }).errorId ?? r.id}`, {
          source: 'error',
          projectId: r.project_id,
          sessionId: r.session_id,
          transcriptId: null,
          seq: null,
          ts: r.ts,
          title: 'Error',
          where: r.project ?? '',
          snippet: r.snip,
        });
        continue;
      }
      if (r.kind === 'git.commit') {
        const sha = String((JSON.parse(r.payload) as { sha?: string }).sha ?? '');
        add(`g:${r.id}`, {
          source: 'commit',
          projectId: r.project_id,
          sessionId: null,
          transcriptId: null,
          seq: null,
          ts: r.ts,
          title: `Commit ${sha.slice(0, 7)}`,
          where: r.project ?? '',
          snippet: r.snip,
        });
        continue;
      }
      add(`s:${r.session_id}`, {
        source: 'agent',
        projectId: r.project_id,
        sessionId: r.session_id,
        transcriptId: null,
        seq: null,
        ts: r.ts,
        title: r.title ?? 'Agent session',
        where: r.project ?? '',
        snippet: r.snip,
      });
    }

    // Terminal output.
    const termRows = this.db
      .prepare(
        `SELECT f.session_id, f.seq, c.ts_end AS ts, s.project_id, s.title, s.kind, p.name AS project, ${SNIP('scrollback_fts')} AS snip
         FROM scrollback_fts f
         JOIN sessions s ON s.id = f.session_id
         LEFT JOIN scrollback_chunks c ON c.session_id = f.session_id AND c.seq = f.seq
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE scrollback_fts MATCH ? ${projectId ? 'AND s.project_id = ?' : ''}
         ORDER BY c.ts_end DESC LIMIT ${PER_SOURCE}`,
      )
      .all(...(projectId ? [fts, projectId] : [fts])) as {
      session_id: string;
      seq: number;
      ts: number | null;
      project_id: string;
      title: string | null;
      kind: string;
      project: string | null;
      snip: string;
    }[];
    for (const r of termRows) {
      add(`t:${r.session_id}`, {
        source: 'terminal',
        projectId: r.project_id,
        sessionId: r.session_id,
        transcriptId: null,
        seq: r.seq,
        ts: r.ts,
        title: r.title ?? (r.kind === 'agent' ? 'Agent session' : 'Terminal'),
        where: r.project ?? '',
        snippet: r.snip,
      });
    }

    // Claude conversations (any folder; mapped to a project when its root matches).
    if (!projectId || root) {
      const convRows = this.db
        .prepare(
          `SELECT f.transcript_id, f.ts, tf.cwd, tf.title, p.id AS project_id, ${SNIP('transcript_fts')} AS snip
           FROM transcript_fts f
           JOIN transcript_files tf ON tf.transcript_id = f.transcript_id
           LEFT JOIN projects p ON p.root_path = tf.cwd AND p.archived = 0
           WHERE transcript_fts MATCH ? ${projectId ? 'AND tf.cwd = ?' : ''}
           ORDER BY f.ts DESC LIMIT ${PER_SOURCE}`,
        )
        .all(...(projectId ? [fts, root!] : [fts])) as {
        transcript_id: string;
        ts: number | null;
        cwd: string | null;
        title: string | null;
        project_id: string | null;
        snip: string;
      }[];
      for (const r of convRows) {
        add(`c:${r.transcript_id}`, {
          source: 'transcript',
          projectId: r.project_id,
          sessionId: null,
          transcriptId: r.transcript_id,
          seq: null,
          ts: r.ts,
          title: r.title ?? 'Claude conversation',
          where: r.cwd ?? '',
          snippet: r.snip,
        });
      }
    }

    return hits.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, limit);
  }
}
