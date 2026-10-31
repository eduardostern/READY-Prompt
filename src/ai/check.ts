/**
 * Checks a program the AI board's model wrote, and makes its .prg.
 *
 * BASIC is tokenized (as a pasted listing is) and RUN on a hidden C64: a
 * line on the screen like "?SYNTAX  ERROR IN 20" is the error. A program
 * still running, or waiting at INPUT or GET, after about ten seconds is
 * fine, and so is one that ends at READY.
 *
 * Machine code is assembled behind a BASIC line, 10 SYS 2061, so LOAD and
 * RUN start it, and is run the same way: a JAM opcode, or the C64 starting
 * over (its banner again), is the error.
 */
import type { CheckResult } from './aiboard';
import { assemble } from '../c64/as65';
import { tokenize } from '../c64/basic';
import { C64, type Roms } from '../c64/machine';
import { injectPrg } from '../c64/prg';

/** How long a program runs before it counts as working: ~10 s of C64 time. */
const RUN_FRAMES = 500;
/** "10 SYS 2061" at 0801h, as the .prg starts: load address, link, line, SYS, "2061". */
const SYS_STUB = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];

const yieldNow = () => new Promise<void>(r => setTimeout(r, 0));

/** Boots a fresh C64, runs `prg`, and returns the error it ended with, if any. */
async function run(roms: Roms, prg: Uint8Array): Promise<string | undefined> {
  const c = new C64(roms);
  for (let f = 0; f < 400 && !c.atPrompt; f++) c.runFrame();
  injectPrg(c, prg);
  c.type('RUN\n');
  const before = c.screenText();
  for (let f = 0; f < RUN_FRAMES; f++) {
    c.runFrame();
    if (f % 100 === 99) await yieldNow();
    if (c.cpu.jammed) return `the CPU stopped at a JAM opcode near $${c.cpu.pc.toString(16).toUpperCase()}`;
    if (f % 25 === 24 && c.screenText().includes('**** COMMODORE 64 BASIC V2 ****') && !before.includes('BASIC V2')) {
      return 'the C64 crashed and started over';
    }
  }
  const lines = c.screenText().split('\n');
  const err = [...lines].reverse().find(l => /^\?[A-Z ]+ERROR/.test(l.trim()));
  return err?.trim().replace(/\s+/g, ' ');
}

export async function checkBasic(roms: Roms, _name: string, listing: string): Promise<CheckResult> {
  let prg: Uint8Array;
  try {
    prg = tokenize(listing);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const report = await run(roms, prg);
  return report ? { ok: false, errors: [report] } : { ok: true, prg, errors: [] };
}

export async function checkAsm(roms: Roms, _name: string, source: string): Promise<CheckResult> {
  let bytes: Uint8Array, origin: number;
  try {
    ({ bytes, origin } = assemble(source));
  } catch (e) {
    const m = /^line (\d+): (.*)$/.exec((e as Error).message);
    const text = m ? `${m[0]}   [${source.split(/\r?\n/)[Number(m[1]) - 1]?.trim() ?? ''}]` : (e as Error).message;
    return { ok: false, errors: [text] };
  }
  if (origin !== 0x080d) return { ok: false, errors: [`the code starts at $${origin.toString(16).toUpperCase()}: begin with * = $080D`] };
  if (origin + bytes.length > 0xa000) return { ok: false, errors: ['the program runs past $9FFF: keep it below'] };
  const prg = new Uint8Array(SYS_STUB.length + bytes.length);
  prg.set(SYS_STUB);
  prg.set(bytes, SYS_STUB.length);
  const report = await run(roms, prg);
  return report ? { ok: false, errors: [report] } : { ok: true, prg, errors: [] };
}
