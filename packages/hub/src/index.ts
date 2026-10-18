import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { HubDiscovery } from '@workbench/shared';
import { openDb } from './db/index.ts';
import { makeDispatch, type HubOps } from './methods.ts';
import { dataDir, dbPath, discoveryPath, ensureDirs } from './paths.ts';
import { startServer, type Server } from './server.ts';
import { Terminals } from './terminals.ts';
import { ClaudeHarness, HARNESS_ID, projectsRoot } from './claude.ts';
import { History } from './history.ts';
import { Ideas } from './ideas.ts';
import { Changelog } from './changelog.ts';
import { Errors } from './errors.ts';
import { Harnesses } from './harnesses.ts';
import { Voice } from './voice.ts';
import { JobMailWatch } from './jobmail.ts';

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
  db.prepare(
    "INSERT OR IGNORE INTO harnesses (id, type, name, created_at) VALUES (?, 'claude-code', 'Claude Code', ?)",
  ).run(HARNESS_ID, Date.now());
  const claude = new ClaudeHarness(terms, () => server?.port ?? 0);
  // Every Claude account's transcripts are searchable (harnesses is created below).
  let harnessesRef: Harnesses | null = null;
  const history = new History(db, () =>
    harnessesRef ? harnessesRef.accounts().map((a) => projectsRoot(a.configDir)) : [projectsRoot()],
  );
  const ideas = new Ideas(
    db,
    terms,
    claude,
    (idea) => server?.broadcast({ event: 'idea.update', data: idea }),
    () => harnessesRef!.usageClaudeAccount(),
  );
  const changelog = new Changelog(db, (projectId) =>
    server?.broadcast({ event: 'changelog.update', data: { projectId } }),
  );
  const errors = new Errors(db, (error, alert) => server?.broadcast({ event: 'errors.update', data: { error, alert } }));
  claude.onTurn = (id) => changelog.session(id);
  claude.onToolFailure = (s, hook) => errors.agentToolFailure(s.projectId, s.id, hook);
  changelog.onCommit = (projectId, sha, subject) => errors.commit(projectId, sha, subject);
  // Output rules run on shells only: agent screens redraw constantly (counts
  // would inflate) and agents report failures through their hooks anyway.
  terms.onOutput = (s, data) => {
    if (terms.isEphemeral(s.id)) return claude.watchToken(s.id, data);
    if (s.kind === 'terminal') errors.feed(`term:${s.id}`, s.projectId, s.id, data);
    if (s.kind === 'agent' && isClaudeAccount(s.harness)) claude.scanOutput(s.id, data);
  };
  // Every Claude account's sessions are watched (RC link, usage limit), not just the main login's.
  const isClaudeAccount = (id: string | null) => {
    if (!id) return false;
    if (id === HARNESS_ID) return true;
    try {
      return harnessesRef?.get(id).type === 'claude-code';
    } catch {
      return false;
    }
  };
  terms.onEnded = (s, killedByUser) => {
    errors.endStream(`term:${s.id}`);
    claude.endTokenWatch(s.id);
    if (s.kind !== 'agent') return;
    claude.unregisterHooks(s.id);
    changelog.session(s.id);
    if (!killedByUser && s.exitCode) errors.agentExit(s.projectId, s.id, s.exitCode);
  };
  // Entries still marked running belong to sessions the last hub run lost.
  for (const r of db
    .prepare("SELECT ref_key FROM change_entries WHERE source = 'session' AND json_extract(refs, '$.running') = 1")
    .all() as { ref_key: string }[]) {
    changelog.session(r.ref_key.slice('session:'.length));
  }
  const harnesses = new Harnesses(db, terms, claude);
  harnessesRef = harnesses;
  const voice = new Voice(db, (u) => server?.broadcast({ event: 'voice.update', data: u }));
  const jobmail = new JobMailWatch(db, (mail, alert) => server?.broadcast({ event: 'jobmail.update', data: { mail, alert } }));
  const hubOps: HubOps = {};
  const dispatch = makeDispatch(
    db, terms, claude, history, ideas, changelog, errors, harnesses, voice, jobmail,
    (harnessId) => server?.broadcast({ event: 'account.update', data: { harnessId } }),
    (project) => server?.broadcast({ event: 'project.update', data: project }),
    {
    version: VERSION,
    pid: process.pid,
    startedAt,
    dbPath,
    node: process.version,
    },
    hubOps,
  );

  // An account ran out: tell the UI, or (auto) switch Credits to the next
  // main-folder account with a token and move the conversation there.
  const limitedAt = new Map<string, number>(); // account → when it last hit its limit
  claude.onLimit = (s) => {
    const from = s.harness ?? HARNESS_ID;
    limitedAt.set(from, Date.now());
    void (async () => {
      let movedTo = null;
      if (hubOps.failoverMode?.() === 'auto') {
        const fresh = (id: string) => Date.now() - (limitedAt.get(id) ?? 0) > 5 * 3600_000;
        for (const id of harnesses.mainFolderAccounts().filter((x) => x !== from && fresh(x))) {
          try {
            movedTo = await hubOps.moveAgent!(s.id, id);
            harnesses.setUsageAccount(id);
            server?.broadcast({ event: 'account.update', data: { harnessId: id } });
            break;
          } catch (err) {
            log(`failover to ${id} failed: ${(err as Error).message}`);
          }
        }
      }
      server?.broadcast({ event: 'agent.limit', data: { sessionId: s.id, harnessId: s.harness, movedTo } });
    })();
  };

  const token = randomBytes(32).toString('hex');
  server = await startServer(
    dispatch,
    token,
    (client) => terms.dropClient(client),
    (path, headers, body) => claude.hook(path, headers['x-workbench-hook'] as string | undefined, body),
  );
  const discovery: HubDiscovery = { port: server.port, token, pid: process.pid };
  writeFileSync(discoveryPath, JSON.stringify(discovery), { mode: 0o600 });
  log(`listening on 127.0.0.1:${server.port} (pid ${process.pid}, data ${dataDir})`);

  // Index Claude transcripts in the background; searches top it up later.
  const t0 = Date.now();
  history
    .refresh()
    .then(() => log(`transcripts indexed in ${Date.now() - t0}ms`))
    .catch((err) => log(`transcript index failed: ${(err as Error).message}`));

  const shutdown = async (signal: string) => {
    log(`${signal}: shutting down`);
    terms.shutdown();
    voice.shutdown();
    jobmail.shutdown();
    ideas.shutdown();
    errors.shutdown();
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

// The hub owns every running terminal and agent; one stray exception must not
// end them all. Log it and keep serving (the failing operation is lost).
process.on('uncaughtException', (err) => log(`uncaught exception: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`));

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
