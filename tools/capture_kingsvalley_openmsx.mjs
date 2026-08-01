import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { makeStage } from '../web/src/game/data.js';

const root = path.resolve(import.meta.dirname, '..');
const defaultExecutable = path.join(root, 'build', 'tooling', 'openmsx-21.0', 'openmsx.exe');
const executable = process.env.OPENMSX || defaultExecutable;
const romPath = path.resolve(process.argv[2] || path.join(root, 'rom', 'RC-727.rom'));
const outputDirectory = path.resolve(process.argv[3] || path.join(root, 'build', 'openmsx-reference'));
const selectedStages = parseStageSelection(process.env.STAGES || '1-15');
const captureSharedReferences = !process.env.STAGES;

await access(executable);
await access(romPath);
await mkdir(outputDirectory, { recursive: true });

if (captureSharedReferences) {
  await capture('title', [
    breakpointCapture(0x410d, 'capture_bp', path.join(outputDirectory, 'title.png')),
  ]);
}
for (const stageNumber of selectedStages) {
  const stage = makeStage(stageNumber);
  const entranceDirection = stage.exits.find(exit => exit.entrance)?.exitDirection || 8;
  if (!process.env.ROOMS_ONLY) {
    await capture(`stage${stageNumber}`, [
      ...startStageActions(stageNumber, entranceDirection),
      breakpointCapture(0x41d5, 'capture_bp', path.join(outputDirectory, `stage${stageNumber}.png`), 60),
    ]);
  }
  const entranceRoom = Math.floor(stage.start.x / 256);
  for (let room = 0; room < stage.width / 32; room++) {
    if (room === entranceRoom) continue;
    const name = `stage${stageNumber}-room${room}`;
    await capture(name, [
      ...startStageActions(stageNumber, entranceDirection),
      roomCapture(room, path.join(outputDirectory, `${name}.png`)),
    ]);
  }
}
if (captureSharedReferences) await captureStartPsg();

function parseStageSelection(selection) {
  const stages = new Set();
  for (const part of selection.split(',')) {
    const [firstText, lastText = firstText] = part.trim().split('-');
    const first = Number.parseInt(firstText, 10);
    const last = Number.parseInt(lastText, 10);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 15 || first > last) throw new Error(`invalid STAGES selection: ${selection}`);
    for (let stage = first; stage <= last; stage++) stages.add(stage);
  }
  return [...stages];
}

async function capture(name, actions) {
  const outputPath = path.join(outputDirectory, `${name}.png`);
  const scriptPath = path.join(outputDirectory, `${name}.tcl`);
  const script = [
    'set mute on',
    'proc save_debuggable {name size output} {set channel [open $output wb]; fconfigure $channel -translation binary; puts -nonewline $channel [debug read_block $name 0 $size]; close $channel}',
    'proc capture_now {output vram_output memory_output} {save_debuggable VRAM 16384 $vram_output; save_debuggable memory 65536 $memory_output; screenshot -raw -size 320 $output; after realtime 0.25 exit}',
    'proc capture_after_frames {remaining output vram_output memory_output} {if {$remaining > 0} {after frame [list capture_after_frames [expr {$remaining - 1}] $output $vram_output $memory_output]} else {save_debuggable VRAM 16384 $vram_output; save_debuggable memory 65536 $memory_output; screenshot -raw -size 320 $output; after realtime 0.25 exit}}',
    ...actions,
    '',
  ].join('\n');
  await writeFile(scriptPath, script);
  await runOpenMsx([
    '-machine', 'C-BIOS_MSX1',
    '-cart', romPath,
    '-script', scriptPath,
  ]);
  await access(outputPath);
  process.stdout.write(`${outputPath}\n`);
}

function startStageActions(stageNumber, entranceDirection) {
  return [
    'set ::menu_bp [debug set_bp 0x410d true {debug remove_bp $::menu_bp; keymatrixdown 8 1; after time 0.1 {keymatrixup 8 1}}]',
    `set ::stage_bp [debug set_bp 0x6aa3 true {debug remove_bp $::stage_bp; debug write memory 0xE055 ${stageNumber}; debug write memory 0xE056 ${entranceDirection}}]`,
  ];
}

function roomCapture(room, outputPath) {
  const output = outputPath.replaceAll('\\', '/');
  const vram = outputPath.replace(/\.png$/i, '.vram').replaceAll('\\', '/');
  const memory = outputPath.replace(/\.png$/i, '.memory').replaceAll('\\', '/');
  return `set ::room_frames 0; set ::room_bp [debug set_bp 0x41d5 true {incr ::room_frames; if {$::room_frames >= 60} {debug remove_bp $::room_bp; debug write memory 0xE13A ${room}; set ::room_done_bp [debug set_bp 0x6ce7 true {debug remove_bp $::room_done_bp; capture_now {${output}} {${vram}} {${memory}}}]; reg PC 0x6ccb}}]`;
}

function breakpointCapture(address, variable, outputPath, frameDelay = 1) {
  const tclOutputPath = outputPath.replaceAll('\\', '/');
  const tclVramPath = outputPath.replace(/\.png$/i, '.vram').replaceAll('\\', '/');
  const tclMemoryPath = outputPath.replace(/\.png$/i, '.memory').replaceAll('\\', '/');
  return `set ::${variable} [debug set_bp 0x${address.toString(16)} true {debug remove_bp $::${variable}; capture_after_frames ${frameDelay} {${tclOutputPath}} {${tclVramPath}} {${tclMemoryPath}}}]`;
}

async function captureStartPsg() {
  const outputPath = path.join(outputDirectory, 'start.psg');
  const wavPath = path.join(outputDirectory, 'start-openmsx.wav');
  const scriptPath = path.join(outputDirectory, 'start-psg.tcl');
  const tclOutputPath = outputPath.replaceAll('\\', '/');
  const tclWavPath = wavPath.replaceAll('\\', '/');
  await rm(wavPath, { force: true });
  const script = [
    'set mute on',
    'proc capture_psg_frame {remaining channel} {puts -nonewline $channel [debug read_block {PSG regs} 0 16]; incr remaining -1; if {$remaining > 0} {after frame [list capture_psg_frame $remaining $channel]} else {soundlog stop; close $channel; after realtime 0.25 exit}}',
    'set ::menu_bp [debug set_bp 0x410d true {debug remove_bp $::menu_bp; keymatrixdown 8 1; after time 0.1 {keymatrixup 8 1}}]',
    `set ::music_bp [debug set_bp 0x7aa9 true {if {[reg A] == 0x97} {debug remove_bp $::music_bp; soundlog start {${tclWavPath}}; set channel [open {${tclOutputPath}} wb]; fconfigure $channel -translation binary; after frame [list capture_psg_frame 260 $channel]}}]`,
    '',
  ].join('\n');
  await writeFile(scriptPath, script);
  await runOpenMsx(['-machine', 'C-BIOS_MSX1', '-cart', romPath, '-script', scriptPath]);
  await access(outputPath);
  await access(wavPath);
  process.stdout.write(`${outputPath}\n`);
  process.stdout.write(`${wavPath}\n`);
}

function runOpenMsx(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('openMSX capture timed out'));
    }, 30000);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`openMSX exited with ${code}: ${stderr.trim()}`));
    });
  });
}
