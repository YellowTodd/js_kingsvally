export class GameState {
  constructor() {
    this.mode = 'splash';
    this.frame = 0;
    this.stage = 1;
    this.score = 0;
    this.record = 0;
    this.lives = 5;
    this.completedRuns = 0;
    this.bestStage = 1;
    this.clearedStages = new Set();
    this.messageTimer = 0;
    this.transitionFrame = 0;
    this.mapFrame = 0;
    this.mapOriginStage = 1;
    this.mapDestinationStage = 1;
    this.mapExitDirection = 1;
    this.mapEntranceDirection = 1;
    this.mapGoalWait = 0;
    this.endingPhase = 'curtain';
    this.endingPhaseFrame = 0;
    this.endingWait = 0;
    this.endingTextVisible = false;
    this.endingPlayer = null;
    this.menuWait = 0x100;
    this.demoReplay = null;
    this.level = null;
    this.paused = false;
    this.debugMode = false;
  }
}
