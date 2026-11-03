// What a user other than the owner may do: their own projects and the sessions in
// them, nothing else. The owner's connection passes through untouched.
import type { Me, Methods, Project, Push, TermSession } from '@workbench/shared';
import type { DB } from './db/index.ts';
import type { Client, Dispatch } from './server.ts';

type Params = Record<string, unknown>;

export function guarded(db: DB, dispatch: Dispatch): { dispatch: Dispatch; visible: (user: Me, push: Push) => boolean } {
  const ownerOf = (projectId: unknown) =>
    (db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(String(projectId)) as { owner_id: string | null } | undefined)?.owner_id;
  const projectOf = (sessionId: unknown) =>
    (db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(String(sessionId)) as { project_id: string | null } | undefined)?.project_id;
  const mine = (user: Me, projectId: unknown) => !!projectId && ownerOf(projectId) === user.id;
  const mySession = (user: Me, sessionId: unknown) => mine(user, projectOf(sessionId));

  const own = (key: string) => (user: Me, p: Params) => mine(user, p[key]);
  const session = (user: Me, p: Params) => mySession(user, p.sessionId);
  const anyone = () => true;
  // Method → may this user call it with these params.
  const allowed: Partial<Record<keyof Methods, (user: Me, p: Params) => boolean>> = {
    'hub.info': anyone,
    'hub.ping': anyone,
    'user.me': anyone,
    'project.list': anyone, // filtered below
    'project.create': anyone, // owned by them, below
    'project.update': own('id'),
    'project.archive': own('id'),
    'project.info': own('projectId'),
    'term.list': own('projectId'),
    'term.running': anyone, // filtered below
    'term.create': own('projectId'),
    'term.get': session,
    'term.attach': session,
    'term.detach': session,
    'term.input': session,
    'term.resize': session,
    'term.kill': session,
    'term.resume': session,
    'agent.start': (user, p) => mine(user, p.projectId) && !p.harnessId, // Claude on their own login
    'scrollback.chunks': session,
    'scrollback.read': session,
  };

  const forUser: Dispatch = async (req, client: Client) => {
    const user = client.user;
    if (user.owner) return dispatch(req, client);
    const p = (req.params ?? {}) as Params;
    const ok = allowed[req.method as keyof Methods];
    if (!ok || !ok(user, p)) throw new Error(`not allowed: ${req.method}`);
    const out = await dispatch(req, client);
    if (req.method === 'project.list') return (out as Project[]).filter((x) => x.ownerId === user.id);
    if (req.method === 'term.running') return (out as TermSession[]).filter((s) => mine(user, s.projectId));
    if (req.method === 'project.create') {
      const created = out as Project;
      db.prepare('UPDATE projects SET owner_id = ? WHERE id = ?').run(user.id, created.id);
      return { ...created, ownerId: user.id };
    }
    return out;
  };

  const visible = (user: Me, push: Push): boolean => {
    const d = push.data as Record<string, unknown>;
    switch (push.event) {
      case 'term.update':
        return mine(user, (d as unknown as TermSession).projectId);
      case 'term.data':
      case 'agent.limit':
        return mySession(user, d.sessionId);
      case 'project.update':
        return (d as unknown as Project).ownerId === user.id;
      default:
        return false; // ideas, accounts, Haven, voice, errors: the owner's
    }
  };

  return { dispatch: forUser, visible };
}
