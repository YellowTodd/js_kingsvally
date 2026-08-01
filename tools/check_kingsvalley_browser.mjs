#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const files = {
  main: await readFile(new URL('../web/src/main.js', import.meta.url), 'utf8'),
  input: await readFile(new URL('../web/src/input.js', import.meta.url), 'utf8'),
  sound: await readFile(new URL('../web/src/sound.js', import.meta.url), 'utf8'),
  audio: await readFile(new URL('../web/src/audio.js', import.meta.url), 'utf8'),
  html: await readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
};

const checks = [
  ['MSX raster dimensions', /SCREEN_W \+ 16/.test(files.main) && /SCREEN_H/.test(files.main) && /width="256" height="192"/.test(files.html)],
  ['59.92 Hz game clock', /1000 \/ 59\.92/.test(files.main)],
  ['responsive resize handling', /addEventListener\('resize', \(\) => fitCanvas/.test(files.main)],
  ['screen presentation after audio tick', /sound\.tick\(\)/.test(files.main) && /screen\.present\(\)/.test(files.main)],
  ['Space-only action binding', /\['Space', ACTION\]/.test(files.input) && !/\['KeyZ', ACTION\]/.test(files.input)],
  ['blur and visibility input reset', /addEventListener\('blur'/.test(files.input) && /visibilitychange/.test(files.input)],
  ['AudioContext creation and resume', /new AudioContextClass/.test(files.audio) && /context\.resume\(\)/.test(files.sound)],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) throw new Error(`browser checks failed: ${failures.join(', ')}`);
console.log(JSON.stringify({ checks: checks.length, passed: checks.length - failures.length, failures }));
