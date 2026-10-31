import { describe, expect, it } from 'vitest';
import { Modem, type Dialer, type LinkHandlers } from '../src/c64/modem';
import { SwiftLink } from '../src/c64/swiftlink';
import { boot, runUntil, sys } from './helpers';

/** A line that answers every call, and the handlers to talk back with. */
function fakeLine() {
  const line = { handlers: undefined as LinkHandlers | undefined, sent: [] as number[] };
  const dialer: Dialer = (_t, h) => {
    line.handlers = h;
    queueMicrotask(() => h.onOpen());
    return { send: b => line.sent.push(...b), close: () => {} };
  };
  return { line, dialer };
}

function withModem() {
  const c = boot();
  const { line, dialer } = fakeLine();
  const modem = new Modem({ dialer, phoneBook: () => [{ host: 'bbs.example.com', port: 23, name: 'Example' }], now: () => 0 });
  c.swiftlink = new SwiftLink(modem, c.clockHz);
  return { c, modem, line };
}

/** A tiny terminal: DTR on, 38400 baud, sends a string, then prints whatever comes. */
const POLLED = (send: string) => `
  * = $C000
  LDA #$0B     ; DTR on, receive interrupt off, RTS low
  STA $DE02
  LDA #$1F     ; 38400 baud, 8N1
  STA $DE03
  LDX #0
out: LDA text,X
  BEQ loop
wait: LDA $DE01
  AND #$10
  BEQ wait
  LDA text,X
  STA $DE00
  INX
  BNE out
loop: LDA $DE01
  AND #$08
  BEQ loop
  LDA $DE00
  CMP #10
  BEQ loop
  JSR $FFD2
  JMP loop
text: .byte ${[...send].map(ch => ch.charCodeAt(0)).join(', ')}, 0
`;

describe('SwiftLink', () => {
  it('talks to the modem: AT gets OK', () => {
    const { c } = withModem();
    sys(c, POLLED('AT\r'), 20);
    expect(c.screenText()).toContain('OK');
  });

  it('dials, connects and shows what the BBS sends, at the chosen baud rate', async () => {
    const { c, line } = withModem();
    sys(c, POLLED('ATDT1\r'), 5);
    await Promise.resolve();
    c.run(5);
    expect(c.screenText()).toContain('CONNECT');
    line.handlers!.onData(new TextEncoder().encode('WELCOME TO THE BOARD'));
    runUntil(c, 'WELCOME TO THE BOARD', 50);
  });

  it('raises NMI for each byte with receive interrupts on (as CCGMS uses it)', async () => {
    const { c, line } = withModem();
    sys(c, `
      * = $C000
      SEI
      LDA #<nmi
      STA $0318
      LDA #>nmi
      STA $0319
      LDA #$1F
      STA $DE03
      LDA #$09     ; DTR on, receive interrupts on
      STA $DE02
      CLI
      LDX #0
      LDA #$41     ; "A"
w1:   LDA $DE01
      AND #$10
      BEQ w1
      LDA #$41
      STA $DE00
      LDA #$54
      STA $DE00
      LDA #$44
      STA $DE00
      LDA #$54
      STA $DE00
      LDA #$31
      STA $DE00
      LDA #13
      STA $DE00
      RTS
nmi:  PHA
      TXA
      PHA
      LDA $DE01    ; reading the status lets go of NMI
      LDA $DE00
      LDX $C100
      STA $C200,X
      INC $C100
      PLA
      TAX
      PLA
      RTI
    `, 5);
    await Promise.resolve();
    line.handlers!.onData(new TextEncoder().encode('PETSCII!'));
    c.run(20);
    const got = String.fromCharCode(...c.ram.subarray(0xc200, 0xc200 + c.ram[0xc100]));
    expect(got).toContain('CONNECT');
    expect(got.endsWith('PETSCII!')).toBe(true);
  });
});
