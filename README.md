# Workbench

Native macOS workspace for projects and agent harnesses. See [SPEC.md](SPEC.md).

## Run (dev)

```sh
npm install        # also downloads the Electron binary
npm run dev        # starts the app; the app starts the hub if none is running
npm run typecheck
```

The **hub** is a background process that owns sessions and the database. It
keeps running after the app quits (by design). Data, `hub.json` and `hub.log`
live in `~/Library/Application Support/Workbench/`.

- Stop the hub: `pkill -f hub/src/index.ts` — this ends every terminal it owns.
- Terminals: ⌘T or **+** opens one in the selected project. Closing a tab kills
  its shell; switching projects or quitting the app only detaches.
- Claude Code: ⌘⇧A or **Agents +** starts `claude` in a pane for the project.
  Live status (working / needs you / ready) comes from hooks injected with
  `--settings` for that session only — global `~/.claude/settings.json` is
  never modified. **Claude history** lists past conversations for the
  project's folder; click one to resume it.
- Search: ⌘⇧F searches terminal output, agent activity and every Claude
  conversation under `~/.claude/projects` (this project or all). Terminal
  output becomes searchable when its chunk closes (exit, 30 s quiet, or 256 KB).
- Ideas: **Ideas +** captures one; each lives in its own folder
  (`…/Workbench/ideas/<slug>/IDEA.md`). **Draft with Claude** starts Claude
  there, briefed to interview you, then write SPEC.md and PLAN.md — they open
  as tabs live and the stage advances. Claude asks to trust each new idea
  folder once. **Promote to project…** copies the docs (never overwriting)
  into a folder you pick and creates the project.
- Changelog: ⌘⇧L (or **Changelog** in the title bar) per project — git commits
  (polled every 20 s), one entry per Claude session (prompt, files edited,
  commands, Claude's final reply; updated after each turn) and your notes.
- Errors: ⌘⇧E (or **Errors** in the title bar). Terminal output and tailed log
  files are matched against detection rules (defaults: Go panic, Python
  exceptions, TS/npm/Rust errors, `level=ERROR`), agent tool failures and agent
  crashes are recorded too. Errors are grouped by a normalised fingerprint;
  new or regressed ones notify (once per 10 min) and the dock badge shows the
  open count. A commit saying `fixes err-xxxxxx` resolves that error.
- Harnesses (**Harnesses…** in the sidebar): Claude Code (always on), the
  Agent SDK starter (`packages/runner/sdk-agent.mjs` — copy it to build your
  own), local models over any OpenAI-compatible server (Ollama, LM Studio,
  llama.cpp/MLX; "Find local model servers" detects them), OpenAI Codex CLI,
  and custom commands. OpenAI Codex uses the existing `codex` CLI ChatGPT sign-in;
  choose available GPT models in the Codex pane. It does not need an API key.
  **Agents +** offers every enabled harness; a project's right-click
  menu sets its default (what ⌘⇧A starts). Any program can be a harness by
  POSTing the events documented in `packages/runner/events.mjs`.
- Claude accounts (**Harnesses… → Add Claude account**), two kinds:
  - **Separate folder**: own Claude folder (`CLAUDE_CONFIG_DIR`) and sign-in. Per-account
    switches link parts of your main `~/.claude` in: *Instructions & settings*
    (CLAUDE.md, settings, hooks), *Agents, commands & skills*, *History & memory*
    (`projects/`). A switch refuses (and changes nothing) if the account already has its
    own copy.
  - **Main folder + token**: runs in your main `~/.claude` with the account's
    `claude setup-token` token (`CLAUDE_CODE_OAUTH_TOKEN`), so everything is shared while
    the work runs on that account — no logging out. **Get token** runs `setup-token` in a
    pane that captures the token into the macOS Keychain (that pane's output is never
    written to disk or indexed); **Paste token** is the fallback.
  **Credits: ▾** in the title bar picks which account new Claude sessions use (your login
  or a token account) — everything you start afterwards runs and counts on it; running
  sessions keep theirs — right-click one → **Continue on <account>** to move the
  conversation (Workbench stops it and resumes it there). When a Claude session hits its
  usage limit the pane shows a banner to continue on another account; with **Credits ▾ →
  Auto-switch when an account runs out** it moves itself and switches Credits.
  Separate-folder accounts are picked per conversation in
  **Agents +** and resume only in their own folder. History and search cover every account.
- Your existing Claude data: **⤓ Import from Claude** (under Projects) makes a project for
  every folder Claude has been used in, so all past conversations show in Claude history.
  Claude files conversations by the folder they were *started* in (usually ~), so
  **⇄ Organize conversations…** proposes the project each one really belongs to (the repo
  or folder whose files it touched most) for you to review and file; right-click a
  conversation → **Move to project** to fix one by hand (manual moves are never overridden).
  Filed conversations still resume in the folder they were started in.
  OpenAI Codex sessions are loaded from `~/.codex/sessions` into the shared
  **Conversation history** view and search, and can be resumed with Codex CLI.
  ChatGPT conversations on chatgpt.com are separate and aren't exposed by CLI sign-in.
  **Claude files** (Agents section) browses and edits global CLAUDE.md, settings, agents,
  skills and the project's CLAUDE.md and memory — nothing else is reachable
  (`~/.claude.json` never), and JSON is validated before saving.
- Remote Control: Workbench starts Claude with Remote Control on (named after
  the project; switch off with `remoteControl: "off"` on the Claude Code
  harness), so each session is also reachable from claude.ai and your phone —
  right-click an agent for its link. **Elsewhere** in the sidebar lists other
  Claude sessions on this Mac (background agents: click to attach, right-click
  to stop) and opens **Remote sessions**: claude.ai inside a sandboxed pane
  (own storage, no Workbench access, claude.ai only) for driving Remote
  Control sessions on other machines, e.g. one started on Windows with
  `claude --remote-control`.
- History viewer: **Earlier output** (hover a pane) pages through a session's
  full saved output; search hits open it at the matching part.
- Throwaway data dir: `WORKBENCH_DATA_DIR=/some/tmp npm run dev`

## Layout

```
packages/shared   wire protocol + shared types
packages/hub      hub: websocket server, SQLite (node:sqlite) + migrations
packages/app      Electron app: main (starts/finds hub), preload, React renderer
packages/runner   agent programs run in panes: local-model agent, Agent SDK starter, event protocol
```
