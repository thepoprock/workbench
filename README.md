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
- Throwaway data dir: `WORKBENCH_DATA_DIR=/some/tmp npm run dev`

## Layout

```
packages/shared   wire protocol + shared types
packages/hub      hub: websocket server, SQLite (node:sqlite) + migrations
packages/app      Electron app: main (starts/finds hub), preload, React renderer
```
