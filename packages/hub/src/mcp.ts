import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { McpHealth, McpScope, McpServer } from '@workbench/shared';
import { viaShell } from './platform.ts';
import { stripAnsi } from './text.ts';

// MCP servers as Claude Code keeps them (verified on 2.1.310):
//   user    <config>/.claude.json  mcpServers                  (every project)
//   local   <config>/.claude.json  projects[<folder>].mcpServers (just you, this folder)
//   project <folder>/.mcp.json     mcpServers                  (checked in, shared)
// <config> is the account's CLAUDE_CONFIG_DIR (or the hub's), else the home folder. Adding and removing goes
// through `claude mcp` so Claude does its own validation and writing; only the
// per-folder switches below are written here, because the CLI has no command for them:
//   off in this folder    <config>/.claude.json projects[<folder>].disabledMcpServers
//   .mcp.json approval    <folder>/.claude/settings.local.json enabledMcpjsonServers / disabledMcpjsonServers
const run = promisify(execFile);

type Json = Record<string, unknown>;

export interface McpContext {
  claude: string; // path to the claude CLI
  cwd: string; // the project folder, or home when there is none
  configDir?: string;
  env: Record<string, string>; // the account's env (CLAUDE_CONFIG_DIR / token)
}

const globalFile = (c: McpContext) => join(c.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
const localSettings = (c: McpContext) => join(c.cwd, '.claude', 'settings.local.json');

function readJson(path: string): Json {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    return {};
  }
}

// Claude keys a folder by its real path (/tmp → /private/tmp on macOS).
function folderKey(c: McpContext, projects: Json): string {
  let real = c.cwd;
  try {
    real = realpathSync(c.cwd);
  } catch {
    // keep as given
  }
  return real in projects || !(c.cwd in projects) ? real : c.cwd;
}

const obj = (x: unknown): Json => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : {});
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);

function toServer(name: string, scope: McpScope, raw: unknown, disabled: Set<string>, approval?: McpServer['approval']): McpServer {
  const config = obj(raw);
  const transport = typeof config.type === 'string' ? config.type : config.url ? 'http' : 'stdio';
  return {
    name,
    scope,
    transport,
    config,
    target: config.url ? String(config.url) : [config.command, ...strings(config.args)].filter(Boolean).join(' '),
    enabled: !disabled.has(name),
    ...(approval ? { approval } : {}),
  };
}

// What's configured, read straight from the files (fast; no health check).
export function listMcp(c: McpContext, hasProject: boolean): McpServer[] {
  const g = readJson(globalFile(c));
  const projects = obj(g.projects);
  const here = hasProject ? obj(projects[folderKey(c, projects)]) : {};
  const disabled = new Set(strings(here.disabledMcpServers));
  const out: McpServer[] = [];
  for (const [n, s] of Object.entries(obj(g.mcpServers))) out.push(toServer(n, 'user', s, disabled));
  if (!hasProject) return out;
  for (const [n, s] of Object.entries(obj(here.mcpServers))) out.push(toServer(n, 'local', s, disabled));
  const settings = readJson(localSettings(c));
  const approved = new Set(strings(settings.enabledMcpjsonServers));
  const rejected = new Set(strings(settings.disabledMcpjsonServers));
  const all = settings.enableAllProjectMcpServers === true;
  for (const [n, s] of Object.entries(obj(readJson(join(c.cwd, '.mcp.json')).mcpServers))) {
    const approval = rejected.has(n) ? 'rejected' : approved.has(n) || all ? 'approved' : 'pending';
    out.push(toServer(n, 'project', s, disabled, approval));
  }
  return out;
}

// `claude mcp list`: every server Claude would load here, claude.ai connectors
// and plugin servers included, each health-checked (takes a few seconds).
// Lines look like "name: target - ✔ Connected" / "- ✘ Failed to connect — why".
export async function mcpHealth(c: McpContext): Promise<McpHealth[]> {
  const cmd = viaShell([c.claude, 'mcp', 'list']);
  const { stdout } = await run(cmd.file, cmd.args, {
    cwd: c.cwd,
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...c.env },
  });
  const out: McpHealth[] = [];
  for (const line of stripAnsi(stdout).split('\n')) {
    const m = /^(.+?): (.*?) - ([✔✘!⏸⊘○…])\s*(.*)$/u.exec(line.trim());
    if (!m) continue;
    const [, name, target, mark, text] = m;
    const state =
      mark === '✔' ? 'connected' : mark === '!' ? 'needs-auth' : mark === '⏸' ? 'pending' : mark === '⊘' ? 'disabled' : mark === '✘' ? 'failed' : 'unknown';
    out.push({ name, target: target.trim(), state, detail: text.replace(/^Failed to connect\s*—?\s*/, '').slice(0, 300) });
  }
  return out;
}

async function cli(c: McpContext, args: string[]): Promise<void> {
  const cmd = viaShell([c.claude, 'mcp', ...args]);
  try {
    await run(cmd.file, cmd.args, { cwd: c.cwd, timeout: 30_000, env: { ...process.env, ...c.env } });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(stripAnsi(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' '));
  }
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

// Add, or replace (`was`: the entry being edited, removed first; put back if the add fails).
export async function saveMcp(
  c: McpContext,
  s: { name: string; scope: McpScope; config: Json },
  was?: { name: string; scope: McpScope },
): Promise<void> {
  if (!NAME.test(s.name)) throw new Error('name: letters, digits, - _ . only');
  if (!['user', 'local', 'project'].includes(s.scope)) throw new Error(`can't save to ${s.scope}`);
  const config = cleanConfig(s.config);
  const prev = was && listMcp(c, true).find((x) => x.name === was.name && x.scope === was.scope);
  if (was) await cli(c, ['remove', '-s', was.scope, was.name]);
  try {
    await cli(c, ['add-json', '-s', s.scope, s.name, JSON.stringify(config)]);
  } catch (err) {
    if (prev) await cli(c, ['add-json', '-s', prev.scope, prev.name, JSON.stringify(prev.config)]).catch(() => {});
    throw err;
  }
}

// Only the fields Claude takes, empty ones dropped.
function cleanConfig(raw: Json): Json {
  const type = String(raw.type ?? 'stdio');
  const map = (x: unknown) => {
    const m = Object.fromEntries(Object.entries(obj(x)).filter(([k, v]) => k.trim() && typeof v === 'string'));
    return Object.keys(m).length ? m : undefined;
  };
  if (type === 'stdio') {
    if (!String(raw.command ?? '').trim()) throw new Error('a command is needed');
    return { type, command: String(raw.command).trim(), args: strings(raw.args), ...(map(raw.env) ? { env: map(raw.env) } : {}) };
  }
  if (type !== 'http' && type !== 'sse') throw new Error(`unknown transport ${type}`);
  if (!/^https?:\/\//.test(String(raw.url ?? ''))) throw new Error('a http(s) URL is needed');
  return { type, url: String(raw.url).trim(), ...(map(raw.headers) ? { headers: map(raw.headers) } : {}) };
}

export const removeMcp = (c: McpContext, name: string, scope: McpScope) => cli(c, ['remove', '-s', scope, name]);
export const logoutMcp = (c: McpContext, name: string) => cli(c, ['logout', name]);

// Read-modify-write, then rename into place so Claude never reads half a file.
// Claude rewrites ~/.claude.json itself, so this re-reads right before writing.
function updateJson(path: string, fn: (d: Json) => void): void {
  if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '{}';
  const d = JSON.parse(raw) as Json; // refuse to touch a file we can't parse
  fn(d);
  const tmp = `${path}.wb-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

const toggle = (list: unknown, name: string, on: boolean) => {
  const l = strings(list).filter((n) => n !== name);
  return on ? [...l, name] : l;
};

// On or off for this folder (any server, claude.ai connectors too) — what /mcp's toggle does.
export function setMcpEnabled(c: McpContext, name: string, enabled: boolean): void {
  updateJson(globalFile(c), (g) => {
    const projects = obj(g.projects);
    const key = folderKey(c, projects);
    const here = obj(projects[key]);
    here.disabledMcpServers = toggle(here.disabledMcpServers, name, !enabled);
    projects[key] = here;
    g.projects = projects;
  });
}

// Approve or reject a server from this folder's .mcp.json.
export function setMcpApproval(c: McpContext, name: string, approved: boolean): void {
  updateJson(localSettings(c), (s) => {
    s.enabledMcpjsonServers = toggle(s.enabledMcpjsonServers, name, approved);
    s.disabledMcpjsonServers = toggle(s.disabledMcpjsonServers, name, !approved);
  });
}
