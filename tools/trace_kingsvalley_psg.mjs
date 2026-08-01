#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { KVALLEY_ASSETS } from '../web/src/game/romdata.js';
import { ROM_BYTES } from '../web/src/game/rom.js';
import { KingsValleyPsg } from '../web/src/psg.js';

const musicId = Number(process.argv[2] || '0x97');
const frameCount = Math.max(1, Number(process.argv[3]) || 260);
const outputPath = process.argv[4] || 'build/psg-trace.json';
const psg = new KingsValleyPsg(ROM_BYTES);
psg.beginTrace();
psg.setMusic(musicId);
for (let frame = 0; frame < frameCount; frame++) psg.tick();
const output = {
  romSha256: KVALLEY_ASSETS.romSha256,
  musicId: musicId & 0xff,
  frameCount,
  frames: psg.endTrace(),
  final: psg.snapshot(),
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`${outputPath}: ${frameCount} frames, music 0x${(musicId & 0xff).toString(16).padStart(2, '0')}`);
