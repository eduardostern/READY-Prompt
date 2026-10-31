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
DORMANN=1 npx vitest run tests/dormann.test.ts   # Klaus Dormann's 6502 test (downloaded, GPL)
npm run term                     # reassemble programs/TERM.asm into src/programs/TERM.prg (commit both)
```

Run `npx tsc --noEmit` and `npm test` before every commit; DORMANN=1 after
any change to `src/cpu6510.ts` (the Harte tests run in `npm test`).

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
| `src/c64/keyboard.ts`, `legend.ts` | 8 × 8 matrix, PC keys by character, `KeyInput`; the on-screen keyboard's caps |
| `src/c64/basic.ts` | Listing → tokens (first keyword in table order, magazine `{codes}`) → .prg; `detokenize` |
| `src/c64/prg.ts` | `injectPrg` (bytes + BASIC pointers, as LOAD leaves them), `.p00` |
| `src/c64/tape.ts` | `Tape`: pulse timeline (.tap v0/v1, or .t64 files encoded as the KERNAL writes them), KERNAL-format files decoded with their pulse ranges; `record` for SAVE |
| `src/c64/disk.ts` | `.d64` (35/40 tracks): BAM, directory, sector chains, 1541 allocation (nearest to track 18, interleave 10), scratch, rename, format |
| `src/c64/drive.ts` | Virtual 1541 behind the KERNAL's bus routines: channels, LOAD/SAVE, `$` as a BASIC program at 0401h, ,S,R/,P,W/,S,A, @0:, channel 15 (I N S R V, error message) |
| `src/c64/cartridge.ts` | `.crt`: normal 8K/16K/Ultimax, Simons' BASIC, Ocean, Fun Play, System 3, Dinamic, Magic Desk, EasyFlash (RAM at DF00h, flash read-only); `makeCrt` builds one |
| `src/c64/state.ts` | Save states: `grab`/`put` each chip's plain data (skip lists leave out wiring, ROMs, the frame); `.rdy` = magic + deflated JSON; `Rewind` (a state a second, 30 kept) |
| `src/c64/swiftlink.ts` | SwiftLink: 6551 at DE00h-DE03h, NMI on receive, doubled baud table (15 = 38400), bytes paced at the baud rate and held until read |
| `src/c64/modem.ts` | K-Prompt's Hayes modem with telnet (same code in all the siblings) |
| `src/phonebook.ts`, `worker/` | BBSes the relay may reach (`petscii` marks Commodore boards); the Worker's `/relay` WebSocket-to-telnet |
| `programs/TERM.asm`, `scripts/term.ts`, `build-term.ts` | TERM, the SwiftLink terminal (.prg, SYS 2061): ANSI mode with its own screen in the lower-case set, PETSCII mode through CHROUT; the build writes its tables (row addresses, ASCII/CP437 → screen codes, keys → ASCII) at `;@TABLES` |
| `src/ai/aiboard.ts`, `check.ts`, `deepseek.ts`, `telnet-server.ts` | The AI board behind ATDT AI (K-Prompt's, 38 columns): chat, BOFH, programs in BASIC V2 or 6502 (as65 syntax, `* = $080D` behind 10 SYS 2061) checked on a hidden C64, delivered to the disk in drive 8; fixes a BASIC program read from that disk |
| `src/main.ts` | Page wiring, frame loop, keys, joystick (arrows + Right Ctrl), gamepad, program slot, shelf, listing dialog, `?prg=`/`?file=` links |
| `src/ui/` | From K-Prompt: audio, power switch, sound output, confirm dialog, call sound, modem audio; `modem-line.ts` (from Ok-Prompt: gateway, else relay); `store.ts` (IndexedDB `ready-prompt`: shelf, tape, disk:n, cart, quick) |
| `history.html`, `manual.html`, `pt/*.html`, `src/history.css` | The C64 story and the manual, English and Portuguese (Vite entries); facts sourced, or measured by the tests |
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
- `C64.whenReady(fn)` runs fn once the KERNAL idles in its key loop
  (E5CDh-E5D5h) with nothing typed: programs go in after the boot.
- Joystick bits (1 = pressed): up 1, down 2, left 4, right 8, fire 16;
  port 2 is CIA1 port A (shared with the keyboard columns), port 1 port B.
- Tape: pulses go to CIA1 FLAG while PLAY is down (port bit 4 reads 0)
  and the motor runs (bit 5 an output, low). Traps on the KERNAL's LOAD
  (F4A5h) and SAVE (F5EDh) for device 1 load/record a file at once and
  move the tape past it, so a turbo loader after it reads its own pulses
  in real time. After FOUND the KERNAL waits 8 s or for C= in the matrix
  (not the keyboard buffer: tape I/O runs with interrupts off).
- Traps run only when the KERNAL is mapped at E000h and no interrupt is
  due (`cpu.interruptPending`); they return with `cpu.returnFromTrap`.
- Disks: traps on LISTEN ED0Ch, TALK ED09h, SECOND EDB9h, TKSA EDC7h,
  CIOUT EDDDh, ACPTR EE13h, UNTLK EDEFh, UNLSN EDFEh (the KERNAL calls
  these itself); the rest is the KERNAL's own code. A missing file reads
  back as ST 42h (EOI + timeout), which the KERNAL turns into FILE NOT
  FOUND. Drive 9 is on the bus only with a disk in it. Bytes sent to a
  channel whose OPEN failed are dropped and the OPEN's error stays.
- Directory lines: block count + (4 − digits) spaces (LIST adds one more).
- Cartridges set GAME/EXROM through `cart.changed` (the machine re-reads
  its PLA mode). The KERNAL starts a cartridge with "CBM80" at 8004h;
  an Ultimax one (EasyFlash boots so) starts from its own reset vector
  in ROMH. Code that leaves Ultimax must run from RAM.
- Save states must stay deterministic: tests/state.test.ts checks that a
  restored machine runs on to the same cycle count, picture and sound. A
  new field holding wiring or a reference goes in `SKIP` (state.ts).
- Hotkeys are F9 (quick save), F10 (quick load), PgDn (rewind): F1-F8
  are the C64's own keys, PgUp is RESTORE.
- The SwiftLink sits at DE00h beside the cartridge (as on a port
  expander), but Ocean/Magic Desk/EasyFlash also use DE00h: it is off by
  default and plugging in a cartridge takes it out.
- TERM: the KERNAL screen editor links lines and has quote mode, so the
  ANSI side draws its own screen; the PETSCII side clears QTSW (D4h) and
  INSRT (D8h) after every CHROUT. as65's `.text` is ca65's C64 PETSCII
  (capitals become shifted): use `.byte "..."` for text shown in the
  capitals set. tests/term.test.ts fails if TERM.prg is not rebuilt.
- The AI board's checker counts a program as failing when the screen ends
  with "?... ERROR", the CPU JAMs, or the banner comes back (a crash).
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
  It only reads files in its working folder: copy uploads there.
