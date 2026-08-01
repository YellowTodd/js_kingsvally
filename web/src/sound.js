import { PsgAudio } from './audio.js';
import { KingsValleyPsg } from './psg.js';

export class Sound {
  constructor(romBytes) {
    this.engine = new KingsValleyPsg(romBytes);
    this.audio = null;
    this.muted = false;
    this.log = [];
  }

  attach(target) {
    const start = () => {
      if (!this.audio) {
        try {
          this.audio = new PsgAudio();
          this.audio.setMuted(this.muted);
          this.audio.update(this.engine.regs);
        } catch {
          return;
        }
      }
      if (this.audio.context.state === 'suspended') this.audio.context.resume();
      target.removeEventListener('keydown', start);
      target.removeEventListener('pointerdown', start);
      target.removeEventListener('touchstart', start);
    };
    const visibilityTarget = target.document || target;
    const resume = () => {
      if (this.audio?.context.state === 'suspended') this.audio.context.resume();
    };
    target.addEventListener('keydown', start);
    target.addEventListener('pointerdown', start);
    target.addEventListener('touchstart', start);
    visibilityTarget.addEventListener('visibilitychange', resume);
  }

  setMusic(id) {
    this.log.push(id & 0xff);
    this.engine.setMusic(id);
  }

  playMusic(id) {
    this.setMusic(id);
  }

  playEvent(id) {
    this.setMusic(id);
  }

  isPlaying() {
    return this.engine.channels.some((channel) => channel.id !== 0);
  }

  beep() {}

  stopAll() {
    this.engine.stopAll();
  }

  beginTrace() {
    return this.engine.beginTrace();
  }

  endTrace() {
    return this.engine.endTrace();
  }

  snapshot() {
    return this.engine.snapshot();
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.audio) this.audio.setMuted(this.muted);
  }

  tick() {
    this.engine.tick();
    if (this.audio) this.audio.update(this.engine.regs);
  }
}
