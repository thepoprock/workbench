import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { Idea, IdeaStage, Project, TermSession } from '@workbench/shared';
import type { ClaudeHarness } from './claude.ts';
import type { DB } from './db/index.ts';
import { dataDir } from './paths.ts';
import type { Terminals } from './terminals.ts';

// An idea is a folder of markdown files. The files are the content — the user
// edits IDEA.md, Claude writes SPEC.md / PLAN.md beside it — and the DB keeps
// metadata. A watcher turns file changes into idea.update pushes.

export const ideasDir = join(dataDir, 'ideas');
const STAGES: IdeaStage[] = ['idea', 'spec', 'plan', 'promoted'];
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*\.md$/; // a plain .md name, no paths

const BRIEF = [
  'You are helping me turn a rough idea into a project. My notes are in IDEA.md in this folder.',
  'Read IDEA.md first. Then interview me to flesh it out: ask a few focused questions at a time',
  '(goals, who it is for, scope, constraints, what "done" looks like) and suggest options when I am unsure.',
  'Do not rewrite IDEA.md — it is my notes. When we have converged, write SPEC.md',
  '(goals, non-goals, users, core features, architecture sketch, open questions),',
  'then PLAN.md (milestones, each with a concrete "done when"). Keep both concise and update them as we refine.',
].join(' ');

interface IdeaRow {
  id: string;
  title: string;
  stage: IdeaStage;
  folder: string;
  session_id: string | null;
  project_id: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'idea';

function mdFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  const order = ['IDEA.md', 'SPEC.md', 'PLAN.md'];
  return readdirSync(folder)
    .filter((f) => FILE_RE.test(f) && statSync(join(folder, f)).isFile())
    .sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
}

export class Ideas {
  private watchers = new Map<string, FSWatcher>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: DB,
    private terms: Terminals,
    private claude: ClaudeHarness,
    private push: (idea: Idea) => void,
  ) {
    mkdirSync(ideasDir, { recursive: true, mode: 0o700 });
    for (const r of this.rows(false)) this.watch(r);
  }

  list(includeArchived = false): Idea[] {
    return this.rows(includeArchived).map((r) => this.toIdea(r));
  }

  create(title: string): Idea {
    const t = title.trim();
    if (!t) throw new Error('idea title is required');
    const id = randomUUID();
    const folder = join(ideasDir, `${slug(t)}-${id.slice(0, 8)}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'IDEA.md'), `# ${t}\n\n`);
    const now = Date.now();
    this.db
      .prepare('INSERT INTO ideas (id, title, body, stage, folder, created_at, updated_at) VALUES (?, ?, \'\', \'idea\', ?, ?, ?)')
      .run(id, t, folder, now, now);
    const row = this.row(id);
    this.watch(row);
    return this.toIdea(row);
  }

  update(id: string, patch: { title?: string; stage?: IdeaStage; archived?: boolean }): Idea {
    const r = this.row(id);
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error('idea title is required');
      r.title = patch.title.trim();
    }
    if (patch.stage !== undefined) {
      if (!STAGES.includes(patch.stage)) throw new Error(`unknown stage ${patch.stage}`);
      r.stage = patch.stage;
    }
    if (patch.archived !== undefined) {
      if (patch.archived && r.session_id && this.terms.get(r.session_id)?.status === 'running') {
        throw new Error('stop its Claude session before archiving');
      }
      r.archived = patch.archived ? 1 : 0;
      if (r.archived) this.unwatch(id);
      else this.watch(r);
    }
    r.updated_at = Date.now();
    this.db
      .prepare('UPDATE ideas SET title = ?, stage = ?, archived = ?, updated_at = ? WHERE id = ?')
      .run(r.title, r.stage, r.archived, r.updated_at, id);
    return this.toIdea(r);
  }

  read(id: string, file: string): string {
    const path = this.filePath(id, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  write(id: string, file: string, content: string): void {
    writeFileSync(this.filePath(id, file), content);
  }

  agent(id: string, cols: number, rows: number): TermSession {
    const r = this.row(id);
    const prev = r.session_id ? this.safeInfo(r.session_id) : null;
    if (prev?.status === 'running') return prev;
    // Resume the idea's conversation if there was one; otherwise start with the brief.
    const resume = prev?.agent?.externalId ?? undefined;
    const s = this.claude.start(null, r.folder, cols, rows, resume, resume ? undefined : BRIEF);
    this.db.prepare('UPDATE ideas SET session_id = ?, updated_at = ? WHERE id = ?').run(s.id, Date.now(), id);
    this.push(this.toIdea(this.row(id)));
    return s;
  }

  promote(id: string, rootPath: string, name: string | undefined, createProject: (name: string, root: string) => Project) {
    const r = this.row(id);
    if (r.project_id) throw new Error('already promoted');
    mkdirSync(rootPath, { recursive: true });
    if (!statSync(rootPath).isDirectory()) throw new Error(`not a directory: ${rootPath}`);
    const skipped: string[] = [];
    for (const f of mdFiles(r.folder)) {
      const dest = join(rootPath, f);
      if (existsSync(dest)) skipped.push(f);
      else copyFileSync(join(r.folder, f), dest);
    }
    const project = createProject(name?.trim() || r.title, rootPath);
    this.db
      .prepare("UPDATE ideas SET stage = 'promoted', project_id = ?, updated_at = ? WHERE id = ?")
      .run(project.id, Date.now(), id);
    this.push(this.toIdea(this.row(id)));
    return { project, skipped };
  }

  shutdown(): void {
    for (const w of this.watchers.values()) w.close();
  }

  private filePath(id: string, file: string): string {
    if (!FILE_RE.test(file)) throw new Error(`not an idea document name: ${file}`);
    return join(this.row(id).folder, basename(file));
  }

  private safeInfo(sessionId: string): TermSession | null {
    try {
      return this.terms.info(sessionId);
    } catch {
      return null;
    }
  }

  // Debounced: Claude writes files in bursts.
  private watch(r: IdeaRow): void {
    if (this.watchers.has(r.id) || r.archived || !existsSync(r.folder)) return;
    const w = watch(r.folder, () => {
      clearTimeout(this.timers.get(r.id));
      this.timers.set(
        r.id,
        setTimeout(() => this.changed(r.id), 250),
      );
    });
    w.on('error', () => this.unwatch(r.id));
    this.watchers.set(r.id, w);
  }

  private unwatch(id: string): void {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    clearTimeout(this.timers.get(id));
  }

  // Files changed: bump the time and move the stage forward when Claude
  // produces the next document (never backwards).
  private changed(id: string): void {
    let r: IdeaRow;
    try {
      r = this.row(id);
    } catch {
      return this.unwatch(id);
    }
    const files = mdFiles(r.folder);
    let stage = r.stage;
    if (stage === 'idea' && files.includes('SPEC.md')) stage = 'spec';
    if (stage === 'spec' && files.includes('PLAN.md')) stage = 'plan';
    this.db.prepare('UPDATE ideas SET stage = ?, updated_at = ? WHERE id = ?').run(stage, Date.now(), id);
    this.push(this.toIdea(this.row(id)));
  }

  private row(id: string): IdeaRow {
    const r = this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as IdeaRow | undefined;
    if (!r) throw new Error('unknown idea');
    return r;
  }

  private rows(includeArchived: boolean): IdeaRow[] {
    return this.db
      .prepare(`SELECT * FROM ideas ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`)
      .all() as unknown as IdeaRow[];
  }

  private toIdea(r: IdeaRow): Idea {
    return {
      id: r.id,
      title: r.title,
      stage: r.stage,
      folder: r.folder,
      files: mdFiles(r.folder),
      sessionId: r.session_id,
      projectId: r.project_id,
      archived: r.archived === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
