#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const romPath = resolve(process.argv[2] || 'rom/RC-727.rom');
const symbolPath = resolve(process.argv[3] || 'build/kvalley.sym');
const outputPath = resolve(process.argv[4] || 'web/src/game/romdata.js');
const rom = await readFile(romPath);
const symbols = parseSymbols(await readFile(symbolPath, 'utf8'));
const romBase = 0x4000;
const romEnd = romBase + rom.length;

function addressOf(label) {
  const address = symbols.get(label);
  if (address === undefined) throw new Error(`Missing symbol: ${label}`);
  return address;
}

function bytesAt(address, length) {
  if (address < romBase || address + length > romEnd) throw new Error(`ROM range outside cartridge: ${address.toString(16)}`);
  return Array.from(rom.subarray(address - romBase, address - romBase + length));
}

function range(label, endLabel) {
  const start = addressOf(label);
  const end = endLabel ? addressOf(endLabel) : nextRomSymbol(start);
  return { address: start, bytes: bytesAt(start, end - start) };
}

function compressedRange(label) {
  const start = addressOf(label);
  const startOffset = start - romBase;
  let pointer = startOffset;
  while (pointer < rom.length) {
    const control = rom[pointer++];
    if (control === 0) return { address: start, bytes: Array.from(rom.subarray(startOffset, pointer)) };
    if (control === 0x80) pointer += 2;
    else if (control & 0x80) pointer += control & 0x7f;
    else pointer++;
  }
  throw new Error(`Unterminated graphics stream: ${label}`);
}

function nextRomSymbol(start) {
  const candidates = [...symbols.values()].filter((address) => address > start && address >= romBase && address < romEnd);
  if (candidates.length === 0) return romEnd;
  return Math.min(...candidates);
}

function namedRanges(labels) {
  return Object.fromEntries(labels.map((label, index) => {
    const nextLabel = labels[index + 1];
    return [label, range(label, nextLabel)];
  }));
}

function parseSymbols(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^:]+): equ ([0-9A-F]+)h$/i);
    if (match) result.set(match[1].trim(), Number.parseInt(match[2], 16));
  }
  return result;
}

const graphics = namedRanges([
  'GFX_Font', 'GFX_Space', 'GFX_KonamiLogo', 'GFX_Menu', 'ATTRIB_Menu',
  'COLORES_LOGO', 'GFX_PiramidLogo', 'GFX_Prota', 'GFX_ProtaKnife',
  'GFX_ProtaPico', 'GFX_MOMIA', 'GFX_SPRITES2', 'GFX_InGame', 'GFX_GEMA',
  'COLOR_InGame', 'COLOR_Flipped', 'COLOR_GEMAS', 'ColoresPiedra',
  'gfxMap', 'colorTableMap', 'gfxSprMapa',
]);
for (const label of ['COLOR_InGame', 'COLOR_Flipped', 'COLOR_GEMAS']) graphics[label] = compressedRange(label);
const halfMaps = namedRanges(['halfMap1', 'halfMap2', 'halfMap3', 'halfMap4']);
const stageLabels = Array.from({ length: 15 }, (_, index) => `MapStage${index + 1}`);
const stages = namedRanges(stageLabels.sort((left, right) => addressOf(left) - addressOf(right)));
const tiles = namedRanges([
  'tilesNULL', 'tilesPlataforma', 'tilesEscalera', 'tilesCuchillo', 'tilesGemas',
  'tilesGiratoria', 'tilesSalida', 'tilesSalida2', 'tilePico', 'tilesAgujero',
]);
const ending = namedRanges(['endingTiles', 'endingColors', 'tilesEndDoor', 'starsLocations', 'protaEndingDat']);
const demo = { controls: range('DemoKeyData', 'tickGame') };

const sourceName = relative(process.cwd(), romPath).replaceAll('\\', '/');
const output = `/** Generated from ${sourceName}; do not edit. */\nexport const KVALLEY_ASSETS = ${JSON.stringify({
  romSha256: createHash('sha256').update(rom).digest('hex'),
  romBase,
  romBytes: Array.from(rom),
  graphics,
  halfMaps,
  stages,
  tiles,
  ending,
  demo,
}, null, 2)};\n`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output);
console.log(`wrote ${outputPath}`);
console.log(`ROM SHA-256 ${KVALLEY_ASSETS_HASH(output)}`);

function KVALLEY_ASSETS_HASH(value) {
  return value.match(/romSha256[^:]*: "([^"]+)/)?.[1] || '';
}
