import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { HubInfo, Method, Methods, Project, Request } from '@workbench/shared';
import { PROTOCOL_VERSION } from '@workbench/shared';
import { schemaVersion, type DB } from './db/index.ts';
import { reply, type Client, type Dispatch } from './server.ts';
import type { Terminals } from './terminals.ts';

type Handler<M extends Method> = (params: Methods[M]['params'], client: Client) => unknown;
type Handlers = { [M in Method]: Handler<M> };

interface ProjectRow {
  id: string;
  name: string;
  root_path: string | null;
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
  createdAt: r.created_at,
  archived: r.archived === 1,
});

export function makeDispatch(db: DB, terms: Terminals, info: Omit<HubInfo, 'schemaVersion' | 'protocol'>): Dispatch {
  const getProject = (id: string): ProjectRow => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new Error('unknown project');
    return row;
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

    'project.create': ({ name, rootPath }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('project name is required');
      if (rootPath) checkDir(rootPath);
      const row: ProjectRow = {
        id: randomUUID(),
        name: trimmed,
        root_path: rootPath ?? null,
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
    },

    'project.update': ({ id, name, rootPath }) => {
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
      db.prepare('UPDATE projects SET name = ?, root_path = ? WHERE id = ?').run(row.name, row.root_path, id);
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
    'term.attach': async ({ sessionId }, client) => {
      const { session, snapshot, release } = await terms.attach(sessionId, client);
      return reply({ session, snapshot }, release);
    },
    'term.detach': ({ sessionId }, client) => terms.detach(sessionId, client),
    'term.input': ({ sessionId, data }) => terms.input(sessionId, data),
    'term.resize': ({ sessionId, cols, rows }) => terms.resize(sessionId, cols, rows),
    'term.kill': ({ sessionId }) => terms.kill(sessionId),

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
