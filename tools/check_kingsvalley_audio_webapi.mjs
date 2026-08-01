import { ROM_BYTES } from '../web/src/game/rom.js';
import { Sound } from '../web/src/sound.js';

class FakeParam {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
}

class FakeNode {
  connect() { return this; }
}

class FakeGain extends FakeNode {
  constructor() { super(); this.gain = new FakeParam(); }
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = new FakeNode();
  }

  createGain() { return new FakeGain(); }
  createBiquadFilter() { return Object.assign(new FakeNode(), { frequency: new FakeParam(), Q: new FakeParam(), type: '' }); }
  createBuffer(channels, length) { return { getChannelData() { return new Float32Array(length); } }; }
  createBufferSource() { return Object.assign(new FakeNode(), { playbackRate: new FakeParam(1), start() {}, buffer: null, loop: false }); }
  createConstantSource() { return Object.assign(new FakeNode(), { offset: new FakeParam(), start() {} }); }
  createOscillator() { return Object.assign(new FakeNode(), { frequency: new FakeParam(), start() {}, type: '' }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  dispatch(type) { this.listeners.get(type)?.({ code: 'Space', preventDefault() {} }); }
}

globalThis.AudioContext = FakeAudioContext;
const target = new FakeTarget();
const sound = new Sound(ROM_BYTES);
sound.attach(target);
target.dispatch('keydown');
if (!sound.audio || sound.audio.context.state !== 'running') throw new Error('AudioContext did not resume from input');
sound.setMusic(0x97);
sound.tick();
if (!sound.audio.channels.some(channel => channel.amplitude.gain.value > 0)) throw new Error('PSG output did not reach WebAudio nodes');
sound.setMuted(true);
if (sound.audio.master.gain.value !== 0) throw new Error('WebAudio mute was not applied');
sound.stopAll();
sound.tick();
if (sound.audio.channels.some(channel => channel.amplitude.gain.value !== 0)) throw new Error('PSG stop did not silence WebAudio nodes');

console.log(JSON.stringify({ context: sound.audio.context.state, musicId: sound.snapshot().channels[0].id, muted: sound.audio.master.gain.value === 0 }, null, 2));
