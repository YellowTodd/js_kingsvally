import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const executable = process.env.OPENMSX || path.join(root, 'build', 'tooling', 'openmsx-21.0', 'openmsx.exe');
const romPath = path.resolve(process.argv[2] || path.join(root, 'rom', 'RC-727.rom'));
const outputDirectory = path.resolve(process.argv[3] || path.join(root, 'build', 'openmsx-reference'));
const defaultFrames = [0, 8, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 161, 162, 163, 176, 192, 208, 216, 232, 248, 264, 280, 296, 304, 312, 320, 321, 328, 456, 457, 464, 832];
const frames = parseFrames(process.env.DEMO_FRAMES) || defaultFrames;

await access(executable);
await access(romPath);
await mkdir(outputDirectory, { recursive: true });

const scriptPath = path.join(outputDirectory, 'demo-capture.tcl');
const tclOutputDirectory = outputDirectory.replaceAll('\\', '/');
const script = [
  'set mute on',
  'proc save_debuggable {name size output} {set channel [open $output wb]; fconfigure $channel -translation binary; puts -nonewline $channel [debug read_block $name 0 $size]; close $channel}',
  'proc capture_demo {frame output_directory final_frame} {set stem [format "demo-frame%04d" $frame]; save_debuggable VRAM 16384 [file join $output_directory "$stem.vram"]; save_debuggable memory 65536 [file join $output_directory "$stem.memory"]; screenshot -raw -size 320 [file join $output_directory "$stem.png"]; if {$frame == $final_frame} {after realtime 0.25 exit}}',
  `set ::demo_frames {${frames.join(' ')}}`,
  `set ::demo_final ${frames.at(-1)}`,
  'set ::demo_frame 0',
  'set ::menu_bp [debug set_bp 0x410d true {debug remove_bp $::menu_bp; debug write memory 0xE002 1}]',
  `set ::demo_bp [debug set_bp 0x41d5 true {if {[lsearch -exact $::demo_frames $::demo_frame] >= 0} {capture_demo $::demo_frame {${tclOutputDirectory}} $::demo_final}; incr ::demo_frame}]`,
  '',
].join('\n');
await writeFile(scriptPath, script);
await runOpenMsx(['-machine', 'C-BIOS_MSX1', '-cart', romPath, '-script', scriptPath]);

for (const frame of frames) {
  const stem = path.join(outputDirectory, `demo-frame${String(frame).padStart(4, '0')}`);
  await access(`${stem}.png`);
  await access(`${stem}.vram`);
  await access(`${stem}.memory`);
  process.stdout.write(`${stem}.png\n`);
}

function runOpenMsx(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('openMSX demo capture timed out'));
    }, 120000);
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

function parseFrames(value) {
  if (!value) return null;
  const parsed = [...new Set(value.split(',').flatMap(part => {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`Invalid DEMO_FRAMES entry: ${part}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (end < start) throw new Error(`Invalid DEMO_FRAMES range: ${part}`);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }))].sort((left, right) => left - right);
  if (!parsed.length) throw new Error('DEMO_FRAMES must contain at least one frame');
  return parsed;
}
