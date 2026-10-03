# Workbench — Spec (draft v0.1, 2026-10-03)

> A native macOS app for managing projects and the agent
> harnesses that work on them. Single user (Patrick). Runs entirely on this Mac.

## 1. Goals

1. **One workspace above all projects.** Every project (herd dashboard, bogglinux,
   localchat, future ideas…) is a first-class object with its own layout,
   sessions, history, changelog and errors.
2. **Dockable workspace.** Tiled/tabbed/floating panes — terminals, agent
   sessions, logs, notes, diffs, changelogs — with saved layouts per project.
3. **Terminals and agents that persist.** Closing or restarting the UI never
   kills a running terminal or agent.
4. **Toggleable, multiple harnesses.** Claude Code first; others pluggable;
   our own harnesses (Agent SDK based) are a first-class harness type.
5. **Nothing is lost.** Every session, command, agent message, error and commit
   is persisted and searchable.
6. **Ideas → projects.** Capture an idea, grow it (with an agent) into a spec,
   plan and tasks, then promote it to a real project.
7. **Error tracking from everywhere.** Agent failures, build/test failures,
   service/log errors — grouped, counted, linked to the session/commit that
   caused or fixed them, with alerting.

## 2. Non-goals (for now)

- Remote / cloud agents (deferred — revisit after MVP).
- Anything installed on servers. SSH from a terminal pane is just a terminal.
- Windows/Linux builds. macOS only.
- Multi-user, auth, sharing.
- Replacing the herd fleet deck — that is one small project inside this app.

## 3. Architecture

```
┌──────────────────────── Electron app (UI) ─────────────────────────┐
│ React + dockview (docking) + xterm.js (WebGL) panes                │
│ Pure client: renders state, sends commands. Restartable at will.  │
└───────────────────────────────┬────────────────────────────────────┘
                                │ local websocket (JSON-RPC + streams)
┌───────────────────────────────▼────────────────────────────────────┐
│ Hub — background Node process (launchd agent), TypeScript          │
│  • PTY manager (node-pty) — owns every terminal process            │
│  • Harness runtime — adapters: claude-code, agent-sdk, custom…     │
│  • Event ingest — PTY output, harness events, Claude Code hooks,   │
│    git watcher, log tailers                                        │
│  • Error engine — fingerprint, group, alert                        │
│  • Store — SQLite (WAL) + FTS5, scrollback files on disk           │
└────────────────────────────────────────────────────────────────────┘
```

**Why the split:** the hub owns all long-lived state, so the UI can crash,
update or be closed without losing a session (tmux-like). It also gives one
place where every event is captured.

**Stack:** TypeScript end-to-end · Electron · React · dockview · xterm.js +
node-pty · better-sqlite3 (or node:sqlite) with FTS5 · Agent SDK for custom
harnesses.

**Why Electron over Tauri:** one runtime (Node) for UI, hub and Agent SDK;
xterm.js is most battle-tested on Chromium; devtools. Tauri's only win is RAM,
and the UI is thin enough to port later if that ever matters.

## 4. Data model

Append-only **Event** log is the source of truth; history, changelog and
errors are views/projections over it.

| Entity | Key fields |
|---|---|
| **Project** | id, name, root paths, repos, default harness, tags, archived |
| **Harness** | id, type (`claude-code` \| `agent-sdk` \| `local-model` \| `shell` \| `custom`), command/config, enabled |
| **Session** | id, project, harness, kind (terminal \| agent), status, cwd, started/ended, external id (e.g. Claude session id), tokens/cost |
| **Event** | id, ts, project, session?, kind, payload (JSON), searchable text |
| **Error** | id, project, fingerprint, title, first/last seen, count, status (open/resolved/ignored), source, linked events, fix commit |
| **Idea** | id, title, body, stage (idea → spec → plan → promoted), project? (once promoted), linked sessions |
| **ChangeEntry** | id, project, source (git \| session \| manual), summary, refs (commits, sessions) |
| **Layout** | id, project, dock JSON, name |
| **Note** | id, project, body — free-form pinned notes |

Event kinds (initial): `session.start/end`, `pty.input`, `pty.output` (chunk
refs to scrollback files, not inline), `agent.message`, `agent.tool_call`,
`agent.tool_result`, `agent.cost`, `error`, `git.commit`, `note`, `deploy`.

Storage: one SQLite DB in `~/Library/Application Support/Workbench/`.
Large terminal scrollback is stored as files and indexed, not stored in rows.

**Scrollback:**
- Live panes keep a standard in-memory scrollback (10,000 lines, configurable).
- The hub writes the **full** output of every session to disk (chunked files,
  indexed by offset/time) — nothing is dropped when it leaves the live buffer.
- Older output is **loadable on demand**: "load earlier" at the top of a pane
  pages earlier chunks back in, and any session (live or ended) can be opened
  in a history viewer at any point in its output.
- Retention: keep everything by default; a cleanup/archive setting comes later
  if disk use warrants it.

## 5. Harnesses

A harness adapter implements:

```ts
interface Harness {
  start(opts: { project; cwd; prompt?; resume? }): Session
  send(session, input): void          // prompt / keystrokes
  stop(session): void
  events(session): AsyncIterable<Event>  // normalized events
}
```

- **claude-code (first):**
  - Interactive: `claude` in a hub-owned PTY pane.
  - Structured: Claude Code **hooks** (SessionStart, Pre/PostToolUse, Stop,
    Notification…) POST to the hub → live status ("editing X", "waiting for
    permission") without screen-scraping.
  - Resume: `claude --resume <id>`.
  - **History import:** backfill from `~/.claude/projects/**/*.jsonl`.
  - **Context browser:** CLAUDE.md, memory dirs, `~/.claude/agents/`,
    settings — view/edit per project.
- **agent-sdk / custom:** our own harnesses written against the Agent SDK, run
  by the hub, emitting the same normalized events.
- **shell:** plain terminal; still a Session with captured history.
- **local-model:** local LLMs via an OpenAI-compatible endpoint (Ollama,
  LM Studio, llama.cpp server). Model picker per session; runs the same agent
  loop/tools as our custom harnesses, so a local model can be swapped in
  wherever a hosted one is used. Hub detects running servers on localhost.
- Harnesses are toggled on/off globally and per project.

## 6. Errors

Sources: harness events (tool failures, crashes, non-zero exits), PTY output
matchers (per-project regex rules), build/test commands, tailed log files.
Each error is fingerprinted (normalized message + source) → grouped → counted.
Alerts: macOS notification + badge, debounced; per-rule mute.
Resolve manually or automatically when linked to a fix commit.

## 7. MVP (v1) — the first three things, done well

1. **Docked terminals + Claude Code sessions per project**, persisting across
   UI restarts, with saved layouts.
2. **Session history** — every session searchable (FTS), replayable
   scrollback, Claude transcript import.
3. **Idea → spec workspace** — capture ideas, work them up with an agent,
   promote to a project.

Then: changelog view (git + sessions) → error tracking → context browser →
custom harnesses → local-model harness → remote agents.

## 8. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 ✅ | Skeleton | Electron app + hub launch; websocket connected; SQLite schema migrated |
| M1 ✅ | Terminals | Hub-owned PTYs in dockable panes; survive UI restart; layout saved per project |
| M2 ✅ | Projects | Project CRUD, sidebar, per-project layouts & sessions |
| M3 ✅ | Claude Code | Launch/resume in pane; hooks → live status; transcript import |
| M4 ✅ | History | FTS search across sessions/events; scrollback replay |
| M5 ✅ | Ideas | Idea board, agent-assisted spec drafting, promote to project |
| M6 ✅ | Changelog | Git watcher + session summaries per project |
| M7 | Errors | Ingest, fingerprint, group, alert |
| M8 | Harnesses | Agent SDK custom harnesses + local-model harness (Ollama/LM Studio) |

## 9. Open questions

- Remote agents — deferred; revisit after M5.
