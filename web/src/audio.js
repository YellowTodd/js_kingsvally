import { AY_DAC, CHANNEL_GAIN, PSG_CLOCK } from './ay.js';

const NOISE_PERIOD = 131071;

export class PsgAudio {
  constructor() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('WebAudio is not available');
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = 0.5;
    const dcBlock = this.context.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 12;
    dcBlock.Q.value = 0.707;
    this.master.connect(dcBlock).connect(this.context.destination);

    const buffer = this.context.createBuffer(1, NOISE_PERIOD, this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    let lfsr = 1;
    for (let index = 0; index < samples.length; index++) {
      samples[index] = lfsr & 1;
      lfsr = (lfsr >>> 1) | (((lfsr ^ (lfsr >>> 3)) & 1) << 16);
    }
    this.noise = this.context.createBufferSource();
    this.noise.buffer = buffer;
    this.noise.loop = true;
    this.noise.start();
    this.noiseRate = 0;

    const dc = this.context.createConstantSource();
    dc.offset.value = 1;
    dc.start();
    this.channels = [];
    for (let channel = 0; channel < 3; channel++) {
      const amplitude = this.context.createGain();
      amplitude.gain.value = 0;
      amplitude.connect(this.master);
      const oscillator = this.context.createOscillator();
      oscillator.type = 'square';
      oscillator.start();
      const tone = this.context.createGain();
      tone.gain.value = 0;
      oscillator.connect(tone).connect(amplitude);
      const product = this.context.createGain();
      product.gain.value = 0;
      oscillator.connect(product);
      this.noise.connect(product.gain);
      const gated = this.context.createGain();
      gated.gain.value = 0;
      product.connect(gated).connect(amplitude);
      const noiseLevel = this.context.createGain();
      noiseLevel.gain.value = 0;
      this.noise.connect(noiseLevel).connect(amplitude);
      const offset = this.context.createGain();
      offset.gain.value = 0;
      dc.connect(offset).connect(amplitude);
      this.channels.push({ oscillator, amplitude, tone, gated, noiseLevel, offset, frequency: 0, mode: -1 });
    }
  }

  setMuted(muted) {
    this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.context.currentTime, 0.01);
  }

  update(registers) {
    const now = this.context.currentTime;
    const divider = (registers[6] & 0x1f) || 1;
    const rate = Math.min(4, Math.max(0.02, PSG_CLOCK / (16 * divider) / this.context.sampleRate));
    if (rate !== this.noiseRate) {
      this.noise.playbackRate.setValueAtTime(rate, now);
      this.noiseRate = rate;
    }
    for (let channel = 0; channel < 3; channel++) {
      const output = this.channels[channel];
      const period = registers[channel * 2] | ((registers[channel * 2 + 1] & 0x0f) << 8);
      const volume = registers[8 + channel] & 0x0f;
      const toneOn = (registers[7] & (1 << channel)) === 0 && period > 0;
      const noiseOn = (registers[7] & (8 << channel)) === 0;
      if (toneOn) {
        const frequency = Math.min(12000, Math.max(20, PSG_CLOCK / (16 * period)));
        if (frequency !== output.frequency) {
          output.oscillator.frequency.setValueAtTime(frequency, now);
          output.frequency = frequency;
        }
      }
      const mode = (toneOn ? 1 : 0) | (noiseOn ? 2 : 0);
      if (mode !== output.mode) {
        output.mode = mode;
        output.tone.gain.setValueAtTime(mode === 1 ? 1 : 0, now);
        output.gated.gain.setValueAtTime(mode === 3 ? 1 : 0, now);
        output.noiseLevel.gain.setValueAtTime(mode === 2 ? 2 : mode === 3 ? 1 : 0, now);
        output.offset.gain.setValueAtTime(mode & 2 ? -1 : 0, now);
      }
      output.amplitude.gain.setValueAtTime(mode ? AY_DAC[volume] * CHANNEL_GAIN : 0, now);
    }
  }
}
