export const UP = 1;
export const DOWN = 2;
export const LEFT = 4;
export const RIGHT = 8;
export const ACTION = 16;

const bindings = new Map([
  ['ArrowUp', UP], ['KeyW', UP], ['ArrowDown', DOWN], ['KeyS', DOWN],
  ['ArrowLeft', LEFT], ['KeyA', LEFT], ['ArrowRight', RIGHT], ['KeyD', RIGHT],
  ['Space', ACTION],
]);

export class Input {
  constructor() {
    this.heldKeys = new Set();
    this.pressedKeys = new Set();
  }

  attach(target) {
    const keyDown = (event) => {
      if (bindings.has(event.code) || event.code === 'Escape' || event.code === 'F1' || event.code === 'F2' || event.code === 'Backquote' || /^Digit[0-9]$/.test(event.code) || /^Numpad[0-9]$/.test(event.code)) event.preventDefault();
      if (!this.heldKeys.has(event.code)) this.pressedKeys.add(event.code);
      this.heldKeys.add(event.code);
    };
    const keyUp = (event) => this.heldKeys.delete(event.code);
    const clear = () => { this.heldKeys.clear(); this.pressedKeys.clear(); };
    const blur = clear;
    const visibilityTarget = target.document || target;
    const visibilityChange = () => {
      if (visibilityTarget.visibilityState === 'hidden') clear();
    };
    target.addEventListener('keydown', keyDown);
    target.addEventListener('keyup', keyUp);
    target.addEventListener('blur', blur);
    visibilityTarget.addEventListener('visibilitychange', visibilityChange);
    return () => {
      target.removeEventListener('keydown', keyDown);
      target.removeEventListener('keyup', keyUp);
      target.removeEventListener('blur', blur);
      visibilityTarget.removeEventListener('visibilitychange', visibilityChange);
    };
  }

  controls() {
    let result = 0;
    for (const code of this.heldKeys) result |= bindings.get(code) || 0;
    return result;
  }

  held(mask) { return (this.controls() & mask) !== 0; }
  heldKey(code) { return this.heldKeys.has(code); }
  pressed(code) { return this.pressedKeys.has(code); }
  actionPressed() { return this.pressed('Space'); }
  anyPressed() { return this.pressedKeys.size > 0; }
  endFrame() { this.pressedKeys.clear(); }
}
