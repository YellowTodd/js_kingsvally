export const PSG_CLOCK = 1789772.5;
export const CHANNEL_GAIN = 0.143;
export const AY_DAC = [
  0, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369,
  0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1,
];

export class AyPcmRenderer {
  constructor(sampleRate = 44100, frameRate = 59.92) {
    this.sampleRate = sampleRate;
    this.frameRate = frameRate;
    this.totalSamples = 0;
    this.frameBoundary = 0;
    this.tonePhases = [0, 0, 0];
    this.noisePhase = 0;
    this.noiseLfsr = 1;
  }

  renderFrame(registers) {
    this.frameBoundary += this.sampleRate / this.frameRate;
    const sampleCount = Math.floor(this.frameBoundary) - this.totalSamples;
    const output = new Int16Array(sampleCount);
    const noiseDivider = (registers[6] & 0x1f) || 1;
    const noiseStep = PSG_CLOCK / (16 * noiseDivider) / this.sampleRate;
    for (let sample = 0; sample < sampleCount; sample++) {
      this.noisePhase += noiseStep;
      while (this.noisePhase >= 1) {
        this.noisePhase--;
        this.noiseLfsr = (this.noiseLfsr >>> 1) | (((this.noiseLfsr ^ (this.noiseLfsr >>> 3)) & 1) << 16);
      }
      const noiseBit = this.noiseLfsr & 1;
      let mixed = 0;
      for (let channel = 0; channel < 3; channel++) {
        const period = registers[channel * 2] | ((registers[channel * 2 + 1] & 0x0f) << 8);
        const toneOn = (registers[7] & (1 << channel)) === 0 && period > 0;
        const noiseOn = (registers[7] & (8 << channel)) === 0;
        if (!toneOn && !noiseOn) continue;
        let tone = 1;
        if (toneOn) {
          this.tonePhases[channel] += PSG_CLOCK / (16 * period) / this.sampleRate;
          this.tonePhases[channel] %= 1;
          tone = this.tonePhases[channel] < 0.5 ? 1 : -1;
        }
        let signal = tone;
        if (noiseOn && toneOn) signal = tone * noiseBit + noiseBit - 1;
        else if (noiseOn) signal = noiseBit * 2 - 1;
        const volume = registers[8 + channel] & 0x0f;
        mixed += signal * AY_DAC[volume] * CHANNEL_GAIN;
      }
      output[sample] = Math.max(-32768, Math.min(32767, Math.round(mixed * 0.5 * 32767)));
    }
    this.totalSamples += sampleCount;
    return output;
  }
}

export function encodeMonoWav(samples, sampleRate = 44100) {
  const output = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, 'RIFF');
  view.setUint32(4, output.length - 8, true);
  writeAscii(output, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(output, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, samples[index], true);
  return output;
}

function writeAscii(output, offset, value) {
  for (let index = 0; index < value.length; index++) output[offset + index] = value.charCodeAt(index);
}
