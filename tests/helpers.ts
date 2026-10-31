import { readFileSync } from 'node:fs';
import { C64, type Model } from '../src/c64/machine';

const rom = (f: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${f}`, import.meta.url)));
export const ROMS = {
  basic: rom('basic.901226-01.bin'),
  kernal: rom('kernal.901227-03.bin'),
  chargen: rom('characters.901225-01.bin'),
};

/** A C64 run until BASIC is ready (about 2.5 s of emulated time). */
export function boot(model: Model = 'pal', frames = 150): C64 {
  const c = new C64(ROMS);
  if (model !== 'pal') c.setModel(model);
  c.run(frames);
  return c;
}

/** Runs frames until `text` is on screen (or fails after `max`). */
export function runUntil(c: C64, text: string, max = 300): string {
  for (let i = 0; i < max; i++) {
    c.runFrame();
    if (c.screenText().includes(text)) return c.screenText();
  }
  throw new Error(`"${text}" never appeared:\n${c.screenText()}`);
}

import { assemble } from '../src/c64/as65';

/** Assembles `src` into the C64's RAM and calls it with SYS from BASIC. */
export function sys(c: C64, src: string, frames = 5): void {
  const a = assemble(src);
  c.ram.set(a.bytes, a.origin);
  c.type(`SYS ${a.origin}\n`);
  c.run(frames);
}
