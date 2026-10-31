# READY-Prompt — notes for Claude

Commodore 64 emulator for the browser in TypeScript. Static site (Vite).
Sibling of A-Prompt (`~/cpm`, CP/M), Ok-Prompt (`~/Ok-Prompt`, MSX) and
K-Prompt (`~/K-Prompt`, ZX Spectrum); the page, the UI helpers, the modem
and the relay Worker come from K-Prompt. Named after the `READY.` prompt.

## Commands

```bash
npm run dev                      # http://localhost:5173
npm test                         # vitest
npx tsc --noEmit                 # typecheck (npm run build also runs it)
npm run build                    # static site in dist/
npm run deploy                   # build + wrangler deploy (only when the user says so)
```

Run `npx tsc --noEmit` and `npm test` before every commit.

## Workflow

- Commit straight to `main` (single-developer repo); push only when the user
  says so (CI deploys every push to main). Commit style: `feat:`, `fix:`,
  `docs:` with a body that says why.
- Every bug fix gets a regression test that fails on the old code.

## Layout

| Path | Role |
| --- | --- |
| `src/cpu6510.ts` | 6502/6510 with the undocumented opcodes; each `read`/`write` is one bus cycle, dummy accesses included; interrupts sampled per cycle |
| `src/c64/machine.ts` | `C64`: memory, I/O, the 6510 port, `runFrame()`, typing (keyboard buffer), `screenText()` |
| `src/c64/pla.ts` | The 82S100's equations (`docs/pla.txt`) evaluated into `cpuMap` and `vicChip` |
| `src/c64/vic.ts` | VIC-II 6569/6567R8, one cycle at a time: fetches, BA, border flip-flops, 8 pixels per cycle |
| `src/c64/cia.ts` | 6526: timers with the start/load/interrupt pipeline, TOD, ICR |
| `src/c64/sid.ts` | SID 6581/8580: `advanceTo(cycle)` before each access; samples average sub-steps of ≤ 8 cycles; reSID's envelope (rate counter, exponential steps, ADSR bug); SVF filter; 6581 volume DC (digis) |
| `src/c64/as65.ts` | Two-pass 6502 assembler on the CPU's opcode table (tests, built-in programs, AI board); `toPrg` |
| `src/c64/keyboard.ts` | 8 × 8 matrix, PC keys by character, `KeyInput` |
| `src/main.ts` | Page wiring, frame loop, keys |
| `src/ui/` | From K-Prompt: audio, power switch, sound output, confirm dialog |
| `src/roms/` | BASIC 901226-01, KERNAL 901227-03, characters 901225-01 (see its README) |

## C64 facts that are easy to get wrong

- A CPU read while the VIC holds BA low waits (a stolen cycle); writes go
  ahead (the VIC takes the bus 3 cycles after BA, and the 6510 never writes
  more than 3 times in a row). Bad lines: BA low in cycles 12-54.
- An instruction acts on the interrupt sampled in its next-to-last cycle:
  CLI/SEI/PLP take effect one instruction late; a taken branch within its
  page looks one cycle further back.
- The VIC latches the raster flag ($D019 bit 0) every frame even while
  masked, and the KERNAL leaves it set: enable $D01A only after writing
  $D019, or the interrupt fires at once (as on the real machine).
- The VIC's bank is CIA2 port A bits 0-1, inverted; it sees the character
  ROM at 1000h-1FFFh of banks 0 and 2, and colour RAM on data bits 8-11.
- Sprite Y = the line before the sprite's first one; the 21st row is drawn
  after DMA stops (the data was fetched the line before), so sprites are
  armed by their fetch, not by the display flag.
- CIA timer: latch N underflows every N + 1 cycles; a started timer counts
  from the third cycle after the write; the IRQ line follows one cycle
  after the ICR flag.
- With the vertical border never set (RSEL to 24 rows between lines 247
  and 251) top and bottom borders stay open and show the idle fetch
  (3FFFh, 39FFh with ECM) in black.
- SID pitch = freq × clock / 2^24 (7493 is A4 on PAL); rate 0 attack is
  255 steps of 9 cycles; OSC3 ($D41B) with noise is the games' random
  number source.
- KERNAL 02A6h = 1 on PAL, 0 on NTSC (it counts raster lines at boot).
- Typing goes into the keyboard buffer (0277h, count C6h); both cases type
  plain letters (listings are upper case).

## Testing tips

- `tests/helpers.ts`: `boot(model, frames)`, `runUntil(c, text)`, `sys(c, asm)`
  (assemble into RAM and SYS it);
  `tests/png.ts` writes a frame as PNG to look at.
- `tests/cpu.test.ts` runs 40 of Tom Harte's single-step tests per opcode
  (`tests/fixtures/harte6502.json.gz`, bus cycles included).
- Browser checks: `npm run build`, `npx vite preview --port 4180`, then
  `playwright-cli` from the scratchpad, localStorage
  `ready-prompt.settings` = `{"autoPower":true}`. playwright's `type`
  presses keys faster than a C64 scans: type with `{delay: 90}`.
