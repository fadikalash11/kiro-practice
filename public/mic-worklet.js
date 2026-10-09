// AudioWorklet: downsample mic input to 16 kHz, convert to 16-bit PCM, and
// post ~100 ms chunks back to the main thread as binary (Bonus A).

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._inRate = sampleRate; // the context's actual rate (44.1k / 48k)
    this._outRate = 16000;
    this._ratio = this._inRate / this._outRate;
    // 100 ms of 16 kHz samples = 1600 samples per chunk.
    this._chunkSamples = 1600;
    this._buffer = [];
    this._acc = 0; // fractional read position for naive downsampling
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Downsample by averaging / picking samples at the target ratio.
    for (let i = 0; i < channel.length; i++) {
      this._acc += 1;
      if (this._acc >= this._ratio) {
        this._acc -= this._ratio;
        let s = channel[i];
        // clamp and convert to 16-bit PCM
        s = Math.max(-1, Math.min(1, s));
        this._buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
    }

    while (this._buffer.length >= this._chunkSamples) {
      const slice = this._buffer.splice(0, this._chunkSamples);
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) pcm[i] = slice[i] | 0;
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
