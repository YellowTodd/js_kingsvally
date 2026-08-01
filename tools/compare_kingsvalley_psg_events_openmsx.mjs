import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { ROM_BYTES } from '../web/src/game/rom.js';
import { KingsValleyPsg } from '../web/src/psg.js';

const root = path.resolve(import.meta.dirname, '..');
const referenceDirectory = path.resolve(process.argv[2] || path.join(root, 'build', 'openmsx-reference', 'psg-events'));
const outputPath = path.resolve(process.argv[3] || path.join(root, 'build', 'openmsx-reference', 'psg-events-comparison.json'));
const frames = Math.max(1, Number(process.env.PSG_FRAMES) || 260);
const references = (process.env.PSG_IDS || '0x01,0x03,0x04,0x45,0x06,0x07,0x08,0x09,0x0a,0x8b,0x8d,0x8f,0x91,0x94,0x97,0x9a')
  .split(',')
  .map(value => Number.parseInt(value.trim(), 0));
const reports = [];

for (const id of references) {
  const inputPath = path.join(referenceDirectory, `event-${id.toString(16).padStart(2, '0')}.psg`);
  const reference = await readFile(inputPath);
  if (reference.length !== 260 * 16) throw new Error(`unexpected PSG capture size for 0x${id.toString(16)}: ${reference.length}`);
  const psg = new KingsValleyPsg(ROM_BYTES);
  psg.setMusic(id);
  let mismatchCount = 0;
  const mismatches = [];
  for (let frame = 0; frame < frames; frame++) {
    for (let register = 0; register < 14; register++) {
      const browser = psg.regs[register];
      const original = reference[frame * 16 + register];
      if (browser === original) continue;
      mismatchCount++;
      if (mismatches.length < 8) mismatches.push({ frame, register, original, browser });
    }
    psg.tick();
  }
  reports.push({ id, frames, mismatchCount, mismatches, referenceSha256: sha256(referenceRegisters(reference, frames)), browserSha256: sha256(registerBytes(id, frames)) });
}

if (reports.some(report => report.mismatchCount !== 0)) throw new Error(`openMSX event mismatch: ${JSON.stringify(reports)}`);
await writeFile(outputPath, `${JSON.stringify({ events: reports }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ events: reports }, null, 2)}\n`);

function registerBytes(id, frameCount) {
  const psg = new KingsValleyPsg(ROM_BYTES);
  const bytes = Buffer.alloc(frameCount * 14);
  psg.setMusic(id);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let register = 0; register < 14; register++) bytes[frame * 14 + register] = psg.regs[register];
    psg.tick();
  }
  return bytes;
}

function referenceRegisters(reference, frameCount) {
  const bytes = Buffer.alloc(frameCount * 14);
  for (let frame = 0; frame < frameCount; frame++) reference.copy(bytes, frame * 14, frame * 16, frame * 16 + 14);
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
