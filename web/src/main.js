import { Screen, SCREEN_H, SCREEN_W } from './screen.js';
import { Input, RIGHT, UP } from './input.js';
import { Sound } from './sound.js';
import { ROM_BYTES } from './game/rom.js';
import { GameState } from './game/state.js';
import { Game } from './game/flow.js';

const FRAME_MS = 1000 / 59.92;
const MAX_CATCHUP = 4;

function fitCanvas(canvas, display) {
  const rasterWidth = SCREEN_W + 16;
  const availableWidth = Math.max(rasterWidth, window.innerWidth - 16);
  const availableHeight = Math.max(SCREEN_H, window.innerHeight - 52);
  const scale = Math.max(1, Math.min(2.5, availableWidth / rasterWidth, availableHeight / SCREEN_H));
  canvas.style.width = `${SCREEN_W * scale}px`;
  canvas.style.height = `${SCREEN_H * scale}px`;
  display.style.paddingInline = `${8 * scale}px`;
}

function boot() {
  const canvas = document.getElementById('screen');
  const display = document.getElementById('display');
  const status = document.getElementById('status');
  window.addEventListener('error', (event) => {
    status.textContent = `runtime error: ${event.error?.message || event.message}`;
  });
  window.addEventListener('unhandledrejection', (event) => {
    status.textContent = `runtime error: ${event.reason?.message || event.reason}`;
  });
  const screen = new Screen(canvas);
  const input = new Input();
  input.attach(window);
  const sound = new Sound(ROM_BYTES);
  sound.attach(window);
  const state = new GameState();
  const game = new Game(screen, input, sound, state);
  const baseStatus = 'MSX SCREEN 2 · 256×192 · 59.92Hz · stairs: UP/DOWN + LEFT/RIGHT · SPACE jump/use · F1 pause';
  const debugParams = new URLSearchParams(window.location.search);
  const debugFreeze = debugParams.get('freeze') === '1';
  const debugSoundTrace = debugParams.get('soundTrace') === '1';
  if (debugParams.get('mode') === 'play') {
    state.stage = Math.max(1, Math.min(15, Number(debugParams.get('stage')) || 1));
    game.startLevel();
    if (debugParams.get('entry') !== '1') state.level.skipEntry();
    const debugItem = debugParams.get('item');
    if (debugItem === 'knife' || debugItem === 'pickaxe') state.level.player.item = debugItem;
    if (debugItem === 'pickaxe' && debugParams.get('dig') === '1') state.level.dig();
    if (debugItem === 'knife' && debugParams.get('throw') === '1') state.level.startThrow();
    if (debugParams.get('stair') === 'up') {
      state.level.player.x = 60;
      state.level.player.y = 112;
      state.level.player.update(state.level.data, UP | RIGHT, false);
      for (let frame = 0; frame < 36; frame++) state.level.player.update(state.level.data, RIGHT, false);
    }
    if (debugParams.get('mummyStair') === 'up') {
      const mummy = state.level.entities.enemies[0];
      Object.assign(mummy, { x: 76, y: 92, direction: 1, phase: 'active', visible: true, movementState: 'stairs', stairDirection: 1 });
    }
    if (debugParams.get('mummyJump') === '1') {
      const mummy = state.level.entities.enemies[0];
      Object.assign(mummy, { x: 132, y: 52, direction: 1, phase: 'active', visible: true, movementState: 'jumping', jumpIndex: 5, jumpFalling: false });
    }
    if (/^[0-3]$/.test(debugParams.get('knifePhase') || '')) {
      const phase = Number(debugParams.get('knifePhase'));
      state.level.entities.knives = [{ x: 96 + phase * 4, y: 100, direction: 0, state: 'flying', bounceStep: 0, tick: 0, life: 10000 }];
    }
    if (debugParams.get('knifeHit') === '1' && state.stage === 1) {
      state.level.entities.activateAll();
      const enemy = state.level.entities.enemies[0];
      Object.assign(enemy, { x: 84, y: 40, direction: 1, phase: 'active', visible: true });
      for (const other of state.level.entities.enemies.slice(1)) other.alive = false;
      Object.assign(state.level.player, { x: 64, y: 40, direction: 1, invulnerable: 10000 });
      state.level.entities.throwKnife(state.level.player);
      for (let frame = 0; frame < 20; frame++) state.level.entities.update(state.level.data, state.level.player, sound, (points) => { state.score += points; }, (knife) => state.level.landKnife(knife));
    }
    if (debugParams.get('spinner') === 'mid' && state.stage === 4) {
      const spinner = state.level.spinners[0];
      Object.assign(spinner, { spinning: true, counter: 3, frame: 2 });
      Object.assign(state.level.player, { x: 20, y: 32, direction: 1 });
      state.level.cameraX = 0;
      state.level.cameraTarget = 0;
    }
    if (debugParams.get('trap') === 'mid' && state.stage === 5) {
      const trap = state.level.traps[0];
      state.level.activateTrap(trap);
      Object.assign(state.level.player, { x: 80, y: 160, onGround: true });
      for (const timer of [32, 64, 96, 128]) {
        state.level.timer = timer;
        state.level.updateTraps();
      }
      state.level.timer = 1;
    }
    if (debugParams.get('itemMap') === 'pick' && state.stage === 6) {
      Object.assign(state.level.player, { x: 456, y: 152, direction: 1, invulnerable: 10000 });
      state.level.cameraX = 256;
      state.level.cameraTarget = 256;
    }
    if (debugParams.get('dig') === 'lateral' && state.stage === 1) {
      Object.assign(state.level.player, { x: 228, y: 144, direction: 1, item: 'pickaxe', onGround: true, invulnerable: 10000 });
      state.level.dig();
      for (let frame = 0; frame < 13 && state.level.digAnimation; frame++) state.level.updateDig();
    }
    if (debugParams.get('exit') === 'depart') {
      for (const gem of state.level.gems) {
        state.level.clearGemMap(gem);
        gem.collected = true;
      }
      state.level.gemsComplete = true;
      const exit = state.level.exitStates.find((candidate) => candidate.target === Math.min(15, state.stage + 1)) || state.level.exitStates[0];
      exit.state = 'open';
      Object.assign(state.level.player, { x: exit.x - 24, y: exit.y + 4, direction: 1, item: null, invulnerable: 10000 });
      state.level.cameraX = Math.floor(exit.x / 256) * 256;
      state.level.cameraTarget = state.level.cameraX;
      state.level.startDeparture(exit);
    }
    if (debugParams.get('scroll') === 'mid' && state.stage === 2) {
      Object.assign(state.level.player, { x: 244, direction: 1, invulnerable: 10000 });
      state.level.cameraX = 0;
      state.level.cameraTarget = 0;
      state.level.startRoomScroll();
      for (let frame = 0; frame < 4; frame++) state.level.updateRoomScroll();
    }
  } else if (debugParams.get('mode') === 'menu') {
    state.mode = 'menu';
    game.menuProgress = 22;
  } else if (debugParams.get('mode') === 'map') {
    state.mode = 'map';
    state.mapOriginStage = Math.max(1, Math.min(15, Number(debugParams.get('from')) || 1));
    state.mapDestinationStage = Math.max(1, Math.min(15, Number(debugParams.get('to')) || 2));
    state.mapExitDirection = Number(debugParams.get('exitDirection')) || 8;
    state.mapEntranceDirection = Number(debugParams.get('entranceDirection')) || 4;
    state.mapFrame = Math.max(0, Number(debugParams.get('mapFrame')) || 0);
  } else if (debugParams.get('mode') === 'ending') {
    state.score = Math.max(0, Number(debugParams.get('score')) || 0);
    state.record = state.score;
    game.startEnding();
    const endingFrame = Math.max(0, Math.min(450, Number(debugParams.get('frame')) || 33));
    for (let frame = 0; frame < endingFrame; frame++) game.updateEnding();
  } else if (debugParams.get('mode') === 'demo') {
    game.requestDemo();
    game.startDemoLevel();
    state.level.skipEntry();
    const demoFrame = Math.max(0, Math.min(1999, Number(debugParams.get('frame')) || 240));
    for (let frame = 0; frame < demoFrame && state.mode === 'demo'; frame++) game.tick();
  } else if (debugParams.get('mode') === 'gameover') {
    state.stage = Math.max(1, Math.min(15, Number(debugParams.get('stage')) || 5));
    game.startLevel();
    state.level.skipEntry();
    state.lives = 0;
    state.mode = 'gameover';
    state.messageTimer = 0xb8;
  } else if (debugParams.get('mode') === 'curtain') {
    state.mode = 'curtain-to-level';
    state.mapOriginStage = 1;
    state.mapDestinationStage = 2;
    state.mapExitDirection = 8;
    state.mapEntranceDirection = 4;
    state.mapFrame = 88;
    state.transitionFrame = Math.max(0, Math.min(32, Number(debugParams.get('frame')) || 16));
  }
  if (debugParams.get('pause') === '1' && (state.mode === 'play' || state.mode === 'map')) {
    state.paused = true;
    state.frame = Math.max(0, Number(debugParams.get('pauseFrame')) || 32);
  }
  status.textContent = `${baseStatus} · DEBUG: \` toggle, 1–9/0 select, Shift+1–5 = 11–15`;
  fitCanvas(canvas, display);
  window.addEventListener('resize', () => fitCanvas(canvas, display));
  let carry = 0;
  let previous = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (debugFreeze) {
      game.draw();
      screen.present();
      return;
    }
    carry += now - previous;
    previous = now;
    let steps = Math.min(MAX_CATCHUP, Math.floor(carry / FRAME_MS));
    if (steps <= 0) return;
    carry -= steps * FRAME_MS;
    while (steps-- > 0) {
      game.tick();
      sound.tick();
    }
    if (debugSoundTrace) {
      status.textContent = `AY ${sound.snapshot().registers.slice(0, 11).map((value) => value.toString(16).padStart(2, '0')).join(' ')}`;
    } else if (game.debugMode) {
      status.textContent = `${baseStatus} · DEBUG ON · 1–9/0 select, Shift+1–5 = 11–15`;
    } else {
      status.textContent = `${baseStatus} · DEBUG OFF · \` toggle`;
    }
    screen.present();
  };
  requestAnimationFrame(frame);
}

boot();
