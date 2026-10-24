// Smoke test against a running hub: node scripts/smoke-hub.mjs <data dir>
// With --start (CI) it first starts the bundled hub (packages/app/out/hub) under
// Electron's own Node, as the packaged app does, in a fresh data dir.
// Creates a throwaway project, opens a terminal in it, runs a command and
// checks the output, checks the project moved to the top of the recent order,
// then archives what it made. Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'hub', 'package.json'));
const { WebSocket } = require('ws');

let dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: smoke-hub.mjs <data dir> | --start');
let hub = null;
if (dataDir === '--start') {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-smoke-'));
  const electron = createRequire(import.meta.url)('electron'); // path to the binary
  hub = spawn(electron, [join(import.meta.dirname, '..', 'packages', 'app', 'out', 'hub', 'index.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_DATA_DIR: dataDir },
    stdio: 'inherit',
  });
  process.on('exit', () => hub.kill());
}

let disc = null;
for (let i = 0; i < 60 && !disc; i++) {
  try {
    disc = JSON.parse(readFileSync(join(dataDir, 'hub.json'), 'utf8'));
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!disc) throw new Error('no hub.json — the hub did not start');

const ws = new WebSocket(`ws://127.0.0.1:${disc.port}/?token=${disc.token}`);
await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)));
let n = 0;
const waiting = new Map();
let output = '';
ws.on('message', (m) => {
  const r = JSON.parse(m);
  if (r.event === 'term.data') output += r.data.data;
  else if (r.id) waiting.get(r.id)?.(r);
});
const call = (method, params) =>
  new Promise((res, rej) => {
    const id = ++n;
    waiting.set(id, (r) => (r.error ? rej(new Error(`${method}: ${JSON.stringify(r.error)}`)) : res(r.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
setTimeout(() => fail('timed out'), 90_000).unref();

const info = await call('hub.info', {});
console.log(`hub ${info.version} pid ${info.pid} on ${process.platform}`);

const older = await call('project.create', { name: 'smoke-older', rootPath: tmpdir() });
await new Promise((r) => setTimeout(r, 20));
const newer = await call('project.create', { name: 'smoke-newer', rootPath: tmpdir() });

const term = await call('term.create', { projectId: older.id, cols: 100, rows: 30 });
const { snapshot } = await call('term.attach', { sessionId: term.id });
output += snapshot;
await new Promise((r) => setTimeout(r, 3000)); // shell startup
// The command line itself never contains the expected text, only its output does.
const cmd = process.platform === 'win32' ? "echo ('wb'+'smoke')\r" : 'echo wb""smoke\r';
await call('term.input', { sessionId: term.id, data: cmd });
for (let i = 0; i < 40 && !output.includes('wbsmoke'); i++) await new Promise((r) => setTimeout(r, 250));
if (!output.includes('wbsmoke')) fail(`terminal output never showed the command's result:\n${output.slice(-800)}`);
console.log(`terminal ok (${term.title})`);

const list = (await call('project.list', {})).filter((p) => p.id === older.id || p.id === newer.id);
list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
if (list[0]?.id !== older.id) fail('project with the newest session is not first by lastActiveAt');
console.log('recent sort ok');

await call('term.kill', { sessionId: term.id });
await new Promise((r) => setTimeout(r, 500));
for (const p of [older, newer]) await call('project.archive', { id: p.id, archived: true });
ws.close();
console.log('PASS');
process.exit(0);
