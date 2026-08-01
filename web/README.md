# King's Valley — browser port

This is a native JavaScript port of the MSX King's Valley RC727 source. It
does not execute Z80 instructions in the browser. The ROM is used as a source
of address-stable graphics, level data, and music streams, while game logic is
implemented in the modules under `src/game/`.

Run from the repository root:

```powershell
python -m http.server 8000 --directory web
```

Open `http://localhost:8000/`. ES modules require HTTP; opening `index.html`
directly with `file://` is not supported.

The internal display remains 256×192. Its default browser size is 640×480,
and it preserves the original 4:3 ratio on smaller windows.

For normal debugging, press the backtick key (`) to toggle debug mode, then press
`1`–`9` or `0` to start stages 1–10 immediately. Use `Shift+1`–`Shift+5` for
stages 11–15. This does not modify the URL. The diagnostic URLs below remain
available for automated screenshot and frame comparisons.

For visual comparison, use `?mode=menu`, `?mode=play&stage=5`, or `?mode=map`.
Add `&entry=1` to the play URL to retain the entrance animation.
Add `&stair=up` to the stage 1 play URL to show the player midway up a stair.
Add `&mummyStair=up` to show a mummy traversing the same stair.
Add `&mummyJump=1` to show a mummy during its original jump arc.
Add `&knifePhase=0` through `3` to freeze each thrown-knife rotation phase.
Add `&knifeHit=1` to the stage 1 play URL to show an enemy hit and knife bounce.
Add `&spinner=mid` to the stage 4 play URL to show the rotating door mid-turn.
Add `&trap=mid` to the stage 5 play URL to show a trap wall descending.
Add `&itemMap=pick` to the stage 6 play URL to inspect a pickaxe replacing a wall cell.
Add `&dig=lateral` to the stage 1 play URL to show the trapped-player side-wall dig.
Use `?mode=demo&frame=240` for the recorded stage 5 demo, `?mode=ending&frame=220`
for SPECIAL BONUS, or `?mode=gameover&stage=5` for the original overlay.
Add `&pause=1&pauseFrame=32` to a play or map URL for the blinking PAUSING label,
and `&soundTrace=1` to display the current AY registers.

Controls: arrows/WASD move. Press UP or DOWN together with the stair's LEFT or
RIGHT direction to enter and traverse a stair. SPACE jumps/selects, throws a
collected knife, or uses a pickaxe. The title screen uses the original ROM menu tiles and text;
the first keyboard or pointer gesture also unlocks WebAudio. Press SPACE on
the title screen to start pyramid 1. With no input, the title starts the original
recorded stage 5 demo. Clearing a stage opens the automatic pyramid map route.
Clearing stage 15 runs the desert ending, SPECIAL BONUS, and pyramid 1 restart.
F1 pauses the game or map while the PSG continues playing.

See the repository root's `PORT_PLAN.md` for the exact fidelity status,
completed implementation log, and original-ROM comparison evidence.

Asset extraction is reproducible from the supplied cartridge:

```powershell
sjasm -s src/kvalley.asm build/kvalley.rom build/kvalley.lst build/kvalley.sym
node tools/export_kingsvalley_assets.mjs
node tools/check_kingsvalley_assets.mjs
node tools/trace_kingsvalley_psg.mjs 0x97 260 build/psg-trace-start.json
node tools/render_kingsvalley_audio.mjs 0x97 260 build/kingsvalley-start.wav
node tools/capture_kingsvalley_openmsx.mjs
node tools/compare_kingsvalley_openmsx.mjs
node tools/compare_kingsvalley_psg_openmsx.mjs
```

The openMSX capture command uses `OPENMSX` when set, otherwise it looks for
`build/tooling/openmsx-21.0/openmsx.exe`. It records deterministic title,
stage 1–15, VRAM, SAT, PSG, and WAV references under `build/openmsx-reference`.
Set `STAGES=2-15` to recapture only selected stages without regenerating the
shared title, PSG, and WAV references. Set `ROOMS_ONLY=1` as well to capture
only the non-entry room of selected two-room stages.

For recorded-demo timing work, set `DEMO_FRAMES` to comma-separated frames or
ranges. Both the capture and comparison tools accept the same syntax:

```powershell
$env:DEMO_FRAMES='228-266,456,832,960-1040'
node tools\capture_kingsvalley_demo_openmsx.mjs
node tools\compare_kingsvalley_openmsx.mjs
```

The static title and all 22 room backgrounds are exact. The dynamic comparison
also checks mutable name/pattern/color VRAM and the SAT-composited framebuffer;
it intentionally exits nonzero while any recorded gameplay sprite differs.
