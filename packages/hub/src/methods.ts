import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { HubInfo, Method, Methods, Project, Request } from '@workbench/shared';
import { PROTOCOL_VERSION } from '@workbench/shared';
import { schemaVersion, type DB } from './db/index.ts';
import { reply, type Client, type Dispatch } from './server.ts';
import { keychainGet, keychainSet } from './keychain.ts';
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
): Dispatch {
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
  const resumeAccount = (projectId: string, externalId: string): string | undefined => {
    const ran = db
      .prepare('SELECT harness_id FROM sessions WHERE external_id = ? AND harness_id IS NOT NULL ORDER BY started_at DESC LIMIT 1')
      .get(externalId) as { harness_id: string } | undefined;
    if (ran) return ran.harness_id;
    const root = getProject(projectId).root_path;
    return root ? claude.accountOf(externalId, root, harnesses.accounts())?.harnessId : undefined;
  };

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
        // A conversation resumes on the account it lives in.
        harnessId ??= resumeAccount(projectId, resume);
      }
      return harnesses.start(projectId, harnessId, cols, rows, resume);
    },
    'account.add': ({ name, mode }) => harnesses.addAccount(name, mode),
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
    'agent.history': ({ projectId }) => {
      const root = getProject(projectId).root_path;
      return root ? claude.history(root, harnesses.accounts()) : [];
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
