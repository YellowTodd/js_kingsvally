Forked from GuillianSeed/Kings-Valley

# King's Valley (RC727, MSX)

This repository contains the fully annotated disassembly of the original King's Valley game, released by Konami for [MSX](https://en.wikipedia.org/wiki/MSX) in 1985 with code RC727. I hope you will find the code comments useful to understand how the game works.


## How to assemble

Use [Sjasm 0.39](https://github.com/Konamiman/Sjasm) or a compatible assembler:

    sjasm kvalley.asm kvalley.rom

## Browser port

The native JavaScript port lives in `web/`. It follows the same architecture
as the `ref/web` Zanac port: a fixed 256x192 display, explicit game state,
keyboard input, frame-timed updates, and a platform-independent rendering
layer. The title/menu now uses the original ROM tile codes and VRAM positions.
The browser engine reads the supplied `rom/RC-727.rom`: all 15
pyramid layouts, platforms, ladders, gems, mummies, doors, knives, pickaxes,
and the original compressed game graphics are extracted from the cartridge.
The gameplay slice includes movement, climbing, jumping, digging, item pickup,
knife attacks, enemy collisions, scoring, lives, game over, pyramid clear, and
the ending state after all 15 pyramids.

Run it from a local HTTP server because the browser loads ES modules:

    python -m http.server 8000 --directory web

Then open `http://localhost:8000/`.

Controls: arrows/WASD move. Enter stairs with UP/DOWN plus their LEFT/RIGHT
direction. SPACE jumps/selects and throws a held knife.

Regenerate the ROM-backed asset module after replacing the ROM or rebuilding
the ASM:

    sjasm -s src/kvalley.asm build/kvalley.rom build/kvalley.lst build/kvalley.sym
    node tools/export_kingsvalley_assets.mjs
    node tools/check_kingsvalley_assets.mjs

The generated `web/src/game/romdata.js` is address-preserving data, not
executable Z80. The browser port remains a native JavaScript implementation;
the original ROM is used for graphics, game data, and music streams while the
source routines are translated into browser-friendly state updates.

Port status and the completed/remaining fidelity work are tracked in
`PORT_PLAN.md`. The port is not declared cycle-perfect until that document's
remaining items are closed.

## Porting work log

The browser port now includes the following original-game flow and systems:

- The blue Konami splash, ROM-based title logo, `PLAY START` blink, title music,
  automatic demo, menu-to-stage curtain, and original 256x192 4:3 display.
- All 15 pyramid layouts, platforms, ladders, gems, mummies, rotating doors,
  traps, holes, knives, pickaxes, exits, map transitions, game over, the
  pyramid map, and the ending sequence.
- Player walking with fixed-point X movement, jumping, falling, stair entry and
  exit, item pickup, knife throw/bounce, digging, gem completion, and exit
  activation. SPACE is the original shared action key; Z is not required.
- Stair descent now recognizes the original bottom-boundary platform sentinel,
  preventing the second-pyramid bottom ladder from carrying the player below
  the floor.
- PSG music and effects through the browser audio path, with input reset on
  blur/hidden tabs and AudioContext resume handling.
- Debug stage selection without URL parameters: press backtick (`), then use
  `1`–`9`/`0` for stages 1–10 or `Shift+1`–`Shift+5` for stages 11–15.

Validation completed during the port:

- `node tools/check_kingsvalley_assets.mjs` validates ROM hash, extracted
  graphics, music, collision data, and stage data.
- `node tools/check_kingsvalley_gameplay.mjs` clears all 15 stages in the
  deterministic gameplay harness and exercises movement, stairs, jumping, and
  action input for every stage.
- `node tools/check_kingsvalley_browser.mjs` passes 7/7 browser-runtime
  contracts for raster size, refresh timing, resize, input, focus, and audio.
- The latest OpenMSX comparison has exact background VRAM (0 pixel mismatch).
  The recorded long-demo framebuffer still has 646 sprite phase pixels, so the
  port is functionally complete but not yet cycle-perfect.

The detailed dated work log and the remaining fidelity items are in
`PORT_PLAN.md`. Generated comparison logs, screenshots, WAV files, and OpenMSX
capture trees are intentionally not kept in the repository; they can be
regenerated with the commands in `web/README.md`.


## Version 1 vs Version 2

It is possible to build both versions by setting the `VERSION2` constant to 1 or 0 in the `kvalley.asm` file.
Version 2 fixes few bugs from the first version.



## Legal notice

This repository is provided "as is" for education purposes only. Any non-educational use of this repository might be illegal if you do not own an original copy of the game.

Also, the repository will be removed if Konami or their legal representatives ask me to do so.
