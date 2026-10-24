// Voice: microphone audio streamed from the app, transcribed live with
// whisper.cpp. The hub keeps one whisper-server loaded (the first recording
// starts it; ten idle minutes stop it) and runs a recognition pass over the
// uncommitted tail of each recording as audio arrives. A segment is committed
// once it ends clear of the live edge, so text the app has shown as final never
// changes; the tail is shown as partial and re-recognised with more context.
// Every recording is saved as a 16 kHz wav next to its transcript, before the
// final pass, so a failed engine never loses what was said.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { delimiter, join } from 'node:path';
import type { VoiceEngine, VoiceRecording, VoiceUpdate } from '@workbench/shared';
import type { DB } from './db/index.ts';
import { dataDir } from './paths.ts';
import { isWindows } from './platform.ts';

const RATE = 16_000;
const BPS = 2; // bytes per sample (Int16LE mono)
const PASS_EVERY_S = 1.5; // run a pass once this much new audio has arrived
const SETTLE_S = 1.0; // a segment ending this close to the live edge may still change
const LONG_TAIL_S = 25; // past this, everything but the last segment is committed
const SILENCE_RMS = 0.003; // below both of these the window is not sent to whisper
const SILENCE_PEAK = 0.02; // (it invents text for silence)
const MIN_WORD_PROB = 0.35; // segments whose words average below this are dropped
const IDLE_STOP_MS = 10 * 60_000;
const START_TIMEOUT_MS = 90_000;
const KEEP_DONE_MS = 60 * 60_000; // a finished recording stays addressable (discard) this long
const EXTRA_PATH = isWindows ? [] : ['/opt/homebrew/bin', '/usr/local/bin'];
// Bracketed/parenthesised "events", music notes, punctuation-only output.
const JUNK = /^[\s.,!?\-–—]*$|^\[.*\]$|^\(.*\)$|^♪/;
// Phrases whisper invents from room noise or silence. Dropped only when the
// audio under them is quiet or the decode was unsure, so a spoken "okay" stays.
const PHANTOM = /^(thank you( (so much|very much|for watching))?|thanks( for watching)?|okay|ok|you|bye|so|oh|uh|um|hmm|yeah|right|all right)[.!?]*$/i;
const PHANTOM_RMS = 0.02; // speech through the mic (with auto gain) sits well above this
const PHANTOM_PROB = 0.75;

export const voiceDir = join(dataDir, 'voice');
export const modelsDir = join(dataDir, 'models');

const log = (msg: string) => console.log(`${new Date().toISOString()} [voice] ${msg}`);

function findBinary(name: string): string | null {
  for (const d of [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_PATH]) {
    if (!d) continue;
    const p = join(d, isWindows ? `${name}.exe` : name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

// Setting 'voice.model' → $WORKBENCH_WHISPER_MODEL → the largest ggml *.bin in <data>/models.
function findModel(db: DB): string | null {
  const setting = (db.prepare("SELECT value FROM settings WHERE key = 'voice.model'").get() as { value: string } | undefined)?.value;
  for (const p of [setting, process.env.WORKBENCH_WHISPER_MODEL]) if (p && existsSync(p)) return p;
  try {
    const files = readdirSync(modelsDir)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => join(modelsDir, f));
    files.sort((a, b) => statSync(b).size - statSync(a).size);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * BPS, 28);
  h.writeUInt16LE(BPS, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function loudness(pcm: Buffer): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  const n = pcm.length / BPS;
  for (let i = 0; i + 1 < pcm.length; i += BPS) {
    const v = pcm.readInt16LE(i) / 32768;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: n ? Math.sqrt(sum / n) : 0, peak };
}

// Bytes [from, to) of a chunk list without concatenating the whole recording.
function slice(chunks: Buffer[], from: number, to: number): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (const c of chunks) {
    const end = at + c.length;
    if (end > from && at < to) parts.push(c.subarray(Math.max(0, from - at), Math.min(c.length, to - at)));
    at = end;
    if (at >= to) break;
  }
  return Buffer.concat(parts);
}

// Where to cut between committed and live audio: the quietest moment near the
// boundary whisper reported. Its timestamps drift a few hundred ms either way,
// and cutting inside a word loses it or hears it twice; a real pause splits
// nothing. Returns a byte offset into the window, or null when nothing near the
// boundary is quiet (the caller then waits for a pause, or a longer tail).
function quietCut(window: Buffer, atSec: number, maxSec: number): number | null {
  const frame = Math.round(0.08 * RATE);
  const step = Math.round(0.02 * RATE);
  const lo = Math.max(0, Math.round((atSec - 0.4) * RATE));
  const hi = Math.min(Math.round(maxSec * RATE), Math.round((atSec + 0.4) * RATE), window.length / BPS);
  if (hi - lo < frame) return null;
  const rms = (s0: number, s1: number) => {
    let sum = 0;
    for (let i = s0; i < s1; i++) {
      const v = window.readInt16LE(i * BPS) / 32768;
      sum += v * v;
    }
    return Math.sqrt(sum / (s1 - s0));
  };
  const around = rms(lo, hi);
  let best = -1;
  let bestRms = Infinity;
  for (let s0 = lo; s0 + frame <= hi; s0 += step) {
    const r = rms(s0, s0 + frame);
    if (r < bestRms) {
      bestRms = r;
      best = s0;
    }
  }
  if (best < 0 || !(bestRms < 0.01 || bestRms < around * 0.15)) return null;
  return (best + Math.floor(frame / 2)) * BPS;
}

const joinText = (...parts: string[]) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

interface Segment {
  text: string;
  start: number; // seconds from the window start
  end: number;
  prob: number; // mean word probability
}

// One whisper-server, started on demand, stopped when idle.
class Engine {
  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private tail: string[] = []; // last lines the server printed, for error messages
  private chain: Promise<unknown> = Promise.resolve(); // one request at a time
  error: string | null = null;

  constructor(private db: DB) {}

  status(): VoiceEngine {
    return { ready: !!this.url, model: findModel(this.db), server: findBinary('whisper-server'), error: this.error };
  }

  ensure(): Promise<string> {
    if (this.url) return Promise.resolve(this.url);
    this.starting ??= this.start()
      .catch((err) => {
        this.error = (err as Error).message;
        throw err;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async start(): Promise<string> {
    const bin = findBinary('whisper-server');
    if (!bin) throw new Error('whisper-server not found — install whisper.cpp (brew install whisper-cpp)');
    const model = findModel(this.db);
    if (!model) throw new Error(`no speech model — put a ggml-*.bin (whisper.cpp) in ${modelsDir}`);
    const port = await freePort();
    const t0 = Date.now();
    // Beam search (5) over the default greedy decode: slower per pass, noticeably fewer misheard words.
    const proc = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', '8', '-l', 'en', '-bs', '5'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.tail = [];
    const keep = (c: Buffer) => {
      for (const l of c.toString().split('\n')) {
        if (!l.trim()) continue;
        this.tail.push(l.trim());
        if (this.tail.length > 20) this.tail.shift();
      }
    };
    proc.stdout!.on('data', keep);
    proc.stderr!.on('data', keep);
    let exited = false;
    proc.on('exit', (code) => {
      exited = true;
      if (this.proc === proc) {
        this.proc = null;
        this.url = null;
      }
      log(`whisper-server exited (${code ?? 'signal'})`);
    });
    this.proc = proc;
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`whisper-server failed to start: ${this.tail.slice(-3).join(' | ')}`);
      try {
        await fetch(`${url}/`, { signal: AbortSignal.timeout(1000) });
        this.url = url;
        this.error = null;
        this.touch();
        log(`whisper-server ready on ${port} in ${Date.now() - t0}ms (${model})`);
        return url;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    proc.kill();
    throw new Error('whisper-server did not start within 90 s');
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop('idle'), IDLE_STOP_MS);
    this.idle.unref();
  }

  stop(why: string): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.proc) {
      log(`stopping whisper-server (${why})`);
      this.proc.kill();
    }
    this.proc = null;
    this.url = null;
  }

  transcribe(pcm: Buffer, prompt: string): Promise<Segment[]> {
    const run = async () => {
      const url = await this.ensure();
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav(pcm))], { type: 'audio/wav' }), 'audio.wav');
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');
      if (prompt) form.append('prompt', prompt);
      const res = await fetch(`${url}/inference`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`whisper-server answered HTTP ${res.status}`);
      const j = (await res.json()) as {
        segments?: { text: string; start: number; end: number; words?: { probability: number }[] }[];
      };
      this.touch();
      return (j.segments ?? []).map((s) => ({
        text: s.text.trim(),
        start: s.start,
        end: s.end,
        prob: s.words?.length ? s.words.reduce((a, w) => a + w.probability, 0) / s.words.length : 1,
      }));
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }
}

interface Rec {
  u: VoiceUpdate;
  projectId: string | null; // where it was recorded (for the Recordings pane)
  sessionId: string | null;
  startedAt: number;
  chunks: Buffer[];
  bytes: number;
  committed: number; // byte offset: audio before this is final text
  passedTo: number; // byte offset at the start of the last pass
  lastSeg: string; // repetition guard (a looping decoder repeats one segment)
  busy: Promise<void> | null;
  finishing: Promise<VoiceUpdate> | null;
  timer: NodeJS.Timeout | null;
}

export class Voice {
  private recs = new Map<string, Rec>();
  private engine: Engine;

  constructor(
    private db: DB,
    private send: (u: VoiceUpdate) => void,
  ) {
    this.engine = new Engine(db);
  }

  // What the app shows before the first recording; also warms the server up.
  engineStatus(): VoiceEngine {
    void this.engine.ensure().catch(() => {});
    return this.engine.status();
  }

  start(projectId: string | null = null, sessionId: string | null = null): VoiceUpdate {
    const id = randomUUID();
    const u: VoiceUpdate = { id, state: 'starting', text: '', partial: '', seconds: 0, error: null, file: null, transcriptFile: null };
    const rec: Rec = { u, projectId, sessionId, startedAt: Date.now(), chunks: [], bytes: 0, committed: 0, passedTo: 0, lastSeg: '', busy: null, finishing: null, timer: null };
    this.recs.set(id, rec);
    this.engine.ensure().then(
      () => {
        if (rec.u.state !== 'starting') return;
        rec.u.state = 'listening';
        this.emit(rec);
        this.maybePass(rec);
      },
      (err) => {
        // Audio keeps being buffered and saved; only recognition is off.
        rec.u.error = (err as Error).message;
        if (rec.u.state === 'starting') rec.u.state = 'listening';
        this.emit(rec);
      },
    );
    return { ...u };
  }

  // pcm: base64 Int16LE mono 16 kHz.
  push(id: string, pcm: string): void {
    const rec = this.rec(id);
    if (rec.finishing) return;
    const buf = Buffer.from(pcm, 'base64');
    if (buf.length % BPS) throw new Error('pcm must be whole 16-bit samples');
    rec.chunks.push(buf);
    rec.bytes += buf.length;
    rec.u.seconds = rec.bytes / BPS / RATE;
    this.maybePass(rec);
  }

  stop(id: string): Promise<VoiceUpdate> {
    const rec = this.rec(id);
    rec.finishing ??= this.finish(rec);
    return rec.finishing;
  }

  discard(id: string): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    rec.finishing ??= Promise.resolve(rec.u); // stops further passes
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.u.file) removeRecording(rec.u.file.replace(/\.wav$/, ''));
    this.recs.delete(id);
  }

  // Hub going down: nothing is lost — unfinished recordings are written out as they are.
  shutdown(): void {
    for (const rec of this.recs.values()) {
      if (rec.u.file || rec.bytes === 0) continue;
      try {
        this.save(rec);
      } catch (err) {
        log(`could not save recording ${rec.u.id}: ${(err as Error).message}`);
      }
    }
    this.engine.stop('hub shutdown');
  }

  private rec(id: string): Rec {
    const rec = this.recs.get(id);
    if (!rec) throw new Error('unknown recording');
    return rec;
  }

  private emit(rec: Rec): void {
    this.send({ ...rec.u });
  }

  private save(rec: Rec): void {
    mkdirSync(voiceDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = join(voiceDir, `${stamp}-${rec.u.id.slice(0, 8)}`);
    writeFileSync(`${base}.wav`, wav(Buffer.concat(rec.chunks)));
    writeFileSync(`${base}.txt`, `${rec.u.text}\n`);
    writeFileSync(`${base}.json`, JSON.stringify({ projectId: rec.projectId, sessionId: rec.sessionId, startedAt: rec.startedAt }));
    rec.u.file = `${base}.wav`;
    rec.u.transcriptFile = `${base}.txt`;
  }

  private maybePass(rec: Rec): void {
    if (rec.busy || rec.finishing || rec.u.state !== 'listening') return;
    if (rec.bytes - rec.passedTo < PASS_EVERY_S * RATE * BPS) return;
    rec.busy = this.pass(rec, false)
      .catch((err) => {
        rec.u.error = (err as Error).message; // transient: the next pass retries (and restarts the server)
        this.emit(rec);
      })
      .finally(() => {
        rec.busy = null;
        this.maybePass(rec);
      });
  }

  private async finish(rec: Rec): Promise<VoiceUpdate> {
    rec.u.state = 'finishing';
    this.emit(rec);
    if (rec.busy) await rec.busy.catch(() => {});
    try {
      this.save(rec); // audio first: the final pass may fail
      await this.pass(rec, true);
      writeFileSync(rec.u.transcriptFile!, `${rec.u.text}\n`);
      rec.u.state = 'done';
      rec.u.error = null;
    } catch (err) {
      rec.u.state = 'failed';
      rec.u.error = (err as Error).message;
    }
    rec.u.partial = '';
    rec.chunks = []; // on disk now
    this.emit(rec);
    rec.timer = setTimeout(() => this.recs.delete(rec.u.id), KEEP_DONE_MS);
    rec.timer.unref();
    return { ...rec.u };
  }

  // Recognise the uncommitted tail; commit what has settled.
  private async pass(rec: Rec, final: boolean): Promise<void> {
    const to = rec.bytes;
    const from = rec.committed;
    rec.passedTo = to;
    if (to - from < 0.3 * RATE * BPS) {
      if (final) rec.committed = to;
      return;
    }
    const window = slice(rec.chunks, from, to);
    const dur = window.length / BPS / RATE;
    const { rms, peak } = loudness(window);
    if (rms < SILENCE_RMS && peak < SILENCE_PEAK) {
      if (final || dur > 5) rec.committed = to;
      if (rec.u.partial) {
        rec.u.partial = '';
        this.emit(rec);
      }
      return;
    }
    const segRms = (sg: Segment) => {
      const a = Math.max(0, Math.floor(sg.start * RATE)) * BPS;
      const b = Math.min(window.length, Math.ceil(sg.end * RATE) * BPS);
      return b > a ? loudness(window.subarray(a, b)).rms : 0;
    };
    const segs = (await this.engine.transcribe(window, rec.u.text.slice(-200))).filter(
      (s) =>
        s.text &&
        !JUNK.test(s.text) &&
        s.prob >= MIN_WORD_PROB &&
        !(PHANTOM.test(s.text) && (segRms(s) < PHANTOM_RMS || s.prob < PHANTOM_PROB)),
    );
    const settled = (s: Segment, i: number) => final || s.end <= dur - SETTLE_S || (dur > LONG_TAIL_S && i < segs.length - 1);
    let n = 0;
    while (n < segs.length && settled(segs[n], n)) n++;
    // Commit only up to a pause; without one, hold the text as partial until the
    // next pass (or cut where whisper said once the tail is long).
    let cut = to;
    if (!final) {
      while (n > 0) {
        const c = quietCut(window, segs[n - 1].end, dur - SETTLE_S);
        if (c !== null) {
          cut = from + c;
          break;
        }
        if (dur > LONG_TAIL_S) {
          cut = from + Math.round(segs[n - 1].end * RATE) * BPS;
          break;
        }
        n--;
      }
    }
    const done: string[] = [];
    for (const s of segs.slice(0, n)) {
      if (s.text === rec.lastSeg) continue;
      rec.lastSeg = s.text;
      done.push(s.text);
    }
    if (final || n > 0) rec.committed = Math.min(to, cut);
    rec.u.text = joinText(rec.u.text, ...done);
    rec.u.partial = final ? '' : joinText(...segs.slice(n).map((s) => s.text));
    rec.u.error = null;
    this.emit(rec);
  }
}

// ---- saved recordings (the Recordings pane) ----

const NAME = /^[\w.-]+$/;
const pathOf = (id: string) => {
  if (!NAME.test(id)) throw new Error('bad recording id');
  return join(voiceDir, id);
};
function removeRecording(base: string): void {
  for (const ext of ['.wav', '.txt', '.json']) rmSync(`${base}${ext}`, { force: true });
}

// Every saved recording, newest first. Recordings made before project tags
// existed (no .json) come back with projectId null.
export function listRecordings(projectId?: string | null): VoiceRecording[] {
  let names: string[];
  try {
    names = readdirSync(voiceDir).filter((f) => f.endsWith('.wav'));
  } catch {
    return [];
  }
  const out: VoiceRecording[] = [];
  for (const f of names) {
    const id = f.slice(0, -4);
    const base = join(voiceDir, id);
    let meta: { projectId?: string | null; sessionId?: string | null; startedAt?: number } = {};
    try {
      meta = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    } catch {}
    let text = '';
    try {
      text = readFileSync(`${base}.txt`, 'utf8').trim();
    } catch {}
    const st = statSync(`${base}.wav`);
    out.push({
      id,
      file: `${base}.wav`,
      transcriptFile: existsSync(`${base}.txt`) ? `${base}.txt` : null,
      text,
      seconds: Math.max(0, st.size - 44) / BPS / RATE,
      createdAt: meta.startedAt ?? st.mtimeMs,
      projectId: meta.projectId ?? null,
      sessionId: meta.sessionId ?? null,
    });
  }
  return out
    .filter((r) => projectId === undefined || r.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export const readRecordingAudio = (id: string) => readFileSync(`${pathOf(id)}.wav`).toString('base64');
export function deleteRecording(id: string): void {
  removeRecording(pathOf(id));
}
export function saveRecordingText(id: string, text: string): void {
  if (!existsSync(`${pathOf(id)}.wav`)) throw new Error('unknown recording');
  writeFileSync(`${pathOf(id)}.txt`, `${text.trim()}\n`);
}
export function fileRecording(id: string, projectId: string | null): void {
  const p = `${pathOf(id)}.json`;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(p, 'utf8'));
  } catch {}
  writeFileSync(p, JSON.stringify({ ...meta, projectId }));
}
