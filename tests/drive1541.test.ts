import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/c64/basic';
import { D64, petsciiName } from '../src/c64/disk';
import { decodeDisk, encodeDisk } from '../src/c64/gcr';
import { Via } from '../src/c64/via';
import type { C64 } from '../src/c64/machine';
import { assemble } from '../src/c64/as65';
import { boot, runUntil } from './helpers';

const rom = (f: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${f}`, import.meta.url)));
const DOS = rom('1541-II.251968-03.bin');
/** The first 1541's DOS: two 8K chips. */
const OLD_DOS = new Uint8Array([...rom('1541-c000.325302-01.bin'), ...rom('1541-e000.901229-05.bin')]);

function diskWith(files: [string, Uint8Array][]): D64 {
  const d = D64.blank('TEST DISK', 'T1');
  for (const [n, data] of files) d.write(petsciiName(n), 2, data);
  return d;
}

function withDrive(disk: D64 | null) {
  const c = boot();
  c.setDrive1541(DOS);
  c.insertDisk(8, disk);
  c.run(100); // the DOS tests its RAM and ROM first
  return c;
}

describe('the real 1541', () => {
  it('lists the directory through its own DOS', () => {
    const c = withDrive(diskWith([['HELLO', tokenize('10 PRINT "HI"')]]));
    c.type('LOAD"$",8\nLIST\n');
    const screen = runUntil(c, 'BLOCKS FREE.', 1500);
    expect(screen).toContain('0 "TEST DISK       " T1 2A');
    expect(screen).toContain('1    "HELLO"            PRG');
    expect(screen).toContain('663 BLOCKS FREE.');
  });

  it('LOADs a program and RUNs it', () => {
    const c = withDrive(diskWith([['HELLO', tokenize('10 PRINT "HI FROM THE 1541"')]]));
    c.type('LOAD"HEL*",8\nRUN\n');
    const screen = runUntil(c, 'HI FROM THE 1541', 1500);
    expect(screen).toContain('SEARCHING FOR HEL*');
    expect(screen).toContain('LOADING');
  });

  it('SAVEs onto the disk, and the .d64 gets the file once the motor stops', () => {
    const disk = diskWith([]);
    const c = withDrive(disk);
    c.type('10 PRINT "SAVED"\nSAVE"NEW",8\n');
    runUntil(c, 'SAVING NEW', 300);
    waitMotor(c);
    const e = disk.find(petsciiName('NEW'));
    expect(e).not.toBeNull();
    expect([...disk.read(e!)]).toEqual([...tokenize('10 PRINT "SAVED"')]);
    expect(disk.dirty).toBe(true);
  });

  it('runs code put into its RAM with M-W and started with M-E', () => {
    const c = withDrive(diskWith([]));
    // LDA #42h : STA 0600h : RTS, at 0500h.
    c.type('10 OPEN15,8,15:C$=CHR$(169)+CHR$(66)+CHR$(141)\n20 C$=C$+CHR$(0)+CHR$(6)+CHR$(96)\n');
    c.type('30 PRINT#15,"M-W"CHR$(0)CHR$(5)CHR$(6)C$\n40 PRINT#15,"M-E"CHR$(0)CHR$(5):CLOSE15:PRINT"FIN"+"ISHED"\nRUN\n');
    runUntil(c, 'FINISHED', 600);
    c.run(20);
    expect(c.drive1541!.ram[0x600]).toBe(0x42);
  });

  it('formats a disk with N: (writing every track)', () => {
    const disk = diskWith([['OLD', new Uint8Array(3000)]]);
    const c = withDrive(disk);
    c.type('OPEN15,8,15,"N:FRESH,FD":CLOSE15:PRINT"FIN"+"ISHED"\n');
    runUntil(c, 'FINISHED', 6000);
    waitMotor(c);
    c.type('LOAD"$",8\nLIST\n');
    const screen = runUntil(c, 'BLOCKS FREE.', 1500);
    expect(screen).toContain('0 "FRESH           " FD 2A');
    expect(screen).toContain('664 BLOCKS FREE.');
    expect(disk.blocksFree).toBe(664);
    expect(disk.entries()).toHaveLength(0);
  });
});

/** Runs until the drive's motor has stopped (the DOS turns it off a while after the last job). */
function waitMotor(c: C64, max = 1500): void {
  for (let i = 0; i < max && !c.drive1541!.motor; i++) c.runFrame();
  for (let i = 0; i < max && c.drive1541!.motor; i++) c.runFrame();
  c.runFrame();
  expect(c.drive1541!.motor).toBe(false);
}

describe('GCR', () => {
  it('reads back every sector it encoded', () => {
    const d = diskWith([['A', Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff)]]);
    const copy = new D64(d.data.slice());
    expect(decodeDisk(encodeDisk(d), copy)).toBe(0);
    copy.sector(17, 3).fill(0xaa);
    copy.sector(35, 16).fill(0x55);
    expect(decodeDisk(encodeDisk(d), copy)).toBe(2);
    expect([...copy.data]).toEqual([...d.data]);
  });

  it('lays tracks out at the real lengths', () => {
    const t = encodeDisk(D64.blank());
    expect([t[1].length, t[18].length, t[25].length, t[31].length]).toEqual([7692, 7142, 6666, 6250]);
  });
});

describe('6522', () => {
  const via = () => new Via({ readA: () => 0xff, readB: () => 0xff });

  it('timer 1 one-shot sets its flag once, N + 1 cycles after the write', () => {
    const v = via();
    v.write(4, 10); v.write(5, 0);
    let at = -1;
    for (let i = 1; i <= 40; i++) { v.tick(); if (at < 0 && v.ifr & 0x40) at = i; }
    expect(at).toBe(12);
    v.read(4);
    for (let i = 0; i < 40; i++) v.tick();
    expect(v.ifr & 0x40).toBe(0);
  });

  it('timer 1 free-runs every N + 2 cycles', () => {
    const v = via();
    v.write(11, 0x40);
    v.write(4, 10); v.write(5, 0);
    const hits: number[] = [];
    for (let i = 1; i <= 50; i++) { v.tick(); if (v.ifr & 0x40) { hits.push(i); v.read(4); } }
    expect(hits[1] - hits[0]).toBe(12);
    expect(hits[2] - hits[1]).toBe(12);
  });

  it('interrupts when the flag is enabled, and port A latches on CA1', () => {
    let pa = 0x12;
    const v = new Via({ readA: () => pa, readB: () => 0xff });
    v.write(11, 0x01); v.write(14, 0x82);
    v.edgeCa1();
    pa = 0x34;
    expect(v.irq).toBe(true);
    expect(v.read(1)).toBe(0x12);
    expect(v.irq).toBe(false);
  });
});

/**
 * A 2-bit fast loader of the usual kind: the drive puts two bits at a
 * time on CLK and DATA, 12 cycles apart, timed from the moment it sees
 * ATN go low; the C64 reads them on its own clock with no handshake. It
 * works only if both sides see each other's lines at the right cycle.
 */
const DRIVE_SENDER = `
  * = $0500
  cur = $85
  p0 = $86
  p1 = $87
  p2 = $88
  p3 = $89
  SEI
  LDA #$00
  STA $1800
  LDY #0
next: LDA $E000,Y
  STA cur
  LSR
  LSR
  LSR
  LSR
  LSR
  LSR
  TAX
  LDA vtab,X
  STA p0
  LDA cur
  LSR
  LSR
  LSR
  LSR
  AND #3
  TAX
  LDA vtab,X
  STA p1
  LDA cur
  LSR
  LSR
  AND #3
  TAX
  LDA vtab,X
  STA p2
  LDA cur
  AND #3
  TAX
  LDA vtab,X
  STA p3
wait: BIT $1800
  BPL wait
  LDA p0
  STA $1800
  LDA p1
  BIT cur
  NOP
  STA $1800
  LDA p2
  BIT cur
  NOP
  STA $1800
  LDA p3
  BIT cur
  NOP
  STA $1800
wait2: BIT $1800
  BMI wait2
  LDA #$00
  STA $1800
  INY
  BNE next
  CLI
  RTS
; Two bits to port B: DATA (read as bit 7) = bit 1, CLK (bit 6) = bit 0, ATN acknowledge on.
vtab: .byte $1A, $12, $18, $10
`;

const C64_RECEIVER = `
  * = $C000
  base = $FB
  atnon = $FC
  acc = $FD
  t0 = $02
  t1 = $03
  t2 = $04
  t3 = $05
  SEI
  LDA $D011
  AND #$EF
  STA $D011
w1: LDA $D012
  BNE w1
  LDA $DD00
  AND #$07
  STA base
  ORA #$08
  STA atnon
  LDY #0
byte: LDX #20
d1: DEX
  BNE d1
  LDA atnon
  STA $DD00
  NOP
  NOP
  NOP
  NOP
  NOP
  NOP
  NOP
  LDA $DD00
  STA t0
  BIT acc
  NOP
  LDA $DD00
  STA t1
  BIT acc
  NOP
  LDA $DD00
  STA t2
  BIT acc
  NOP
  LDA $DD00
  STA t3
  LDA base
  STA $DD00
  LDA t0
  AND #$C0
  STA acc
  LDA t1
  AND #$C0
  LSR
  LSR
  ORA acc
  STA acc
  LDA t2
  AND #$C0
  LSR
  LSR
  LSR
  LSR
  ORA acc
  STA acc
  LDA t3
  AND #$C0
  LSR
  LSR
  LSR
  LSR
  LSR
  LSR
  ORA acc
  STA $C800,Y
  INY
  BNE byte
  LDA $D011
  ORA #$10
  STA $D011
  CLI
  RTS
`;

describe('fast loaders', () => {
  for (const [name, rom] of [['1541-II', DOS], ['1541', OLD_DOS]] as const) {
    it(`a 2-bit transfer timed to the cycle gets every byte across (${name})`, () => {
      const c = boot();
      c.setDrive1541(rom);
      c.insertDisk(8, D64.blank());
      c.run(100);
      const drv = assemble(DRIVE_SENDER), rx = assemble(C64_RECEIVER);
      c.drive1541!.ram.set(drv.bytes, drv.origin);
      c.ram.set(rx.bytes, rx.origin);
      c.type('OPEN15,8,15,"M-E"+CHR$(0)+CHR$(5):SYS49152:PRINT"FIN"+"ISHED"\n');
      runUntil(c, 'FINISHED', 600);
      expect([...c.ram.subarray(0xc800, 0xc900)]).toEqual([...rom.subarray(0x2000, 0x2100)]);
    });
  }
});

describe('the real 1541 in a save state', () => {
  it('goes on loading from where the state was taken', async () => {
    const { saveState, loadState } = await import('../src/c64/state');
    const c = withDrive(diskWith([['HELLO', tokenize('10 PRINT "BACK AGAIN"')]]));
    c.type('LOAD"HELLO",8\nRUN\n');
    runUntil(c, 'SEARCHING', 300);
    c.run(30);
    const state = saveState(c);
    runUntil(c, 'BACK AGAIN', 1500);
    loadState(c, state);
    expect(c.screenText()).not.toContain('BACK AGAIN');
    expect(c.drive1541!.motor).toBe(true);
    runUntil(c, 'BACK AGAIN', 1500);
  });
});
