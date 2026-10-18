import type { VoiceUpdate } from '@workbench/shared';
import { hub } from './hub.ts';

const RATE = 16_000;

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

// Microphone → 16 kHz PCM → hub (voice.push), for one recording at a time.
// Recognition happens in the hub; its voice.update pushes carry the text.
export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  id: string | null = null;
  onLevel: (level: number) => void = () => {};

  async start(projectId: string | null = null, sessionId: string | null = null): Promise<VoiceUpdate> {
    if (this.id) throw new Error('already recording');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: RATE });
    } catch {
      ctx = new AudioContext(); // the worklet resamples
    }
    try {
      await ctx.resume();
      await ctx.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url).href);
      const u = await hub.call('voice.start', { projectId, sessionId });
      const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
        this.onLevel(e.data.level);
        if (this.id) hub.notify('voice.push', { id: this.id, pcm: b64(e.data.pcm) });
      };
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(ctx.destination); // the worklet outputs silence; being connected keeps it running
      this.ctx = ctx;
      this.stream = stream;
      this.node = node;
      this.id = u.id;
      return u;
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw err;
    }
  }

  // Ends capture and has the hub finish recognition and save the files.
  stop(): Promise<VoiceUpdate> {
    const id = this.id;
    this.teardown();
    if (!id) return Promise.reject(new Error('not recording'));
    return hub.call('voice.stop', { id });
  }

  // Ends capture and drops the recording.
  cancel(): void {
    const id = this.id;
    this.teardown();
    if (id) void hub.call('voice.discard', { id }).catch(() => {});
  }

  private teardown(): void {
    this.id = null;
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}

// What to tell the user when the microphone could not be opened.
export function micError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'NotAllowedError') {
    return 'Microphone access was refused — allow it under System Settings › Privacy & Security › Microphone (Electron while in dev), then try again.';
  }
  if (e?.name === 'NotFoundError') return 'No microphone was found.';
  return e?.message ?? String(err);
}
