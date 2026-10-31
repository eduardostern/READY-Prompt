/**
 * Programs straight into memory, as LOAD"name",8,1 would leave them: the
 * bytes at their load address, and BASIC's pointers to the end of the
 * program when it is a BASIC program (load address = start of BASIC).
 */
import type { C64 } from './machine';

export interface Loaded { start: number; end: number; basic: boolean }

export function injectPrg(c: C64, prg: Uint8Array): Loaded {
  if (prg.length < 3) throw new Error('too short to be a program');
  const start = prg[0] | (prg[1] << 8);
  const data = prg.subarray(2);
  if (start + data.length > 0x10000) throw new Error('the program runs past the end of memory');
  c.ram.set(data, start);
  const end = start + data.length;
  const basicStart = c.ram[0x2b] | (c.ram[0x2c] << 8);
  const basic = start === basicStart;
  // End of the loaded bytes (the KERNAL leaves it in AEh/AFh).
  c.ram[0xae] = end & 0xff; c.ram[0xaf] = end >> 8;
  if (basic) {
    // VARTAB, ARYTAB, STREND: variables start after the program.
    for (const p of [0x2d, 0x2f, 0x31]) { c.ram[p] = end & 0xff; c.ram[p + 1] = end >> 8; }
  }
  return { start, end, basic };
}

/** A .prg's name for the screen and shelf (without the extension). */
export function prgName(file: string): string {
  return file.replace(/^.*\//, '').replace(/\.(prg|p00)$/i, '');
}

/** A PC64 .p00 file: 26-byte header ("C64File", name), then a .prg. */
export function fromP00(data: Uint8Array): Uint8Array {
  const magic = String.fromCharCode(...data.subarray(0, 7));
  if (magic !== 'C64File') throw new Error('not a .p00 file');
  return data.subarray(26);
}
