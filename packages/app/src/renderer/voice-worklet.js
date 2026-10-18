// AudioWorklet: the microphone's mono input → 16 kHz Int16 PCM, posted to the
// page in 250 ms pieces with a level reading. Resamples (linear) when the
// context could not be opened at 16 kHz.
const OUT_RATE = 16000;
const PIECE = 4000; // samples per message (250 ms)

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.pos = 0; // next read position within the current block, carried across blocks
    this.out = new Int16Array(PIECE);
    this.n = 0;
    this.sq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.put(ch[i]);
    } else {
      let p = this.pos;
      while (p < ch.length) {
        const i = Math.floor(p);
        const f = p - i;
        const a = ch[i];
        const b = i + 1 < ch.length ? ch[i + 1] : a;
        this.put(a + (b - a) * f);
        p += this.ratio;
      }
      this.pos = p - ch.length;
    }
    return true;
  }

  put(v) {
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    this.out[this.n++] = c < 0 ? c * 32768 : c * 32767;
    this.sq += c * c;
    if (this.n === PIECE) {
      const level = Math.sqrt(this.sq / PIECE);
      const pcm = this.out.buffer.slice(0);
      this.port.postMessage({ pcm, level }, [pcm]);
      this.n = 0;
      this.sq = 0;
    }
  }
}

registerProcessor('pcm-capture', PcmCapture);
