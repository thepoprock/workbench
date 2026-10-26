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
  defaultHarnessId: string | null; // what ⌘⇧A starts; null = Claude Code
  createdAt: number;
  lastActiveAt: number; // last session start or prompt; createdAt if none
  archived: boolean;
}

export type TermStatus = 'running' | 'exited' | 'lost';
export type SessionKind = 'terminal' | 'agent';

// Live agent state, driven by harness events (Claude Code hooks).
export type AgentState = 'starting' | 'working' | 'waiting' | 'idle' | 'limited'; // limited: the account ran out

export interface AgentInfo {
  state: AgentState;
  activity: string | null; // e.g. "Bash: npm test", "needs permission to use Bash"
  externalId: string | null; // the harness's own session id (Claude session id)
  remoteUrl?: string | null; // claude.ai link when Remote Control is on
}

// A Claude session running elsewhere on this Mac (`claude agents --json`).
export interface LocalClaudeSession {
  id: string | null; // background sessions: short id for attach/logs/stop
  pid: number | null; // interactive sessions
  kind: 'background' | 'interactive';
  name: string;
  cwd: string;
  state: string; // idle / busy / blocked / …
  startedAt: number | null;
  sessionId: string | null; // Claude conversation id
  ours: boolean; // launched by Workbench
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
  'project.update': Project; // created, renamed, moved or archived, possibly by another client
  'changelog.update': { projectId: string }; // entries added or changed
  'account.update': { harnessId: string }; // sign-in or token changed
  // A session hit its account's usage limit. movedTo: auto-switch moved it there.
  'agent.limit': { sessionId: string; harnessId: string | null; movedTo: TermSession | null };
  // An error was recorded or changed. alert = show a notification for it.
  'errors.update': { error: ErrorGroup; alert: boolean };
  // A recording's transcript grew, finished or failed (see VoiceUpdate).
  'voice.update': VoiceUpdate;
  // A reply to a job application arrived (alert = notify; false during the first sweep).
  'jobmail.update': { mail: JobMail; alert: boolean };
}

// A past Claude Code conversation, read from ~/.claude/projects/<cwd>/<id>.jsonl.
export interface ClaudeTranscript {
  id: string;
  harnessId: string; // the harness/account that owns the conversation
  provider?: 'claude-code' | 'openai-codex';
  cwd?: string;
  movedHere?: boolean; // shown here by Organize / Move to project, started elsewhere
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

// Everything a project is, in one read: git state, versions, docs, what the hub has logged, and built assets.
export interface ProjectInfo {
  project: Project;
  git: {
    branch: string | null;
    head: { sha: string; subject: string; ts: number } | null;
    commits: number;
    dirty: number; // files with uncommitted changes
    tags: { name: string; ts: number; subject: string }[]; // newest first, at most 20
  } | null;
  version: string | null; // package.json version, else the newest tag
  docs: { name: string; head: string }[]; // README.md, SPEC.md, PLAN.md, IDEA.md, CHANGELOG.md: first lines
  counts: { terminals: number; agents: number; conversations: number; commits: number; sessionsLogged: number; notes: number; errorsOpen: number };
  assets: { dir: string; files: number; bytes: number }[]; // dist/, build/, out/, release/, assets/ when present
}

export type ChangeSource = 'git' | 'session' | 'manual';

export interface ChangeEntry {
  id: string;
  projectId: string;
  ts: number;
  source: ChangeSource;
  summary: string;
  // git: sha, author, branch, files, insertions, deletions
  // session: sessionId, externalId, prompts, files[], commands, final, running
  refs: Record<string, unknown>;
}

export type ErrorSource = 'terminal' | 'logfile' | 'agent-tool' | 'agent-exit';
export type ErrorStatus = 'open' | 'resolved' | 'ignored';

export interface ErrorGroup {
  id: string;
  shortId: string; // "err-ab12cd" — put "fixes err-ab12cd" in a commit to resolve
  projectId: string;
  title: string;
  source: ErrorSource;
  status: ErrorStatus;
  count: number;
  firstSeen: number;
  lastSeen: number;
  fixCommit: string | null;
}

export interface ErrorOccurrence {
  ts: number;
  text: string; // matched line plus surrounding output
  sessionId: string | null;
}

export interface ErrorRule {
  id: string;
  projectId: string | null; // null = every project
  kind: 'output' | 'logfile';
  label: string;
  pattern: string; // JavaScript regex source
  path: string | null; // log file to tail (kind = logfile)
  enabled: boolean; // record matches
  notify: boolean; // alert on new / regressed errors
}

export type HarnessType = 'claude-code' | 'agent-sdk' | 'local-model' | 'custom';

// An agent program Workbench can run in a pane. config by type:
//   claude-code: configDir? (an extra account; absent = your main ~/.claude login)
//   local-model: baseUrl, model, apiKey?   agent-sdk: script?, model?   custom: command
export interface Harness {
  id: string;
  type: HarnessType;
  name: string;
  enabled: boolean;
  builtin: boolean; // Claude Code: can't be deleted or disabled
  config: Record<string, string>;
  // Folder accounts: which parts of the main ~/.claude are linked in.
  sharing?: Record<ShareGroup, boolean>;
}

// What a separate-folder account can share with the main ~/.claude:
//   instructions: CLAUDE.md, settings, hooks   extensions: agents, commands, skills, plugins
//   history: projects/ (conversations + per-project memory)
export type ShareGroup = 'instructions' | 'extensions' | 'history';
// folder: own config folder and sign-in. token: main folder, secondary account's setup-token.
export type AccountMode = 'folder' | 'token';

export interface AccountStatus {
  loggedIn: boolean;
  email: string | null;
  authMethod: string | null;
  tokenHint?: string | null; // token accounts: last characters of the saved token
}

// MCP servers Claude Code loads (see packages/hub/src/mcp.ts for where each lives).
//   user: every project · local: just you, this folder · project: the folder's .mcp.json
//   other: claude.ai connectors and plugin servers (managed elsewhere; can only be switched off here)
export type McpScope = 'user' | 'local' | 'project' | 'other';
export interface McpServer {
  name: string;
  scope: McpScope;
  transport: string; // stdio | http | sse
  target: string; // URL, or command + args
  config: Record<string, unknown>;
  enabled: boolean; // not switched off for this folder
  approval?: 'approved' | 'pending' | 'rejected'; // project (.mcp.json) servers
}
export interface McpHealth {
  name: string;
  target: string;
  state: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'unknown';
  detail: string;
}
// projectId: whose folder (local/project scopes, switches); none = user scope only.
// harnessId: which Claude account's config (default: the main one).
type McpWhere = { projectId?: string; harnessId?: string };

export interface ModelServer {
  name: string;
  baseUrl: string;
  models: string[];
}

// A file Claude Code keeps for you (instructions, settings, agents, memory).
export interface ClaudeFile {
  group: 'global' | 'agents' | 'project' | 'memory';
  path: string;
  label: string;
  bytes: number;
}

// Organize: conversations grouped by where they actually worked (the repo or
// folder whose files they touched most), to file under the right project.
export interface OrganizeGroup {
  root: string; // folder the work happened in
  projectId: string | null; // existing project for that folder
  isRepo: boolean;
  conversations: { id: string; title: string; updatedAt: number; startedIn: string }[];
}

export type HitSource = 'agent' | 'terminal' | 'transcript' | 'commit' | 'error';

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

// Voice: microphone audio streamed from the app as 16 kHz Int16 PCM and
// transcribed in the hub by whisper.cpp while it arrives.
export type VoiceState = 'starting' | 'listening' | 'finishing' | 'done' | 'failed';

export interface VoiceUpdate {
  id: string;
  state: VoiceState; // starting: the model is loading (audio is buffered meanwhile)
  text: string; // settled transcript; only ever grows by appending
  partial: string; // the tail still being recognised; may change
  seconds: number; // audio received so far
  error: string | null; // last engine error (recognition retries; audio is kept)
  file: string | null; // the saved recording (.wav), once finished
  transcriptFile: string | null; // its transcript (.txt)
}

// A saved recording (…/Workbench/voice/<id>.wav + .txt + .json).
export interface VoiceRecording {
  id: string; // file name without extension
  file: string;
  transcriptFile: string | null;
  text: string;
  seconds: number;
  createdAt: number;
  projectId: string | null; // null: recorded before recordings were tagged, or not filed
  sessionId: string | null;
}

// Job-application replies found in Gmail (see hub/src/jobmail.ts).
export type JobMailKind = 'interview' | 'rejection' | 'received' | 'other';
export interface JobMail {
  id: string; // Message-ID
  ts: number;
  from: string;
  subject: string;
  company: string; // a company from ~/Desktop/Job Applications, or "(unmatched company)"
  kind: JobMailKind;
  snippet: string;
  seen: boolean;
}
export interface JobMailStatus {
  user: string | null; // the Gmail address being watched
  lastCheck: number | null;
  error: string | null;
  count: number;
  unseen: number;
  companies: string[];
}

export interface VoiceEngine {
  ready: boolean; // whisper-server is loaded and answering
  model: string | null; // the ggml model file it uses, if one was found
  server: string | null; // the whisper-server binary, if installed
  error: string | null;
}

type Empty = Record<string, never>;

// Method name → params/result. Add methods here; both sides are typed off it.
export interface Methods {
  'hub.info': { params: Empty; result: HubInfo };
  'hub.ping': { params: Empty; result: { now: number } };
  'project.list': { params: { includeArchived?: boolean }; result: Project[] };
  'project.create': { params: { name: string; rootPath?: string }; result: Project };
  'project.update': {
    params: { id: string; name?: string; rootPath?: string | null; defaultHarnessId?: string | null };
    result: Project;
  };
  // Refused while the project has running terminals.
  'project.archive': { params: { id: string; archived: boolean }; result: Project };
  // Sidebar order (drag to sort): ids in the order wanted; projects not listed follow, by name.
  'project.reorder': { params: { ids: string[] }; result: null };

  // Terminals. The hub owns the PTY; clients attach/detach freely.
  'term.create': { params: { projectId: string; cwd?: string; cols: number; rows: number }; result: TermSession };
  'project.info': { params: { projectId: string }; result: ProjectInfo };
  'term.list': { params: { projectId: string }; result: TermSession[] };
  'term.running': { params: Empty; result: TermSession[] }; // every running session, any project
  'term.get': { params: { sessionId: string }; result: TermSession }; // live or ended
  // snapshot = serialized screen + scrollback; term.data pushes follow it.
  'term.attach': { params: { sessionId: string }; result: { session: TermSession; snapshot: string } };
  'term.detach': { params: { sessionId: string }; result: null };
  'term.input': { params: { sessionId: string; data: string }; result: null };
  'term.resize': { params: { sessionId: string; cols: number; rows: number }; result: null };
  'term.kill': { params: { sessionId: string }; result: null };
  // An ended session's successor: its Claude conversation resumed, else a new shell in its folder.
  'term.resume': { params: { sessionId: string; cols: number; rows: number }; result: TermSession };

  // Agents (Claude Code). Run in a hub-owned PTY like terminals; all term.* apply.
  // harnessId omitted = the project's default (Claude Code unless set). resume: Claude Code only.
  'agent.start': {
    params: { projectId: string; harnessId?: string; resume?: string; cols: number; rows: number };
    result: TermSession;
  };
  // Claude sessions outside Workbench on this Mac, and control of background ones.
  'local.sessions': { params: Empty; result: LocalClaudeSession[] };
  'local.attach': { params: { id: string; projectId: string; cols: number; rows: number }; result: TermSession };
  'local.stop': { params: { id: string }; result: null };
  // Claude accounts: each is a Claude Code harness with its own config folder and login.
  'account.add': { params: { name: string; mode: AccountMode }; result: Harness };
  // The account new Claude sessions use (and bill to): the main login or a token account.
  'account.usage': { params: Empty; result: { harnessId: string } };
  'account.setUsage': { params: { harnessId: string }; result: { harnessId: string } };
  'account.share': { params: { harnessId: string; group: ShareGroup; shared: boolean }; result: Harness };
  // Token accounts: save a setup-token (Keychain), or open a pane that runs
  // `claude setup-token` and captures the token itself (nothing written to disk).
  'account.setToken': { params: { harnessId: string; token: string }; result: AccountStatus };
  'account.tokenPane': { params: { harnessId: string; projectId: string; cols: number; rows: number }; result: TermSession };
  'account.status': { params: { harnessId: string }; result: AccountStatus };
  // Opens a pane running `claude auth login` for that account.
  'account.login': { params: { harnessId: string; projectId: string; cols: number; rows: number }; result: TermSession };
  'harness.list': { params: Empty; result: Harness[] };
  'harness.save': { params: { harness: Omit<Harness, 'id' | 'builtin'> & { id?: string } }; result: Harness };
  'harness.delete': { params: { id: string }; result: null };
  // Probes localhost for Ollama / LM Studio / llama.cpp servers and their models.
  'harness.detect': { params: Empty; result: ModelServer[] };
  'mcp.list': { params: McpWhere; result: McpServer[] };
  'mcp.health': { params: McpWhere; result: McpHealth[] };
  // was: the entry being edited (replaced); omit to add.
  'mcp.save': {
    params: McpWhere & { name: string; scope: McpScope; config: Record<string, unknown>; was?: { name: string; scope: McpScope } };
    result: null;
  };
  'mcp.remove': { params: McpWhere & { name: string; scope: McpScope }; result: null };
  'mcp.setEnabled': { params: McpWhere & { projectId: string; name: string; enabled: boolean }; result: null };
  'mcp.setApproval': { params: McpWhere & { projectId: string; name: string; approved: boolean }; result: null };
  // Opens a pane running `claude mcp login <name>` (OAuth in the browser).
  'mcp.login': { params: McpWhere & { projectId: string; name: string; cols: number; rows: number }; result: TermSession };
  'mcp.logout': { params: McpWhere & { name: string }; result: null };
  'agent.history': { params: { projectId: string }; result: ClaudeTranscript[] };
  // Continue a running Claude conversation on another main-folder account
  // (stops this process, resumes the conversation there). Returns the new pane's session.
  'agent.move': { params: { sessionId: string; harnessId: string }; result: TermSession };
  // When an account runs out: 'ask' (notify) or 'auto' (switch Credits + move the session).
  'account.failover': { params: { mode?: 'ask' | 'auto' }; result: { mode: 'ask' | 'auto' } };

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

  // Changelog per project: git commits, agent session summaries, manual notes.
  'changelog.list': { params: { projectId: string; before?: number; limit?: number }; result: ChangeEntry[] };
  'changelog.note': { params: { projectId: string; text: string }; result: ChangeEntry };
  'changelog.delete': { params: { id: string }; result: null }; // manual notes only
  'changelog.commit': { params: { projectId: string; sha: string }; result: string }; // git show --stat

  // Errors: grouped occurrences from terminals, log files and agents.
  'errors.list': { params: { projectId: string; status?: ErrorStatus }; result: ErrorGroup[] };
  'errors.occurrences': { params: { id: string; limit?: number }; result: ErrorOccurrence[] };
  'errors.setStatus': { params: { id: string; status: ErrorStatus }; result: ErrorGroup };
  'errors.counts': { params: Empty; result: Record<string, number> }; // open errors per project
  'rules.list': { params: { projectId: string }; result: ErrorRule[] }; // global + this project's
  'rules.save': { params: { rule: Omit<ErrorRule, 'id'> & { id?: string } }; result: ErrorRule };
  'rules.delete': { params: { id: string }; result: null };

  // Your existing Claude data: files to view/edit, and folders to import as projects.
  'claude.files': { params: { projectId?: string }; result: ClaudeFile[] };
  'claude.read': { params: { path: string }; result: string };
  'claude.write': { params: { path: string; content: string }; result: null };
  'claude.import': { params: Empty; result: { created: Project[]; existing: number } };
  'claude.organize': { params: Empty; result: OrganizeGroup[] };
  // File conversations under projects (creating projects for new folders).
  'claude.organizeApply': {
    params: { groups: { root: string; transcriptIds: string[] }[] };
    result: { created: number; moved: number };
  };
  // Move one conversation to a project (null: back to the folder it was started in).
  'claude.assign': { params: { transcriptId: string; projectId: string | null }; result: null };

  // History. Search spans agent events, terminal output and Claude transcripts.
  'history.search': { params: { query: string; projectId?: string; limit?: number }; result: SearchHit[] };
  // Full saved output of a session, paged by chunk (the last may still be growing).
  'scrollback.chunks': { params: { sessionId: string }; result: { session: TermSession; chunks: ScrollbackChunk[] } };
  'scrollback.read': { params: { sessionId: string; seq: number }; result: string };

  // Voice. Start, stream pcm (base64 Int16LE mono 16 kHz) with notifies, then
  // stop: the hub finishes recognition, saves the wav + transcript and returns
  // the final update. Progress arrives as voice.update pushes. voice.engine
  // reports (and warms up) the speech engine.
  'voice.engine': { params: Empty; result: VoiceEngine };
  'voice.start': { params: { projectId?: string | null; sessionId?: string | null }; result: VoiceUpdate };
  'voice.push': { params: { id: string; pcm: string }; result: null };
  'voice.stop': { params: { id: string }; result: VoiceUpdate };
  'voice.discard': { params: { id: string }; result: null }; // drops the recording and its files
  // Saved recordings. projectId omitted = all; null = unfiled.
  'voice.list': { params: { projectId?: string | null }; result: VoiceRecording[] };
  'voice.audio': { params: { id: string }; result: string }; // the .wav, base64
  'voice.delete': { params: { id: string }; result: null };
  'voice.saveText': { params: { id: string; text: string }; result: null }; // edit a transcript
  'voice.file': { params: { id: string; projectId: string | null }; result: null }; // move to a project

  // Job-application inbox watch (Gmail over IMAP with an app password in the Keychain).
  'jobmail.status': { params: Empty; result: JobMailStatus };
  'jobmail.list': { params: Empty; result: JobMail[] };
  'jobmail.configure': { params: { user: string; password?: string }; result: JobMailStatus };
  'jobmail.check': { params: Empty; result: { added: number } };
  'jobmail.seen': { params: { id: string | null }; result: null }; // null = mark all

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
