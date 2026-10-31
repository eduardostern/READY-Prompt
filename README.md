# READY-Prompt

A Commodore 64 in the browser, in TypeScript, named after the `READY.`
prompt. The fourth sibling of [A-Prompt](https://a-prompt.stern.workers.dev)
(CP/M), [Ok-Prompt](https://ok-prompt.stern.workers.dev) (MSX) and
[K-Prompt](https://k-prompt.stern.workers.dev) (ZX Spectrum).

## What it does

- **The C64, cycle by cycle**: a 6510 that makes every bus access the real
  chip makes (checked against Tom Harte's single-step tests), the VIC-II
  drawing 8 pixels per cycle with bad lines, sprites and border tricks,
  the SID (6581 or 8580) with reSID's envelopes, two CIAs with the real
  timer delays, and the PLA's own logic equations. PAL and NTSC.
- **Programs**: drop a `.prg`, paste a BASIC listing (magazine `{CLR}`
  codes included), or link to one with `?prg=` / `?file=`.
- **Tapes**: `.tap` and `.t64` in a Datasette, loaded at once or played in
  real time for turbo loaders; SAVE records onto them.
- **Disks**: `.d64` in drives 8 and 9, a virtual 1541 behind the KERNAL's
  serial routines (LOAD, SAVE, `$`, OPEN, channel 15).
- **Cartridges**: `.crt`, normal and Ultimax, Ocean, Magic Desk, System 3,
  Dinamic, Fun Play, Simons' BASIC, EasyFlash.
- **Save states**, a quick-save slot and 30 seconds of rewind.
- **A SwiftLink modem** that dials telnet BBSes (PETSCII and ANSI), with
  **TERM**, a terminal written in 6502 for it, and the **AI board**
  (`ATDT AI`), whose sysop is DeepSeek and which writes BASIC and machine
  code programs onto the disk in drive 8.
- A [manual](manual.html) and [the C64 story](history.html), in English and
  Portuguese.

## Run

```bash
npm install
npm run dev     # http://localhost:5173
npm test
npm run build   # static site in dist/
```

## ROMs

BASIC 901226-01, KERNAL 901227-03 and the 901225-01 character ROM, © Commodore
(see `src/roms/README.md`).

## Licence

MIT (see `LICENSE`), except the ROMs in `src/roms` and the test fixtures:
`tests/fixtures/harte6502.json.gz` is a slice of Tom Harte's
[SingleStepTests](https://github.com/SingleStepTests/65x02) (MIT).
`docs/pla.txt` is Marko Mäkelä's and Mark Smith's C64 PLA document.
