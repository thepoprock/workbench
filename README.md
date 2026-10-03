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
- History viewer: **Earlier output** (hover a pane) pages through a session's
  full saved output; search hits open it at the matching part.
- Throwaway data dir: `WORKBENCH_DATA_DIR=/some/tmp npm run dev`

## Layout

```
packages/shared   wire protocol + shared types
packages/hub      hub: websocket server, SQLite (node:sqlite) + migrations
packages/app      Electron app: main (starts/finds hub), preload, React renderer
```
