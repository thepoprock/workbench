import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Harness, HarnessType, ModelServer, TermSession } from '@workbench/shared';
import type { ClaudeAccount, ClaudeHarness } from './claude.ts';
import { dataDir } from './paths.ts';
import type { DB } from './db/index.ts';
import type { Terminals } from './terminals.ts';
import { HARNESS_ID } from './claude.ts';

// Harness registry + launcher. Every harness runs in a hub-owned PTY with the
// hook env (WORKBENCH_HOOK_URL/TOKEN), so status, changelog and errors work
// the same for all of them (protocol: packages/runner/events.mjs).

const RUNNER_DIR = join(import.meta.dirname, '..', '..', 'runner');
const TYPES: HarnessType[] = ['claude-code', 'agent-sdk', 'local-model', 'custom'];

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

const toHarness = (r: Row): Harness => ({
  id: r.id,
  type: r.type,
  name: r.name,
  enabled: r.id === HARNESS_ID ? true : r.enabled === 1,
  builtin: r.id === HARNESS_ID,
  config: JSON.parse(r.config),
});

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
  }

  // Every Claude account: the main login plus each extra config folder.
  accounts(): ClaudeAccount[] {
    return this.list()
      .filter((h) => h.type === 'claude-code')
      .map((h) => ({ harnessId: h.id, configDir: h.config.configDir || undefined }));
  }

  account(harnessId: string): ClaudeAccount {
    const h = this.get(harnessId);
    if (h.type !== 'claude-code') throw new Error(`${h.name} is not a Claude account`);
    return { harnessId: h.id, configDir: h.config.configDir || undefined };
  }

  // A new Claude account: its own config folder (login, settings, history).
  addAccount(name: string): Harness {
    const label = name.trim();
    if (!label) throw new Error('account needs a name');
    const id = randomUUID();
    const configDir = join(dataDir, 'accounts', id);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    this.db
      .prepare("INSERT INTO harnesses (id, type, name, config, enabled, created_at) VALUES (?, 'claude-code', ?, ?, 1, ?)")
      .run(id, `Claude Code · ${label}`, JSON.stringify({ configDir }), Date.now());
    return this.get(id);
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

  delete(id: string): void {
    if (id === HARNESS_ID) throw new Error('Claude Code is built in');
    this.db.prepare('UPDATE projects SET default_harness_id = NULL WHERE default_harness_id = ?').run(id);
    // Soft delete: sessions that ran under it keep their reference.
    this.db.prepare('UPDATE harnesses SET deleted = 1, enabled = 0 WHERE id = ?').run(id);
  }

  start(projectId: string, harnessId: string | undefined, cols: number, rows: number, resume?: string): TermSession {
    const project = this.db.prepare('SELECT default_harness_id FROM projects WHERE id = ?').get(projectId) as
      | { default_harness_id: string | null }
      | undefined;
    if (!project) throw new Error('unknown project');
    const h = this.get(harnessId ?? project.default_harness_id ?? HARNESS_ID);
    if (!h.enabled) throw new Error(`${h.name} is turned off — enable it under Harnesses`);
    if (h.type === 'claude-code') {
      // Remote Control on unless switched off: the session is reachable from claude.ai and the phone.
      const name = (this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string }).name;
      return this.claude.start(projectId, undefined, cols, rows, {
        resume,
        remoteName: h.config.remoteControl === 'off' ? undefined : name,
        account: { harnessId: h.id, configDir: h.config.configDir || undefined },
      });
    }
    if (resume) throw new Error(`${h.name} can't resume conversations`);

    const shell = process.env.SHELL || '/bin/zsh';
    let command: string[];
    if (h.type === 'local-model') command = ['node', join(RUNNER_DIR, 'local-agent.mjs')];
    else if (h.type === 'agent-sdk') command = ['node', h.config.script || join(RUNNER_DIR, 'sdk-agent.mjs')];
    else command = ['/bin/sh', '-c', h.config.command];

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
          file: shell,
          args: ['-l', '-c', 'exec "$0" "$@"', ...command],
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
