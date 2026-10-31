import { describe, expect, it } from 'vitest';
import { boot, runUntil } from './helpers';

describe('C64', () => {
  it('boots BASIC V2 with 38911 bytes free', () => {
    const c = boot();
    expect(c.screenText()).toContain('**** COMMODORE 64 BASIC V2 ****');
    expect(c.screenText()).toContain('64K RAM SYSTEM  38911 BASIC BYTES FREE');
    expect(c.screenText()).toContain('READY.');
  });

  it('boots on an NTSC machine too, and the KERNAL sees it (02A6h = 0)', () => {
    const c = boot('ntsc', 180);
    expect(c.screenText()).toContain('38911 BASIC BYTES FREE');
    expect(c.ram[0x2a6]).toBe(0);
    expect(boot('pal').ram[0x2a6]).toBe(1);
  });

  it('runs a typed program', () => {
    const c = boot();
    c.type('10 FOR I=1 TO 3:PRINT "HELLO";I:NEXT\nRUN\n');
    runUntil(c, 'HELLO 3');
  });

  it('serves a raster interrupt on the line asked for', () => {
    const c = boot();
    const at = (a: number, bytes: number[]) => bytes.forEach((b, i) => { c.ram[a + i] = b; });
    at(0xc000, [
      0x78, //             SEI
      0xa9, 0x7f, 0x8d, 0x0d, 0xdc, 0xad, 0x0d, 0xdc, // CIA1 interrupts off
      0xa9, 0x20, 0x8d, 0x14, 0x03, 0xa9, 0xc0, 0x8d, 0x15, 0x03, // CINV = C020h
      0xa9, 0x64, 0x8d, 0x12, 0xd0, // raster line 100
      0xad, 0x11, 0xd0, 0x29, 0x7f, // (bit 8 = 0)
      0x4c, 0x31, 0xc0, //  JMP C031h
    ]);
    at(0xc020, [
      0xad, 0x12, 0xd0, 0x8d, 0x00, 0xc1, // the line we were called on
      0xee, 0x01, 0xc1, //  count the calls
      0xa9, 0x01, 0x8d, 0x19, 0xd0, // acknowledge
      0x4c, 0x81, 0xea, //  JMP EA81h (pull the registers, RTI)
    ]);
    at(0xc031, [
      0x8d, 0x11, 0xd0,
      0xa9, 0xff, 0x8d, 0x19, 0xd0, // clear the flag the KERNAL left set
      0xa9, 0x01, 0x8d, 0x1a, 0xd0, // raster interrupts on
      0x58, 0x60, //       CLI, RTS
    ]);
    c.type('SYS 49152\n');
    c.run(60);
    expect(c.ram[0xc100]).toBe(100);
    expect(c.ram[0xc101]).toBeGreaterThan(40);
  });
});
