import { DOWN, LEFT, RIGHT, UP } from '../input.js';
import { isSolid, isStairExit, mapIdAt, stairEntryAt } from './data.js';

export class Player {
  constructor(start = {}) {
    this.start = { x: start.x ?? 40, y: start.y ?? 150, direction: start.direction ?? 1 };
    this.x = this.start.x;
    this.y = this.start.y;
    this.velocityY = 0;
    this.xFraction = 0;
    this.jumpIndex = -1;
    this.jumpFalling = false;
    this.jumpDirection = 0;
    this.falling = false;
    this.fallingPending = false;
    this.direction = this.start.direction;
    this.onGround = false;
    this.onLadder = false;
    this.stairDirection = 0;
    this.movementTimer = 0;
    this.walkCounter = 1;
    this.frame = 0;
    this.invulnerable = 0;
    this.item = null;
    this.blockedAt = null;
  }

  reset() {
    this.x = this.start.x;
    this.y = this.start.y;
    this.velocityY = 0;
    this.xFraction = 0;
    this.jumpIndex = -1;
    this.jumpFalling = false;
    this.jumpDirection = 0;
    this.falling = false;
    this.fallingPending = false;
    this.onGround = false;
    this.onLadder = false;
    this.stairDirection = 0;
    this.movementTimer = 0;
    this.walkCounter = 1;
    this.frame = 4;
    this.invulnerable = 90;
    this.item = null;
    this.blockedAt = null;
    this.direction = this.start.direction;
  }

  update(level, controls, jumpPressed) {
    this.blockedAt = null;
    this.movementTimer = (this.movementTimer + 1) & 0xff;
    const horizontal = (controls & RIGHT ? 1 : 0) - (controls & LEFT ? 1 : 0);
    if (this.jumpIndex >= 0) {
      if (this.jumpDirection) {
        this.x += this.jumpDirection;
        this.direction = this.jumpDirection;
      }
      this.updateJump(level);
      if (this.jumpDirection && this.jumpIndex >= 0 && this.jumpHitsSide(level, this.jumpDirection)) this.stopJumpAtWall(level);
    } else if (this.onLadder) {
      this.updateStair(level, horizontal);
    } else {
      this.onGround = this.isStanding(level);
      if (!this.onGround) {
        if (!this.falling) {
          if (!this.fallingPending) {
            this.fallingPending = true;
            this.finishFrame(level);
            return;
          }
          this.fallingPending = false;
          if ((this.x & 7) < 4) this.x += 4;
          this.x &= 0xfc;
          this.falling = true;
        }
        this.y += 4;
        if (this.isStanding(level)) {
          this.y = Math.floor((this.y + 17) / 8) * 8 - 16;
          this.onGround = true;
          this.falling = false;
          this.fallingPending = false;
        }
        this.finishFrame(level);
        return;
      }
      this.falling = false;
      this.fallingPending = false;
      if (jumpPressed && this.onGround) {
        if (horizontal) this.direction = horizontal;
        if (this.canStartJump(level, horizontal)) {
          this.jumpIndex = 0;
          this.jumpFalling = false;
          this.jumpDirection = horizontal;
          this.onGround = false;
          this.frame = 8;
        }
        this.finishFrame(level);
        return;
      }
      if (!this.tryEnterStair(level, controls)) {
        let movement = 0;
        const obstacle = horizontal ? this.walkingObstacle(level, horizontal) : null;
        if (horizontal && !obstacle) {
          this.xFraction += horizontal * 0xa8;
          movement = this.xFraction >> 8;
          this.xFraction -= movement << 8;
          this.x += movement;
        }
        if (horizontal) {
          this.walkCounter = (this.walkCounter + 1) & 0xff;
          this.direction = horizontal;
          if (obstacle) this.blockedAt = obstacle;
          this.frame = this.walkCounter & 0x1f;
        } else this.frame = 4;
      }
    }
    this.finishFrame(level);
  }

  tryEnterStair(level, controls) {
    if ((controls & (UP | DOWN)) === 0) return false;
    const entry = stairEntryAt(level, this.x, this.y, controls & UP ? -1 : 1);
    if (!entry) return false;
    this.stairDirection = entry.ascentDirection;
    this.y += entry.yOffset;
    this.onLadder = true;
    this.onGround = false;
    this.velocityY = 0;
    return true;
  }

  updateStair(level, horizontal) {
    this.velocityY = 0;
    this.onGround = false;
    if (!horizontal) return;
    this.direction = horizontal;
    if (this.movementTimer & 1) return;
    if (isStairExit(level, this.x, this.y)) {
      this.onLadder = false;
      this.stairDirection = 0;
      this.onGround = true;
      return;
    }
    this.x += horizontal;
    this.y += horizontal === this.stairDirection ? -1 : 1;
    this.walkCounter = (this.walkCounter + 1) & 0xff;
    this.frame = this.walkCounter & 0x1f;
  }

  isStanding(level, y = this.y) {
    return isSolid(level, this.x + 6, y + 17) || isSolid(level, this.x + 10, y + 17);
  }

  sideBlocked(level, direction, y = this.y) {
    const collisionX = this.x + (direction > 0 ? 12 : 3);
    return isSolid(level, collisionX, y) || isSolid(level, collisionX, y + 8);
  }

  walkingObstacle(level, direction) {
    const x = Math.floor(this.x);
    const tileOffset = x & 7;
    if (tileOffset !== 0 && tileOffset !== 4) return null;
    const family = tileOffset === 0 ? 0x50 : 0x10;
    const collisionX = direction < 0 ? x : x + (tileOffset === 0 ? 8 : 16);
    for (const collisionY of [this.y, this.y + 8]) {
      const mapId = mapIdAt(level, collisionX, collisionY);
      if ((mapId & 0xf0) === family) return { x: collisionX, y: collisionY, mapId };
    }
    return null;
  }

  canStartJump(level, horizontal) {
    if (this.y <= 0) return false;
    if (isSolid(level, this.x + 4, this.y - 2) || isSolid(level, this.x + 10, this.y - 2)) return false;
    if (!horizontal) return true;
    const edgeX = this.x + (horizontal < 0 ? 3 : 12);
    if (!isSolid(level, edgeX, this.y + 4)) return !isSolid(level, edgeX, this.y - 4);
    return !isSolid(level, edgeX, this.y - 4)
      && !isSolid(level, edgeX, this.y - 12)
      && !isSolid(level, this.x + 8, this.y + 4);
  }

  updateJump(level) {
    const jumpSteps = [4, 2, 2, 2, 1, 1, 2, 0, 1, 1, 0, 0];
    let movement;
    if (!this.jumpFalling) {
      movement = -jumpSteps[this.jumpIndex++];
      if (this.jumpIndex >= jumpSteps.length) {
        this.jumpFalling = true;
        this.jumpIndex = jumpSteps.length - 1;
      }
    } else if (this.jumpIndex >= 0) {
      movement = jumpSteps[this.jumpIndex--];
    } else {
      movement = 4;
    }
    const nextY = this.y + movement;
    if (movement >= 0 && this.isStanding(level, nextY)) {
      this.y = Math.floor((nextY + 17) / 8) * 8 - 16;
      this.jumpIndex = -1;
      this.jumpFalling = false;
      this.jumpDirection = 0;
      this.onGround = true;
      this.falling = false;
      this.fallingPending = false;
      this.frame = 4;
      return;
    }
    this.y = nextY;
    this.velocityY = movement;
  }

  jumpHitsSide(level, direction) {
    if ((Math.floor(this.x) & 7) !== 4) return false;
    const collisionX = this.x + (direction < 0 ? 3 : 12);
    const topBlocked = isSolid(level, collisionX, this.y);
    if (topBlocked && isSolid(level, collisionX, this.y + 20)) return true;
    return isSolid(level, collisionX, this.y + 8) || isSolid(level, collisionX, this.y + 14);
  }

  stopJumpAtWall(level) {
    this.y &= 0xf8;
    this.jumpIndex = -1;
    this.jumpFalling = false;
    this.jumpDirection = 0;
    this.falling = !this.isStanding(level);
    this.fallingPending = false;
    this.onGround = !this.falling;
    this.frame = 4;
  }

  finishFrame(level) {
    this.x = Math.max(0, Math.min(level.width * 8 - 12, this.x));
    this.y = Math.max(0, Math.min(176, this.y));
    if (this.invulnerable > 0) this.invulnerable--;
  }
}
