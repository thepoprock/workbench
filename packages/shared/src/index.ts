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
export type SessionKind = 'terminal' | 'agent';

// Live agent state, driven by harness events (Claude Code hooks).
export type AgentState = 'starting' | 'working' | 'waiting' | 'idle';

export interface AgentInfo {
  state: AgentState;
  activity: string | null; // e.g. "Bash: npm test", "needs permission to use Bash"
  externalId: string | null; // the harness's own session id (Claude session id)
}

// A PTY-backed session: a plain shell, or an agent CLI running in a terminal.
export interface TermSession {
  id: string;
  projectId: string | null; // null for an idea's Claude session
  kind: SessionKind;
  harness: string | null; // 'claude-code' for agents
  agent: AgentInfo | null;
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
  'idea.update': Idea; // metadata or a file in its folder changed
}

// A past Claude Code conversation, read from ~/.claude/projects/<cwd>/<id>.jsonl.
export interface ClaudeTranscript {
  id: string;
  title: string;
  firstPrompt: string | null;
  startedAt: number | null;
  updatedAt: number;
  bytes: number;
}

export type IdeaStage = 'idea' | 'spec' | 'plan' | 'promoted';

export interface Idea {
  id: string;
  title: string;
  stage: IdeaStage;
  folder: string;
  files: string[]; // markdown files in the folder, IDEA.md first
  sessionId: string | null; // workbench session of its Claude agent
  projectId: string | null; // set once promoted
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type HitSource = 'agent' | 'terminal' | 'transcript';

export interface SearchHit {
  source: HitSource;
  projectId: string | null; // null: a transcript from a folder that isn't a project
  sessionId: string | null; // workbench session (agent / terminal hits)
  transcriptId: string | null; // Claude session id (transcript hits)
  seq: number | null; // scrollback chunk (terminal hits)
  ts: number | null;
  title: string; // session or conversation title
  where: string; // cwd / project name
  snippet: string; // matched text, with \u0001…\u0002 around matches
}

export interface ScrollbackChunk {
  seq: number;
  byteStart: number;
  byteEnd: number;
  tsStart: number;
  tsEnd: number;
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
  'term.get': { params: { sessionId: string }; result: TermSession }; // live or ended
  // snapshot = serialized screen + scrollback; term.data pushes follow it.
  'term.attach': { params: { sessionId: string }; result: { session: TermSession; snapshot: string } };
  'term.detach': { params: { sessionId: string }; result: null };
  'term.input': { params: { sessionId: string; data: string }; result: null };
  'term.resize': { params: { sessionId: string; cols: number; rows: number }; result: null };
  'term.kill': { params: { sessionId: string }; result: null };

  // Agents (Claude Code). Run in a hub-owned PTY like terminals; all term.* apply.
  'agent.start': { params: { projectId: string; resume?: string; cols: number; rows: number }; result: TermSession };
  'agent.history': { params: { projectId: string }; result: ClaudeTranscript[] };

  // Ideas: a folder of markdown files worked up with Claude, then promoted to a project.
  'idea.list': { params: { includeArchived?: boolean }; result: Idea[] };
  'idea.create': { params: { title: string }; result: Idea };
  'idea.update': { params: { id: string; title?: string; stage?: IdeaStage; archived?: boolean }; result: Idea };
  'idea.read': { params: { id: string; file: string }; result: string };
  'idea.write': { params: { id: string; file: string; content: string }; result: null };
  // Starts (or resumes, or returns the running) Claude session for the idea.
  'idea.agent': { params: { id: string; cols: number; rows: number }; result: TermSession };
  // Copies the idea's files into rootPath (never overwriting) and creates a project there.
  'idea.promote': { params: { id: string; rootPath: string; name?: string }; result: { project: Project; skipped: string[] } };

  // History. Search spans agent events, terminal output and Claude transcripts.
  'history.search': { params: { query: string; projectId?: string; limit?: number }; result: SearchHit[] };
  // Full saved output of a session, paged by chunk (the last may still be growing).
  'scrollback.chunks': { params: { sessionId: string }; result: { session: TermSession; chunks: ScrollbackChunk[] } };
  'scrollback.read': { params: { sessionId: string; seq: number }; result: string };

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
