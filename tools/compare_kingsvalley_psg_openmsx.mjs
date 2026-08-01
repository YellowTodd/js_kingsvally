import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { AyPcmRenderer } from '../web/src/ay.js';
import { ROM_BYTES } from '../web/src/game/rom.js';
import { KingsValleyPsg } from '../web/src/psg.js';

const root = path.resolve(import.meta.dirname, '..');
const inputPath = path.resolve(process.argv[2] || path.join(root, 'build', 'openmsx-reference', 'start.psg'));
const outputPath = path.resolve(process.argv[3] || path.join(root, 'build', 'openmsx-reference', 'psg-comparison.json'));
const wavPath = path.join(path.dirname(inputPath), 'start-openmsx.wav');
const reference = await readFile(inputPath);
if (reference.length !== 260 * 16) throw new Error(`unexpected openMSX PSG capture size: ${reference.length}`);

const psg = new KingsValleyPsg(ROM_BYTES);
psg.setMusic(0x97);
const browserFrames = [[...psg.regs]];
for (let frame = 1; frame < 260; frame++) {
  psg.tick();
  browserFrames.push([...psg.regs]);
}

const referenceAudioRegisters = Buffer.alloc(260 * 14);
const browserAudioRegisters = Buffer.alloc(260 * 14);
let mismatchCount = 0;
const mismatches = [];
for (let frame = 0; frame < 260; frame++) {
  for (let register = 0; register < 14; register++) {
    const referenceValue = reference[frame * 16 + register];
    const browserValue = browserFrames[frame][register];
    referenceAudioRegisters[frame * 14 + register] = referenceValue;
    browserAudioRegisters[frame * 14 + register] = browserValue;
    if (referenceValue === browserValue) continue;
    mismatchCount++;
    if (mismatches.length < 32) mismatches.push({ frame, register, reference: referenceValue, browser: browserValue });
  }
}

const report = {
  musicId: 0x97,
  frames: 260,
  registersPerFrame: 14,
  referenceSha256: sha256(referenceAudioRegisters),
  browserSha256: sha256(browserAudioRegisters),
  mismatchCount,
  mismatches,
  waveform: compareWaveforms(await readFile(wavPath)),
};
if (mismatchCount !== 0 || report.referenceSha256 !== report.browserSha256) throw new Error(`openMSX PSG mismatch: ${JSON.stringify(report)}`);
if (report.waveform.envelopeCorrelation < 0.9 || Math.abs(report.waveform.meanRmsRatio - 1) > 0.02) throw new Error(`openMSX waveform mismatch: ${JSON.stringify(report.waveform)}`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareWaveforms(referenceWav) {
  const reference = decodeMonoWav(referenceWav);
  const audioPsg = new KingsValleyPsg(ROM_BYTES);
  const renderer = new AyPcmRenderer(reference.sampleRate);
  const chunks = [];
  audioPsg.setMusic(0x97);
  for (let frame = 0; frame < 260; frame++) {
    audioPsg.tick();
    chunks.push(renderer.renderFrame(audioPsg.regs));
  }
  const browser = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let outputOffset = 0;
  for (const chunk of chunks) {
    browser.set(chunk, outputOffset);
    outputOffset += chunk.length;
  }
  const samplesPerFrame = reference.sampleRate / renderer.frameRate;
  const expectedLag = -Math.round(samplesPerFrame);
  const lag = findBestLag(reference.samples, browser, expectedLag - 16, expectedLag + 16);
  const referenceEnvelope = rmsEnvelope(reference.samples, samplesPerFrame, 258, 0);
  const browserEnvelope = rmsEnvelope(browser, samplesPerFrame, 258, lag);
  const referenceMean = mean(referenceEnvelope);
  const browserMean = mean(browserEnvelope);
  return {
    sampleRate: reference.sampleRate,
    referenceSamples: reference.samples.length,
    browserSamples: browser.length,
    bestLagSamples: lag,
    envelopeCorrelation: Number(correlation(referenceEnvelope, browserEnvelope).toFixed(6)),
    meanRmsRatio: Number((browserMean / referenceMean).toFixed(6)),
    referenceWavSha256: sha256(referenceWav),
  };
}

function decodeMonoWav(buffer) {
  const formatOffset = buffer.indexOf(Buffer.from('fmt '));
  const dataOffset = buffer.indexOf(Buffer.from('data'));
  if (formatOffset < 0 || dataOffset < 0) throw new Error('invalid WAV');
  const channels = buffer.readUInt16LE(formatOffset + 10);
  const sampleRate = buffer.readUInt32LE(formatOffset + 12);
  const bits = buffer.readUInt16LE(formatOffset + 22);
  if (channels !== 1 || bits !== 16) throw new Error(`unsupported WAV format: ${channels} channels, ${bits} bits`);
  const byteLength = buffer.readUInt32LE(dataOffset + 4);
  const samples = new Int16Array(byteLength / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = buffer.readInt16LE(dataOffset + 8 + index * 2);
  return { sampleRate, samples };
}

function findBestLag(reference, browser, minimum, maximum) {
  let bestLag = minimum;
  let bestCorrelation = -Infinity;
  for (let lag = minimum; lag <= maximum; lag++) {
    let sumXY = 0;
    let sumXX = 0;
    let sumYY = 0;
    for (let index = 2000; index < Math.min(reference.length - 2000, 100000); index += 8) {
      const browserIndex = index + lag;
      if (browserIndex < 0 || browserIndex >= browser.length) continue;
      const x = reference[index];
      const y = browser[browserIndex];
      sumXY += x * y;
      sumXX += x * x;
      sumYY += y * y;
    }
    const value = sumXY / Math.sqrt(sumXX * sumYY);
    if (value > bestCorrelation) {
      bestCorrelation = value;
      bestLag = lag;
    }
  }
  return bestLag;
}

function rmsEnvelope(samples, samplesPerFrame, frames, shift) {
  const envelope = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const start = Math.max(0, Math.floor(frame * samplesPerFrame) + shift);
    const end = Math.min(samples.length, Math.floor((frame + 1) * samplesPerFrame) + shift);
    let squares = 0;
    for (let index = start; index < end; index++) squares += samples[index] * samples[index];
    envelope[frame] = Math.sqrt(squares / Math.max(1, end - start));
  }
  return envelope;
}

function mean(values) {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function correlation(left, right) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let cross = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] - leftMean;
    const rightValue = right[index] - rightMean;
    cross += leftValue * rightValue;
    leftSquares += leftValue * leftValue;
    rightSquares += rightValue * rightValue;
  }
  return cross / Math.sqrt(leftSquares * rightSquares);
}
