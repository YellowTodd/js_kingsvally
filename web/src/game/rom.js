import { KVALLEY_ASSETS } from './romdata.js';

export function decodeGfxSet(encoded, vram = new Uint8Array(0x4000)) {
  let pointer = 0;
  let destination = encoded[pointer] | (encoded[pointer + 1] << 8);
  pointer += 2;
  decodeGfxStream(encoded, pointer, destination, vram);
  return vram;
}

export function decodePatterns(encoded, destination, vram = new Uint8Array(0x4000)) {
  for (let bank = 0; bank < 3; bank++) {
    decodeGfxStream(encoded, 0, destination + bank * 0x800, vram);
  }
  return vram;
}

function decodeGfxStream(encoded, pointer, destination, vram) {
  while (pointer < encoded.length) {
    const control = encoded[pointer++];
    const count = control & 0x7f;
    if (control === 0) return pointer;
    if (control === 0x80) {
      destination = encoded[pointer] | (encoded[pointer + 1] << 8);
      pointer += 2;
      continue;
    }
    if ((control & 0x80) !== 0) {
      for (let countIndex = 0; countIndex < count; countIndex++) vram[destination++ & 0x3fff] = encoded[pointer++];
    } else {
      const value = encoded[pointer++];
      for (let repeatIndex = 0; repeatIndex < count; repeatIndex++) vram[destination++ & 0x3fff] = value;
    }
  }
  return pointer;
}

function skipGfxStream(encoded, pointer) {
  return decodeGfxStream(encoded, pointer, 0, new Uint8Array(0x4000));
}

function reverseBits(value) {
  let result = 0;
  for (let bit = 0; bit < 8; bit++) result = (result << 1) | ((value >>> bit) & 1);
  return result;
}

function copyFlippedPatterns(vram, sourcePattern, destinationPattern, count) {
  for (let bank = 0; bank < 3; bank++) {
    const bankOffset = bank * 0x800;
    for (let index = 0; index < count; index++) {
      const source = bankOffset + 0x2000 + (sourcePattern + index) * 8;
      const destination = bankOffset + 0x2000 + (destinationPattern + index) * 8;
      for (let row = 0; row < 8; row++) vram[destination + row] = reverseBits(vram[source + row]);
    }
  }
}

const gameVram = decodePatterns(KVALLEY_ASSETS.graphics.GFX_InGame.bytes, 0x2200);
for (let gem = 0; gem < 6; gem++) decodePatterns(KVALLEY_ASSETS.graphics.GFX_GEMA.bytes, 0x2430 + gem * 8, gameVram);
const colorInGameBytes = KVALLEY_ASSETS.graphics.COLOR_InGame.bytes;
const colorInGameStream = colorInGameBytes.at(-1) === 0
  ? colorInGameBytes
  : [...colorInGameBytes, ...KVALLEY_ASSETS.graphics.COLOR_Flipped.bytes];
const colorVram = decodePatterns(colorInGameStream, 0x0228);
decodePatterns(KVALLEY_ASSETS.graphics.COLOR_GEMAS.bytes, 0x0430, colorVram);
decodePatterns(KVALLEY_ASSETS.graphics.COLOR_Flipped.bytes, 0x03b8, colorVram);
copyFlippedPatterns(gameVram, 0x68, 0x77, 0x0f);
const spriteVram = new Uint8Array(0x2000);
decodeGfxSet(KVALLEY_ASSETS.graphics.GFX_Prota.bytes, spriteVram);
decodeGfxSet(KVALLEY_ASSETS.graphics.GFX_MOMIA.bytes, spriteVram);
decodeGfxSet(KVALLEY_ASSETS.graphics.GFX_SPRITES2.bytes, spriteVram);
const playerSpriteSets = {
  none: decodeGfxSet(KVALLEY_ASSETS.graphics.GFX_Prota.bytes, new Uint8Array(0x2000)),
  knife: decodeGfxSet(KVALLEY_ASSETS.graphics.GFX_ProtaKnife.bytes, new Uint8Array(0x2000)),
  pickaxe: decodeGfxSet(KVALLEY_ASSETS.graphics.GFX_ProtaPico.bytes, new Uint8Array(0x2000)),
};

const introVram = decodePatterns(KVALLEY_ASSETS.graphics.GFX_Font.bytes, 0x2080);
decodePatterns(KVALLEY_ASSETS.graphics.GFX_KonamiLogo.bytes, 0x2300, introVram);
decodePatterns(KVALLEY_ASSETS.graphics.GFX_Menu.bytes, 0x2480, introVram);
const introColorVram = new Uint8Array(0x4000);
introColorVram.fill(0xf0);
decodePatterns(KVALLEY_ASSETS.graphics.ATTRIB_Menu.bytes, 0x0480, introColorVram);
for (let index = 0; index < 0x16; index++) {
  decodePatterns(KVALLEY_ASSETS.graphics.COLORES_LOGO.bytes, 0x04d8 + index * 0x10, introColorVram);
}
for (let bank = 0; bank < 3; bank++) introColorVram.fill(0x40, 0x0638 + bank * 0x800, 0x0648 + bank * 0x800);

const mapVram = new Uint8Array(0x4000);
decodePatterns(KVALLEY_ASSETS.graphics.gfxMap.bytes, 0x2600, mapVram);
decodePatterns(KVALLEY_ASSETS.graphics.colorTableMap.bytes, 0x0600, mapVram);
decodeGfxSet(KVALLEY_ASSETS.graphics.gfxSprMapa.bytes, mapVram);
mapVram.set(introVram.subarray(0x2080, 0x2200), 0x2080);
mapVram.set(introColorVram.subarray(0, 0x200), 0);

const endingVram = introVram.slice();
const endingColorVram = introColorVram.slice();
decodePatterns(KVALLEY_ASSETS.ending.endingTiles.bytes, 0x2480, endingVram);
decodePatterns(KVALLEY_ASSETS.ending.endingColors.bytes, 0x0480, endingColorVram);

export const ROM_GRAPHICS = {
  romSha256: KVALLEY_ASSETS.romSha256,
  gameVram,
  colorVram,
  spriteVram,
  introVram,
  introColorVram,
  mapVram,
  endingVram,
  endingColorVram,
};

export const ROM_BYTES = Uint8Array.from(KVALLEY_ASSETS.romBytes || []);

export function applyStoneColors(stageNumber) {
  const blocks = KVALLEY_ASSETS.graphics.ColoresPiedra.bytes;
  const block = Math.min(3, Math.floor((stageNumber - 1) / 4));
  let pointer = 0;
  for (let index = 0; index < block; index++) pointer = skipGfxStream(blocks, pointer);
  for (let pattern = 0; pattern < 5; pattern++) {
    for (let bank = 0; bank < 3; bank++) decodeGfxStream(blocks, pointer, 0x0200 + pattern * 8 + bank * 0x800, colorVram);
  }
}

export function introPattern(pattern, row) {
  const bank = Math.floor(row / 64);
  const start = bank * 0x800 + 0x2000 + pattern * 8;
  return introVram.subarray(start, start + 8);
}

export function introColors(pattern, row) {
  const bank = Math.floor(row / 64);
  const start = bank * 0x800 + pattern * 8;
  return introColorVram.subarray(start, start + 8);
}

export function tilePattern(pattern) {
  return gameVram.subarray(0x2000 + pattern * 8, 0x2000 + pattern * 8 + 8);
}

export function tileColors(pattern) {
  return colorVram.subarray(pattern * 8, pattern * 8 + 8);
}

export function spritePattern(pattern) {
  const start = 0x1800 + pattern * 8;
  return spriteVram.subarray(start, start + 32);
}

export function playerSpritePattern(pattern, item) {
  const start = 0x1800 + pattern * 8;
  const sprites = playerSpriteSets[item] || playerSpriteSets.none;
  return sprites.subarray(start, start + 32);
}

export function mapPattern(pattern) {
  const start = 0x2000 + pattern * 8;
  return ROM_GRAPHICS.mapVram.subarray(start, start + 8);
}

export function mapColors(pattern) {
  const start = pattern * 8;
  return ROM_GRAPHICS.mapVram.subarray(start, start + 8);
}

export function mapNameTable() {
  return ROM_GRAPHICS.mapVram.subarray(0x3800, 0x3b00);
}

export function mapSpritePattern(pattern) {
  const start = 0x1800 + pattern * 8;
  return ROM_GRAPHICS.mapVram.subarray(start, start + 32);
}

export function endingPattern(pattern, row) {
  const bank = Math.floor(row / 64);
  const start = bank * 0x800 + 0x2000 + pattern * 8;
  return ROM_GRAPHICS.endingVram.subarray(start, start + 8);
}

export function endingColors(pattern, row) {
  const bank = Math.floor(row / 64);
  const start = bank * 0x800 + pattern * 8;
  return ROM_GRAPHICS.endingColorVram.subarray(start, start + 8);
}

export const ENDING_ASSETS = {
  door: Uint8Array.from(KVALLEY_ASSETS.ending.tilesEndDoor.bytes),
  stars: Uint8Array.from(KVALLEY_ASSETS.ending.starsLocations.bytes),
  player: Uint8Array.from(KVALLEY_ASSETS.ending.protaEndingDat.bytes),
};

export const DEMO_CONTROLS = Uint8Array.from(KVALLEY_ASSETS.demo.controls.bytes);

export function flippedSpritePattern(pattern) {
  return flipSpritePattern(spritePattern(pattern));
}

export function flippedPlayerSpritePattern(pattern, item) {
  return flipSpritePattern(playerSpritePattern(pattern, item));
}

function flipSpritePattern(source) {
  const flipped = new Uint8Array(32);
  for (let row = 0; row < 16; row++) {
    flipped[row] = reverseBits(source[row + 16]);
    flipped[row + 16] = reverseBits(source[row]);
  }
  return flipped;
}
