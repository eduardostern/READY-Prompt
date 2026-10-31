import { readFileSync } from 'node:fs';
import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Cpu6510, MNEMONIC } from '../src/cpu6510';

/** Tom Harte's SingleStepTests (6502/v1, MIT): 40 tests per opcode, every bus cycle. */
type State = { pc: number; s: number; a: number; x: number; y: number; p: number; ram: [number, number][] };
type Test = { name: string; initial: State; final: State; cycles: [number, number, string][] };
const all: Record<string, Test[]> = JSON.parse(new TextDecoder().decode(
  gunzipSync(readFileSync(new URL('./fixtures/harte6502.json.gz', import.meta.url)))));

function run(t: Test): void {
  const mem = new Uint8Array(65536);
  const bus: [number, number, string][] = [];
  const cpu = new Cpu6510(
    a => { bus.push([a, mem[a], 'read']); return mem[a]; },
    (a, v) => { bus.push([a, v, 'write']); mem[a] = v; });
  const i = t.initial;
  cpu.pc = i.pc; cpu.s = i.s; cpu.a = i.a; cpu.x = i.x; cpu.y = i.y; cpu.p = i.p;
  for (const [a, v] of i.ram) mem[a] = v;
  cpu.step();
  const f = t.final;
  const got = { pc: cpu.pc, s: cpu.s, a: cpu.a, x: cpu.x, y: cpu.y, p: cpu.p | 0x30, ram: f.ram.map(([a]) => [a, mem[a]]) };
  expect({ ...got, cycles: bus }, t.name).toEqual({ ...f, p: f.p | 0x30, cycles: t.cycles });
}

describe('6510 against SingleStepTests', () => {
  for (const op of Object.keys(all)) {
    const m = MNEMONIC[parseInt(op, 16)];
    // JAM never ends; the tests only record its first cycles.
    it.skipIf(m === 'JAM')(`${op} ${m}`, () => { for (const t of all[op]) run(t); });
  }
});
