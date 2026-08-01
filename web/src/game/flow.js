import { ACTION, DOWN, LEFT, RIGHT, UP } from '../input.js';
import { Level } from './level.js';
import {
  ENDING_ASSETS,
  DEMO_CONTROLS,
  endingColors,
  endingPattern,
  flippedPlayerSpritePattern,
  introColors,
  introPattern,
  mapColors,
  mapNameTable,
  mapPattern,
  mapSpritePattern,
  playerSpritePattern,
  ROM_GRAPHICS,
} from './rom.js';
import { PALETTE } from '../screen.js';

const SPLASH_PALETTE = PALETTE.map((color, index) => index === 0 ? PALETTE[4] : color);
const SPLASH_RISE_FRAMES = 27;
const SPLASH_HOLD_FRAMES = 0xff;
const MENU_WAIT_FRAMES = 0x100;
const MAP_PAPER_COLORS = new Uint8Array(8).fill(0x0f);

const DEBUG_STAGE_KEYS = [
  ['Digit1', 1], ['Digit2', 2], ['Digit3', 3], ['Digit4', 4], ['Digit5', 5],
  ['Digit6', 6], ['Digit7', 7], ['Digit8', 8], ['Digit9', 9], ['Digit0', 10],
  ['Numpad1', 1], ['Numpad2', 2], ['Numpad3', 3], ['Numpad4', 4], ['Numpad5', 5],
  ['Numpad6', 6], ['Numpad7', 7], ['Numpad8', 8], ['Numpad9', 9], ['Numpad0', 10],
];

export class Game {
  constructor(screen, input, sound, state) {
    this.screen = screen;
    this.input = input;
    this.sound = sound;
    this.state = state;
    this.menuProgress = 0;
    this.debugMode = false;
    this.state.debugMode = false;
  }

  startLevel() {
    this.state.mode = 'play';
    this.state.paused = false;
    this.state.lives = Math.max(0, this.state.lives - 1);
    this.sound.setMuted(false);
    this.state.level = new Level(this.state.stage, this.sound, { mummyCycle: this.state.completedRuns || 0 });
  }

  startDebugStage(stageNumber) {
    const stage = Math.max(1, Math.min(15, stageNumber));
    this.state.stage = stage;
    this.state.score = 0;
    this.state.record = 0;
    this.state.lives = 5;
    this.state.completedRuns = 0;
    this.state.bestStage = stage;
    this.state.clearedStages?.clear();
    this.state.mode = 'play';
    this.state.paused = false;
    this.state.messageTimer = 0;
    this.state.transitionFrame = 0;
    this.state.level = new Level(stage, this.sound);
    this.state.level.skipEntry();
  }

  requestStart() {
    this.state.stage = 1;
    this.state.score = 0;
    this.state.lives = 5;
    this.state.completedRuns = 0;
    this.state.bestStage = 1;
    this.state.clearedStages?.clear();
    this.state.mode = 'starting';
    this.state.messageTimer = 0;
    playMusic(this.sound, 0x97);
  }

  enterMenu(immediate = false) {
    this.state.mode = 'menu';
    this.menuProgress = immediate ? 22 : 0;
    this.state.menuWait = MENU_WAIT_FRAMES;
    this.state.demoReplay = null;
    this.sound.stopAll?.();
  }

  requestDemo() {
    this.state.stage = 5;
    this.state.lives = 5;
    this.state.completedRuns = 0;
    this.state.mode = 'curtain-to-demo';
    this.state.transitionFrame = 0;
    this.state.demoReplay = new DemoReplay(DEMO_CONTROLS);
    this.sound.stopAll?.();
  }

  startDemoLevel() {
    this.state.mode = 'demo';
    this.state.lives = Math.max(0, this.state.lives - 1);
    this.state.level = new Level(5, this.sound, { demo: true });
  }

  restartIntro() {
    this.state.mode = 'splash';
    this.state.frame = 0;
    this.state.level = null;
    this.state.demoReplay = null;
    this.sound.stopAll?.();
  }

  tick() {
    this.state.frame++;
    if (this.input.pressed('Backquote')) {
      this.debugMode = !this.debugMode;
      this.state.debugMode = this.debugMode;
      this.draw();
      this.input.endFrame();
      return;
    }
    if (this.debugMode) {
      const debugStage = debugStageFromInput(this.input);
      if (debugStage) {
        this.startDebugStage(debugStage);
        this.draw();
        this.input.endFrame();
        return;
      }
    }
    const pauseCapable = this.state.mode === 'play' || this.state.mode === 'map';
    const wasPaused = this.state.paused;
    const pausePressed = pauseCapable && this.input.pressed('F1');
    if (pausePressed) {
      this.state.paused = !this.state.paused;
    }
    if (pauseCapable && this.state.paused && (wasPaused || !pausePressed)) {
      this.draw();
      this.input.endFrame();
      return;
    }
    if (this.state.mode === 'splash') {
      if (this.state.frame >= SPLASH_RISE_FRAMES + SPLASH_HOLD_FRAMES || this.input.anyPressed()) {
        this.enterMenu(false);
      }
    } else if (this.state.mode === 'menu') {
      if (this.menuProgress < 22) {
        this.menuProgress++;
        if (this.input.anyPressed()) {
          this.menuProgress = 22;
          this.state.menuWait = MENU_WAIT_FRAMES;
        } else if (this.menuProgress >= 22) {
          this.state.menuWait = MENU_WAIT_FRAMES;
        }
      } else if (this.input.actionPressed()) {
        this.requestStart();
      } else if (this.input.anyPressed()) {
        this.state.menuWait = 0x100;
      } else if (--this.state.menuWait <= 0) {
        this.requestDemo();
      }
    } else if (this.state.mode === 'starting') {
      this.state.messageTimer++;
      if (this.state.messageTimer >= 0x50) {
        this.state.mode = 'curtain-to-first-level';
        this.state.transitionFrame = 0;
      }
    } else if (this.state.mode === 'curtain-to-first-level') {
      if (++this.state.transitionFrame >= 32) this.startLevel();
    } else if (this.state.mode === 'curtain-to-demo') {
      if (++this.state.transitionFrame >= 32) this.startDemoLevel();
    } else if (this.state.mode === 'curtain-to-map') {
      if (++this.state.transitionFrame >= 32) {
        this.state.mode = 'map';
        this.state.mapFrame = 0;
        this.state.mapGoalWait = 0;
        playMusic(this.sound, 0x91);
      }
    } else if (this.state.mode === 'map') {
      this.updateMapTransition();
    } else if (this.state.mode === 'curtain-to-level') {
      if (++this.state.transitionFrame >= 32) this.startLevel();
    } else if (this.state.mode === 'curtain-to-restart') {
      if (++this.state.transitionFrame >= 32) {
        this.state.level = new Level(this.state.stage, this.sound, { mummyCycle: this.state.completedRuns || 0 });
        this.state.mode = 'play';
      }
    } else if (this.state.mode === 'play') {
      this.state.level.update(this.input, this.state);
      if (this.state.level.dead) {
        this.state.mode = 'dying';
      } else if (this.state.level.restartPending) {
        if (!this.sound.isPlaying()) {
          this.state.mode = 'curtain-to-restart';
          this.state.transitionFrame = 0;
        }
      } else if (this.state.level.complete) {
        this.state.lives++;
        const destinationStage = this.state.level.destinationStage || Math.min(15, this.state.stage + 1);
        this.state.mapOriginStage = this.state.stage;
        this.state.mapDestinationStage = destinationStage;
        this.state.mapExitDirection = this.state.level.activeExit?.exitDirection || 1;
        this.state.mapEntranceDirection = this.state.level.activeExit?.direction || 1;
        this.state.bestStage = Math.max(this.state.bestStage, destinationStage);
        this.state.stage = destinationStage;
        this.state.mode = 'curtain-to-map';
        this.state.transitionFrame = 0;
        this.sound.stopAll();
      }
    } else if (this.state.mode === 'demo') {
      if (this.input.anyPressed()) {
        this.enterMenu(true);
      } else {
        let replayFrame = { controls: 0, actionPressed: false, ended: false };
        if (this.state.level.entryPhase === 'active') replayFrame = this.state.demoReplay.tick();
        const replayInput = {
          controls: () => replayFrame.controls,
          actionPressed: () => replayFrame.actionPressed,
        };
        this.state.level.update(replayInput, this.state);
        if (replayFrame.ended || this.state.level.dead || this.state.level.restartPending) this.state.mode = 'demo-ending';
      }
    } else if (this.state.mode === 'demo-ending') {
      if (this.input.anyPressed()) this.enterMenu(true);
      else if (!this.sound.isPlaying()) this.restartIntro();
    } else if (this.state.mode === 'dying') {
      if (!this.sound.isPlaying()) {
        this.state.mode = 'gameover';
        this.state.messageTimer = 0xb8;
        playMusic(this.sound, 0x9a);
      }
    } else if (this.state.mode === 'gameover') {
      if ((this.state.frame & 1) && --this.state.messageTimer <= 0) {
        if (this.input.anyPressed()) this.enterMenu(true);
        else this.restartIntro();
      }
    } else if (this.state.mode === 'ending') {
      this.updateEnding();
    }
    this.draw();
    this.input.endFrame();
  }

  draw() {
    if (this.state.mode === 'splash') this.drawSplash();
    if (this.state.mode === 'menu') this.drawMenu();
    if (this.state.mode === 'starting') this.drawMenu();
    if (this.state.mode === 'curtain-to-first-level') {
      this.drawMenu();
      this.drawCurtain(this.state.transitionFrame);
    }
    if (this.state.mode === 'curtain-to-demo') {
      this.drawMenu();
      this.drawCurtain(this.state.transitionFrame);
    }
    if (this.state.mode === 'map') this.drawMap();
    if (this.state.mode === 'curtain-to-map') {
      this.state.level.draw(this.screen, this.state);
      this.drawCurtain(this.state.transitionFrame);
    }
    if (this.state.mode === 'curtain-to-level') {
      this.drawMap();
      this.drawCurtain(this.state.transitionFrame);
    }
    if (this.state.mode === 'curtain-to-restart') {
      this.state.level.draw(this.screen, this.state);
      this.drawCurtain(this.state.transitionFrame);
    }
    if (this.state.mode === 'play') {
      this.state.level.draw(this.screen, this.state);
    }
    if (this.state.mode === 'demo' || this.state.mode === 'demo-ending') this.state.level.draw(this.screen, this.state);
    if (this.state.mode === 'dying') this.state.level.draw(this.screen, this.state);
    if (this.state.mode === 'gameover') this.drawGameOver();
    if (this.state.mode === 'ending') this.drawEnding();
    if (this.state.paused && pauseTextVisible(this.state.frame)) {
      drawEncodedText(this.screen, [0x30, 0x21, 0x35, 0x33, 0x29, 0x2e, 0x27], 176, 184);
    }
  }

  drawSplash() {
    this.screen.clear(PALETTE[4]);
    const rise = Math.min(14, Math.floor((this.state.frame + 1) / 2));
    const top = 168 - rise * 8;
    const rows = [[0x60, 3], [0x63, 11], [0x6e, 12]];
    for (let row = 0; row < rows.length; row++) {
      for (let column = 0; column < rows[row][1]; column++) {
        drawIntroTile(this.screen, rows[row][0] + column, 80 + column * 8, top + row * 8, SPLASH_PALETTE, PALETTE[4]);
      }
    }
    if (rise >= 14) {
      for (let column = 0; column < 12; column++) drawIntroTile(this.screen, 0x7a, 80 + column * 8, 80, SPLASH_PALETTE, PALETTE[4]);
      drawEncodedText(this.screen, [0x33, 0x2f, 0x26, 0x34, 0x37, 0x21, 0x32, 0x25], 96, 88, SPLASH_PALETTE, PALETTE[4]);
    }
  }

  drawMenu() {
    this.screen.clear(PALETTE[0]);
    drawMenuLogo(this.screen, this.menuProgress);
    if (this.menuProgress >= 22) {
      drawEncodedText(this.screen, [0x1a, 0x2b, 0x2f, 0x2e, 0x21, 0x2d, 0x29, 0x00, 0x11, 0x19, 0x18, 0x15], 80, 104);
      const startingPrompt = this.state.mode === 'starting' || this.state.mode === 'curtain-to-first-level';
      const startWait = 0x50 - this.state.messageTimer;
      if (!startingPrompt || this.state.mode === 'curtain-to-first-level' || (startWait & 4) === 0) {
        const prompt = startingPrompt
          ? [0x00, 0x00, 0x30, 0x2c, 0x21, 0x39, 0x00, 0x33, 0x34, 0x21, 0x32, 0x34, 0x00, 0x00]
          : [0x30, 0x35, 0x33, 0x28, 0x00, 0x33, 0x30, 0x21, 0x23, 0x25, 0x00, 0x2b, 0x25, 0x39];
        drawEncodedText(this.screen, prompt, 72, 144);
      }
    }
  }

  drawMap() {
    this.screen.clear(PALETTE[0]);
    const names = mapNameTable();
    for (let row = 0; row < 24; row++) {
      for (let column = 0; column < 32; column++) {
        const pattern = names[row * 32 + column];
        if (pattern) {
          const colors = pattern === 0x01 ? MAP_PAPER_COLORS : mapColors(pattern);
          this.screen.vramTile(mapPattern(pattern), colors, column * 8, row * 8, PALETTE, PALETTE[0], pattern);
        }
      }
    }
    drawScoreHud(this.screen, this.state);
    const coordinates = [
      [0x4a, 0x3f], [0x6a, 0x3f], [0x8a, 0x3f], [0xa2, 0x4f], [0x8a, 0x4f],
      [0x62, 0x4f], [0x5a, 0x5f], [0x7a, 0x5f], [0x92, 0x6f], [0x6a, 0x6f],
      [0x52, 0x6f], [0x6a, 0x7f], [0x82, 0x7f], [0xa2, 0x7f], [0xa2, 0x8f],
    ];
    const marker = mapMarkerState(this.state);
    const color = [1, 6, 6, 10, 10, 6, 6, 6][this.state.frame & 7];
    if (marker.stage) {
      const [x, y] = coordinates[marker.stage - 1];
      this.screen.sprite(mapSpritePattern(0xe4), x, y, PALETTE[color]);
      const arrow = mapArrow(marker.direction, marker.inverted, x, y);
      this.screen.sprite(mapSpritePattern(arrow.pattern), arrow.x, arrow.y, PALETTE[color]);
    } else {
      this.screen.sprite(mapSpritePattern(0xf0), 0x7d, 0x90, PALETTE[color]);
    }
  }

  updateMapTransition() {
    this.state.mapFrame++;
    const reachesGoal = this.state.mapOriginStage - this.state.mapDestinationStage === 14;
    if (reachesGoal && this.state.mapFrame >= 88) {
      if (this.sound.isPlaying()) return;
      if (++this.state.mapGoalWait < 0x80) return;
      this.startEnding();
      return;
    }
    if (!reachesGoal && this.state.mapFrame >= 0xe0) {
      this.state.mode = 'curtain-to-level';
      this.state.transitionFrame = 0;
    }
  }

  startEnding() {
    this.state.completedRuns = (this.state.completedRuns || 0) + 1;
    this.state.mode = 'ending';
    this.state.transitionFrame = 0;
    this.state.endingPhase = 'curtain';
    this.state.endingPhaseFrame = 0;
    this.state.endingWait = 0;
    this.state.endingTextVisible = false;
    this.state.endingPlayer = null;
  }

  updateEnding() {
    if (this.state.endingPhase === 'curtain') {
      if (++this.state.transitionFrame >= 32) {
        this.state.endingPhase = 'initialize';
        this.state.endingPhaseFrame = 0;
        playMusic(this.sound, 0x8b);
      }
      return;
    }
    if (this.state.endingPhase === 'initialize') {
      const data = ENDING_ASSETS.player;
      this.state.endingPlayer = {
        x: data[5],
        y: data[3],
        fraction: data[4],
        direction: -1,
        movementCounter: data[10],
        frame: data[11],
        jumpIndex: -1,
        jumpFalling: false,
        jumpScale: 1,
      };
      this.state.endingPhase = 'walk';
      this.state.endingPhaseFrame = 0;
      return;
    }
    if (this.state.endingPhase === 'walk') {
      const player = this.state.endingPlayer;
      moveEndingPlayerLeft(player, 0xc0);
      player.movementCounter = (player.movementCounter + 1) & 0xff;
      player.frame = (player.movementCounter >> 2) & 7;
      if (this.state.endingPhaseFrame === 0x88) beginEndingJump(player, 1);
      else if (player.jumpIndex >= 0) updateEndingJump(player);
      this.state.endingPhaseFrame++;
      if (this.state.endingPhaseFrame >= 0x88 + 0x1b) {
        beginEndingJump(player, 4);
        this.state.endingPhase = 'jump';
        this.state.endingPhaseFrame = 0;
      }
      return;
    }
    if (this.state.endingPhase === 'jump') {
      const player = this.state.endingPlayer;
      player.x--;
      if (updateEndingJump(player)) {
        this.state.endingPhase = 'bonus';
        this.state.endingPhaseFrame = 0;
      }
      return;
    }
    if (this.state.endingPhase === 'bonus') {
      this.state.lives++;
      this.state.score += 10000;
      this.state.record = Math.max(this.state.record, this.state.score);
      this.state.endingTextVisible = true;
      this.state.endingWait = 0xd0;
      if (typeof this.sound.playEvent === 'function') this.sound.playEvent(0x8a);
      else playMusic(this.sound, 0x8a);
      this.state.endingPhase = 'wait';
      return;
    }
    if (this.state.endingPhase === 'wait') {
      if (--this.state.endingWait > 0) return;
      this.state.lives++;
      this.state.stage = 1;
      this.state.endingPhase = 'restart-curtain';
      this.state.transitionFrame = 0;
      if (typeof this.sound.setMusic === 'function') this.sound.setMusic(0x20);
      else this.sound.stopAll?.();
      return;
    }
    if (this.state.endingPhase === 'restart-curtain' && ++this.state.transitionFrame >= 32) this.startLevel();
  }

  drawCurtain(frame) {
    const columns = Math.max(0, Math.min(32, frame));
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < 24; row++) drawIntroTile(this.screen, 0, column * 8, row * 8);
    }
  }

  drawGameOver() {
    this.state.level.draw(this.screen, this.state);
    for (let row = 9; row < 14; row++) {
      for (let column = 9; column < 21; column++) drawIntroTile(this.screen, 0, column * 8, row * 8);
    }
    drawEncodedText(this.screen, [0x27, 0x21, 0x2d, 0x25, 0, 0x2f, 0x36, 0x25, 0x32], 88, 88);
  }

  drawEnding() {
    if (this.state.endingPhase === 'curtain') {
      this.drawMap();
      this.drawCurtain(this.state.transitionFrame);
      return;
    }
    this.screen.clear(PALETTE[0]);
    const names = endingSceneNameTable();
    for (let row = 0; row < 24; row++) {
      for (let column = 0; column < 32; column++) {
        const pattern = names[row * 32 + column];
        if (pattern) this.screen.vramTile(endingPattern(pattern, row * 8), endingColors(pattern, row * 8), column * 8, row * 8, PALETTE, PALETTE[0], pattern);
      }
    }
    drawScoreHud(this.screen, this.state);
    if (this.state.endingTextVisible) {
      drawEncodedText(this.screen, [0x23, 0x2f, 0x2e, 0x27, 0x32, 0x21, 0x34, 0x35, 0x2c, 0x21, 0x34, 0x29, 0x2f, 0x2e, 0x33], 72, 48);
      drawEncodedText(this.screen, [0x33, 0x30, 0x25, 0x23, 0x29, 0x21, 0x2c, 0, 0x22, 0x2f, 0x2e, 0x35, 0x33, 0, 0, 0x11], 48, 64);
      drawEncodedText(this.screen, [0x10, 0x10, 0x10, 0x10], 176, 64);
    }
    const player = this.state.endingPlayer;
    if (player) {
      const framePatterns = [8, 0, 16, 8, 0, 16, 0, 16];
      const pattern = framePatterns[player.frame & 7];
      const clothing = player.direction < 0 ? flippedPlayerSpritePattern(pattern, 'pickaxe') : playerSpritePattern(pattern, 'pickaxe');
      const skin = player.direction < 0 ? flippedPlayerSpritePattern(pattern + 4, 'pickaxe') : playerSpritePattern(pattern + 4, 'pickaxe');
      const y = player.y - 2 + ((player.frame & 1) ? 1 : 0);
      this.screen.sprite(clothing, player.x, y, PALETTE[14]);
      this.screen.sprite(skin, player.x, y, PALETTE[6]);
    }
    if (this.state.endingPhase === 'restart-curtain') this.drawCurtain(this.state.transitionFrame);
  }
}

export class DemoReplay {
  constructor(data = DEMO_CONTROLS) {
    this.data = data;
    this.pointer = 0;
    this.holdCounter = 8;
    this.previousControls = 0;
    this.finished = false;
  }

  tick() {
    if (this.finished) return { controls: 0, actionPressed: false, ended: true };
    this.holdCounter = (this.holdCounter - 1) & 0xff;
    const controls = this.data[this.pointer] || 0;
    let ended = false;
    if (this.holdCounter === 0) {
      const duration = this.data[this.pointer + 1];
      if (duration === 0xff || duration === undefined) {
        this.finished = true;
        ended = true;
      } else {
        this.holdCounter = duration;
        this.pointer += 2;
      }
    }
    const actionPressed = !!(controls & ACTION) && !(this.previousControls & ACTION);
    this.previousControls = controls;
    return { controls, actionPressed, ended };
  }
}

export function debugStageFromInput(input) {
  const shifted = input.heldKey?.('ShiftLeft') || input.heldKey?.('ShiftRight');
  for (const [code, stage] of DEBUG_STAGE_KEYS) {
    if (!input.pressed(code)) continue;
    if (shifted && stage <= 5) return stage + 10;
    if (!shifted) return stage;
  }
  return 0;
}

export function pauseTextVisible(frame) {
  return (frame & 0x10) === 0;
}

export function endingSceneNameTable() {
  const names = new Uint8Array(32 * 24);
  drawHalfPyramid(names, 8, 31, 0x90, -1);
  drawHalfPyramid(names, 16, 3, 0x92, -1);
  drawHalfPyramid(names, 17, 11, 0x92, -1);
  drawHalfPyramid(names, 16, 4, 0x94, 1);
  drawHalfPyramid(names, 17, 12, 0x94, 1);
  const door = ENDING_ASSETS.door;
  for (let row = 0; row < 3; row++) for (let column = 0; column < 2; column++) names[(16 + row) * 32 + 30 + column] = door[row * 2 + column];
  names.fill(0x96, 19 * 32, 20 * 32);
  for (const lowByte of ENDING_ASSETS.stars.subarray(0, 6)) names[0x100 + lowByte] = 0x97;
  return names;
}

function drawHalfPyramid(names, startRow, axisColumn, edgePattern, direction) {
  let width = 0;
  for (let row = startRow; row < 20; row++, width++) {
    names[row * 32 + axisColumn] = edgePattern;
    for (let offset = 1; offset < width; offset++) {
      const column = axisColumn + direction * offset;
      if (column >= 0 && column < 32) names[row * 32 + column] = edgePattern + 1;
    }
  }
}

function moveEndingPlayerLeft(player, speed) {
  player.fraction -= speed;
  while (player.fraction < 0) {
    player.fraction += 0x100;
    player.x--;
  }
}

function beginEndingJump(player, scale) {
  player.jumpIndex = 0;
  player.jumpFalling = false;
  player.jumpScale = scale;
  player.frame = 2;
}

function updateEndingJump(player) {
  const steps = [4, 2, 2, 2, 1, 1, 2, 0, 1, 1, 0, 0];
  let movement;
  if (!player.jumpFalling) {
    movement = -steps[player.jumpIndex++] * player.jumpScale;
    if (player.jumpIndex >= steps.length) {
      player.jumpFalling = true;
      player.jumpIndex = steps.length - 1;
    }
  } else {
    movement = steps[player.jumpIndex--] * player.jumpScale;
  }
  player.y += movement;
  if (player.jumpFalling && player.jumpIndex < 0) {
    player.y = 0x88;
    player.jumpIndex = -1;
    player.jumpFalling = false;
    player.frame = 0;
    return true;
  }
  return false;
}

function drawScoreHud(screen, state) {
  state.record = Math.max(state.record, state.score);
  drawEncodedText(screen, [0x33, 0x23, 0x2f, 0x32, 0x25, 0x20], 8, 0);
  drawNumber(screen, state.score, 56, 0, 6);
  drawEncodedText(screen, [0x28, 0x29, 0x20], 112, 0);
  drawNumber(screen, state.record, 136, 0, 6);
  drawEncodedText(screen, [0x32, 0x25, 0x33, 0x34, 0x20], 192, 0);
  drawNumber(screen, state.lives, 232, 0, 2);
}

export function pyramidDisplayNumber(state) {
  return (state.completedRuns || 0) * 15 + Math.max(1, state.stage || 1);
}

function drawNumber(screen, value, x, y, digits) {
  const text = String(Math.max(0, value)).padStart(digits, '0').slice(-digits);
  for (let index = 0; index < text.length; index++) drawIntroTile(screen, 0x10 + Number(text[index]), x + index * 8, y);
}

export function mapMarkerState(state) {
  const atDestination = state.mapFrame >= 0x58;
  if (atDestination && state.mapOriginStage - state.mapDestinationStage === 14) return { stage: 0, direction: 1, inverted: true };
  return atDestination
    ? { stage: state.mapDestinationStage, direction: state.mapEntranceDirection, inverted: true }
    : { stage: state.mapOriginStage, direction: state.mapExitDirection, inverted: false };
}

export function mapArrow(direction, inverted, pyramidX, pyramidY) {
  const index = ({ 1: 0, 2: 1, 4: 2, 8: 3 })[direction] ?? 0;
  const offsets = [[2, -7], [2, 8], [-15, -7], [4, -7]];
  const patterns = inverted ? [0xf0, 0xe8, 0xec, 0xf4] : [0xe8, 0xf0, 0xf4, 0xec];
  return { x: pyramidX + offsets[index][0], y: pyramidY + offsets[index][1], pattern: patterns[index] };
}

function drawMenuLogo(screen, progress) {
  const kingColumns = Math.min(9, progress);
  for (let index = 0; index < kingColumns; index++) {
    drawIntroTile(screen, 0x9b + index * 2, 56 + index * 8, 40);
    drawIntroTile(screen, 0x9c + index * 2, 56 + index * 8, 48);
  }
  if (kingColumns > 5) drawIntroTile(screen, 0xc7, 96, 56);
  if (kingColumns > 6) drawIntroTile(screen, 0xc8, 104, 56);
  const valleyColumns = Math.min(13, Math.max(0, progress - 9));
  for (let index = 0; index < valleyColumns; index++) {
    drawIntroTile(screen, 0xad + index * 2, 104 + index * 8, 64);
    drawIntroTile(screen, 0xae + index * 2, 104 + index * 8, 72);
  }
  if (progress < 22) return;
  const pyramid = ROM_GRAPHICS.introVram;
  const source = [0, 0, 0x93, 0x96, 0, 0, 0, 0x90, 0x94, 0x97, 0x98, 0, 0x91, 0x92, 0x95, 0x99, 0x99, 0x9a];
  for (let index = 0; index < source.length; index++) {
    const row = Math.floor(index / 6);
    const column = index % 6;
    drawIntroTile(screen, source[index], 144 + column * 8, 32 + row * 8);
  }
}

function drawEncodedText(screen, codes, x, y, palette = PALETTE, backdrop = PALETTE[0]) {
  for (let index = 0; index < codes.length; index++) drawIntroTile(screen, codes[index], x + index * 8, y, palette, backdrop);
}

function drawIntroTile(screen, pattern, x, y, palette = PALETTE, backdrop = PALETTE[0]) {
  screen.vramTile(introPattern(pattern, y), introColors(pattern, y), x, y, palette, backdrop, pattern);
}

function playMusic(sound, id) {
  if (typeof sound.playMusic === 'function') sound.playMusic(id);
  else if (typeof sound.beep === 'function') sound.beep(id === 0x91 ? 330 : 440, 0.1);
}

function screenFrame(screen, x, y, width, height, color) {
  screen.rect(x, y, width, 2, color);
  screen.rect(x, y + height - 2, width, 2, color);
  screen.rect(x, y, 2, height, color);
  screen.rect(x + width - 2, y, 2, height, color);
}
