import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/c64/basic';
import { KEYS } from '../src/c64/keyboard';
import { encodeFile, Tape } from '../src/c64/tape';
import { boot, runUntil } from './helpers';

const name = (s: string) => Uint8Array.from([...s.padEnd(16)].map(c => c.charCodeAt(0)));

/** A tape holding one BASIC program, written as the KERNAL writes it. */
function programTape(listing: string, file = 'HELLO'): Tape {
  const prg = tokenize(listing);
  const pulses: number[] = [];
  encodeFile(pulses, 1, 0x0801, prg.subarray(2), name(file));
  return new Tape(pulses, `${file}.tap`);
}

/** A .t64 with the given files. */
function t64(files: { name: string; start: number; data: Uint8Array }[]): Uint8Array {
  const dir = 64 + files.length * 32;
  const total = dir + files.reduce((n, f) => n + f.data.length, 0);
  const out = new Uint8Array(total);
  out.set([...'C64S tape image file'].map(c => c.charCodeAt(0)));
  out[32] = 0x01; out[33] = 0x01; out[34] = files.length; out[36] = files.length;
  let off = dir;
  files.forEach((f, i) => {
    const e = 64 + i * 32;
    out[e] = 1; out[e + 1] = 0x82;
    out[e + 2] = f.start & 0xff; out[e + 3] = f.start >> 8;
    const end = f.start + f.data.length;
    out[e + 4] = end & 0xff; out[e + 5] = end >> 8;
    out[e + 8] = off & 0xff; out[e + 9] = off >> 8;
    out.set(name(f.name), e + 16);
    out.set(f.data, off);
    off += f.data.length;
  });
  return out;
}

describe('tapes', () => {
  it('reads back what it writes, through .tap and back', () => {
    const t = programTape('10 PRINT "HI"');
    expect(t.files.map(f => [f.name, f.type, f.start])).toEqual([['HELLO', 1, 0x0801]]);
    const again = Tape.fromTap(t.toTap());
    expect(again.pulses.length).toBe(t.pulses.length);
    expect([...again.files[0].data]).toEqual([...t.files[0].data]);
  });

  it('turns .t64 files into a tape', () => {
    const prg = tokenize('10 PRINT "ONE"');
    const t = Tape.fromT64(t64([{ name: 'ONE', start: 0x0801, data: prg.subarray(2) }, { name: 'TWO', start: 0xc000, data: Uint8Array.of(1, 2, 3) }]));
    expect(t.files.map(f => f.name)).toEqual(['ONE', 'TWO']);
    expect([...t.files[1].data]).toEqual([1, 2, 3]);
  });

  it('LOADs at once through the KERNAL trap', () => {
    const c = boot();
    c.tape = programTape('10 PRINT "FROM TAPE"');
    c.type('LOAD\nRUN\n');
    runUntil(c, 'FROM TAPE', 100);
  });

  it('finds a file by name, with KERNAL wildcards', () => {
    const c = boot();
    const prg1 = tokenize('10 PRINT "FIRST"'), prg2 = tokenize('10 PRINT "SECOND"');
    c.tape = Tape.fromT64(t64([{ name: 'FIRST', start: 0x0801, data: prg1.subarray(2) }, { name: 'SECOND', start: 0x0801, data: prg2.subarray(2) }]));
    c.type('LOAD "SEC*"\nRUN\n');
    runUntil(c, 'SECOND', 100);
  });

  it('LOADs in real time through the FLAG line, as the KERNAL reads a tape', () => {
    const c = boot();
    c.fastTape = false;
    c.tape = programTape('10 PRINT "SLOWLY"');
    c.tapePlay = true;
    c.type('LOAD\n');
    runUntil(c, 'FOUND HELLO', 1200);
    // After FOUND the KERNAL waits 8 s or for the C= key, read from the matrix itself.
    c.setKeys([KEYS['C=']]);
    runUntil(c, 'LOADING', 50);
    c.setKeys([]);
    c.run(600);
    c.type('RUN\n');
    runUntil(c, 'SLOWLY', 3000);
  }, 60_000);

  it('SAVEs onto the tape and LOADs it back', () => {
    const c = boot();
    c.tape = Tape.blank();
    c.type('10 PRINT "SAVED AND BACK"\nSAVE "MINE"\n');
    c.run(60);
    expect(c.tape.files.map(f => f.name)).toEqual(['MINE']);
    c.tape.rewind();
    c.type('NEW\nLOAD "MINE"\nRUN\n');
    runUntil(c, 'SAVED AND BACK', 100);
  });
});
