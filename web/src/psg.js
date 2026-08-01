const ROM_BASE = 0x4000;
const MUSIC_INDEX = 0x7cf5;
const NOTE_PERIODS = [0x6a, 0x64, 0x5f, 0x59, 0x54, 0x50, 0x4b, 0x47, 0x43, 0x3f, 0x3c, 0x38, 0x39];

function makeChannel() {
  return {
    count: 0, duration: 1, id: 0, pointer: 0, octave: 0, channelVolume: 0,
    volume: 0, fadeCounter: 0, loopCount: 0, tempo: 1, chorus: 0,
    fadeDelay: 0, fadeThreshold: 0,
  };
}

export class KingsValleyPsg {
  constructor(romBytes) {
    this.rom = romBytes;
    this.ram = new Uint8Array(0x10000);
    this.regs = new Uint8Array(16);
    this.mixer = 0xb8;
    this.regs[7] = this.mixer;
    this.channels = [makeChannel(), makeChannel(), makeChannel()];
    this.fallFrequency = 0x61b0;
    this.fallInitialized = false;
    this.frame = 0;
    this.trace = null;
    this.currentWrites = null;
  }

  byte(address) {
    const index = address - ROM_BASE;
    if (index >= 0 && index < this.rom.length) return this.rom[index];
    if (address >= 0xe000 && address < this.ram.length) return this.ram[address];
    return 0xff;
  }

  word(address) {
    return this.byte(address) | (this.byte(address + 1) << 8);
  }

  setMusic(requestedId) {
    const fullId = requestedId & 0xff;
    const number = fullId & 0x3f;
    let firstChannel = 0;
    let channelCount = 2;
    if (number < 0x0b) {
      firstChannel = 2;
      channelCount = 1;
    } else if (number >= 0x11) {
      channelCount = 3;
    }
    if (number < (this.channels[firstChannel].id & 0x3f)) return false;
    let pointerTable = MUSIC_INDEX + (number - 1) * 2;
    for (let index = 0; index < channelCount; index++) {
      const channel = this.channels[firstChannel + index];
      channel.count = 1;
      channel.duration = 1;
      channel.id = fullId;
      channel.pointer = this.word(pointerTable);
      channel.loopCount = 0;
      pointerTable += 2;
    }
    if (number === 1) this.fallInitialized = false;
    return true;
  }

  stopAll() {
    for (const channel of this.channels) channel.id = 0;
    this.mixer = 0xb8;
    this.writeRegister(7, this.mixer);
    this.writeRegister(8, 0);
    this.writeRegister(9, 0);
    this.writeRegister(10, 0);
  }

  tick() {
    this.currentWrites = [];
    this.writeRegister(7, this.mixer);
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
      const channel = this.channels[channelIndex];
      if (!channel.id) continue;
      if ((channel.id & 0x3f) === 1 && channelIndex === 2) this.updateFallingSound(channel);
      this.processChannel(channel, channelIndex);
    }
    this.frame++;
    if (this.trace) this.trace.push({ frame: this.frame, writes: this.currentWrites.map(([register, value]) => [register, value]), registers: [...this.regs] });
    this.currentWrites = null;
  }

  beginTrace() {
    this.trace = [];
    return this.trace;
  }

  endTrace() {
    const trace = this.trace || [];
    this.trace = null;
    return trace;
  }

  snapshot() {
    return { frame: this.frame, registers: [...this.regs], channels: this.channels.map(({ id, count, duration, pointer, volume }) => ({ id, count, duration, pointer, volume })) };
  }

  updateFallingSound(channel) {
    if (!this.fallInitialized) {
      this.ram[0xe03b] = this.byte(0x7b8d);
      this.ram[0xe03c] = this.byte(0x7b8e);
      this.ram[0xe03d] = this.byte(0x7b8f);
      this.ram[0xe03e] = this.byte(0x7b90);
      this.fallInitialized = true;
    } else {
      const next = this.ram[0xe03e] + 8;
      this.ram[0xe03e] = next & 0xff;
      if (next > 0xff) this.ram[0xe03d] = (this.ram[0xe03d] + 1) & 0xff;
    }
    channel.pointer = 0xe03c;
  }

  processChannel(channel, channelIndex) {
    if ((channel.id & 0x40) === 0) this.useTone(channelIndex);
    if (channel.id & 0x80) {
      channel.count = (channel.count - 1) & 0xff;
      if (channel.count === 0) this.nextMusicalToken(channel, channelIndex);
      else this.decayVolume(channel, channelIndex);
      return;
    }
    channel.count = (channel.count - 1) & 0xff;
    if (channel.count === 0) this.nextRawToken(channel, channelIndex);
  }

  nextMusicalToken(channel, channelIndex) {
    for (let guard = 0; guard < 64; guard++) {
      const token = this.byte(channel.pointer);
      if (token === 0xfe) {
        this.patternLoop(channel);
        continue;
      }
      if (token === 0xff) {
        this.endChannel(channel, channelIndex);
        return;
      }
      if ((token & 0xf0) === 0xd0) {
        channel.tempo = token & 0x0f;
        channel.pointer++;
        continue;
      }
      if ((token & 0xf0) === 0xf0) {
        channel.channelVolume = token & 0x0f;
        channel.fadeDelay = this.byte(channel.pointer + 1);
        channel.fadeThreshold = this.byte(channel.pointer + 2);
        channel.pointer += 3;
        continue;
      }
      if ((token & 0xf0) === 0xe0) {
        const value = token & 0x0f;
        if (value & 8) channel.chorus = value;
        else channel.octave = value;
        channel.pointer++;
        continue;
      }
      const note = token >> 4;
      const multiplier = token & 0x0f;
      const duration = (channel.tempo * (multiplier + 1)) & 0xff;
      channel.duration = duration;
      channel.count = duration;
      channel.fadeCounter = (channel.fadeDelay + duration) & 0xff;
      channel.volume = note === 0x0c ? 0 : channel.channelVolume;
      this.writeVolume(channelIndex, channel.volume);
      const base = NOTE_PERIODS[note] ?? 0;
      let period = base << channel.octave;
      if (channel.chorus) period++;
      this.writePeriod(channelIndex, period);
      channel.pointer++;
      return;
    }
    this.endChannel(channel, channelIndex);
  }

  nextRawToken(channel, channelIndex) {
    for (let guard = 0; guard < 64; guard++) {
      let token = this.byte(channel.pointer);
      if (token === 0xfe) {
        this.patternLoop(channel);
        continue;
      }
      if (token === 0xff) {
        this.endChannel(channel, channelIndex);
        return;
      }
      if ((token & 0xf0) === 0x20) {
        channel.duration = token & 0x0f;
        channel.pointer++;
        token = this.byte(channel.pointer);
      }
      if ((token & 0xf0) === 0x10) {
        let noisePeriod = token & 0x1f;
        channel.pointer++;
        token = this.byte(channel.pointer) & 0xef;
        if ((this.byte(channel.pointer) & 0x10) === 0) noisePeriod -= 0x10;
        this.writeRegister(6, noisePeriod & 0x1f);
        this.useNoise(channelIndex);
      }
      if (channel.id & 0x40) {
        channel.pointer++;
        this.setRawDuration(channel, channelIndex, token & 0x0f);
        return;
      }
      const period = ((token & 0x0f) << 8) | this.byte(channel.pointer + 1);
      channel.pointer += 2;
      this.writePeriod(channelIndex, period);
      this.setRawDuration(channel, channelIndex, token >> 4);
      return;
    }
    this.endChannel(channel, channelIndex);
  }

  setRawDuration(channel, channelIndex, volume) {
    channel.count = channel.duration;
    channel.fadeCounter = (channel.fadeDelay + channel.count) & 0xff;
    channel.volume = volume & 0x0f;
    this.writeVolume(channelIndex, channel.volume);
  }

  patternLoop(channel) {
    const repetitions = this.byte(channel.pointer + 1);
    const nextCount = (channel.loopCount + 1) & 0xff;
    if (repetitions !== 0xff && nextCount === repetitions) {
      channel.pointer += 4;
      channel.loopCount = 0;
    } else {
      channel.loopCount = nextCount;
      channel.pointer = this.word(channel.pointer + 2);
    }
    channel.count = (channel.count + 1) & 0xff;
  }

  decayVolume(channel, channelIndex) {
    channel.fadeCounter = (channel.fadeCounter - 1) & 0xff;
    let shouldDecay = channel.fadeCounter !== channel.count;
    if (!shouldDecay) shouldDecay = channel.fadeThreshold >= channel.count;
    else channel.fadeCounter = (channel.fadeCounter - 1) & 0xff;
    if (!shouldDecay || channel.volume === 0) return;
    channel.volume--;
    this.writeVolume(channelIndex, channel.volume);
  }

  endChannel(channel, channelIndex) {
    channel.loopCount = 0;
    channel.chorus = 0;
    channel.id = 0;
    this.useTone(channelIndex);
    channel.volume = 0;
    this.writeVolume(channelIndex, 0);
  }

  useTone(channelIndex) {
    if (channelIndex !== 2) return;
    this.mixer = 0xb8;
    this.writeRegister(7, this.mixer);
  }

  useNoise(channelIndex) {
    if (channelIndex !== 2) return;
    this.mixer = 0x9c;
    this.writeRegister(7, this.mixer);
  }

  writePeriod(channelIndex, period) {
    this.writeRegister(channelIndex * 2 + 1, (period >> 8) & 0x0f);
    this.writeRegister(channelIndex * 2, period & 0xff);
  }

  writeVolume(channelIndex, volume) {
    this.writeRegister(8 + channelIndex, volume & 0x0f);
  }

  writeRegister(register, value) {
    const normalized = value & 0xff;
    this.regs[register] = normalized;
    if (this.currentWrites) this.currentWrites.push([register, normalized]);
  }
}
