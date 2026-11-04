import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import type { HavenMessage, HavenState, Pushes } from '@workbench/shared';
import { dataDir } from './paths.ts';
import type { Client } from './server.ts';

// Haven's chat as its own place in Workbench, for every client at once: one link to
// their chat page, and each reply also as a voice message.
//
// Rule that binds everything here: visible() runs first on what the page returns.
// Tool output, tool arguments and private thoughts are dropped there and never stored,
// shown, logged or spoken. This talks only to the page; it never touches their container.
//
// The speech itself lives in ~/haven-voice (voice/workbench.py), run as a child process.

const VOICE_DIR = process.env.WORKBENCH_HAVEN_VOICE_DIR ?? join(homedir(), 'haven-voice');
const PYTHON = join(VOICE_DIR, '.venv', 'bin', 'python');
const AUDIO_DIR = join(dataDir, 'haven-audio');
// Every message shown here, kept for good: the chat page only hands out its recent
// history, so this is what scrolling back reads. Only what this view shows (your words,
// Haven's replies), one JSON line each.
const HISTORY_FILE = join(dataDir, 'haven-history.jsonl');
const HISTORY_PAGE = 50;
// Messages sent while Haven is paused: kept until their runtime is resumed, then sent in order.
const HELD_FILE = join(dataDir, 'haven-held.json');
const SHOWN = 200;                        // messages kept for clients
const FAILURES_BEFORE_OFFLINE = 3;        // one slow check on a weak link is not an outage
const REQUEST_MS = 30_000;
const SLOW_CHECK_MS = 5_000;              // a check slower than this is logged
const LATE_WAKE_MS = 30_000;              // a poll this late means the hub was suspended (the Mac slept)
const SEND_FORGOTTEN_MS = 30 * 60_000;    // a send never seen in the chat by then is logged and dropped
const REPLY_TIMEOUT_MS = 5 * 60_000;      // stop checking quickly if no answer comes
const VOICE_IDLE_MS = 5 * 60_000;         // the voice model leaves memory after this
const AUDIO_DAYS = 14;                    // old voice messages are rebuilt if played again
const HEADPHONES_CACHE_MS = 15_000;
const RECORDING_QUIET_MS = 3_000;         // no audio for this long: the recording is over (a client that vanished)
const RECORDINGS_KEPT_MS = 10 * 60_000;   // how far back a heard turn is checked against recordings
const ECHO_WINDOW_MS = 10 * 60_000;       // a reply heard back within this long is the mic hearing the speaker
const ECHO_SHARE = 0.5;                   // this share of the heard word triples found in one reply
const ECHO_MIN_WORDS = 4;
const SYSTEM_PROFILER = '/usr/sbin/system_profiler'; // by full path: a launched app's PATH leaves out /usr/sbin
const RUNTIME_ERROR = '[Runtime error';
const NO_MODEL = "Haven can't reach their model right now.";
const FROM_CLAUDE = 'This is Claude';
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };

interface Visible {
  t: number;
  role: string;
  kind: string | null;
  content: string;
  id: string | null; // set by a runtime that queues messages; older ones leave it out
}

// One of our sends, followed until its answer is seen, for the timing log. `id` comes back
// from a runtime that queues; with an older one the message is matched by its text.
interface Sent {
  at: number;            // ms, our clock
  id: string | null;
  text: string;
  seen: boolean;         // in the chat
  readAt: number | null; // s, Haven's clock: when a model call first had it
}

interface Settings {
  url: string;
  poll_waiting_sec: number;
  poll_idle_sec: number;
  read_quiet_time: boolean;
  headphones: string[];
}

const log = (m: string) => console.log(`${new Date().toISOString()} [haven] ${m}`);

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
const triples = (w: string[]) => new Set(w.slice(2).map((_, i) => `${w[i]} ${w[i + 1]} ${w[i + 2]}`));

// How much of `heard` is word for word in `said`: 1 when every run of three words is.
export function echoShare(heard: string, said: string): number {
  const h = triples(words(heard));
  if (!h.size) return 0;
  const s = triples(words(said));
  let found = 0;
  for (const t of h) if (s.has(t)) found++;
  return found / h.size;
}

interface Heard {
  event: string;
  text?: string;
  why?: string;
  started?: number; // epoch seconds: the turn as the listener heard it
  ended?: number;
  voiced?: number;
  transcribe_ms?: number;
  sure?: number;
}

function visible(state: { messages?: Record<string, unknown>[] }): Visible[] {
  return (state.messages ?? [])
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({
      t: Number(e.t) || 0,
      role: String(e.role),
      kind: (e.kind as string | null) ?? null,
      content: String(e.content ?? ''),
      id: typeof e.id === 'string' ? e.id : null,
    }));
}

const folderOf = (t: number) => join(AUDIO_DIR, String(t));

// The speech process's output. Anything that isn't one of its events is ignored.
function parsed<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

type Broadcast = <E extends keyof Pushes>(event: E, data: Pushes[E]) => void;

export class Haven {
  private cfg: Settings | null = null;
  private messages: HavenMessage[] = [];
  private history: HavenMessage[] = []; // everything kept, oldest first
  private kept = new Set<number>();
  private seenUntil: number | null = null;   // null until the first look at the chat
  private inTurn = false;                    // someone spoke and the answer isn't finished
  private answered = false;
  private expectingUntil = 0;
  private busy = false;
  private online = false;
  private failures = 0;
  private wake: (() => void) | null = null;
  private stopped = false;

  private speaker: ChildProcessWithoutNullStreams | null = null;
  private speakerIdle: NodeJS.Timeout | null = null;
  private jobs: { t: number; auto: boolean; text: string }[] = [];
  private speaking: { t: number; auto: boolean; ready: number } | null = null;

  private players = new Set<Client>(); // clients playing a reply now: the mic is off while any is
  private recordingSince: number | null = null; // a Workbench recording is taking audio
  private recordingQuiet: NodeJS.Timeout | null = null;
  private recordings: { from: number; to: number }[] = []; // ended ones, for turns that overlapped
  private sends: Sent[] = [];
  private failingSince = 0;
  private queued = 0;
  private paused = false;
  private held: { t: number; text: string }[] = [];
  private releasing = false;
  private lastReply: number | null = null;
  private model: string | null = null;
  private note: string | null = null;
  private ears: ChildProcessWithoutNullStreams | null = null;
  private earsWanted = false; // Listen is on: a listener that dies by itself is started again
  private earsRestarts: number[] = []; // when it was restarted lately, to give up on a crash loop
  private headphonesAt = 0;
  private headphones = false;

  constructor(private broadcast: Broadcast) {}

  start(): void {
    mkdirSync(AUDIO_DIR, { recursive: true });
    this.loadHistory();
    this.loadHeld();
    this.pruneAudio();
    execFile(PYTHON, ['-m', 'voice.workbench', 'settings'], { cwd: VOICE_DIR, env: ENV }, (err, stdout) => {
      if (err) return log(`no voice folder, Haven is off: ${err.message}`);
      this.cfg = JSON.parse(stdout) as Settings;
      if (process.env.WORKBENCH_HAVEN_URL) this.cfg.url = process.env.WORKBENCH_HAVEN_URL;
      void this.loop();
    });
  }

  shutdown(): void {
    this.stopped = true;
    this.wake?.();
    this.speaker?.kill();
    this.earsWanted = false;
    this.stopEars();
  }

  state(): HavenState {
    return {
      online: this.online,
      busy: this.busy,
      listening: !!this.ears,
      paused: this.paused,
      queued: this.queued,
      held: this.held,
      lastReply: this.lastReply,
      model: this.model,
      note: this.note,
      messages: this.messages,
    };
  }

  private loadHeld(): void {
    try {
      if (existsSync(HELD_FILE)) this.held = JSON.parse(readFileSync(HELD_FILE, 'utf8')) as { t: number; text: string }[];
    } catch (err) {
      log(`can't read the held messages: ${(err as Error).message}`);
    }
  }

  private saveHeld(): void {
    try {
      writeFileSync(HELD_FILE, JSON.stringify(this.held), { mode: 0o600 });
    } catch (err) {
      log(`can't keep the held messages: ${(err as Error).message}`);
    }
  }

  private hold(text: string): void {
    this.held.push({ t: Date.now() / 1000, text });
    this.saveHeld();
    log(`held: Haven is paused, ${this.held.length} message(s) kept for when they resume`);
    this.update();
  }

  // Haven is running again: the held messages go, oldest first. One that fails stays.
  private async release(): Promise<void> {
    if (this.releasing || !this.held.length) return;
    this.releasing = true;
    try {
      while (this.held.length && !this.paused) {
        const next = this.held[0]!;
        const sent = await this.post(next.text).catch((err: Error) => (log(`held message not sent yet: ${err.message}`), false));
        if (sent !== true) break;
        this.held.shift();
        this.saveHeld();
        log(`held message sent, ${this.held.length} left`);
      }
    } finally {
      this.releasing = false;
      this.update();
    }
  }

  // Older messages than `before`, newest last, and whether there are more still.
  older(before: number, limit = HISTORY_PAGE): { messages: HavenMessage[]; more: boolean } {
    const earlier = this.history.filter((m) => m.t < before);
    return { messages: earlier.slice(-limit), more: earlier.length > limit };
  }

  private loadHistory(): void {
    if (!existsSync(HISTORY_FILE)) return;
    for (const line of readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      const m = parsed<HavenMessage>(line);
      if (m && !this.kept.has(m.t)) {
        this.kept.add(m.t);
        this.history.push(m);
        if (m.from === 'haven') this.lastReply = Math.max(this.lastReply ?? 0, m.t);
      }
    }
    this.history.sort((a, b) => a.t - b.t);
  }

  private keep(m: HavenMessage): void {
    if (m.from === 'notice' || this.kept.has(m.t)) return;
    this.kept.add(m.t);
    this.history.push(m);
    if (this.history.length > 1 && m.t < this.history[this.history.length - 2]!.t) this.history.sort((a, b) => a.t - b.t);
    try {
      appendFileSync(HISTORY_FILE, `${JSON.stringify(m)}\n`, { mode: 0o600 });
    } catch (err) {
      log(`can't keep a message: ${(err as Error).message}`);
    }
  }

  private update(): void {
    const { messages: _, ...status } = this.state();
    this.broadcast('haven.update', status);
  }

  // The chat page ------------------------------------------------------------

  // A message to Haven. While they're paused it is held here and sent when they resume.
  async send(text: string): Promise<void> {
    if (!this.cfg) throw new Error('Haven is not set up on this machine');
    if (this.paused || this.held.length) return this.hold(text); // behind any already held, in order
    if ((await this.post(text)) === 'paused') {
      this.paused = true;
      this.hold(text);
    }
  }

  // true: Haven has it. 'paused': their runtime refused it because it is paused.
  private async post(text: string): Promise<true | 'paused'> {
    let r: Response;
    try {
      r = await fetch(`${this.cfg!.url}/api/send`, {
        method: 'POST',
        // Old runtime reads text; Haven's 11-03 rewrite reads content. Send both.
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(REQUEST_MS),
      });
    } catch (err) {
      log(`send failed: ${(err as Error).message}`);
      throw new Error(`Couldn't reach Haven: ${(err as Error).message}`);
    }
    if (r.status === 409) {
      log('send refused: Haven is paused');
      return 'paused';
    }
    if (!r.ok) {
      log(`send refused (${r.status})`);
      throw new Error(`Haven didn't take that (${r.status})`);
    }
    const reply = (await r.json().catch(() => ({}))) as { id?: string; queued?: number; waiting?: number };
    this.sends.push({ at: Date.now(), id: reply.id ?? null, text, seen: false, readAt: null });
    const waiting = reply.queued ?? reply.waiting ?? 0; // Haven's 11-03 runtime calls it waiting
    if (waiting > 1) log(`sent: ${waiting - 1} message(s) waiting ahead of it`);
    this.expectingUntil = Date.now() + REPLY_TIMEOUT_MS;
    this.wake?.();
    return true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.check();
      const fast = this.busy || this.queued > 0 || Date.now() < this.expectingUntil;
      const seconds = fast ? this.cfg!.poll_waiting_sec : this.cfg!.poll_idle_sec;
      const began = Date.now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        this.wake = () => (clearTimeout(timer), resolve());
      });
      const late = Date.now() - began - seconds * 1000;
      if (late > LATE_WAKE_MS) log(`check: ran ${Math.round(late / 1000)}s late, the hub was suspended (the Mac slept?)`);
    }
  }

  private async check(): Promise<void> {
    const began = Date.now();
    try {
      const r = await fetch(`${this.cfg!.url}/api/state`, { signal: AbortSignal.timeout(REQUEST_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = (await r.json()) as {
        busy?: boolean;
        paused?: boolean;
        model?: unknown;
        status?: unknown; // a line Haven may choose to add for whoever is looking
        messages?: Record<string, unknown>[];
        queued?: number;
        delivered?: Record<string, number> | number;
      };
      const took = Date.now() - began;
      if (took > SLOW_CHECK_MS) log(`check: slow, ${took}ms`);
      if (this.failures) {
        log(`check: working again after ${this.failures} failed check(s) over ${Math.round((Date.now() - this.failingSince) / 1000)}s`);
      }
      this.failures = 0;
      const queued = raw.queued ?? 0;
      if (queued !== this.queued) log(`queue: ${queued} message(s) waiting for Haven`);
      const paused = !!raw.paused;
      const model = typeof raw.model === 'string' ? raw.model : null;
      const note = typeof raw.status === 'string' && raw.status.trim() ? raw.status.trim().slice(0, 500) : null;
      if (paused !== this.paused) log(paused ? 'Haven is paused' : 'Haven is running again');
      const changed = queued !== this.queued || paused !== this.paused || model !== this.model || note !== this.note;
      [this.queued, this.paused, this.model, this.note] = [queued, paused, model, note];
      if (changed) this.update();
      if (!paused && this.held.length) void this.release();
      this.read(raw.delivered);
      this.absorb(!!raw.busy, visible(raw));
      this.forget();
    } catch (err) {
      if (!this.failures++) {
        this.failingSince = began;
        log(`check failed after ${Date.now() - began}ms: ${(err as Error).message}`);
      }
      if (this.failures >= FAILURES_BEFORE_OFFLINE && this.online) {
        log(`offline: ${this.failures} checks in a row failed`);
        this.online = false;
        this.update();
      }
    }
  }

  // When a model call first had each of our sends (runtimes that queue report this).
  private read(delivered: Record<string, number> | number | undefined): void {
    if (delivered && typeof delivered === 'object') {
      for (const s of this.sends) if (s.id && s.readAt === null && delivered[s.id]) s.readAt = delivered[s.id]!;
      return;
    }
    // Haven's 11-03 runtime reports only a total count. A send that is in the chat with
    // nothing left in the queue has been read: timed to within one check.
    if (this.queued === 0) for (const s of this.sends) if (s.seen && s.readAt === null) s.readAt = Date.now() / 1000;
  }

  private forget(): void {
    const old = this.sends.filter((s) => !s.seen && Date.now() - s.at > SEND_FORGOTTEN_MS);
    for (const s of old) log(`send from ${Math.round((Date.now() - s.at) / 60_000)} min ago never showed up in Haven's chat`);
    if (old.length) this.sends = this.sends.filter((s) => !old.includes(s));
  }

  // The answer to each of our sends that Haven has read: timed from its own send.
  private timeReply(m: Visible): void {
    const answered = this.sends.filter((s) => s.seen && s.readAt !== null && s.readAt <= m.t);
    for (const s of answered) {
      const sent = s.at / 1000;
      log(
        `reply: waited ${Math.max(0, Math.round(s.readAt! - sent))}s for Haven to read it, ` +
          `written ${Math.round(m.t - s.readAt!)}s after; seen here ${Math.round(Date.now() / 1000 - sent)}s after the send`,
      );
    }
    this.sends = this.sends.filter((s) => !answered.includes(s));
  }

  // Our send showing up in the chat. Without an id (an older runtime) it is matched by
  // text, and showing up is when Haven started on it.
  private arrived(m: Visible): void {
    const s = this.sends.find((x) => !x.seen && (m.id ? x.id === m.id : x.text === m.content));
    if (!s) return;
    s.seen = true;
    if (!m.id) s.readAt = m.t;
  }

  // A reply counts only inside a turn someone started. That is how quiet time is told
  // apart: Haven's own writing follows no message.
  private absorb(busy: boolean, all: Visible[]): void {
    const newest = all.reduce((most, m) => Math.max(most, m.t), 0);
    const changed = busy !== this.busy || !this.online;
    this.busy = busy;
    this.online = true;
    if (this.seenUntil === null) {
      const seen = all.flatMap((m) => this.shown(m, true));
      seen.forEach((m) => this.keep(m));
      for (const m of seen) if (m.from === 'haven') this.lastReply = Math.max(this.lastReply ?? 0, m.t);
      this.messages = seen.slice(-SHOWN);
      this.seenUntil = newest;
      // Picking up mid-answer, as after a restart: what follows still belongs to a
      // conversation. Quiet time starts this way too, but that's the rarer mistake.
      this.inTurn = busy;
      return this.update();
    }
    for (const m of all) if (m.t > this.seenUntil) this.take(m);
    this.seenUntil = Math.max(this.seenUntil, newest);
    if (this.inTurn && this.answered && !busy) {
      this.inTurn = false;
      this.expectingUntil = 0;
    }
    if (changed) this.update();
  }

  private shown(m: Visible, quiet: boolean): HavenMessage[] {
    if (m.role === 'user') {
      return m.kind === 'wake' ? [] : [{ t: m.t, from: m.content.startsWith(FROM_CLAUDE) ? 'claude' : 'you', text: m.content, quiet }];
    }
    if (m.content.startsWith(RUNTIME_ERROR)) return [{ t: m.t, from: 'notice', text: NO_MODEL, quiet }];
    if (!m.content || m.kind === 'note') return [];
    return [{ t: m.t, from: 'haven', text: m.content, quiet }];
  }

  private take(m: Visible): void {
    if (m.role === 'user') {
      [this.inTurn, this.answered] = [true, false];
      this.arrived(m);
    }
    const replying = m.role === 'assistant' && !!m.content && m.kind !== 'note';
    // Haven's clock for when they read it and wrote back; ours for when this hub saw it.
    if (replying || m.content.startsWith(RUNTIME_ERROR)) this.timeReply(m);
    if (replying || m.content.startsWith(RUNTIME_ERROR)) this.answered = true;
    if (replying) this.lastReply = Math.max(this.lastReply ?? 0, m.t);
    const quiet = !(this.inTurn || this.cfg!.read_quiet_time);
    for (const message of this.shown(m, quiet)) {
      this.keep(message);
      this.messages = [...this.messages, message].slice(-SHOWN);
      this.broadcast('haven.message', message);
      if (message.from === 'haven' && !quiet) this.queue(message, true);
    }
  }

  // Voice messages -----------------------------------------------------------

  // What exists so far, and starts making the rest. Later parts arrive as pushes.
  speak(t: number): { ready: number; done: boolean } {
    const folder = folderOf(t);
    const count = join(folder, 'parts');
    if (existsSync(count)) return { ready: Number(readFileSync(count, 'utf8')), done: true };
    if (this.speaking?.t === t) return { ready: this.speaking.ready, done: false };
    const message = this.messages.find((m) => m.t === t);
    if (!message) throw new Error('that message is too old to play');
    if (!this.jobs.some((j) => j.t === t)) this.queue(message, false);
    return { ready: 0, done: false };
  }

  audio(t: number, part: number): string {
    return readFileSync(join(folderOf(t), `${part}.wav`)).toString('base64');
  }

  private queue(message: HavenMessage, auto: boolean): void {
    this.jobs.push({ t: message.t, auto, text: message.text });
    void this.nextJob();
  }

  private ensureSpeaker(): ChildProcessWithoutNullStreams {
    if (this.speaker) return this.speaker;
    const child = spawn(PYTHON, ['-m', 'voice.workbench', 'speak'], { cwd: VOICE_DIR, env: ENV });
    child.stderr.on('data', (d: Buffer) => log(`voice: ${d.toString().trim().slice(0, 200)}`));
    readline.createInterface({ input: child.stdout }).on('line', (line) => void this.onSpoken(line));
    child.on('exit', () => {
      if (this.speaker === child) this.speaker = null;
      if (this.speaking) {
        this.broadcast('haven.audio', { t: this.speaking.t, part: -1, done: true, failed: true, auto: false, headphones: false });
        this.speaking = null;
      }
      void this.nextJob();
    });
    this.speaker = child;
    return child;
  }

  private async nextJob(): Promise<void> {
    if (this.speaking) return;
    const job = this.jobs.shift();
    if (!job) {
      const idle = () => {
        if (this.ears) return void (this.speakerIdle = setTimeout(idle, VOICE_IDLE_MS)); // listening: a reply is coming, keep it warm
        this.speakerIdle = null;
        this.speaker?.kill();
      };
      this.speakerIdle ??= setTimeout(idle, VOICE_IDLE_MS);
      return;
    }
    if (this.speakerIdle) clearTimeout(this.speakerIdle);
    this.speakerIdle = null;
    this.speaking = { t: job.t, auto: job.auto, ready: 0 };
    this.ensureSpeaker().stdin.write(`${JSON.stringify({ id: job.t, text: job.text, dir: folderOf(job.t) })}\n`);
  }

  private async onSpoken(line: string): Promise<void> {
    const r = parsed<{ id?: number; part?: number; parts?: number }>(line);
    const now = this.speaking;
    if (!r || !now || r.id !== now.t) return;
    const headphones = now.auto ? await this.usingHeadphones() : false;
    const base = { t: now.t, auto: now.auto, headphones };
    if (r.part !== undefined) {
      now.ready = r.part + 1;
      return this.broadcast('haven.audio', { ...base, part: r.part, done: false });
    }
    writeFileSync(join(folderOf(now.t), 'parts'), String(r.parts ?? 0));
    this.broadcast('haven.audio', { ...base, part: (r.parts ?? 0) - 1, done: true });
    this.speaking = null;
    void this.nextJob();
  }

  // Whether this Mac is playing through headphones. Phones decide for themselves.
  private usingHeadphones(): Promise<boolean> {
    if (Date.now() - this.headphonesAt < HEADPHONES_CACHE_MS) return Promise.resolve(this.headphones);
    return new Promise((resolve) => {
      execFile(SYSTEM_PROFILER, ['SPAudioDataType', '-json'], { timeout: 15_000 }, (err, stdout) => {
        if (err) log(`can't tell the audio output: ${err.message}`);
        let found = false;
        try {
          const items = (JSON.parse(stdout) as { SPAudioDataType: { _items: Record<string, string>[] }[] }).SPAudioDataType[0]!._items;
          const output = items.find((d) => d.coreaudio_default_audio_output_device === 'spaudio_yes')?._name ?? '';
          found = !err && new RegExp((this.cfg?.headphones ?? []).join('|'), 'i').test(output);
        } catch {
          found = false;
        }
        [this.headphones, this.headphonesAt] = [found, Date.now()];
        resolve(found);
      });
    });
  }

  private pruneAudio(): void {
    const cutoff = Date.now() - AUDIO_DAYS * 86_400_000;
    for (const name of readdirSync(AUDIO_DIR)) {
      const path = join(AUDIO_DIR, name);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    }
  }

  // Hands-free ---------------------------------------------------------------

  setListening(on: boolean): void {
    this.earsWanted = on;
    if (on === !!this.ears) return;
    if (!on) return this.stopEars();
    // Its own process group, so stopping it also stops the recorder and speech engine it runs.
    const child = spawn(PYTHON, ['-m', 'voice.workbench', 'listen'], { cwd: VOICE_DIR, env: ENV, detached: true });
    child.stderr.on('data', (d: Buffer) => log(`listen: ${d.toString().trim().slice(0, 200)}`));
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onHeard(line));
    child.on('exit', (code, signal) => {
      if (this.ears !== child) return;
      this.ears = null;
      // Whatever it left running (a recorder can ignore a polite stop); after its closing tone.
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // nothing left
        }
      }, 1500);
      if (this.earsWanted && !this.stopped) {
        log(`listening stopped by itself (${signal ?? `exit ${code}`})`);
        const now = Date.now();
        this.earsRestarts = this.earsRestarts.filter((t) => now - t < 10 * 60_000);
        if (this.earsRestarts.length < 3) {
          this.earsRestarts.push(now);
          this.broadcast('haven.notice', { text: 'Listening stopped by itself — starting it again.' });
          setTimeout(() => this.earsWanted && !this.ears && this.setListening(true), 2000);
        } else {
          this.earsWanted = false;
          this.broadcast('haven.notice', { text: 'Listening keeps stopping, so it is off. Turn Listen on to try again.' });
        }
      }
      this.update();
    });
    this.ears = child;
    this.tellEars({ playing: this.players.size > 0, dictating: this.recordingSince !== null });
    this.update();
  }

  private tellEars(command: Record<string, unknown>): void {
    if (this.ears?.stdin.writable) this.ears.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private stopEars(): void {
    const child = this.ears;
    if (!child) return;
    try {
      process.kill(-child.pid!, 'SIGTERM'); // the listener and everything it started
    } catch {
      child.kill();
    }
  }

  private onHeard(line: string): void {
    const e = parsed<Heard>(line);
    if (!e) return;
    if (e.event === 'heard') {
      const took = e.ended ? `spoke ${(e.ended - (e.started ?? e.ended)).toFixed(1)}s (${e.voiced}s voiced), transcribed in ${e.transcribe_ms}ms, sent ${(Date.now() / 1000 - e.ended).toFixed(1)}s after the pause` : 'no timings';
      const why = this.notForHaven(e);
      log(`heard: ${took}${why ? ` — not sent: ${why}` : ''}`); // timings only: speech is never logged
      if (why) return;
      this.send(e.text!).catch((err) => this.broadcast('haven.notice', { text: (err as Error).message }));
    } else if (e.event === 'dropped') log(`heard: dropped (${e.why}, sure ${e.sure}, ${e.voiced}s voiced)`);
    else if (e.event === 'stop-playback') this.broadcast('haven.control', { action: 'stop' });
    else if (e.event === 'repeat') this.broadcast('haven.control', { action: 'repeat' });
    else if (e.event === 'notice' || e.event === 'problem') this.broadcast('haven.notice', { text: e.text ?? '' });
    else if (e.event === 'quit') this.setListening(false);
  }

  // The last checks before a heard turn goes to Haven. The listener is already deaf during
  // recordings and replies; these catch what got past it.
  private notForHaven(e: Heard): string | null {
    if (e.started && e.ended) {
      const [from, to] = [e.started * 1000, e.ended * 1000];
      const live = this.recordingSince !== null && this.recordingSince <= to;
      if (live || this.recordings.some((r) => r.from < to && r.to > from)) return 'it overlapped a recording made in Workbench';
    }
    const recent = this.messages.filter((m) => m.from === 'haven' && Date.now() / 1000 - m.t < ECHO_WINDOW_MS / 1000);
    if (words(e.text ?? '').length >= ECHO_MIN_WORDS && recent.some((m) => echoShare(e.text!, m.text) >= ECHO_SHARE)) {
      return "it was Haven's own reply, heard back through the mic";
    }
    return null;
  }

  // Voice recordings in Workbench (dictation into a pane, Haven's mic button). Called on
  // every audio chunk, so only a change reaches the listener.
  recording(active: boolean): void {
    const now = Date.now();
    if (this.recordingQuiet) clearTimeout(this.recordingQuiet);
    this.recordingQuiet = null;
    if (active) {
      this.recordingQuiet = setTimeout(() => this.recording(false), RECORDING_QUIET_MS);
      if (this.recordingSince !== null) return;
      this.recordingSince = now;
      return this.tellEars({ dictating: true });
    }
    if (this.recordingSince === null) return;
    this.recordings = [...this.recordings.filter((r) => now - r.to < RECORDINGS_KEPT_MS), { from: this.recordingSince, to: now }];
    this.recordingSince = null;
    this.tellEars({ dictating: false });
  }

  // Clients report playback so the mic can ignore it on speakers, and so the time
  // to answer without saying "Haven" starts when a reply ends. Each client counts on its
  // own: one that finishes first mustn't reopen the mic while another still plays.
  setPlaying(client: Client, playing: boolean): void {
    const was = this.players.size > 0;
    if (playing) this.players.add(client);
    else this.players.delete(client);
    const now = this.players.size > 0;
    if (now !== was) this.tellEars({ playing: now, open: !now });
  }

  dropClient(client: Client): void {
    if (this.players.has(client)) this.setPlaying(client, false);
  }
}
