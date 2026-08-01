import { isSolid, isStairExit, mapIdAt, stairEntryAt } from './data.js';

const STAIR_PAUSE_MASKS = [3, 0, 1, 0, 3];
const ENEMY_JUMP = [4, 2, 2, 2, 1, 1, 2, 0, 1, 1, 0, 0];
const ENEMY_HESITATIONS = [3, 3, 0, 0, 3];

export class EntitySystem {
  constructor(level) {
    this.timer = 0;
    const speeds = [0x50, 0x50, 0xa0, 0xa0, 0xb0];
    this.enemies = level.enemies.map((enemy) => ({
      ...enemy,
      alive: true,
      frame: 0,
      phase: 'limbo',
      timer: 16,
      phaseTick: 0,
      visible: false,
      speed: (speeds[enemy.type ?? 0] ?? 0x50) / 256,
      moveDirection: enemy.direction,
      movementState: 'walking',
      stairDirection: 0,
      stairIntent: null,
      relativePosition: 0,
      walkTimer: 0,
      walkCounter: 0,
      thinkTimer: 0,
      jumpIndex: -1,
      jumpFalling: false,
      jumpDirection: 0,
      wallTurnPending: false,
      stress: 0,
    }));
    this.knives = [];
  }

  throwKnife(player, options = {}) {
    this.knives.push({
      x: options.x ?? (((Math.floor(player.x) + (player.direction > 0 ? 8 : 0)) & ~7) + 4),
      y: options.y ?? player.y,
      direction: player.direction,
      state: options.state ?? 'flying',
      bounceStep: 0,
      tick: 0,
      life: 512,
    });
  }

  update(level, player, sound, scoreCallback, landKnife = () => {}, frame = null) {
    this.timer = frame === null ? (this.timer + 1) & 0xff : frame & 0xff;
    let playerHit = false;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const previousRenderState = enemy.phase === 'active'
          ? { x: enemy.x, y: enemy.y, frame: enemy.frame, direction: enemy.direction, movementState: enemy.movementState }
        : null;
      if (!this.updateEnemyPhase(enemy, sound)) {
        enemy.renderState = null;
        continue;
      }
      this.updateEnemyMovement(enemy, level, player);
      enemy.renderState = enemy.phase === 'active' ? previousRenderState : null;
      if (enemy.phase !== 'active') continue;
      if (this.enemyTouchesPlayer(enemy, player) && player.invulnerable === 0) {
        if (!playerHit) sound.playEvent(0x1d);
        playerHit = true;
      }
    }
    for (const knife of this.knives) {
      knife.life--;
      if (knife.state === 'flying') this.updateFlyingKnife(knife, level);
      else if (knife.state === 'collided') this.startKnifeBounce(knife);
      else if (knife.state === 'bouncing') this.updateBouncingKnife(knife, level, landKnife);
      else if (knife.state === 'falling') this.updateFallingKnife(knife, level, landKnife);
      if (knife.state === 'flying') this.hitEnemyWithKnife(knife, scoreCallback, sound);
      if (knife.x < -16 || knife.x >= level.width * 8 + 16 || knife.y >= 184) knife.life = 0;
    }
    this.knives = this.knives.filter((knife) => knife.life > 0);
    return playerHit;
  }

  enemyTouchesPlayer(enemy, player) {
    const deltaX = Math.floor(player.x) - Math.floor(enemy.x);
    const deltaY = Math.floor(player.y) - Math.floor(enemy.y);
    return deltaX >= -5 && deltaX <= 4 && deltaY >= -8 && deltaY <= 7;
  }

  updateEnemyMovement(enemy, level, player) {
    if (enemy.movementState === 'stairs') {
      this.updateEnemyStair(enemy, level);
      return;
    }
    if (enemy.movementState === 'jumping') {
      this.updateEnemyJump(enemy, level);
      return;
    }
    if (enemy.movementState === 'falling') {
      this.updateEnemyFall(enemy, level);
      return;
    }
    if (enemy.movementState === 'thinking') {
      this.updateEnemyThinking(enemy, level, player);
      return;
    }
    enemy.direction = enemy.moveDirection ?? enemy.direction;
    if (!this.enemyIsStanding(enemy, level)) {
      this.handleEnemyPlatformEdge(enemy, level, player);
      return;
    }
    if (enemy.walkTimer <= 0) {
      this.startEnemyThinking(enemy);
      return;
    }
    if ((this.timer & 0x0f) === 0) enemy.walkTimer--;
    if (enemy.stairIntent) {
      const entry = stairEntryAt(level, enemy.x, enemy.y, enemy.stairIntent.verticalDirection);
      if (entry) {
        enemy.y += entry.yOffset;
        enemy.stairDirection = entry.ascentDirection;
        enemy.moveDirection = enemy.stairIntent.verticalDirection < 0 ? entry.ascentDirection : -entry.ascentDirection;
        enemy.direction = enemy.moveDirection;
        enemy.stairIntent = null;
        enemy.movementState = 'stairs';
        return;
      }
    }
    if (enemy.wallTurnPending) {
      enemy.wallTurnPending = false;
      enemy.stairIntent = null;
      if (this.raiseEnemyStress(enemy)) return;
      enemy.moveDirection = -(enemy.moveDirection ?? enemy.direction);
      return;
    }
    const movementDirection = enemy.moveDirection ?? enemy.direction;
    enemy.x += movementDirection * enemy.speed;
    enemy.walkCounter = (enemy.walkCounter + 1) & 0xff;
    enemy.frame = (enemy.walkCounter >> 2) & 7;
    const hitsWall = this.enemyHitsWalkingObstacle(enemy, level);
    if (hitsWall) {
      enemy.stairIntent = null;
      if (enemy.y >= 8 && this.enemyCanJump(enemy, level)) {
        if (this.raiseEnemyStress(enemy)) return;
        this.startEnemyJump(enemy);
      } else enemy.wallTurnPending = true;
    } else if (enemy.stress !== 0xf0 && (this.timer & 0x1f) === 0) {
      enemy.stress = (enemy.stress - 1) & 0xff;
    }
    if (!hitsWall) this.avoidEnemySurprise(enemy, player);
  }

  enemyHitsWalkingObstacle(enemy, level) {
    const x = Math.floor(enemy.x);
    const tileOffset = x & 7;
    if (tileOffset !== 0 && tileOffset !== 4) return false;
    const family = tileOffset === 0 ? 0x50 : 0x10;
    const movementDirection = enemy.moveDirection ?? enemy.direction;
    const sampleX = movementDirection < 0 ? x : x + (tileOffset === 0 ? 8 : 16);
    return (mapIdAt(level, sampleX, enemy.y) & 0xf0) === family
      || (mapIdAt(level, sampleX, enemy.y + 8) & 0xf0) === family;
  }

  startEnemyThinking(enemy) {
    enemy.movementState = 'thinking';
    enemy.thinkTimer = ENEMY_HESITATIONS[enemy.type ?? 0] ?? 3;
  }

  updateEnemyThinking(enemy, level, player) {
    if (enemy.thinkTimer > 0) {
      enemy.frame = 2;
      enemy.direction = enemy.thinkTimer & 1 ? -1 : 1;
      if ((this.timer & 0x1f) !== 0) return;
      enemy.thinkTimer--;
      if (enemy.thinkTimer > 0) return;
    }
    const nearbyStairs = {
      up: this.findNearbyStairIntent(enemy, level, -1),
      down: this.findNearbyStairIntent(enemy, level, 1),
    };
    const playerY = player.y + (player.onLadder ? 2 : 0);
    const verticalDifference = playerY - enemy.y;
    enemy.relativePosition = verticalDifference < -9 ? 2 : verticalDifference > 9 ? 1 : 0;
    if (verticalDifference < -9) {
      if (nearbyStairs.up) {
        enemy.stairIntent = nearbyStairs.up;
        enemy.moveDirection = nearbyStairs.up.targetX < enemy.x ? -1 : 1;
      }
    } else if (verticalDifference > 9) {
      if (nearbyStairs.down) {
        enemy.stairIntent = nearbyStairs.down;
        enemy.moveDirection = nearbyStairs.down.targetX < enemy.x ? -1 : 1;
      }
    }
    else {
      enemy.moveDirection = player.x - 1 < enemy.x ? -1 : 1;
      enemy.direction = enemy.moveDirection;
      enemy.stairIntent = this.enemyPathBlocked(enemy, level, player)
        ? nearbyStairs.down || ((this.timer & 2) ? nearbyStairs.up : null)
        : null;
      if (enemy.stairIntent) enemy.moveDirection = enemy.stairIntent.targetX < enemy.x ? -1 : 1;
    }
    enemy.walkTimer = 5;
    enemy.movementState = 'walking';
  }

  avoidEnemySurprise(enemy, player) {
    const enemyRoom = Math.floor(enemy.x / 256);
    const playerRoom = Math.floor(player.x / 256);
    if (enemyRoom === playerRoom) return;
    const enemyX = Math.floor(enemy.x) & 0xff;
    const playerX = Math.floor(player.x) & 0xff;
    if (enemyX < 0x50 && playerRoom === enemyRoom - 1 && playerX >= 0xb0) enemy.moveDirection = enemy.direction = 1;
    else if (enemyX >= 0xb0 && playerRoom === enemyRoom + 1 && playerX < 0x50) enemy.moveDirection = enemy.direction = -1;
  }

  enemyPathBlocked(enemy, level, player) {
    const playerX = player.x - 1;
    const playerY = player.y + (player.onLadder ? 2 : 0);
    const direction = (enemy.moveDirection ?? enemy.direction) < 0 ? -1 : 1;
    const row = Math.floor(enemy.y / 8);
    const playerRow = Math.floor(playerY / 8);
    const playerColumn = Math.floor(playerX / 8);
    let column = Math.floor(enemy.x / 8);
    for (let distance = 0; distance < 32; distance++) {
      if (row === playerRow && column === playerColumn) return false;
      if (((level.mapIds?.[row]?.[column] || 0) & 0xf0) === 0x10) return true;
      column += direction;
      if (column < 0 || column >= level.width) return false;
    }
    return false;
  }

  raiseEnemyStress(enemy) {
    enemy.stress = ((enemy.stress & 0xf0) + 0x1f) & 0xff;
    if (enemy.stress !== 0xaf) return false;
    enemy.phase = 'exploding';
    enemy.timer = 0x22;
    enemy.frame = 10;
    enemy.stairIntent = null;
    return true;
  }

  handleEnemyPlatformEdge(enemy, level, player) {
    const x = Math.floor(enemy.x);
    const fraction = enemy.x - x;
    enemy.x = (((x & 7) < 4 ? x + 4 : x) & ~3) + fraction;
    enemy.stairIntent = null;
    const type = enemy.type ?? 0;
    const mummyIsAbovePlayer = enemy.y < player.y - 9;
    if (type === 0 || type === 3 || mummyIsAbovePlayer || enemy.y < 8 || !this.enemyCanJump(enemy, level)) {
      this.startEnemyFall(enemy);
      this.updateEnemyFall(enemy, level);
      return;
    }
    this.startEnemyJump(enemy);
  }

  startEnemyJump(enemy) {
    enemy.movementState = 'jumping';
    enemy.jumpIndex = 0;
    enemy.jumpFalling = false;
    enemy.jumpDirection = 0;
    enemy.frame = 2;
  }

  updateEnemyJump(enemy, level) {
    const movementDirection = enemy.moveDirection ?? enemy.direction;
    enemy.x += movementDirection;
    let movement;
    if (!enemy.jumpFalling) {
      movement = -ENEMY_JUMP[enemy.jumpIndex++];
      if (enemy.jumpIndex >= ENEMY_JUMP.length) {
        enemy.jumpFalling = true;
        enemy.jumpDirection = 1;
        enemy.jumpIndex = ENEMY_JUMP.length - 1;
      }
    } else if (enemy.jumpIndex >= 0) {
      movement = ENEMY_JUMP[enemy.jumpIndex--];
    } else {
      movement = 4;
    }
    enemy.y += movement;
    if ((Math.floor(enemy.x) & 7) === 4) {
      const frontX = enemy.x + (movementDirection < 0 ? 3 : 12);
      if (isSolid(level, frontX, enemy.y) || isSolid(level, frontX, enemy.y + 8) || isSolid(level, frontX, enemy.y + 14)) {
        enemy.y = Math.floor(enemy.y / 8) * 8;
        this.startEnemyFall(enemy);
        this.updateEnemyFall(enemy, level);
        return;
      }
    }
    if (enemy.jumpFalling && this.enemyIsStanding(enemy, level)) this.finishEnemyLanding(enemy);
  }

  startEnemyFall(enemy) {
    enemy.movementState = 'falling';
    enemy.jumpIndex = -1;
    enemy.jumpFalling = false;
  }

  updateEnemyFall(enemy, level) {
    enemy.y = Math.floor(enemy.y / 4) * 4;
    if (this.enemyIsStanding(enemy, level)) {
      this.finishEnemyLanding(enemy);
      return;
    }
    enemy.y += 4;
  }

  finishEnemyLanding(enemy) {
    enemy.y = Math.floor(enemy.y / 8) * 8;
    enemy.movementState = 'walking';
    enemy.jumpIndex = -1;
    enemy.jumpFalling = false;
  }

  enemyCanJump(enemy, level) {
    if (isSolid(level, enemy.x + 4, enemy.y - 2) || isSolid(level, enemy.x + 10, enemy.y - 2)) return false;
    const movementDirection = enemy.moveDirection ?? enemy.direction;
    const frontX = enemy.x + (movementDirection < 0 ? 3 : 12);
    if (!isSolid(level, frontX, enemy.y + 4)) return !isSolid(level, frontX, enemy.y - 4);
    return !isSolid(level, frontX, enemy.y - 4) && !isSolid(level, frontX, enemy.y - 12) && !isSolid(level, enemy.x + 8, enemy.y - 12);
  }

  enemyIsStanding(enemy, level) {
    return isSolid(level, enemy.x + 6, enemy.y + 17) || isSolid(level, enemy.x + 10, enemy.y + 17);
  }

  updateEnemyStair(enemy, level) {
    const pauseMask = STAIR_PAUSE_MASKS[enemy.type ?? 0] ?? 3;
    if (this.timer & pauseMask) {
      enemy.walkCounter = (enemy.walkCounter + 1) & 0xff;
      enemy.frame = (enemy.walkCounter >> 2) & 7;
      return;
    }
    if (isStairExit(level, enemy.x, enemy.y)) {
      enemy.movementState = 'walking';
      enemy.walkTimer = 0;
      return;
    }
    const movementDirection = enemy.moveDirection ?? enemy.direction;
    enemy.x += movementDirection;
    enemy.y += movementDirection === enemy.stairDirection ? -1 : 1;
    enemy.walkCounter = (enemy.walkCounter + 2) & 0xff;
    enemy.frame = (enemy.walkCounter >> 2) & 7;
  }

  findStairIntent(enemy, level, player) {
    const verticalDifference = player.y - enemy.y;
    if (verticalDifference >= -9 && verticalDifference <= 9) return null;
    return this.findNearbyStairIntent(enemy, level, verticalDifference < 0 ? -1 : 1);
  }

  findNearbyStairIntent(enemy, level, verticalDirection) {
    const centerColumn = Math.floor((enemy.x + 8) / 8);
    const row = Math.floor((enemy.y + 8) / 8);
    let best = null;
    const movementDirection = enemy.moveDirection ?? enemy.direction;
    for (const direction of [movementDirection, -movementDirection]) {
      for (let index = 0; index < 5; index++) {
        const distance = index;
        const column = centerColumn + direction * (index + 2);
        const mapId = level.mapIds?.[row]?.[column] || 0;
        if ((mapId & 0xf0) === 0x10) break;
        const below = level.mapIds?.[row + 1]?.[column] || 0;
        const stopAtDrop = (below & 0xf0) === 0;
        let found = verticalDirection < 0
          ? (mapId & 0xf0) === 0x20 || ((mapId & 0xf0) === 0x30 && mapId !== 0x30)
          : false;
        if (verticalDirection > 0) {
          found = stopAtDrop || (below & 0x0f) >= 5;
        }
        if (found && distance !== 0 && (!best || best.distance < distance)) {
          best = { targetX: column * 8 - 8, verticalDirection, distance };
        }
        if (stopAtDrop && (enemy.type ?? 0) === 0) break;
      }
    }
    return best;
  }

  stairPathBlocked(level, enemy, targetX) {
    const direction = Math.sign(targetX - enemy.x);
    if (!direction) return false;
    for (let x = enemy.x; direction > 0 ? x < targetX : x > targetX; x += direction * 4) {
      if (isSolid(level, x + (direction > 0 ? 12 : 2), enemy.y + 8)) return true;
    }
    return false;
  }

  updateFlyingKnife(knife, level) {
    knife.x += knife.direction * 2;
    const leadingX = knife.x + (knife.direction > 0 ? 8 : -1);
    if (!isKnifeObstacle(level, leadingX, knife.y + 4)) return;
    knife.direction *= -1;
    knife.x = Math.floor(knife.x / 8) * 8;
    knife.state = 'bouncing';
    knife.bounceStep = 0;
    knife.tick = 0;
  }

  startKnifeBounce(knife) {
    knife.direction *= -1;
    knife.x = knife.direction > 0 ? Math.floor((knife.x + 4) / 8) * 8 : Math.floor(knife.x / 8) * 8;
    knife.state = 'bouncing';
    knife.bounceStep = 0;
    knife.tick = 0;
  }

  updateBouncingKnife(knife, level, landKnife) {
    knife.tick = (knife.tick + 1) & 3;
    if (knife.tick !== 0) return;
    knife.x += knife.direction;
    knife.y += KNIFE_BOUNCE[knife.bounceStep];
    const below = mapIdAt(level, knife.x + 4, knife.y + 8);
    if (isKnifeBlockingId(below)) {
      if ((below & 0xf0) === 0x10) {
        this.landKnife(knife, landKnife);
        return;
      }
      knife.bounceStep = 0;
      return;
    }
    knife.bounceStep++;
    if (knife.bounceStep >= KNIFE_BOUNCE.length) {
      knife.state = 'falling';
      knife.tick = 0;
    }
  }

  updateFallingKnife(knife, level, landKnife) {
    knife.tick = (knife.tick + 1) & 3;
    if (knife.tick !== 0) return;
    knife.y &= ~3;
    const below = mapIdAt(level, knife.x + 4, knife.y + 8);
    if (isKnifeBlockingId(below)) {
      if ((below & 0xf0) === 0x10) this.landKnife(knife, landKnife);
      else {
        knife.state = 'bouncing';
        knife.bounceStep = 0;
        knife.tick = 0;
      }
      return;
    }
    knife.y += 4;
  }

  landKnife(knife, landKnife) {
    landKnife({ x: Math.floor(knife.x / 8) * 8, y: Math.floor(knife.y / 8) * 8 });
    knife.life = 0;
  }

  hitEnemyWithKnife(knife, scoreCallback, sound) {
    for (const enemy of this.enemies) {
      if (!enemy.alive || enemy.phase !== 'active' || Math.abs(enemy.x - knife.x) >= 12 || Math.abs(enemy.y - knife.y) >= 12) continue;
      enemy.phase = 'exploding';
      enemy.timer = 0x22;
      enemy.frame = 10;
      knife.state = 'collided';
      scoreCallback(100);
      sound.playEvent(0x08);
      return;
    }
  }

  updateEnemyPhase(enemy, sound) {
    if (enemy.phase === 'active') return true;
    if (enemy.phase === 'limbo') {
      enemy.visible = false;
      enemy.phaseTick ^= 1;
      if (enemy.phaseTick) return false;
      if (--enemy.timer <= 0) {
        enemy.phase = 'appearing';
        enemy.timer = 0x82;
        enemy.frame = 9;
        enemy.visible = true;
        sound.playEvent(0x87);
      }
      return false;
    }
    if (enemy.phase === 'appearing') {
      enemy.visible = true;
      enemy.timer--;
      if (enemy.timer <= 0) {
        enemy.phase = 'active';
        enemy.frame = 2;
        enemy.moveDirection = enemy.direction = 1;
        enemy.movementState = 'walking';
        enemy.stairDirection = 0;
        enemy.stairIntent = null;
        enemy.walkTimer = 0;
        enemy.thinkTimer = 0;
        enemy.jumpIndex = -1;
        enemy.jumpFalling = false;
        enemy.jumpDirection = 0;
        enemy.wallTurnPending = false;
        return false;
      }
      if (enemy.timer < 7) enemy.frame = 2;
      else if ((enemy.timer & 0x1f) === 0) enemy.frame = enemy.timer & 0x20 ? 9 : 8;
      return false;
    }
    if (enemy.phase === 'exploding') {
      enemy.visible = true;
      enemy.frame = 10;
      if (--enemy.timer <= 0) {
        enemy.phase = 'limbo';
        enemy.timer = 0x80;
        enemy.visible = false;
      }
      return false;
    }
    return false;
  }

  activateAll() {
    for (const enemy of this.enemies) {
      enemy.phase = 'active';
      enemy.timer = 0;
      enemy.phaseTick = 0;
      enemy.visible = true;
      enemy.frame = 2;
      enemy.movementState = 'walking';
      enemy.stairDirection = 0;
      enemy.stairIntent = null;
      enemy.walkTimer = 0;
      enemy.walkCounter = 0;
      enemy.thinkTimer = 0;
      enemy.jumpIndex = -1;
      enemy.jumpFalling = false;
      enemy.jumpDirection = 0;
      enemy.wallTurnPending = false;
      enemy.stress = 0;
    }
  }
}

const KNIFE_BOUNCE = [-5, -2, -1, 0, 0, 1, 2, 5];

function isKnifeObstacle(level, worldX, worldY) {
  const mapId = mapIdAt(level, worldX, worldY);
  const family = mapId & 0xf0;
  return family === 0x10 || family === 0x30 || family === 0x50 || family === 0x80;
}

function isKnifeBlockingId(mapId) {
  const family = mapId & 0xf0;
  return family === 0x10 || family === 0x30 || family === 0x50 || family === 0x80;
}

function isKnifeObstacleId(mapId) {
  const family = mapId & 0xf0;
  return family === 0x10 || family === 0x30 || family === 0x40 || family === 0x50 || family === 0x80;
}
