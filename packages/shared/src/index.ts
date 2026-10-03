// Wire protocol between the app (client) and the hub (server).
// Transport: one websocket on 127.0.0.1, JSON text frames.
//   client → hub   Request   { id, method, params }
//   client → hub   Notify    { method, params }        (no id → no response)
//   hub → client   Response  { id, result } | { id, error }
//   hub → client   Push      { event, data }   (unsolicited)

export const PROTOCOL_VERSION = 1;

export interface Request<M extends Method = Method> {
  id?: number;
  method: M;
  params: Methods[M]['params'];
}

export type Response =
  | { id: number; result: unknown }
  | { id: number; error: { code: string; message: string } };

export type Push = { [E in keyof Pushes]: { event: E; data: Pushes[E] } }[keyof Pushes];

export interface HubInfo {
  protocol: number;
  version: string;
  pid: number;
  startedAt: number;
  dbPath: string;
  schemaVersion: number;
  node: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string | null;
  createdAt: number;
  archived: boolean;
}

export type TermStatus = 'running' | 'exited' | 'lost';

export interface TermSession {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  status: TermStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

// Pushes (hub → client).
export interface Pushes {
  'term.data': { sessionId: string; data: string }; // only to attached clients
  'term.update': TermSession; // to everyone: status/title changes
}

type Empty = Record<string, never>;

// Method name → params/result. Add methods here; both sides are typed off it.
export interface Methods {
  'hub.info': { params: Empty; result: HubInfo };
  'hub.ping': { params: Empty; result: { now: number } };
  'project.list': { params: { includeArchived?: boolean }; result: Project[] };
  'project.create': { params: { name: string; rootPath?: string }; result: Project };
  'project.update': { params: { id: string; name?: string; rootPath?: string | null }; result: Project };
  // Refused while the project has running terminals.
  'project.archive': { params: { id: string; archived: boolean }; result: Project };

  // Terminals. The hub owns the PTY; clients attach/detach freely.
  'term.create': { params: { projectId: string; cwd?: string; cols: number; rows: number }; result: TermSession };
  'term.list': { params: { projectId: string }; result: TermSession[] };
  // snapshot = serialized screen + scrollback; term.data pushes follow it.
  'term.attach': { params: { sessionId: string }; result: { session: TermSession; snapshot: string } };
  'term.detach': { params: { sessionId: string }; result: null };
  'term.input': { params: { sessionId: string; data: string }; result: null };
  'term.resize': { params: { sessionId: string; cols: number; rows: number }; result: null };
  'term.kill': { params: { sessionId: string }; result: null };

  // Dock layout per project (opaque dockview JSON).
  'layout.get': { params: { projectId: string }; result: unknown | null };
  'layout.save': { params: { projectId: string; dock: unknown }; result: null };
}

export type Method = keyof Methods;

// Written by the hub at startup so clients can find and authenticate to it.
export interface HubDiscovery {
  port: number;
  token: string;
  pid: number;
}

export const APP_DIR_NAME = 'Workbench';
export const DISCOVERY_FILE = 'hub.json';
export const DB_FILE = 'workbench.db';
