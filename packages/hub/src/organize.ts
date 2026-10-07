import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { ClaudeTranscript, OrganizeGroup } from '@workbench/shared';

// Where did a conversation actually work? Claude files conversations by the
// folder they were started in (usually ~), so infer the real project from the
// files its tools touched: the git repo, else the top-level folder under ~,
// that most of them fall in. A guess — Organize shows it for review.

const HOME = homedir();
const SKIP = new Set(['.claude', 'Library', '.ssh', '.cache', '.npm', '.Trash']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
const CMD_PATH = /(?:^|[\s"'=])((?:~|\/Users\/[^/\s"']+)\/[\w.@+-][\w./@+-]*)/g;

function gitRoot(p: string): string | null {
  let d = existsSync(p) && statSync(p).isDirectory() ? p : dirname(p);
  while (d.startsWith(HOME + sep)) {
    if (existsSync(join(d, '.git'))) return d;
    d = dirname(d);
  }
  return null;
}

function bucket(p: string): { root: string; isRepo: boolean } | null {
  const abs = p.startsWith('~') ? join(HOME, p.slice(1)) : p;
  if (!abs.startsWith(HOME + sep)) return null;
  const top = relative(HOME, abs).split(sep)[0];
  if (!top || SKIP.has(top)) return null;
  const repo = gitRoot(abs);
  if (repo) return { root: repo, isRepo: true };
  const dir = join(HOME, top);
  return existsSync(dir) && statSync(dir).isDirectory() ? { root: dir, isRepo: false } : null;
}

async function workedIn(path: string): Promise<{ root: string; isRepo: boolean } | null> {
  const counts = new Map<string, { n: number; isRepo: boolean }>();
  const add = (p: string) => {
    const b = bucket(p);
    if (!b) return;
    const c = counts.get(b.root) ?? { n: 0, isRepo: b.isRepo };
    c.n++;
    counts.set(b.root, c);
  };
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"tool_use"')) continue;
    let d: { message?: { content?: unknown } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(d.message?.content) ? (d.message!.content as Record<string, unknown>[]) : [];
    for (const b of blocks) {
      if (b?.type !== 'tool_use') continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      for (const k of PATH_KEYS) if (typeof input[k] === 'string') add(input[k] as string);
      if (typeof input.command === 'string') for (const m of input.command.matchAll(CMD_PATH)) add(m[1]);
    }
  }
  let best: { root: string; isRepo: boolean; n: number } | null = null;
  for (const [root, c] of counts) if (!best || c.n > best.n) best = { root, isRepo: c.isRepo, n: c.n };
  return best && { root: best.root, isRepo: best.isRepo };
}

export class Organizer {
  private cache = new Map<string, { key: string; at: { root: string; isRepo: boolean } | null }>();

  // Group every conversation in the given Claude folders by where it worked.
  async suggest(
    projectsRoots: string[],
    read: (files: { path: string; harnessId: string }[]) => Promise<ClaudeTranscript[]>,
    projectFor: (root: string) => string | null,
    startedIn: (transcriptPath: string) => string | null,
  ): Promise<OrganizeGroup[]> {
    const groups = new Map<string, OrganizeGroup>();
    for (const root of projectsRoots) {
      if (!existsSync(root)) continue;
      for (const dir of readdirSync(root)) {
        const full = join(root, dir);
        if (!statSync(full).isDirectory()) continue;
        for (const f of readdirSync(full).filter((x) => x.endsWith('.jsonl'))) {
          const path = join(full, f);
          const st = statSync(path);
          const key = `${st.mtimeMs}:${st.size}`;
          let c = this.cache.get(path);
          if (c?.key !== key) {
            c = { key, at: await workedIn(path) };
            this.cache.set(path, c);
          }
          if (!c.at) continue;
          const [t] = await read([{ path, harnessId: '' }]);
          if (!t) continue;
          const from = startedIn(path) ?? '';
          if (from === c.at.root) continue; // already filed where it worked
          let g = groups.get(c.at.root);
          if (!g) {
            g = { root: c.at.root, projectId: projectFor(c.at.root), isRepo: c.at.isRepo, conversations: [] };
            groups.set(c.at.root, g);
          }
          g.conversations.push({ id: t.id, title: t.title, updatedAt: t.updatedAt, startedIn: from });
        }
      }
    }
    for (const g of groups.values()) g.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    // Repos first, then by size.
    return [...groups.values()].sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || b.conversations.length - a.conversations.length);
  }
}

export const projectName = (root: string) => (root === HOME ? 'Home' : basename(root));
