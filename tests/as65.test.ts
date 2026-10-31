import { describe, expect, it } from 'vitest';
import { assemble } from '../src/c64/as65';

describe('as65', () => {
  it('assembles every addressing mode', () => {
    const a = assemble(`
      * = $C000
      ptr = $FB
start: SEI
       LDA #$7F
       STA $DC0D
       LDA ptr
       LDA (ptr),Y
       LDA (ptr,X)
       LDA $D000,X
       STX ptr,Y
       ASL
       ROL A
       JMP (vector)
       BNE start
       LDA #<start
       LDX #>start
       NOP
       .byte 1, "AB"
       .word start
vector: .text "Hi"
       LAX ptr
    `);
    expect(a.origin).toBe(0xc000);
    expect([...a.bytes]).toEqual([
      0x78, 0xa9, 0x7f, 0x8d, 0x0d, 0xdc, 0xa5, 0xfb, 0xb1, 0xfb, 0xa1, 0xfb, 0xbd, 0x00, 0xd0,
      0x96, 0xfb, 0x0a, 0x2a, 0x6c, 0x22, 0xc0, 0xd0, 0xe8, 0xa9, 0x00, 0xa2, 0xc0, 0xea,
      0x01, 0x41, 0x42, 0x00, 0xc0, 0xc8, 0x49, 0xa7, 0xfb,
    ]);
  });

  it('keeps a forward reference absolute in both passes', () => {
    const a = assemble(`* = $1000\n LDA later\n later = $10\n RTS`);
    expect([...a.bytes]).toEqual([0xad, 0x10, 0x00, 0x60]);
  });

  it('reports what it cannot read, with the line', () => {
    expect(() => assemble('* = $1000\n LDA nowhere')).toThrow(/line 2/);
    expect(() => assemble('* = $1000\n FOO #1')).toThrow(/unknown instruction/);
  });
});
