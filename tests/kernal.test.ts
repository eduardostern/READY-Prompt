import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { C64 } from '../src/c64/machine';
import { ROMS, runUntil } from './helpers';

const rom = (f: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${f}`, import.meta.url)));

describe('KERNAL revisions', () => {
  for (const f of ['kernal.901227-01.bin', 'kernal.901227-02.bin']) {
    it(`${f} boots to READY. and runs BASIC`, () => {
      const c = new C64({ ...ROMS, kernal: rom(f) });
      runUntil(c, 'READY.', 300);
      expect(c.screenText()).toContain('38911 BASIC BYTES FREE');
      c.type('PRINT 6*7\n');
      expect(runUntil(c, ' 42', 100)).toContain(' 42');
    });
  }
});
