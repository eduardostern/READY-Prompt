import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Cpu6510 } from '../src/cpu6510';

/**
 * Klaus Dormann's 6502 functional test (GPL, so downloaded rather than
 * committed): DORMANN=1 npx vitest run tests/dormann.test.ts. It runs
 * from 0400h and loops on itself at 3469h when every test passed; any
 * other self-loop is the test that failed.
 */
const URL_BIN = 'https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin';
const CACHE = new URL('./fixtures/.cache/6502_functional_test.bin', import.meta.url);

describe.skipIf(!process.env.DORMANN)('Klaus Dormann functional test', () => {
  it('reaches the success loop at 3469h', async () => {
    if (!existsSync(CACHE)) {
      mkdirSync(new URL('./fixtures/.cache/', import.meta.url), { recursive: true });
      writeFileSync(CACHE, new Uint8Array(await (await fetch(URL_BIN)).arrayBuffer()));
    }
    const mem = new Uint8Array(65536);
    mem.set(readFileSync(CACHE));
    const cpu = new Cpu6510(a => mem[a], (a, v) => { mem[a] = v; });
    cpu.pc = 0x0400;
    let last = -1;
    for (let i = 0; i < 100_000_000; i++) {
      const pc = cpu.pc;
      cpu.step();
      if (cpu.pc === pc) { last = pc; break; }
    }
    expect(last.toString(16)).toBe('3469');
  }, 120_000);
});
