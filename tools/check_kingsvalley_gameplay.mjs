#!/usr/bin/env node

import { debugStageFromInput, Game } from '../web/src/game/flow.js';
import { Level } from '../web/src/game/level.js';
import { GameState } from '../web/src/game/state.js';
import { ACTION, DOWN, LEFT, RIGHT, UP, Input } from '../web/src/input.js';

const input = {
  pressed() { return false; },
  anyPressed() { return false; },
  actionPressed() { return false; },
  controls() { return 0; },
  endFrame() {},
};

const soundEvents = [];
const sound = {
  setMusic(id) { soundEvents.push(id & 0xff); },
  playMusic(id) { soundEvents.push(id & 0xff); },
  playEvent(id) { soundEvents.push(id & 0xff); },
  stopAll() {},
  setMuted() {},
  isPlaying() { return false; },
};

const state = new GameState();
const game = new Game(null, input, sound, state);
game.draw = () => {};

const debugPressedKeys = new Set(['Backquote']);
const debugHeldKeys = new Set();
const debugInput = {
  pressed(code) { return debugPressedKeys.has(code); },
  heldKey(code) { return debugHeldKeys.has(code); },
  anyPressed() { return debugPressedKeys.size > 0; },
  actionPressed() { return debugPressedKeys.has('Space'); },
  controls() { return 0; },
  endFrame() { debugPressedKeys.clear(); },
};
const debugState = new GameState();
const debugGame = new Game(null, debugInput, sound, debugState);
debugGame.draw = () => {};
debugGame.tick();
if (!debugGame.debugMode || !debugState.debugMode) throw new Error('backquote did not enable debug mode');
debugPressedKeys.add('Digit5');
debugGame.tick();
if (debugState.mode !== 'play' || debugState.stage !== 5 || debugState.level.entryPhase !== 'active' || debugState.lives !== 5) throw new Error('debug stage 5 did not start directly');
debugHeldKeys.add('ShiftLeft');
debugPressedKeys.add('Digit1');
debugGame.tick();
if (debugState.stage !== 11) throw new Error('shifted debug stage 11 selection failed');
debugHeldKeys.clear();
debugPressedKeys.add('Backquote');
debugGame.tick();
if (debugGame.debugMode || debugState.debugMode) throw new Error('backquote did not disable debug mode');
const pressedDebugKey = (code, held = []) => ({
  pressed(value) { return value === code; },
  heldKey(value) { return held.includes(value); },
});
if (debugStageFromInput(pressedDebugKey('Digit0')) !== 10 || debugStageFromInput(pressedDebugKey('Digit5', ['ShiftLeft'])) !== 15) throw new Error('debug number key mapping mismatch');

const firstCycleLevel = new Level(1, sound);
const secondCycleLevel = new Level(1, sound, { mummyCycle: 1 });
const fifthCycleLevel = new Level(1, sound, { mummyCycle: 5 });
for (let index = 0; index < firstCycleLevel.entities.enemies.length; index++) {
  const baseType = firstCycleLevel.entities.enemies[index].type ?? 0;
  const expectedType = Math.min(4, baseType + 1);
  if (secondCycleLevel.entities.enemies[index].type !== expectedType) throw new Error('second-cycle mummy type did not increase');
  if (fifthCycleLevel.entities.enemies[index].type !== 4) throw new Error('mummy type did not clamp at the intelligent type');
}

const transitionLog = [];
for (let stageNumber = 1; stageNumber <= 15; stageNumber++) {
  if (stageNumber === 1) {
    state.stage = 1;
    state.lives = 5;
    game.startLevel();
  } else {
    if (state.mode !== 'play' || state.stage !== stageNumber) throw new Error(`stage ${stageNumber} did not start: ${state.mode}/${state.stage}`);
  }
  const level = state.level;
  level.skipEntry();
  for (const enemy of level.entities.enemies) enemy.alive = false;
  level.player.invulnerable = 10000;
  const inputPattern = [RIGHT, RIGHT, LEFT, UP, DOWN, LEFT, RIGHT, UP];
  for (let frame = 0; frame < 96; frame++) {
    const controls = inputPattern[frame % inputPattern.length];
    const actionPressed = frame % 24 === 0;
    level.update({ controls: () => controls, actionPressed: () => actionPressed }, state);
    if (![level.player.x, level.player.y, level.player.xFraction].every(Number.isFinite)) throw new Error(`stage ${stageNumber} input path produced invalid player coordinates`);
  }
  const destination = stageNumber === 15 ? 1 : stageNumber + 1;
  const exit = level.exitStates.find((candidate) => candidate.target === destination);
  if (!exit) throw new Error(`stage ${stageNumber} has no exit to ${destination}`);

  for (const gem of level.gems) {
    gem.collected = true;
    level.clearGemMap(gem);
  }
  level.gemsComplete = true;
  exit.state = 'open';
  Object.assign(level.player, {
    x: exit.x - 24,
    y: exit.y + 4,
    direction: 1,
    item: null,
    invulnerable: 10000,
  });
  level.startDeparture(exit);

  let ticks = 0;
  while (state.mode === 'play' && !level.complete && ticks++ < 500) game.tick();
  if (!level.complete || state.mode !== 'curtain-to-map') throw new Error(`stage ${stageNumber} departure did not complete: ${state.mode}/${ticks}`);
  if (!state.clearedStages.has(stageNumber)) throw new Error(`stage ${stageNumber} was not recorded as cleared`);
  transitionLog.push({ stage: stageNumber, departureTicks: ticks, score: state.score });

  for (let frame = 0; frame < 32; frame++) game.tick();
  if (state.mode !== 'map') throw new Error(`stage ${stageNumber} did not enter pyramid map`);

  if (stageNumber < 15) {
    for (let frame = 0; frame < 224; frame++) game.tick();
    if (state.mode !== 'curtain-to-level') throw new Error(`stage ${stageNumber} map did not open next curtain: ${state.mode}`);
    for (let frame = 0; frame < 32; frame++) game.tick();
    if (state.mode !== 'play' || state.stage !== destination) throw new Error(`stage ${destination} did not start after map: ${state.mode}/${state.stage}`);
  } else {
    let endingTicks = 0;
    while (state.mode !== 'ending' && endingTicks++ < 300) game.tick();
    if (state.mode !== 'ending') throw new Error(`stage 15 did not reach ending: ${state.mode}`);
    for (let frame = 0; frame < 33; frame++) game.tick();
    if (state.endingPhase !== 'walk' || !state.endingPlayer) throw new Error('ending did not initialize after final pyramid');
  }
}

const noActionInput = {
  controls() { return 0; },
  actionPressed() { return false; },
};
const oneShotActionInput = {
  used: false,
  controls() { return 0; },
  actionPressed() {
    if (this.used) return false;
    this.used = true;
    return true;
  },
};
const itemState = { score: 0, lives: 4 };
const itemLevel = new Level(1, sound);
itemLevel.skipEntry();
for (const enemy of itemLevel.entities.enemies) enemy.alive = false;
itemLevel.player.invulnerable = 10000;
itemLevel.player.x = 45;
itemLevel.player.y = 40;
itemLevel.landKnife({ x: 40, y: 40 });
itemLevel.update(noActionInput, itemState);
if (itemLevel.player.item !== 'knife' || itemLevel.groundKnives.at(-1).active) throw new Error('game-loop knife pickup failed');

itemLevel.update(oneShotActionInput, itemState);
for (let frame = 0; frame < 24; frame++) itemLevel.update(noActionInput, itemState);
if (itemLevel.throwAnimation || itemLevel.player.item !== null || itemLevel.entities.knives.length !== 1) throw new Error('game-loop knife throw lifecycle failed');

const digLevel = new Level(1, sound);
digLevel.skipEntry();
for (const enemy of digLevel.entities.enemies) enemy.alive = false;
oneShotActionInput.used = false;
Object.assign(digLevel.player, { x: 228, y: 144, direction: 1, item: 'pickaxe', onGround: true, invulnerable: 10000 });
const digRow = Math.floor((digLevel.player.y + 16) / 8);
const digColumn = Math.floor((digLevel.player.x + 16) / 8);
if (!digLevel.canDigCell(digRow, digColumn)) throw new Error('game-loop dig fixture is not solid');
digLevel.update(oneShotActionInput, itemState);
const digTarget = { row: digLevel.digAnimation?.row, column: digLevel.digAnimation?.column };
for (let frame = 0; frame < 64 && digLevel.digAnimation; frame++) digLevel.update(noActionInput, itemState);
if (digLevel.digAnimation || digLevel.player.item !== null || digLevel.data.tiles[digTarget.row][digTarget.column] !== 0 || digLevel.data.mapIds[digTarget.row][digTarget.column] !== 1) throw new Error('game-loop pickaxe lifecycle failed');

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  dispatch(type, code) { this.listeners.get(type)?.({ code, preventDefault() {} }); }
}

const eventTarget = new FakeEventTarget();
const browserInput = new Input();
browserInput.attach(eventTarget);
eventTarget.dispatch('keydown', 'Space');
if (!browserInput.actionPressed() || browserInput.controls() !== ACTION) throw new Error('browser space input was not latched');
browserInput.endFrame();
if (browserInput.actionPressed()) throw new Error('browser space edge was not consumed');
eventTarget.dispatch('keydown', 'KeyZ');
if (browserInput.controls() !== ACTION) throw new Error('unsupported Z input changed controls');
eventTarget.dispatch('keyup', 'Space');
eventTarget.dispatch('keyup', 'KeyZ');
eventTarget.dispatch('keydown', 'ArrowRight');
if (browserInput.controls() === 0) throw new Error('browser directional input was not latched');
eventTarget.dispatch('keyup', 'ArrowRight');
eventTarget.dispatch('keydown', 'Backquote');
if (!browserInput.pressed('Backquote')) throw new Error('backquote debug input was not latched');
browserInput.endFrame();
eventTarget.dispatch('keyup', 'Backquote');
eventTarget.dispatch('keydown', 'ShiftLeft');
eventTarget.dispatch('keydown', 'Digit5');
if (!browserInput.pressed('Digit5') || !browserInput.heldKey('ShiftLeft')) throw new Error('shifted debug stage input was not latched');
eventTarget.dispatch('keyup', 'Digit5');
eventTarget.dispatch('keyup', 'ShiftLeft');
eventTarget.dispatch('blur');
if (browserInput.controls() !== 0 || browserInput.anyPressed()) throw new Error('browser blur did not clear input state');
eventTarget.visibilityState = 'hidden';
eventTarget.dispatch('keydown', 'ArrowLeft');
eventTarget.dispatch('visibilitychange');
if (browserInput.controls() !== 0 || browserInput.anyPressed()) throw new Error('browser visibility change did not clear input state');

game.requestDemo();
game.startDemoLevel();
state.level.skipEntry();
for (let frame = 0; frame < 2000; frame++) game.tick();
if (state.mode !== 'demo-ending') throw new Error(`demo sentinel did not end replay: ${state.mode}`);
game.tick();
if (state.mode !== 'splash') throw new Error(`demo ending did not return to splash: ${state.mode}`);

state.stage = 4;
state.lives = 4;
game.startLevel();
state.level.skipEntry();
const oldLevel = state.level;
const collisionEnemy = state.level.entities.enemies[0];
Object.assign(collisionEnemy, {
  x: state.level.player.x,
  y: state.level.player.y,
  phase: 'active',
  visible: true,
  alive: true,
  movementState: 'walking',
  walkTimer: 100,
  speed: 0,
  moveDirection: 1,
});
state.level.player.invulnerable = 0;
game.tick();
if (state.mode !== 'curtain-to-restart' || state.lives !== 2) throw new Error(`enemy collision restart did not start: ${state.mode}/${state.lives}`);
for (let frame = 0; frame < 32; frame++) game.tick();
if (state.mode !== 'play' || state.stage !== 4 || state.level === oldLevel) throw new Error('death restart did not create a fresh stage');

const gemLevel = new Level(1, sound);
gemLevel.skipEntry();
for (const enemy of gemLevel.entities.enemies) enemy.alive = false;
for (const gem of gemLevel.gems.slice(1)) gem.collected = true;
const testGem = gemLevel.gems[0];
Object.assign(gemLevel.player, { x: testGem.x, y: testGem.y, item: null, invulnerable: 10000 });
gemLevel.collectGems({ demoReplay: false, score: 0 });
gemLevel.gemsComplete = false;
gemLevel.update(noActionInput, { demoReplay: false, score: 0 });

state.mode = 'play';
state.level.dead = true;
state.lives = 0;
game.tick();
game.tick();
if (state.mode !== 'gameover') throw new Error(`game-over PSG event sequence did not start: ${state.mode}`);

const requiredSoundEvents = [0x04, 0x06, 0x09, 0x1d, 0x20, 0x45, 0x8b, 0x8f, 0x91, 0x94, 0x9a];
const missingSoundEvents = requiredSoundEvents.filter(id => !soundEvents.includes(id));
if (missingSoundEvents.length) throw new Error(`gameplay PSG event sequence missing: ${missingSoundEvents.map(id => `0x${id.toString(16)}`).join(', ')}`);

console.log(JSON.stringify({
  stagesCleared: state.clearedStages.size,
  finalMode: 'ending',
  transitions: transitionLog,
  restartStage: state.stage,
  soundEventCount: soundEvents.length,
  soundEvents: [...new Set(soundEvents)].sort((left, right) => left - right),
}, null, 2));
