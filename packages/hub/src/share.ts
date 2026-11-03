// Workbenches of other accounts on this Mac, side by side and read-only. A hub started
// with WORKBENCH_SHARE_FILE writes a short summary of its projects there: names,
// folders, when last worked in, and what is running. Nothing else leaves its data. Every
// hub reads the summaries in SHARE_DIR other than its own, so one account sees what
// another is working on without being able to open or change any of it.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SharedWorkbench } from '@workbench/shared';
import type { DB } from './db/index.ts';
import { listProjects } from './methods.ts';
import type { Terminals } from './terminals.ts';
import { isWindows } from './platform.ts';

const SHARE_DIR = process.env.WORKBENCH_SHARE_DIR ?? (isWindows ? '' : '/Users/Shared/workbench-shared');
const WRITE_EVERY_MS = 5_000;
const STALE_MS = 2 * 60_000; // a summary not rewritten in this long: that hub is not running

export function startSharing(db: DB, terms: Terminals): () => void {
  const file = process.env.WORKBENCH_SHARE_FILE;
  if (!file) return () => {};
  const owner = process.env.WORKBENCH_SHARE_NAME || basename(file, '.json');
  let last = '';
  let lastWrite = 0;
  const write = () => {
    const running = terms.running();
    const projects = listProjects(db, false).map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      lastActiveAt: p.lastActiveAt,
      running: running.filter((s) => s.projectId === p.id).map((s) => ({ title: s.title, kind: s.kind, state: s.agent?.state ?? null })),
    }));
    const body = JSON.stringify({ owner, projects });
    // Unchanged content is still rewritten now and then, so readers can tell this hub is alive.
    if (body === last && Date.now() - lastWrite < STALE_MS / 2) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ owner, updatedAt: Date.now(), projects }), { mode: 0o644 });
      renameSync(tmp, file);
      [last, lastWrite] = [body, Date.now()];
    } catch (err) {
      console.log(`${new Date().toISOString()} [share] can't write ${file}: ${(err as Error).message}`);
    }
  };
  write();
  const timer = setInterval(write, WRITE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function readShared(): SharedWorkbench[] {
  if (!SHARE_DIR) return [];
  const own = process.env.WORKBENCH_SHARE_FILE;
  let names: string[];
  try {
    names = readdirSync(SHARE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .filter((f) => join(SHARE_DIR, f) !== own)
    .flatMap((f) => {
      try {
        const w = JSON.parse(readFileSync(join(SHARE_DIR, f), 'utf8')) as SharedWorkbench;
        if (typeof w.owner !== 'string' || !Array.isArray(w.projects)) return [];
        return [{ ...w, running: Date.now() - w.updatedAt < STALE_MS }];
      } catch {
        return []; // being written, or not a summary
      }
    });
}
