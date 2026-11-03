#!/usr/bin/env node
// Workbench from the command line. The owner's account uses the hub's own key; anyone
// else added under Users uses theirs, which Workbench puts in ~/.workbench-key, and
// sees only their own projects. Their sessions run as their own Mac account.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

const USAGE = `wb projects                        list projects
wb new <name> [folder]             new project (folder defaults to ~/projects/<name>)
wb claude <project> [--resume id]  start a Claude session; prints its id
wb shell <project>                 start a shell
wb sessions [project]              running sessions (with a project: all of its sessions)
wb read <session> [lines]          what the session shows now (default: whole screen)
wb send <session> <text…>          type text and press Enter
wb keys <session> <keys…>          send keys: enter esc tab up down left right ctrl-c, or text
wb stop <session>                  end a session
wb me                              who Workbench knows you as
Projects and sessions can be named by id, or by name or title.`;

const COLS = 120;
const ROWS = 40;
const DATA = process.env.WORKBENCH_DATA_DIR ?? join(homedir(), 'Library/Application Support/Workbench');
const PUBLIC = process.env.WORKBENCH_PUBLIC_DIR ?? '/Users/Shared/workbench';
const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// The owner's own hub.json if this is the owner's account; otherwise the shared port and
// this account's own key.
function address() {
  const own = read(join(DATA, 'hub.json'));
  if (own) return JSON.parse(own);
  const shared = read(join(PUBLIC, 'hub.json'));
  if (!shared) throw new Error("Workbench isn't running on this Mac.");
  const key = read(join(homedir(), '.workbench-key'))?.trim();
  if (!key) throw new Error('No Workbench key here (~/.workbench-key). Ask the owner to add you under Users.');
  return { port: JSON.parse(shared).port, token: key };
}

function connect() {
  const hub = address();
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/?token=${hub.token}`);
  const waiting = new Map();
  let next = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.no(new Error(m.error.message ?? JSON.stringify(m.error))) : w.ok(m.result);
  };
  const open = new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = () => no(new Error("could not reach Workbench: it isn't running, or this key was replaced"));
  });
  return {
    call: async (method, params = {}) => {
      await open;
      return new Promise((ok, no) => {
        const id = ++next;
        waiting.set(id, { ok, no });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

const pick = (items, key, label, what) => {
  const exact = items.find((x) => x.id === key) ?? items.find((x) => label(x).toLowerCase() === key.toLowerCase());
  const found = exact ?? items.filter((x) => x.id.startsWith(key) || label(x).toLowerCase().includes(key.toLowerCase()));
  if (exact) return exact;
  if (found.length === 1) return found[0];
  throw new Error(found.length ? `"${key}" matches more than one ${what}: ${found.map(label).join(', ')}` : `no ${what} "${key}"`);
};

async function project(hub, key) {
  return pick(await hub.call('project.list', {}), key, (p) => p.name, 'project');
}

async function session(hub, key) {
  const live = await hub.call('term.running', {});
  try {
    return pick(live, key, (s) => s.title, 'running session');
  } catch (err) {
    try {
      return await hub.call('term.get', { sessionId: key });
    } catch {
      throw err;
    }
  }
}

const KEYS = { enter: '\r', esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', 'ctrl-c': '\x03', backspace: '\x7f', space: ' ' };
const line = (s) => `${s.id}  ${s.status.padEnd(8)} ${s.kind.padEnd(8)} ${s.title}`;

async function screen(hub, s, lines) {
  const { session: info, snapshot } = await hub.call('term.attach', { sessionId: s.id });
  await hub.call('term.detach', { sessionId: s.id }).catch(() => {});
  const t = new Terminal({ cols: info.cols ?? COLS, rows: info.rows ?? ROWS, scrollback: 5000, allowProposedApi: true });
  await new Promise((done) => t.write(snapshot, done));
  const b = t.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return (lines ? out.slice(-lines) : out.slice(b.baseY)).join('\n');
}

async function main([cmd, ...args]) {
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);
  const hub = connect();
  try {
    if (cmd === 'me') {
      const me = await hub.call('user.me', {});
      console.log(me.owner ? `${me.name} (owner)` : me.name);
    } else if (cmd === 'projects') for (const p of await hub.call('project.list', {})) console.log(`${p.id}  ${p.name}  ${p.rootPath ?? ''}`);
    else if (cmd === 'new') {
      if (!args[0]) throw new Error('wb new <name> [folder]');
      const folder = resolve(args[1] ?? join(homedir(), 'projects', args[0].replace(/[^\w.-]+/g, '-')));
      mkdirSync(folder, { recursive: true });
      const p = await hub.call('project.create', { name: args[0], rootPath: folder });
      console.log(`${p.id}  ${p.name}  ${folder}`);
    } else if (cmd === 'claude' || cmd === 'shell') {
      if (!args[0]) throw new Error(`wb ${cmd} <project>`);
      const p = await project(hub, args[0]);
      const r = args.indexOf('--resume');
      const s =
        cmd === 'claude'
          ? await hub.call('agent.start', { projectId: p.id, cols: COLS, rows: ROWS, ...(r > 0 ? { resume: args[r + 1] } : {}) })
          : await hub.call('term.create', { projectId: p.id, cwd: p.rootPath ?? homedir(), cols: COLS, rows: ROWS });
      console.log(s.id);
    } else if (cmd === 'sessions') {
      const list = args[0] ? await hub.call('term.list', { projectId: (await project(hub, args[0])).id }) : await hub.call('term.running', {});
      for (const s of list) console.log(line(s));
    } else if (cmd === 'read') {
      console.log(await screen(hub, await session(hub, args[0] ?? ''), Number(args[1]) || 0));
    } else if (cmd === 'send' || cmd === 'keys') {
      const s = await session(hub, args[0] ?? '');
      const rest = args.slice(1);
      if (!rest.length) throw new Error(`wb ${cmd} <session> …`);
      if (cmd === 'send') {
        await hub.call('term.input', { sessionId: s.id, data: rest.join(' ') });
        await new Promise((r) => setTimeout(r, 150)); // Enter apart from the text, or Claude takes it as a pasted newline
        await hub.call('term.input', { sessionId: s.id, data: '\r' });
      } else for (const k of rest) await hub.call('term.input', { sessionId: s.id, data: KEYS[k.toLowerCase()] ?? k });
    } else if (cmd === 'stop') {
      await hub.call('term.kill', { sessionId: (await session(hub, args[0] ?? '')).id });
    } else throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  } finally {
    hub.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
