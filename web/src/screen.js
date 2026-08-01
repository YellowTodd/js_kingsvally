export const SCREEN_W = 256;
export const SCREEN_H = 192;
export const COLS = 32;
export const ROWS = 24;
export const NAME_TABLE_BASE = 0x3800;
export const SAT_TERMINATOR = 208;

export const PALETTE = [
  '#000000', '#000000', '#3eb849', '#74d07d',
  '#5955e0', '#8076ff', '#b95e51', '#65dbef',
  '#db6559', '#ff897d', '#ccc35e', '#ded087',
  '#3aa241', '#b766b5', '#cccccc', '#ffffff',
];

const BANK_BYTES = 256 * 8;
const MAX_SPRITES = 32;
const SPRITES_PER_LINE = 4;

export class Screen {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.context.imageSmoothingEnabled = false;
    this.imageData = this.context.createImageData(SCREEN_W, SCREEN_H);
    this.pixels = new Uint32Array(this.imageData.data.buffer);
    this.colorCache = new Map();
    this.patterns = new Uint8Array(3 * BANK_BYTES);
    this.colors = new Uint8Array(3 * BANK_BYTES);
    this.nameTable = new Uint8Array(COLS * ROWS);
    this.spriteGen = new Uint8Array(2048);
    this.sat = new Uint8Array(MAX_SPRITES * 4);
    this.sprites = [];
    this.overlays = [];
    this.spriteLimit = true;
    this.backdrop = 0;
    this.clear(PALETTE[0]);
  }

  clear(color = PALETTE[this.backdrop]) {
    this.sprites.length = 0;
    this.overlays.length = 0;
    this.nameTable.fill(0);
    this.sat.fill(SAT_TERMINATOR);
    this.pixels.fill(this.packColor(color));
  }

  rect(x, y, width, height, color) {
    const operation = { type: 'rect', x: Math.round(x), y: Math.round(y), width, height, color: this.packColor(color) };
    if (this.sprites.length) this.overlays.push(operation);
    else this.drawRect(operation);
  }

  pattern(patternBytes, x, y, foreground, background = PALETTE[this.backdrop]) {
    this.vramTile(patternBytes, new Uint8Array(8).fill((this.paletteIndex(foreground) << 4) | this.paletteIndex(background)), x, y, PALETTE, background);
  }

  vramTile(patternBytes, colorBytes, x, y, palette = PALETTE, backdrop = PALETTE[this.backdrop], patternId = null) {
    const operation = { type: 'tile', patternBytes, colorBytes, x: Math.round(x), y: Math.round(y), palette, backdrop, patternId };
    this.mirrorTile(operation);
    if (this.sprites.length) this.overlays.push(operation);
    else this.drawTile(operation);
  }

  sprite(patternBytes, x, y, color, flip = false) {
    if (this.sprites.length >= MAX_SPRITES) return;
    const slot = this.sprites.length;
    const pattern = flip ? flipSprite(patternBytes) : patternBytes;
    const base = slot * 32;
    this.spriteGen.set(pattern.subarray ? pattern.subarray(0, 32) : pattern.slice(0, 32), base);
    const top = Math.floor(y);
    const left = Math.floor(x);
    const colorIndex = this.paletteIndex(color);
    this.sat[slot * 4] = (top - 1) & 0xff;
    this.sat[slot * 4 + 1] = left & 0xff;
    this.sat[slot * 4 + 2] = slot * 4;
    this.sat[slot * 4 + 3] = colorIndex;
    if (slot + 1 < MAX_SPRITES) this.sat[(slot + 1) * 4] = SAT_TERMINATOR;
    this.sprites.push({ pattern, x: left, y: top, color: this.packColor(color) });
  }

  pixelText(value, x, y, color = PALETTE[15], scale = 1) {
    const glyphs = PIXEL_GLYPHS;
    const packed = this.packColor(color);
    const glyphWidth = 6 * scale;
    for (let charIndex = 0; charIndex < value.length; charIndex++) {
      const glyph = glyphs[value[charIndex].toUpperCase()] || glyphs[' '];
      for (let row = 0; row < glyph.length; row++) {
        for (let column = 0; column < glyph[row].length; column++) {
          if (glyph[row][column] !== '1') continue;
          const operation = { type: 'rect', x: x + charIndex * glyphWidth + column * scale, y: y + row * scale, width: scale, height: scale, color: packed };
          if (this.sprites.length) this.overlays.push(operation);
          else this.drawRect(operation);
        }
      }
    }
  }

  text(value, x, y, color = PALETTE[15], size = 8) {
    this.pixelText(value, x, y, color, Math.max(1, Math.round(size / 8)));
  }

  present() {
    this.drawSprites();
    for (const operation of this.overlays) {
      if (operation.type === 'rect') this.drawRect(operation);
      else this.drawTile(operation);
    }
    this.context.putImageData(this.imageData, 0, 0);
  }

  drawRect({ x, y, width, height, color }) {
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(SCREEN_W, x + width);
    const bottom = Math.min(SCREEN_H, y + height);
    for (let row = top; row < bottom; row++) this.pixels.fill(color, row * SCREEN_W + left, row * SCREEN_W + right);
  }

  drawTile({ patternBytes, colorBytes, x, y, palette, backdrop }) {
    for (let row = 0; row < 8; row++) {
      const screenY = y + row;
      if (screenY < 0 || screenY >= SCREEN_H) continue;
      const bits = patternBytes[row] || 0;
      const attribute = colorBytes[row] || 0;
      const foreground = this.packColor(palette[(attribute >> 4) & 0x0f] || backdrop);
      const background = this.packColor(palette[attribute & 0x0f] || backdrop);
      for (let column = 0; column < 8; column++) {
        const screenX = x + column;
        if (screenX < 0 || screenX >= SCREEN_W) continue;
        this.pixels[screenY * SCREEN_W + screenX] = bits & (0x80 >> column) ? foreground : background;
      }
    }
  }

  drawSprites() {
    const lineCount = new Uint8Array(SCREEN_H);
    const visibleRows = this.sprites.map(() => new Uint8Array(16));
    for (let slot = 0; slot < this.sprites.length; slot++) {
      const sprite = this.sprites[slot];
      for (let row = 0; row < 16; row++) {
        const screenY = sprite.y + row;
        if (screenY < 0 || screenY >= SCREEN_H) continue;
        visibleRows[slot][row] = !this.spriteLimit || lineCount[screenY] < SPRITES_PER_LINE ? 1 : 0;
        lineCount[screenY]++;
      }
    }
    for (let slot = this.sprites.length - 1; slot >= 0; slot--) {
      const sprite = this.sprites[slot];
      for (let row = 0; row < 16; row++) {
        if (!visibleRows[slot][row]) continue;
        const screenY = sprite.y + row;
        for (let half = 0; half < 2; half++) {
          const bits = sprite.pattern[row + half * 16] || 0;
          for (let column = 0; column < 8; column++) {
            if (!(bits & (0x80 >> column))) continue;
            const screenX = sprite.x + half * 8 + column;
            if (screenX >= 0 && screenX < SCREEN_W) this.pixels[screenY * SCREEN_W + screenX] = sprite.color;
          }
        }
      }
    }
  }

  mirrorTile({ patternBytes, colorBytes, x, y, patternId }) {
    if ((x & 7) || (y & 7) || x < 0 || x >= SCREEN_W || y < 0 || y >= SCREEN_H) return;
    const column = x >> 3;
    const row = y >> 3;
    const tile = patternId === null ? ((row & 7) * COLS + column) & 0xff : patternId & 0xff;
    const offset = (row >> 3) * BANK_BYTES + tile * 8;
    this.nameTable[row * COLS + column] = tile;
    for (let index = 0; index < 8; index++) {
      this.patterns[offset + index] = patternBytes[index] || 0;
      this.colors[offset + index] = colorBytes[index] || 0;
    }
  }

  paletteIndex(color) {
    const normalized = String(color).toLowerCase();
    const index = PALETTE.indexOf(normalized);
    return index < 0 ? 15 : index;
  }

  packColor(color) {
    const normalized = String(color).toLowerCase();
    if (this.colorCache.has(normalized)) return this.colorCache.get(normalized);
    const value = normalized.startsWith('#') ? Number.parseInt(normalized.slice(1), 16) : 0;
    const packed = (0xff000000 | ((value & 0xff) << 16) | (value & 0xff00) | ((value >>> 16) & 0xff)) >>> 0;
    this.colorCache.set(normalized, packed);
    return packed;
  }
}

function flipSprite(patternBytes) {
  const output = new Uint8Array(32);
  for (let row = 0; row < 16; row++) {
    output[row] = reverseByte(patternBytes[row + 16] || 0);
    output[row + 16] = reverseByte(patternBytes[row] || 0);
  }
  return output;
}

function reverseByte(value) {
  let output = 0;
  for (let bit = 0; bit < 8; bit++) output |= ((value >> bit) & 1) << (7 - bit);
  return output;
}

const PIXEL_GLYPHS = {
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  A: ['01110','10001','10001','11111','10001','10001','10001'], B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'], D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'], F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'], H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'], J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'], L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'], N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'], P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'], R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'], T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'], V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'], X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'], Z: ['11111','00001','00010','00100','01000','10000','11111'],
  0: ['01110','10001','10011','10101','11001','10001','01110'], 1: ['00100','01100','00100','00100','00100','00100','01110'],
  2: ['01110','10001','00001','00010','00100','01000','11111'], 3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['00010','00110','01010','10010','11111','00010','00010'], 5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'], 7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'], 9: ['01110','10001','10001','01111','00001','00001','01110'],
  "'": ['00100','00100','00000','00000','00000','00000','00000'], '-': ['00000','00000','00000','11111','00000','00000','00000'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
};
