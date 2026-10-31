import { describe, expect, it } from 'vitest';
import { assemble } from '../src/c64/as65';
import { cartridgeFromCrt, makeCrt } from '../src/c64/cartridge';
import { C64 } from '../src/c64/machine';
import { ROMS } from './helpers';

const rom8k = (src: string, origin = 0x8000) => {
  const a = assemble(src);
  const out = new Uint8Array(0x2000).fill(0xff);
  out.set(a.bytes, a.origin - origin);
  return out;
};

describe('cartridges', () => {
  it('starts an 8K cartridge through its CBM80 signature', () => {
    const crt = makeCrt(0, true, false, 'BORDER', [{ bank: 0, address: 0x8000, data: rom8k(`
      * = $8000
      .word cold, cold
      .byte $C3, $C2, $CD, $38, $30
cold: LDA #2
      STA $D020
loop: JMP loop`) }]);
    const c = new C64(ROMS);
    c.insert(cartridgeFromCrt(crt));
    c.reset(true);
    c.run(10);
    expect(c.vic.regs[0x20] & 15).toBe(2);
    expect(c.peek(0x8004)).toBe(0xc3);
    expect(c.peek(0xa000)).toBe(c.basic[0]); // 8K mode: BASIC stays at A000h
  });

  it('switches Magic Desk banks at DE00h, and bit 7 takes the cartridge away', () => {
    const banks = [0, 1, 2].map(b => ({ bank: b, address: 0x8000, data: new Uint8Array(0x2000).fill(0x10 + b) }));
    const cart = cartridgeFromCrt(makeCrt(19, true, false, 'MAGIC', banks));
    const c = new C64(ROMS);
    c.insert(cart);
    expect(c.peek(0x8000)).toBe(0x10);
    c.poke(0xde00, 2);
    expect(c.peek(0x8000)).toBe(0x12);
    c.poke(0xde00, 0x80);
    expect(c.peek(0x8000)).toBe(c.ram[0x8000]);
  });

  it('boots an EasyFlash in Ultimax mode from its ROMH and lets it pick 16K mode', () => {
    const romh = rom8k(`
      * = $FF00
start: LDA #5
      STA $D020
      LDX #0        ; the switch runs from RAM: ROMH leaves the map under it
copy: LDA code,X
      STA $0340,X
      INX
      CPX #8
      BNE copy
      JMP $0340
code: .byte $A9, $07, $8D, $02, $DE ; LDA #7: STA $DE02 (16K mode)
      .byte $4C, $45, $03           ; JMP $0345 (itself)
      * = $FFFC
      .word start`, 0xe000);
    const crt = makeCrt(32, false, true, 'EF', [
      { bank: 0, address: 0x8000, data: new Uint8Array(0x2000).fill(0x42) },
      { bank: 0, address: 0xe000, data: romh },
    ]);
    const c = new C64(ROMS);
    c.insert(cartridgeFromCrt(crt));
    c.reset(true);
    c.run(2);
    expect(c.vic.regs[0x20] & 15).toBe(5);
    expect(c.peek(0x8000)).toBe(0x42);
    expect(c.peek(0xe000)).toBe(c.kernal[0]); // out of Ultimax: the KERNAL is back
    c.poke(0xdf10, 0x99);
    expect(c.peek(0xdf10)).toBe(0x99);
  });

  it('refuses the kinds it does not know, by name', () => {
    expect(() => cartridgeFromCrt(makeCrt(1, false, false, 'AR', [{ bank: 0, address: 0x8000, data: new Uint8Array(0x2000) }])))
      .toThrow(/Action Replay/);
  });
});
