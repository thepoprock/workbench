import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project, ProjectInfo } from '@workbench/shared';
import type { DB } from './db/index.ts';

const run = promisify(execFile);
const DOC_NAMES = ['README.md', 'SPEC.md', 'PLAN.md', 'IDEA.md', 'CHANGELOG.md'];
const ASSET_DIRS = ['dist', 'build', 'out', 'release', 'releases', 'assets'];
const DOC_LINES = 40;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function gitInfo(root: string): Promise<ProjectInfo['git']> {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null;
  let head: NonNullable<ProjectInfo['git']>['head'] = null;
  try {
    const [sha, subject, ts] = (await git(root, ['log', '-1', '--format=%H%x1f%s%x1f%ct'])).trim().split('\x1f');
    if (sha) head = { sha, subject, ts: Number(ts) * 1000 };
  } catch {
    /* no commits yet */
  }
  const commits = Number((await git(root, ['rev-list', '--count', 'HEAD']).catch(() => '0')).trim()) || 0;
  const dirty = (await git(root, ['status', '--porcelain']).catch(() => ''))
    .split('\n')
    .filter((l) => l.trim()).length;
  const tags = (
    await git(root, ['for-each-ref', '--sort=-creatordate', '--count=20', '--format=%(refname:short)%1f%(creatordate:unix)%1f%(subject)', 'refs/tags']).catch(() => '')
  )
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [name, ts, subject] = l.split('\x1f');
      return { name, ts: Number(ts) * 1000, subject: subject ?? '' };
    });
  return { branch, head, commits, dirty, tags };
}

function docs(root: string): ProjectInfo['docs'] {
  const out: ProjectInfo['docs'] = [];
  for (const name of DOC_NAMES) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const head = readFileSync(p, 'utf8').split('\n').slice(0, DOC_LINES).join('\n');
      out.push({ name, head });
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

function dirSize(dir: string, depth = 0): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (depth > 4) return { files, bytes };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const s = dirSize(p, depth + 1);
        files += s.files;
        bytes += s.bytes;
      } else if (e.isFile()) {
        files++;
        bytes += statSync(p).size;
      }
    } catch {
      /* skip */
    }
  }
  return { files, bytes };
}

function assets(root: string): ProjectInfo['assets'] {
  const out: ProjectInfo['assets'] = [];
  for (const dir of ASSET_DIRS) {
    const p = join(root, dir);
    if (!existsSync(p)) continue;
    try {
      if (!statSync(p).isDirectory()) continue;
      out.push({ dir, ...dirSize(p) });
    } catch {
      /* skip */
    }
  }
  return out;
}

function version(root: string, tags: { name: string }[]): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* no package.json */
  }
  return tags[0]?.name ?? null;
}

export async function projectInfo(db: DB, project: Project): Promise<ProjectInfo> {
  const count = (sql: string, ...args: string[]): number => (db.prepare(sql).get(...args) as { n: number }).n;
  const counts: ProjectInfo['counts'] = {
    terminals: count("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND kind = 'terminal'", project.id),
    agents: count("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND kind = 'agent'", project.id),
    conversations: count('SELECT COUNT(*) AS n FROM conversation_projects WHERE project_id = ?', project.id),
    commits: count("SELECT COUNT(*) AS n FROM change_entries WHERE project_id = ? AND source = 'git'", project.id),
    sessionsLogged: count("SELECT COUNT(*) AS n FROM change_entries WHERE project_id = ? AND source = 'session'", project.id),
    notes: count("SELECT COUNT(*) AS n FROM change_entries WHERE project_id = ? AND source = 'manual'", project.id),
    errorsOpen: count("SELECT COUNT(*) AS n FROM errors WHERE project_id = ? AND status = 'open'", project.id),
  };
  const root = project.rootPath && existsSync(project.rootPath) ? project.rootPath : null;
  const g = root ? await gitInfo(root) : null;
  return {
    project,
    git: g,
    version: root ? version(root, g?.tags ?? []) : null,
    docs: root ? docs(root) : [],
    counts,
    assets: root ? assets(root) : [],
  };
}
