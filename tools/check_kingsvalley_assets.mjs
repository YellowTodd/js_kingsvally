#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AyPcmRenderer, encodeMonoWav } from '../web/src/ay.js';
import { KVALLEY_ASSETS } from '../web/src/game/romdata.js';
import { mapNameTable, playerSpritePattern, ROM_BYTES, ROM_GRAPHICS, spritePattern, tilePattern } from '../web/src/game/rom.js';
import { makeStage } from '../web/src/game/data.js';
import { EntitySystem } from '../web/src/game/entity.js';
import { DemoReplay, endingSceneNameTable, Game, mapArrow, mapMarkerState, pauseTextVisible, pyramidDisplayNumber } from '../web/src/game/flow.js';
import { knifeFlightFrame, Level } from '../web/src/game/level.js';
import { Player } from '../web/src/game/player.js';
import { DOWN, Input, LEFT, RIGHT, UP } from '../web/src/input.js';
import { KingsValleyPsg } from '../web/src/psg.js';
import { Screen } from '../web/src/screen.js';
import { GameState } from '../web/src/game/state.js';

const rom = await readFile(process.argv[2] || 'rom/RC-727.rom');
const actualHash = createHash('sha256').update(rom).digest('hex');
if (actualHash !== KVALLEY_ASSETS.romSha256) throw new Error('romdata.js does not match the selected ROM');

const graphicNames = Object.keys(KVALLEY_ASSETS.graphics);
for (const graphicName of graphicNames) {
  const bytes = KVALLEY_ASSETS.graphics[graphicName].bytes;
  if (bytes.length === 0) throw new Error(`empty graphics block: ${graphicName}`);
}
for (const halfMapName of Object.keys(KVALLEY_ASSETS.halfMaps)) {
  if (KVALLEY_ASSETS.halfMaps[halfMapName].bytes.length < 44) throw new Error(`short half map: ${halfMapName}`);
}

const stages = [];
for (let stageNumber = 1; stageNumber <= 15; stageNumber++) {
  const stage = makeStage(stageNumber);
  const solidTiles = stage.tiles.flat().filter((tile) => tile === 1).length;
  const ladderTiles = stage.tiles.flat().filter((tile) => tile === 2).length;
  if (solidTiles === 0 || stage.gemLocations.length === 0 || stage.enemies.length === 0) throw new Error(`incomplete stage ${stageNumber}`);
  for (const spinner of stage.spinners) {
    const column = Math.floor(spinner.x / 8);
    const firstRow = Math.floor(spinner.y / 8);
    const rows = ((spinner.height >> 1) & 3) + 2;
    const firstId = spinner.direction & 4 ? 0x52 : 0x50;
    for (let row = firstRow; row < firstRow + rows; row++) {
      if (stage.mapIds[row][column] !== firstId || stage.mapIds[row][column + 1] !== firstId + 1) throw new Error(`stage ${stageNumber} spinner map mismatch at ${column},${row}`);
    }
  }
  stages.push({ stageNumber, width: stage.width, solidTiles, ladderTiles, gems: stage.gemLocations.length, enemies: stage.enemies.length });
}
if (makeStage(1).exits[0].exitDirection !== 8 || makeStage(1).exits[0].direction !== 4) throw new Error('stage 1 map arrow directions mismatch');
const upwardMapArrow = mapArrow(1, false, 0x4a, 0x3f);
if (upwardMapArrow.x !== 0x4c || upwardMapArrow.y !== 0x38 || upwardMapArrow.pattern !== 0xe8) throw new Error('outgoing map arrow mismatch');
const incomingMapArrow = mapArrow(4, true, 0x6a, 0x3f);
if (incomingMapArrow.x !== 0x5b || incomingMapArrow.y !== 0x38 || incomingMapArrow.pattern !== 0xec) throw new Error('incoming map arrow mismatch');
const markerState = { mapFrame: 87, mapOriginStage: 1, mapDestinationStage: 2, mapExitDirection: 1, mapEntranceDirection: 4 };
if (mapMarkerState(markerState).stage !== 1 || mapMarkerState({ ...markerState, mapFrame: 88 }).stage !== 2) throw new Error('map marker 88-frame transition mismatch');
if (mapMarkerState({ ...markerState, mapFrame: 88, mapOriginStage: 15, mapDestinationStage: 1 }).stage !== 0) throw new Error('map goal marker mismatch');

const demoReplay = new DemoReplay();
for (let frame = 0; frame < 7; frame++) if (demoReplay.tick().controls !== RIGHT) throw new Error('demo initial right input mismatch');
const eighthDemoFrame = demoReplay.tick();
if (eighthDemoFrame.controls !== RIGHT || demoReplay.pointer !== 2 || demoReplay.holdCounter !== 0x98) throw new Error('demo first segment timing mismatch');
if (demoReplay.tick().controls !== (DOWN | LEFT)) throw new Error('demo second input mismatch');
let demoFrames = 9;
let demoActionTriggers = 0;
while (!demoReplay.finished && demoFrames < 3000) {
  const replayFrame = demoReplay.tick();
  if (replayFrame.actionPressed) demoActionTriggers++;
  demoFrames++;
}
if (demoFrames !== 2000 || demoActionTriggers !== 8) throw new Error(`demo stream mismatch: ${demoFrames}/${demoActionTriggers}`);

const idleInput = { anyPressed() { return false; }, actionPressed() { return false; }, pressed() { return false; }, endFrame() {} };
const demoSoundEvents = [];
const demoSound = { stopAll() {}, setMuted() {}, setMusic(id) { demoSoundEvents.push(id); }, isPlaying() { return false; } };
const menuState = { mode: 'menu', frame: 0, menuWait: 0x100, transitionFrame: 0, lives: 5, stage: 1, demoReplay: null, paused: false };
const menuGame = new Game(null, idleInput, demoSound, menuState);
menuGame.menuProgress = 22;
menuGame.draw = () => {};
for (let frame = 0; frame < 255; frame++) menuGame.tick();
if (menuState.mode !== 'menu') throw new Error('menu demo started before 256 idle frames');
menuGame.tick();
if (menuState.mode !== 'curtain-to-demo' || menuState.stage !== 5) throw new Error('menu did not start the stage 5 demo');
for (let frame = 0; frame < 32; frame++) menuGame.tick();
if (menuState.mode !== 'demo' || menuState.lives !== 4 || menuState.level.data.number !== 5 || !menuState.level.demo) throw new Error('demo curtain or stage setup mismatch');
menuState.level.skipEntry();
if (demoSoundEvents.includes(0x8b)) throw new Error('in-game music played during the original silent demo');

const splashScreen = makeTestScreen();
const splashState = { mode: 'splash', frame: 0, menuWait: 0x100, transitionFrame: 0, lives: 5, stage: 1, demoReplay: null, paused: false };
const splashGame = new Game(splashScreen, idleInput, demoSound, splashState);
splashGame.tick();
if (splashScreen.nameTable[20 * 32 + 10] !== 0x60) throw new Error('Konami logo first rise position mismatch');
splashGame.tick();
if (splashScreen.nameTable[20 * 32 + 10] !== 0x60) throw new Error('Konami logo moved on the wrong frame');
splashGame.tick();
if (splashScreen.nameTable[19 * 32 + 10] !== 0x60) throw new Error('Konami logo two-frame rise mismatch');
for (let frame = 3; frame < 27; frame++) splashGame.tick();
if (splashState.mode !== 'splash' || splashScreen.nameTable[7 * 32 + 10] !== 0x60 || splashScreen.nameTable[10 * 32 + 10] !== 0x7a) throw new Error('Konami logo did not reach its final row');
if (splashScreen.nameTable[11 * 32 + 12] !== 0x33 || splashScreen.nameTable[11 * 32 + 19] !== 0x25 || splashScreen.nameTable[11 * 32 + 20] !== 0) throw new Error('Konami SOFTWARE text is not centered');
for (let frame = 27; frame < 281; frame++) splashGame.tick();
if (splashState.mode !== 'splash') throw new Error('Konami logo hold ended before 255 frames');
splashGame.tick();
if (splashState.mode !== 'menu') throw new Error('Konami logo did not transition to menu after the original hold');

let deathMusicPlaying = true;
const gameOverEvents = [];
const gameOverSound = {
  isPlaying() { return deathMusicPlaying; },
  playMusic(id) { gameOverEvents.push(id); },
  stopAll() { gameOverEvents.push(0x20); },
};
const gameOverState = { mode: 'dying', frame: 0, level: {}, messageTimer: 0, lives: 0, stage: 5, demoReplay: null };
const gameOverGame = new Game(null, idleInput, gameOverSound, gameOverState);
gameOverGame.draw = () => {};
gameOverGame.tick();
if (gameOverState.mode !== 'dying') throw new Error('game over started before death music ended');
deathMusicPlaying = false;
gameOverGame.tick();
if (gameOverState.mode !== 'gameover' || gameOverState.messageTimer !== 0xb8 || gameOverEvents[0] !== 0x9a) throw new Error('game over music or counter mismatch');
let gameOverFrames = 0;
while (gameOverState.mode === 'gameover' && gameOverFrames < 500) {
  gameOverGame.tick();
  gameOverFrames++;
}
if (gameOverFrames !== 367 || gameOverState.mode !== 'splash' || gameOverEvents.at(-1) !== 0x20) throw new Error(`game over return timing mismatch: ${gameOverFrames}`);

if (!pauseTextVisible(0) || !pauseTextVisible(8) || pauseTextVisible(16) || pauseTextVisible(24) || !pauseTextVisible(32)) throw new Error('PAUSING blink phase mismatch');
let f1Pressed = true;
let pausedUpdates = 0;
let muteCalls = 0;
const pauseInput = {
  pressed(code) { return code === 'F1' && f1Pressed; },
  anyPressed() { return f1Pressed; },
  actionPressed() { return false; },
  endFrame() { f1Pressed = false; },
};
const pauseState = {
  mode: 'play', frame: 0, paused: false, lives: 4,
  level: { update() { pausedUpdates++; }, dead: false, restartPending: false, complete: false },
};
const pauseGame = new Game(null, pauseInput, { setMuted() { muteCalls++; } }, pauseState);
pauseGame.draw = () => {};
pauseGame.tick();
if (!pauseState.paused || pausedUpdates !== 1) throw new Error('pause trigger frame did not finish game logic');
pauseGame.tick();
if (pausedUpdates !== 1 || muteCalls !== 0) throw new Error('paused game advanced or muted the continuing PSG');
f1Pressed = true;
pauseGame.tick();
if (pauseState.paused || pausedUpdates !== 2) throw new Error('unpause frame did not resume game logic');

const pausedMapState = { mode: 'map', frame: 7, paused: true, mapFrame: 42 };
const pausedMapGame = new Game(null, { pressed() { return false; }, endFrame() {} }, {}, pausedMapState);
pausedMapGame.draw = () => {};
pausedMapGame.tick();
if (pausedMapState.mapFrame !== 42) throw new Error('paused pyramid map advanced');

const transitionSound = { isPlaying() { return false; } };
const transitionState = { mode: 'map', mapFrame: 0xdf, mapOriginStage: 1, mapDestinationStage: 2, transitionFrame: -1 };
new Game(null, null, transitionSound, transitionState).updateMapTransition();
if (transitionState.mode !== 'curtain-to-level' || transitionState.transitionFrame !== 0) throw new Error('map 224-frame completion mismatch');
const goalState = { mode: 'map', mapFrame: 0x57, mapOriginStage: 15, mapDestinationStage: 1, mapGoalWait: 0x7f, score: 0, messageTimer: -1 };
new Game(null, null, transitionSound, goalState).updateMapTransition();
if (goalState.mode !== 'ending' || goalState.score !== 0 || goalState.endingPhase !== 'curtain' || goalState.completedRuns !== 1) throw new Error('map goal completion mismatch');

const pyramidNumberState = { stage: 1, completedRuns: 0 };
if (pyramidDisplayNumber(pyramidNumberState) !== 1) throw new Error('initial pyramid HUD number mismatch');
pyramidNumberState.completedRuns = 1;
if (pyramidDisplayNumber(pyramidNumberState) !== 16) throw new Error('completed-run pyramid HUD number mismatch');

const endingNames = endingSceneNameTable();
if (endingNames[8 * 32 + 31] !== 0x90 || endingNames[18 * 32 + 30] !== 0x66) throw new Error('ending pyramid or door layout mismatch');
if (!endingNames.slice(19 * 32, 20 * 32).every((pattern) => pattern === 0x96)) throw new Error('ending sand floor mismatch');
if ([...endingNames].filter((pattern) => pattern === 0x97).length !== 6) throw new Error('ending star count mismatch');
const endingEvents = [];
const endingSound = {
  playMusic(id) { endingEvents.push(id); },
  playEvent(id) { endingEvents.push(id); },
  setMusic(id) { endingEvents.push(id); },
};
const endingState = {
  mode: 'map', transitionFrame: 0, endingPhase: '', endingPhaseFrame: 0, endingWait: 0,
  endingTextVisible: false, endingPlayer: null, score: 12300, record: 0, lives: 4, stage: 15,
};
const endingGame = new Game(null, null, endingSound, endingState);
endingGame.startEnding();
for (let frame = 0; frame < 32; frame++) endingGame.updateEnding();
if (endingState.endingPhase !== 'initialize' || endingEvents[0] !== 0x8b) throw new Error('ending curtain or music timing mismatch');
endingGame.updateEnding();
for (let frame = 0; frame < 0x88 + 0x1b; frame++) endingGame.updateEnding();
if (endingState.endingPhase !== 'jump' || endingState.endingPlayer.x !== 117 || endingState.endingPlayer.y !== 136) throw new Error('ending recorded walk mismatch');
for (let frame = 0; frame < 24; frame++) endingGame.updateEnding();
if (endingState.endingPhase !== 'bonus' || endingState.endingPlayer.x !== 93 || endingState.endingPlayer.y !== 136) throw new Error('ending enlarged jump mismatch');
endingGame.updateEnding();
if (!endingState.endingTextVisible || endingState.score !== 22300 || endingState.lives !== 5 || endingEvents.at(-1) !== 0x8a) throw new Error('ending special bonus mismatch');
for (let frame = 0; frame < 0xd0; frame++) endingGame.updateEnding();
if (endingState.endingPhase !== 'restart-curtain' || endingState.stage !== 1 || endingState.lives !== 6 || endingEvents.at(-1) !== 0x20) throw new Error('ending restart timing mismatch');

const curtainScreen = makeTestScreen();
const curtainState = new GameState();
const curtainGame = new Game(curtainScreen, idleInput, demoSound, curtainState);
const curtainWrites = [];
curtainScreen.vramTile = (...args) => curtainWrites.push([args[2], args[3]]);
curtainGame.drawCurtain(0);
if (curtainWrites.length !== 0) throw new Error('curtain opened with a nonzero first frame');
curtainGame.drawCurtain(1);
if (curtainWrites.length !== 24 || curtainWrites.some(([x, y], index) => x !== 0 || y !== index * 8)) throw new Error('curtain did not clear its first column');
curtainGame.drawCurtain(32);
if (curtainWrites.length !== 24 + 768 || curtainWrites.some(([x, y], index) => index >= 24 && (x !== Math.floor((index - 24) / 24) * 8 || y !== ((index - 24) % 24) * 8))) throw new Error('curtain did not clear the complete screen');

const scrollSound = { setMusic() {}, playEvent() {} };
const rightScrollLevel = new Level(2, scrollSound);
rightScrollLevel.skipEntry();
Object.assign(rightScrollLevel.player, { x: 244, direction: 1 });
rightScrollLevel.cameraX = 0;
if (!rightScrollLevel.startRoomScroll()) throw new Error('right room scroll did not start at x=244');
for (let frame = 0; frame < 4; frame++) rightScrollLevel.updateRoomScroll();
if (rightScrollLevel.cameraX !== 128 || !rightScrollLevel.scrollAnimation) throw new Error('right room scroll midpoint mismatch');
for (let frame = 0; frame < 4; frame++) rightScrollLevel.updateRoomScroll();
if (rightScrollLevel.cameraX !== 256 || rightScrollLevel.player.x !== 260 || rightScrollLevel.scrollAnimation) throw new Error('right room scroll completion mismatch');
const leftScrollLevel = new Level(2, scrollSound);
leftScrollLevel.skipEntry();
Object.assign(leftScrollLevel.player, { x: 257, direction: -1 });
leftScrollLevel.cameraX = 256;
if (!leftScrollLevel.startRoomScroll()) throw new Error('left room scroll did not start at x=1');
for (let frame = 0; frame < 8; frame++) leftScrollLevel.updateRoomScroll();
if (leftScrollLevel.cameraX !== 0 || leftScrollLevel.player.x !== 240 || leftScrollLevel.scrollAnimation) throw new Error('left room scroll completion mismatch');

if (ROM_GRAPHICS.gameVram.every((value) => value === 0)) throw new Error('decoded game graphics are empty');
if (ROM_GRAPHICS.spriteVram.every((value) => value === 0)) throw new Error('decoded sprite graphics are empty');
if (tilePattern(0x86).every((value) => value === 0)) throw new Error('gem tile is empty');
if (spritePattern(0x2c).every((value) => value === 0)) throw new Error('mummy sprite is empty');
if (spritePattern(0xf0).every((value) => value === 0)) throw new Error('thrown knife sprite is empty');
const plainPlayer = [...playerSpritePattern(0, null)];
const knifePlayer = [...playerSpritePattern(0, 'knife')];
const pickaxePlayer = [...playerSpritePattern(0, 'pickaxe')];
if (plainPlayer.every((value, index) => value === knifePlayer[index])) throw new Error('knife player graphics were not loaded');
if (plainPlayer.every((value, index) => value === pickaxePlayer[index])) throw new Error('pickaxe player graphics were not loaded');
const stairEndColors = [...ROM_GRAPHICS.colorVram.subarray(0x73 * 8, 0x73 * 8 + 8)];
if (stairEndColors[0] !== 0xea || stairEndColors[1] !== 0xf9) throw new Error('normal stair-end colors are incomplete');

const psg = new KingsValleyPsg(ROM_BYTES);
psg.beginTrace();
psg.setMusic(0x97);
let startMusicTicks = 0;
while (psg.channels.some((channel) => channel.id) && startMusicTicks < 1000) {
  psg.tick();
  startMusicTicks++;
}
if (startMusicTicks !== 260) throw new Error(`start music duration mismatch: ${startMusicTicks}`);
const startMusicTrace = psg.endTrace();
const startTracePayload = startMusicTrace.map(({ writes }) => writes.flat().join(',')).join('|');
const startTraceHash = createHash('sha256').update(startTracePayload).digest('hex');
if (startTraceHash !== '97297af69db7309792e442e0811858d6a2130f8aeaf1ed23c7920e54fa2bb3b5') throw new Error(`start music register trace mismatch: ${startTraceHash}`);
if (JSON.stringify(startMusicTrace[0].writes) !== JSON.stringify([[7, 184], [8, 12], [1, 0], [0, 96], [9, 12], [3, 0], [2, 95], [7, 184], [10, 0], [5, 0], [4, 114]])) throw new Error('start music first-frame AY write order mismatch');

const ingamePsg = new KingsValleyPsg(ROM_BYTES);
ingamePsg.beginTrace();
ingamePsg.setMusic(0x8b);
for (let frame = 0; frame < 600; frame++) ingamePsg.tick();
const ingameTracePayload = ingamePsg.endTrace().map(({ writes }) => writes.flat().join(',')).join('|');
const ingameTraceHash = createHash('sha256').update(ingameTracePayload).digest('hex');
if (ingameTraceHash !== 'fdbe88e8bfd1d12797ec1769a5e0bd3b1526c2c41b36e8dc07bbf612dac136bf') throw new Error(`ingame register trace mismatch: ${ingameTraceHash}`);

const priorityPsg = new KingsValleyPsg(ROM_BYTES);
if (!priorityPsg.setMusic(0x8b) || !priorityPsg.setMusic(0x97) || priorityPsg.setMusic(0x8b)) throw new Error('three-channel music priority mismatch');
if (priorityPsg.channels.some(({ id }) => id !== 0x97)) throw new Error('high-priority music did not occupy all channels');
const sfxPriorityPsg = new KingsValleyPsg(ROM_BYTES);
if (!sfxPriorityPsg.setMusic(0x04) || sfxPriorityPsg.setMusic(0x03) || !sfxPriorityPsg.setMusic(0x09) || sfxPriorityPsg.channels[2].id !== 0x09) throw new Error('channel 3 SFX priority mismatch');
const noisePsg = new KingsValleyPsg(ROM_BYTES);
noisePsg.beginTrace();
noisePsg.setMusic(0x45);
noisePsg.tick();
const noiseFrame = noisePsg.endTrace()[0];
if (noiseFrame.registers[6] !== 0x1c || noiseFrame.registers[7] !== 0x9c || !noiseFrame.writes.some(([register, value]) => register === 6 && value === 0x1c)) throw new Error('pickaxe AY noise frame mismatch');
const zeroDurationPsg = new KingsValleyPsg(ROM_BYTES);
zeroDurationPsg.channels[2].duration = 0;
zeroDurationPsg.setRawDuration(zeroDurationPsg.channels[2], 2, 7);
if (zeroDurationPsg.channels[2].count !== 0) throw new Error('zero raw duration no longer preserves the 256-frame counter wrap');

const tileWrites = [];
const screen = {
  clear() {},
  vramTile(pattern, colors, x, y) { tileWrites.push({ pattern: [...pattern], colors: [...colors], x, y }); },
  sprite() {},
  rect() {},
  pixelText() {},
};
const level = new Level(1, { setMusic() {}, playEvent() {} });
level.skipEntry();
level.draw(screen, { score: 0, record: 0, lives: 4, frame: 0 });
const topMapWrites = tileWrites.filter(({ y }) => y === 8);
const bottomPattern = [...tilePattern(0x41)];
const bottomMapWrites = tileWrites.filter(({ pattern, y }) => y === 176 && pattern.every((value, index) => value === bottomPattern[index]));
if (topMapWrites.length !== 2) throw new Error(`stage 1 reserved map row mismatch: ${topMapWrites.length}`);
if (bottomMapWrites.length !== 32) throw new Error(`stage 1 bottom map row mismatch: ${bottomMapWrites.length}`);
const sparklePattern = [...tilePattern(0x51)];
const firstSparkle = tileWrites.find(({ pattern, x, y }) => x === 24 && y === 16 && pattern.every((value, index) => value === sparklePattern[index]));
if (!firstSparkle || firstSparkle.colors.some((value) => value !== 0x10)) throw new Error('stage 1 gem sparkle frame 0 mismatch');
tileWrites.length = 0;
level.draw(screen, { score: 0, record: 0, lives: 4, frame: 2 });
const secondSparkle = tileWrites.find(({ pattern, x, y }) => x === 24 && y === 16 && pattern.every((value, index) => value === sparklePattern[index]));
if (!secondSparkle || secondSparkle.colors.some((value) => value !== 0xf0)) throw new Error('stage 1 gem sparkle frame 1 mismatch');

const pitGem = level.gems.find(({ x, y }) => x === 16 && y === 160);
if (!pitGem) throw new Error('stage 1 pit gem is missing');
const pitColumn = Math.floor(pitGem.x / 8);
const pitRow = Math.floor(pitGem.y / 8);
if (level.data.mapIds[pitRow - 1][pitColumn] !== 0x40 || level.data.mapIds[pitRow][pitColumn - 1] !== 0x41 || level.data.mapIds[pitRow][pitColumn] !== 0x44 || level.data.mapIds[pitRow][pitColumn + 1] !== 0x42) throw new Error('stage 1 pit gem did not replace the blocking wall');
const pitPlayer = new Player({ x: 18, y: 136, direction: -1 });
let reachedPitGem = false;
for (let frame = 0; frame < 24; frame++) {
  pitPlayer.update(level.data, LEFT, false);
  const deltaX = Math.floor(pitPlayer.x) - pitGem.x;
  const deltaY = Math.floor(pitPlayer.y) - pitGem.y;
  if (deltaX >= -12 && deltaX <= 4 && deltaY >= -8 && deltaY <= 0) {
    reachedPitGem = true;
    break;
  }
}
if (!reachedPitGem) throw new Error(`player could not enter the stage 1 gem pit: ${pitPlayer.x},${pitPlayer.y}`);
const pitState = { score: 0 };
Object.assign(level.player, { x: pitPlayer.x, y: pitPlayer.y });
level.collectGems(pitState);
if (!pitGem.collected || pitState.score !== 500) throw new Error('stage 1 pit gem was not collected');
if (level.data.mapIds[pitRow - 1][pitColumn] !== 0 || level.data.mapIds[pitRow][pitColumn - 1] !== 0 || level.data.mapIds[pitRow][pitColumn] !== 0 || level.data.mapIds[pitRow][pitColumn + 1] !== 0) throw new Error('collected gem map cells were not cleared');

const rightStairPlayer = new Player({ x: 60, y: 112, direction: 1 });
rightStairPlayer.update(level.data, UP | RIGHT, false);
if (!rightStairPlayer.onLadder || rightStairPlayer.stairDirection !== 1 || rightStairPlayer.y !== 108) throw new Error('right stair upward entry mismatch');
for (let frame = 0; frame < 100 && rightStairPlayer.onLadder; frame++) rightStairPlayer.update(level.data, RIGHT, false);
if (rightStairPlayer.onLadder || rightStairPlayer.x !== 96 || rightStairPlayer.y !== 72 || !rightStairPlayer.onGround) throw new Error('right stair upward exit mismatch');
rightStairPlayer.x = 92;
rightStairPlayer.y = 72;
rightStairPlayer.update(level.data, DOWN | LEFT, false);
if (!rightStairPlayer.onLadder || rightStairPlayer.stairDirection !== 1 || rightStairPlayer.y !== 76) throw new Error('right stair downward entry mismatch');
for (let frame = 0; frame < 100 && rightStairPlayer.onLadder; frame++) rightStairPlayer.update(level.data, LEFT, false);
if (rightStairPlayer.onLadder || rightStairPlayer.x !== 56 || rightStairPlayer.y !== 112 || !rightStairPlayer.onGround) throw new Error('right stair downward exit mismatch');

const stage2DownStairPlayer = new Player({ x: 164, y: 128, direction: -1 });
stage2DownStairPlayer.update(makeStage(2), DOWN | LEFT, false);
for (let frame = 0; frame < 160 && stage2DownStairPlayer.onLadder; frame++) stage2DownStairPlayer.update(makeStage(2), LEFT, false);
if (stage2DownStairPlayer.onLadder || stage2DownStairPlayer.y !== 160 || !stage2DownStairPlayer.onGround) throw new Error('stage 2 bottom stair exit mismatch');

const leftStairPlayer = new Player({ x: 45, y: 72, direction: -1 });
leftStairPlayer.update(level.data, UP | LEFT, false);
if (!leftStairPlayer.onLadder || leftStairPlayer.stairDirection !== -1 || leftStairPlayer.y !== 69) throw new Error('left stair upward entry mismatch');
for (let frame = 0; frame < 100 && leftStairPlayer.onLadder; frame++) leftStairPlayer.update(level.data, LEFT, false);
if (leftStairPlayer.onLadder || leftStairPlayer.x !== 16 || leftStairPlayer.y !== 40 || !leftStairPlayer.onGround) throw new Error('left stair upward exit mismatch');

function runMummyStair({ x, y, type, playerY, exitY, maximumFrames }) {
  const mummyLevel = { ...level.data, enemies: [{ x, y, direction: 1, type, colorIndex: 15 }] };
  const mummyEntities = new EntitySystem(mummyLevel);
  mummyEntities.activateAll();
  const mummy = mummyEntities.enemies[0];
  const targetPlayer = { x: 200, y: playerY, invulnerable: 999 };
  let usedStairs = false;
  let frame = 0;
  for (; frame < maximumFrames; frame++) {
    mummyEntities.update(mummyLevel, targetPlayer, { playEvent() {} }, () => {});
    if (mummy.movementState === 'stairs') usedStairs = true;
    if (usedStairs && mummy.movementState === 'walking' && mummy.y === exitY) break;
  }
  return { mummy, frame, usedStairs };
}

const fastMummyStair = runMummyStair({ x: 40, y: 112, type: 2, playerY: 72, exitY: 72, maximumFrames: 200 });
if (!fastMummyStair.usedStairs || Math.floor(fastMummyStair.mummy.x) !== 96 || fastMummyStair.mummy.y !== 72 || fastMummyStair.mummy.stairDirection !== 1 || fastMummyStair.frame !== 109) throw new Error(`fast mummy stair mismatch: ${JSON.stringify(fastMummyStair)}`);
const slowMummyStair = runMummyStair({ x: 88, y: 72, type: 0, playerY: 112, exitY: 112, maximumFrames: 300 });
if (!slowMummyStair.usedStairs || Math.floor(slowMummyStair.mummy.x) !== 56 || slowMummyStair.mummy.y !== 112 || slowMummyStair.frame !== 255) throw new Error(`slow mummy stair mismatch: ${JSON.stringify(slowMummyStair)}`);

const thinkingLevel = { ...level.data, enemies: [{ x: 56, y: 112, direction: 1, type: 0, colorIndex: 15 }] };
const thinkingEntities = new EntitySystem(thinkingLevel);
thinkingEntities.activateAll();
const thinkingMummy = thinkingEntities.enemies[0];
for (let frame = 0; frame < 96; frame++) thinkingEntities.update(thinkingLevel, { x: 200, y: 112, invulnerable: 999 }, { playEvent() {} }, () => {});
if (thinkingMummy.movementState !== 'walking' || thinkingMummy.thinkTimer !== 0 || thinkingMummy.walkTimer !== 5) throw new Error('slow mummy same-tick decision transition mismatch');

for (let collision = 0; collision < 9; collision++) if (thinkingEntities.raiseEnemyStress(thinkingMummy)) throw new Error('mummy exploded before stress threshold');
if (!thinkingEntities.raiseEnemyStress(thinkingMummy) || thinkingMummy.phase !== 'exploding' || thinkingMummy.timer !== 0x22) throw new Error('mummy stress explosion mismatch');

function makeMummyGapLevel(type) {
  const width = 32;
  const height = 22;
  const tiles = Array.from({ length: height }, () => Array(width).fill(0));
  const mapIds = Array.from({ length: height }, () => Array(width).fill(0));
  for (let column = 0; column <= 4; column++) {
    tiles[10][column] = 1;
    mapIds[10][column] = 0x12;
  }
  for (let column = 8; column < width; column++) {
    tiles[10][column] = 1;
    mapIds[10][column] = 0x12;
  }
  for (let column = 0; column < width; column++) {
    tiles[15][column] = 1;
    mapIds[15][column] = 0x12;
  }
  return { width, height, tiles, mapIds, enemies: [{ x: 24, y: 64, direction: 1, type, colorIndex: 15 }] };
}

function runMummyGap(type, playerY) {
  const mummyLevel = makeMummyGapLevel(type);
  const mummyEntities = new EntitySystem(mummyLevel);
  mummyEntities.activateAll();
  const mummy = mummyEntities.enemies[0];
  mummy.walkTimer = 5;
  const states = new Set();
  for (let frame = 0; frame < 80; frame++) {
    mummyEntities.update(mummyLevel, { x: 160, y: playerY, invulnerable: 999 }, { playEvent() {} }, () => {});
    states.add(mummy.movementState);
  }
  return { mummy, states };
}

const fallingMummy = runMummyGap(0, 112);
if (!fallingMummy.states.has('falling') || fallingMummy.states.has('jumping') || fallingMummy.mummy.y !== 104) throw new Error(`dumb mummy fall mismatch: ${JSON.stringify([...fallingMummy.states])}`);
const jumpingMummy = runMummyGap(2, 32);
if (!jumpingMummy.states.has('jumping') || jumpingMummy.states.has('falling') || jumpingMummy.mummy.y !== 64 || jumpingMummy.mummy.x < 64) throw new Error(`smart mummy jump mismatch: ${JSON.stringify([...jumpingMummy.states])}`);

const jumpProfileLevel = {
  width: 32,
  height: 22,
  tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
  enemies: [{ x: 40, y: 112, direction: 1, type: 2, colorIndex: 15 }],
};
const jumpProfileEntities = new EntitySystem(jumpProfileLevel);
const jumpProfileMummy = jumpProfileEntities.enemies[0];
jumpProfileEntities.activateAll();
jumpProfileEntities.startEnemyJump(jumpProfileMummy);
const jumpY = [];
for (let frame = 0; frame < 12; frame++) {
  jumpProfileEntities.updateEnemyJump(jumpProfileMummy, jumpProfileLevel);
  jumpY.push(jumpProfileMummy.y);
}
if (JSON.stringify(jumpY) !== JSON.stringify([108, 106, 104, 102, 101, 100, 98, 98, 97, 96, 96, 96]) || !jumpProfileMummy.jumpFalling || jumpProfileMummy.jumpDirection !== 1) throw new Error(`mummy jump profile mismatch: ${JSON.stringify(jumpY)}`);

const fallProfileLevel = {
  width: 32,
  height: 22,
  tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
  enemies: [{ x: 40, y: 100, direction: 1, type: 0, colorIndex: 15 }],
};
fallProfileLevel.tiles[15].fill(1);
const fallProfileEntities = new EntitySystem(fallProfileLevel);
const fallProfileMummy = fallProfileEntities.enemies[0];
fallProfileEntities.activateAll();
fallProfileEntities.startEnemyFall(fallProfileMummy);
fallProfileEntities.updateEnemyFall(fallProfileMummy, fallProfileLevel);
if (fallProfileMummy.y !== 104 || fallProfileMummy.movementState !== 'falling') throw new Error(`mummy fall step mismatch: ${JSON.stringify(fallProfileMummy)}`);
fallProfileEntities.updateEnemyFall(fallProfileMummy, fallProfileLevel);
if (fallProfileMummy.y !== 104 || fallProfileMummy.movementState !== 'walking') throw new Error(`mummy fall landing mismatch: ${JSON.stringify(fallProfileMummy)}`);

const stairPauseLevel = {
  width: 32,
  height: 22,
  tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
  enemies: [],
};
const stairPauseEntities = new EntitySystem(stairPauseLevel);
const stairPauseMummy = { x: 40, y: 80, type: 0, moveDirection: 1, direction: 1, stairDirection: 1, movementState: 'stairs', walkCounter: 0 };
stairPauseEntities.timer = 1;
stairPauseEntities.updateEnemyStair(stairPauseMummy, stairPauseLevel);
if (stairPauseMummy.x !== 40 || stairPauseMummy.y !== 80) throw new Error('slow mummy stair pause mask mismatch');
stairPauseEntities.timer = 4;
stairPauseEntities.updateEnemyStair(stairPauseMummy, stairPauseLevel);
if (stairPauseMummy.x !== 41 || stairPauseMummy.y !== 79) throw new Error('slow mummy stair movement mask mismatch');

const routingLevel = {
  width: 64,
  height: 22,
  tiles: Array.from({ length: 22 }, () => Array(64).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(64).fill(0)),
  enemies: [],
};
const routingEntities = new EntitySystem(routingLevel);
const leftRoomMummy = { x: 0x128, direction: -1 };
routingEntities.avoidEnemySurprise(leftRoomMummy, { x: 0xf0 });
if (leftRoomMummy.direction !== 1) throw new Error('mummy left-boundary surprise guard mismatch');
const rightRoomMummy = { x: 0xb8, direction: 1 };
routingEntities.avoidEnemySurprise(rightRoomMummy, { x: 0x114 });
if (rightRoomMummy.direction !== -1) throw new Error('mummy right-boundary surprise guard mismatch');
const safeBoundaryMummy = { x: 0x128, direction: -1 };
routingEntities.avoidEnemySurprise(safeBoundaryMummy, { x: 0x78 });
if (safeBoundaryMummy.direction !== -1) throw new Error('mummy surprise guard triggered outside edge range');

routingLevel.mapIds[10][15] = 0x12;
const routingMummy = { x: 80, y: 80, direction: 1, thinkTimer: 0, stairIntent: null };
const routingPlayer = { x: 160, y: 80 };
if (!routingEntities.enemyPathBlocked(routingMummy, routingLevel, routingPlayer)) throw new Error('mummy failed to detect blocked player route');
const upIntent = { targetX: 48, verticalDirection: -1 };
const downIntent = { targetX: 112, verticalDirection: 1 };
routingEntities.findNearbyStairIntent = (_enemy, _level, verticalDirection) => verticalDirection < 0 ? upIntent : downIntent;
routingEntities.updateEnemyThinking(routingMummy, routingLevel, routingPlayer);
if (routingMummy.stairIntent !== downIntent) throw new Error('mummy blocked-route downward priority mismatch');

const upwardRoutingEntities = new EntitySystem(routingLevel);
upwardRoutingEntities.timer = 2;
upwardRoutingEntities.findNearbyStairIntent = (_enemy, _level, verticalDirection) => verticalDirection < 0 ? upIntent : null;
const upwardRoutingMummy = { x: 80, y: 80, direction: 1, thinkTimer: 0, stairIntent: null };
upwardRoutingEntities.updateEnemyThinking(upwardRoutingMummy, routingLevel, routingPlayer);
if (upwardRoutingMummy.stairIntent !== upIntent) throw new Error('mummy blocked-route random upward choice mismatch');
upwardRoutingEntities.timer = 0;
upwardRoutingMummy.thinkTimer = 0;
upwardRoutingEntities.updateEnemyThinking(upwardRoutingMummy, routingLevel, routingPlayer);
if (upwardRoutingMummy.stairIntent !== null) throw new Error('mummy blocked-route random rejection mismatch');

const digEvents = [];
const digLevel = new Level(1, { setMusic() {}, playEvent(id) { digEvents.push(id); } });
digLevel.skipEntry();
digLevel.player.item = 'pickaxe';
const digRow = Math.floor((digLevel.player.y + 16) / 8);
const digColumn = Math.floor(digLevel.player.x / 8);
if (!digLevel.canDigCell(digRow, digColumn)) throw new Error('stage 1 dig target is not solid');
digLevel.dig();
for (let frame = 0; frame < 64 && digLevel.digAnimation; frame++) digLevel.updateDig();
if (digLevel.digAnimation || digLevel.player.item !== null) throw new Error('pickaxe action did not finish');
if (digLevel.data.tiles[digRow][digColumn] !== 0 || digLevel.data.mapIds[digRow][digColumn] !== 1) throw new Error('pickaxe did not remove the target block');
if (digEvents.length !== 3 || digEvents.some((id) => id !== 0x45)) throw new Error(`pickaxe hit sequence mismatch: ${digEvents.join(',')}`);

function makeDigLevel() {
  const events = [];
  const testLevel = new Level(1, { setMusic() {}, playEvent(id) { events.push(id); } });
  testLevel.skipEntry();
  Object.assign(testLevel.data, {
    width: 32,
    height: 22,
    tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
    mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
    tilePatterns: Array.from({ length: 22 }, () => Array(32).fill(0)),
  });
  Object.assign(testLevel.player, { x: 84, y: 80, direction: 1, item: 'pickaxe', onLadder: false, jumpIndex: -1 });
  for (let column = 0; column < 32; column++) setDigCell(testLevel, 12, column);
  return { testLevel, events };
}

function setDigCell(testLevel, row, column, mapId = 0x12) {
  testLevel.data.tiles[row][column] = 1;
  testLevel.data.mapIds[row][column] = mapId;
  testLevel.data.tilePatterns[row][column] = 0x40;
}

function finishTestDig(testLevel, maximumFrames = 120) {
  let frames = 0;
  while (frames < maximumFrames && testLevel.digAnimation) {
    testLevel.updateDig();
    frames++;
  }
  return frames;
}

const { testLevel: lateralDigLevel, events: lateralDigEvents } = makeDigLevel();
for (const row of [10, 11]) {
  setDigCell(lateralDigLevel, row, 10);
  setDigCell(lateralDigLevel, row, 12);
}
lateralDigLevel.dig();
if (lateralDigLevel.digAnimation?.mode !== 'lateral' || lateralDigLevel.digAnimation?.row !== 10 || lateralDigLevel.digAnimation?.column !== 12) throw new Error('two-cell lateral dig target mismatch');
const lateralDigFrames = finishTestDig(lateralDigLevel);
if (lateralDigLevel.data.mapIds[10][12] !== 1 || lateralDigLevel.data.mapIds[11][12] !== 1 || lateralDigEvents.length !== 7) throw new Error('two-cell lateral dig sequence mismatch');
if (lateralDigFrames !== 74) throw new Error(`two-cell lateral dig timing mismatch: ${lateralDigFrames}`);

const { testLevel: lowerLateralDigLevel, events: lowerLateralDigEvents } = makeDigLevel();
for (const row of [10, 11]) setDigCell(lowerLateralDigLevel, row, 10);
setDigCell(lowerLateralDigLevel, 11, 12);
lowerLateralDigLevel.dig();
if (lowerLateralDigLevel.digAnimation?.mode !== 'lateral' || lowerLateralDigLevel.digAnimation?.row !== 11 || lowerLateralDigLevel.digAnimation?.initialHoleCounter !== 9) throw new Error('lower-only lateral dig target mismatch');
const lowerLateralDigFrames = finishTestDig(lowerLateralDigLevel);
if (lowerLateralDigLevel.data.mapIds[10][12] !== 0 || lowerLateralDigLevel.data.mapIds[11][12] !== 1 || lowerLateralDigEvents.length !== 3) throw new Error('lower-only lateral dig sequence mismatch');
if (lowerLateralDigFrames !== 26) throw new Error(`lower-only lateral dig timing mismatch: ${lowerLateralDigFrames}`);

const { testLevel: timedDigLevel, events: timedDigEvents } = makeDigLevel();
timedDigLevel.dig();
const timedDigHits = [];
for (let frame = 1; frame <= 56 && timedDigLevel.digAnimation; frame++) {
  const previousEventCount = timedDigEvents.length;
  timedDigLevel.updateDig();
  if (timedDigEvents.length > previousEventCount) timedDigHits.push(`${frame}:${timedDigLevel.digAnimation?.pattern || 0}`);
}
if (timedDigLevel.digAnimation || timedDigHits.join(',') !== '20:67,32:68,44:0') throw new Error(`floor dig timing mismatch: ${timedDigHits.join(',')}`);

const { testLevel: leftIncrustedLevel } = makeDigLevel();
Object.assign(leftIncrustedLevel.player, { x: 85, y: 80 });
setDigCell(leftIncrustedLevel, 10, 11);
leftIncrustedLevel.adjustAfterDig();
if (leftIncrustedLevel.player.x !== 88) throw new Error(`left incrust correction mismatch: ${leftIncrustedLevel.player.x}`);

const { testLevel: rightIncrustedLevel } = makeDigLevel();
Object.assign(rightIncrustedLevel.player, { x: 85, y: 80 });
setDigCell(rightIncrustedLevel, 10, 12);
rightIncrustedLevel.adjustAfterDig();
if (rightIncrustedLevel.player.x !== 84) throw new Error(`right incrust correction mismatch: ${rightIncrustedLevel.player.x}`);

const { testLevel: leftDigOffsetLevel } = makeDigLevel();
Object.assign(leftDigOffsetLevel.player, { x: 85, y: 80, direction: -1 });
leftDigOffsetLevel.dig();
if (leftDigOffsetLevel.digAnimation?.column !== 11 || leftDigOffsetLevel.player.x !== 90) throw new Error('left-facing pickaxe target or alignment mismatch');

const exitEvents = [];
const exitLevel = new Level(1, { setMusic() {}, playEvent(id) { exitEvents.push(id); } });
exitLevel.skipEntry();
const testExit = exitLevel.exitStates[0];
testExit.state = 'closed';
exitLevel.startExitOpening(testExit);
for (let frame = 0; frame < 31; frame++) exitLevel.updateExitAnimations();
if (testExit.animationStep !== 0 || exitLevel.exitPatterns(testExit)[0] !== 0x77) throw new Error('exit opened before the first 32-frame step');
exitLevel.updateExitAnimations();
if (testExit.animationStep !== 1 || exitLevel.exitPatterns(testExit)[1] !== 0x6b) throw new Error('exit closing-pattern step mismatch');
for (let frame = 0; frame < 64; frame++) exitLevel.updateExitAnimations();
if (testExit.state !== 'open' || exitLevel.exitPatterns(testExit)[1] !== 0x60) throw new Error('exit did not finish opening after 96 frames');

Object.assign(exitLevel.player, { x: testExit.x, y: testExit.y, item: 'knife' });
const exitState = { score: 0, clearedStages: new Set() };
exitLevel.startDeparture(testExit);
let departureFrames = 0;
while (!exitLevel.complete && departureFrames < 300) {
  exitLevel.updateExitAnimations();
  exitLevel.updateDeparture(exitState);
  departureFrames++;
}
if (!exitLevel.complete || departureFrames !== 240) throw new Error(`exit departure timing mismatch: ${departureFrames}`);
if (exitState.score !== 2000 || exitLevel.destinationStage !== 2 || exitLevel.playerVisible || exitLevel.player.item !== null) throw new Error('exit departure state mismatch');
if (!exitState.clearedStages.has(1)) throw new Error('cleared pyramid was not recorded');
if (exitEvents.filter((id) => id === 0x8d).length !== 2 || exitEvents.filter((id) => id === 0x8f).length !== 1) throw new Error(`exit sound sequence mismatch: ${exitEvents.join(',')}`);

const overlapLevel = new Level(1, { setMusic() {}, playEvent() {} });
overlapLevel.skipEntry();
const overlapExit = overlapLevel.exitStates[0];
Object.assign(overlapLevel.player, { x: overlapExit.x - 24, y: overlapExit.y + 4, direction: 1 });
overlapLevel.cameraX = Math.floor(overlapExit.x / 256) * 256;
overlapLevel.startDeparture(overlapExit);
const overlapScreen = makeTestScreen();
overlapLevel.draw(overlapScreen, { mode: 'play', frame: 32, score: 0, record: 0, lives: 4 });
if (overlapScreen.sprites.length !== 6) throw new Error(`exit overlap SAT count mismatch: ${overlapScreen.sprites.length}`);
for (const [slot, pattern] of [0xd8, 0xdc, 0xe0, 0xe4].entries()) {
  const expected = spritePattern(pattern);
  if ([...overlapScreen.sprites[slot].pattern].some((value, index) => value !== expected[index])) throw new Error(`exit overlap SAT slot ${slot} pattern mismatch`);
}
const overlapX = overlapExit.x + 16 - overlapLevel.cameraX;
if (overlapScreen.sprites[0].x !== overlapX || overlapScreen.sprites[0].y !== overlapExit.y - 16) throw new Error('exit overlap top-pair coordinates mismatch');
if (overlapScreen.sprites[2].x !== overlapX || overlapScreen.sprites[2].y !== overlapExit.y) throw new Error('exit overlap bottom-pair coordinates mismatch');

const { testLevel: itemBlockedDigLevel } = makeDigLevel();
itemBlockedDigLevel.data.mapIds[11][12] = 0x80;
itemBlockedDigLevel.dig();
if (itemBlockedDigLevel.digAnimation || itemBlockedDigLevel.player.item !== 'pickaxe') throw new Error('pickaxe dug below a map item');

const { testLevel: spinnerBlockedDigLevel } = makeDigLevel();
setDigCell(spinnerBlockedDigLevel, 13, 12, 0x50);
spinnerBlockedDigLevel.dig();
if (spinnerBlockedDigLevel.digAnimation || spinnerBlockedDigLevel.player.item !== 'pickaxe') throw new Error('pickaxe dug above a rotating door');

const knifeLevel = {
  width: 32,
  height: 22,
  enemies: [],
  tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
};
knifeLevel.tiles[5][10] = 1;
knifeLevel.mapIds[5][10] = 0x12;
knifeLevel.tiles[10].fill(1);
knifeLevel.mapIds[10].fill(0x12);
const knifeEntities = new EntitySystem(knifeLevel);
const knifeTestPlayer = { x: 64, y: 40, direction: 1, invulnerable: 1 };
const landedKnives = [];
const knifeStates = new Set();
knifeEntities.throwKnife(knifeTestPlayer);
for (let frame = 0; frame < 160 && knifeEntities.knives.length; frame++) {
  knifeEntities.update(knifeLevel, knifeTestPlayer, { playEvent() {} }, () => {}, (knife) => landedKnives.push(knife));
  for (const knife of knifeEntities.knives) knifeStates.add(knife.state);
}
if (!knifeStates.has('bouncing') || !knifeStates.has('falling')) throw new Error(`knife state sequence mismatch: ${[...knifeStates].join(',')}`);
if (landedKnives.length !== 1 || landedKnives[0].y !== 72) throw new Error(`knife landing mismatch: ${JSON.stringify(landedKnives)}`);
const enemyKnifeLevel = {
  width: 32,
  height: 22,
  enemies: [{ x: 84, y: 40, direction: 1, type: 2, colorIndex: 4 }],
  tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
};
enemyKnifeLevel.tiles[10].fill(1);
enemyKnifeLevel.mapIds[10].fill(0x12);
const enemyKnifeEntities = new EntitySystem(enemyKnifeLevel);
enemyKnifeEntities.activateAll();
const enemyKnifePlayer = { x: 64, y: 40, direction: 1, invulnerable: 999 };
const enemyKnifeStates = new Set();
const enemyKnifeLanded = [];
const enemyKnifeEvents = [];
let enemyKnifeScore = 0;
enemyKnifeEntities.throwKnife(enemyKnifePlayer);
for (let frame = 0; frame < 160 && enemyKnifeEntities.knives.length; frame++) {
  enemyKnifeEntities.update(enemyKnifeLevel, enemyKnifePlayer, { playEvent(id) { enemyKnifeEvents.push(id); } }, (points) => { enemyKnifeScore += points; }, (knife) => enemyKnifeLanded.push(knife));
  for (const knife of enemyKnifeEntities.knives) enemyKnifeStates.add(knife.state);
}
if (!enemyKnifeStates.has('collided') || !enemyKnifeStates.has('bouncing') || !enemyKnifeStates.has('falling')) throw new Error(`enemy-hit knife state mismatch: ${[...enemyKnifeStates].join(',')}`);
if (enemyKnifeLanded.length !== 1 || enemyKnifeLanded[0].x !== 64 || enemyKnifeLanded[0].y !== 72) throw new Error(`enemy-hit knife did not land: ${JSON.stringify(enemyKnifeLanded)}`);
if (enemyKnifeScore !== 100 || enemyKnifeEvents[0] !== 0x08) throw new Error('enemy-hit knife score or sound mismatch');
const pickupEvents = [];
const pickupLevel = new Level(1, { setMusic() {}, playEvent(id) { pickupEvents.push(id); } });
pickupLevel.skipEntry();
pickupLevel.groundKnives.length = 0;
pickupLevel.player.x = 40;
pickupLevel.player.y = 40;
const pickupBackgroundId = pickupLevel.data.mapIds[5][5];
pickupLevel.landKnife({ x: 40, y: 40 });
const pickupKnifeId = pickupBackgroundId === 0x21 || pickupBackgroundId === 0x22 ? pickupBackgroundId + 0x10 : pickupBackgroundId === 0x31 || pickupBackgroundId === 0x32 ? pickupBackgroundId : 0x30;
if (pickupLevel.data.mapIds[5][5] !== pickupKnifeId || pickupLevel.data.tiles[5][5] !== 0) throw new Error('landed knife did not occupy the map');
pickupLevel.collectItems();
if (pickupLevel.player.item !== 'knife' || pickupLevel.groundKnives[0].active) throw new Error('landed knife was not collectible');
if (pickupLevel.data.mapIds[5][5] !== pickupBackgroundId) throw new Error('landed knife background was not restored');
if (pickupEvents.at(-1) !== 0x04) throw new Error('landed knife pickup sound mismatch');

const stairKnifeLevel = new Level(1, { setMusic() {}, playEvent() {} });
stairKnifeLevel.skipEntry();
let stairKnifeCell = null;
for (let row = 0; row < stairKnifeLevel.data.height && !stairKnifeCell; row++) {
  const column = stairKnifeLevel.data.mapIds[row].findIndex((mapId) => mapId === 0x21 || mapId === 0x22);
  if (column >= 0) stairKnifeCell = { row, column, mapId: stairKnifeLevel.data.mapIds[row][column] };
}
if (!stairKnifeCell) throw new Error('stage 1 has no stair cell for knife backup test');
stairKnifeLevel.landKnife({ x: stairKnifeCell.column * 8, y: stairKnifeCell.row * 8 });
if (stairKnifeLevel.data.mapIds[stairKnifeCell.row][stairKnifeCell.column] !== stairKnifeCell.mapId + 0x10) throw new Error('knife-on-stair map ID mismatch');
Object.assign(stairKnifeLevel.player, { x: stairKnifeCell.column * 8, y: stairKnifeCell.row * 8, item: null });
stairKnifeLevel.collectItems();
if (stairKnifeLevel.data.mapIds[stairKnifeCell.row][stairKnifeCell.column] !== stairKnifeCell.mapId || stairKnifeLevel.data.tiles[stairKnifeCell.row][stairKnifeCell.column] !== 2) throw new Error('knife did not restore its stair background');

const pickMapLevel = new Level(6, { setMusic() {}, playEvent() {} });
pickMapLevel.skipEntry();
const embeddedPick = pickMapLevel.picks.find(({ x, y }) => x === 480 && y === 168);
if (!embeddedPick || pickMapLevel.data.mapIds[21][60] !== 0x80 || pickMapLevel.data.tiles[21][60] !== 0) throw new Error('pickaxe did not replace its original wall cell');
Object.assign(pickMapLevel.player, { x: embeddedPick.x, y: embeddedPick.y, item: null });
pickMapLevel.collectItems();
if (pickMapLevel.player.item !== 'pickaxe' || embeddedPick.active || pickMapLevel.data.mapIds[21][60] !== 0) throw new Error('pickaxe map pickup mismatch');

const occupiedHandsLevel = new Level(1, { setMusic() {}, playEvent() {} });
occupiedHandsLevel.skipEntry();
const occupiedKnife = occupiedHandsLevel.groundKnives[0];
Object.assign(occupiedHandsLevel.player, { x: occupiedKnife.x, y: occupiedKnife.y, item: 'pickaxe' });
occupiedHandsLevel.collectItems();
if (!occupiedKnife.active || occupiedHandsLevel.data.mapIds[occupiedKnife.y >> 3][occupiedKnife.x >> 3] !== 0x30) throw new Error('player collected a knife while already holding an item');

const itemObstacleLevel = {
  width: 32,
  height: 22,
  enemies: [],
  tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
};
itemObstacleLevel.mapIds[5][10] = 0x80;
const itemObstacleEntities = new EntitySystem(itemObstacleLevel);
itemObstacleEntities.throwKnife({ x: 64, y: 40, direction: 1 });
itemObstacleEntities.update(itemObstacleLevel, { x: 0, y: 0, invulnerable: 999 }, { playEvent() {} }, () => {});
if (itemObstacleEntities.knives[0]?.state !== 'bouncing' || itemObstacleEntities.knives[0]?.direction !== -1) throw new Error('flying knife ignored a map item obstacle');

const throwEvents = [];
const throwLevel = new Level(1, { setMusic() {}, playEvent(id) { throwEvents.push(id); } });
throwLevel.skipEntry();
throwLevel.player.item = 'knife';
throwLevel.startThrow();
for (let frame = 0; frame < 4; frame++) throwLevel.updateThrow();
if (throwLevel.entities.knives.length !== 0 || throwLevel.player.frame !== 32) throw new Error('knife was released before the preparation frames ended');
throwLevel.updateThrow();
if (throwLevel.entities.knives.length !== 1 || throwLevel.player.frame !== 36 || throwLevel.player.item !== 'knife') throw new Error('knife release frame mismatch');
for (let frame = 0; frame < 16; frame++) throwLevel.updateThrow();
if (throwLevel.throwAnimation || throwLevel.player.item !== null || throwLevel.player.frame !== 1) throw new Error('knife throw animation did not finish');
if (throwEvents.length !== 1 || throwEvents[0] !== 0x06) throw new Error(`knife throw sound mismatch: ${throwEvents.join(',')}`);

const wallThrowLevel = new Level(1, { setMusic() {}, playEvent() {} });
wallThrowLevel.skipEntry();
Object.assign(wallThrowLevel.data, {
  width: 32,
  height: 22,
  tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
  mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
});
wallThrowLevel.data.tiles[5][3] = 1;
wallThrowLevel.data.mapIds[5][3] = 0x12;
Object.assign(wallThrowLevel.player, { x: 12, y: 40, direction: 1, item: 'knife' });
if (!wallThrowLevel.startThrow() || !wallThrowLevel.throwAnimation.directBounce) throw new Error('wall-adjacent knife did not select direct bounce');
for (let frame = 0; frame < 5; frame++) wallThrowLevel.updateThrow();
if (wallThrowLevel.entities.knives[0]?.state !== 'bouncing' || wallThrowLevel.entities.knives[0]?.x !== 16 || wallThrowLevel.entities.knives[0]?.y !== 32) throw new Error('wall-adjacent knife bounce origin mismatch');
const fullKnifeLevel = new Level(1, { setMusic() {}, playEvent() {} });
fullKnifeLevel.skipEntry();
fullKnifeLevel.player.item = 'knife';
for (let index = 0; index < 4; index++) fullKnifeLevel.entities.throwKnife(fullKnifeLevel.player);
if (fullKnifeLevel.startThrow()) throw new Error('fifth active knife was allowed');

const spaceInput = new Input();
spaceInput.pressedKeys.add('Space');
if (!spaceInput.actionPressed()) throw new Error('space did not trigger the unified action');
const zInput = new Input();
zInput.pressedKeys.add('KeyZ');
if (zInput.actionPressed() || zInput.controls() !== 0) throw new Error('Z is still bound to an original-game action');
const actionInput = { controls() { return 0; }, actionPressed() { return true; } };
const spaceKnifeLevel = new Level(1, { setMusic() {}, playEvent() {} });
spaceKnifeLevel.skipEntry();
spaceKnifeLevel.player.item = 'knife';
spaceKnifeLevel.update(actionInput, { score: 0, lives: 4 });
if (!spaceKnifeLevel.throwAnimation || spaceKnifeLevel.player.jumpIndex >= 0) throw new Error('space did not select knife throw while holding a knife');
const spaceJumpLevel = new Level(1, { setMusic() {}, playEvent() {} });
spaceJumpLevel.skipEntry();
Object.assign(spaceJumpLevel.player, { x: 60, y: 112, item: null, jumpIndex: -1, onLadder: false });
spaceJumpLevel.update(actionInput, { score: 0, lives: 4 });
if (spaceJumpLevel.player.jumpIndex !== 0 || spaceJumpLevel.throwAnimation) throw new Error('space did not select jump without a held item');

function makeCollisionLevel() {
  return {
    width: 32,
    height: 22,
    tiles: Array.from({ length: 22 }, () => Array(32).fill(0)),
    mapIds: Array.from({ length: 22 }, () => Array(32).fill(0)),
  };
}

const walkCollisionLevel = makeCollisionLevel();
walkCollisionLevel.tiles[7].fill(1);
walkCollisionLevel.mapIds[7].fill(0x12);
walkCollisionLevel.tiles[5][2] = 1;
walkCollisionLevel.mapIds[5][2] = 0x12;
const walkCollisionPlayer = new Player({ x: 4, y: 40, direction: 1 });
walkCollisionPlayer.update(walkCollisionLevel, RIGHT, false);
if (walkCollisionPlayer.x !== 4 || walkCollisionPlayer.blockedAt?.y !== 40) throw new Error('fixed-point walking collision phase mismatch');
walkCollisionPlayer.update(walkCollisionLevel, RIGHT, false);
if (walkCollisionPlayer.x !== 4 || walkCollisionPlayer.blockedAt?.y !== 40) throw new Error('upper-body walking collision mismatch');

const fallingCorrectionLevel = makeCollisionLevel();
const fallingCorrectionPlayer = new Player({ x: 9, y: 40, direction: 1 });
fallingCorrectionPlayer.update(fallingCorrectionLevel, 0, false);
fallingCorrectionPlayer.update(fallingCorrectionLevel, 0, false);
if (fallingCorrectionPlayer.x !== 12 || fallingCorrectionPlayer.y !== 44 || !fallingCorrectionPlayer.falling) throw new Error('platform-edge falling correction mismatch');

const roofCollisionLevel = makeCollisionLevel();
roofCollisionLevel.tiles[7].fill(1);
roofCollisionLevel.mapIds[7].fill(0x12);
roofCollisionLevel.tiles[4][1] = 1;
roofCollisionLevel.mapIds[4][1] = 0x12;
const roofCollisionPlayer = new Player({ x: 4, y: 40, direction: 1 });
roofCollisionPlayer.update(roofCollisionLevel, 0, true);
if (roofCollisionPlayer.jumpIndex >= 0 || roofCollisionPlayer.y !== 40) throw new Error('player jumped through a low ceiling');

const jumpWallLevel = makeCollisionLevel();
jumpWallLevel.tiles[5][2] = 1;
jumpWallLevel.mapIds[5][2] = 0x12;
const jumpWallPlayer = new Player({ x: 3, y: 40, direction: 1 });
Object.assign(jumpWallPlayer, { jumpIndex: 0, jumpFalling: false, jumpDirection: 1, frame: 8 });
jumpWallPlayer.update(jumpWallLevel, RIGHT, false);
if (jumpWallPlayer.x !== 4 || jumpWallPlayer.jumpIndex !== -1 || jumpWallPlayer.y !== 32) throw new Error('horizontal jump crossed a wall');
const topJumpPlayer = new Player({ x: 4, y: 0, direction: 1 });
const topJumpLevel = makeCollisionLevel();
topJumpPlayer.onGround = true;
topJumpPlayer.update(topJumpLevel, 0, true);
if (topJumpPlayer.jumpIndex >= 0) throw new Error('player jumped from the top screen edge');

const idleLevelInput = { controls() { return 0; }, actionPressed() { return false; } };
for (let stageNumber = 1; stageNumber <= 15; stageNumber++) {
  const level = new Level(stageNumber, { setMusic() {}, playEvent() {} });
  level.skipEntry();
  level.player.invulnerable = 100000;
  const state = { score: 0, lives: 4 };
  for (let frame = 0; frame < 300; frame++) level.update(idleLevelInput, state);
  if (!Number.isFinite(level.player.x) || !Number.isFinite(level.player.y)) throw new Error(`stage ${stageNumber} player coordinates became invalid`);
  if (level.player.x < 0 || level.player.x > level.data.width * 8 - 12 || level.player.y < 0 || level.player.y > 176) throw new Error(`stage ${stageNumber} player escaped collision bounds`);
  if (level.dead || level.restartPending) throw new Error(`stage ${stageNumber} idle smoke unexpectedly killed the player`);
}

const knifeFlightPhases = [
  { x: 0, pattern: 0x45, tileCount: 1, tileX: 0 },
  { x: 2, pattern: 0x45, tileCount: 1, tileX: 0 },
  { x: 4, pattern: 0x46, tileCount: 2, tileX: 0 },
  { x: 6, pattern: 0x46, tileCount: 2, tileX: 0 },
  { x: 8, pattern: 0x48, tileCount: 1, tileX: 8 },
  { x: 10, pattern: 0x48, tileCount: 1, tileX: 8 },
  { x: 12, pattern: 0x49, tileCount: 2, tileX: 8 },
  { x: 14, pattern: 0x49, tileCount: 2, tileX: 8 },
];
for (const expected of knifeFlightPhases) {
  const actual = knifeFlightFrame(expected.x);
  if (actual.pattern !== expected.pattern || actual.tileCount !== expected.tileCount || actual.x !== expected.tileX) throw new Error(`knife flight phase mismatch at ${expected.x}: ${JSON.stringify(actual)}`);
}

const spinnerEvents = [];
const spinnerLevel = new Level(4, { setMusic() {}, playEvent(id) { spinnerEvents.push(id); } });
spinnerLevel.skipEntry();
const spinner = spinnerLevel.spinners[0];
spinnerLevel.player.x = 20;
spinnerLevel.player.y = 32;
spinnerLevel.player.direction = 1;
for (let frame = 0; frame < 20; frame++) {
  spinnerLevel.player.blockedAt = { x: 32, y: 40, mapId: 0x51 };
  spinnerLevel.updateSpinnerPush();
}
if (spinnerLevel.spinPassAnimation || spinner.spinning) throw new Error('spinner accepted its blocked side');
for (let frame = 0; frame < 16; frame++) {
  spinnerLevel.player.blockedAt = { x: 32, y: 40, mapId: 0x50 };
  spinnerLevel.updateSpinnerPush();
}
if (spinnerLevel.spinPassAnimation?.timer !== 0x20 || !spinner.spinning || spinnerEvents.at(-1) !== 0x03) throw new Error('spinner push threshold mismatch');
for (let frame = 1; frame <= 64; frame++) {
  spinnerLevel.timer = frame;
  if (spinnerLevel.spinPassAnimation) spinnerLevel.updateSpinnerPass();
}
if (spinnerLevel.spinPassAnimation || spinnerLevel.player.x !== 41) throw new Error(`spinner passage mismatch: ${spinnerLevel.player.x}`);
const spinnerFrames = [];
for (let frame = 1; frame <= 48; frame++) {
  spinnerLevel.timer = frame;
  spinnerLevel.updateSpinners();
  if ((frame & 7) === 0 && frame <= 40) spinnerFrames.push(spinner.frame);
}
if (spinnerFrames.join(',') !== '0,1,2,3,4' || spinner.spinning || spinner.direction !== 4) throw new Error(`spinner animation mismatch: ${spinnerFrames.join(',')}`);
const spinnerColumn = Math.floor(spinner.x / 8);
const spinnerFirstRow = Math.floor(spinner.y / 8);
for (let row = spinnerFirstRow; row < spinnerFirstRow + spinner.rows; row++) {
  if (spinnerLevel.data.mapIds[row][spinnerColumn] !== 0x52 || spinnerLevel.data.mapIds[row][spinnerColumn + 1] !== 0x53) throw new Error(`spinner final map mismatch at ${spinnerColumn},${row}`);
}
const clearedSpinnerLevel = new Level(4, { setMusic() {}, playEvent() {} });
clearedSpinnerLevel.skipEntry();
const clearedSpinner = clearedSpinnerLevel.spinners[0];
for (const gem of clearedSpinnerLevel.gems) gem.collected = true;
clearedSpinnerLevel.gemsComplete = false;
const clearedSpinnerState = { demoReplay: false, score: 0, lives: 4 };
clearedSpinnerLevel.update({ controls() { return 0; }, actionPressed() { return false; } }, clearedSpinnerState);
const clearedSpinnerColumn = Math.floor(clearedSpinner.x / 8);
const clearedSpinnerRow = Math.floor(clearedSpinner.y / 8);
if (!clearedSpinner.removed || clearedSpinnerLevel.data.mapIds[clearedSpinnerRow][clearedSpinnerColumn] !== 0 || clearedSpinnerLevel.data.mapIds[clearedSpinnerRow][clearedSpinnerColumn + 1] !== 1 || clearedSpinnerLevel.data.tiles[clearedSpinnerRow][clearedSpinnerColumn] !== 0) throw new Error('last-gem spinner removal mismatch');

const trapLevel = new Level(5, { setMusic() {}, playEvent() {} });
trapLevel.skipEntry();
const trap = trapLevel.traps[0];
const trapColumn = Math.floor(trap.x / 8);
const trapTriggerRow = Math.floor(trap.y / 8);
if (trapLevel.data.mapIds[trapTriggerRow][trapColumn] !== 0) throw new Error('trap trigger was incorrectly placed as a static wall');
Object.assign(trapLevel.player, { x: trap.triggerX, y: trap.triggerY, onGround: true });
trapLevel.updateTraps();
if (trap.status !== 'falling' || trap.y !== 144) throw new Error(`trap ceiling search mismatch: ${JSON.stringify(trap)}`);
trapLevel.timer = 32;
trapLevel.updateTraps();
if (trap.y !== 148 || trapLevel.data.mapIds[18][trapColumn] !== 0x19) throw new Error('trap full-brick phase mismatch');
trapLevel.groundKnives.push({ x: trap.x, y: 152, active: true });
trapLevel.timer = 64;
trapLevel.updateTraps();
if (trap.y !== 148 || trapLevel.data.mapIds[19][trapColumn] !== 0) throw new Error('trap did not wait for a blocking object');
trapLevel.groundKnives.at(-1).active = false;
trapLevel.player.x = 80;
const trapSteps = [
  [96, 152, 0x1a],
  [128, 156, 0x19],
  [160, 160, 0x1a],
  [192, 164, 0x19],
  [224, 168, 0x1a],
  [256, 172, 0x19],
];
for (const [timer, y, mapId] of trapSteps) {
  trapLevel.timer = timer;
  if (trapLevel.updateTraps() || trap.y !== y || trapLevel.data.mapIds[Math.floor(y / 8)][trapColumn] !== mapId) throw new Error(`trap descent mismatch at timer ${timer}`);
}
trapLevel.timer = 288;
trapLevel.updateTraps();
if (trap.status !== 'closed' || trap.y !== 176) throw new Error(`trap lower-limit mismatch: ${JSON.stringify(trap)}`);

const crushLevel = new Level(5, { setMusic() {}, playEvent() {} });
crushLevel.skipEntry();
const crushTrap = crushLevel.traps[0];
Object.assign(crushLevel.player, { x: crushTrap.triggerX, y: crushTrap.triggerY, onGround: true });
crushLevel.updateTraps();
let crushed = false;
for (const timer of [32, 64, 96, 128]) {
  crushLevel.timer = timer;
  crushed = crushLevel.updateTraps();
}
if (!crushed || crushTrap.y !== 160) throw new Error('trap crush timing mismatch');

const frameHashes = {
  menu: renderFrameHash(({ state, game }) => {
    state.mode = 'menu';
    game.menuProgress = 22;
  }),
  stage1: renderFrameHash(({ state, game }) => {
    state.stage = 1;
    game.startLevel();
    state.level.skipEntry();
    state.frame = 32;
  }),
  map: renderFrameHash(({ state }) => {
    Object.assign(state, { mode: 'map', mapOriginStage: 1, mapDestinationStage: 2, mapExitDirection: 8, mapEntranceDirection: 4, mapFrame: 0x40, frame: 0x40 });
  }),
  ending: renderFrameHash(({ state, game }) => {
    state.score = 12300;
    state.record = 12300;
    game.startEnding();
    for (let frame = 0; frame < 220; frame++) game.updateEnding();
  }),
  gameover: renderFrameHash(({ state, game }) => {
    state.stage = 5;
    game.startLevel();
    state.level.skipEntry();
    state.lives = 0;
    state.mode = 'gameover';
    state.frame = 32;
    state.messageTimer = 0xb8;
  }),
};
const expectedFrameHashes = {
  menu: '16eb9febf76875bc886853b08fc9e02a9fe53efc0bdc7028780d22cb3728fa4f',
  stage1: 'd2e484f252c3c7d19c9960e19d6ad6268eab8c6e49603c6943343e3c55953276',
  map: 'abc905da8ca6bc281eef90792ab03befdd20931c17042bafa2e5233cb6d8e52c',
  ending: 'f75daa3eca42f9e22751dd1744491fc487c36130d6432a27f8cc849e426ae4f2',
  gameover: 'e6fe51a4c707a61cacb506b1b4d80ab9ea27a24e9676df766a88b14ab4dafeed',
};
const frameHashMismatches = Object.entries(expectedFrameHashes).filter(([mode, expected]) => frameHashes[mode] !== expected);
if (frameHashMismatches.length) throw new Error(`framebuffer hash mismatch: ${JSON.stringify(frameHashes)}`);

const menuMirrorScreen = makeTestScreen();
const menuMirrorState = new GameState();
const mirrorInput = { pressed() { return false; }, anyPressed() { return false; }, actionPressed() { return false; }, endFrame() {} };
const mirrorSound = { setMusic() {}, playMusic() {}, playEvent() {}, stopAll() {}, setMuted() {}, isPlaying() { return false; } };
const menuMirrorGame = new Game(menuMirrorScreen, mirrorInput, mirrorSound, menuMirrorState);
menuMirrorState.mode = 'menu';
menuMirrorGame.menuProgress = 22;
menuMirrorGame.draw();
if (menuMirrorScreen.nameTable[5 * 32 + 7] !== 0x9b || menuMirrorScreen.nameTable[6 * 32 + 7] !== 0x9c) throw new Error('menu name-table pattern IDs mismatch');

const startMirrorScreen = makeTestScreen();
const startMirrorState = new GameState();
const startMirrorGame = new Game(startMirrorScreen, mirrorInput, mirrorSound, startMirrorState);
Object.assign(startMirrorState, { mode: 'starting', messageTimer: 0 });
startMirrorGame.menuProgress = 22;
startMirrorGame.draw();
if (startMirrorScreen.nameTable[18 * 32 + 11] !== 0x30 || startMirrorScreen.nameTable[18 * 32 + 18] !== 0x21) throw new Error('PLAY START name-table writes mismatch');
startMirrorState.messageTimer = 1;
startMirrorGame.draw();
if (startMirrorScreen.nameTable[18 * 32 + 11] !== 0 || startMirrorScreen.nameTable[18 * 32 + 18] !== 0) throw new Error('PLAY START blink clear mismatch');
startMirrorState.messageTimer = 5;
startMirrorGame.draw();
if (startMirrorScreen.nameTable[18 * 32 + 11] !== 0x30 || startMirrorScreen.nameTable[18 * 32 + 18] !== 0x21) throw new Error('PLAY START blink phase mismatch');
startMirrorState.mode = 'menu';
startMirrorState.stage = 1;
startMirrorState.lives = 5;
startMirrorGame.requestStart();
for (let frame = 0; frame < 80; frame++) startMirrorGame.tick();
if (startMirrorState.mode !== 'curtain-to-first-level' || startMirrorState.messageTimer !== 80) throw new Error('PLAY START wait timing mismatch');
for (let frame = 0; frame < 32; frame++) startMirrorGame.tick();
if (startMirrorState.mode !== 'play' || !startMirrorState.level) throw new Error('first-level curtain transition mismatch');

const mapMirrorScreen = makeTestScreen();
const mapMirrorState = new GameState();
Object.assign(mapMirrorState, { mode: 'map', mapOriginStage: 1, mapDestinationStage: 2, mapExitDirection: 8, mapEntranceDirection: 4, mapFrame: 0x40, frame: 0x40 });
new Game(mapMirrorScreen, mirrorInput, mirrorSound, mapMirrorState).draw();
const expectedMapNames = mapNameTable();
if ([...mapMirrorScreen.nameTable].some((pattern, index) => index >= 32 && pattern !== expectedMapNames[index])) throw new Error('pyramid map name-table mirror mismatch');
if (mapMirrorScreen.nameTable[1] !== 0x33 || mapMirrorScreen.nameTable[8] !== 0x10) throw new Error('pyramid map HUD mirror mismatch');
if (mapMirrorScreen.pixels[7 * 256 + 9 * 8] === 0) throw new Error('pyramid map paper fill mismatch');

const gameOverMirrorScreen = makeTestScreen();
const gameOverMirrorState = new GameState();
const gameOverMirrorGame = new Game(gameOverMirrorScreen, mirrorInput, mirrorSound, gameOverMirrorState);
gameOverMirrorState.stage = 5;
gameOverMirrorGame.startLevel();
gameOverMirrorState.level.skipEntry();
gameOverMirrorState.mode = 'gameover';
gameOverMirrorState.lives = 0;
gameOverMirrorGame.draw();
if (gameOverMirrorScreen.nameTable[9 * 32 + 9] !== 0 || gameOverMirrorScreen.nameTable[11 * 32 + 11] !== 0x27) throw new Error('GAME OVER name-table writes mismatch');

const fallingPsg = new KingsValleyPsg(ROM_BYTES);
fallingPsg.setMusic(1);
const fallingPeriods = [];
for (let frame = 0; frame < 24; frame++) {
  fallingPsg.tick();
  fallingPeriods.push(fallingPsg.regs[4] | ((fallingPsg.regs[5] & 0x0f) << 8));
}
if (fallingPeriods[0] !== 0x061 || fallingPeriods[19] !== 0x0f9 || fallingPeriods[20] !== 0x101) throw new Error(`falling PSG ramp mismatch: ${fallingPeriods.slice(0, 21).join(',')}`);
if (fallingPsg.regs[7] !== 0xb8 || fallingPsg.regs[10] !== 0x0b || fallingPsg.channels[2].id !== 1) throw new Error(`falling PSG stream mismatch: ${JSON.stringify(fallingPsg.snapshot())}`);

const rawEffectIds = [3, 4, 5, 6, 7, 8, 9, 10];
const rawEffectChecks = rawEffectIds.map(id => {
  const psg = new KingsValleyPsg(ROM_BYTES);
  psg.setMusic(id);
  psg.tick();
  return { id, mixer: psg.regs[7], active: psg.channels[2].id !== 0, volume: psg.regs[10] };
});
if (rawEffectChecks.some(({ active }) => !active)) throw new Error(`raw PSG effect stream mismatch: ${JSON.stringify(rawEffectChecks)}`);
const noiseEffectPsg = new KingsValleyPsg(ROM_BYTES);
noiseEffectPsg.setMusic(0x45);
noiseEffectPsg.tick();
if (noiseEffectPsg.regs[7] !== 0x9c || noiseEffectPsg.regs[6] !== 0x1c) throw new Error(`noise PSG effect mismatch: ${JSON.stringify(noiseEffectPsg.snapshot())}`);

const audioHashes = {
  start: renderAudioHash(0x97, 260),
  ingame: renderAudioHash(0x8b, 600),
  pickaxe: renderAudioHash(0x45, 90),
};
const expectedAudioHashes = {
  start: 'c1a4010944c46cdeb6bc77484b642e13d9a1a79a718261c04f06147219b0067a',
  ingame: '8bf2517869f97ace4bbaa208035f12cc90c5c6cfd309a2b81c9380aa09521997',
  pickaxe: '2c35411fa481e7cea452260f8bd6773a339001116d9fffe87e04fc431dd6ae60',
};
const audioHashMismatches = Object.entries(expectedAudioHashes).filter(([soundName, expected]) => audioHashes[soundName] !== expected);
if (audioHashMismatches.length) throw new Error(`PCM/WAV hash mismatch: ${JSON.stringify(audioHashes)}`);

console.log(JSON.stringify({ romSha256: actualHash, graphics: graphicNames.length, startMusicTicks, frameHashes, audioHashes, fallingPeriods: fallingPeriods.slice(0, 21), rawEffectChecks, stages }, null, 2));

function renderFrameHash(setup) {
  const screen = makeTestScreen();
  const input = { pressed() { return false; }, anyPressed() { return false; }, actionPressed() { return false; }, endFrame() {} };
  const sound = { setMusic() {}, playMusic() {}, playEvent() {}, stopAll() {}, setMuted() {}, isPlaying() { return false; } };
  const state = new GameState();
  const game = new Game(screen, input, sound, state);
  setup({ screen, state, game });
  game.draw();
  screen.present();
  return createHash('sha256').update(Buffer.from(screen.pixels.buffer)).digest('hex');
}

function makeTestScreen() {
  const context = {
    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() {},
  };
  return new Screen({ getContext() { return context; } });
}

function renderAudioHash(id, frames) {
  const psg = new KingsValleyPsg(ROM_BYTES);
  const renderer = new AyPcmRenderer();
  const chunks = [];
  let sampleCount = 0;
  psg.setMusic(id);
  for (let frame = 0; frame < frames; frame++) {
    psg.tick();
    const chunk = renderer.renderFrame(psg.regs);
    chunks.push(chunk);
    sampleCount += chunk.length;
  }
  const samples = new Int16Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return createHash('sha256').update(encodeMonoWav(samples, renderer.sampleRate)).digest('hex');
}
