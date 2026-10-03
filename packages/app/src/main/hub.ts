import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { APP_DIR_NAME, DISCOVERY_FILE, type HubDiscovery } from '@workbench/shared';

const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);
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
// Dev only for now — runs the TS source with the system node + tsx.
// Packaging will bundle the hub and run it under ELECTRON_RUN_AS_NODE.
function spawnHub(): void {
  const hubDir = resolve(app.getAppPath(), '..', 'hub');
  const log = openSync(join(dataDir, 'hub.log'), 'a');
  const child = spawn('node', ['--import', 'tsx', join(hubDir, 'src', 'index.ts')], {
    cwd: hubDir,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
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
