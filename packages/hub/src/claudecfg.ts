import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { ClaudeFile } from '@workbench/shared';
import { projectsRoot } from './claude.ts';

// Read/edit what Claude Code keeps for you: global instructions, settings,
// agents, skills, and each project's CLAUDE.md and memory. Only those places
// are reachable; ~/.claude.json (account identity) never is.

const CLAUDE = join(homedir(), '.claude');
const TEXT = /\.(md|json|txt|ya?ml)$/i;
const MAX_FILE = 2 * 1024 * 1024;

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function files(dir: string, recursive: boolean, depth = 0): string[] {
  if (!existsSync(dir) || depth > 3) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (recursive) out.push(...files(p, true, depth + 1));
    } else if (TEXT.test(name) && st.size <= MAX_FILE) out.push(p);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

// Everything Claude keeps that's relevant to a project (or just the global set).
export function listClaudeFiles(projectRoot: string | null): ClaudeFile[] {
  const out: ClaudeFile[] = [];
  const add = (group: ClaudeFile['group'], path: string, label = relative(CLAUDE, path)) => {
    if (existsSync(path)) out.push({ group, path, label, bytes: statSync(path).size });
  };
  add('global', join(CLAUDE, 'CLAUDE.md'));
  add('global', join(CLAUDE, 'settings.json'));
  add('global', join(CLAUDE, 'settings.local.json'));
  for (const f of files(join(CLAUDE, 'agents'), false)) add('agents', f, basename(f));
  for (const f of files(join(CLAUDE, 'commands'), true)) add('agents', f, `commands/${relative(join(CLAUDE, 'commands'), f)}`);
  for (const f of files(join(CLAUDE, 'skills'), true)) add('agents', f, `skills/${relative(join(CLAUDE, 'skills'), f)}`);
  if (projectRoot) {
    add('project', join(projectRoot, 'CLAUDE.md'), 'CLAUDE.md');
    add('project', join(projectRoot, '.claude', 'settings.json'), '.claude/settings.json');
    add('project', join(projectRoot, '.claude', 'settings.local.json'), '.claude/settings.local.json');
    const mem = join(projectsRoot(), encode(projectRoot), 'memory');
    // MEMORY.md (the index) first, then newest first.
    const mtime = (p: string) => statSync(p).mtimeMs;
    const memFiles = files(mem, false).sort(
      (a, b) =>
        Number(basename(b) === 'MEMORY.md') - Number(basename(a) === 'MEMORY.md') || mtime(b) - mtime(a),
    );
    for (const f of memFiles) add('memory', f, basename(f));
  }
  return out;
}

// A path is reachable only if it's one listClaudeFiles could return.
function allowed(path: string, projectRoots: string[]): string {
  const real = (() => {
    try {
      return realpathSync(path);
    } catch {
      // A new file: judge by its folder.
      return join(realpathSync(dirname(path)), basename(path));
    }
  })();
  if (!TEXT.test(real) || basename(real) === '.claude.json') throw new Error('not a Claude text file');
  const inside = (root: string) => {
    try {
      const r = realpathSync(root);
      return real === r || real.startsWith(r + sep);
    } catch {
      return false;
    }
  };
  const ok =
    ['agents', 'commands', 'skills'].some((d) => inside(join(CLAUDE, d))) ||
    ['CLAUDE.md', 'settings.json', 'settings.local.json'].some((f) => real === join(realpathSync(CLAUDE), f)) ||
    projectRoots.some(
      (root) =>
        ['CLAUDE.md', join('.claude', 'settings.json'), join('.claude', 'settings.local.json')].some(
          (f) => existsSync(root) && real === join(realpathSync(root), f),
        ) || inside(join(projectsRoot(), encode(root), 'memory')),
    );
  if (!ok) throw new Error('outside the Claude files Workbench can open');
  return real;
}

export function readClaudeFile(path: string, projectRoots: string[]): string {
  const p = allowed(path, projectRoots);
  if (statSync(p).size > MAX_FILE) throw new Error('file too large to open here');
  return readFileSync(p, 'utf8');
}

export function writeClaudeFile(path: string, content: string, projectRoots: string[]): void {
  const p = allowed(path, projectRoots);
  if (/\.json$/i.test(p)) JSON.parse(content); // don't save broken settings
  writeFileSync(p, content);
}

// Folders Claude has been used in (conversations or memory) that still exist.
export function claudeProjectFolders(): { path: string; conversations: number; memory: number }[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const out: { path: string; conversations: number; memory: number }[] = [];
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    if (!statSync(full).isDirectory()) continue;
    const convs = readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    const mem = existsSync(join(full, 'memory')) ? readdirSync(join(full, 'memory')).filter((f) => f.endsWith('.md')).length : 0;
    // The real folder: a transcript's cwd, else decode the name (dashes are
    // ambiguous, so try every split and keep the one that exists).
    let path: string | null = null;
    for (const f of convs.slice(0, 3)) {
      const head = readFileSync(join(full, f), 'utf8').slice(0, 200_000);
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
      if (m) {
        path = JSON.parse(`"${m[1]}"`);
        break;
      }
    }
    path ??= decode(dir);
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) continue;
    if (path.startsWith(CLAUDE + sep)) continue; // Claude's own internals
    if (convs.length === 0 && mem === 0) continue;
    out.push({ path, conversations: convs.length, memory: mem });
  }
  return out.sort((a, b) => b.conversations - a.conversations || b.memory - a.memory);
}

// "-Users-bat-Desktop-untitled-folder" → "/Users/bat/Desktop/untitled folder" (first existing match).
function decode(name: string): string | null {
  const parts = name.replace(/^-/, '').split('-');
  const walk = (base: string, i: number): string | null => {
    if (i >= parts.length) return base;
    for (let j = parts.length; j > i; j--) {
      for (const joiner of ['-', ' ', '.', '_']) {
        const seg = parts.slice(i, j).join(joiner);
        const next = join(base, seg);
        if (existsSync(next)) {
          const r = walk(next, j);
          if (r) return r;
        }
        if (j - i === 1) break; // single part: joiner irrelevant
      }
    }
    return null;
  };
  return name === '-' ? '/' : walk('/', 0);
}
