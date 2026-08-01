import { KVALLEY_ASSETS } from './romdata.js';

export const STAGE_COUNT = 15;

const STAIR_ENTRY_Y = [0, -1, -2, -3, -4, -3, -2, -1];

export function makeStage(stageNumber) {
  const original = decodeOriginalStage(stageNumber);
  if (original) return original;

  const width = 96;
  const height = 22;
  const tiles = Array.from({ length: height }, () => Array(width).fill(0));
  const platforms = [
    [20, 18, 92], [3, 15, 25], [38, 15, 30], [73, 15, 20],
    [12, 11, 22], [50, 10, 25], [80, 8, 14], [27, 6, 18], [62, 4, 24],
  ];
  for (const [start, row, length] of platforms) {
    for (let column = start; column < Math.min(width, start + length); column++) tiles[row][column] = 1;
  }
  for (let column = 0; column < width; column++) tiles[21][column] = 1;
  const stairs = [[18, 18, 11], [45, 15, 10], [70, 15, 7], [30, 15, 9], [57, 10, 6], [78, 15, 7], [67, 4, 6]];
  for (const [column, bottom, length] of stairs) {
    for (let row = bottom; row > Math.max(1, bottom - length); row--) if (!tiles[row][column]) tiles[row][column] = 2;
  }
  const gemLocations = [
    [16, 14], [45, 14], [63, 9], [84, 7], [31, 5], [73, 3],
  ];
  const enemies = [
    { x: 94, y: 176, direction: -1, color: '#ded087' },
    { x: 132, y: 136, direction: 1, color: '#b766b5' },
    { x: 224, y: 176, direction: -1, color: '#ded087' },
    { x: 420, y: 96, direction: 1, color: '#ded087' },
    { x: 612, y: 56, direction: -1, color: '#b766b5' },
  ];
  const variation = (stageNumber - 1) % 3;
  for (let index = 0; index < variation; index++) enemies.push({ x: 520 + index * 80, y: 176, direction: index % 2 ? -1 : 1, color: '#db6559' });
  return { number: stageNumber, width, height, tiles, gemLocations, enemies, exit: { x: 744, y: 152 } };
}

function decodeOriginalStage(stageNumber) {
  const raw = KVALLEY_ASSETS.stages[`MapStage${stageNumber}`]?.bytes;
  if (!raw) return null;
  let pointer = 0;
  const selectors = [];
  for (let chunk = 0; chunk < 4; chunk++) {
    const selector = raw[pointer++];
    selectors.push(selector);
    if ((selector & 0xf0) === 0x30) break;
  }
  const width = selectors.length * 16;
  const height = 22;
  const tiles = Array.from({ length: height }, () => Array(width).fill(0));
  const tilePatterns = Array.from({ length: height }, () => Array(width).fill(0));
  const mapIds = Array.from({ length: height }, () => Array(width).fill(0));
  for (let chunk = 0; chunk < selectors.length; chunk++) {
    decodeHalfMap(selectors[chunk], chunk * 16, tiles, tilePatterns, mapIds);
  }
  const doors = readDoors(raw, pointer);
  pointer = doors.pointer;
  const mummyCount = raw[pointer++];
  const enemies = [];
  for (let mummy = 0; mummy < mummyCount; mummy++) {
    const y = raw[pointer++];
    const packedX = raw[pointer++];
    const type = raw[pointer++];
    enemies.push({
      x: (packedX & 0xf8) + ((packedX & 1) ? 256 : 0),
      y,
      direction: 1,
      type,
      colorIndex: [15, 9, 4, 8, 10][type & 7] ?? 15,
    });
  }
  const gemCount = raw[pointer++];
  const gemLocations = [];
  for (let gem = 0; gem < gemCount; gem++) {
    const color = raw[pointer++];
    const y = raw[pointer++];
    const packedX = raw[pointer++];
    gemLocations.push({ x: (packedX & 0xf8) + ((packedX & 1) ? 256 : 0), y, color });
  }
  const knifeCount = raw[pointer++];
  const knives = [];
  for (let knife = 0; knife < knifeCount; knife++) knives.push(readPosition(raw, pointer + knife * 2));
  pointer += knifeCount * 2;
  const pickCount = raw[pointer++];
  const picks = [];
  for (let pick = 0; pick < pickCount; pick++) picks.push(readPosition(raw, pointer + pick * 2));
  pointer += pickCount * 2;
  const spinnerCount = raw[pointer++];
  const spinners = [];
  for (let spinner = 0; spinner < spinnerCount; spinner++) {
    const height = raw[pointer];
    const y = raw[pointer + 1];
    const packedX = raw[pointer + 2];
    spinners.push({
      height,
      x: (packedX & 0xf8) + ((packedX & 4) ? 256 : 0),
      y,
      direction: (packedX & 3) << 2,
    });
    pointer += 3;
  }
  const trapCount = raw[pointer++];
  const traps = [];
  for (let trap = 0; trap < trapCount; trap++) traps.push(readPosition(raw, pointer + trap * 2));
  pointer += trapCount * 2;
  const stairCount = raw[pointer++];
  for (let stair = 0; stair < stairCount; stair++) {
    const y = raw[pointer++];
    const packedX = raw[pointer++];
    let column = Math.floor(((packedX & 0xf8) + ((packedX & 2) ? 256 : 0)) / 8);
    let row = Math.floor(y / 8);
    const direction = packedX & 1;
    while (row >= 0 && row < height && column >= 0 && column + 1 < width) {
      const reachesPlatform = mapIds[row][column] !== 0;
      const firstId = reachesPlatform ? 0x15 : 0x20;
      const directionOffset = direction ? 2 : 0;
      mapIds[row][column] = firstId + directionOffset;
      mapIds[row][column + 1] = firstId + directionOffset + 1;
      tilePatterns[row][column] = mapPatternForId(mapIds[row][column]);
      tilePatterns[row][column + 1] = mapPatternForId(mapIds[row][column + 1]);
      if (!reachesPlatform) {
        tiles[row][column] = 2;
        tiles[row][column + 1] = 2;
      }
      row--;
      if (!direction) column--;
      else column++;
      if (reachesPlatform) break;
    }
  }
  for (const spinner of spinners) {
    const column = Math.floor(spinner.x / 8);
    const firstRow = Math.floor(spinner.y / 8);
    const doorHeight = ((spinner.height >> 1) & 3) + 2;
    const firstId = (spinner.direction & 4) ? 0x52 : 0x50;
    for (let row = firstRow; row < Math.min(height, firstRow + doorHeight); row++) {
      if (column >= 0 && column + 1 < width) {
        const leftId = firstId;
        tiles[row][column] = 1;
        tiles[row][column + 1] = 1;
        mapIds[row][column] = leftId;
        mapIds[row][column + 1] = leftId + 1;
        tilePatterns[row][column] = mapPatternForId(leftId);
        tilePatterns[row][column + 1] = mapPatternForId(leftId + 1);
      }
    }
  }
  const exits = doors.items.map((candidate, index) => candidate && ({
    x: candidate.x + (candidate.room ? 256 : 0),
    y: candidate.y,
    target: candidate.target,
    direction: candidate.direction,
    exitDirection: [1, 2, 4, 8][index],
  })).filter(Boolean);
  const entrance = exits.find((exit) => exit.target === stageNumber - 1) || exits[0] || { x: 32, y: 152, direction: 8 };
  for (const exit of exits) exit.entrance = exit === entrance;
  return {
    number: stageNumber,
    width,
    height,
    tiles,
    tilePatterns,
    mapIds,
    gemLocations,
    enemies,
    knives,
    picks,
    spinners,
    traps,
    exits,
    start: {
      x: entrance.x + 8,
      y: Math.max(0, entrance.y - 8),
      direction: -1,
    },
    exit: exits[0] || { x: width * 8 - 24, y: 160 },
    source: { selectors, doors: doors.items, knifeCount, pickCount, spinnerCount, trapCount, stairCount },
  };
}

function readPosition(raw, pointer) {
  const y = raw[pointer];
  const packedX = raw[pointer + 1];
  return { x: (packedX & 0xf8) + ((packedX & 1) ? 256 : 0), y };
}

function decodeHalfMap(selector, destinationColumn, tiles, tilePatterns, mapIds) {
  if (selector === 0xff) return;
  const halfIndex = ((selector >>> 3) & 0x1e) >> 1;
  const halfMap = KVALLEY_ASSETS.halfMaps[`halfMap${halfIndex + 1}`]?.bytes;
  if (!halfMap) return;
  const offset = (selector & 0x0f) * 44;
  for (let row = 0; row < 22; row++) {
    const left = halfMap[offset + row * 2] || 0;
    const right = halfMap[offset + row * 2 + 1] || 0;
    for (let column = 0; column < 16; column++) {
      const occupied = column < 8 ? left & (0x80 >> column) : right & (0x80 >> (column - 8));
      if (occupied) {
        tiles[row][destinationColumn + column] = 1;
        mapIds[row][destinationColumn + column] = 0x12;
        tilePatterns[row][destinationColumn + column] = 0x40;
      }
    }
  }
}

export function mapPatternForId(id) {
  const groups = [
    [0],
    [0, 0, 0x40, 0x40, 0x41, 0x73, 0x74, 0x83, 0x82, 0x40, 0x42, 0x43, 0x44, 0x44],
    [0x75, 0x76, 0x85, 0x84],
    [0x4b, 0x4b, 0x4b],
    [0x51, 0x52, 0x53, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b],
    [0x68, 0x69, 0x78, 0x77],
    [0x6c, 0x7b, 0x6d, 0x7c, 0x6e, 0x7d, 0x63, 0x64, 0x65, 0x66, 0x67, 0x6f, 0x5f, 0x60, 0x7e, 0x70],
    [0x71, 0x80, 0x7f, 0x72, 0x61, 0x62, 0x81, 0x5c, 0x5d, 0x5e],
    [0x4c],
    [0], [0], [0], [0],
    [0x43, 0x44],
  ];
  const group = (id >>> 4) & 0x0f;
  const table = groups.slice(group).flat();
  return table[id & 0x0f] || 0;
}

function readDoors(raw, pointer) {
  const items = [];
  for (let door = 0; door < 4; door++) {
    const y = raw[pointer++];
    if (y === 0xff) {
      items.push(null);
      continue;
    }
    const packedX = raw[pointer++];
    const target = raw[pointer++];
    items.push({ y, x: packedX & 0xf8, room: packedX & 1, target: target >> 4, direction: target & 0x0f });
  }
  return { items, pointer };
}

export function isSolid(level, worldX, worldY) {
  const column = Math.floor(worldX / 8);
  const row = Math.floor(worldY / 8);
  if (column < 0 || column >= level.width || row < 0) return false;
  if (row >= level.height) return true;
  return level.tiles[row][column] === 1;
}

export function mapIdAt(level, worldX, worldY) {
  const column = Math.floor(worldX / 8);
  const row = Math.floor(worldY / 8);
  if (column < 0 || column >= level.width || row < 0 || row >= level.height) return 0;
  return level.mapIds?.[row]?.[column] || 0;
}

export function stairAscentDirection(mapId) {
  const stairId = mapId === 0x31 || mapId === 0x32 ? mapId - 0x10 : mapId;
  if ((stairId >= 0x15 && stairId <= 0x16) || (stairId >= 0x20 && stairId <= 0x21)) return -1;
  if ((stairId >= 0x17 && stairId <= 0x18) || (stairId >= 0x22 && stairId <= 0x23)) return 1;
  return 0;
}

export function stairEntryAt(level, actorX, actorY, verticalDirection) {
  const x = Math.floor(actorX);
  const y = Math.floor(actorY);
  const relativeX = x & 7;
  if (verticalDirection < 0) {
    if (relativeX === 0) return null;
    const stairId = mapIdAt(level, (Math.floor(x / 8) + 1) * 8, (Math.floor(y / 8) + 1) * 8);
    const expectedId = relativeX < 5 ? 0x22 : 0x21;
    const matchesExpected = stairId === expectedId || stairId === expectedId + 0x10;
    const matchesAdjacentLeftStair = relativeX < 5 && (stairId === 0x21 || stairId === 0x31);
    if (!matchesExpected && !matchesAdjacentLeftStair) return null;
    return { ascentDirection: stairAscentDirection(stairId), yOffset: STAIR_ENTRY_Y[relativeX] };
  }
  if (relativeX !== 4) return null;
  const stairId = mapIdAt(level, (Math.floor(x / 8) + 1) * 8, (Math.floor(y / 8) + 2) * 8);
  if (stairId !== 0x16 && stairId !== 0x17) return null;
  return { ascentDirection: stairAscentDirection(stairId), yOffset: 4 };
}

export function isStairExit(level, actorX, actorY) {
  const x = Math.floor(actorX);
  const y = Math.floor(actorY);
  if ((x & 3) !== 0 || (y & 7) !== 0) return false;
  const belowRow = Math.floor((y + 16) / 8);
  return belowRow >= level.height
    || (mapIdAt(level, (Math.floor(x / 8) + 1) * 8, y + 16) & 0xf0) === 0x10;
}

export function isLadder(level, worldX, worldY) {
  const column = Math.floor(worldX / 8);
  const row = Math.floor(worldY / 8);
  return row >= 0 && row < level.height && column >= 0 && column < level.width && level.tiles[row][column] === 2;
}
