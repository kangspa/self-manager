import { api } from "./api";

// AudioWorklet that forwards mono Float32 frames to the main thread.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("sm-tap", Tap);
`;

/**
 * Records the microphone as 16 kHz mono PCM and streams it to Rust once per
 * second, so a long meeting never sits in webview memory and a crash loses at
 * most a second of audio.
 */
export class MeetingRecorder {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private buf: Float32Array[] = [];
  private bufLen = 0;
  private wake?: { release: () => Promise<void> };
  private sending = Promise.resolve();
  seconds = 0;
  level = 0;
  paused = false;

  constructor(private meetingId: number, private onTick: () => void) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // Asking for 16 kHz makes the browser resample for us (what whisper expects).
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "sm-tap");
    this.node.port.onmessage = (e) => this.push(e.data as Float32Array);
    src.connect(this.node);
    await api.recStart(this.meetingId);
    try {
      // Keeps the phone screen on; Android may suspend the webview otherwise.
      this.wake = await (navigator as any).wakeLock?.request("screen");
    } catch {
      /* wake lock not available */
    }
  }

  private push(frame: Float32Array) {
    if (this.paused || !this.ctx) return;
    this.buf.push(frame);
    this.bufLen += frame.length;
    let peak = 0;
    for (let i = 0; i < frame.length; i += 8) peak = Math.max(peak, Math.abs(frame[i]));
    this.level = this.level * 0.8 + peak * 0.2;
    if (this.bufLen >= this.ctx.sampleRate) this.flush();
  }

  private flush() {
    if (!this.bufLen) return;
    const pcm = new Int16Array(this.bufLen);
    let o = 0;
    for (const f of this.buf) {
      for (let i = 0; i < f.length; i++) pcm[o++] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    }
    this.seconds += this.bufLen / (this.ctx?.sampleRate ?? 16000);
    this.buf = [];
    this.bufLen = 0;
    const bytes = new Uint8Array(pcm.buffer);
    // Keep chunks in order.
    this.sending = this.sending.then(() => api.recAppend(this.meetingId, bytes).then(() => undefined)).catch((e) => console.error(e));
    this.onTick();
  }

  pause(p: boolean) {
    this.paused = p;
    if (p) this.flush();
    this.onTick();
  }

  async stop() {
    this.flush();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    await this.sending;
    try {
      await this.wake?.release();
    } catch {
      /* already released */
    }
    return api.recStop(this.meetingId);
  }
}
