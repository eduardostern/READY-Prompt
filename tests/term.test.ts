import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { injectPrg } from '../src/c64/prg';
import { Modem, type Dialer, type LinkHandlers } from '../src/c64/modem';
import { SwiftLink } from '../src/c64/swiftlink';
import type { C64 } from '../src/c64/machine';
import { buildTerm } from '../scripts/term';
import { boot } from './helpers';

/** TERM running with a modem whose calls always answer. */
async function term() {
  const c = boot();
  const line = { handlers: undefined as LinkHandlers | undefined, sent: [] as number[] };
  const dialer: Dialer = (_t, h) => { line.handlers = h; queueMicrotask(() => h.onOpen()); return { send: b => line.sent.push(...b), close: () => {} }; };
  const modem = new Modem({ dialer, phoneBook: () => [{ host: 'bbs.example.com', port: 23, name: 'Example' }], now: () => 0 });
  c.swiftlink = new SwiftLink(modem, c.clockHz);
  injectPrg(c, buildTerm());
  c.type('RUN\n');
  c.run(20);
  c.type('ATDT1\r');
  c.run(5);
  await Promise.resolve();
  c.run(5);
  const send = (s: string | number[]) => {
    line.handlers!.onData(typeof s === 'string' ? Uint8Array.from([...s].map(ch => ch.charCodeAt(0))) : Uint8Array.from(s));
    c.run(10);
  };
  return { c, line, send };
}

/** A screen row as TERM draws it (lower-case set). */
function row(c: C64, r: number): string {
  let s = '';
  for (let x = 0; x < 40; x++) {
    const v = c.ram[0x0400 + r * 40 + x] & 0x7f;
    s += v === 0 ? '@' : v <= 26 ? String.fromCharCode(0x60 + v) : v >= 0x41 && v <= 0x5a ? String.fromCharCode(v) : v < 0x40 ? String.fromCharCode(v) : '#';
  }
  return s.trimEnd();
}

describe('TERM', () => {
  it('is the program built from programs/TERM.asm (run npm run term after changing it)', () => {
    const built = buildTerm();
    const committed = new Uint8Array(readFileSync(new URL('../src/programs/TERM.prg', import.meta.url)));
    expect([...committed]).toEqual([...built]);
  });

  it('connects and shows ANSI text with its colours, where the board puts it', async () => {
    const { c, send } = await term();
    expect([...Array(25).keys()].map(r => row(c, r)).join('\n')).toContain('CONNECT');
    send('\x1b[2J\x1b[3;5H\x1b[1;31mRed\x1b[0m and plain');
    expect(row(c, 2)).toBe('    Red and plain');
    expect(c.colorRam[2 * 40 + 4]).toBe(10); // bold red: light red
    expect(c.colorRam[2 * 40 + 9]).toBe(15); // reset: light grey
  });

  it('draws CP437 boxes with the C64 graphics', async () => {
    const { c, send } = await term();
    send([0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x48, 0xc9, 0xcd, 0xbb, 0x0d, 0x0a, 0xc8, 0xcd, 0xbc]);
    expect([...c.ram.subarray(0x0400, 0x0403)]).toEqual([0x70, 0x40, 0x6e]);
    expect([...c.ram.subarray(0x0428, 0x042b)].map(v => v & 0x7f)).toEqual([0x6d, 0x40, 0x7d]);
  });

  it('answers the terminal probe ESC[6n with where the cursor is', async () => {
    const { line, send } = await term();
    line.sent.length = 0;
    send('\x1b[10;20H\x1b[6n');
    expect(String.fromCharCode(...line.sent)).toBe('\x1b[10;20R');
  });

  it('sends keys as ASCII, the cursor keys as ANSI', async () => {
    const { c, line } = await term();
    line.sent.length = 0;
    c.type('hi');
    c.run(10);
    expect(String.fromCharCode(...line.sent)).toBe('hi');
  });

  it('passes PETSCII straight to the screen in PETSCII mode (F1), and F7 goes back to BASIC', async () => {
    const { c, send } = await term();
    c.setKeys([0x04]); // F1 (column 0, row 4)
    c.run(3);
    c.setKeys([]);
    c.run(5);
    send([0x93, 0x05, 0x48, 0x49]); // CLR, white, "HI"
    expect(c.screenText()).toContain('HI');
    expect(c.colorRam[0]).toBe(1);
    c.setKeys([0x03]); // F7
    c.run(3);
    c.setKeys([]);
    c.run(10);
    expect(c.screenText()).toContain('BACK IN BASIC');
  });
});
