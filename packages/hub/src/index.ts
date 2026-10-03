import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { HubDiscovery } from '@workbench/shared';
import { openDb } from './db/index.ts';
import { makeDispatch } from './methods.ts';
import { dataDir, dbPath, discoveryPath, ensureDirs } from './paths.ts';
import { startServer, type Server } from './server.ts';
import { Terminals } from './terminals.ts';

const VERSION = '0.0.1';

function log(msg: string): void {
  console.log(`${new Date().toISOString()} [hub] ${msg}`);
}

function readDiscovery(): HubDiscovery | null {
  try {
    return JSON.parse(readFileSync(discoveryPath, 'utf8')) as HubDiscovery;
  } catch {
    return null;
  }
}

// One hub per data dir. hub.json alone is not proof (the pid may have been
// reused), so only step aside if a hub actually answers on that port.
function liveHub(d: HubDiscovery | null): Promise<boolean> {
  if (!d) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/?token=${d.token}`);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 1500);
    ws.once('open', () => done(true));
    ws.once('error', () => done(false));
  });
}

async function main(): Promise<void> {
  ensureDirs();
  const running = readDiscovery();
  if (running && (await liveHub(running))) {
    log(`hub already running (pid ${running.pid}, port ${running.port}); exiting`);
    return;
  }

  const db = openDb(dbPath);
  const startedAt = Date.now();
  // Terminals broadcast through the server, which starts after them.
  let server: Server | null = null;
  const terms = new Terminals(db, (session) => server?.broadcast({ event: 'term.update', data: session }));
  const dispatch = makeDispatch(db, terms, {
    version: VERSION,
    pid: process.pid,
    startedAt,
    dbPath,
    node: process.version,
  });

  const token = randomBytes(32).toString('hex');
  server = await startServer(dispatch, token, (client) => terms.dropClient(client));
  const discovery: HubDiscovery = { port: server.port, token, pid: process.pid };
  writeFileSync(discoveryPath, JSON.stringify(discovery), { mode: 0o600 });
  log(`listening on 127.0.0.1:${server.port} (pid ${process.pid}, data ${dataDir})`);

  const shutdown = async (signal: string) => {
    log(`${signal}: shutting down`);
    terms.shutdown();
    await server?.close();
    db.close();
    try {
      if (readDiscovery()?.pid === process.pid) rmSync(discoveryPath);
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
