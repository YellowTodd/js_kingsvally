import { makeStage, isSolid, mapIdAt, mapPatternForId } from './data.js';
import { EntitySystem } from './entity.js';
import { Player } from './player.js';
import { applyStoneColors, flippedPlayerSpritePattern, flippedSpritePattern, introColors, introPattern, playerSpritePattern, spritePattern, tileColors, tilePattern } from './rom.js';
import { PALETTE } from '../screen.js';

const DIG_PATTERNS = {
  0x12: 0x43,
  0x0f: 0x44,
  0x0c: 0,
  0x09: 0x43,
  0x06: 0x44,
  0x03: 0,
};

export class Level {
  constructor(stageNumber, sound, options = {}) {
    this.data = makeStage(stageNumber);
    const mummyCycle = Math.max(0, options.mummyCycle || 0);
    if (mummyCycle) {
      const mummyColors = [15, 9, 4, 8, 10];
      for (const enemy of this.data.enemies) {
        enemy.type = Math.min(4, (enemy.type ?? 0) + mummyCycle);
        enemy.colorIndex = mummyColors[enemy.type] ?? 15;
      }
    }
    applyStoneColors(stageNumber);
    this.sound = sound;
    this.demo = !!options.demo;
    this.player = new Player(this.data.start);
    this.entities = new EntitySystem(this.data);
    this.gems = this.data.gemLocations.map(({ x, y, color }) => ({ x, y, pattern: 0x83 + ((color || 0x31) >> 4), collected: false }));
    for (const gem of this.gems) this.placeGemMap(gem);
    this.groundKnives = this.data.knives.map(({ x, y }) => ({ x, y, active: true }));
    for (const knife of this.groundKnives) this.placeGroundKnife(knife);
    this.picks = this.data.picks.map(({ x, y }) => ({ x, y, active: true }));
    for (const pick of this.picks) this.placePick(pick);
    this.spinners = this.data.spinners.map((spinner) => ({
      ...spinner,
      rows: ((spinner.height >> 1) & 3) + 2,
      spinning: false,
      counter: 0,
      frame: spinner.direction === 8 ? 0 : 4,
    }));
    this.traps = this.data.traps.map((trap) => ({ ...trap, triggerX: trap.x, triggerY: trap.y, status: 'waiting' }));
    this.exitStates = (this.data.exits || [this.data.exit]).map((exit) => ({ ...exit, state: exit.entrance ? 'closed' : 'hidden', animationStep: 0, animationTimer: 0 }));
    const initialRoom = Math.max(0, Math.floor(this.player.x / 256));
    this.cameraX = initialRoom * 256;
    this.cameraTarget = this.cameraX;
    this.scrollAnimation = null;
    this.complete = false;
    this.destinationStage = null;
    this.exitPhase = null;
    this.exitTimer = 0;
    this.activeExit = null;
    this.playerVisible = true;
    this.dead = false;
    this.digAnimation = null;
    this.digActionCounter = 0;
    this.throwAnimation = null;
    this.spinPassAnimation = null;
    this.spinnerPush = { index: -1, timer: 0 };
    this.timer = 0;
    this.gemsComplete = false;
    this.restartPending = false;
    this.entryPhase = 'wait';
    this.entryTimer = 16;
    const entrance = this.exitStates.find((exit) => exit.entrance);
    if (entrance) entrance.state = 'open';
  }

  update(input, state) {
    if (this.restartPending) return;
    if (this.entryPhase !== 'active') {
      this.updateEntry();
      return;
    }
    this.timer = (this.timer + 1) & 0xff;
    this.updateExitAnimations();
    if (this.exitPhase) {
      this.updateDeparture(state);
      return;
    }
    if (this.scrollAnimation) {
      this.updateRoomScroll();
      return;
    }
    this.updateSpinners();
    const controls = input.controls();
    const actionPressed = input.actionPressed();
    let playerUpdated = false;
    if (this.spinPassAnimation) this.updateSpinnerPass();
    else {
      let startedThrow = false;
      let startedDig = false;
      if (this.player.item === 'knife' && actionPressed) startedThrow = this.startThrow();
      if (this.player.item === 'pickaxe' && actionPressed) this.dig();
      if (this.player.item === 'pickaxe' && actionPressed) startedDig = !!this.digAnimation;
      if (this.throwAnimation && !startedThrow) this.updateThrow();
      else if (this.digAnimation && !startedDig) this.updateDig();
      else {
        const wasFalling = this.player.falling;
        this.player.update(this.data, controls, actionPressed && !this.player.item);
        if (!wasFalling && this.player.falling && this.player.jumpIndex < 0) this.sound.playEvent?.(0x01);
        if (wasFalling && this.player.onGround && !this.player.falling) this.sound.playEvent?.(0x02);
        playerUpdated = true;
      }
    }
    if (playerUpdated) this.updateSpinnerPush();
    if (playerUpdated && this.startRoomScroll()) return;
    const playerHit = this.entities.update(this.data, this.player, this.sound, (points) => {
      if (!state.demoReplay) state.score += points;
    }, (knife) => this.landKnife(knife), state.frame);
    this.collectItems();
    if (playerHit && !state.demoReplay) {
      if (state.lives === 0) this.dead = true;
      else {
        state.lives--;
        this.restartPending = true;
      }
      return;
    }
    this.collectGems(state);
    if (this.updateTraps()) {
      this.sound.playEvent(0x1d);
      if (state.lives === 0) this.dead = true;
      else {
        state.lives--;
        this.restartPending = true;
      }
      return;
    }
    const allGems = this.gems.every((gem) => gem.collected);
    if (allGems && !this.gemsComplete) {
      this.gemsComplete = true;
      this.removeSpinners();
      for (const exit of this.exitStates) if (exit.state === 'hidden') exit.state = 'closed';
      this.sound.playEvent?.(0x94);
    }
    for (const exit of this.exitStates) {
      const atLever = Math.abs(exit.x - this.player.x) < 20 && Math.abs(exit.y - 8 - this.player.y) < 18;
      if (this.gemsComplete && exit.state === 'closed' && atLever && this.player.jumpIndex >= 0) this.startExitOpening(exit);
    }
    const openExit = this.exitStates.find((exit) => exit.state === 'open' && Math.abs(exit.x - this.player.x) < 14 && Math.abs(exit.y - this.player.y) < 16);
    if (this.gemsComplete && openExit) this.startDeparture(openExit);
  }

  startRoomScroll() {
    const room = Math.floor(this.cameraX / 256);
    const maximumRoom = Math.max(0, Math.floor((this.data.width * 8 - 1) / 256));
    const localX = this.player.x - room * 256;
    let direction = 0;
    if (this.player.direction > 0 && localX >= 0xf4 && room < maximumRoom) direction = 1;
    if (this.player.direction < 0 && localX < 2 && room > 0) direction = -1;
    if (!direction) return false;
    this.scrollAnimation = { direction, room, targetRoom: room + direction, step: 0 };
    this.cameraTarget = (room + direction) * 256;
    this.player.x = room * 256 + (direction > 0 ? 0xf4 : 1);
    return true;
  }

  updateRoomScroll() {
    const animation = this.scrollAnimation;
    animation.step++;
    this.cameraX = animation.room * 256 + animation.direction * animation.step * 32;
    if (animation.step < 8) return;
    this.cameraX = animation.targetRoom * 256;
    this.cameraTarget = this.cameraX;
    this.player.x = animation.targetRoom * 256 + (animation.direction > 0 ? 4 : 0xf0);
    this.scrollAnimation = null;
  }

  updateEntry() {
    const entrance = this.exitStates.find((exit) => exit.entrance);
    if (this.entryPhase === 'wait') {
      if (--this.entryTimer <= 0) {
        this.entryPhase = 'descending';
        this.entryTimer = 0;
      }
      return;
    }
    if (this.entryPhase === 'descending') {
      this.entryTimer++;
      if ((this.entryTimer & 3) !== 0) return;
      this.player.x -= 1.875;
      this.player.y++;
      this.player.frame = (this.player.frame + 1) & 7;
      if ((Math.round(this.player.y) & 7) === 0) {
        this.player.frame = 1;
        this.entryPhase = 'closing';
        this.entryTimer = 0;
      }
      return;
    }
    if (this.entryPhase === 'closing') {
      this.entryTimer++;
      if (entrance && this.entryTimer === 32) entrance.state = 'closing';
      if (entrance && this.entryTimer === 96) entrance.state = 'closed';
      if (this.entryTimer >= 128) {
        if (entrance) entrance.state = 'hidden';
        this.entryPhase = 'ready';
        this.entryTimer = 40;
      }
      return;
    }
    if (this.entryPhase === 'ready' && --this.entryTimer <= 0) {
      this.entryPhase = 'active';
      if (!this.demo) this.sound.setMusic(0x8b);
    }
  }

  skipEntry({ activateEnemies = true } = {}) {
    const entrance = this.exitStates.find((exit) => exit.entrance);
    if (entrance) entrance.state = 'hidden';
    this.player.x -= 15;
    this.player.y += 8;
    this.player.frame = 4;
    this.player.invulnerable = 180;
    if (activateEnemies) this.entities.activateAll();
    this.entryPhase = 'active';
    this.entryTimer = 0;
    if (!this.demo) this.sound.setMusic(0x8b);
  }

  startExitOpening(exit) {
    exit.state = 'opening';
    exit.animationStep = 0;
    exit.animationTimer = 0;
  }

  updateExitAnimations() {
    for (const exit of this.exitStates) {
      if (exit.state !== 'opening' && exit.state !== 'closing') continue;
      exit.animationTimer++;
      if ((exit.animationTimer & 0x1f) !== 0) continue;
      exit.animationStep++;
      if (exit.state === 'opening') {
        if (exit.animationStep === 1) this.sound.playEvent?.(0x8d);
        if (exit.animationStep >= 3) exit.state = 'open';
      } else {
        if (exit.animationStep === 2) this.sound.playEvent?.(0x8d);
        if (exit.animationStep >= 4) exit.state = 'sealed';
      }
    }
  }

  startDeparture(exit) {
    this.activeExit = exit;
    this.destinationStage = exit.target || Math.min(15, this.data.number + 1);
    this.exitPhase = 'climbing';
    this.exitTimer = 0;
    exit.state = 'closing';
    exit.animationStep = 0;
    exit.animationTimer = 0;
    this.player.item = null;
    this.player.direction = 1;
    for (const enemy of this.entities.enemies) enemy.visible = false;
    this.sound.setMusic?.(0x20);
  }

  updateDeparture(state) {
    if (this.exitPhase === 'climbing') {
      this.exitTimer++;
      if ((this.exitTimer & 3) !== 0) return;
      this.player.x += 1.875;
      this.player.y--;
      this.player.frame = (this.player.frame + 1) & 7;
      if (this.player.x < this.activeExit.x + 8) return;
      this.playerVisible = false;
      this.player.frame = 1;
      this.exitPhase = 'waiting-door';
      return;
    }
    if (this.exitPhase === 'waiting-door') {
      if (this.activeExit.state !== 'sealed') return;
      state.clearedStages ||= new Set();
      if (!state.clearedStages.has(this.data.number)) state.score += 2000;
      state.clearedStages.add(this.data.number);
      this.sound.playEvent?.(0x8f);
      this.exitPhase = 'fanfare';
      this.exitTimer = 0x70;
      return;
    }
    if (this.exitPhase === 'fanfare' && --this.exitTimer <= 0) this.complete = true;
  }

  collectItems() {
    if (this.player.item) return;
    for (const knife of this.groundKnives) {
      if (knife.active && this.playerTouchesItem(knife)) {
        knife.active = false;
        this.restoreGroundKnife(knife);
        this.player.item = 'knife';
        this.sound.playEvent(0x04);
        return;
      }
    }
    for (const pick of this.picks) {
      if (pick.active && this.playerTouchesItem(pick)) {
        pick.active = false;
        this.writeItemMapCell(pick.x, pick.y, 0, 0);
        this.player.item = 'pickaxe';
        this.sound.playEvent(0x04);
        return;
      }
    }
  }

  placeGroundKnife(knife) {
    const column = Math.floor(knife.x / 8);
    const row = Math.floor(knife.y / 8);
    if (row < 0 || row >= this.data.height || column < 0 || column >= this.data.width) return;
    if (!knife.backup) {
      knife.backup = {
        mapId: this.data.mapIds[row][column],
        tile: this.data.tiles[row][column],
        pattern: this.data.tilePatterns[row][column],
      };
    }
    const backgroundId = knife.backup.mapId;
    const mapId = backgroundId === 0x31 || backgroundId === 0x32 ? backgroundId : backgroundId === 0x21 || backgroundId === 0x22 ? backgroundId + 0x10 : 0x30;
    this.writeItemMapCell(knife.x, knife.y, mapId, 0x4b);
  }

  restoreGroundKnife(knife) {
    if (!knife.backup) return;
    const column = Math.floor(knife.x / 8);
    const row = Math.floor(knife.y / 8);
    this.data.mapIds[row][column] = knife.backup.mapId;
    this.data.tiles[row][column] = knife.backup.tile;
    this.data.tilePatterns[row][column] = knife.backup.pattern;
  }

  placePick(pick) {
    this.writeItemMapCell(pick.x, pick.y, 0x80, 0x4c);
  }

  writeItemMapCell(x, y, mapId, pattern) {
    const column = Math.floor(x / 8);
    const row = Math.floor(y / 8);
    if (row < 0 || row >= this.data.height || column < 0 || column >= this.data.width) return;
    this.data.mapIds[row][column] = mapId;
    this.data.tiles[row][column] = 0;
    this.data.tilePatterns[row][column] = pattern;
  }

  collectGems(state) {
    for (const gem of this.gems) {
      if (gem.collected || !this.playerTouchesItem(gem)) continue;
      gem.collected = true;
      this.clearGemMap(gem);
      if (!state.demoReplay) state.score += 500;
      this.sound.playEvent(0x09);
    }
  }

  playerTouchesItem(item) {
    const deltaX = Math.floor(this.player.x) - Math.floor(item.x);
    const deltaY = Math.floor(this.player.y) - Math.floor(item.y);
    return deltaX >= -12 && deltaX <= 5 && deltaY >= -8 && deltaY <= 0;
  }

  placeGemMap(gem) {
    const column = Math.floor(gem.x / 8);
    const row = Math.floor(gem.y / 8);
    this.writeGemMapCell(row - 1, column, 0x40);
    this.writeGemMapCell(row, column - 1, 0x41);
    this.writeGemMapCell(row, column, 0x40 + (gem.pattern - 0x83));
    this.writeGemMapCell(row, column + 1, 0x42);
  }

  clearGemMap(gem) {
    const column = Math.floor(gem.x / 8);
    const row = Math.floor(gem.y / 8);
    this.writeGemMapCell(row - 1, column, 0);
    this.writeGemMapCell(row, column - 1, 0);
    this.writeGemMapCell(row, column, 0);
    this.writeGemMapCell(row, column + 1, 0);
  }

  writeGemMapCell(row, column, mapId) {
    if (row < 0 || row >= this.data.height || column < 0 || column >= this.data.width) return;
    this.data.tiles[row][column] = 0;
    this.data.mapIds[row][column] = mapId;
    this.data.tilePatterns[row][column] = mapPatternForId(mapId);
  }

  landKnife({ x, y }) {
    if (this.groundKnives.some((knife) => knife.active && knife.x === x && knife.y === y)) return;
    const knife = { x, y, active: true };
    this.groundKnives.push(knife);
    this.placeGroundKnife(knife);
  }

  dig() {
    if (this.digAnimation) return;
    if (!this.player.isStanding(this.data)) return;
    const leftBlocked = this.digSideBlocked(-1);
    const rightBlocked = this.digSideBlocked(1);
    if (leftBlocked && rightBlocked) {
      this.startLateralDig();
      return;
    }
    const relativeX = Math.floor(this.player.x) & 7;
    const offset = this.player.direction < 0
      ? (relativeX >= 5 ? 8 : 0)
      : 16;
    const targetX = Math.floor(this.player.x) + offset;
    const column = Math.floor(targetX / 8);
    const row = Math.floor((this.player.y + 16) / 8);
    if (!this.canDigCell(row, column)) return;
    if ((this.data.mapIds[row + 1]?.[column] & 0xf0) === 0x50) return;
    const aboveFamily = (this.data.mapIds[row - 1]?.[column] || 0) & 0xf0;
    if (aboveFamily !== 0 && aboveFamily !== 0x20) return;
    if (this.player.direction < 0 && relativeX >= 5) this.player.x = ((Math.floor(this.player.x) + 4) & ~7) + 2;
    if (this.player.direction > 0 && (relativeX < 1 || relativeX > 3)) this.player.x = Math.floor(this.player.x) & ~3;
    this.startDig(row, column, 0x15, this.digActionCounter, 'floor');
  }

  startLateralDig() {
    const targetX = Math.floor(this.player.x) + (this.player.direction > 0 ? 16 : 0);
    const localX = targetX & 0xff;
    if ((localX & 0xf8) === 0 || (localX & 0xf8) === 0xf8) return;
    const column = Math.floor(targetX / 8);
    let row = Math.floor(this.player.y / 8);
    let holeCounter = 0x15;
    if (!this.canDigCell(row, column)) {
      row++;
      holeCounter = 9;
      if (!this.canDigCell(row, column)) return;
    }
    this.startDig(row, column, holeCounter, 2, 'lateral');
    this.sound.playEvent(0x45);
  }

  startDig(row, column, holeCounter, actionCounter, mode) {
    this.digAnimation = { row, column, holeCounter, initialHoleCounter: holeCounter, actionCounter, mode, pattern: 0 };
    this.player.frame = 32;
  }

  digSideBlocked(direction) {
    const x = this.player.x + (direction > 0 ? 16 : 0);
    return isSolid(this.data, x, this.player.y) || isSolid(this.data, x, this.player.y + 8);
  }

  startThrow() {
    if (this.throwAnimation || this.player.item !== 'knife' || this.entities.knives.length >= 4) return false;
    const direction = this.player.direction < 0 ? -1 : 1;
    const wallX = this.player.x + (direction < 0 ? -1 : 18);
    const wallId = mapIdAt(this.data, wallX, this.player.y);
    let directBounce = false;
    if (isSolid(this.data, wallX, this.player.y) || isKnifeObstacleId(wallId)) {
      if ((Math.floor(this.player.x) & 7) !== 4 || mapIdAt(this.data, wallX, this.player.y - 8) !== 0) return false;
      directBounce = true;
    }
    this.throwAnimation = { timer: 0x15, released: false, directBounce };
    this.player.frame = 32;
    return true;
  }

  updateThrow() {
    const animation = this.throwAnimation;
    animation.timer--;
    if (!animation.released && animation.timer === 16) {
      animation.released = true;
      this.entities.throwKnife(this.player, animation.directBounce ? {
        state: 'bouncing',
        x: Math.floor(this.player.x) + 4,
        y: this.player.y - 8,
      } : undefined);
      this.sound.playEvent(0x06);
      this.player.frame = 36;
    }
    if (animation.timer > 0) return;
    this.throwAnimation = null;
    this.player.item = null;
    this.player.frame = 1;
  }

  updateDig() {
    const animation = this.digAnimation;
    animation.actionCounter = (animation.actionCounter - 1) & 0xff;
    if ((animation.actionCounter & 0x0f) !== 0) {
      this.player.frame = animation.actionCounter & 0x10 ? 32 : 36;
      return;
    }
    let holdFrames = 4;
    if ((animation.actionCounter & 0x10) === 0) {
      holdFrames = 8;
      animation.holeCounter -= 3;
      if (animation.holeCounter <= 0) {
        this.digActionCounter = (((animation.actionCounter & 0xf0) | holdFrames) ^ 0x10) & 0xff;
        this.finishDig();
        return;
      }
      const secondCell = animation.initialHoleCounter === 0x15 && animation.holeCounter <= 9;
      const row = animation.row + (secondCell ? 1 : 0);
      if (!this.canDigCell(row, animation.column)) {
        this.digActionCounter = (((animation.actionCounter & 0xf0) | holdFrames) ^ 0x10) & 0xff;
        this.finishDig();
        return;
      }
      animation.pattern = DIG_PATTERNS[animation.holeCounter] || 0;
      animation.drawRow = row;
      if (animation.holeCounter === 0x0c || animation.holeCounter === 3) {
        this.data.tiles[row][animation.column] = 0;
        this.data.mapIds[row][animation.column] = 1;
        this.data.tilePatterns[row][animation.column] = 0;
      }
      this.sound.playEvent(0x45);
    }
    animation.actionCounter = (((animation.actionCounter & 0xf0) | holdFrames) ^ 0x10) & 0xff;
  }

  adjustAfterDig() {
    if (this.playerIncrustedAt(4)) {
      this.player.x = Math.floor(this.player.x + 4) & ~3;
      return;
    }
    if (this.playerIncrustedAt(11)) this.player.x = Math.floor(this.player.x) & ~3;
  }

  playerIncrustedAt(offsetX) {
    const x = this.player.x + offsetX;
    if (!isSolid(this.data, x, this.player.y + 12)) return isSolid(this.data, x, this.player.y + 4);
    if (isSolid(this.data, x, this.player.y + 4) || isSolid(this.data, x, this.player.y - 4)) return true;
    return isSolid(this.data, this.player.x + 8, this.player.y - 4);
  }

  canDigCell(row, column) {
    if (row < 0 || row >= this.data.height || column < 0 || column >= this.data.width) return false;
    const mapId = this.data.mapIds?.[row]?.[column] || 0;
    const kind = mapId & 0x0f;
    return (mapId & 0xf0) === 0x10 && (kind < 4 || kind === 9);
  }

  finishDig() {
    this.adjustAfterDig();
    this.digAnimation = null;
    this.player.item = null;
    this.player.frame = 1;
  }

  updateSpinnerPush() {
    const blocked = this.player.blockedAt;
    const kind = blocked?.mapId & 0x0f;
    if (!blocked || (blocked.mapId & 0xf0) !== 0x50 || kind === 1 || kind === 2) {
      this.spinnerPush.index = -1;
      this.spinnerPush.timer = 0;
      return;
    }
    const index = this.spinners.findIndex((spinner) => blocked.x >= spinner.x && blocked.x < spinner.x + 16 && blocked.y >= spinner.y && blocked.y < spinner.y + spinner.rows * 8);
    if (index < 0 || this.spinners[index].spinning) return;
    if (this.spinnerPush.index !== index) {
      this.spinnerPush.index = index;
      this.spinnerPush.timer = 0;
    }
    if (++this.spinnerPush.timer < 0x10) return;
    const spinner = this.spinners[index];
    spinner.spinning = true;
    spinner.counter = 0;
    spinner.frame = spinner.direction === 8 ? 0 : 4;
    this.spinPassAnimation = { timer: 0x20, direction: this.player.direction };
    this.spinnerPush.index = -1;
    this.spinnerPush.timer = 0;
    this.sound.playEvent(0x03);
  }

  updateSpinnerPass() {
    if (this.timer & 1) return;
    const animation = this.spinPassAnimation;
    animation.timer--;
    this.player.xFraction += animation.direction * 0xa8;
    const movement = this.player.xFraction >> 8;
    this.player.xFraction -= movement << 8;
    this.player.x += movement;
    this.player.direction = animation.direction;
    this.player.frame = (this.player.frame + 1) % 16;
    if (animation.timer <= 0) this.spinPassAnimation = null;
  }

  updateSpinners() {
    if (this.timer & 7) return;
    for (const spinner of this.spinners) {
      if (!spinner.spinning) continue;
      if (spinner.counter >= 5) {
        spinner.spinning = false;
        spinner.direction ^= 0x0c;
        spinner.frame = spinner.direction === 8 ? 0 : 4;
        this.applySpinnerMap(spinner);
        continue;
      }
      spinner.frame = spinner.direction === 8 ? spinner.counter : 4 - spinner.counter;
      spinner.counter++;
    }
  }

  applySpinnerMap(spinner) {
    const firstId = spinner.direction & 4 ? 0x52 : 0x50;
    const column = Math.floor(spinner.x / 8);
    const firstRow = Math.floor(spinner.y / 8);
    for (let row = firstRow; row < Math.min(this.data.height, firstRow + spinner.rows); row++) {
      this.data.mapIds[row][column] = firstId;
      this.data.mapIds[row][column + 1] = firstId + 1;
      this.data.tilePatterns[row][column] = mapPatternForId(firstId);
      this.data.tilePatterns[row][column + 1] = mapPatternForId(firstId + 1);
    }
  }

  removeSpinners() {
    for (const spinner of this.spinners) {
      spinner.spinning = false;
      spinner.removed = true;
      const column = Math.floor(spinner.x / 8);
      const firstRow = Math.floor(spinner.y / 8);
      for (let row = firstRow; row < Math.min(this.data.height, firstRow + spinner.rows); row++) {
        for (const currentColumn of [column, column + 1]) {
          if (currentColumn < 0 || currentColumn >= this.data.width) continue;
          this.data.tiles[row][currentColumn] = 0;
          this.data.mapIds[row][currentColumn] = currentColumn === column ? 0 : 1;
          this.data.tilePatterns[row][currentColumn] = 0;
        }
      }
    }
  }

  spinnerPatternAt(row, column) {
    const spinner = this.spinners.find((candidate) => !candidate.removed && candidate.spinning && row >= Math.floor(candidate.y / 8) && row < Math.floor(candidate.y / 8) + candidate.rows && column >= Math.floor(candidate.x / 8) && column < Math.floor(candidate.x / 8) + 2);
    if (!spinner) return null;
    return SPINNER_FRAMES[spinner.frame][column - Math.floor(spinner.x / 8)];
  }

  updateTraps() {
    for (const trap of this.traps) {
      if (trap.status === 'waiting') {
        if (Math.floor(this.player.x) === trap.triggerX && Math.floor(this.player.y) === trap.triggerY) this.activateTrap(trap);
        continue;
      }
      if (trap.status !== 'falling' || (this.timer & 0x1f) !== 0) continue;
      trap.y += 4;
      const column = Math.floor(trap.x / 8);
      const row = Math.floor(trap.y / 8);
      if ((trap.y & 7) === 0) {
        if (row >= this.data.height) {
          trap.status = 'closed';
          continue;
        }
        const mapId = this.data.mapIds[row]?.[column] || 0;
        if (mapId !== 0) {
          if (mapId === 1 || (mapId & 0xf0) === 0x10) {
            trap.status = 'closed';
            this.writeTrapTile(row, column, mapId === 0x14 ? 0x14 : 0x13);
          } else {
            trap.y -= 4;
          }
          continue;
        }
        if (this.trapObjectAt(column, row)) {
          trap.y -= 4;
          continue;
        }
      }
      this.writeTrapTile(row, column, (trap.y & 7) === 0 ? 0x1a : 0x19);
      if (this.playerIsWalking()) {
        const leftHead = mapIdAt(this.data, this.player.x + 5, this.player.y);
        const rightHead = mapIdAt(this.data, this.player.x + 11, this.player.y);
        if ([0x19, 0x1a].includes(leftHead) || [0x19, 0x1a].includes(rightHead)) return true;
      }
    }
    return false;
  }

  activateTrap(trap) {
    const column = Math.floor(trap.x / 8);
    let row = Math.floor(trap.y / 8);
    while (row > 0 && (this.data.mapIds[row]?.[column] || 0) === 0) row--;
    if (row === 0 && (this.data.mapIds[row]?.[column] || 0) === 0) this.writeTrapTile(row, column, 0x12);
    trap.y = row * 8;
    trap.status = 'falling';
  }

  writeTrapTile(row, column, mapId) {
    if (row < 0 || row >= this.data.height || column < 0 || column >= this.data.width) return;
    this.data.tiles[row][column] = 1;
    this.data.mapIds[row][column] = mapId;
    this.data.tilePatterns[row][column] = mapPatternForId(mapId);
  }

  trapObjectAt(column, row) {
    const occupiesCell = (object) => Math.floor(object.x / 8) === column && Math.floor(object.y / 8) === row;
    return this.gems.some((gem) => !gem.collected && occupiesCell(gem)) || this.groundKnives.some((knife) => knife.active && occupiesCell(knife)) || this.picks.some((pick) => pick.active && occupiesCell(pick));
  }

  playerIsWalking() {
    return this.player.onGround && !this.player.onLadder && this.player.jumpIndex < 0 && !this.throwAnimation && !this.digAnimation && !this.spinPassAnimation;
  }

  draw(screen, state) {
    const offsetX = Math.floor(this.cameraX);
    screen.clear(PALETTE[0]);
    drawHud(screen, state, this.data.number);
    for (let row = 1; row <= this.data.height; row++) {
      for (let column = 0; column < this.data.width; column++) {
        const tile = row < this.data.height ? this.data.tiles[row][column] : 1;
        const x = column * 8 - offsetX;
        const y = row * 8;
        const spinnerPattern = this.spinnerPatternAt(row, column);
        if (spinnerPattern !== null) {
          drawGameTile(screen, spinnerPattern, x, y);
        } else if (tile === 1) {
          const pattern = row < this.data.height ? this.data.tilePatterns?.[row]?.[column] || 0x40 : 0x41;
          drawGameTile(screen, pattern, x, y);
        } else if (tile === 2) {
          const pattern = this.data.tilePatterns?.[row]?.[column] || 0x75;
          drawGameTile(screen, pattern, x, y);
        }
      }
    }
    if (this.digAnimation?.pattern) {
      drawGameTile(screen, this.digAnimation.pattern, this.digAnimation.column * 8 - offsetX, this.digAnimation.drawRow * 8);
    }
    const sparkleColor = GEM_SPARKLE_COLORS[(state.frame >> 1) & 3];
    const sparkleColors = new Uint8Array(8).fill(sparkleColor);
    for (const gem of this.gems) if (!gem.collected) {
      const x = gem.x - offsetX;
      const y = gem.y;
      drawGameTileWithColors(screen, 0x51, sparkleColors, x, y - 8);
      drawGameTileWithColors(screen, 0x52, sparkleColors, x - 8, y);
      drawGameTile(screen, gem.pattern, x, y);
      drawGameTileWithColors(screen, 0x53, sparkleColors, x + 8, y);
    }
    for (const knife of this.groundKnives) if (knife.active) {
      drawGameTile(screen, 0x4b, knife.x - offsetX, knife.y);
    }
    for (const pick of this.picks) if (pick.active) {
      drawGameTile(screen, 0x4c, pick.x - offsetX, pick.y);
    }
    for (const exit of this.exitStates) {
      if (exit.state === 'hidden') continue;
      const exitX = exit.x - offsetX - 16;
      const exitY = exit.y - 8;
      const exitPatterns = this.exitPatterns(exit);
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 5; column++) {
          const mapId = exitPatterns[row * 5 + column];
          if (mapId) drawGameTile(screen, mapPatternForId(mapId), exitX + column * 8, exitY + row * 8);
        }
      }
    }
    for (const knife of this.entities.knives) {
      if (this.scrollAnimation && knife.state !== 'flying') continue;
      if (knife.state === 'flying') {
        const flightFrame = knifeFlightFrame(knife.x);
        const x = flightFrame.x - offsetX;
        drawGameTile(screen, flightFrame.pattern, x, knife.y);
        if (flightFrame.tileCount === 2) drawGameTile(screen, flightFrame.pattern + 1, x + 8, knife.y);
      } else {
        const knifePattern = 0xf0 + (state.frame & 0x0c);
        screen.sprite(spritePattern(knifePattern), knife.x - offsetX, knife.y + 1, PALETTE[15]);
      }
    }
    if (this.exitPhase === 'climbing') this.drawExitOverlapSprites(screen, this.activeExit, offsetX);
    if (this.playerVisible && !this.scrollAnimation) {
      const movingAnimation = this.player.frame === (this.player.walkCounter & 0x1f);
      const stairDescent = this.player.onLadder && this.player.direction !== this.player.stairDirection;
      const playerX = this.player.x + (stairDescent ? this.player.direction : 0) - offsetX;
      const movementFrame = this.player.falling
        ? 4
        : movingAnimation
        ? ((this.player.walkCounter >> 2) & 7) << 2
        : this.player.frame;
      const playerY = this.player.y - 1 - (this.player.falling ? 1 : 0) + (stairDescent ? 1 : 0) + ((movementFrame >> 2) & 1);
      const framePatterns = [8, 0, 16, 8, 0, 16, 0, 16, 24, 32];
      const playerPattern = framePatterns[Math.min(framePatterns.length - 1, movementFrame >> 2)];
      const ropa = this.player.direction < 0 ? flippedPlayerSpritePattern(playerPattern, this.player.item) : playerSpritePattern(playerPattern, this.player.item);
      const piel = this.player.direction < 0 ? flippedPlayerSpritePattern(playerPattern + 4, this.player.item) : playerSpritePattern(playerPattern + 4, this.player.item);
      screen.sprite(ropa, playerX, playerY, PALETTE[14]);
      screen.sprite(piel, playerX, playerY, PALETTE[6]);
    }
    for (const enemy of this.entities.enemies) if (!this.scrollAnimation && enemy.alive && enemy.visible) {
      const renderEnemy = enemy.renderState || enemy;
      const stairRenderOffset = enemy.type === 3
        && enemy.movementState === 'stairs'
        && renderEnemy.movementState === 'stairs'
        && !this.player.onLadder
        && this.player.y === 152
        && (renderEnemy.x !== enemy.x || renderEnemy.y !== enemy.y)
        ? -1
        : 0;
      const x = renderEnemy.x + stairRenderOffset - offsetX;
      const framePatterns = [0x2c, 0x28, 0x30, 0x2c, 0x28, 0x30, 0x28, 0x30, 0xe8, 0xec, 0xd4];
      const animationFrame = renderEnemy.frame;
      const y = renderEnemy.y - (animationFrame & 1) - stairRenderOffset;
      const pattern = framePatterns[animationFrame] || 0x30;
      const pixels = renderEnemy.direction < 0 ? flippedSpritePattern(pattern) : spritePattern(pattern);
      screen.sprite(pixels, x, y, PALETTE[enemy.colorIndex ?? 15]);
    }
  }

  exitPatterns(exit) {
    if (exit.state === 'open') return OPEN_EXIT_PATTERNS;
    if (exit.state === 'opening') return exit.animationStep === 0 ? CLOSED_EXIT_PATTERNS : exit.animationStep === 1 ? CLOSING_EXIT_PATTERNS : OPEN_EXIT_PATTERNS;
    if (exit.state === 'closing') return exit.animationStep < 2 ? OPEN_EXIT_PATTERNS : exit.animationStep === 2 ? CLOSING_EXIT_PATTERNS : CLOSED_EXIT_PATTERNS;
    return CLOSED_EXIT_PATTERNS;
  }

  drawExitOverlapSprites(screen, exit, offsetX) {
    const x = exit.x + 16 - offsetX;
    const y = exit.y - 16;
    screen.sprite(spritePattern(0xd8), x, y, PALETTE[1]);
    screen.sprite(spritePattern(0xdc), x, y, PALETTE[3]);
    screen.sprite(spritePattern(0xe0), x, y + 16, PALETTE[1]);
    screen.sprite(spritePattern(0xe4), x, y + 16, PALETTE[3]);
  }
}

const CLOSED_EXIT_PATTERNS = [
  0x77, 0x00, 0x60, 0x61, 0x00,
  0x79, 0x00, 0x62, 0x63, 0x00,
  0x00, 0x00, 0x64, 0x65, 0x00,
];

const OPEN_EXIT_PATTERNS = [
  0x78, 0x60, 0x66, 0x67, 0x61,
  0x79, 0x62, 0x00, 0x68, 0x63,
  0x00, 0x64, 0x69, 0x6a, 0x65,
];

const CLOSING_EXIT_PATTERNS = [
  0x78, 0x6b, 0x6c, 0x6d, 0x6e,
  0x79, 0x6f, 0x70, 0x71, 0x72,
  0x00, 0x73, 0x74, 0x75, 0x76,
];

const GEM_SPARKLE_COLORS = [0x10, 0xf0, 0xa0, 0xa0];

const SPINNER_FRAMES = [[0x68, 0x69], [0x6a, 0x6b], [0x54, 0x55], [0x7a, 0x79], [0x78, 0x77]];

const KNIFE_FLIGHT_FRAMES = [0x45, 0x46, 0x48, 0x49];

export function knifeFlightFrame(worldX) {
  const x = Math.floor(worldX);
  const phase = (x >> 2) & 3;
  return { pattern: KNIFE_FLIGHT_FRAMES[phase], x: x & ~7, tileCount: phase & 1 ? 2 : 1 };
}

function drawGameTile(screen, pattern, x, y) {
  screen.vramTile(tilePattern(pattern), tileColors(pattern), x, y, PALETTE, PALETTE[0], pattern);
}

function drawGameTileWithColors(screen, pattern, colors, x, y) {
  screen.vramTile(tilePattern(pattern), colors, x, y, PALETTE, PALETTE[0], pattern);
}

function drawHud(screen, state, stageNumber) {
  state.record = Math.max(state.record, state.score);
  drawEncodedText(screen, [0x33, 0x23, 0x2f, 0x32, 0x25, 0x20], 8, 0);
  drawNumber(screen, state.score, 56, 0, 6);
  drawEncodedText(screen, [0x28, 0x29, 0x20], 112, 0);
  drawNumber(screen, state.record, 136, 0, 6);
  drawEncodedText(screen, [0x32, 0x25, 0x33, 0x34, 0x20], 192, 0);
  drawNumber(screen, state.lives, 232, 0, 2);
  drawEncodedText(screen, [0x1a, 0x2b, 0x2f, 0x2e, 0x21, 0x2d, 0x29], 8, 184);
  drawEncodedText(screen, [0x30, 0x39, 0x32, 0x21, 0x2d, 0x29, 0x24, 0x20], 88, 184);
  drawNumber(screen, (state.completedRuns || 0) * 15 + stageNumber, 152, 184, 2);
}

function drawNumber(screen, value, x, y, digits) {
  const text = String(Math.max(0, value)).padStart(digits, '0').slice(-digits);
  for (let index = 0; index < text.length; index++) drawIntroTile(screen, 0x10 + Number(text[index]), x + index * 8, y);
}

function drawEncodedText(screen, codes, x, y) {
  for (let index = 0; index < codes.length; index++) drawIntroTile(screen, codes[index], x + index * 8, y);
}

function drawIntroTile(screen, pattern, x, y) {
  screen.vramTile(introPattern(pattern, y), introColors(pattern, y), x, y, PALETTE, PALETTE[0], pattern);
}

function isKnifeObstacleId(mapId) {
  const family = mapId & 0xf0;
  return family === 0x10 || family === 0x30 || family === 0x40 || family === 0x50 || family === 0x80;
}
