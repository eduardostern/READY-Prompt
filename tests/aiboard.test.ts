import { describe, expect, it } from 'vitest';
import { createAiBoard, type CheckResult } from '../src/ai/aiboard';
import { checkAsm, checkBasic } from '../src/ai/check';
import type { ChatFn } from '../src/ai/deepseek';
import { ROMS } from './helpers';

describe('AI board checks', () => {
  it('passes a BASIC program that runs, and catches one that stops with an error', async () => {
    expect((await checkBasic(ROMS, 'OK', '10 PRINT "HELLO"\n20 GOTO 10')).ok).toBe(true);
    const bad = await checkBasic(ROMS, 'BAD', '10 PRINT "HI"\n20 PRUNT X');
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toBe('?SYNTAX ERROR IN 20');
  });

  it('assembles 6502 behind 10 SYS 2061, and catches a JAM', async () => {
    const ok = await checkAsm(ROMS, 'ASM', '* = $080D\n LDA #2\n STA $D020\n RTS');
    expect(ok.ok).toBe(true);
    expect([...ok.prg!.subarray(0, 14)]).toEqual([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00]);
    const jam = await checkAsm(ROMS, 'JAM', '* = $080D\n .byte $02');
    expect(jam.errors[0]).toMatch(/JAM/);
    const where = await checkAsm(ROMS, 'ORG', '* = $C000\n RTS');
    expect(where.errors[0]).toMatch(/\$080D/);
  });
});

describe('AI board', () => {
  it('orders a program: describes, names, writes, checks (fixing once) and puts it on the disk', async () => {
    const answers = ['10 PRUNT "OOPS"', '10 PRINT "TIMES TABLE"\n20 FOR I=1 TO 10:PRINT I*7:NEXT'];
    const chat: ChatFn = async function* () { yield { kind: 'text', text: answers.shift()! }; };
    const out: string[] = [];
    const delivered: string[] = [];
    let open = false;
    const checks: string[] = [];
    const board = createAiBoard(
      { onOpen: () => { open = true; }, onData: b => out.push(String.fromCharCode(...b)), onClose: () => {} },
      {
        getKey: () => 'sk-test', setKey: () => {}, chat, cps: 0,
        check: async (_l, _n, src): Promise<CheckResult> => {
          checks.push(src);
          return src.includes('PRUNT') ? { ok: false, errors: ['?SYNTAX ERROR IN 10'] } : { ok: true, prg: Uint8Array.of(1, 8), errors: [] };
        },
        deliver: name => delivered.push(name),
        fetch: () => ({ error: 'none' }),
        schedule: fn => fn(),
      });
    const type = (s: string) => board.send(Uint8Array.from([...s].map(c => c.charCodeAt(0))));
    expect(open).toBe(true);
    type('P');
    type('a times table\r');
    type('B');
    type('tables\r');
    for (let i = 0; i < 20 && !delivered.length; i++) await new Promise(r => setTimeout(r, 0));
    expect(checks.length).toBe(2);
    expect(delivered).toEqual(['TABLES']);
    expect(out.join('')).toContain('TABLES is on the disk in drive 8');
    expect(out.join('')).toContain('LOAD"TABLES",8');
  });
});
