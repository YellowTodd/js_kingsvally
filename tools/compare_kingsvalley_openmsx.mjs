import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { inflateSync } from 'node:zlib';

import { DemoReplay, Game } from '../web/src/game/flow.js';
import { GameState } from '../web/src/game/state.js';
import { makeStage } from '../web/src/game/data.js';
import { PALETTE, Screen } from '../web/src/screen.js';

const root = path.resolve(import.meta.dirname, '..');
const referenceDirectory = path.resolve(process.argv[2] || path.join(root, 'build', 'openmsx-reference'));
const outputPath = path.resolve(process.argv[3] || path.join(referenceDirectory, 'comparison.json'));
const selectedStages = parseStageSelection(process.env.STAGES || '1-15');
const defaultDemoFrames = [0, 8, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 161, 162, 163, 176, 192, 208, 216, 232, 248, 264, 280, 296, 304, 312, 320, 321, 328, 456, 457, 464, 832, 960, 1088, 1216, 1344, 1472, 1600, 1728, 1856, 1984];
const selectedDemoFrames = parseFrameSelection(process.env.DEMO_FRAMES) || defaultDemoFrames;
const demoUpdateOffset = Number.parseInt(process.env.DEMO_UPDATE_OFFSET || '1', 10);
const input = {
  controls() { return 0; },
  pressed() { return false; },
  anyPressed() { return false; },
  actionPressed() { return false; },
  endFrame() {},
};
const sound = { setMusic() {}, playMusic() {}, playEvent() {}, stopAll() {}, setMuted() {}, isPlaying() { return false; } };

const report = {};
if (!process.env.STAGES) {
  report.title = await compareFrame('title', ({ game, state }) => {
    state.mode = 'menu';
    game.menuProgress = 22;
  });
}
for (const stageNumber of selectedStages) {
  report[`stage${stageNumber}`] = await compareFrame(`stage${stageNumber}`, ({ game, state }) => {
    state.stage = stageNumber;
    game.startLevel();
    state.level.skipEntry({ activateEnemies: false });
    for (let frame = 0; frame < 60; frame++) {
      state.frame++;
      state.level.update(input, state);
    }
  }, ({ state, referenceMemory }) => {
    state.frame = (referenceMemory[0xe003] - 1) & 0xff;
  });
  const stage = makeStage(stageNumber);
  const entranceRoom = Math.floor(stage.start.x / 256);
  for (let room = 0; room < stage.width / 32; room++) {
    if (room === entranceRoom) continue;
    report[`stage${stageNumber}-room${room}`] = await compareFrame(`stage${stageNumber}-room${room}`, ({ game, state }) => {
      state.stage = stageNumber;
      game.startLevel();
      state.level.skipEntry({ activateEnemies: false });
      for (let frame = 0; frame < 60; frame++) {
        state.frame++;
        state.level.update(input, state);
      }
      state.level.player.x = room * 256 + (state.level.player.x & 0xff);
      state.level.cameraX = room * 256;
      state.level.cameraTarget = state.level.cameraX;
    }, ({ state, referenceMemory }) => {
      state.frame = (referenceMemory[0xe003] - 1) & 0xff;
    });
  }
}
if (!process.env.STAGES) {
  for (const frame of selectedDemoFrames) {
    const name = `demo-frame${String(frame).padStart(4, '0')}`;
    report[name] = await compareFrame(name, ({ game, state, referenceMemory }) => {
      state.stage = 5;
      state.lives = 5;
      state.frame = (referenceMemory[0xe003] - frame) & 0xff;
      state.demoReplay = new DemoReplay();
      game.startDemoLevel();
      state.level.skipEntry({ activateEnemies: false });
      const visibleFrame = Math.max(0, frame - demoUpdateOffset);
      for (let demoFrame = 0; demoFrame < visibleFrame; demoFrame++) {
        state.frame++;
        const replayFrame = state.demoReplay.tick();
        state.level.update({
          controls: () => replayFrame.controls,
          actionPressed: () => replayFrame.actionPressed,
        }, state);
      }
    }, ({ state, referenceMemory }) => {
      state.frame = (referenceMemory[0xe003] - 1) & 0xff;
    });
  }
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const failures = [];
for (const [name, frame] of Object.entries(report)) {
  if (frame.vramBackgroundComparison.mismatchPixels !== 0) failures.push(`${name} background=${frame.vramBackgroundComparison.mismatchPixels}`);
  if (!name.includes('-room') && frame.vramFramebufferComparison.mismatchPixels !== 0) failures.push(`${name} framebuffer=${frame.vramFramebufferComparison.mismatchPixels}`);
  if (frame.vram.nameByteMismatches !== 0 || frame.vram.patternByteMismatches !== 0 || frame.vram.uniqueColorByteMismatches !== 0) {
    failures.push(`${name} VRAM=${frame.vram.nameByteMismatches}/${frame.vram.patternByteMismatches}/${frame.vram.uniqueColorByteMismatches}`);
  }
}
if (failures.length) throw new Error(`openMSX mismatches: ${failures.join(', ')}`);

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

function parseFrameSelection(selection) {
  if (!selection) return null;
  const frames = new Set();
  for (const part of selection.split(',')) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`invalid DEMO_FRAMES entry: ${part}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first > last) throw new Error(`invalid DEMO_FRAMES range: ${part}`);
    for (let frame = first; frame <= last; frame++) frames.add(frame);
  }
  return [...frames].sort((left, right) => left - right);
}

async function compareFrame(name, setup, afterSetup) {
  const referencePath = path.join(referenceDirectory, `${name}.png`);
  const referencePng = await readFile(referencePath);
  const referenceMemory = await readFile(path.join(referenceDirectory, `${name}.memory`));
  const decoded = decodePng(referencePng);
  const reference = normalizeMsxFrame(decoded);
  const browserFrame = renderBrowser(setup, referenceMemory, afterSetup);
  const browser = browserFrame.rgba;
  const referenceVram = await readFile(path.join(referenceDirectory, `${name}.vram`));
  const referenceIndices = paletteIndices(reference.rgba);
  const browserIndices = paletteIndices(browser);
  const pngComparison = compareIndices(referenceIndices, browserIndices);
  const vramIndices = renderVramIndices(referenceVram);
  const vramComparison = compareIndices(vramIndices, browserIndices);
  const backgroundComparison = compareIndices(renderVramIndices(referenceVram, false), browserFrame.backgroundIndices);
  return {
    referenceSize: [decoded.width, decoded.height],
    normalizedSize: [reference.width, reference.height],
    referenceSha256: sha256(reference.rgba),
    browserSha256: sha256(browser),
    pngPaletteComparison: pngComparison,
    vramBackgroundComparison: backgroundComparison,
    vramFramebufferComparison: vramComparison,
    vram: compareVisibleVram(referenceVram, browserFrame.screen),
    sprites: compareSprites(referenceVram, browserFrame.screen),
    player: comparePlayerState(referenceMemory, browserFrame.state),
    ai: compareMummyStates(referenceMemory, browserFrame.state),
  };
}

function renderBrowser(setup, referenceMemory, afterSetup) {
  const context = {
    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() {},
  };
  const screen = new Screen({ getContext() { return context; } });
  const state = new GameState();
  const game = new Game(screen, input, sound, state);
  setup({ game, state, referenceMemory });
  afterSetup?.({ game, state, referenceMemory });
  game.draw();
  const backgroundIndices = paletteIndices(new Uint8Array(screen.imageData.data));
  screen.present();
  return { rgba: new Uint8Array(screen.imageData.data), backgroundIndices, screen, state };
}

function compareMummyStates(reference, state) {
  const enemies = state.level?.entities?.enemies || [];
  const fields = ['status', 'y', 'xDecimal', 'x', 'movementCounter', 'frame', 'jumpDirection', 'stairDirection', 'relativePosition', 'timer', 'type', 'stress'];
  const entries = enemies.map((enemy, index) => {
    const base = 0xe16a + index * 0x16;
    const referenceState = {
      status: reference[base],
      y: reference[base + 3],
      xDecimal: reference[base + 4],
      x: reference[base + 5],
      movementCounter: reference[base + 0x0a],
      frame: reference[base + 0x0b],
      jumpDirection: reference[base + 0x0e],
      stairDirection: reference[base + 0x0f],
      relativePosition: reference[base + 0x10],
      timer: reference[base + 0x11],
      type: reference[base + 0x14],
      stress: reference[base + 0x15],
    };
    const browserState = {
      status: enemyStatus(enemy),
      y: Math.floor(enemy.y),
      xDecimal: Math.round((enemy.x - Math.floor(enemy.x)) * 256) & 0xff,
      x: Math.floor(enemy.x),
      movementCounter: enemy.walkCounter,
      frame: enemy.frame,
      jumpDirection: enemy.jumpDirection,
      stairDirection: enemy.stairDirection < 0 ? 0 : enemy.stairDirection > 0 ? 1 : 0,
      relativePosition: enemy.relativePosition,
      timer: enemy.phase === 'active' ? (enemy.movementState === 'thinking' ? enemy.thinkTimer : enemy.walkTimer) : enemy.timer,
      type: enemy.type ?? 0,
      stress: enemy.stress,
    };
    const mismatches = fields.filter((field) => referenceState[field] !== browserState[field]);
    return { index, mismatches, reference: referenceState, browser: browserState };
  });
  return { entries, mismatchCount: entries.reduce((count, entry) => count + entry.mismatches.length, 0) };
}

function comparePlayerState(reference, state) {
  const player = state.level?.player;
  if (!player) return { mismatches: ['missing'], reference: null, browser: null };
  const referenceState = {
    status: reference[0xe134],
    direction: reference[0xe136],
    y: reference[0xe137],
    xDecimal: reference[0xe138],
    x: reference[0xe139],
    room: reference[0xe13a],
    movementCounter: reference[0xe13e],
    frame: reference[0xe13f],
    item: reference[0xe144],
  };
  const browserState = {
    status: playerStatus(player, state.level),
    direction: player.direction < 0 ? 1 : 2,
    y: Math.floor(player.y),
    xDecimal: player.xFraction & 0xff,
    x: Math.floor(player.x),
    room: Math.floor(player.x / 256),
    movementCounter: player.walkCounter,
    frame: Math.floor(player.frame / 4),
    item: player.item === 'knife' ? 0x10 : player.item === 'pickaxe' ? 0x20 : 0,
  };
  const fields = Object.keys(referenceState);
  const mismatches = fields.filter((field) => referenceState[field] !== browserState[field]);
  return { mismatches, reference: referenceState, browser: browserState };
}

function playerStatus(player, level) {
  if (player.jumpIndex >= 0) return 1;
  if (player.falling) return 2;
  if (player.onLadder) return 3;
  if (level.throwAnimation) return 4;
  if (level.digAnimation) return 5;
  if (level.spinPassAnimation) return 6;
  return 0;
}

function enemyStatus(enemy) {
  if (enemy.phase === 'limbo') return 4;
  if (enemy.phase === 'appearing') return 5;
  if (enemy.phase === 'exploding') return 8;
  return { walking: 0, jumping: 1, falling: 2, stairs: 3, thinking: 7 }[enemy.movementState] ?? 0;
}

function compareVisibleVram(reference, screen) {
  let nameByteMismatches = 0;
  let patternByteMismatches = 0;
  let colorByteMismatches = 0;
  const nameDifferences = [];
  const colorDifferences = [];
  const uniqueColorDifferences = new Map();
  for (let cell = 0; cell < screen.nameTable.length; cell++) {
    const pattern = screen.nameTable[cell];
    const referencePattern = reference[0x3800 + cell];
    if (referencePattern !== pattern) {
      nameByteMismatches++;
      if (nameDifferences.length < 16) nameDifferences.push([0x3800 + cell, referencePattern, pattern]);
    }
    if (referencePattern === 0 && pattern === 0) continue;
    const bank = Math.floor(cell / (32 * 8));
    const browserOffset = bank * 0x800 + pattern * 8;
    const referencePatternOffset = 0x2000 + browserOffset;
    for (let row = 0; row < 8; row++) {
      if (reference[referencePatternOffset + row] !== screen.patterns[browserOffset + row]) patternByteMismatches++;
      if (reference[browserOffset + row] !== screen.colors[browserOffset + row]) {
        colorByteMismatches++;
        uniqueColorDifferences.set(browserOffset + row, [reference[browserOffset + row], screen.colors[browserOffset + row]]);
        if (colorDifferences.length < 32) colorDifferences.push([browserOffset + row, reference[browserOffset + row], screen.colors[browserOffset + row]]);
      }
    }
  }
  return {
    nameByteMismatches,
    patternByteMismatches,
    colorByteMismatches,
    uniqueColorByteMismatches: uniqueColorDifferences.size,
    nameDifferences,
    colorDifferences,
    uniqueColorDifferences: [...uniqueColorDifferences].map(([offset, values]) => [offset, ...values]),
  };
}

function compareSprites(reference, screen) {
  const referenceSprites = [];
  for (let slot = 0; slot < 32; slot++) {
    const offset = 0x3b00 + slot * 4;
    const rawY = reference[offset];
    if (rawY === 208) break;
    let y = rawY + 1;
    if (y >= 224) y -= 256;
    const colorByte = reference[offset + 3];
    if (y >= 192 || y + 15 < 0) continue;
    const pattern = reference[offset + 2] & 0xfc;
    referenceSprites.push({
      slot,
      x: reference[offset + 1] - ((colorByte & 0x80) ? 32 : 0),
      y,
      pattern,
      color: colorByte & 0x0f,
      hash: sha256(reference.subarray(0x1800 + pattern * 8, 0x1800 + pattern * 8 + 32)).slice(0, 12),
    });
  }
  const browserSprites = screen.sprites.map((sprite, slot) => ({
    slot,
    x: sprite.x,
    y: sprite.y,
    color: screen.sat[slot * 4 + 3] & 0x0f,
    hash: sha256(sprite.pattern).slice(0, 12),
  }));
  return { reference: referenceSprites, browser: browserSprites };
}

function renderVramIndices(vram, includeSprites = true) {
  const indices = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) {
    const tileRow = y >> 3;
    const bankOffset = (y >> 6) * 0x800;
    for (let x = 0; x < 256; x++) {
      const pattern = vram[0x3800 + tileRow * 32 + (x >> 3)];
      const row = y & 7;
      const bits = vram[0x2000 + bankOffset + pattern * 8 + row];
      const colors = vram[bankOffset + pattern * 8 + row];
      indices[y * 256 + x] = bits & (0x80 >> (x & 7)) ? colors >> 4 : colors & 0x0f;
    }
  }
  if (!includeSprites) return indices;
  const sprites = [];
  for (let slot = 0; slot < 32; slot++) {
    const offset = 0x3b00 + slot * 4;
    const rawY = vram[offset];
    if (rawY === 208) break;
    let y = rawY + 1;
    if (y >= 224) y -= 256;
    const colorByte = vram[offset + 3];
    sprites.push({
      y,
      x: vram[offset + 1] - ((colorByte & 0x80) ? 32 : 0),
      pattern: vram[offset + 2] & 0xfc,
      color: colorByte & 0x0f,
    });
  }
  const lineCount = new Uint8Array(192);
  const visibleRows = sprites.map(() => new Uint8Array(16));
  for (let slot = 0; slot < sprites.length; slot++) {
    for (let row = 0; row < 16; row++) {
      const y = sprites[slot].y + row;
      if (y < 0 || y >= 192) continue;
      visibleRows[slot][row] = lineCount[y] < 4 ? 1 : 0;
      lineCount[y]++;
    }
  }
  for (let slot = sprites.length - 1; slot >= 0; slot--) {
    const sprite = sprites[slot];
    if (sprite.color === 0) continue;
    const patternOffset = 0x1800 + sprite.pattern * 8;
    for (let row = 0; row < 16; row++) {
      if (!visibleRows[slot][row]) continue;
      const y = sprite.y + row;
      for (let half = 0; half < 2; half++) {
        const bits = vram[patternOffset + row + half * 16];
        for (let column = 0; column < 8; column++) {
          if (!(bits & (0x80 >> column))) continue;
          const x = sprite.x + half * 8 + column;
          if (x >= 0 && x < 256) indices[y * 256 + x] = sprite.color;
        }
      }
    }
  }
  return indices;
}

function compareIndices(reference, browser) {
  let mismatchPixels = 0;
  let minX = 256;
  let minY = 192;
  let maxX = -1;
  let maxY = -1;
  const mismatchPairs = new Map();
  const mismatchCoordinates = [];
  for (let index = 0; index < reference.length; index++) {
    const referenceColor = reference[index] === 1 ? 0 : reference[index];
    const browserColor = browser[index] === 1 ? 0 : browser[index];
    if (referenceColor === browserColor) continue;
    mismatchPixels++;
    const pair = `${referenceColor}:${browserColor}`;
    mismatchPairs.set(pair, (mismatchPairs.get(pair) || 0) + 1);
    const x = index % 256;
    const y = Math.floor(index / 256);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (mismatchCoordinates.length < 32) mismatchCoordinates.push([x, y, referenceColor, browserColor]);
  }
  return {
    mismatchPixels,
    mismatchPercent: Number((mismatchPixels * 100 / reference.length).toFixed(4)),
    mismatchBounds: mismatchPixels ? [minX, minY, maxX, maxY] : null,
    mismatchPairs: [...mismatchPairs.entries()].sort((left, right) => right[1] - left[1]).slice(0, 16),
    mismatchCoordinates,
  };
}

function paletteIndices(rgba) {
  const colors = PALETTE.map(hex => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]);
  const result = new Uint8Array(rgba.length / 4);
  for (let index = 0; index < result.length; index++) {
    const offset = index * 4;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let paletteIndex = 0; paletteIndex < colors.length; paletteIndex++) {
      const color = colors[paletteIndex];
      const red = rgba[offset] - color[0];
      const green = rgba[offset + 1] - color[1];
      const blue = rgba[offset + 2] - color[2];
      const distance = red * red + green * green + blue * blue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = paletteIndex;
      }
    }
    result[index] = bestIndex;
  }
  return result;
}

function resizeNearest(source, width, height) {
  if (source.width === width && source.height === height) return source;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / width));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      rgba.set(source.rgba.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width, height, rgba };
}

function normalizeMsxFrame(source) {
  if (source.width === 320 && source.height === 240) return crop(source, 32, 24, 256, 192);
  return resizeNearest(source, 256, 192);
}

function crop(source, left, top, width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceOffset = ((top + y) * source.width + left) * 4;
    rgba.set(source.rgba.subarray(sourceOffset, sourceOffset + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

function decodePng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('invalid PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const dataChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') dataChunks.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error(`unsupported PNG format: depth=${bitDepth}, type=${colorType}, interlace=${interlace}`);
  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const compressed = Buffer.concat(dataChunks);
  const scanlines = inflateSync(compressed);
  const rgba = new Uint8Array(width * height * 4);
  let sourceOffset = 0;
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = scanlines[sourceOffset++];
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const raw = scanlines[sourceOffset++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 0) row[x] = raw;
      else if (filter === 1) row[x] = (raw + left) & 0xff;
      else if (filter === 2) row[x] = (raw + up) & 0xff;
      else if (filter === 3) row[x] = (raw + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (raw + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const sourcePixel = x * channels;
      const targetPixel = (y * width + x) * 4;
      rgba[targetPixel] = row[sourcePixel];
      rgba[targetPixel + 1] = row[sourcePixel + 1];
      rgba[targetPixel + 2] = row[sourcePixel + 2];
      rgba[targetPixel + 3] = channels === 4 ? row[sourcePixel + 3] : 255;
    }
    previous = row;
  }
  return { width, height, rgba };
}

function paeth(left, up, upLeft) {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
