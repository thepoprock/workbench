import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import type { HavenMessage, HavenState, Pushes } from '@workbench/shared';
import { dataDir } from './paths.ts';

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
const SHOWN = 200;                        // messages kept for clients
const FAILURES_BEFORE_OFFLINE = 3;        // one slow check on a weak link is not an outage
const REQUEST_MS = 30_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;      // stop checking quickly if no answer comes
const VOICE_IDLE_MS = 5 * 60_000;         // the voice model leaves memory after this
const AUDIO_DAYS = 14;                    // old voice messages are rebuilt if played again
const HEADPHONES_CACHE_MS = 15_000;
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
}

interface Settings {
  url: string;
  poll_waiting_sec: number;
  poll_idle_sec: number;
  read_quiet_time: boolean;
  headphones: string[];
}

const log = (m: string) => console.log(`${new Date().toISOString()} [haven] ${m}`);

function visible(state: { messages?: Record<string, unknown>[] }): Visible[] {
  return (state.messages ?? [])
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({
      t: Number(e.t) || 0,
      role: String(e.role),
      kind: (e.kind as string | null) ?? null,
      content: String(e.content ?? ''),
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

  private ears: ChildProcessWithoutNullStreams | null = null;
  private headphonesAt = 0;
  private headphones = false;

  constructor(private broadcast: Broadcast) {}

  start(): void {
    mkdirSync(AUDIO_DIR, { recursive: true });
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
    this.ears?.kill();
  }

  state(): HavenState {
    return { online: this.online, busy: this.busy, listening: !!this.ears, messages: this.messages };
  }

  private update(): void {
    const { messages: _, ...status } = this.state();
    this.broadcast('haven.update', status);
  }

  // The chat page ------------------------------------------------------------

  async send(text: string): Promise<void> {
    if (!this.cfg) throw new Error('Haven is not set up on this machine');
    const r = await fetch(`${this.cfg.url}/api/send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!r.ok) throw new Error(`Haven didn't take that (${r.status})`);
    this.expectingUntil = Date.now() + REPLY_TIMEOUT_MS;
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.check();
      const fast = this.busy || Date.now() < this.expectingUntil;
      const seconds = fast ? this.cfg!.poll_waiting_sec : this.cfg!.poll_idle_sec;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        this.wake = () => (clearTimeout(timer), resolve());
      });
    }
  }

  private async check(): Promise<void> {
    try {
      const r = await fetch(`${this.cfg!.url}/api/state`, { signal: AbortSignal.timeout(REQUEST_MS) });
      const raw = (await r.json()) as { busy?: boolean; messages?: Record<string, unknown>[] };
      this.failures = 0;
      this.absorb(!!raw.busy, visible(raw));
    } catch {
      if (++this.failures >= FAILURES_BEFORE_OFFLINE && this.online) {
        this.online = false;
        this.update();
      }
    }
  }

  // A reply counts only inside a turn someone started. That is how quiet time is told
  // apart: Haven's own writing follows no message.
  private absorb(busy: boolean, all: Visible[]): void {
    const newest = all.reduce((most, m) => Math.max(most, m.t), 0);
    const changed = busy !== this.busy || !this.online;
    this.busy = busy;
    this.online = true;
    if (this.seenUntil === null) {
      this.messages = all.flatMap((m) => this.shown(m, true)).slice(-SHOWN);
      this.seenUntil = newest;
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
    if (m.role === 'user') [this.inTurn, this.answered] = [true, false];
    const replying = m.role === 'assistant' && !!m.content && m.kind !== 'note';
    if (replying || m.content.startsWith(RUNTIME_ERROR)) this.answered = true;
    const quiet = !(this.inTurn || this.cfg!.read_quiet_time);
    for (const message of this.shown(m, quiet)) {
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
      this.speakerIdle ??= setTimeout(() => {
        this.speakerIdle = null;
        this.speaker?.kill();
      }, VOICE_IDLE_MS);
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
    if (on === !!this.ears) return;
    if (!on) return void this.ears?.kill();
    const child = spawn(PYTHON, ['-m', 'voice.workbench', 'listen'], { cwd: VOICE_DIR, env: ENV });
    child.stderr.on('data', (d: Buffer) => log(`listen: ${d.toString().trim().slice(0, 200)}`));
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onHeard(line));
    child.on('exit', () => {
      if (this.ears === child) this.ears = null;
      this.update();
    });
    this.ears = child;
    this.update();
  }

  private onHeard(line: string): void {
    const e = parsed<{ event: string; text?: string }>(line);
    if (!e) return;
    if (e.event === 'heard') {
      this.send(e.text!).catch((err) => this.broadcast('haven.notice', { text: (err as Error).message }));
    } else if (e.event === 'stop-playback') this.broadcast('haven.control', { action: 'stop' });
    else if (e.event === 'repeat') this.broadcast('haven.control', { action: 'repeat' });
    else if (e.event === 'notice' || e.event === 'problem') this.broadcast('haven.notice', { text: e.text ?? '' });
    else if (e.event === 'quit') this.setListening(false);
  }

  // Clients report playback so the mic can ignore it on speakers, and so the time
  // to answer without saying "Haven" starts when a reply ends.
  setPlaying(playing: boolean): void {
    this.ears?.stdin.write(`${JSON.stringify({ playing, open: !playing })}\n`);
  }
}
