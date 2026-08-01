#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AyPcmRenderer, encodeMonoWav } from '../web/src/ay.js';
import { ROM_BYTES } from '../web/src/game/rom.js';
import { KingsValleyPsg } from '../web/src/psg.js';

const id = Number.parseInt(process.argv[2] || '0x97', 0);
const frames = Math.max(1, Number.parseInt(process.argv[3] || '260', 10));
const outputPath = resolve(process.argv[4] || `build/kingsvalley-${id.toString(16)}.wav`);
const psg = new KingsValleyPsg(ROM_BYTES);
const renderer = new AyPcmRenderer();
const chunks = [];
let sampleCount = 0;
psg.setMusic(id);
for (let frame = 0; frame < frames; frame++) {
  psg.tick();
  const chunk = renderer.renderFrame(psg.regs);
  chunks.push(chunk);
  sampleCount += chunk.length;
}
const samples = new Int16Array(sampleCount);
let offset = 0;
for (const chunk of chunks) {
  samples.set(chunk, offset);
  offset += chunk.length;
}
await writeFile(outputPath, encodeMonoWav(samples, renderer.sampleRate));
console.log(`${outputPath}: ${frames} frames, ${samples.length} samples, music 0x${id.toString(16)}`);
