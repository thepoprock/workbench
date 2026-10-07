import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { HubInfo, Method, Methods, Project, Request, TermSession } from '@workbench/shared';
import { PROTOCOL_VERSION } from '@workbench/shared';
import { schemaVersion, type DB } from './db/index.ts';
import { reply, type Client, type Dispatch } from './server.ts';
import { keychainGet, keychainSet } from './keychain.ts';
import { claudeProjectFolders, listClaudeFiles, readClaudeFile, writeClaudeFile } from './claudecfg.ts';
import { Organizer, projectName } from './organize.ts';
import { projectsRoot } from './claude.ts';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import type { ClaudeHarness } from './claude.ts';
import type { History } from './history.ts';
import type { Ideas } from './ideas.ts';
import type { Changelog } from './changelog.ts';
import type { Errors } from './errors.ts';
import type { Harnesses } from './harnesses.ts';
import type { Terminals } from './terminals.ts';

type Handler<M extends Method> = (params: Methods[M]['params'], client: Client) => unknown;
type Handlers = { [M in Method]: Handler<M> };

interface ProjectRow {
  id: string;
  name: string;
  root_path: string | null;
  default_harness_id: string | null;
  created_at: number;
  archived: number;
}

function checkDir(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`not a directory: ${path}`);
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  rootPath: r.root_path,
  defaultHarnessId: r.default_harness_id,
  createdAt: r.created_at,
  archived: r.archived === 1,
});

// Operations the hub itself needs (limit failover), filled in by makeDispatch.
export interface HubOps {
  moveAgent?: (sessionId: string, harnessId: string) => Promise<TermSession>;
  failoverMode?: () => 'ask' | 'auto';
}

export function makeDispatch(
  db: DB,
  terms: Terminals,
  claude: ClaudeHarness,
  history: History,
  ideas: Ideas,
  changelog: Changelog,
  errors: Errors,
  harnesses: Harnesses,
  onAccountUpdate: (harnessId: string) => void,
  info: Omit<HubInfo, 'schemaVersion' | 'protocol'>,
  // Out: the hub wires limit detection to these.
  exportsOut: HubOps = {},
): Dispatch {
  const failoverMode = (): 'ask' | 'auto' =>
    ((db.prepare("SELECT value FROM settings WHERE key = 'failover'").get() as { value: string } | undefined)?.value === 'auto'
      ? 'auto'
      : 'ask');

  // Stop a Claude conversation's process and resume it on another account that
  // shares the main folder (where the transcript is). Ideas follow their session.
  const moveAgent = async (sessionId: string, harnessId: string): Promise<TermSession> => {
    const s = terms.info(sessionId);
    const externalId = s.agent?.externalId;
    if (s.kind !== 'agent' || !externalId) throw new Error('only Claude conversations can move between accounts');
    const from = s.harness ? harnesses.get(s.harness) : null;
    if (from?.type !== 'claude-code' || from.config.configDir) throw new Error('this conversation lives in a separate-folder account and can only run there');
    if (from.id === harnessId) throw new Error(`already on ${from.name}`);
    const account = await harnesses.mainFolderAccount(harnessId);
    const size = terms.size(sessionId) ?? { cols: 100, rows: 30 };
    if (s.status === 'running') await terms.killAndWait(sessionId);
    const idea = db.prepare('SELECT id, title FROM ideas WHERE session_id = ?').get(sessionId) as { id: string; title: string } | undefined;
    const projectName = s.projectId ? getProject(s.projectId).name : null;
    const next = claude.start(s.projectId, s.cwd, size.cols, size.rows, {
      resume: externalId,
      remoteName: idea ? `Idea: ${idea.title}` : (projectName ?? undefined),
      account,
    });
    if (idea) db.prepare('UPDATE ideas SET session_id = ? WHERE id = ?').run(next.id, idea.id);
    return next;
  };
  exportsOut.moveAgent = moveAgent;
  exportsOut.failoverMode = failoverMode;

  const getProject = (id: string): ProjectRow => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new Error('unknown project');
    return row;
  };

  const createProject = (name: string, rootPath?: string): Project => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('project name is required');
    if (rootPath) checkDir(rootPath);
    const row: ProjectRow = {
      id: randomUUID(),
      name: trimmed,
      root_path: rootPath ?? null,
      default_harness_id: null,
      created_at: Date.now(),
      archived: 0,
    };
    db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run(
      row.id,
      row.name,
      row.root_path,
      row.created_at,
    );
    return toProject(row);
  };

  // The account a Claude conversation belongs to: the session that last ran it,
  // else whichever account's folder holds its transcript.
  // Conversations in the main folder resume on the usage account (undefined);
  // those in a separate-folder account can only resume there.
  const resumeAccount = (projectId: string, externalId: string): string | undefined => {
    const folderAccount = (id: string | undefined) => {
      if (!id) return undefined;
      try {
        return harnesses.account(id).configDir ? id : undefined;
      } catch {
        return undefined;
      }
    };
    const ran = db
      .prepare('SELECT harness_id FROM sessions WHERE external_id = ? AND harness_id IS NOT NULL ORDER BY started_at DESC LIMIT 1')
      .get(externalId) as { harness_id: string } | undefined;
    if (ran) return folderAccount(ran.harness_id);
    const root = getProject(projectId).root_path;
    return root ? folderAccount(claude.accountOf(externalId, root, harnesses.accounts())?.harnessId) : undefined;
  };

  const organizer = new Organizer();
  // Where a conversation's transcript file is (any account), for filed ones.
  const transcriptFile = (id: string): { path: string; harnessId: string } | null => {
    const row = db.prepare('SELECT path FROM transcript_files WHERE transcript_id = ?').get(id) as { path: string } | undefined;
    if (!row) return null;
    const acct = harnesses.accounts().find((a) => row.path.startsWith(projectsRoot(a.configDir)));
    return { path: row.path, harnessId: acct?.harnessId ?? 'claude-code' };
  };
  const projectRoots = () =>
    (db.prepare('SELECT root_path FROM projects WHERE root_path IS NOT NULL').all() as { root_path: string }[]).map(
      (r) => r.root_path,
    );

  const handlers: Handlers = {
    'hub.info': () => ({ ...info, protocol: PROTOCOL_VERSION, schemaVersion: schemaVersion(db) }),

    'hub.ping': () => ({ now: Date.now() }),

    'project.list': ({ includeArchived }) =>
      (
        db
          .prepare(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name COLLATE NOCASE`)
          .all() as unknown as ProjectRow[]
      ).map(toProject),

    'project.create': ({ name, rootPath }) => createProject(name, rootPath),

    'project.update': ({ id, name, rootPath, defaultHarnessId }) => {
      const row = getProject(id);
      if (name !== undefined) {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('project name is required');
        row.name = trimmed;
      }
      if (rootPath !== undefined) {
        if (rootPath !== null) checkDir(rootPath);
        row.root_path = rootPath;
      }
      if (defaultHarnessId !== undefined) {
        if (defaultHarnessId !== null) harnesses.get(defaultHarnessId);
        row.default_harness_id = defaultHarnessId;
      }
      db.prepare('UPDATE projects SET name = ?, root_path = ?, default_harness_id = ? WHERE id = ?').run(
        row.name,
        row.root_path,
        row.default_harness_id,
        id,
      );
      return toProject(row);
    },

    'project.archive': ({ id, archived }) => {
      const row = getProject(id);
      if (archived && terms.list(id).some((s) => s.status === 'running')) {
        throw new Error(`"${row.name}" has running terminals — close them before archiving`);
      }
      row.archived = archived ? 1 : 0;
      db.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(row.archived, id);
      return toProject(row);
    },

    'term.create': ({ projectId, cwd, cols, rows }) => terms.create(projectId, cwd, cols, rows),
    'term.list': ({ projectId }) => terms.list(projectId),
    'term.get': ({ sessionId }) => terms.info(sessionId),
    'term.attach': async ({ sessionId }, client) => {
      const { session, snapshot, release } = await terms.attach(sessionId, client);
      return reply({ session, snapshot }, release);
    },
    'term.detach': ({ sessionId }, client) => terms.detach(sessionId, client),
    'term.input': ({ sessionId, data }) => terms.input(sessionId, data),
    'term.resize': ({ sessionId, cols, rows }) => terms.resize(sessionId, cols, rows),
    'term.kill': ({ sessionId }) => terms.kill(sessionId),

    'agent.start': ({ projectId, harnessId, resume, cols, rows }) => {
      if (resume) {
        const open = terms
          .list(projectId)
          .find((s) => s.status === 'running' && s.agent?.externalId === resume);
        if (open) return open; // already running here: the UI focuses it
        // A conversation resumes on the account it lives in, in the folder it
        // was started in (where Claude keeps it) even if it's filed elsewhere.
        harnessId ??= resumeAccount(projectId, resume);
        const startedIn = (db.prepare('SELECT cwd FROM transcript_files WHERE transcript_id = ?').get(resume) as { cwd: string | null } | undefined)?.cwd;
        if (startedIn && startedIn !== getProject(projectId).root_path) {
          return harnesses.start(projectId, harnessId, cols, rows, resume, startedIn);
        }
      }
      return harnesses.start(projectId, harnessId, cols, rows, resume);
    },
    'account.add': ({ name, mode }) => harnesses.addAccount(name, mode),
    'account.usage': () => ({ harnessId: harnesses.usageAccount() }),
    'account.setUsage': async ({ harnessId }) => {
      if (harnesses.account(harnessId).tokenMode && !(await keychainGet(harnessId))) {
        throw new Error('that account has no token yet — Get token or Paste token under Harnesses first');
      }
      const id = harnesses.setUsageAccount(harnessId);
      onAccountUpdate(id);
      return { harnessId: id };
    },
    'account.share': ({ harnessId, group, shared }) => harnesses.share(harnessId, group, shared),
    'account.status': async ({ harnessId }) => {
      const a = harnesses.account(harnessId);
      if (!a.tokenMode) return claude.status(a.configDir);
      const token = await keychainGet(harnessId);
      if (!token) return { loggedIn: false, email: null, authMethod: null, tokenHint: null };
      return { ...(await claude.status(undefined, token)), tokenHint: token.slice(-4) };
    },
    'account.setToken': async ({ harnessId, token }) => {
      if (!harnesses.account(harnessId).tokenMode) throw new Error('only token accounts take a token');
      const t = token.trim();
      if (!/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error("that doesn't look like a setup-token (sk-ant-oat…)");
      await keychainSet(harnessId, t);
      onAccountUpdate(harnessId);
      return { ...(await claude.status(undefined, t)), tokenHint: t.slice(-4) };
    },
    'account.tokenPane': ({ harnessId, projectId, cols, rows }) => {
      if (!harnesses.account(harnessId).tokenMode) throw new Error('only token accounts take a token');
      return claude.tokenPane(harnessId, projectId, cols, rows, (t) => {
        void keychainSet(harnessId, t).then(() => onAccountUpdate(harnessId));
      });
    },
    'account.login': ({ harnessId, projectId, cols, rows }) => {
      const a = harnesses.account(harnessId);
      // A token account has no folder: logging in would switch the MAIN account.
      if (a.tokenMode) throw new Error('token accounts use a setup-token, not a sign-in');
      return claude.login(a, projectId, cols, rows);
    },
    'local.sessions': () => claude.localSessions(),
    'local.attach': ({ id, projectId, cols, rows }) => claude.attach(id, projectId, cols, rows),
    'local.stop': ({ id }) => claude.stop(id),
    'harness.list': () => harnesses.list(),
    'harness.save': ({ harness }) => harnesses.save(harness),
    'harness.delete': ({ id }) => harnesses.delete(id),
    'harness.detect': () => harnesses.detect(),
    'agent.move': ({ sessionId, harnessId }) => moveAgent(sessionId, harnessId),
    'account.failover': ({ mode }) => {
      if (mode) {
        if (mode !== 'ask' && mode !== 'auto') throw new Error(`unknown mode ${mode}`);
        db.prepare("INSERT INTO settings (key, value) VALUES ('failover', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(mode);
      }
      return { mode: failoverMode() };
    },
    'agent.history': ({ projectId }) => {
      const root = getProject(projectId).root_path;
      const filed = db.prepare('SELECT transcript_id, project_id FROM conversation_projects').all() as {
        transcript_id: string;
        project_id: string;
      }[];
      const here = filed
        .filter((f) => f.project_id === projectId)
        .map((f) => transcriptFile(f.transcript_id))
        .filter((x): x is { path: string; harnessId: string } => !!x);
      const elsewhere = new Set(filed.filter((f) => f.project_id !== projectId).map((f) => f.transcript_id));
      if (!root) return claude.readTranscripts(here).then((ts) => ts.map((t) => ({ ...t, movedHere: true })));
      return claude.history(root, harnesses.accounts(), { elsewhere, here });
    },
    'claude.organize': () =>
      organizer.suggest(
        harnesses.accounts().map((a) => projectsRoot(a.configDir)),
        (files) => claude.readTranscripts(files),
        (root) => (db.prepare('SELECT id FROM projects WHERE root_path = ? AND archived = 0').get(root) as { id: string } | undefined)?.id ?? null,
        (path) => (db.prepare('SELECT cwd FROM transcript_files WHERE path = ?').get(path) as { cwd: string } | undefined)?.cwd ?? null,
      ),
    'claude.organizeApply': ({ groups }) => {
      let created = 0;
      let moved = 0;
      for (const g of groups) {
        let id = (db.prepare('SELECT id FROM projects WHERE root_path = ? AND archived = 0').get(g.root) as { id: string } | undefined)?.id;
        if (!id) {
          // Two folders with the same name (…/fleet-src/bogglinux, …/D2bot/bogglinux): add the parent.
          let name = projectName(g.root);
          const taken = (n: string) => !!db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE').get(n);
          if (taken(name)) name = `${basename(dirname(g.root))}/${name}`;
          id = createProject(name, g.root).id;
          created++;
        }
        for (const t of g.transcriptIds) {
          db.prepare(
            `INSERT INTO conversation_projects (transcript_id, project_id, assigned_by, assigned_at) VALUES (?, ?, 'auto', ?)
             ON CONFLICT(transcript_id) DO UPDATE SET project_id = excluded.project_id, assigned_by = 'auto', assigned_at = excluded.assigned_at
             WHERE conversation_projects.assigned_by = 'auto'`,
          ).run(t, id, Date.now());
          moved++;
        }
      }
      return { created, moved };
    },
    'claude.assign': ({ transcriptId, projectId }) => {
      if (projectId === null) {
        db.prepare('DELETE FROM conversation_projects WHERE transcript_id = ?').run(transcriptId);
        return null;
      }
      getProject(projectId);
      db.prepare(
        `INSERT INTO conversation_projects (transcript_id, project_id, assigned_by, assigned_at) VALUES (?, ?, 'user', ?)
         ON CONFLICT(transcript_id) DO UPDATE SET project_id = excluded.project_id, assigned_by = 'user', assigned_at = excluded.assigned_at`,
      ).run(transcriptId, projectId, Date.now());
      return null;
    },

    'idea.list': ({ includeArchived }) => ideas.list(includeArchived),
    'idea.create': ({ title }) => ideas.create(title),
    'idea.update': ({ id, ...patch }) => ideas.update(id, patch),
    'idea.read': ({ id, file }) => ideas.read(id, file),
    'idea.write': ({ id, file, content }) => ideas.write(id, file, content),
    'idea.agent': ({ id, cols, rows }) => ideas.agent(id, cols, rows),
    'idea.promote': ({ id, rootPath, name }) => ideas.promote(id, rootPath, name, createProject),

    'changelog.list': ({ projectId, before, limit }) => changelog.list(projectId, before, limit),
    'changelog.note': ({ projectId, text }) => changelog.note(projectId, text),
    'changelog.delete': ({ id }) => changelog.deleteNote(id),
    'changelog.commit': ({ projectId, sha }) => changelog.commit(projectId, sha),

    'errors.list': ({ projectId, status }) => errors.list(projectId, status),
    'errors.occurrences': ({ id, limit }) => errors.occurrences(id, limit),
    'errors.setStatus': ({ id, status }) => errors.setStatus(id, status),
    'errors.counts': () => errors.counts(),
    'rules.list': ({ projectId }) => errors.rules(projectId),
    'rules.save': ({ rule }) => errors.saveRule(rule),
    'rules.delete': ({ id }) => errors.deleteRule(id),

    'claude.files': ({ projectId }) => listClaudeFiles(projectId ? getProject(projectId).root_path : null),
    'claude.read': ({ path }) => readClaudeFile(path, projectRoots()),
    'claude.write': ({ path, content }) => writeClaudeFile(path, content, projectRoots()),
    'claude.import': () => {
      const known = new Set(projectRoots());
      const created: Project[] = [];
      let existing = 0;
      for (const f of claudeProjectFolders()) {
        if (known.has(f.path)) {
          existing++;
          continue;
        }
        const name = f.path === homedir() ? 'Home' : f.path === '/' ? 'Root (/)' : basename(f.path);
        created.push(createProject(name, f.path));
        known.add(f.path);
      }
      return { created, existing };
    },

    'history.search': ({ query, projectId, limit }) => history.search(query, projectId, limit),
    'scrollback.chunks': ({ sessionId }) => ({ session: terms.info(sessionId), chunks: terms.chunks(sessionId) }),
    'scrollback.read': ({ sessionId, seq }) => terms.readChunk(sessionId, seq),

    'layout.get': ({ projectId }) => {
      const row = db.prepare("SELECT dock FROM layouts WHERE project_id = ? AND name = 'current'").get(projectId) as
        | { dock: string }
        | undefined;
      return row ? JSON.parse(row.dock) : null;
    },
    'layout.save': ({ projectId, dock }) => {
      const json = JSON.stringify(dock);
      const updated = db
        .prepare("UPDATE layouts SET dock = ?, updated_at = ? WHERE project_id = ? AND name = 'current'")
        .run(json, Date.now(), projectId);
      if (updated.changes === 0) {
        db.prepare("INSERT INTO layouts (id, project_id, name, dock, updated_at) VALUES (?, ?, 'current', ?, ?)").run(
          randomUUID(),
          projectId,
          json,
          Date.now(),
        );
      }
    },
  };

  return (req: Request, client: Client) => {
    const handler = handlers[req.method] as Handler<Method> | undefined;
    if (!handler) throw new Error(`unknown method ${req.method}`);
    return handler(req.params ?? ({} as never), client);
  };
}
