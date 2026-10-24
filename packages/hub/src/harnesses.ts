import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountMode, Harness, HarnessType, ModelServer, ShareGroup, TermSession } from '@workbench/shared';
import { keychainDelete, keychainGet } from './keychain.ts';
import type { ClaudeAccount, ClaudeHarness } from './claude.ts';
import { dataDir } from './paths.ts';
import { shellCommand, viaShell } from './platform.ts';
import type { DB } from './db/index.ts';
import type { Terminals } from './terminals.ts';
import { HARNESS_ID } from './claude.ts';

// Harness registry + launcher. Every harness runs in a hub-owned PTY with the
// hook env (WORKBENCH_HOOK_URL/TOKEN), so status, changelog and errors work
// the same for all of them (protocol: packages/runner/events.mjs).

const RUNNER_DIR = process.env.WORKBENCH_RUNNER_DIR ?? join(import.meta.dirname, '..', '..', 'runner');
const MAIN_CLAUDE = join(homedir(), '.claude');

// What each sharing switch links from the main ~/.claude into an account folder.
// Never ~/.claude.json: that holds the account's identity and folder trust.
const SHARE_ITEMS: Record<ShareGroup, string[]> = {
  instructions: ['CLAUDE.md', 'settings.json', 'settings.local.json', 'hooks'],
  extensions: ['agents', 'commands', 'skills', 'plugins'],
  history: ['projects'],
};

function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

function sharingOf(configDir: string): Record<ShareGroup, boolean> {
  const out = {} as Record<ShareGroup, boolean>;
  for (const [group, items] of Object.entries(SHARE_ITEMS) as [ShareGroup, string[]][]) {
    const present = items.filter((i) => existsSync(join(MAIN_CLAUDE, i)));
    out[group] = present.length > 0 && present.every((i) => isLinkTo(join(configDir, i), join(MAIN_CLAUDE, i)));
  }
  return out;
}
const TYPES: HarnessType[] = ['claude-code', 'agent-sdk', 'local-model', 'custom'];
const OPENAI_HARNESS_ID = 'openai-codex';

const KNOWN_SERVERS = [
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { name: 'llama.cpp / MLX', baseUrl: 'http://localhost:8080/v1' },
];

interface Row {
  id: string;
  type: HarnessType;
  name: string;
  config: string;
  enabled: number;
}

const toHarness = (r: Row): Harness => {
  const config = JSON.parse(r.config) as Record<string, string>;
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    enabled: r.id === HARNESS_ID || r.id === OPENAI_HARNESS_ID ? true : r.enabled === 1,
    builtin: r.id === HARNESS_ID || r.id === OPENAI_HARNESS_ID,
    config,
    ...(r.type === 'claude-code' && config.configDir ? { sharing: sharingOf(config.configDir) } : {}),
  };
};

export class Harnesses {
  constructor(
    private db: DB,
    private terms: Terminals,
    private claude: ClaudeHarness,
  ) {
    const seed = (id: string, type: HarnessType, name: string, config: object, enabled: number) =>
      db
        .prepare('INSERT OR IGNORE INTO harnesses (id, type, name, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, type, name, JSON.stringify(config), enabled, Date.now());
    seed('sdk-starter', 'agent-sdk', 'Agent SDK starter', {}, 0);
    seed('local-ollama', 'local-model', 'Local model (Ollama)', { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }, 0);
    seed(OPENAI_HARNESS_ID, 'custom', 'OpenAI Codex (ChatGPT account)', { command: 'codex' }, 1);
  }

  // The account new Claude sessions use: the main login or a token account
  // (both work in the main ~/.claude, so history stays in one place).
  usageAccount(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'usageAccount'").get() as { value: string } | undefined;
    if (!row) return HARNESS_ID;
    try {
      const h = this.get(row.value);
      return h.type === 'claude-code' && !h.config.configDir ? h.id : HARNESS_ID;
    } catch {
      return HARNESS_ID; // deleted since
    }
  }

  setUsageAccount(harnessId: string): string {
    const h = this.get(harnessId);
    if (h.type !== 'claude-code') throw new Error(`${h.name} is not a Claude account`);
    if (h.config.configDir) throw new Error(`${h.name} has its own folder — it is used for its own conversations, not as the main account`);
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('usageAccount', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(h.id);
    return h.id;
  }

  // Claude settings for a session in the main folder, on the usage account.
  async usageClaudeAccount(): Promise<ClaudeAccount> {
    return this.mainFolderAccount(this.usageAccount());
  }

  // A main-folder account ready to launch with: the login itself, or a token account + its token.
  async mainFolderAccount(id: string): Promise<ClaudeAccount> {
    if (id === HARNESS_ID) return { harnessId: id };
    const h = this.get(id);
    if (h.type !== 'claude-code' || h.config.configDir) throw new Error(`${h.name} doesn't use the main Claude folder`);
    const token = await keychainGet(id);
    if (!token) throw new Error(`${h.name} has no token — add one under Harnesses`);
    return { harnessId: id, token };
  }

  // Accounts that work in the main folder (login + token accounts), in order.
  mainFolderAccounts(): string[] {
    return this.list()
      .filter((h) => h.type === 'claude-code' && !h.config.configDir)
      .map((h) => h.id);
  }

  // Every Claude folder: the main ~/.claude (as the main login) plus each
  // separate-folder account. Token accounts share the main folder, so listing
  // them too would show every conversation twice.
  accounts(): ClaudeAccount[] {
    return this.list()
      .filter((h) => h.type === 'claude-code' && (h.id === HARNESS_ID || h.config.configDir))
      .map((h) => ({ harnessId: h.id, configDir: h.config.configDir || undefined }));
  }

  account(harnessId: string): ClaudeAccount & { tokenMode: boolean } {
    const h = this.get(harnessId);
    if (h.type !== 'claude-code') throw new Error(`${h.name} is not a Claude account`);
    return { harnessId: h.id, configDir: h.config.configDir || undefined, tokenMode: h.config.mode === 'token' };
  }

  // folder: its own config folder (sign-in, settings, history; sharing optional).
  // token:  runs in the main ~/.claude with the account's setup-token — shares everything.
  addAccount(name: string, mode: AccountMode): Harness {
    const label = name.trim();
    if (!label) throw new Error('account needs a name');
    if (mode !== 'folder' && mode !== 'token') throw new Error(`unknown account mode ${mode}`);
    const id = randomUUID();
    let config: Record<string, string> = { mode: 'token' };
    if (mode === 'folder') {
      const configDir = join(dataDir, 'accounts', id);
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      config = { mode: 'folder', configDir };
    }
    this.db
      .prepare("INSERT INTO harnesses (id, type, name, config, enabled, created_at) VALUES (?, 'claude-code', ?, ?, 1, ?)")
      .run(id, `Claude Code · ${label}`, JSON.stringify(config), Date.now());
    return this.get(id);
  }

  // Link (or unlink) a group of the main ~/.claude into a folder account.
  // Refuses rather than replace anything the account has of its own.
  share(harnessId: string, group: ShareGroup, shared: boolean): Harness {
    const h = this.get(harnessId);
    const dir = h.config.configDir;
    if (h.type !== 'claude-code' || !dir) throw new Error('only separate-folder accounts have sharing switches');
    const items = SHARE_ITEMS[group];
    if (!items) throw new Error(`unknown group ${group}`);
    if (!shared) {
      for (const item of items) if (isLinkTo(join(dir, item), join(MAIN_CLAUDE, item))) unlinkSync(join(dir, item));
      return this.get(harnessId);
    }
    // Check every item first, so a refusal leaves the group exactly as it was.
    const lstat = (p: string) => {
      try {
        return lstatSync(p);
      } catch {
        return null;
      }
    };
    const todo = items.filter((i) => existsSync(join(MAIN_CLAUDE, i)) && !isLinkTo(join(dir, i), join(MAIN_CLAUDE, i)));
    const own = todo.filter((i) => {
      const st = lstat(join(dir, i));
      return st && !st.isSymbolicLink() && !(st.isDirectory() && readdirSync(join(dir, i)).length === 0);
    });
    if (own.length) {
      throw new Error(`this account already has its own ${own.join(', ')} — move ${own.length > 1 ? 'them' : 'it'} out of ${dir} first, or keep this unshared`);
    }
    for (const item of todo) {
      const dst = join(dir, item);
      const st = lstat(dst);
      if (st?.isSymbolicLink()) unlinkSync(dst); // a link to somewhere else: ours to replace
      else if (st) rmdirSync(dst); // empty folder
      symlinkSync(join(MAIN_CLAUDE, item), dst);
    }
    return this.get(harnessId);
  }

  list(): Harness[] {
    return (
      this.db.prepare('SELECT * FROM harnesses WHERE deleted = 0 ORDER BY created_at').all() as unknown as Row[]
    ).map(toHarness);
  }

  get(id: string): Harness {
    const r = this.db.prepare('SELECT * FROM harnesses WHERE id = ? AND deleted = 0').get(id) as Row | undefined;
    if (!r) throw new Error('unknown harness');
    return toHarness(r);
  }

  save(input: Omit<Harness, 'id' | 'builtin'> & { id?: string }): Harness {
    let h = input;
    if (!TYPES.includes(h.type)) throw new Error(`unknown harness type ${h.type}`);
    if (!h.name.trim()) throw new Error('harness needs a name');
    if (h.id === HARNESS_ID && h.type !== 'claude-code') throw new Error('Claude Code is built in');
    if (h.id === HARNESS_ID && !h.enabled) throw new Error('Claude Code is always on');
    if (h.id === OPENAI_HARNESS_ID && (h.type !== 'custom' || h.config.command !== 'codex')) throw new Error('OpenAI Codex is built in');
    if (h.id === OPENAI_HARNESS_ID && !h.enabled) throw new Error('OpenAI Codex is always on');
    if (h.type === 'claude-code' && !h.id) throw new Error('add Claude accounts with "Add Claude account"');
    // An account's folder is fixed at creation.
    if (h.type === 'claude-code' && h.id) h = { ...h, config: { ...h.config, configDir: this.get(h.id).config.configDir ?? '' } };
    if (h.type === 'local-model' && (!h.config.baseUrl || !h.config.model)) throw new Error('a local model needs a server URL and a model');
    if (h.type === 'custom' && !h.config.command?.trim()) throw new Error('a custom harness needs a command');
    if (h.type === 'agent-sdk' && h.config.script && !existsSync(h.config.script)) throw new Error(`script not found: ${h.config.script}`);
    const id = h.id ?? randomUUID();
    if (h.id) this.get(h.id); // must exist and not be deleted
    this.db
      .prepare(
        `INSERT INTO harnesses (id, type, name, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, enabled = excluded.enabled`,
      )
      .run(id, h.type, h.name.trim(), JSON.stringify(h.config ?? {}), h.enabled ? 1 : 0, Date.now());
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    if (id === HARNESS_ID || id === OPENAI_HARNESS_ID) throw new Error('Built-in harnesses cannot be deleted');
    const h = this.get(id);
    if (h.type === 'claude-code' && h.config.mode === 'token') await keychainDelete(id);
    this.db.prepare('UPDATE projects SET default_harness_id = NULL WHERE default_harness_id = ?').run(id);
    // Soft delete: sessions that ran under it keep their reference.
    this.db.prepare('UPDATE harnesses SET deleted = 1, enabled = 0 WHERE id = ?').run(id);
  }

  // cwd: run somewhere other than the project folder (a filed conversation
  // must resume in the folder it was started in, where its transcript is).
  async start(
    projectId: string,
    harnessId: string | undefined,
    cols: number,
    rows: number,
    resume?: string,
    cwd?: string,
  ): Promise<TermSession> {
    const project = this.db.prepare('SELECT default_harness_id FROM projects WHERE id = ?').get(projectId) as
      | { default_harness_id: string | null }
      | undefined;
    if (!project) throw new Error('unknown project');
    let h = this.get(harnessId ?? project.default_harness_id ?? HARNESS_ID);
    if (!h.enabled) throw new Error(`${h.name} is turned off — enable it under Harnesses`);
    // "Claude Code" means: whichever account is selected for usage.
    if (h.id === HARNESS_ID) h = this.get(this.usageAccount());
    if (h.type === 'claude-code') {
      // Remote Control on unless switched off: the session is reachable from claude.ai and the phone.
      const name = (this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string }).name;
      let token: string | undefined;
      if (h.config.mode === 'token') {
        token = (await keychainGet(h.id)) ?? undefined;
        if (!token) throw new Error(`${h.name} has no token yet — add one under Harnesses`);
      }
      return this.claude.start(projectId, cwd, cols, rows, {
        resume,
        remoteName: h.config.remoteControl === 'off' ? undefined : name,
        account: { harnessId: h.id, configDir: h.config.configDir || undefined, token },
      });
    }
    if (resume && h.id !== OPENAI_HARNESS_ID) throw new Error(`${h.name} can't resume conversations`);

    let command: string[];
    if (h.id === OPENAI_HARNESS_ID) command = resume ? ['codex', 'resume', resume] : ['codex'];
    else if (h.type === 'local-model') command = ['node', join(RUNNER_DIR, 'local-agent.mjs')];
    else if (h.type === 'agent-sdk') command = ['node', h.config.script || join(RUNNER_DIR, 'sdk-agent.mjs')];
    else command = shellCommand(h.config.command);

    const id = randomUUID();
    const hookEnv = this.claude.registerHooks(id);
    try {
      return this.terms.create(
        projectId,
        undefined,
        cols,
        rows,
        {
          kind: 'agent',
          harness: h.id,
          // Login shell so node and the user's tools are on PATH, as in a terminal.
          ...viaShell(command),
          env: { ...hookEnv, WB_HARNESS_CONFIG: JSON.stringify(h.config ?? {}) },
          title: h.name,
          agent: { state: 'starting', activity: null, externalId: null },
        },
        id,
      );
    } catch (err) {
      this.claude.unregisterHooks(id);
      throw err;
    }
  }

  async detect(): Promise<ModelServer[]> {
    const found = await Promise.all(
      KNOWN_SERVERS.map(async (s) => {
        try {
          const r = await fetch(`${s.baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
          if (!r.ok) return null;
          const data = (await r.json()) as { data?: { id: string }[] };
          return { ...s, models: (data.data ?? []).map((m) => m.id) };
        } catch {
          return null;
        }
      }),
    );
    return found.filter((x): x is ModelServer => x !== null);
  }
}
