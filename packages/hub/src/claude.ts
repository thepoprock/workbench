import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentState, ClaudeTranscript, LocalClaudeSession, TermSession } from '@workbench/shared';
import { stripAnsi } from './text.ts';
import type { Terminals } from './terminals.ts';

// Claude Code harness. Runs the real `claude` CLI in a hub-owned PTY and
// follows it through hooks injected with --settings (only for sessions we
// launch; the user's global settings are never touched).
//
// Verified against claude 2.1.288: --session-id, --resume, --settings accept
// these forms; hook payloads carry hook_event_name, session_id, prompt,
// tool_name/tool_input, last_assistant_message; transcripts live in
// ~/.claude/projects/<cwd with non-alphanumerics → '-'>/<session id>.jsonl.

export const HARNESS_ID = 'claude-code';
const run = promisify(execFile);
// Printed by Claude once Remote Control connects (verified on 2.1.288).
const REMOTE_URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/;
const BACKGROUND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

// Never blocks or alters Claude: output discarded, 2s cap, always exits 0.
const HOOK_COMMAND =
  'curl -s -o /dev/null --max-time 2 -X POST -H "X-Workbench-Hook: $WORKBENCH_HOOK_TOKEN" ' +
  '-H "Content-Type: application/json" --data-binary @- "$WORKBENCH_HOOK_URL" || true';

const HOOK_SETTINGS = JSON.stringify({
  hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }]])),
});

const MAX_FIELD = 2000; // truncate strings stored in event payloads
const HISTORY_LIMIT = 50;

export const transcriptDir = (cwd: string) =>
  join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

// Resolve `claude` the way the user's login shell would.
function findClaude(): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 10_000 }).trim();
    return out.split('\n').pop() || null;
  } catch {
    return null;
  }
}

type Hook = Record<string, unknown> & { hook_event_name?: string };

export class ClaudeHarness {
  private claudePath: string | null | undefined;
  private hookTokens = new Map<string, Buffer>(); // workbench session id → token
  private historyCache = new Map<string, { key: string; t: ClaudeTranscript | null }>();

  onTurn: (sessionId: string) => void = () => {}; // a turn finished (Stop hook)
  onToolFailure: (session: TermSession, hook: Record<string, unknown>) => void = () => {};

  constructor(
    private terms: Terminals,
    private hubPort: () => number,
  ) {}

  private claude(): string {
    this.claudePath ??= findClaude();
    if (!this.claudePath) throw new Error('claude CLI not found on your login shell PATH');
    return this.claudePath;
  }

  // opts.prompt opens a new conversation with that first message (ignored on resume).
  // opts.remoteName turns on Remote Control under that name (claude.ai / phone).
  start(
    projectId: string | null,
    cwd: string | undefined,
    cols: number,
    rows: number,
    opts: { resume?: string; prompt?: string; remoteName?: string } = {},
  ): TermSession {
    const claudePath = this.claude();
    const { resume, prompt, remoteName } = opts;
    const id = randomUUID();
    const hookEnv = this.registerHooks(id);
    const externalId = resume ?? randomUUID();
    const shell = process.env.SHELL || '/bin/zsh';
    const claudeArgs = [resume ? '--resume' : '--session-id', externalId, '--settings', HOOK_SETTINGS];
    if (remoteName) claudeArgs.push('--remote-control', remoteName);
    if (prompt && !resume) claudeArgs.push('--', prompt);

    try {
      // Through a login shell so Claude's tools get the same PATH as a terminal.
      return this.terms.create(
        projectId,
        cwd,
        cols,
        rows,
        {
          kind: 'agent',
          harness: HARNESS_ID,
          file: shell,
          args: ['-l', '-c', 'exec "$0" "$@"', claudePath, ...claudeArgs],
          env: hookEnv,
          title: 'Claude',
          agent: { state: 'starting', activity: null, externalId, remoteUrl: null },
        },
        id,
      );
    } catch (err) {
      this.unregisterHooks(id);
      throw err;
    }
  }

  // Watch a Claude pane's output for its Remote Control link (it can arrive split).
  private tails = new Map<string, string>();
  scanOutput(sessionId: string, data: string): void {
    const s = this.terms.get(sessionId);
    if (!s?.agent || s.agent.remoteUrl) return;
    const text = ((this.tails.get(sessionId) ?? '') + stripAnsi(data)).slice(-400);
    const m = REMOTE_URL_RE.exec(text);
    if (m) {
      this.tails.delete(sessionId);
      this.terms.updateAgent(sessionId, { remoteUrl: m[0] });
    } else this.tails.set(sessionId, text);
  }

  // Every Claude session on this Mac, as `claude agents --json` reports them.
  async localSessions(): Promise<LocalClaudeSession[]> {
    const { stdout } = await run(this.claude(), ['agents', '--json'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const ours = new Set(this.terms.agentExternalIds());
    return (JSON.parse(stdout) as Record<string, unknown>[]).map((r) => {
      const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
      const sessionId = str('sessionId');
      return {
        id: r.kind === 'background' ? str('id') : null,
        pid: typeof r.pid === 'number' ? r.pid : Number(r.pid) || null,
        kind: r.kind === 'background' ? 'background' : 'interactive',
        name: str('name') ?? 'Claude',
        cwd: str('cwd') ?? '',
        state: str('state') ?? str('status') ?? 'unknown',
        startedAt: typeof r.startedAt === 'number' ? r.startedAt : r.startedAt ? Date.parse(String(r.startedAt)) || null : null,
        sessionId,
        ours: !!sessionId && ours.has(sessionId),
      };
    });
  }

  // Open a background session in a pane (`claude attach`). It runs outside
  // Workbench's hooks, so the pane is a plain terminal.
  attach(id: string, projectId: string, cols: number, rows: number): TermSession {
    if (!BACKGROUND_ID_RE.test(id)) throw new Error('bad session id');
    const shell = process.env.SHELL || '/bin/zsh';
    return this.terms.create(projectId, undefined, cols, rows, {
      kind: 'terminal',
      harness: null,
      file: shell,
      args: ['-l', '-c', 'exec "$0" "$@"', this.claude(), 'attach', id],
      title: `claude attach ${id}`,
    });
  }

  async stop(id: string): Promise<void> {
    if (!BACKGROUND_ID_RE.test(id)) throw new Error('bad session id');
    await run(this.claude(), ['stop', id], { timeout: 15_000 });
  }

  // Hook endpoint + secret for one agent session (any harness).
  registerHooks(sessionId: string): Record<string, string> {
    const token = randomBytes(24).toString('hex');
    this.hookTokens.set(sessionId, Buffer.from(token));
    return {
      WORKBENCH_HOOK_URL: `http://127.0.0.1:${this.hubPort()}/hook/${sessionId}`,
      WORKBENCH_HOOK_TOKEN: token,
    };
  }

  unregisterHooks(sessionId: string): void {
    this.hookTokens.delete(sessionId);
    this.tails.delete(sessionId);
  }

  // POST /hook/<session id>. Returns an HTTP status.
  hook(path: string, token: string | undefined, body: string): number {
    const m = /^\/hook\/([0-9a-f-]{36})$/.exec(path);
    if (!m) return 404;
    const sessionId = m[1];
    const expected = this.hookTokens.get(sessionId);
    const given = Buffer.from(token ?? '');
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) return 403;

    const h = JSON.parse(body) as Hook;
    const event = String(h.hook_event_name ?? 'unknown');
    const session = this.terms.get(sessionId);
    if (!session?.agent) return 410;

    const str = (k: string) => (typeof h[k] === 'string' ? (h[k] as string) : '');
    let state: AgentState | undefined;
    let activity: string | null | undefined;
    let text: string | undefined;

    switch (event) {
      case 'SessionStart':
        state = 'idle';
        activity = null;
        break;
      case 'UserPromptSubmit':
        state = 'working';
        activity = 'Thinking…';
        text = str('prompt');
        break;
      case 'PreToolUse':
        state = 'working';
        activity = describeTool(str('tool_name'), h.tool_input);
        text = activity;
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        state = 'working';
        activity = 'Thinking…';
        break;
      case 'Notification': {
        // Idle reminders ("waiting for your input") shouldn't look like a blocked agent.
        const msg = str('message');
        if (session.agent.state !== 'idle' && !/waiting for your input/i.test(msg)) {
          state = 'waiting';
          activity = msg || 'Needs your attention';
        }
        text = msg;
        break;
      }
      case 'Stop':
        state = 'idle';
        activity = null;
        text = str('last_assistant_message');
        break;
      case 'SessionEnd':
        activity = null;
        break;
    }

    const externalId = str('session_id') || undefined;
    this.terms.updateAgent(sessionId, {
      ...(state && { state }),
      ...(activity !== undefined && { activity }),
      ...(externalId && { externalId }),
    });
    this.terms.recordEvent(sessionId, `agent.${event}`, trimPayload(h), text || undefined);
    // No token cleanup on SessionEnd: /clear ends one Claude session and starts
    // another in the same pane. Tokens go when the pane's process exits.
    if (event === 'Stop') this.onTurn(sessionId);
    if (event === 'PostToolUseFailure') this.onToolFailure(session, h);
    return 204;
  }

  // Past conversations for a project folder, newest first.
  async history(cwd: string): Promise<ClaudeTranscript[]> {
    const dir = transcriptDir(cwd);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const path = join(dir, f);
        const st = statSync(path);
        return { path, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, HISTORY_LIMIT);

    const out: ClaudeTranscript[] = [];
    for (const f of files) {
      const key = `${f.mtime}:${f.size}`;
      let cached = this.historyCache.get(f.path);
      if (cached?.key !== key) {
        cached = { key, t: await readTranscript(f.path, f.mtime, f.size) };
        this.historyCache.set(f.path, cached);
      }
      if (cached.t) out.push(cached.t);
    }
    return out;
  }
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const detail =
    s('command') || (s('file_path') && basename(s('file_path'))) || s('pattern') || s('url') || s('description') || '';
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  return oneLine ? `${name}: ${oneLine.slice(0, 120)}` : name;
}

// Keep events small: drop tool output, cap long strings.
function trimPayload(h: Hook): object {
  const { tool_response: _drop, ...rest } = h;
  return JSON.parse(
    JSON.stringify(rest, (_k, v) => (typeof v === 'string' && v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…` : v)),
  );
}

function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text') as
      | { text?: string }
      | undefined;
    return t?.text ?? null;
  }
  return null;
}

// One pass over a transcript: last ai-title, first real user prompt, first timestamp.
// Lines are prefiltered by substring so large transcripts aren't fully JSON-parsed.
async function readTranscript(path: string, mtime: number, size: number): Promise<ClaudeTranscript | null> {
  let title: string | null = null;
  let firstPrompt: string | null = null;
  let startedAt: number | null = null;

  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const isTitle = line.includes('"type":"ai-title"');
    const wantUser = firstPrompt === null && line.includes('"type":"user"');
    const wantTs = startedAt === null && line.includes('"timestamp"');
    if (!isTitle && !wantUser && !wantTs) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (isTitle && typeof d.aiTitle === 'string') title = d.aiTitle;
    if (wantTs && typeof d.timestamp === 'string') startedAt = Date.parse(d.timestamp) || null;
    if (wantUser && d.type === 'user' && !d.isSidechain) {
      const text = userText((d.message as { content?: unknown } | undefined)?.content);
      // Skip tool results and injected wrappers (<command-name>, <system-reminder>, …).
      if (text && !text.trimStart().startsWith('<')) firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
  }
  if (!title && !firstPrompt) return null; // nothing a person would recognise
  return {
    id: basename(path, '.jsonl'),
    title: title ?? firstPrompt!.slice(0, 80),
    firstPrompt,
    startedAt,
    updatedAt: mtime,
    bytes: size,
  };
}
