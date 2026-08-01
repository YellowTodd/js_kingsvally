import { access, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const executable = process.env.OPENMSX || path.join(root, 'build', 'tooling', 'openmsx-21.0', 'openmsx.exe');
const romPath = path.resolve(process.argv[2] || path.join(root, 'rom', 'RC-727.rom'));
const outputDirectory = path.resolve(process.argv[3] || path.join(root, 'build', 'openmsx-reference', 'psg-events'));
const ids = (process.env.PSG_IDS || '0x01,0x03,0x04,0x45,0x06,0x07,0x08,0x09,0x0a,0x8b,0x8d,0x8f,0x91,0x94,0x97,0x9a')
  .split(',')
  .map(value => Number.parseInt(value.trim(), 0));

await access(executable);
await access(romPath);
await mkdir(outputDirectory, { recursive: true });
for (const id of ids) await capture(id);

async function capture(id) {
  if (!Number.isInteger(id) || id < 0 || id > 0xff) throw new Error(`invalid PSG id: ${id}`);
  const name = `event-${id.toString(16).padStart(2, '0')}`;
  const outputPath = path.join(outputDirectory, `${name}.psg`);
  const scriptPath = path.join(outputDirectory, `${name}.tcl`);
  const tclOutputPath = outputPath.replaceAll('\\', '/');
  const script = [
    'set mute on',
    'proc capture_psg_frame {remaining channel} {puts -nonewline $channel [debug read_block {PSG regs} 0 16]; debug write memory 0xe000 1; debug write memory 0xe004 255; incr remaining -1; if {$remaining > 0} {after frame [list capture_psg_frame $remaining $channel]} else {close $channel; after realtime 0.25 exit}}',
    'set ::menu_bp [debug set_bp 0x410d true {debug remove_bp $::menu_bp; keymatrixdown 8 1; after time 0.1 {keymatrixup 8 1}}]',
    `set ::music_bp [debug set_bp 0x7aa9 true {if {[reg A] == 0x97} {debug remove_bp $::music_bp; reg A ${id}; set channel [open {${tclOutputPath}} wb]; fconfigure $channel -translation binary; after frame [list capture_psg_frame 260 $channel]}}]`,
    '',
  ].join('\n');
  await writeFile(scriptPath, script);
  await runOpenMsx(['-machine', 'C-BIOS_MSX1', '-cart', romPath, '-script', scriptPath]);
  await access(outputPath);
  process.stdout.write(`${outputPath}\n`);
}

function runOpenMsx(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('openMSX PSG capture timed out'));
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
