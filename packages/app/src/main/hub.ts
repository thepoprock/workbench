import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { DISCOVERY_FILE, type HubDiscovery } from '@workbench/shared';

// Electron's userData is the same per-OS folder the hub defaults to.
const dataDir = process.env.WORKBENCH_DATA_DIR ?? app.getPath('userData');
const discoveryPath = join(dataDir, DISCOVERY_FILE);

function readDiscovery(): HubDiscovery | null {
  try {
    return JSON.parse(readFileSync(discoveryPath, 'utf8')) as HubDiscovery;
  } catch {
    return null;
  }
}

function probe(d: HubDiscovery): Promise<boolean> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/?token=${d.token}`);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      ws.close();
      done(ok);
    };
    const timer = setTimeout(() => finish(false), 1500);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
  });
}

// The hub outlives the app: spawned detached, never killed on quit.
// Dev: the TS source with the system node + tsx. Packaged: the bundled hub
// (scripts/bundle-hub.mjs) under Electron's own Node, so nothing else is needed.
function spawnHub(): void {
  // First run: the data folder doesn't exist until the hub makes it, but the log goes there.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dataDir, 'hub.log'), 'a');
  const opts = { detached: true, windowsHide: true, stdio: ['ignore', log, log] as ['ignore', number, number] };
  if (app.isPackaged) {
    spawn(process.execPath, [join(__dirname, '..', 'hub', 'index.mjs')], {
      ...opts,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WORKBENCH_DATA_DIR: dataDir,
        WORKBENCH_RUNNER_DIR: join(process.resourcesPath, 'runner'),
      },
    }).unref();
    return;
  }
  const hubDir = resolve(app.getAppPath(), '..', 'hub');
  spawn('node', ['--import', 'tsx', join(hubDir, 'src', 'index.ts')], { ...opts, cwd: hubDir, env: process.env }).unref();
}

let pending: Promise<HubDiscovery> | null = null;

// Returns a hub that answered a probe, starting one if needed.
export function ensureHub(): Promise<HubDiscovery> {
  pending ??= (async () => {
    const existing = readDiscovery();
    if (existing && (await probe(existing))) return existing;

    spawnHub();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const d = readDiscovery();
      if (d && d.pid !== existing?.pid && (await probe(d))) return d;
    }
    throw new Error(`hub did not start within 15s — see ${join(dataDir, 'hub.log')}`);
  })().finally(() => {
    pending = null;
  });
  return pending;
}
